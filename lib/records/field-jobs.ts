import { and, eq, inArray, like, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import {
  canMoveFieldJob,
  FIELD_JOB_LIMITS,
  FIELD_JOB_PAY_METHODS,
  FIELD_JOB_PHOTO_PHASES,
  FIELD_JOB_PHOTO_TYPES,
  FIELD_JOB_STATUS_LABEL,
  fieldJobLinesEditable,
  fieldJobMoney,
  nextFieldJobCode,
  type FieldJobStatus,
} from "@/lib/constants/field-jobs";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";

/**
 * ═══════════ PHIẾU CÔNG VIỆC HIỆN TRƯỜNG — ĐƯỜNG GHI (docs/verticals/home-service.md) ═══════════
 *
 *  · Mọi lượt ghi cần `field_jobs:write` (khoá của module `field_jobs` — tắt module ⇒ `can()` từ chối).
 *  · Chuyển trạng thái có điều kiện TRONG câu UPDATE (`status = trạng thái đã đọc`): hai người bấm cùng lúc chỉ một lượt thắng.
 *  · Một thợ không bị hẹn chồng giờ: kiểm trong giao dịch sau khoá tư vấn theo thợ (hẹn nối tiếp không tính trùng).
 *  · Thu tiền: không thu khi chưa có báo giá, không thu vượt tổng báo giá; huỷ phiếu thu cần lý do, không xoá dòng.
 *  · Nghiệm thu cần TÊN người ký (gõ lại từ biên bản giấy); huỷ phiếu cần lý do; mọi lượt ghi có nhật ký.
 */

export type FieldJobResult = { ok: true; id: string; message: string } | MetaFailure;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

function gate(user: SessionUser): MetaFailure | null {
  return can(user, "field_jobs:write") ? null : fail("FORBIDDEN", "Bạn không có quyền lập / xử lý phiếu công việc (field_jobs:write).");
}

const L = FIELD_JOB_LIMITS;

const lineZ = z
  .object({
    description: z.string().trim().min(1, "Ghi nội dung công việc").max(L.lineTextMax),
    quantity: z.number().int("Số lượng nguyên").min(1, "Ít nhất 1").max(L.qtyMax),
    unitPrice: z.number().int("Đơn giá là số nguyên (đồng)").min(0, "Không âm").max(L.moneyMax),
  })
  .strict();

const quoteZ = z
  .object({
    title: z.string({ error: "Nhập tên việc" }).trim().min(1, "Nhập tên việc").max(L.titleMax),
    address: z.string().trim().max(500).default(""),
    description: z.string().trim().max(L.textMax).default(""),
    warrantyMonths: z.number().int().min(1, "Bảo hành ít nhất 1 tháng").max(L.warrantyMonthsMax).nullable().default(null),
    lines: z.array(lineZ).max(L.lineMax, `Tối đa ${L.lineMax} dòng`).default([]),
  })
  .strict();

const createZ = quoteZ.extend({ customerId: z.string({ error: "Chọn khách" }).trim().min(1, "Chọn khách").max(200) }).strict();

export type FieldJobQuoteInput = z.input<typeof quoteZ>;
export type FieldJobCreateInput = z.input<typeof createZ>;

async function writeLines(tx: Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0], jobId: string, lines: z.output<typeof lineZ>[]) {
  await tx.delete(schema.fieldJobLines).where(eq(schema.fieldJobLines.jobId, jobId));
  if (lines.length) await tx.insert(schema.fieldJobLines).values(lines.map((l, i) => ({ jobId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, position: i })));
}

async function insertJob(user: SessionUser, v: z.output<typeof createZ>, now: Date, parentJobId: string | null): Promise<{ id: string; code: string }> {
  const db = await getDb();
  const id = crypto.randomUUID();
  return db.transaction(async (tx) => {
    // Mã phiếu theo ngày: khoá tư vấn chung để hai lượt lập cùng lúc không lấy trùng số.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('field-job-code'))`);
    const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(2, 10).replace(/-/g, "");
    const codes = await tx.select({ code: schema.fieldJobs.code }).from(schema.fieldJobs).where(like(schema.fieldJobs.code, `CV-${day}-%`));
    const code = nextFieldJobCode(now, codes.map((c) => c.code));
    await tx.insert(schema.fieldJobs).values({ id, code, customerId: v.customerId, parentJobId, title: v.title, address: v.address, description: v.description, warrantyMonths: v.warrantyMonths, createdByUserId: user.id, createdByName: user.name, createdAt: now, updatedAt: now });
    await writeLines(tx, id, v.lines);
    return { id, code };
  });
}

export async function createFieldJobCore(user: SessionUser, raw: unknown, now: Date = new Date()): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = createZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const [customer] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, v.customerId)).limit(1);
  if (!customer) return fail("INVALID", [{ field: "customerId", message: "Khách không tồn tại trong tổ chức này." }]);
  const { id, code } = await insertJob(user, v, now, null);
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_CREATE", entity: "FIELD_JOB", entityId: id, before: null, after: { code, customerId: v.customerId, title: v.title, lines: v.lines.length, total: fieldJobMoney(v.lines, []).total }, reason: "Lập phiếu công việc" });
  return { ok: true, id, message: `Đã lập phiếu ${code}.` };
}

async function loadJob(id: string) {
  const db = await getDb();
  const [job] = await db.select().from(schema.fieldJobs).where(eq(schema.fieldJobs.id, id)).limit(1);
  return job ?? null;
}

/** Sửa báo giá (tên việc, địa chỉ, mô tả, bảo hành, dòng) — được tới trước khi nghiệm thu; phát sinh tại nhà khách là chuyện thường. */
export async function updateFieldJobQuoteCore(user: SessionUser, jobId: string, raw: unknown): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = quoteZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const job = await loadJob(jobId);
  if (!job) return fail("NOT_FOUND", "Không có phiếu này.");
  const status = job.status as FieldJobStatus;
  if (!fieldJobLinesEditable(status)) return fail("CONFLICT", `Phiếu đang «${FIELD_JOB_STATUS_LABEL[status]}» — không sửa báo giá được nữa.`);
  if (status !== "QUOTED" && !v.lines.length) return fail("INVALID", [{ field: "lines", message: "Khách đã đồng ý — báo giá phải còn ít nhất một dòng." }]);
  const db = await getDb();
  const receipts = await db.select({ amount: schema.fieldJobReceipts.amount, status: schema.fieldJobReceipts.status }).from(schema.fieldJobReceipts).where(eq(schema.fieldJobReceipts.jobId, jobId));
  const money = fieldJobMoney(v.lines, receipts);
  if (money.paid > 0 && (money.total ?? 0) < money.paid) return fail("CONFLICT", [{ field: "lines", message: "Tổng báo giá mới nhỏ hơn số đã thu — huỷ bớt phiếu thu trước." }]);
  const before = { title: job.title, warrantyMonths: job.warrantyMonths };
  const done = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.fieldJobs)
      .set({ title: v.title, address: v.address, description: v.description, warrantyMonths: v.warrantyMonths, updatedAt: new Date() })
      .where(and(eq(schema.fieldJobs.id, jobId), eq(schema.fieldJobs.status, status)))
      .returning({ id: schema.fieldJobs.id });
    if (!row) return false;
    await writeLines(tx, jobId, v.lines);
    return true;
  });
  if (!done) return fail("CONFLICT", "Phiếu vừa được người khác cập nhật — tải lại trang.");
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_QUOTE", entity: "FIELD_JOB", entityId: jobId, before, after: { title: v.title, warrantyMonths: v.warrantyMonths, lines: v.lines.length, total: money.total }, reason: "Sửa báo giá" });
  return { ok: true, id: jobId, message: "Đã lưu báo giá." };
}

const moveZ = z
  .object({
    to: z.enum(["ACCEPTED", "SCHEDULED", "IN_PROGRESS", "DONE", "CANCELLED"]),
    note: z.string().trim().max(L.textMax).default(""),
    assigneeUserId: z.string().trim().max(200).nullable().default(null),
    /** «YYYY-MM-DDTHH:MM» giờ VN (ô datetime-local). */
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Giờ hẹn dạng YYYY-MM-DDTHH:MM").nullable().default(null),
    durationMin: z.number().int().min(15, "Ít nhất 15 phút").max(L.durationMinMax).nullable().default(null),
    signedByName: z.string().trim().max(L.nameMax).nullable().default(null),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

export type FieldJobMoveInput = z.input<typeof moveZ>;

/**
 * Chuyển trạng thái: khách đồng ý (cần ≥ 1 dòng) · hẹn / dời hẹn (thợ đang hoạt động + giờ + thời lượng, không chồng giờ) ·
 * bắt đầu · nghiệm thu (cần tên người ký) · huỷ (cần lý do).
 */
export async function moveFieldJobCore(user: SessionUser, jobId: string, raw: unknown, now: Date = new Date()): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = moveZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const job = await loadJob(jobId);
  if (!job) return fail("NOT_FOUND", "Không có phiếu này.");
  const from = job.status as FieldJobStatus;
  if (!canMoveFieldJob(from, v.to)) return fail("CONFLICT", `Phiếu đang «${FIELD_JOB_STATUS_LABEL[from]}» — không chuyển sang «${FIELD_JOB_STATUS_LABEL[v.to]}» được.`);
  const db = await getDb();
  const fj = schema.fieldJobs;
  let set: Partial<typeof fj.$inferInsert> = { status: v.to, updatedAt: now };

  if (v.to === "ACCEPTED") {
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.fieldJobLines).where(eq(schema.fieldJobLines.jobId, jobId));
    if (!Number(n?.n ?? 0)) return fail("INVALID", [{ field: "lines", message: "Chưa có dòng báo giá nào — khách đồng ý với cái gì?" }]);
    set = { ...set, acceptedAt: now, acceptedNote: v.note };
  }
  if (v.to === "DONE") {
    if (!v.signedByName) return fail("INVALID", [{ field: "signedByName", message: "Ghi tên khách ký nghiệm thu." }]);
    set = { ...set, completedAt: now, signedByName: v.signedByName, completionNote: v.note };
  }
  if (v.to === "IN_PROGRESS") set = { ...set, startedAt: now };
  if (v.to === "CANCELLED") {
    if ((v.reason ?? "").length < L.reasonMin) return fail("INVALID", [{ field: "reason", message: "Ghi lý do huỷ (ít nhất 3 ký tự)." }]);
    set = { ...set, cancelReason: v.reason, cancelledAt: now };
  }

  if (v.to === "SCHEDULED") {
    if (!v.assigneeUserId) return fail("INVALID", [{ field: "assigneeUserId", message: "Chọn thợ." }]);
    if (!v.start) return fail("INVALID", [{ field: "start", message: "Chọn giờ hẹn." }]);
    if (!v.durationMin) return fail("INVALID", [{ field: "durationMin", message: "Ghi thời lượng dự kiến." }]);
    const [tech] = await db.select({ active: schema.users.active, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, v.assigneeUserId)).limit(1);
    if (!tech?.active) return fail("INVALID", [{ field: "assigneeUserId", message: "Thợ không còn hoạt động." }]);
    const start = new Date(`${v.start}:00+07:00`);
    if (Number.isNaN(start.getTime())) return fail("INVALID", [{ field: "start", message: "Giờ hẹn không hợp lệ." }]);
    const end = new Date(start.getTime() + v.durationMin * 60_000);
    const assignee = v.assigneeUserId;
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`field-job-tech:${assignee}`}))`);
      const [clash] = await tx
        .select({ code: fj.code, start: fj.scheduledStart })
        .from(fj)
        .where(and(eq(fj.assigneeUserId, assignee), inArray(fj.status, ["SCHEDULED", "IN_PROGRESS"]), ne(fj.id, jobId), sql`${fj.scheduledStart} < ${end} and ${fj.scheduledEnd} > ${start}`))
        .limit(1);
      if (clash) return { clash };
      const [row] = await tx
        .update(fj)
        .set({ ...set, assigneeUserId: assignee, scheduledStart: start, scheduledEnd: end })
        .where(and(eq(fj.id, jobId), eq(fj.status, from)))
        .returning({ id: fj.id });
      return { ok: Boolean(row) };
    });
    if ("clash" in outcome && outcome.clash) return fail("CONFLICT", [{ field: "start", message: `${tech.name} đã có hẹn ${outcome.clash.code} chồng giờ này.` }]);
    if (!("ok" in outcome) || !outcome.ok) return fail("CONFLICT", "Phiếu vừa được người khác cập nhật — tải lại trang.");
    await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_SCHEDULE", entity: "FIELD_JOB", entityId: jobId, before: { status: from, assigneeUserId: job.assigneeUserId, scheduledStart: job.scheduledStart }, after: { status: "SCHEDULED", assigneeUserId: assignee, scheduledStart: start, scheduledEnd: end }, reason: from === "SCHEDULED" ? "Dời hẹn" : "Hẹn thợ" });
    return { ok: true, id: jobId, message: `Đã hẹn ${tech.name} lúc ${v.start.replace("T", " ")}.` };
  }

  const [row] = await db.update(fj).set(set).where(and(eq(fj.id, jobId), eq(fj.status, from))).returning({ id: fj.id });
  if (!row) return fail("CONFLICT", "Phiếu vừa được người khác cập nhật — tải lại trang.");
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_STATUS", entity: "FIELD_JOB", entityId: jobId, before: { status: from }, after: { status: v.to, signedByName: v.signedByName }, reason: v.reason ?? (v.note || FIELD_JOB_STATUS_LABEL[v.to]) });
  return { ok: true, id: jobId, message: `Phiếu ${job.code}: ${FIELD_JOB_STATUS_LABEL[v.to]}.` };
}

// ═══ THU TIỀN ═══

const receiptZ = z
  .object({
    amount: z.number({ error: "Nhập số tiền" }).int("Số tiền nguyên (đồng)").min(1, "Lớn hơn 0").max(L.moneyMax),
    method: z.enum(FIELD_JOB_PAY_METHODS).default("CASH"),
    note: z.string().trim().max(500).default(""),
  })
  .strict();

export async function recordFieldJobReceiptCore(user: SessionUser, jobId: string, raw: unknown, now: Date = new Date()): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = receiptZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const id = crypto.randomUUID();
  const outcome = await db.transaction(async (tx) => {
    const [job] = await tx.select({ status: schema.fieldJobs.status, code: schema.fieldJobs.code }).from(schema.fieldJobs).where(eq(schema.fieldJobs.id, jobId)).for("update").limit(1);
    if (!job) return { err: fail("NOT_FOUND", "Không có phiếu này.") };
    if (job.status === "CANCELLED") return { err: fail("CONFLICT", "Phiếu đã huỷ — không thu tiền.") };
    const lines = await tx.select({ quantity: schema.fieldJobLines.quantity, unitPrice: schema.fieldJobLines.unitPrice }).from(schema.fieldJobLines).where(eq(schema.fieldJobLines.jobId, jobId));
    const receipts = await tx.select({ amount: schema.fieldJobReceipts.amount, status: schema.fieldJobReceipts.status }).from(schema.fieldJobReceipts).where(eq(schema.fieldJobReceipts.jobId, jobId));
    const money = fieldJobMoney(lines, receipts);
    if (money.total === null) return { err: fail("INVALID", [{ field: "amount", message: "Chưa có báo giá — chưa biết thu bao nhiêu." }]) };
    if (money.paid + v.amount > money.total) return { err: fail("CONFLICT", [{ field: "amount", message: `Vượt số còn phải thu (${(money.total - money.paid).toLocaleString("vi-VN")} ₫).` }]) };
    await tx.insert(schema.fieldJobReceipts).values({ id, jobId, amount: v.amount, method: v.method, paidAt: now, note: v.note, createdByUserId: user.id, createdByName: user.name });
    return { code: job.code, due: money.total - money.paid - v.amount };
  });
  if ("err" in outcome && outcome.err) return outcome.err;
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_RECEIPT", entity: "FIELD_JOB", entityId: jobId, before: null, after: { receiptId: id, amount: v.amount, method: v.method }, reason: "Thu tiền phiếu công việc" });
  return { ok: true, id, message: `Đã thu ${v.amount.toLocaleString("vi-VN")} ₫ cho ${"code" in outcome ? outcome.code : ""} — còn ${("due" in outcome ? outcome.due ?? 0 : 0).toLocaleString("vi-VN")} ₫.` };
}

export async function voidFieldJobReceiptCore(user: SessionUser, receiptId: string, reason: string, now: Date = new Date()): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const why = (reason ?? "").trim();
  if (why.length < L.reasonMin) return fail("INVALID", [{ field: "reason", message: "Ghi lý do huỷ phiếu thu (ít nhất 3 ký tự)." }]);
  const db = await getDb();
  const r = schema.fieldJobReceipts;
  const [row] = await db.update(r).set({ status: "VOIDED", voidReason: why.slice(0, 500), voidedAt: now }).where(and(eq(r.id, receiptId), eq(r.status, "CONFIRMED"))).returning({ id: r.id, jobId: r.jobId, amount: r.amount });
  if (!row) return fail("NOT_FOUND", "Không có phiếu thu còn hiệu lực này.");
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_RECEIPT_VOID", entity: "FIELD_JOB", entityId: row.jobId, before: { receiptId, status: "CONFIRMED", amount: row.amount }, after: { status: "VOIDED" }, reason: why });
  return { ok: true, id: receiptId, message: "Đã huỷ phiếu thu." };
}

// ═══ ẢNH ═══

const photoZ = z
  .object({
    phase: z.enum(FIELD_JOB_PHOTO_PHASES),
    contentType: z.enum(FIELD_JOB_PHOTO_TYPES),
    base64: z.string().min(10).max(Math.ceil((L.photoBytesMax * 4) / 3) + 8, "Ảnh quá lớn"),
  })
  .strict();

export async function addFieldJobPhotoCore(user: SessionUser, jobId: string, raw: unknown): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = photoZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const data = Buffer.from(v.base64, "base64");
  if (!data.length || data.length > L.photoBytesMax) return fail("INVALID", [{ field: "base64", message: "Ảnh rỗng hoặc lớn hơn 2 MB." }]);
  const job = await loadJob(jobId);
  if (!job) return fail("NOT_FOUND", "Không có phiếu này.");
  if (job.status === "CANCELLED") return fail("CONFLICT", "Phiếu đã huỷ.");
  const db = await getDb();
  const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.fieldJobPhotos).where(eq(schema.fieldJobPhotos.jobId, jobId));
  if (Number(n?.n ?? 0) >= L.photosMax) return fail("CONFLICT", `Mỗi phiếu tối đa ${L.photosMax} ảnh.`);
  const id = crypto.randomUUID();
  await db.insert(schema.fieldJobPhotos).values({ id, jobId, phase: v.phase, contentType: v.contentType, bytes: data.length, data, uploadedByUserId: user.id, uploadedByName: user.name });
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_PHOTO", entity: "FIELD_JOB", entityId: jobId, before: null, after: { photoId: id, phase: v.phase, bytes: data.length }, reason: "Tải ảnh" });
  return { ok: true, id, message: "Đã tải ảnh." };
}

export async function deleteFieldJobPhotoCore(user: SessionUser, photoId: string): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const db = await getDb();
  const p = schema.fieldJobPhotos;
  const [row] = await db.delete(p).where(eq(p.id, photoId)).returning({ id: p.id, jobId: p.jobId, phase: p.phase });
  if (!row) return fail("NOT_FOUND", "Không có ảnh này.");
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_PHOTO_DELETE", entity: "FIELD_JOB", entityId: row.jobId, before: { photoId, phase: row.phase }, after: null, reason: "Xoá ảnh" });
  return { ok: true, id: photoId, message: "Đã xoá ảnh." };
}

// ═══ BẢO HÀNH ═══

/** Mở lượt QUAY LẠI cho một phiếu đã nghiệm thu: phiếu MỚI cùng khách / địa chỉ, trỏ về phiếu gốc, chưa có dòng báo giá. */
export async function openFieldJobRevisitCore(user: SessionUser, jobId: string, issue: string, now: Date = new Date()): Promise<FieldJobResult> {
  const denied = gate(user);
  if (denied) return denied;
  const what = (issue ?? "").trim();
  if (what.length < 5) return fail("INVALID", [{ field: "issue", message: "Mô tả sự cố ít nhất 5 ký tự." }]);
  const job = await loadJob(jobId);
  if (!job) return fail("NOT_FOUND", "Không có phiếu này.");
  if (job.status !== "DONE") return fail("CONFLICT", "Chỉ mở lượt bảo hành cho phiếu đã nghiệm thu.");
  const { id, code } = await insertJob(user, { customerId: job.customerId, title: `Bảo hành: ${job.title}`.slice(0, L.titleMax), address: job.address, description: what.slice(0, L.textMax), warrantyMonths: null, lines: [] }, now, job.id);
  await audit({ userId: user.id, userEmail: user.email, action: "FIELD_JOB_REVISIT", entity: "FIELD_JOB", entityId: id, before: null, after: { code, parentJobId: job.id }, reason: what });
  return { ok: true, id, message: `Đã mở lượt bảo hành ${code} cho phiếu ${job.code}.` };
}


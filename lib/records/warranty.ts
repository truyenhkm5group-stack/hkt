import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { canTransitionClaim, isDayKey, normalizeSerial, WARRANTY_CLAIM_STATUSES, WARRANTY_CLAIM_STATUS_LABEL, WARRANTY_LIMITS, WARRANTY_RESOLUTIONS, warrantyExpiry, type WarrantyClaimStatus } from "@/lib/constants/warranty";
import { vnDateKey } from "@/lib/format";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";

/**
 * ═══════════ BẢO HÀNH — ĐƯỜNG GHI (docs/verticals/household.md) ═══════════
 *
 *  · Mọi lượt ghi cần `warranty:write` (khoá của module `warranty` — tắt module ⇒ `can()` từ chối).
 *  · Một serial chỉ thuộc MỘT phiếu đang hiệu lực: kiểm trong giao dịch sau khoá tư vấn theo serial, và chỉ mục duy nhất có
 *    điều kiện ở CSDL chặn lần cuối.
 *  · Hạn = ngày mua + số tháng, tính ở đây (`warrantyExpiry`) — không nhận hạn từ client.
 *  · Người thao tác đi bằng khoá tài khoản; tên là ảnh chụp do máy chủ đọc (luật 34). Huỷ phiếu / từ chối ca cần lý do.
 */

export type WarrantyResult = { ok: true; id: string; message: string } | MetaFailure;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

function gate(user: SessionUser): MetaFailure | null {
  return can(user, "warranty:write") ? null : fail("FORBIDDEN", "Bạn không có quyền lập / xử lý bảo hành (warranty:write).");
}

const money = z.number().int("Số tiền là số nguyên (đồng)").min(0, "Không âm").max(WARRANTY_LIMITS.moneyMax).nullable();

const cardZ = z
  .object({
    customerId: z.string({ error: "Chọn khách" }).trim().min(1, "Chọn khách").max(200),
    variantId: z.string().trim().max(200).nullable().default(null),
    productName: z.string().trim().max(WARRANTY_LIMITS.nameMax).default(""),
    serial: z.string().max(200).nullable().default(null),
    orderId: z.string().trim().max(200).nullable().default(null),
    purchasedOn: z.string().refine(isDayKey, "Ngày mua dạng YYYY-MM-DD"),
    months: z.number({ error: "Nhập số tháng bảo hành" }).int("Số tháng nguyên").min(WARRANTY_LIMITS.minMonths, `Tối thiểu ${WARRANTY_LIMITS.minMonths} tháng`).max(WARRANTY_LIMITS.maxMonths, `Tối đa ${WARRANTY_LIMITS.maxMonths} tháng`),
    note: z.string().max(WARRANTY_LIMITS.noteMax).default(""),
  })
  .strict();

export type WarrantyCardInput = z.input<typeof cardZ>;

export async function createWarrantyCardCore(user: SessionUser, raw: unknown, now: Date = new Date()): Promise<WarrantyResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = cardZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const errors: FieldError[] = [];
  if (v.purchasedOn > vnDateKey(now)) errors.push({ field: "purchasedOn", message: "Ngày mua không được ở tương lai." });
  const db = await getDb();
  const [customer] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, v.customerId)).limit(1);
  if (!customer) errors.push({ field: "customerId", message: "Khách không tồn tại trong tổ chức này." });
  let productName = v.productName;
  if (v.variantId) {
    const [row] = await db
      .select({ name: schema.products.name, detail: schema.productVariants.detail, size: schema.productVariants.size })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.id, v.variantId))
      .limit(1);
    if (!row) errors.push({ field: "variantId", message: "Sản phẩm không có — chọn lại." });
    else productName = [row.name, row.detail.trim() || row.size.trim()].filter(Boolean).join(" · ");
  }
  if (!productName) errors.push({ field: "productName", message: "Chọn sản phẩm hoặc ghi tên sản phẩm." });
  const expiresOn = warrantyExpiry(v.purchasedOn, v.months);
  if (!expiresOn) errors.push({ field: "months", message: "Không tính được hạn bảo hành." });
  if (errors.length || !expiresOn) return fail("INVALID", errors);
  const serial = normalizeSerial(v.serial);
  const id = crypto.randomUUID();
  const clash = await db.transaction(async (tx) => {
    if (serial) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`warranty-serial:${serial.toLowerCase()}`}))`);
      const c = schema.warrantyCards;
      const [hit] = await tx.select({ id: c.id, productName: c.productName }).from(c).where(and(sql`lower(${c.serial}) = ${serial.toLowerCase()}`, eq(c.status, "ACTIVE"))).limit(1);
      if (hit) return hit;
    }
    await tx.insert(schema.warrantyCards).values({ id, customerId: v.customerId, variantId: v.variantId, productName: productName.slice(0, WARRANTY_LIMITS.nameMax), serial, orderId: v.orderId, purchasedOn: v.purchasedOn, months: v.months, expiresOn, note: v.note.trim(), createdByUserId: user.id, createdByName: user.name });
    return null;
  });
  if (clash) return fail("CONFLICT", [{ field: "serial", message: `Serial «${serial}» đã thuộc phiếu bảo hành «${clash.productName}» đang hiệu lực — huỷ phiếu cũ trước nếu nhập nhầm.` }]);
  await audit({ userId: user.id, userEmail: user.email, action: "WARRANTY_CARD_CREATE", entity: "WARRANTY_CARD", entityId: id, before: null, after: { customerId: v.customerId, productName, serial, purchasedOn: v.purchasedOn, months: v.months, expiresOn }, reason: "Lập phiếu bảo hành" });
  return { ok: true, id, message: `Đã lập phiếu bảo hành «${productName}» — hạn tới ${expiresOn.split("-").reverse().join("/")}.` };
}

export async function voidWarrantyCardCore(user: SessionUser, id: string, reason: string): Promise<WarrantyResult> {
  const denied = gate(user);
  if (denied) return denied;
  const why = (reason ?? "").trim();
  if (why.length < WARRANTY_LIMITS.reasonMin) return fail("INVALID", [{ field: "reason", message: "Ghi lý do huỷ phiếu (ít nhất 3 ký tự)." }]);
  const db = await getDb();
  const c = schema.warrantyCards;
  const [row] = await db.update(c).set({ status: "VOID", voidReason: why.slice(0, 500), updatedAt: new Date() }).where(and(eq(c.id, id), eq(c.status, "ACTIVE"))).returning({ id: c.id, productName: c.productName });
  if (!row) return fail("NOT_FOUND", "Không có phiếu đang hiệu lực này.");
  await audit({ userId: user.id, userEmail: user.email, action: "WARRANTY_CARD_VOID", entity: "WARRANTY_CARD", entityId: id, before: { status: "ACTIVE" }, after: { status: "VOID" }, reason: why });
  return { ok: true, id, message: `Đã huỷ phiếu «${row.productName}».` };
}

const claimZ = z
  .object({
    issue: z.string().trim().min(WARRANTY_LIMITS.issueMin, "Mô tả lỗi ít nhất 5 ký tự").max(WARRANTY_LIMITS.issueMax),
    assigneeUserId: z.string().trim().max(200).nullable().default(null),
  })
  .strict();

export async function openWarrantyClaimCore(user: SessionUser, cardId: string, raw: unknown): Promise<WarrantyResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = claimZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const db = await getDb();
  const [card] = await db.select({ id: schema.warrantyCards.id, status: schema.warrantyCards.status, productName: schema.warrantyCards.productName }).from(schema.warrantyCards).where(eq(schema.warrantyCards.id, cardId)).limit(1);
  if (!card) return fail("NOT_FOUND", "Không có phiếu bảo hành này.");
  if (card.status !== "ACTIVE") return fail("CONFLICT", "Phiếu đã huỷ — không mở ca trên phiếu đã huỷ.");
  if (parsed.data.assigneeUserId) {
    const [u] = await db.select({ active: schema.users.active }).from(schema.users).where(eq(schema.users.id, parsed.data.assigneeUserId)).limit(1);
    if (!u?.active) return fail("INVALID", [{ field: "assigneeUserId", message: "Người nhận ca không còn hoạt động." }]);
  }
  const id = crypto.randomUUID();
  await db.insert(schema.warrantyClaims).values({ id, cardId, issue: parsed.data.issue, assigneeUserId: parsed.data.assigneeUserId, createdByUserId: user.id, createdByName: user.name });
  await audit({ userId: user.id, userEmail: user.email, action: "WARRANTY_CLAIM_OPEN", entity: "WARRANTY_CLAIM", entityId: id, before: null, after: { cardId, issue: parsed.data.issue, assigneeUserId: parsed.data.assigneeUserId }, reason: "Mở ca bảo hành" });
  return { ok: true, id, message: `Đã mở ca bảo hành cho «${card.productName}».` };
}

const advanceZ = z
  .object({
    status: z.enum(WARRANTY_CLAIM_STATUSES),
    resolution: z.enum(WARRANTY_RESOLUTIONS).nullable().default(null),
    rejectReason: z.string().max(500).nullable().default(null),
    costVnd: money.default(null),
    chargedVnd: money.default(null),
    note: z.string().max(WARRANTY_LIMITS.noteMax).nullable().default(null),
  })
  .strict();

/** Chuyển trạng thái ca. Xong cần cách xử lý; từ chối cần lý do. Ca đã xong / từ chối không đổi nữa. */
export async function advanceWarrantyClaimCore(user: SessionUser, claimId: string, raw: unknown, now: Date = new Date()): Promise<WarrantyResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = advanceZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  if (v.status === "DONE" && !v.resolution) return fail("INVALID", [{ field: "resolution", message: "Chọn cách xử lý." }]);
  if (v.status === "REJECTED" && (v.rejectReason ?? "").trim().length < WARRANTY_LIMITS.reasonMin) return fail("INVALID", [{ field: "rejectReason", message: "Ghi lý do từ chối (ít nhất 3 ký tự)." }]);
  const db = await getDb();
  const cl = schema.warrantyClaims;
  const [row] = await db.select({ status: cl.status }).from(cl).where(eq(cl.id, claimId)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có ca bảo hành này.");
  const from = row.status as WarrantyClaimStatus;
  if (!canTransitionClaim(from, v.status)) return fail("CONFLICT", `Ca đang «${WARRANTY_CLAIM_STATUS_LABEL[from]}» — không chuyển sang «${WARRANTY_CLAIM_STATUS_LABEL[v.status]}» được.`);
  const closing = v.status === "DONE" || v.status === "REJECTED";
  const set = {
    status: v.status,
    updatedAt: now,
    ...(v.status === "IN_PROGRESS" && !closing ? { assigneeUserId: sql`coalesce(${cl.assigneeUserId}, ${user.id})` } : {}),
    ...(closing ? { closedAt: now } : {}),
    ...(v.status === "DONE" ? { resolution: v.resolution } : {}),
    ...(v.status === "REJECTED" ? { rejectReason: (v.rejectReason ?? "").trim().slice(0, 500) } : {}),
    ...(v.costVnd !== null ? { costVnd: v.costVnd } : {}),
    ...(v.chargedVnd !== null ? { chargedVnd: v.chargedVnd } : {}),
    ...(v.note !== null ? { note: v.note.trim() } : {}),
  };
  // Điều kiện trạng thái trong câu UPDATE: hai người bấm cùng lúc thì chỉ một lượt thắng.
  const [done] = await db.update(cl).set(set).where(and(eq(cl.id, claimId), eq(cl.status, from), ne(cl.status, v.status))).returning({ id: cl.id });
  if (!done) return fail("CONFLICT", "Ca vừa được người khác cập nhật — tải lại trang.");
  await audit({ userId: user.id, userEmail: user.email, action: "WARRANTY_CLAIM_STATUS", entity: "WARRANTY_CLAIM", entityId: claimId, before: { status: from }, after: { status: v.status, resolution: v.resolution, costVnd: v.costVnd, chargedVnd: v.chargedVnd }, reason: v.rejectReason ?? undefined });
  return { ok: true, id: claimId, message: `Ca bảo hành: ${WARRANTY_CLAIM_STATUS_LABEL[v.status]}.` };
}

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_LIMITS,
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  canTransitionAppointment,
  packageBalance,
  packageUsable,
  type AppointmentStatus,
} from "@/lib/constants/appointments";
import { vnClock, vnDateKey } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";

/**
 * ═══════════ LỊCH HẸN & LIỆU TRÌNH — ĐƯỜNG GHI (docs/verticals/appointments.md) ═══════════
 *
 *  · Mọi lượt ghi cần `appointments:write` (khoá của module `appointments` — tắt module ⇒ `can()` từ chối).
 *  · CHẶN TRÙNG GIỜ: một kỹ thuật viên không có hai lịch ĐANG HIỆU LỰC chồng giờ. Kiểm trong giao dịch, SAU khoá tư vấn theo
 *    người (`pg_advisory_xact_lock`) — hai lễ tân đặt cùng lúc cho cùng một người thì lượt sau thấy lượt trước.
 *  · LIỆU TRÌNH: số buổi đếm lúc ghi từ lịch thật (khoá tư vấn theo gói) — không bộ đếm nào để lệch.
 *  · Người làm đi bằng khoá tài khoản; tên là ảnh chụp do máy chủ đọc (luật 34). Huỷ bắt buộc lý do.
 */

export type AppointmentResult = { ok: true; id: string; message: string } | MetaFailure;

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

function gate(user: SessionUser): MetaFailure | null {
  return can(user, "appointments:write") ? null : fail("FORBIDDEN", "Bạn không có quyền đặt / sửa lịch hẹn (appointments:write).");
}

const slotZ = z
  .object({
    customerId: z.string({ error: "Chọn khách" }).trim().min(1, "Chọn khách").max(200),
    variantId: z.string().trim().max(200).nullable().default(null),
    serviceName: z.string().trim().max(APPOINTMENT_LIMITS.nameMax).default(""),
    staffUserId: z.string().trim().max(200).nullable().default(null),
    startsAt: z.iso.datetime({ offset: true, error: "Nhập giờ bắt đầu" }),
    durationMin: z.number({ error: "Nhập thời lượng" }).int("Thời lượng là số phút nguyên").min(APPOINTMENT_LIMITS.minMinutes, `Tối thiểu ${APPOINTMENT_LIMITS.minMinutes} phút`).max(APPOINTMENT_LIMITS.maxMinutes, "Quá dài"),
    packageId: z.string().trim().max(200).nullable().default(null),
    note: z.string().max(APPOINTMENT_LIMITS.noteMax).default(""),
  })
  .strict();

export type AppointmentInput = z.input<typeof slotZ>;

type Resolved = { customerId: string; variantId: string | null; serviceName: string; staffUserId: string | null; start: Date; end: Date; packageId: string | null; note: string };

/** Kiểm đầu vào + tra khách / dịch vụ / kỹ thuật viên / liệu trình THẬT. Không ghi gì. */
async function resolveSlot(raw: unknown): Promise<{ ok: true; v: Resolved } | MetaFailure> {
  const parsed = slotZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const errors: FieldError[] = [];
  const [customer] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, v.customerId)).limit(1);
  if (!customer) errors.push({ field: "customerId", message: "Khách không tồn tại trong tổ chức này." });
  let serviceName = v.serviceName;
  if (v.variantId) {
    const [row] = await db
      .select({ name: schema.products.name, detail: schema.productVariants.detail, size: schema.productVariants.size, removed: schema.productVariants.isRemoved })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.id, v.variantId))
      .limit(1);
    if (!row || row.removed) errors.push({ field: "variantId", message: "Dịch vụ không còn — chọn lại." });
    else serviceName = [row.name, row.detail.trim() || row.size.trim()].filter(Boolean).join(" · ");
  }
  if (!serviceName) errors.push({ field: "serviceName", message: "Chọn dịch vụ hoặc ghi tên dịch vụ." });
  if (v.staffUserId) {
    const [staff] = await db.select({ active: schema.users.active }).from(schema.users).where(eq(schema.users.id, v.staffUserId)).limit(1);
    if (!staff?.active) errors.push({ field: "staffUserId", message: "Kỹ thuật viên không còn hoạt động." });
  }
  if (v.packageId) {
    const [pkg] = await db.select({ customerId: schema.customerPackages.customerId }).from(schema.customerPackages).where(eq(schema.customerPackages.id, v.packageId)).limit(1);
    if (!pkg || pkg.customerId !== v.customerId) errors.push({ field: "packageId", message: "Liệu trình không thuộc khách này." });
  }
  if (errors.length) return fail("INVALID", errors);
  const start = new Date(v.startsAt);
  return { ok: true, v: { customerId: v.customerId, variantId: v.variantId, serviceName: serviceName.slice(0, APPOINTMENT_LIMITS.nameMax), staffUserId: v.staffUserId, start, end: new Date(start.getTime() + v.durationMin * 60_000), packageId: v.packageId, note: v.note.trim() } };
}

/** Trong giao dịch: khoá theo kỹ thuật viên rồi tìm lịch đang hiệu lực chồng giờ (bỏ chính lịch đang sửa). */
async function staffConflict(tx: Tx, staffUserId: string, start: Date, end: Date, exceptId: string | null) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appt-staff:${staffUserId}`}))`);
  const a = schema.appointments;
  const [hit] = await tx
    .select({ id: a.id, serviceName: a.serviceName, startsAt: a.startsAt, endsAt: a.endsAt })
    .from(a)
    .where(and(eq(a.staffUserId, staffUserId), inArray(a.status, [...ACTIVE_APPOINTMENT_STATUSES]), sql`${a.startsAt} < ${end}`, sql`${a.endsAt} > ${start}`, exceptId ? ne(a.id, exceptId) : undefined))
    .limit(1);
  return hit ?? null;
}

/** Trong giao dịch: khoá theo gói rồi đếm buổi đã làm / đang giữ (bỏ chính lịch đang sửa khỏi số giữ chỗ). */
async function packageState(tx: Tx, packageId: string, exceptId: string | null) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appt-pkg:${packageId}`}))`);
  const [pkg] = await tx.select().from(schema.customerPackages).where(eq(schema.customerPackages.id, packageId)).limit(1);
  if (!pkg) return null;
  const a = schema.appointments;
  const [c] = await tx
    .select({
      used: sql<number>`count(*) filter (where ${a.status} = 'DONE')`.mapWith(Number),
      reserved: sql<number>`count(*) filter (where ${a.status} in ('BOOKED','CONFIRMED','CHECKED_IN'))`.mapWith(Number),
    })
    .from(a)
    .where(and(eq(a.packageId, packageId), exceptId ? ne(a.id, exceptId) : undefined));
  return { pkg, balance: packageBalance(pkg.totalSessions, c?.used ?? 0, c?.reserved ?? 0) };
}

function clash(hit: { serviceName: string; startsAt: Date; endsAt: Date }): MetaFailure {
  return fail("CONFLICT", [{ field: "staffUserId", message: `Kỹ thuật viên đã có lịch «${hit.serviceName}» ${vnClock(hit.startsAt)}–${vnClock(hit.endsAt)} ngày ${vnDateKey(hit.startsAt)} — chọn giờ hoặc người khác.` }]);
}

export async function createAppointmentCore(user: SessionUser, raw: unknown): Promise<AppointmentResult> {
  const denied = gate(user);
  if (denied) return denied;
  const r = await resolveSlot(raw);
  if (!r.ok) return r;
  const v = r.v;
  const db = await getDb();
  const id = crypto.randomUUID();
  const out = await db.transaction(async (tx) => {
    if (v.staffUserId) {
      const hit = await staffConflict(tx, v.staffUserId, v.start, v.end, null);
      if (hit) return clash(hit);
    }
    if (v.packageId) {
      const st = await packageState(tx, v.packageId, null);
      const usable = st ? packageUsable(st.pkg, st.balance, vnDateKey(v.start)) : { ok: false as const, reason: "Không có liệu trình này." };
      if (!usable.ok) return fail("INVALID", [{ field: "packageId", message: usable.reason }]);
    }
    await tx.insert(schema.appointments).values({ id, customerId: v.customerId, variantId: v.variantId, serviceName: v.serviceName, staffUserId: v.staffUserId, startsAt: v.start, endsAt: v.end, packageId: v.packageId, note: v.note, status: "BOOKED", createdByUserId: user.id, createdByName: user.name });
    return null;
  });
  if (out) return out;
  await audit({ userId: user.id, userEmail: user.email, action: "APPOINTMENT_CREATE", entity: "APPOINTMENT", entityId: id, before: null, after: { customerId: v.customerId, service: v.serviceName, staffUserId: v.staffUserId, startsAt: v.start.toISOString(), endsAt: v.end.toISOString(), packageId: v.packageId }, reason: "Đặt lịch hẹn" });
  return { ok: true, id, message: `Đã đặt «${v.serviceName}» ${vnClock(v.start)} ngày ${vnDateKey(v.start)}.` };
}

/**
 * BOT ĐẶT LỊCH (chatbot bán hàng, lib/constants/booking.ts): KHÔNG gán kỹ thuật viên, KHÔNG gắn liệu trình — lễ tân xếp
 * sau. Cổng là MODULE (bot không có phiên người); sức chứa kiểm LẠI trong giao dịch sau khoá tư vấn chung của tổ chức —
 * hai khách chat cùng lúc thì lượt sau thấy lượt trước và không lấy được chỗ cuối cùng. Tác nhân là MÁY (luật 36).
 */
export async function createAppointmentAsAgent(
  agent: { name: string; source: string },
  input: { customerId: string; variantId: string; startsAt: Date; durationMin: number; note: string },
  capacity: number,
): Promise<AppointmentResult> {
  if (!(await canUseModule("appointments"))) return fail("MODULE_DISABLED", "Module Lịch hẹn chưa bật cho tổ chức này.");
  const r = await resolveSlot({ customerId: input.customerId, variantId: input.variantId, startsAt: input.startsAt.toISOString(), durationMin: input.durationMin, note: input.note });
  if (!r.ok) return r;
  const v = r.v;
  const db = await getDb();
  const id = crypto.randomUUID();
  const full = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('appt-capacity'))`);
    const a = schema.appointments;
    const [c] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(a)
      .where(and(inArray(a.status, [...ACTIVE_APPOINTMENT_STATUSES]), sql`${a.startsAt} < ${v.end}`, sql`${a.endsAt} > ${v.start}`));
    if ((c?.n ?? 0) >= capacity) return true;
    await tx.insert(schema.appointments).values({ id, customerId: v.customerId, variantId: v.variantId, serviceName: v.serviceName, staffUserId: null, startsAt: v.start, endsAt: v.end, packageId: null, note: v.note, status: "BOOKED", createdByUserId: null, createdByName: agent.name });
    return false;
  });
  if (full) return fail("CONFLICT", [{ field: "startsAt", message: `Khung ${vnClock(v.start)} ngày ${vnDateKey(v.start)} vừa kín — chọn giờ khác.` }]);
  await audit({ userId: null, userEmail: `agent:${agent.source}`, actorKind: "AGENT", action: "APPOINTMENT_CREATE", entity: "APPOINTMENT", entityId: id, before: null, after: { customerId: v.customerId, service: v.serviceName, staffUserId: null, startsAt: v.start.toISOString(), endsAt: v.end.toISOString(), via: agent.name }, reason: `Đặt bởi ${agent.name}` });
  return { ok: true, id, message: `Đã đặt «${v.serviceName}» ${vnClock(v.start)} ngày ${vnDateKey(v.start)}.` };
}

/** Lịch ĐANG HIỆU LỰC chồng lên một khoảng (mọi kỹ thuật viên) — nguồn của giờ trống bot đọc cho khách. */
export async function activeAppointmentRanges(from: Date, to: Date): Promise<{ start: Date; end: Date }[]> {
  const db = await getDb();
  const a = schema.appointments;
  const rows = await db
    .select({ start: a.startsAt, end: a.endsAt })
    .from(a)
    .where(and(inArray(a.status, [...ACTIVE_APPOINTMENT_STATUSES]), sql`${a.startsAt} < ${to}`, sql`${a.endsAt} > ${from}`));
  return rows;
}

/** Đổi giờ / kỹ thuật viên / dịch vụ / liệu trình của một lịch ĐANG HIỆU LỰC. Lịch đã xong / không tới / huỷ không sửa. */
export async function updateAppointmentCore(user: SessionUser, id: string, raw: unknown): Promise<AppointmentResult> {
  const denied = gate(user);
  if (denied) return denied;
  const db = await getDb();
  const [row] = await db.select().from(schema.appointments).where(eq(schema.appointments.id, id)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có lịch hẹn này.");
  if (!(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(row.status)) return fail("CONFLICT", `Lịch đang «${APPOINTMENT_STATUS_LABEL[row.status as AppointmentStatus] ?? row.status}» — không sửa được; đặt lịch mới.`);
  const r = await resolveSlot(raw);
  if (!r.ok) return r;
  const v = r.v;
  if (v.customerId !== row.customerId) return fail("INVALID", [{ field: "customerId", message: "Không đổi khách của một lịch — huỷ và đặt lịch mới cho khách kia." }]);
  const out = await db.transaction(async (tx) => {
    if (v.staffUserId) {
      const hit = await staffConflict(tx, v.staffUserId, v.start, v.end, id);
      if (hit) return clash(hit);
    }
    if (v.packageId) {
      const st = await packageState(tx, v.packageId, id);
      const usable = st ? packageUsable(st.pkg, st.balance, vnDateKey(v.start)) : { ok: false as const, reason: "Không có liệu trình này." };
      if (!usable.ok) return fail("INVALID", [{ field: "packageId", message: usable.reason }]);
    }
    const won = await tx
      .update(schema.appointments)
      .set({ variantId: v.variantId, serviceName: v.serviceName, staffUserId: v.staffUserId, startsAt: v.start, endsAt: v.end, packageId: v.packageId, note: v.note, updatedAt: new Date() })
      .where(and(eq(schema.appointments.id, id), inArray(schema.appointments.status, [...ACTIVE_APPOINTMENT_STATUSES])))
      .returning({ id: schema.appointments.id });
    return won.length ? null : fail("CONFLICT", "Lịch vừa đổi trạng thái — tải lại trang.");
  });
  if (out) return out;
  await audit({ userId: user.id, userEmail: user.email, action: "APPOINTMENT_UPDATE", entity: "APPOINTMENT", entityId: id, before: { staffUserId: row.staffUserId, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), packageId: row.packageId }, after: { staffUserId: v.staffUserId, startsAt: v.start.toISOString(), endsAt: v.end.toISOString(), packageId: v.packageId }, reason: "Đổi lịch hẹn" });
  return { ok: true, id, message: `Đã đổi lịch sang ${vnClock(v.start)} ngày ${vnDateKey(v.start)}.` };
}

const statusZ = z.object({ status: z.enum(APPOINTMENT_STATUSES), reason: z.string().trim().max(500).default("") }).strict();

export async function setAppointmentStatusCore(user: SessionUser, id: string, raw: unknown): Promise<AppointmentResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = statusZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const { status, reason } = parsed.data;
  if (status === "CANCELLED" && reason.length < APPOINTMENT_LIMITS.reasonMin) return fail("INVALID", [{ field: "reason", message: "Huỷ lịch cần ghi lý do." }]);
  const db = await getDb();
  const [row] = await db.select().from(schema.appointments).where(eq(schema.appointments.id, id)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có lịch hẹn này.");
  const from = row.status as AppointmentStatus;
  if (from === status) return { ok: true, id, message: `Lịch đã ở «${APPOINTMENT_STATUS_LABEL[status]}».` };
  if (!canTransitionAppointment(from, status)) return fail("CONFLICT", `Không chuyển được từ «${APPOINTMENT_STATUS_LABEL[from]}» sang «${APPOINTMENT_STATUS_LABEL[status]}».`);
  const now = new Date();
  const out = await db.transaction(async (tx) => {
    if (status === "DONE" && row.packageId) {
      // Làm xong một buổi của liệu trình: số buổi ĐÃ LÀM (không kể lịch này) phải còn dưới tổng.
      const st = await packageState(tx, row.packageId, id);
      if (st && st.balance.used >= st.balance.total) return fail("INVALID", [{ field: "status", message: `Liệu trình «${st.pkg.name}» đã dùng hết ${st.balance.total} buổi.` }]);
    }
    const won = await tx
      .update(schema.appointments)
      .set({ status, cancelReason: status === "CANCELLED" ? reason : row.cancelReason, statusChangedAt: now, updatedAt: now })
      .where(and(eq(schema.appointments.id, id), eq(schema.appointments.status, from)))
      .returning({ id: schema.appointments.id });
    return won.length ? null : fail("CONFLICT", "Lịch vừa đổi trạng thái — tải lại trang.");
  });
  if (out) return out;
  await audit({ userId: user.id, userEmail: user.email, action: "APPOINTMENT_STATUS", entity: "APPOINTMENT", entityId: id, before: { status: from }, after: { status }, reason: reason || `Lịch hẹn → ${APPOINTMENT_STATUS_LABEL[status]}` });
  return { ok: true, id, message: `«${row.serviceName}»: ${APPOINTMENT_STATUS_LABEL[status]}.` };
}

// ─────────────────────────── Liệu trình ───────────────────────────

const packageZ = z
  .object({
    name: z.string().trim().min(1, "Đặt tên liệu trình").max(APPOINTMENT_LIMITS.nameMax),
    variantId: z.string().trim().max(200).nullable().default(null),
    totalSessions: z.number({ error: "Nhập số buổi" }).int("Số buổi là số nguyên").min(1).max(APPOINTMENT_LIMITS.maxSessions),
    expiresOn: z.iso.date({ error: "Ngày hết hạn không hợp lệ" }).nullable().default(null),
    orderId: z.string().trim().max(200).nullable().default(null),
    note: z.string().max(APPOINTMENT_LIMITS.noteMax).default(""),
  })
  .strict();

export type PackageInput = z.input<typeof packageZ>;

/** Mở liệu trình N buổi cho khách (thường sau khi khách trả tiền gói qua một đơn tạo tay — `orderId` để tra ngược). */
export async function createPackageCore(user: SessionUser, customerId: string, raw: unknown): Promise<AppointmentResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = packageZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const [customer] = await db.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!customer) return fail("NOT_FOUND", "Không có khách này.");
  if (v.orderId) {
    const [order] = await db.select({ customerId: schema.orders.customerId }).from(schema.orders).where(eq(schema.orders.id, v.orderId)).limit(1);
    if (!order || order.customerId !== customerId) return fail("INVALID", [{ field: "orderId", message: "Đơn không thuộc khách này." }]);
  }
  const [row] = await db.insert(schema.customerPackages).values({ customerId, name: v.name, variantId: v.variantId, totalSessions: v.totalSessions, expiresOn: v.expiresOn, orderId: v.orderId, note: v.note.trim(), createdByUserId: user.id }).returning({ id: schema.customerPackages.id });
  await audit({ userId: user.id, userEmail: user.email, action: "PACKAGE_CREATE", entity: "CUSTOMER", entityId: customerId, before: null, after: { packageId: row.id, name: v.name, totalSessions: v.totalSessions, expiresOn: v.expiresOn, orderId: v.orderId }, reason: "Mở liệu trình" });
  return { ok: true, id: row.id, message: `Đã mở liệu trình «${v.name}» ${v.totalSessions} buổi cho ${customer.name}.` };
}

/** Đóng liệu trình (khách huỷ gói / hết hạn): không đặt thêm buổi được; lịch đã đặt giữ nguyên để người quyết. */
export async function closePackageCore(user: SessionUser, id: string, reason: string): Promise<AppointmentResult> {
  const denied = gate(user);
  if (denied) return denied;
  if ((reason ?? "").trim().length < APPOINTMENT_LIMITS.reasonMin) return fail("INVALID", [{ field: "reason", message: "Đóng liệu trình cần ghi lý do." }]);
  const db = await getDb();
  const won = await db.update(schema.customerPackages).set({ status: "CLOSED", updatedAt: new Date() }).where(and(eq(schema.customerPackages.id, id), eq(schema.customerPackages.status, "ACTIVE"))).returning({ customerId: schema.customerPackages.customerId, name: schema.customerPackages.name });
  if (!won.length) return fail("CONFLICT", "Liệu trình không còn mở.");
  await audit({ userId: user.id, userEmail: user.email, action: "PACKAGE_CLOSE", entity: "CUSTOMER", entityId: won[0].customerId, before: { packageId: id, status: "ACTIVE" }, after: { status: "CLOSED" }, reason: reason.trim() });
  return { ok: true, id, message: `Đã đóng liệu trình «${won[0].name}».` };
}

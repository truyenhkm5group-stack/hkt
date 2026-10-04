import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { holdExpiresAt, holdLive, parseUnitLines, RE_LIMITS } from "@/lib/constants/real-estate";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";

/**
 * ═══════════ BẢNG HÀNG BĐS — ĐƯỜNG GHI (docs/verticals/real-estate.md) ═══════════
 *
 *  · Giữ chỗ / cọc cần `real_estate:hold`; dự án, căn, khoá căn, nhả giữ chỗ của NGƯỜI KHÁC, hoàn / bỏ cọc, ký bán cần
 *    `real_estate:manage`. Tắt module ⇒ `can()` từ chối.
 *  · Mọi lượt ghi lên MỘT căn chạy trong giao dịch sau khoá tư vấn theo căn; chỉ mục duy nhất có điều kiện (một giữ chỗ ACTIVE /
 *    một cọc ACTIVE mỗi căn) chặn lần cuối. Giữ chỗ quá hạn được chuyển EXPIRED ngay trong giao dịch giữ mới.
 *  · Khách của một lượt giữ chỗ là của sale giữ: sale khác không chuyển giữ chỗ người khác thành cọc.
 *  · Lý do bắt buộc cho: khoá căn, nhả giữ chỗ của người khác, hoàn cọc, khách bỏ cọc. Mọi lượt ghi có nhật ký.
 */

export type ReResult = { ok: true; id: string; message: string } | MetaFailure;
type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

const canHold = (u: SessionUser) => can(u, "real_estate:hold");
const canManage = (u: SessionUser) => can(u, "real_estate:manage");
const denyHold = () => fail("FORBIDDEN", "Bạn không có quyền giữ chỗ / đặt cọc (real_estate:hold).");
const denyManage = () => fail("FORBIDDEN", "Chỉ quản lý sàn làm được việc này (real_estate:manage).");
const hhmm = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(11, 16) + " " + new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10).split("-").reverse().join("/");
const isUniqueViolation = (e: unknown) => (e as { code?: string; cause?: { code?: string } })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505";

// ═══ DỰ ÁN & CĂN ═══

const projectZ = z
  .object({
    code: z.string({ error: "Nhập mã dự án" }).trim().min(1, "Nhập mã dự án").max(RE_LIMITS.codeMax),
    name: z.string({ error: "Nhập tên dự án" }).trim().min(1, "Nhập tên dự án").max(RE_LIMITS.nameMax),
    holdHours: z.number({ error: "Khai số giờ giữ chỗ" }).int("Số giờ nguyên").min(RE_LIMITS.holdHoursMin, "Ít nhất 1 giờ").max(RE_LIMITS.holdHoursMax, "Tối đa 720 giờ"),
    note: z.string().trim().max(RE_LIMITS.textMax).default(""),
  })
  .strict();

export type ReProjectInput = z.input<typeof projectZ>;

export async function createReProjectCore(user: SessionUser, raw: unknown): Promise<ReResult> {
  if (!canManage(user)) return denyManage();
  const parsed = projectZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const [dup] = await db.select({ id: schema.reProjects.id }).from(schema.reProjects).where(sql`lower(${schema.reProjects.code}) = ${v.code.toLowerCase()}`).limit(1);
  if (dup) return fail("CONFLICT", [{ field: "code", message: `Mã dự án «${v.code}» đã có.` }]);
  const id = crypto.randomUUID();
  await db.insert(schema.reProjects).values({ id, ...v });
  await audit({ userId: user.id, userEmail: user.email, action: "RE_PROJECT_CREATE", entity: "RE_PROJECT", entityId: id, before: null, after: v, reason: "Tạo dự án" });
  return { ok: true, id, message: `Đã tạo dự án «${v.name}» — giữ chỗ ${v.holdHours} giờ.` };
}

/** Thêm căn hàng loạt (dán danh sách). Dòng hỏng / mã đã có ⇒ KHÔNG thêm gì, trả danh sách lỗi theo dòng. */
export async function addReUnitsCore(user: SessionUser, projectId: string, text: string): Promise<ReResult> {
  if (!canManage(user)) return denyManage();
  const { units, errors } = parseUnitLines(String(text ?? ""));
  if (errors.length) return fail("INVALID", errors.slice(0, 20).map((e) => ({ field: "text", message: `Dòng ${e.line}: ${e.message}` })));
  if (!units.length) return fail("INVALID", [{ field: "text", message: "Chưa có dòng căn nào." }]);
  if (units.length > RE_LIMITS.bulkUnitsMax) return fail("INVALID", [{ field: "text", message: `Tối đa ${RE_LIMITS.bulkUnitsMax} căn mỗi lượt.` }]);
  const db = await getDb();
  const [project] = await db.select({ id: schema.reProjects.id, name: schema.reProjects.name }).from(schema.reProjects).where(eq(schema.reProjects.id, projectId)).limit(1);
  if (!project) return fail("NOT_FOUND", "Không có dự án này.");
  const existing = await db.select({ code: schema.reUnits.code }).from(schema.reUnits).where(eq(schema.reUnits.projectId, projectId));
  const taken = new Set(existing.map((e) => e.code.toLowerCase()));
  const clash = units.filter((u) => taken.has(u.code.toLowerCase())).map((u) => u.code);
  if (clash.length) return fail("CONFLICT", [{ field: "text", message: `Mã căn đã có trong dự án: ${clash.slice(0, 10).join(", ")}${clash.length > 10 ? "…" : ""}` }]);
  await db.insert(schema.reUnits).values(units.map((u) => ({ projectId, code: u.code, block: u.block, floor: u.floor, areaM2: u.areaM2, listPrice: u.listPrice })));
  await audit({ userId: user.id, userEmail: user.email, action: "RE_UNITS_ADD", entity: "RE_PROJECT", entityId: projectId, before: null, after: { count: units.length, codes: units.slice(0, 50).map((u) => u.code) }, reason: "Thêm căn" });
  return { ok: true, id: projectId, message: `Đã thêm ${units.length} căn vào «${project.name}».` };
}

// ═══ GIỮ CHỖ ═══

async function lockUnit(tx: Tx, unitId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`re-unit:${unitId}`}))`);
  const [unit] = await tx
    .select({ id: schema.reUnits.id, code: schema.reUnits.code, soldAt: schema.reUnits.soldAt, lockedAt: schema.reUnits.lockedAt, holdHours: schema.reProjects.holdHours, projectActive: schema.reProjects.active })
    .from(schema.reUnits)
    .innerJoin(schema.reProjects, eq(schema.reProjects.id, schema.reUnits.projectId))
    .where(eq(schema.reUnits.id, unitId))
    .limit(1);
  return unit ?? null;
}

/** Giữ ACTIVE đã quá hạn ⇒ EXPIRED (mốc đóng = hạn), để chỉ mục «một ACTIVE mỗi căn» nhường chỗ cho lượt giữ mới. */
async function expireStaleHolds(tx: Tx, unitId: string, now: Date) {
  await tx
    .update(schema.reHolds)
    .set({ status: "EXPIRED", closedAt: sql`${schema.reHolds.expiresAt}` })
    .where(and(eq(schema.reHolds.unitId, unitId), eq(schema.reHolds.status, "ACTIVE"), lte(schema.reHolds.expiresAt, now)));
}

const holdZ = z
  .object({
    customerName: z.string({ error: "Nhập tên khách" }).trim().min(1, "Nhập tên khách").max(RE_LIMITS.nameMax),
    customerPhone: z.string().trim().max(30).default(""),
  })
  .strict();

export async function holdReUnitCore(user: SessionUser, unitId: string, raw: unknown, now: Date = new Date()): Promise<ReResult> {
  if (!canHold(user)) return denyHold();
  const parsed = holdZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const id = crypto.randomUUID();
  try {
    const outcome = await db.transaction(async (tx) => {
      const unit = await lockUnit(tx, unitId);
      if (!unit) return fail("NOT_FOUND", "Không có căn này.");
      if (!unit.projectActive) return fail("CONFLICT", "Dự án đã ngưng bán.");
      if (unit.soldAt) return fail("CONFLICT", `Căn ${unit.code} đã bán.`);
      if (unit.lockedAt) return fail("CONFLICT", `Căn ${unit.code} đang bị chủ đầu tư khoá.`);
      const [dep] = await tx.select({ id: schema.reDeposits.id }).from(schema.reDeposits).where(and(eq(schema.reDeposits.unitId, unitId), eq(schema.reDeposits.status, "ACTIVE"))).limit(1);
      if (dep) return fail("CONFLICT", `Căn ${unit.code} đã có khách cọc.`);
      await expireStaleHolds(tx, unitId, now);
      const [live] = await tx.select({ saleName: schema.reHolds.saleName, expiresAt: schema.reHolds.expiresAt, status: schema.reHolds.status }).from(schema.reHolds).where(and(eq(schema.reHolds.unitId, unitId), eq(schema.reHolds.status, "ACTIVE"))).limit(1);
      if (live && holdLive(live, now)) return fail("CONFLICT", `Căn ${unit.code} đang được ${live.saleName || "sale khác"} giữ tới ${hhmm(live.expiresAt)}.`);
      const expiresAt = holdExpiresAt(now, unit.holdHours);
      await tx.insert(schema.reHolds).values({ id, unitId, saleUserId: user.id, saleName: user.name, customerName: v.customerName, customerPhone: v.customerPhone, heldAt: now, expiresAt });
      return { ok: true as const, id, message: `Đã giữ căn ${unit.code} cho ${v.customerName} tới ${hhmm(expiresAt)}.` };
    });
    if (outcome.ok) await audit({ userId: user.id, userEmail: user.email, action: "RE_HOLD", entity: "RE_UNIT", entityId: unitId, before: null, after: { holdId: id, customerName: v.customerName }, reason: "Giữ chỗ" });
    return outcome;
  } catch (e) {
    // Chỉ mục «một giữ chỗ ACTIVE mỗi căn» là lần chặn cuối khi khoá tư vấn không bao trùm (vd. hai tiến trình khác bể kết nối).
    if (isUniqueViolation(e)) return fail("CONFLICT", "Căn vừa được người khác giữ — tải lại bảng hàng.");
    throw e;
  }
}

/** Nhả giữ chỗ. Của mình: không cần lý do. Của người khác: chỉ quản lý, bắt buộc lý do. */
export async function releaseReHoldCore(user: SessionUser, holdId: string, reason: string, now: Date = new Date()): Promise<ReResult> {
  if (!canHold(user) && !canManage(user)) return denyHold();
  const db = await getDb();
  const h = schema.reHolds;
  const [hold] = await db.select({ id: h.id, unitId: h.unitId, saleUserId: h.saleUserId, status: h.status, expiresAt: h.expiresAt }).from(h).where(eq(h.id, holdId)).limit(1);
  if (!hold || !holdLive(hold, now)) return fail("NOT_FOUND", "Không có lượt giữ chỗ còn hiệu lực này.");
  const own = hold.saleUserId === user.id;
  const why = (reason ?? "").trim();
  if (!own && !canManage(user)) return denyManage();
  if (!own && why.length < RE_LIMITS.reasonMin) return fail("INVALID", [{ field: "reason", message: "Nhả giữ chỗ của người khác phải ghi lý do." }]);
  const [row] = await db.update(h).set({ status: "RELEASED", closedAt: now, closeReason: why || "Sale tự nhả" }).where(and(eq(h.id, holdId), eq(h.status, "ACTIVE"))).returning({ id: h.id });
  if (!row) return fail("CONFLICT", "Lượt giữ vừa thay đổi — tải lại bảng hàng.");
  await audit({ userId: user.id, userEmail: user.email, action: "RE_HOLD_RELEASE", entity: "RE_UNIT", entityId: hold.unitId, before: { holdId, status: "ACTIVE" }, after: { status: "RELEASED" }, reason: why || "Sale tự nhả" });
  return { ok: true, id: holdId, message: "Đã nhả giữ chỗ." };
}

// ═══ CỌC & KÝ BÁN ═══

const depositZ = z
  .object({
    amount: z.number({ error: "Nhập số tiền cọc" }).int("Số tiền nguyên (đồng)").min(1, "Lớn hơn 0").max(RE_LIMITS.priceMax),
    customerName: z.string().trim().max(RE_LIMITS.nameMax).default(""),
    customerPhone: z.string().trim().max(30).default(""),
  })
  .strict();

/**
 * Đặt cọc: căn đang được CHÍNH MÌNH giữ ⇒ chuyển giữ chỗ thành cọc (khách của lượt giữ); căn còn trống ⇒ cọc thẳng (cần tên
 * khách). Căn đang người khác giữ ⇒ chặn — khách của lượt giữ là của sale giữ.
 */
export async function depositReUnitCore(user: SessionUser, unitId: string, raw: unknown, now: Date = new Date()): Promise<ReResult> {
  if (!canHold(user)) return denyHold();
  const parsed = depositZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const id = crypto.randomUUID();
  try {
    const outcome = await db.transaction(async (tx) => {
      const unit = await lockUnit(tx, unitId);
      if (!unit) return fail("NOT_FOUND", "Không có căn này.");
      if (unit.soldAt) return fail("CONFLICT", `Căn ${unit.code} đã bán.`);
      if (unit.lockedAt) return fail("CONFLICT", `Căn ${unit.code} đang bị chủ đầu tư khoá.`);
      const [dep] = await tx.select({ id: schema.reDeposits.id }).from(schema.reDeposits).where(and(eq(schema.reDeposits.unitId, unitId), eq(schema.reDeposits.status, "ACTIVE"))).limit(1);
      if (dep) return fail("CONFLICT", `Căn ${unit.code} đã có khách cọc.`);
      await expireStaleHolds(tx, unitId, now);
      const [live] = await tx.select().from(schema.reHolds).where(and(eq(schema.reHolds.unitId, unitId), eq(schema.reHolds.status, "ACTIVE"))).limit(1);
      let customerName = v.customerName;
      let customerPhone = v.customerPhone;
      if (live && holdLive(live, now)) {
        if (live.saleUserId !== user.id) return fail("CONFLICT", `Căn ${unit.code} đang được ${live.saleName || "sale khác"} giữ — không cọc chồng.`);
        customerName = customerName || live.customerName;
        customerPhone = customerPhone || live.customerPhone;
        await tx.update(schema.reHolds).set({ status: "CONVERTED", closedAt: now }).where(eq(schema.reHolds.id, live.id));
      } else if (!customerName) return fail("INVALID", [{ field: "customerName", message: "Nhập tên khách cọc." }]);
      await tx.insert(schema.reDeposits).values({ id, unitId, holdId: live && holdLive(live, now) ? live.id : null, saleUserId: user.id, saleName: user.name, customerName, customerPhone, amount: v.amount, depositedAt: now });
      return { ok: true as const, id, message: `Đã ghi cọc ${v.amount.toLocaleString("vi-VN")} ₫ cho căn ${unit.code} — khách ${customerName}.` };
    });
    if (outcome.ok) await audit({ userId: user.id, userEmail: user.email, action: "RE_DEPOSIT", entity: "RE_UNIT", entityId: unitId, before: null, after: { depositId: id, amount: v.amount }, reason: "Đặt cọc" });
    return outcome;
  } catch (e) {
    if (isUniqueViolation(e)) return fail("CONFLICT", "Căn vừa có người cọc — tải lại bảng hàng.");
    throw e;
  }
}

const closeZ = z.object({ outcome: z.enum(["REFUNDED", "FORFEITED"]), reason: z.string().trim().min(RE_LIMITS.reasonMin, "Ghi lý do (ít nhất 3 ký tự)").max(500) }).strict();

/** Hoàn cọc / khách bỏ cọc — quản lý, bắt buộc lý do. Căn trở lại còn trống. */
export async function closeReDepositCore(user: SessionUser, depositId: string, raw: unknown, now: Date = new Date()): Promise<ReResult> {
  if (!canManage(user)) return denyManage();
  const parsed = closeZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const db = await getDb();
  const d = schema.reDeposits;
  const [row] = await db.update(d).set({ status: parsed.data.outcome, closedAt: now, closeReason: parsed.data.reason }).where(and(eq(d.id, depositId), eq(d.status, "ACTIVE"))).returning({ id: d.id, unitId: d.unitId, amount: d.amount });
  if (!row) return fail("NOT_FOUND", "Không có khoản cọc đang hiệu lực này.");
  await audit({ userId: user.id, userEmail: user.email, action: "RE_DEPOSIT_CLOSE", entity: "RE_UNIT", entityId: row.unitId, before: { depositId, status: "ACTIVE" }, after: { status: parsed.data.outcome, amount: row.amount }, reason: parsed.data.reason });
  return { ok: true, id: depositId, message: parsed.data.outcome === "REFUNDED" ? "Đã ghi hoàn cọc — căn trở lại còn trống." : "Đã ghi khách bỏ cọc — căn trở lại còn trống." };
}

/** Ký bán: căn phải có cọc đang hiệu lực; cọc chuyển CONVERTED, căn ghi số hợp đồng. Quản lý. */
export async function sellReUnitCore(user: SessionUser, unitId: string, contract: string, now: Date = new Date()): Promise<ReResult> {
  if (!canManage(user)) return denyManage();
  const no = (contract ?? "").trim().slice(0, 80);
  if (!no) return fail("INVALID", [{ field: "contract", message: "Nhập số hợp đồng." }]);
  const db = await getDb();
  const outcome = await db.transaction(async (tx) => {
    const unit = await lockUnit(tx, unitId);
    if (!unit) return fail("NOT_FOUND", "Không có căn này.");
    if (unit.soldAt) return fail("CONFLICT", `Căn ${unit.code} đã bán.`);
    const [dep] = await tx.select({ id: schema.reDeposits.id }).from(schema.reDeposits).where(and(eq(schema.reDeposits.unitId, unitId), eq(schema.reDeposits.status, "ACTIVE"))).limit(1);
    if (!dep) return fail("CONFLICT", `Căn ${unit.code} chưa có khách cọc — ký bán đi sau cọc.`);
    await tx.update(schema.reDeposits).set({ status: "CONVERTED", closedAt: now }).where(eq(schema.reDeposits.id, dep.id));
    await tx.update(schema.reUnits).set({ soldAt: now, soldContract: no, soldByUserId: user.id, updatedAt: now }).where(eq(schema.reUnits.id, unitId));
    return { ok: true as const, id: unitId, message: `Căn ${unit.code}: đã ký bán (HĐ ${no}).` };
  });
  if (outcome.ok) await audit({ userId: user.id, userEmail: user.email, action: "RE_SELL", entity: "RE_UNIT", entityId: unitId, before: null, after: { contract: no }, reason: "Ký bán" });
  return outcome;
}

/** Khoá / mở căn (chủ đầu tư rút căn). Khoá cần lý do và căn không đang có người giữ / cọc. Quản lý. */
export async function lockReUnitCore(user: SessionUser, unitId: string, locked: boolean, reason: string, now: Date = new Date()): Promise<ReResult> {
  if (!canManage(user)) return denyManage();
  const why = (reason ?? "").trim();
  if (locked && why.length < RE_LIMITS.reasonMin) return fail("INVALID", [{ field: "reason", message: "Ghi lý do khoá căn." }]);
  const db = await getDb();
  const outcome = await db.transaction(async (tx) => {
    const unit = await lockUnit(tx, unitId);
    if (!unit) return fail("NOT_FOUND", "Không có căn này.");
    if (unit.soldAt) return fail("CONFLICT", `Căn ${unit.code} đã bán.`);
    if (locked) {
      await expireStaleHolds(tx, unitId, now);
      const [busy] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.reHolds)
        .where(and(eq(schema.reHolds.unitId, unitId), inArray(schema.reHolds.status, ["ACTIVE"])));
      const [dep] = await tx.select({ id: schema.reDeposits.id }).from(schema.reDeposits).where(and(eq(schema.reDeposits.unitId, unitId), eq(schema.reDeposits.status, "ACTIVE"))).limit(1);
      if (Number(busy?.n ?? 0) > 0 || dep) return fail("CONFLICT", `Căn ${unit.code} đang có người giữ / cọc — nhả hoặc xử lý cọc trước.`);
    }
    await tx.update(schema.reUnits).set(locked ? { lockedAt: now, lockedReason: why, updatedAt: now } : { lockedAt: null, lockedReason: null, updatedAt: now }).where(eq(schema.reUnits.id, unitId));
    return { ok: true as const, id: unitId, message: locked ? `Đã khoá căn ${unit.code}.` : `Đã mở lại căn ${unit.code}.` };
  });
  if (outcome.ok) await audit({ userId: user.id, userEmail: user.email, action: locked ? "RE_UNIT_LOCK" : "RE_UNIT_UNLOCK", entity: "RE_UNIT", entityId: unitId, before: null, after: { locked }, reason: why || "Mở căn" });
  return outcome;
}

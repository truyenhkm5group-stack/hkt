import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { countsAsHard, isStayDay, parseIcs, planIcsImport, STAY_CHANNEL_LABEL, STAY_CHANNELS, STAY_LIMITS, stayNights, type IcsImportPlan, type StayChannel } from "@/lib/constants/stays";
import { vnDateKey } from "@/lib/format";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";

/**
 * ═══════════ LƯU TRÚ — ĐƯỜNG GHI (docs/verticals/homestay.md) ═══════════
 *
 *  · Mọi lượt ghi cần `stays:write` (khoá của module `stays` — tắt module ⇒ `can()` từ chối).
 *  · ĐẶT TAY trùng một đặt phòng thật / ngày chủ khoá ⇒ CHẶN, kiểm trong giao dịch sau khoá tư vấn theo phòng (hai lễ tân bấm
 *    cùng lúc chỉ một người được). NHẬP LỊCH KÊNH thì KHÔNG chặn: kênh đã bán thật rồi, nuốt mất lượt đó là để khách đến nơi
 *    mới biết — trùng phòng hiện đỏ ở đầu trang để người xử lý.
 *  · Lượt đến từ lịch kênh chỉ KÊNH sửa được ngày / huỷ (nhập lại lịch); ERP chỉ bổ sung tên khách, SĐT, tiền, ghi chú.
 *  · Nhập lịch có CHẠY THỬ, dùng đúng `planIcsImport` của lượt ghi; mọi lượt (kể cả chạy thử) vào sổ `stay_ical_imports`.
 *  · Người thao tác đi bằng khoá tài khoản; tên là ảnh chụp do máy chủ đọc (luật 34). Huỷ cần lý do.
 */

export type StaysResult = { ok: true; id: string; message: string } | MetaFailure;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

function gate(user: SessionUser): MetaFailure | null {
  return can(user, "stays:write") ? null : fail("FORBIDDEN", "Bạn không có quyền ghi lịch phòng (stays:write).");
}

const vnDay = (d: Date) => vnDateKey(d);
const showDay = (d: string) => d.split("-").reverse().join("/");

export function newIcalToken(): string {
  return randomBytes(24).toString("base64url");
}

// ═══ PHÒNG ═══

const unitZ = z
  .object({
    name: z.string({ error: "Nhập tên phòng" }).trim().min(1, "Nhập tên phòng").max(STAY_LIMITS.nameMax),
    code: z
      .string({ error: "Nhập mã phòng" })
      .trim()
      .min(1, "Nhập mã phòng")
      .max(STAY_LIMITS.codeMax, `Mã tối đa ${STAY_LIMITS.codeMax} ký tự`)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, "Mã chỉ gồm chữ, số, khoảng trắng, . _ -"),
    capacity: z.number().int("Số khách là số nguyên").min(1).max(100).nullable().default(null),
    address: z.string().trim().max(300).default(""),
    ownerName: z.string().trim().max(STAY_LIMITS.nameMax).default(""),
    note: z.string().trim().max(STAY_LIMITS.noteMax).default(""),
    active: z.boolean().default(true),
  })
  .strict();

export type StayUnitInput = z.input<typeof unitZ>;

async function codeTaken(code: string, exceptId: string | null): Promise<boolean> {
  const db = await getDb();
  const u = schema.stayUnits;
  const [hit] = await db
    .select({ id: u.id })
    .from(u)
    .where(and(sql`lower(${u.code}) = ${code.toLowerCase()}`, exceptId ? ne(u.id, exceptId) : undefined))
    .limit(1);
  return Boolean(hit);
}

export async function createStayUnitCore(user: SessionUser, raw: unknown): Promise<StaysResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = unitZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  if (await codeTaken(v.code, null)) return fail("CONFLICT", [{ field: "code", message: `Mã «${v.code}» đã có phòng khác dùng.` }]);
  const id = crypto.randomUUID();
  const db = await getDb();
  await db.insert(schema.stayUnits).values({ id, name: v.name, code: v.code, capacity: v.capacity, address: v.address, ownerName: v.ownerName, note: v.note, active: v.active, icalToken: newIcalToken() });
  await audit({ userId: user.id, userEmail: user.email, action: "STAY_UNIT_CREATE", entity: "STAY_UNIT", entityId: id, before: null, after: { name: v.name, code: v.code, ownerName: v.ownerName }, reason: "Thêm phòng" });
  return { ok: true, id, message: `Đã thêm phòng «${v.name}».` };
}

export async function updateStayUnitCore(user: SessionUser, id: string, raw: unknown): Promise<StaysResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = unitZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  if (await codeTaken(v.code, id)) return fail("CONFLICT", [{ field: "code", message: `Mã «${v.code}» đã có phòng khác dùng.` }]);
  const db = await getDb();
  const u = schema.stayUnits;
  const [before] = await db.select().from(u).where(eq(u.id, id)).limit(1);
  if (!before) return fail("NOT_FOUND", "Không có phòng này.");
  await db.update(u).set({ name: v.name, code: v.code, capacity: v.capacity, address: v.address, ownerName: v.ownerName, note: v.note, active: v.active, updatedAt: new Date() }).where(eq(u.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "STAY_UNIT_UPDATE", entity: "STAY_UNIT", entityId: id, before: { name: before.name, code: before.code, active: before.active, ownerName: before.ownerName }, after: { name: v.name, code: v.code, active: v.active, ownerName: v.ownerName }, reason: "Sửa phòng" });
  return { ok: true, id, message: `Đã lưu phòng «${v.name}».` };
}

/** Đổi đường dẫn lịch của phòng (khi lộ). Đường cũ hết hiệu lực NGAY — phải dán đường mới vào từng kênh. */
export async function rotateStayIcalTokenCore(user: SessionUser, id: string): Promise<StaysResult> {
  const denied = gate(user);
  if (denied) return denied;
  const db = await getDb();
  const u = schema.stayUnits;
  const [row] = await db.update(u).set({ icalToken: newIcalToken(), updatedAt: new Date() }).where(eq(u.id, id)).returning({ id: u.id, name: u.name });
  if (!row) return fail("NOT_FOUND", "Không có phòng này.");
  await audit({ userId: user.id, userEmail: user.email, action: "STAY_ICAL_ROTATE", entity: "STAY_UNIT", entityId: id, before: null, after: null, reason: "Đổi đường dẫn lịch .ics" });
  return { ok: true, id, message: `Đã đổi đường dẫn lịch của «${row.name}» — dán đường mới vào từng kênh, đường cũ không còn dùng được.` };
}

// ═══ ĐẶT PHÒNG / KHOÁ NGÀY (TAY) ═══

const money = z.number().int("Số tiền là số nguyên (đồng)").min(0, "Không âm").max(STAY_LIMITS.moneyMax).nullable();

const bookingZ = z
  .object({
    unitId: z.string({ error: "Chọn phòng" }).trim().min(1, "Chọn phòng").max(200),
    kind: z.enum(["BOOKING", "BLOCK"]).default("BOOKING"),
    channel: z.enum(STAY_CHANNELS).default("DIRECT"),
    checkIn: z.string().refine(isStayDay, "Ngày nhận dạng YYYY-MM-DD"),
    checkOut: z.string().refine(isStayDay, "Ngày trả dạng YYYY-MM-DD"),
    guestName: z.string().trim().max(STAY_LIMITS.nameMax).default(""),
    guestPhone: z.string().trim().max(30).default(""),
    guests: z.number().int().min(1).max(100).nullable().default(null),
    amountVnd: money.default(null),
    note: z.string().trim().max(STAY_LIMITS.noteMax).default(""),
  })
  .strict();

export type StayBookingInput = z.input<typeof bookingZ>;

export async function createStayBookingCore(user: SessionUser, raw: unknown): Promise<StaysResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = bookingZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const nights = stayNights(v.checkIn, v.checkOut);
  if (!nights) return fail("INVALID", [{ field: "checkOut", message: "Ngày trả phải sau ngày nhận." }]);
  if (nights > STAY_LIMITS.maxNights) return fail("INVALID", [{ field: "checkOut", message: `Tối đa ${STAY_LIMITS.maxNights} đêm.` }]);
  if (v.kind === "BOOKING" && !v.guestName) return fail("INVALID", [{ field: "guestName", message: "Nhập tên khách." }]);
  const db = await getDb();
  const [unit] = await db.select({ id: schema.stayUnits.id, name: schema.stayUnits.name, active: schema.stayUnits.active }).from(schema.stayUnits).where(eq(schema.stayUnits.id, v.unitId)).limit(1);
  if (!unit) return fail("INVALID", [{ field: "unitId", message: "Phòng không tồn tại." }]);
  if (!unit.active) return fail("INVALID", [{ field: "unitId", message: "Phòng đang ngưng cho thuê." }]);
  const status = v.kind === "BLOCK" ? "BLOCKED" : "CONFIRMED";
  const channel: StayChannel = v.kind === "BLOCK" ? "DIRECT" : v.channel;
  const id = crypto.randomUUID();
  const b = schema.stayBookings;
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stay-unit:${v.unitId}`}))`);
    const overlapping = await tx
      .select({ id: b.id, checkIn: b.checkIn, checkOut: b.checkOut, status: b.status, source: b.source, channel: b.channel, guestName: b.guestName })
      .from(b)
      .where(and(eq(b.unitId, v.unitId), inArray(b.status, ["CONFIRMED", "BLOCKED"]), lt(b.checkIn, v.checkOut), gt(b.checkOut, v.checkIn)));
    const hard = overlapping.find(countsAsHard);
    if (hard) return { clash: hard, soft: [] as typeof overlapping };
    await tx.insert(b).values({ id, unitId: v.unitId, checkIn: v.checkIn, checkOut: v.checkOut, channel, status, source: "MANUAL", guestName: v.guestName, guestPhone: v.guestPhone, guests: v.guests, amountVnd: v.amountVnd, note: v.note, createdByUserId: user.id, createdByName: user.name });
    return { clash: null, soft: overlapping };
  });
  if (outcome.clash) {
    const c = outcome.clash;
    const who = c.status === "BLOCKED" ? "ngày đã khoá" : `${STAY_CHANNEL_LABEL[c.channel as StayChannel] ?? c.channel}${c.guestName ? ` · ${c.guestName}` : ""}`;
    return fail("CONFLICT", [{ field: "checkIn", message: `Trùng phòng: «${unit.name}» đã có ${who} từ ${showDay(c.checkIn)} tới ${showDay(c.checkOut)}.` }]);
  }
  await audit({ userId: user.id, userEmail: user.email, action: status === "BLOCKED" ? "STAY_BLOCK_CREATE" : "STAY_BOOKING_CREATE", entity: "STAY_BOOKING", entityId: id, before: null, after: { unitId: v.unitId, checkIn: v.checkIn, checkOut: v.checkOut, channel, amountVnd: v.amountVnd }, reason: status === "BLOCKED" ? "Khoá ngày" : "Đặt phòng tay" });
  const head = status === "BLOCKED" ? `Đã khoá «${unit.name}»` : `Đã đặt «${unit.name}» cho ${v.guestName}`;
  const warn = outcome.soft.length ? ` Lưu ý: trùng ngày KHOÁ nhập từ lịch ${[...new Set(outcome.soft.map((s) => STAY_CHANNEL_LABEL[s.channel as StayChannel] ?? s.channel))].join(", ")} — kiểm lại trên kênh.` : "";
  return { ok: true, id, message: `${head} · ${nights} đêm (${showDay(v.checkIn)} → ${showDay(v.checkOut)}).${warn}` };
}

const detailsZ = z
  .object({
    guestName: z.string().trim().max(STAY_LIMITS.nameMax),
    guestPhone: z.string().trim().max(30),
    guests: z.number().int().min(1).max(100).nullable(),
    amountVnd: money,
    note: z.string().trim().max(STAY_LIMITS.noteMax),
  })
  .strict();

/** Bổ sung tên khách / SĐT / số khách / tiền / ghi chú — mọi lượt, kể cả lượt từ lịch kênh (iCal không mang các thứ này). */
export async function updateStayBookingDetailsCore(user: SessionUser, id: string, raw: unknown): Promise<StaysResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = detailsZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const b = schema.stayBookings;
  const [before] = await db.select({ amountVnd: b.amountVnd, guestName: b.guestName }).from(b).where(eq(b.id, id)).limit(1);
  if (!before) return fail("NOT_FOUND", "Không có lượt đặt này.");
  await db.update(b).set({ ...v, updatedAt: new Date() }).where(eq(b.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "STAY_BOOKING_DETAILS", entity: "STAY_BOOKING", entityId: id, before, after: { amountVnd: v.amountVnd, guestName: v.guestName }, reason: "Bổ sung thông tin lượt đặt" });
  return { ok: true, id, message: "Đã lưu thông tin lượt đặt." };
}

/** Huỷ lượt đặt / mở ngày khoá GÕ TAY. Lượt từ lịch kênh thì huỷ trên kênh rồi nhập lại lịch — ERP không tự đè lời của kênh. */
export async function cancelStayBookingCore(user: SessionUser, id: string, reason: string, now: Date = new Date()): Promise<StaysResult> {
  const denied = gate(user);
  if (denied) return denied;
  const why = (reason ?? "").trim();
  if (why.length < STAY_LIMITS.reasonMin) return fail("INVALID", [{ field: "reason", message: "Ghi lý do huỷ (ít nhất 3 ký tự)." }]);
  const db = await getDb();
  const b = schema.stayBookings;
  const [row] = await db.select({ source: b.source, status: b.status }).from(b).where(eq(b.id, id)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có lượt đặt này.");
  if (row.source === "ICAL") return fail("CONFLICT", "Lượt này đến từ lịch của kênh — huỷ trên kênh rồi nhập lại lịch; ERP không tự đè lời của kênh.");
  const [done] = await db.update(b).set({ status: "CANCELLED", cancelReason: why.slice(0, 500), cancelledAt: now, updatedAt: now }).where(and(eq(b.id, id), ne(b.status, "CANCELLED"))).returning({ id: b.id });
  if (!done) return fail("CONFLICT", "Lượt này đã huỷ rồi.");
  await audit({ userId: user.id, userEmail: user.email, action: "STAY_BOOKING_CANCEL", entity: "STAY_BOOKING", entityId: id, before: { status: row.status }, after: { status: "CANCELLED" }, reason: why });
  return { ok: true, id, message: row.status === "BLOCKED" ? "Đã mở lại ngày khoá." : "Đã huỷ lượt đặt." };
}

// ═══ NHẬP LỊCH .ics CỦA KÊNH ═══

const importZ = z
  .object({
    unitId: z.string().trim().min(1, "Chọn phòng").max(200),
    channel: z.enum(STAY_CHANNELS).refine((c) => c !== "DIRECT", "Khách trực tiếp không có lịch kênh — chọn Airbnb / Booking / …"),
    text: z.string().max(STAY_LIMITS.icsMaxBytes, "Tệp lịch quá lớn"),
    apply: z.boolean().default(false),
  })
  .strict();

export type StayImportResult =
  | { ok: true; applied: boolean; events: number; skipped: number; created: number; updated: number; cancelled: number; unchanged: number; cancelList: IcsImportPlan["cancel"]; message: string }
  | MetaFailure;

/**
 * Nhập lịch .ics của MỘT kênh cho MỘT phòng. `apply: false` (mặc định) = CHẠY THỬ: chỉ đọc + ghi sổ, không đổi lượt đặt nào.
 * Lượt GHI tính lại kế hoạch TRONG giao dịch sau khoá phòng — hai người nhập cùng lúc không ra hai bản.
 */
export async function importStayIcsCore(user: SessionUser, raw: unknown, now: Date = new Date()): Promise<StayImportResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = importZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  if (!/BEGIN:VCALENDAR/i.test(v.text)) return fail("INVALID", [{ field: "text", message: "Không phải tệp lịch .ics (thiếu BEGIN:VCALENDAR)." }]);
  const { events, skipped } = parseIcs(v.text);
  if (events.length > STAY_LIMITS.icsMaxEvents) return fail("INVALID", [{ field: "text", message: `Tệp có hơn ${STAY_LIMITS.icsMaxEvents} sự kiện — không nhập.` }]);
  const db = await getDb();
  const [unit] = await db.select({ id: schema.stayUnits.id, name: schema.stayUnits.name }).from(schema.stayUnits).where(eq(schema.stayUnits.id, v.unitId)).limit(1);
  if (!unit) return fail("INVALID", [{ field: "unitId", message: "Phòng không tồn tại." }]);
  const today = vnDay(now);
  const b = schema.stayBookings;
  const existingOf = async (q: Pick<typeof db, "select">) =>
    q.select({ id: b.id, externalUid: b.externalUid, checkIn: b.checkIn, checkOut: b.checkOut, status: b.status }).from(b).where(and(eq(b.unitId, v.unitId), eq(b.channel, v.channel), eq(b.source, "ICAL")));
  let plan = planIcsImport(await existingOf(db), events, today);
  if (v.apply) {
    plan = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stay-unit:${v.unitId}`}))`);
      const p = planIcsImport(await existingOf(tx), events, today);
      for (const ev of p.create) {
        await tx
          .insert(b)
          .values({ unitId: v.unitId, checkIn: ev.checkIn, checkOut: ev.checkOut, channel: v.channel, status: ev.blocked ? "BLOCKED" : "CONFIRMED", source: "ICAL", externalUid: ev.uid, summary: ev.summary, createdByUserId: user.id, createdByName: user.name })
          .onConflictDoNothing();
      }
      for (const u of p.update) {
        await tx.update(b).set({ checkIn: u.event.checkIn, checkOut: u.event.checkOut, status: u.event.blocked ? "BLOCKED" : "CONFIRMED", summary: u.event.summary, cancelReason: null, cancelledAt: null, updatedAt: now }).where(eq(b.id, u.id));
      }
      for (const c of p.cancel) {
        await tx.update(b).set({ status: "CANCELLED", cancelReason: c.why, cancelledAt: now, updatedAt: now }).where(and(eq(b.id, c.id), ne(b.status, "CANCELLED")));
      }
      return p;
    });
  }
  const checksum = createHash("sha256").update(v.text).digest("hex");
  await db.insert(schema.stayIcalImports).values({ unitId: v.unitId, channel: v.channel, applied: v.apply, checksum, events: events.length, skipped, created: plan.create.length, updated: plan.update.length, cancelled: plan.cancel.length, unchanged: plan.unchanged, byUserId: user.id, byName: user.name });
  if (v.apply) {
    await audit({ userId: user.id, userEmail: user.email, action: "STAY_ICAL_IMPORT", entity: "STAY_UNIT", entityId: v.unitId, before: null, after: { channel: v.channel, checksum, created: plan.create.length, updated: plan.update.length, cancelled: plan.cancel.length }, reason: "Nhập lịch kênh" });
  }
  const label = STAY_CHANNEL_LABEL[v.channel];
  const counts = `${plan.create.length} mới · ${plan.update.length} đổi · ${plan.cancel.length} huỷ · ${plan.unchanged} giữ nguyên${skipped ? ` · ${skipped} dòng hỏng bỏ qua` : ""}`;
  return {
    ok: true,
    applied: v.apply,
    events: events.length,
    skipped,
    created: plan.create.length,
    updated: plan.update.length,
    cancelled: plan.cancel.length,
    unchanged: plan.unchanged,
    cancelList: plan.cancel,
    message: v.apply ? `Đã nhập lịch ${label} cho «${unit.name}»: ${counts}.` : `Chạy thử lịch ${label} cho «${unit.name}»: ${counts}. Chưa ghi gì.`,
  };
}

// ═══ DỌN PHÒNG ═══

export async function markStayTurnoverCore(user: SessionUser, unitId: string, day: string, done: boolean, now: Date = new Date()): Promise<StaysResult> {
  const denied = gate(user);
  if (denied) return denied;
  if (!isStayDay(day)) return fail("INVALID", "Ngày dọn sai dạng.");
  const db = await getDb();
  const t = schema.stayTurnovers;
  const [unit] = await db.select({ name: schema.stayUnits.name }).from(schema.stayUnits).where(eq(schema.stayUnits.id, unitId)).limit(1);
  if (!unit) return fail("NOT_FOUND", "Không có phòng này.");
  if (done) {
    const [row] = await db.insert(t).values({ unitId, day, doneAt: now, doneByUserId: user.id, doneByName: user.name }).onConflictDoNothing().returning({ unitId: t.unitId });
    if (!row) return fail("CONFLICT", "Phòng này đã được đánh dấu dọn xong.");
  } else {
    const [row] = await db.delete(t).where(and(eq(t.unitId, unitId), eq(t.day, day))).returning({ unitId: t.unitId });
    if (!row) return fail("NOT_FOUND", "Phòng này chưa được đánh dấu dọn.");
  }
  await audit({ userId: user.id, userEmail: user.email, action: done ? "STAY_TURNOVER_DONE" : "STAY_TURNOVER_UNDO", entity: "STAY_UNIT", entityId: unitId, before: null, after: { day }, reason: done ? "Dọn phòng xong" : "Bỏ đánh dấu dọn phòng" });
  return { ok: true, id: unitId, message: done ? `«${unit.name}» đã dọn xong.` : `Đã bỏ đánh dấu dọn «${unit.name}».` };
}


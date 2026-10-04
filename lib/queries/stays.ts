import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addStayDays, findStayConflicts, stayDayCells, stayOccupancy, stayRevenue, stayTurnoversOn, type StayDayCell } from "@/lib/constants/stays";

/**
 * ═══════════ LƯU TRÚ — ĐỌC (docs/verticals/homestay.md) ═══════════
 *
 * Trùng phòng, ô lịch, dọn phòng, lấp đầy, doanh thu chủ nhà đều TÍNH Ở ĐÂY lúc đọc bằng hàm thuần của
 * `lib/constants/stays.ts` — không cột nào lưu chúng, nên nhập lại lịch kênh là mọi con số đọc lại đúng.
 */

export type StayUnitView = { id: string; name: string; code: string; capacity: number | null; address: string; ownerName: string; active: boolean; note: string; icalToken: string };

export type StayBookingView = {
  id: string;
  unitId: string;
  checkIn: string;
  checkOut: string;
  channel: string;
  status: string;
  source: string;
  summary: string;
  guestName: string;
  guestPhone: string;
  guests: number | null;
  amountVnd: number | null;
  note: string;
  cancelReason: string | null;
};

const bookingCols = {
  id: schema.stayBookings.id,
  unitId: schema.stayBookings.unitId,
  checkIn: schema.stayBookings.checkIn,
  checkOut: schema.stayBookings.checkOut,
  channel: schema.stayBookings.channel,
  status: schema.stayBookings.status,
  source: schema.stayBookings.source,
  summary: schema.stayBookings.summary,
  guestName: schema.stayBookings.guestName,
  guestPhone: schema.stayBookings.guestPhone,
  guests: schema.stayBookings.guests,
  amountVnd: schema.stayBookings.amountVnd,
  note: schema.stayBookings.note,
  cancelReason: schema.stayBookings.cancelReason,
};

export async function listStayUnits(): Promise<StayUnitView[]> {
  const db = await getDb();
  const u = schema.stayUnits;
  return db.select({ id: u.id, name: u.name, code: u.code, capacity: u.capacity, address: u.address, ownerName: u.ownerName, active: u.active, note: u.note, icalToken: u.icalToken }).from(u).orderBy(desc(u.active), asc(u.code));
}

/** Lượt đặt (đang chiếm) của các phòng chồng lên [from, to). */
async function liveBookings(from: string, to: string): Promise<StayBookingView[]> {
  const db = await getDb();
  const b = schema.stayBookings;
  return db
    .select(bookingCols)
    .from(b)
    .where(and(inArray(b.status, ["CONFIRMED", "BLOCKED"]), lt(b.checkIn, to), gt(b.checkOut, from)))
    .orderBy(asc(b.checkIn));
}

export type StayBoard = {
  today: string;
  days: string[];
  units: (StayUnitView & { cells: StayDayCell[] })[];
  bookings: Record<string, StayBookingView>;
  /** Cặp trùng phòng từ hôm nay trở đi (lượt đã trả phòng không còn là việc). */
  conflicts: { unitId: string; a: StayBookingView; b: StayBookingView }[];
  arrivals: StayBookingView[];
  departures: StayBookingView[];
  inHouse: StayBookingView[];
  turnovers: { day: string; unitId: string; departing: StayBookingView; sameDayArrival: boolean; doneByName: string | null }[];
  upcoming: StayBookingView[];
};

/** Bảng lịch phòng: `span` đêm từ `from`, việc hôm nay, trùng phòng và lượt sắp tới (90 ngày). */
export async function stayBoard(today: string, from: string = today, span = 14): Promise<StayBoard> {
  const units = (await listStayUnits()).filter((u) => u.active);
  const days = Array.from({ length: span }, (_, i) => addStayDays(from, i));
  const horizon = addStayDays(today, 90);
  const end = days[days.length - 1] ? addStayDays(days[days.length - 1], 1) : from;
  // Mốc dưới lùi một ngày: lượt TRẢ phòng hôm nay (check_out = hôm nay) vẫn phải vào — khách trả + dọn phòng.
  const rows = await liveBookings(addStayDays(from < today ? from : today, -1), end > horizon ? end : horizon);
  const unitIds = new Set(units.map((u) => u.id));
  const mine = rows.filter((r) => unitIds.has(r.unitId));
  const byUnit = new Map<string, StayBookingView[]>();
  for (const r of mine) byUnit.set(r.unitId, [...(byUnit.get(r.unitId) ?? []), r]);
  const conflicts = findStayConflicts(mine.filter((r) => r.checkOut > today)).map((c) => ({ unitId: c.a.unitId, a: c.a, b: c.b }));
  const confirmed = mine.filter((r) => r.status === "CONFIRMED");
  const tomorrow = addStayDays(today, 1);
  const db = await getDb();
  const t = schema.stayTurnovers;
  const done = await db
    .select({ unitId: t.unitId, day: t.day, doneByName: t.doneByName })
    .from(t)
    .where(inArray(t.day, [today, tomorrow]));
  const doneKey = new Map(done.map((d) => [`${d.unitId}|${d.day}`, d.doneByName || "—"]));
  const turnovers = [today, tomorrow].flatMap((day) => stayTurnoversOn(confirmed, day).map((x) => ({ day, ...x, doneByName: doneKey.get(`${x.unitId}|${day}`) ?? null })));
  return {
    today,
    days,
    units: units.map((u) => ({ ...u, cells: stayDayCells(byUnit.get(u.id) ?? [], days) })),
    bookings: Object.fromEntries(mine.map((r) => [r.id, r])),
    conflicts,
    arrivals: confirmed.filter((r) => r.checkIn === today),
    departures: confirmed.filter((r) => r.checkOut === today),
    inHouse: confirmed.filter((r) => r.checkIn < today && today < r.checkOut),
    turnovers,
    upcoming: mine.filter((r) => r.checkOut > today).slice(0, 200),
  };
}

export type StayOwnerRow = {
  unitId: string;
  unitName: string;
  unitCode: string;
  ownerName: string;
  soldNights: number;
  blockedNights: number;
  sellableNights: number;
  occupancy: number | null;
  revenueKnownVnd: number | null;
  withAmount: number;
  missingAmount: number;
  stays: number;
};

/**
 * Báo cáo chủ nhà cho tháng `month` (YYYY-MM): theo phòng — đêm đã bán / khoá / bán được, lấp đầy, doanh thu ĐÃ BIẾT theo ngày
 * nhận phòng kèm số lượt CHƯA ghi tiền (không cộng như 0 — luật 42).
 */
export async function stayOwnerReport(month: string): Promise<{ from: string; to: string; rows: StayOwnerRow[] }> {
  const from = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const units = await listStayUnits();
  const rows = await liveBookings(from, to);
  return {
    from,
    to,
    rows: units
      .map((u) => {
        const mine = rows.filter((r) => r.unitId === u.id);
        const occ = stayOccupancy(mine, from, to);
        const rev = stayRevenue(mine, from, to);
        return {
          unitId: u.id,
          unitName: u.name,
          unitCode: u.code,
          ownerName: u.ownerName,
          soldNights: occ.soldNights,
          blockedNights: occ.blockedNights,
          sellableNights: occ.sellableNights,
          occupancy: occ.rate,
          revenueKnownVnd: rev.knownVnd,
          withAmount: rev.withAmount,
          missingAmount: rev.missingAmount,
          stays: mine.filter((r) => r.status === "CONFIRMED" && r.checkIn >= from && r.checkIn < to).length,
        };
      })
      .filter((r) => r.soldNights > 0 || r.blockedNights > 0 || units.find((u) => u.id === r.unitId)?.active)
      .sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.unitCode.localeCompare(b.unitCode)),
  };
}

export type StayImportLog = { id: string; unitId: string; channel: string; applied: boolean; events: number; skipped: number; created: number; updated: number; cancelled: number; unchanged: number; byName: string; createdAt: string };

/** 20 lượt nhập lịch gần nhất (kể cả chạy thử) — «ai đã nhập tệp nào, nó đổi gì». */
export async function recentStayImports(): Promise<StayImportLog[]> {
  const db = await getDb();
  const i = schema.stayIcalImports;
  const rows = await db.select().from(i).orderBy(desc(i.createdAt)).limit(20);
  return rows.map((r) => ({ id: r.id, unitId: r.unitId, channel: r.channel, applied: r.applied, events: r.events, skipped: r.skipped, created: r.created, updated: r.updated, cancelled: r.cancelled, unchanged: r.unchanged, byName: r.byName, createdAt: r.createdAt.toISOString() }));
}

/** Lịch của MỘT phòng cho đường dẫn .ics công khai — tra bằng token; phòng ngưng cho thuê ⇒ `null`. Lượt đã trả phòng > 30 ngày bỏ. */
export async function stayFeedByToken(token: string, today: string): Promise<{ unit: { id: string; name: string }; bookings: StayBookingView[] } | null> {
  const db = await getDb();
  const u = schema.stayUnits;
  const [unit] = await db.select({ id: u.id, name: u.name, active: u.active }).from(u).where(eq(u.icalToken, token)).limit(1);
  if (!unit || !unit.active) return null;
  const b = schema.stayBookings;
  const bookings = await db
    .select(bookingCols)
    .from(b)
    .where(and(eq(b.unitId, unit.id), inArray(b.status, ["CONFIRMED", "BLOCKED"]), gt(b.checkOut, addStayDays(today, -30))))
    .orderBy(asc(b.checkIn))
    .limit(2000);
  return { unit: { id: unit.id, name: unit.name }, bookings };
}

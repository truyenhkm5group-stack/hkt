/**
 * ═══════════ LƯU TRÚ NGẮN NGÀY (Airbnb / homestay) — HÀM THUẦN, client-safe (docs/verticals/homestay.md) ═══════════
 *
 * Ba thứ làm nên ngành:
 *  · LỊCH PHÒNG đa kênh — một đặt phòng chiếm khoảng NỬA MỞ [ngày nhận, ngày trả): khách trả phòng sáng ngày 5 thì khách khác
 *    nhận phòng chiều ngày 5 KHÔNG trùng. Hai đặt phòng đang hiệu lực của CÙNG một phòng chồng nhau = TRÙNG PHÒNG.
 *  · iCal — Airbnb / Booking / Agoda đều xuất và nhập lịch dạng .ics (RFC 5545) — không cần API đối tác. ERP đọc tệp kênh xuất
 *    ra (`parseIcs`) và phát lịch của chính ERP (`buildIcs`) để kênh khoá ngày khách đặt trực tiếp.
 *  · DỌN PHÒNG giữa hai lượt và BÁO CÁO CHỦ NHÀ theo phòng (đêm đã bán, lấp đầy, doanh thu ĐÃ BIẾT — iCal không mang giá).
 */

export const STAY_CHANNELS = ["AIRBNB", "BOOKING", "AGODA", "TRAVELOKA", "DIRECT", "OTHER"] as const;
export type StayChannel = (typeof STAY_CHANNELS)[number];

export const STAY_CHANNEL_LABEL: Record<StayChannel, string> = {
  AIRBNB: "Airbnb",
  BOOKING: "Booking.com",
  AGODA: "Agoda",
  TRAVELOKA: "Traveloka",
  DIRECT: "Khách đặt trực tiếp",
  OTHER: "Kênh khác",
};

export const STAY_BOOKING_STATUSES = ["CONFIRMED", "BLOCKED", "CANCELLED"] as const;
export type StayBookingStatus = (typeof STAY_BOOKING_STATUSES)[number];

export const STAY_BOOKING_STATUS_LABEL: Record<StayBookingStatus, string> = { CONFIRMED: "Đã đặt", BLOCKED: "Khoá ngày", CANCELLED: "Đã huỷ" };

/** Đang chiếm phòng: đặt phòng thật hoặc ngày chủ khoá. Đã huỷ thì không. */
export function occupies(status: string): boolean {
  return status === "CONFIRMED" || status === "BLOCKED";
}

export const STAY_LIMITS = { maxNights: 365, icsMaxBytes: 2_000_000, icsMaxEvents: 5_000, nameMax: 120, noteMax: 1000, reasonMin: 3, moneyMax: 2_000_000_000, codeMax: 20 } as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isStayDay(v: string): boolean {
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function addStayDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Số đêm của [nhận, trả). Ngày sai / trả ≤ nhận ⇒ `null`. */
export function stayNights(checkIn: string, checkOut: string): number | null {
  if (!isStayDay(checkIn) || !isStayDay(checkOut)) return null;
  const n = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
  return n > 0 ? n : null;
}

/** Hai khoảng nửa mở [a.in, a.out) và [b.in, b.out) có chồng nhau không — trả phòng sáng, nhận phòng chiều cùng ngày KHÔNG chồng. */
export function staysOverlap(a: { checkIn: string; checkOut: string }, b: { checkIn: string; checkOut: string }): boolean {
  return a.checkIn < b.checkOut && b.checkIn < a.checkOut;
}

export const STAY_SOURCES = ["MANUAL", "ICAL"] as const;
export type StaySource = (typeof STAY_SOURCES)[number];

/**
 * ═══ VỌNG LỊCH — vì sao ngày KHOÁ nhập từ kênh không tính là trùng phòng ═══
 *
 * ERP phát lịch cho Airbnb; Airbnb nhập rồi lại XUẤT chính những ngày đó dưới dạng «Airbnb (Not available)». Nhập ngược tệp
 * Airbnb vào ERP thì mỗi khách đặt trực tiếp có thêm một ngày khoá trùng khít — báo «trùng phòng» ở đó là báo giả, và một
 * cảnh báo giả mỗi ngày là cảnh báo không ai đọc nữa. Nên ngày khoá ĐẾN TỪ iCal:
 *  · KHÔNG tính vào trùng phòng và KHÔNG chặn đặt trực tiếp (chỉ nhắc);
 *  · KHÔNG phát lại ra lịch của ERP (phát lại là vòng vọng giữa hai kênh);
 *  · vẫn làm đêm ấy «không bán được» khi tính lấp đầy — chủ đã khoá ở kênh thì đêm ấy không bán.
 * Đặt phòng thật (dù từ kênh nào) và ngày chủ khoá TRONG ERP thì luôn tính.
 */
export function countsAsHard(b: { status: string; source: string }): boolean {
  return b.status === "CONFIRMED" || (b.status === "BLOCKED" && b.source === "MANUAL");
}

export type StaySpan = { id: string; unitId: string; checkIn: string; checkOut: string; status: string; channel: string; source: string };

/** Mọi cặp TRÙNG PHÒNG (cùng phòng, cả hai `countsAsHard`, chồng ngày). Mỗi cặp một lần, theo phòng rồi ngày nhận. */
export function findStayConflicts<T extends StaySpan>(bookings: readonly T[]): { a: T; b: T }[] {
  const live = bookings
    .filter(countsAsHard)
    .sort((x, y) => (x.unitId === y.unitId ? x.checkIn.localeCompare(y.checkIn) || x.id.localeCompare(y.id) : x.unitId.localeCompare(y.unitId)));
  const out: { a: T; b: T }[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length && live[j].unitId === live[i].unitId && live[j].checkIn < live[i].checkOut; j++) {
      if (staysOverlap(live[i], live[j])) out.push({ a: live[i], b: live[j] });
    }
  }
  return out;
}

/** Danh sách đêm (YYYY-MM-DD, mỗi đêm mang tên ngày bắt đầu) của [from, to). Trần `maxNights` để không lặp vô hạn. */
export function stayNightList(from: string, to: string): string[] {
  const n = stayNights(from, to);
  if (!n) return [];
  const out: string[] = [];
  for (let i = 0; i < Math.min(n, STAY_LIMITS.maxNights * 2); i++) out.push(addStayDays(from, i));
  return out;
}

/**
 * Lấp đầy của MỘT phòng trong [from, to), tính THEO TỪNG ĐÊM (hai bản ghi chồng nhau không bị đếm hai lần):
 * đêm có đặt phòng thật ⇒ ĐÃ BÁN; không có mà có ngày khoá (ERP hay kênh) ⇒ KHOÁ; còn lại ⇒ TRỐNG.
 * Lấp đầy = đã bán / (tổng − khoá). Kỳ không còn đêm nào bán được ⇒ `null` (không phải 0%).
 */
export function stayOccupancy(bookings: readonly { checkIn: string; checkOut: string; status: string }[], from: string, to: string): { soldNights: number; blockedNights: number; sellableNights: number; rate: number | null } {
  const nights = stayNightList(from, to);
  const live = bookings.filter((b) => occupies(b.status));
  let sold = 0;
  let blocked = 0;
  for (const d of nights) {
    const cover = live.filter((b) => b.checkIn <= d && d < b.checkOut);
    if (cover.some((b) => b.status === "CONFIRMED")) sold += 1;
    else if (cover.length) blocked += 1;
  }
  const sellable = nights.length - blocked;
  return { soldNights: sold, blockedNights: blocked, sellableNights: sellable, rate: sellable > 0 ? sold / sellable : null };
}

export type StayDayCell = { kind: "FREE" } | { kind: "SOLD"; bookingId: string; channel: string; start: boolean } | { kind: "BLOCKED"; bookingId: string; source: string; start: boolean } | { kind: "CONFLICT"; bookingIds: string[] };

/** Ô lịch của MỘT phòng cho từng đêm trong `days`. Hai bản ghi `countsAsHard` cùng phủ một đêm ⇒ ô TRÙNG. */
export function stayDayCells(bookings: readonly { id: string; checkIn: string; checkOut: string; status: string; channel: string; source: string }[], days: readonly string[]): StayDayCell[] {
  const live = bookings.filter((b) => occupies(b.status));
  return days.map((d) => {
    const cover = live.filter((b) => b.checkIn <= d && d < b.checkOut);
    const hard = cover.filter(countsAsHard);
    if (hard.length > 1) return { kind: "CONFLICT", bookingIds: hard.map((b) => b.id) };
    const sold = cover.find((b) => b.status === "CONFIRMED");
    if (sold) return { kind: "SOLD", bookingId: sold.id, channel: sold.channel, start: sold.checkIn === d };
    const block = hard[0] ?? cover[0];
    if (block) return { kind: "BLOCKED", bookingId: block.id, source: block.source, start: block.checkIn === d };
    return { kind: "FREE" };
  });
}

/**
 * DỌN PHÒNG ngày `day`: phòng có khách TRẢ phòng hôm đó. `sameDayArrival` = có khách NHẬN phòng cùng ngày ⇒ phải dọn xong
 * trước giờ nhận — việc gấp nhất của buổi sáng.
 */
export function stayTurnoversOn<T extends { unitId: string; checkIn: string; checkOut: string; status: string }>(bookings: readonly T[], day: string): { unitId: string; departing: T; sameDayArrival: boolean }[] {
  const confirmed = bookings.filter((b) => b.status === "CONFIRMED");
  const out: { unitId: string; departing: T; sameDayArrival: boolean }[] = [];
  for (const b of confirmed) {
    if (b.checkOut !== day) continue;
    out.push({ unitId: b.unitId, departing: b, sameDayArrival: confirmed.some((x) => x.unitId === b.unitId && x.checkIn === day) });
  }
  return out.sort((a, b) => Number(b.sameDayArrival) - Number(a.sameDayArrival) || a.unitId.localeCompare(b.unitId));
}

/**
 * Doanh thu của kỳ theo NGÀY NHẬN PHÒNG: chỉ đặt phòng thật. Tiền chưa ghi là CHƯA BIẾT (iCal của kênh không mang giá) —
 * đếm riêng, không cộng như 0 (luật 42). Không lượt nào có tiền ⇒ `knownVnd = null`.
 */
export function stayRevenue(bookings: readonly { checkIn: string; status: string; amountVnd: number | null }[], from: string, to: string): { knownVnd: number | null; withAmount: number; missingAmount: number } {
  const inPeriod = bookings.filter((b) => b.status === "CONFIRMED" && b.checkIn >= from && b.checkIn < to);
  const priced = inPeriod.filter((b) => b.amountVnd !== null);
  return { knownVnd: priced.length ? priced.reduce((s, b) => s + (b.amountVnd ?? 0), 0) : null, withAmount: priced.length, missingAmount: inPeriod.length - priced.length };
}

export type IcsImportPlan = {
  create: IcsEvent[];
  update: { id: string; event: IcsEvent }[];
  cancel: { id: string; checkIn: string; checkOut: string; why: string }[];
  unchanged: number;
};

/**
 * Kế hoạch nhập lịch .ics của MỘT phòng · MỘT kênh — hàm THUẦN, dùng chung cho CHẠY THỬ và GHI để hai bước không lệch nhau.
 *  · Sự kiện mới ⇒ tạo; đổi ngày / đổi loại (đặt ↔ khoá) ⇒ cập nhật; kênh ghi CANCELLED ⇒ huỷ.
 *  · Bản ghi iCal CÒN ĐANG / SẮP ở (trả phòng sau `today`) mà KHÔNG còn trong tệp ⇒ huỷ: kênh đã bỏ nó.
 *  · Bản ghi đã qua KHÔNG đụng tới — lịch kênh tự rụng lượt cũ, rụng không có nghĩa là huỷ.
 */
export function planIcsImport(existing: readonly { id: string; externalUid: string | null; checkIn: string; checkOut: string; status: string }[], events: readonly IcsEvent[], today: string): IcsImportPlan {
  const byUid = new Map(existing.filter((e) => e.externalUid).map((e) => [e.externalUid as string, e]));
  const seen = new Set<string>();
  const plan: IcsImportPlan = { create: [], update: [], cancel: [], unchanged: 0 };
  for (const ev of events) {
    if (seen.has(ev.uid)) continue;
    seen.add(ev.uid);
    const cur = byUid.get(ev.uid);
    const want = ev.cancelled ? "CANCELLED" : ev.blocked ? "BLOCKED" : "CONFIRMED";
    if (!cur) {
      if (!ev.cancelled) plan.create.push(ev);
      continue;
    }
    if (want === "CANCELLED") {
      if (cur.status !== "CANCELLED") plan.cancel.push({ id: cur.id, checkIn: cur.checkIn, checkOut: cur.checkOut, why: "Kênh báo huỷ" });
      else plan.unchanged += 1;
    } else if (cur.status !== want || cur.checkIn !== ev.checkIn || cur.checkOut !== ev.checkOut) plan.update.push({ id: cur.id, event: ev });
    else plan.unchanged += 1;
  }
  for (const e of existing) {
    if (!e.externalUid || seen.has(e.externalUid) || e.status === "CANCELLED" || e.checkOut <= today) continue;
    plan.cancel.push({ id: e.id, checkIn: e.checkIn, checkOut: e.checkOut, why: "Không còn trong lịch của kênh" });
  }
  return plan;
}

// ═══ iCal (RFC 5545) ═══

export type IcsEvent = { uid: string; checkIn: string; checkOut: string; summary: string; cancelled: boolean; blocked: boolean };

/** Bỏ gập dòng (dòng bắt đầu bằng khoảng trắng / tab là phần tiếp của dòng trước). */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function icsUnescape(v: string): string {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

/** «20261005» / «20261005T140000Z» / «2026-10-05» ⇒ «2026-10-05». Lạ ⇒ `null`. */
function icsDay(value: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value.trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return isStayDay(day) ? day : null;
}

/**
 * Đọc lịch .ics của một kênh. Chỉ lấy VEVENT có UID và DTSTART; thiếu DTEND ⇒ một đêm. Sự kiện kênh dùng để khoá ngày (Airbnb
 * ghi «Not available» / «Airbnb (Not available)», Booking ghi «CLOSED - Not available») được đánh dấu `blocked`.
 * Dòng hỏng bị BỎ QUA và ĐẾM — không đoán.
 */
export function parseIcs(text: string): { events: IcsEvent[]; skipped: number } {
  const events: IcsEvent[] = [];
  let skipped = 0;
  let cur: Record<string, string> | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) {
        const uid = (cur.UID ?? "").trim();
        const start = cur.DTSTART ? icsDay(cur.DTSTART) : null;
        const end = cur.DTEND ? icsDay(cur.DTEND) : start ? addStayDays(start, 1) : null;
        if (!uid || !start || !end || end <= start || (stayNights(start, end) ?? 0) > STAY_LIMITS.maxNights) skipped += 1;
        else {
          const summary = icsUnescape(cur.SUMMARY ?? "").slice(0, 200);
          events.push({ uid: uid.slice(0, 300), checkIn: start, checkOut: end, summary, cancelled: (cur.STATUS ?? "").toUpperCase() === "CANCELLED", blocked: /not available|blocked|closed/i.test(summary) });
        }
      }
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).split(";")[0].toUpperCase();
      if (!(key in cur)) cur[key] = line.slice(idx + 1);
    }
  }
  return { events, skipped };
}

function icsEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
}

/**
 * Lịch .ics của MỘT phòng để kênh (Airbnb / Booking…) nhập và khoá ngày. Chỉ phát `countsAsHard` — ngày khoá nhập từ kênh
 * KHÔNG phát lại (vòng vọng, xem `countsAsHard`). `excludeChannel`: lịch phát cho kênh X bỏ lượt của chính X. Tóm tắt KHÔNG
 * mang tên / SĐT khách (ai cầm đường dẫn cũng đọc được) — chỉ «Đã đặt» / «Khoá ngày».
 */
export function buildIcs(
  unit: { id: string; name: string },
  bookings: readonly { id: string; checkIn: string; checkOut: string; status: string; source: string; channel: string }[],
  stamp: Date,
  opts: { excludeChannel?: string | null } = {},
): string {
  const dt = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ERP//Lich phong//VI", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsEscape(unit.name)}`];
  for (const b of bookings) {
    if (!countsAsHard(b) || (opts.excludeChannel && b.channel === opts.excludeChannel)) continue;
    lines.push("BEGIN:VEVENT", `UID:${b.id}@erp-stays`, `DTSTAMP:${dt}`, `DTSTART;VALUE=DATE:${b.checkIn.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${b.checkOut.replace(/-/g, "")}`, `SUMMARY:${b.status === "BLOCKED" ? "Khoá ngày" : "Đã đặt"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

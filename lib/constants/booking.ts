/**
 * ═══════════ ĐẶT LỊCH QUA CHATBOT — PHẦN THUẦN, CLIENT-SAFE (docs/verticals/appointments.md) ═══════════
 *
 * Bot nhận lịch theo SỨC CHỨA, không theo người: shop khai giờ mở cửa, bước chia giờ và «số khách phục vụ cùng lúc»
 * (số giường / ghế). Một giờ còn nhận khi số lịch ĐANG HIỆU LỰC chồng lên nó (mọi lịch, kể cả lễ tân đặt tay) còn dưới sức
 * chứa. Bot KHÔNG gán kỹ thuật viên — chọn người là việc của lễ tân, máy không biết hôm nay ai nghỉ (luật 22).
 *
 * Hàm ở đây không đọc CSDL: máy chủ đưa danh sách lịch đang hiệu lực vào, rồi KIỂM LẠI sức chứa trong giao dịch có khoá
 * (lib/records/appointments.ts::createAppointmentAsAgent) — hai khách chat cùng lúc không lấy được chỗ cuối cùng.
 */
import { z } from "zod";

const timeZ = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Giờ dạng HH:MM");

export const bookingConfigZ = z
  .object({
    enabled: z.boolean(),
    open: timeZ,
    close: timeZ,
    /** 0 = Chủ nhật … 6 = Thứ bảy (giờ Việt Nam). */
    days: z.array(z.number().int().min(0).max(6)).max(7),
    /** Độ dài một lịch đặt qua chat VÀ bước chia giờ trống (phút). */
    slotMinutes: z.number().int().min(15).max(240),
    /** Số khách phục vụ cùng lúc (giường / ghế). */
    capacity: z.number().int().min(1).max(50),
    /** Đặt trước tối thiểu (phút) — không nhận lịch bắt đầu sớm hơn bây giờ + chừng này. */
    leadMinutes: z.number().int().min(0).max(2880),
    /** Nhận lịch xa nhất bao nhiêu ngày tới. */
    horizonDays: z.number().int().min(1).max(60),
  })
  .strict()
  .refine((v) => minutesOf(v.open) < minutesOf(v.close), { path: ["close"], message: "Giờ đóng cửa phải sau giờ mở cửa (không nhận khung qua nửa đêm)" });

export type BookingConfig = z.infer<typeof bookingConfigZ>;

export const DEFAULT_BOOKING_CONFIG: BookingConfig = { enabled: false, open: "09:00", close: "20:00", days: [0, 1, 2, 3, 4, 5, 6], slotMinutes: 60, capacity: 1, leadMinutes: 60, horizonDays: 14 };

export const WEEKDAY_LABEL = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"] as const;

const VN_OFFSET_MS = 7 * 3_600_000;

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function hhmmOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Ngày giờ Việt Nam «YYYY-MM-DD» + «HH:MM» ⇒ thời điểm thật. Sai dạng ⇒ `null`. */
export function vnInstant(day: string, hhmm: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!d || !t) return null;
  const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])) - VN_OFFSET_MS;
  const back = new Date(ms + VN_OFFSET_MS);
  // 2026-02-30 trôi sang tháng 3 — không nhận.
  if (back.getUTCFullYear() !== Number(d[1]) || back.getUTCMonth() !== Number(d[2]) - 1 || back.getUTCDate() !== Number(d[3])) return null;
  return new Date(ms);
}

/** Ngày Việt Nam của một thời điểm, cộng thêm `addDays`. */
export function vnDayOffset(now: Date, addDays = 0): string {
  return new Date(now.getTime() + VN_OFFSET_MS + addDays * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export type BusyRange = { start: Date; end: Date };

export type DaySlots = { day: string; weekday: string; times: string[]; closedReason: string | null };

/**
 * Giờ còn nhận của MỘT ngày. `closedReason` ≠ null khi cả ngày không nhận (ngày nghỉ, quá xa, đã qua) — câu đó bot nói
 * lại được với khách. Ngày mở mà kín hết thì `times` rỗng và `closedReason` = null.
 */
export function freeSlots(cfg: BookingConfig, day: string, now: Date, busy: readonly BusyRange[]): DaySlots {
  const base = { day, weekday: vnInstant(day, "00:00") ? WEEKDAY_LABEL[weekdayOf(day)] : "", times: [] as string[] };
  if (!vnInstant(day, "00:00")) return { ...base, closedReason: "Ngày không hợp lệ (dạng YYYY-MM-DD)." };
  const today = vnDayOffset(now);
  if (day < today) return { ...base, closedReason: "Ngày đã qua." };
  if (day > vnDayOffset(now, cfg.horizonDays)) return { ...base, closedReason: `Shop chỉ nhận lịch trong ${cfg.horizonDays} ngày tới.` };
  if (!cfg.days.includes(weekdayOf(day))) return { ...base, closedReason: `${WEEKDAY_LABEL[weekdayOf(day)]} shop không nhận lịch.` };
  const earliest = now.getTime() + cfg.leadMinutes * 60_000;
  const times: string[] = [];
  for (let m = minutesOf(cfg.open); m + cfg.slotMinutes <= minutesOf(cfg.close); m += cfg.slotMinutes) {
    const start = vnInstant(day, hhmmOf(m))!;
    if (start.getTime() < earliest) continue;
    const end = new Date(start.getTime() + cfg.slotMinutes * 60_000);
    const used = busy.filter((b) => b.start < end && b.end > start).length;
    if (used < cfg.capacity) times.push(hhmmOf(m));
  }
  return { ...base, times, closedReason: null };
}

/** Giờ khách chọn có nằm trong lưới giờ còn nhận không — CÙNG phép tính với danh sách bot đọc cho khách. */
export function slotBookable(cfg: BookingConfig, day: string, hhmm: string, now: Date, busy: readonly BusyRange[]): { ok: true } | { ok: false; reason: string } {
  const s = freeSlots(cfg, day, now, busy);
  if (s.closedReason) return { ok: false, reason: s.closedReason };
  if (!s.times.includes(hhmm)) return { ok: false, reason: s.times.length ? `${hhmm} ngày ${day} không nhận (kín hoặc ngoài khung giờ). Giờ còn nhận: ${s.times.slice(0, 6).join(", ")}.` : `Ngày ${day} đã kín lịch.` };
  return { ok: true };
}

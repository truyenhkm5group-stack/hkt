/**
 * ═══════════ LỊCH HẸN & LIỆU TRÌNH — HÀM THUẦN, client-safe (docs/verticals/appointments.md) ═══════════
 *
 * Nghiệp vụ chung của ngành dịch vụ có lịch: spa, salon, phòng khám, gym, sửa xe. Hai thứ:
 *  · LỊCH HẸN — khách · dịch vụ · kỹ thuật viên · giờ bắt đầu / kết thúc · trạng thái. Một kỹ thuật viên không có hai lịch
 *    ĐANG HIỆU LỰC chồng giờ (chặn ở máy chủ, trong giao dịch có khoá theo người).
 *  · LIỆU TRÌNH — gói N buổi khách trả trước. Số buổi ĐÃ DÙNG và ĐANG GIỮ không lưu thành cột: đếm lúc đọc từ lịch hẹn gắn
 *    gói (đã xong = dùng; đang hiệu lực = giữ chỗ). Không có bộ đếm nào lệch được với lịch thật.
 */

export const APPOINTMENT_STATUSES = ["BOOKED", "CONFIRMED", "CHECKED_IN", "DONE", "NO_SHOW", "CANCELLED"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  BOOKED: "Đã đặt",
  CONFIRMED: "Khách đã xác nhận",
  CHECKED_IN: "Khách đã tới",
  DONE: "Đã làm xong",
  NO_SHOW: "Khách không tới",
  CANCELLED: "Đã huỷ",
};

/** Lịch còn chiếm giờ của kỹ thuật viên và giữ chỗ một buổi liệu trình. */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ["BOOKED", "CONFIRMED", "CHECKED_IN"];

export function isActiveAppointment(s: string): boolean {
  return (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(s);
}

/** Chuyển trạng thái hợp lệ. Trạng thái cuối (xong · không tới · huỷ) không đổi nữa — ghi nhầm thì tạo lịch mới. */
const TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  BOOKED: ["CONFIRMED", "CHECKED_IN", "DONE", "NO_SHOW", "CANCELLED"],
  CONFIRMED: ["CHECKED_IN", "DONE", "NO_SHOW", "CANCELLED"],
  CHECKED_IN: ["DONE", "CANCELLED"],
  DONE: [],
  NO_SHOW: [],
  CANCELLED: [],
};

export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextAppointmentStatuses(from: AppointmentStatus): readonly AppointmentStatus[] {
  return TRANSITIONS[from];
}

export const APPOINTMENT_LIMITS = { minMinutes: 5, maxMinutes: 720, noteMax: 1000, reasonMin: 3, maxSessions: 500, nameMax: 120 } as const;

/** Hai khoảng [bắt đầu, kết thúc) có chồng nhau không. Chạm mép (10:00 hết, 10:00 bắt đầu) KHÔNG chồng. */
export function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export type PackageBalance = { total: number; used: number; reserved: number; remaining: number; available: number };

/**
 * Số dư của MỘT liệu trình. `used` = số lịch ĐÃ XONG gắn gói; `reserved` = số lịch ĐANG HIỆU LỰC gắn gói. `remaining` =
 * còn bao nhiêu buổi chưa làm; `available` = còn đặt thêm được bao nhiêu buổi (đã trừ buổi đang giữ chỗ).
 */
export function packageBalance(total: number, used: number, reserved: number): PackageBalance {
  const t = Math.max(0, Math.trunc(total));
  const u = Math.max(0, Math.trunc(used));
  const r = Math.max(0, Math.trunc(reserved));
  return { total: t, used: u, reserved: r, remaining: Math.max(0, t - u), available: Math.max(0, t - u - r) };
}

/** Liệu trình dùng được cho một lịch hẹn mới vào ngày `onDay` (YYYY-MM-DD, giờ VN) không. */
export function packageUsable(pkg: { status: string; expiresOn: string | null }, balance: PackageBalance, onDay: string): { ok: true } | { ok: false; reason: string } {
  if (pkg.status !== "ACTIVE") return { ok: false, reason: "Liệu trình đã đóng." };
  if (pkg.expiresOn && onDay > pkg.expiresOn) return { ok: false, reason: `Liệu trình hết hạn ngày ${pkg.expiresOn}.` };
  if (balance.available <= 0) return { ok: false, reason: `Liệu trình đã hết buổi (${balance.used} đã làm, ${balance.reserved} đang giữ chỗ / ${balance.total}).` };
  return { ok: true };
}

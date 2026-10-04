/**
 * ═══════════ PHIẾU CÔNG VIỆC HIỆN TRƯỜNG — HÀM THUẦN, client-safe (docs/verticals/home-service.md) ═══════════
 *
 * Dịch vụ tại nhà (sửa chữa, vệ sinh, lắp đặt) bán một VIỆC chứ không bán hàng: báo giá → khách đồng ý → hẹn thợ → làm (ảnh
 * trước / sau) → khách ký nghiệm thu → thu tiền theo đợt → bảo hành dịch vụ. Mọi con số tiền của phiếu (tổng, đã thu, còn
 * nợ) TÍNH lúc đọc từ dòng báo giá và phiếu thu — không cột nào lưu chúng.
 */

export const FIELD_JOB_STATUSES = ["QUOTED", "ACCEPTED", "SCHEDULED", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export type FieldJobStatus = (typeof FIELD_JOB_STATUSES)[number];

export const FIELD_JOB_STATUS_LABEL: Record<FieldJobStatus, string> = {
  QUOTED: "Đã báo giá",
  ACCEPTED: "Khách đồng ý",
  SCHEDULED: "Đã hẹn thợ",
  IN_PROGRESS: "Đang làm",
  DONE: "Đã nghiệm thu",
  CANCELLED: "Đã huỷ",
};

/** Bước đi tới được từ mỗi trạng thái. Huỷ đi được từ mọi trạng thái chưa xong. Nghiệm thu rồi thì không đổi nữa. */
const NEXT: Record<FieldJobStatus, readonly FieldJobStatus[]> = {
  QUOTED: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["SCHEDULED", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["DONE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

export function canMoveFieldJob(from: FieldJobStatus, to: FieldJobStatus): boolean {
  return NEXT[from].includes(to);
}

/** Dòng báo giá sửa được tới trước khi nghiệm thu — phát sinh tại nhà khách là chuyện thường; nghiệm thu chốt con số cuối. */
export function fieldJobLinesEditable(status: FieldJobStatus): boolean {
  return status !== "DONE" && status !== "CANCELLED";
}

export const FIELD_JOB_LIMITS = { titleMax: 200, textMax: 2000, lineMax: 40, lineTextMax: 300, qtyMax: 10_000, moneyMax: 2_000_000_000, reasonMin: 3, nameMax: 120, photosMax: 24, photoBytesMax: 2_000_000, warrantyMonthsMax: 120, durationMinMax: 24 * 60 } as const;

export const FIELD_JOB_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const FIELD_JOB_PHOTO_PHASES = ["BEFORE", "AFTER"] as const;
export type FieldJobPhotoPhase = (typeof FIELD_JOB_PHOTO_PHASES)[number];
export const FIELD_JOB_PHOTO_PHASE_LABEL: Record<FieldJobPhotoPhase, string> = { BEFORE: "Ảnh trước khi làm", AFTER: "Ảnh sau khi làm" };

export const FIELD_JOB_PAY_METHODS = ["CASH", "BANK", "OTHER"] as const;
export type FieldJobPayMethod = (typeof FIELD_JOB_PAY_METHODS)[number];
export const FIELD_JOB_PAY_METHOD_LABEL: Record<FieldJobPayMethod, string> = { CASH: "Tiền mặt", BANK: "Chuyển khoản", OTHER: "Khác" };

/** Tổng báo giá = Σ số lượng × đơn giá. Chưa có dòng nào ⇒ `null` (chưa báo giá), không phải 0 (luật 42). */
export function fieldJobTotal(lines: readonly { quantity: number; unitPrice: number }[]): number | null {
  return lines.length ? lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) : null;
}

/** Đã thu = Σ phiếu thu CÒN HIỆU LỰC; còn phải thu = tổng − đã thu (không âm khi tổng đã biết). */
export function fieldJobMoney(lines: readonly { quantity: number; unitPrice: number }[], receipts: readonly { amount: number; status: string }[]): { total: number | null; paid: number; due: number | null } {
  const total = fieldJobTotal(lines);
  const paid = receipts.filter((r) => r.status === "CONFIRMED").reduce((s, r) => s + r.amount, 0);
  return { total, paid, due: total === null ? null : total - paid };
}

/** Khoảng hẹn [a, b) và [c, d) của CÙNG một thợ chồng nhau không — hẹn nối tiếp (hết 10:00, bắt đầu 10:00) không trùng. */
export function slotsOverlap(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/**
 * Hạn bảo hành dịch vụ = NGÀY nghiệm thu (giờ VN) + N tháng, tháng đích ngắn hơn thì về ngày cuối tháng. Không khai số tháng
 * ⇒ `null` (việc không bảo hành). Cùng phép cộng tháng với bảo hành sản phẩm.
 */
export function serviceWarrantyUntil(completedOnVn: string, months: number | null): string | null {
  if (months === null || !Number.isInteger(months) || months < 1 || months > FIELD_JOB_LIMITS.warrantyMonthsMax) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(completedOnVn);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const total = mo - 1 + months;
  const ty = y + Math.floor(total / 12);
  const tm = total % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Mã phiếu «CV-YYMMDD-NN» theo ngày VN của `at`: số lớn nhất đã có trong ngày + 1 (không đếm dòng — xoá phiếu không làm trùng). */
export function nextFieldJobCode(at: Date, existingCodes: readonly string[]): string {
  const day = new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(2, 10).replace(/-/g, "");
  const prefix = `CV-${day}-`;
  const max = existingCodes.reduce((m, c) => {
    if (!c.startsWith(prefix)) return m;
    const n = Number(c.slice(prefix.length));
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

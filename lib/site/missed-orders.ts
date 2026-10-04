/**
 * ═══════════ «SHOP BẠN ĐANG ĐỂ LỌT BAO NHIÊU ĐƠN?» — PHÉP TÍNH THUẦN, CLIENT-SAFE ═══════════
 *
 * Máy tính trên trang giới thiệu Chốt Đơn Tự Động. Mọi con số ra từ SỐ CỦA KHÁCH nhập vào, không có số liệu khách hàng
 * nào của nền tảng: trang công khai không được in một "kết quả trung bình" mà không ai đo. Kết quả là ƯỚC TÍNH và trang
 * phải nói vậy — không phải cam kết doanh thu.
 *
 * Mô hình cố ý đơn giản và đọc được: khách nhắn NGOÀI giờ có người trực (tối, đêm, ngày lễ, giờ cao điểm không ai rảnh)
 * là phần dễ mất nhất; trợ lý trực 24/7 trả lời được phần đó. Không nhân thêm hệ số nào khác — muốn lạc quan hay bi quan
 * thì khách tự kéo thanh trượt.
 */

export type MissedOrdersInput = {
  /** Số khách nhắn tin fanpage mỗi ngày. */
  chatsPerDay: number;
  /** % khách nhắn vào lúc không có người trực / không ai kịp trả lời. */
  unattendedPct: number;
  /** % khách chốt đơn khi được trả lời kịp thời. */
  closeRatePct: number;
  /** Giá trị đơn trung bình, VND. */
  avgOrderVnd: number;
};

export type MissedOrdersEstimate = {
  /** Khách nhắn lúc không ai trả lời kịp, mỗi tháng. */
  unattendedChatsPerMonth: number;
  /** Đơn có thể giữ lại mỗi tháng (làm tròn XUỐNG — không thổi phồng). */
  ordersPerMonth: number;
  /** Doanh thu có thể giữ lại mỗi tháng, VND. */
  revenuePerMonthVnd: number;
  /** Doanh thu giữ lại gấp bao nhiêu lần một khoản phí tháng (null khi không có giá để so). */
  timesPlanPrice: number | null;
};

export const DAYS_PER_MONTH = 30;

/** Giới hạn của từng thanh trượt — giá trị ngoài khoảng bị kẹp, không bị từ chối. */
export const MISSED_ORDERS_LIMITS = {
  chatsPerDay: { min: 5, max: 1000, step: 5 },
  unattendedPct: { min: 0, max: 100, step: 5 },
  closeRatePct: { min: 1, max: 50, step: 1 },
  avgOrderVnd: { min: 50_000, max: 5_000_000, step: 50_000 },
} as const satisfies Record<keyof MissedOrdersInput, { min: number; max: number; step: number }>;

/** Giá trị mặc định THẬN TRỌNG — khách nên thay bằng số của chính shop. */
export const MISSED_ORDERS_DEFAULTS: MissedOrdersInput = { chatsPerDay: 60, unattendedPct: 30, closeRatePct: 8, avgOrderVnd: 350_000 };

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function normalizeMissedOrdersInput(raw: MissedOrdersInput): MissedOrdersInput {
  const L = MISSED_ORDERS_LIMITS;
  return {
    chatsPerDay: clamp(raw.chatsPerDay, L.chatsPerDay.min, L.chatsPerDay.max),
    unattendedPct: clamp(raw.unattendedPct, L.unattendedPct.min, L.unattendedPct.max),
    closeRatePct: clamp(raw.closeRatePct, L.closeRatePct.min, L.closeRatePct.max),
    avgOrderVnd: clamp(raw.avgOrderVnd, L.avgOrderVnd.min, L.avgOrderVnd.max),
  };
}

/**
 * Ước tính phần đơn đang lọt vì không ai trả lời kịp. `planPriceVnd` = phí tháng để so (gói thấp nhất đang bán);
 * không có / không dương ⇒ `timesPlanPrice = null`, không đoán một giá.
 */
export function estimateMissedOrders(raw: MissedOrdersInput, planPriceVnd: number | null = null): MissedOrdersEstimate {
  const i = normalizeMissedOrdersInput(raw);
  const unattendedChatsPerMonth = Math.round(i.chatsPerDay * (i.unattendedPct / 100) * DAYS_PER_MONTH);
  const ordersPerMonth = Math.floor(unattendedChatsPerMonth * (i.closeRatePct / 100));
  const revenuePerMonthVnd = ordersPerMonth * Math.round(i.avgOrderVnd);
  const timesPlanPrice = planPriceVnd && planPriceVnd > 0 ? Math.floor((revenuePerMonthVnd / planPriceVnd) * 10) / 10 : null;
  return { unattendedChatsPerMonth, ordersPerMonth, revenuePerMonthVnd, timesPlanPrice };
}

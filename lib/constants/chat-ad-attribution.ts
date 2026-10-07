/**
 * ═══════════ CỬA SỔ QUY KẾT ĐƠN HỘI THOẠI ⇒ QUẢNG CÁO (chủ shop HSLC chốt 06/10/2026 — phương án A) ═══════════
 *
 * Đơn do bot chốt / do máy ghi từ hội thoại fanpage mang `orders.ad_id` = mã quảng cáo khách đã bấm để vào hội thoại
 * (`sales_chat_conversations.ad_id`) — CHỈ khi lượt bấm nằm trong cửa sổ này TRƯỚC mốc tạo đơn. Ngoài cửa sổ ⇒ đơn không
 * mang mã nào (NULL = chưa quy kết được, không đoán).
 *
 * Mặc định BẰNG cửa sổ mặc định «7 ngày sau lượt bấm» của Meta, để số đơn ở /ads so được với Trình quản lý quảng cáo. Chủ
 * shop đổi bằng setting `ads.chatAttributionWindowDays` (một số nguyên ngày). Đây là HẰNG SỐ DUY NHẤT của cửa sổ — không gõ
 * lại con số ở chỗ khác. HÀM THUẦN, dùng được cả ở client.
 */

export const CHAT_AD_ATTRIBUTION_SETTING_KEY = "ads.chatAttributionWindowDays";
export const CHAT_AD_ATTRIBUTION_DEFAULT_WINDOW_DAYS = 7;
/** Trần KỸ THUẬT của giá trị khai (chặn gõ nhầm 7000) — không phải ngưỡng nghiệp vụ. */
const MAX_WINDOW_DAYS = 365;

/** Nguồn của mã quảng cáo trên hội thoại — khớp CHECK `sales_chat_conversations_ad_source_check`. */
export const CHAT_AD_SOURCES = ["PANCAKE", "MESSENGER"] as const;
export type ChatAdSource = (typeof CHAT_AD_SOURCES)[number];

/** Giá trị setting ⇒ số ngày. Thiếu / sai (không phải số nguyên 1…365) ⇒ mặc định. */
export function parseChatAttributionWindowDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_WINDOW_DAYS ? n : CHAT_AD_ATTRIBUTION_DEFAULT_WINDOW_DAYS;
}

/**
 * Mã quảng cáo của hội thoại có được ghi vào đơn tạo lúc `orderAt` không: có mã, có mốc, mốc KHÔNG sau mốc tạo đơn, và cách
 * mốc tạo đơn không quá `windowDays` ngày. Thiếu một vế ⇒ `null` (không quy kết).
 */
export function chatAdForOrder(conv: { adId: string | null; adSeenAt: Date | null }, orderAt: Date, windowDays: number): string | null {
  if (!conv.adId || !conv.adSeenAt) return null;
  const age = orderAt.getTime() - conv.adSeenAt.getTime();
  return age >= 0 && age <= windowDays * 86_400_000 ? conv.adId : null;
}

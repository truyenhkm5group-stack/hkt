/**
 * ═══════════ BOT LÊN ĐƠN → CHUÔNG ERP (hàm thuần) ═══════════
 *
 * Chủ shop 02/10/2026: bot lên đơn kiểm mỗi SĐT khách gõ 30 phút/lần; quá 3 lần vẫn chưa đủ thông tin thì "thông báo
 * về ERP". Bot chạy ở container riêng và không ghi được vào CSDL ERP, nên job `alerts` của ERP HỎI bot (`/api/orderbot`)
 * rồi ghi chuông. Hàm ở đây chỉ quyết định MỞ / ĐÓNG thông báo nào — không đọc, không ghi gì.
 *
 * Khoá chống trùng gồm cả MỐC vào "cần duyệt" (`reviewAt`): cùng một hội thoại rơi vào cần duyệt lần thứ hai (khách
 * gửi thêm rồi lại thiếu) là MỘT thông báo mới, còn mỗi lượt job hỏi lại cùng một lần rơi thì không đẻ thêm dòng nào.
 */

export const ORDERBOT_ALERT_PREFIX = "orderbot:review:";
export const ORDERBOT_ALERT_HREF = "/chatbot?view=orderbot";

export type OrderBotReviewItem = {
  key: string;
  customerName?: string;
  page?: string;
  reasons?: string[];
  reviewAt?: number | null;
  lastCheckAt?: number | null;
};

export type OrderBotAlert = { dedupeKey: string; conversationKey: string; title: string; body: string };

/** Khoá chống trùng của MỘT lần rơi vào cần duyệt. Thiếu mốc thì dùng lần kiểm cuối; thiếu cả hai thì chưa báo được. */
export function orderBotAlertKey(it: OrderBotReviewItem): string | null {
  const moc = Number(it.reviewAt ?? it.lastCheckAt);
  if (!it.key || !Number.isFinite(moc) || moc <= 0) return null;
  return `${ORDERBOT_ALERT_PREFIX}${it.key}:${Math.trunc(moc)}`;
}

/**
 * Từ danh sách "cần duyệt" bot trả về + các thông báo còn MỞ của bot lên đơn: mở thông báo cho lần rơi chưa báo, đóng
 * thông báo mà hội thoại đã rời cần duyệt (đã lên đơn / nhân viên bỏ qua / khách gửi thêm). Không tiêu đề nào chứa số tiền.
 */
export function planOrderBotAlerts(review: readonly OrderBotReviewItem[], openKeys: readonly string[]): { create: OrderBotAlert[]; resolve: string[] } {
  const hienTai = new Map<string, OrderBotReviewItem>();
  for (const it of review) {
    const k = orderBotAlertKey(it);
    if (k) hienTai.set(k, it);
  }
  const daMo = new Set(openKeys);
  const create: OrderBotAlert[] = [];
  for (const [k, it] of hienTai) {
    if (daMo.has(k)) continue;
    const ai = [it.customerName, it.page].filter(Boolean).join(" · ") || "Khách";
    const lyDo = (it.reasons ?? []).filter(Boolean).join("; ") || "chưa đủ thông tin để lên đơn";
    create.push({ dedupeKey: k, conversationKey: it.key, title: "Bot lên đơn: đơn chưa đủ thông tin", body: `${ai} — ${lyDo}`.slice(0, 500) });
  }
  const resolve = openKeys.filter((k) => k.startsWith(ORDERBOT_ALERT_PREFIX) && !hienTai.has(k));
  return { create, resolve };
}

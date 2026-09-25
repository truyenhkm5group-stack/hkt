/**
 * ═══════════ GIÁ BÁO MKT — GIÁ CHỐT TÍNH CHO MARKETER THAY GIÁ VỐN THẬT ═══════════
 *
 * Chủ shop chốt ngày 25/09/2026 (bốn câu trả lời, giữ nguyên lời):
 *
 *  1. "1 mã chỉ có tính theo 1 giá từ đầu tới cuối, có thể gần hết vòng đời sản phẩm sẽ giảm giá thêm
 *     cho MKT để bán hết hàng tồn kho." ⇒ giá gắn MÃ HÀNG, không gắn lô; mỗi lần đổi là một dòng mới có
 *     ngày hiệu lực; đơn lấy giá đang hiệu lực vào NGÀY LÊN ĐƠN (hạ giá xả tồn chỉ áp cho đơn lên sau
 *     lúc hạ — đó là cả mục đích của việc hạ giá).
 *  2. "Chỉ phần của MKT." ⇒ giá báo thay giá vốn ở ĐÚNG hai chỗ: lợi nhuận danh nghĩa THEO MKT và cơ
 *     sở tính lương. Lợi nhuận SHOP vẫn đứng trên giá vốn phiếu kho (AGENTS.md mục 13, 15). Phần chênh
 *     (giá báo − giá vốn thật) là dòng đối soát "shop giữ lại" để Σ các MKT vẫn khớp tổng shop.
 *  3. "Từ tháng 9/2026." ⇒ đơn lên TRƯỚC `MARKETER_PRICE_EFFECTIVE_FROM` không bao giờ dùng giá báo,
 *     kể cả khi dòng giá khai hiệu lực sớm hơn. Tháng 8 trở về trước không bị tính lại.
 *  4. "Hoàn phạt MKT: có, cộng cho MKT phụ trách." ⇒ tiền phạt xưởng ghi trên lô cộng vào lợi nhuận
 *     của MKT phụ trách mã (cấu hình Lương "Marketer phụ trách mã") trong kỳ chứa NGÀY GHI PHẠT.
 *
 * Mã CHƯA có giá báo ⇒ giá vốn như cũ (phiếu kho → Pancake → giá nhập mẫu mã). Không có "giá báo 0đ
 * mặc định": giá báo 0 phải là một dòng người khai.
 */

/** Ngày đầu tiên giá báo MKT được áp (giờ Việt Nam). Đổi = đổi lương các kỳ đã tính ⇒ hỏi chủ shop. */
export const MARKETER_PRICE_EFFECTIVE_FROM = "2026-09-01";

export function marketerPriceCutoff(): Date {
  return new Date(`${MARKETER_PRICE_EFFECTIVE_FROM}T00:00:00+07:00`);
}

export type MarketerPriceEntry = { price: number; effectiveFrom: Date };

/**
 * Giá báo đang hiệu lực của MỘT mã vào thời điểm `at`. Hàm THUẦN — cùng luật với biểu thức SQL
 * `MKT_LINE_UNIT_COST` (`lib/queries/marketer-price.ts`); bài kiểm chạy cả hai trên cùng dữ liệu.
 * `null` = không có giá báo áp được (chưa khai, hoặc đơn trước ngày bắt đầu áp dụng).
 */
export function marketerPriceAt(entries: readonly MarketerPriceEntry[], at: Date): number | null {
  if (at.getTime() < marketerPriceCutoff().getTime()) return null;
  let best: MarketerPriceEntry | null = null;
  for (const e of entries) {
    if (e.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || e.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = e;
  }
  return best ? best.price : null;
}

/**
 * Phần chênh của MỘT dòng đơn khi tính cho MKT: (giá báo − giá vốn thật) × số lượng. Dương = MKT chịu
 * giá cao hơn giá vốn thật (shop giữ phần chênh); âm = shop "bù" cho MKT (giá xả tồn thấp hơn giá vốn).
 * Không có giá báo ⇒ 0 (MKT chịu đúng giá vốn thật).
 */
export function marketerCostDelta(qty: number, realUnitCost: number, price: number | null): number {
  return price == null ? 0 : qty * (price - realUnitCost);
}

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
 *
 * ═══ SỬA ĐỔI 25/09/2026 — GIÁ NHẬP KHO = GIÁ BÁO MKT ═══
 *
 * Chủ shop chốt (giữ nguyên lời): "Có thể lấy giá báo MKT làm giá ở phần nhập kho, hoặc bỏ phần giá
 * ở khâu nhập kho vì kho không cần biết giá, tính theo giá báo MKT là được rồi" — rồi chọn "Luôn lấy
 * giá báo MKT". Hệ quả, đã nói với chủ shop trước khi làm:
 *
 *  · Kho KHÔNG nhập giá nữa. Phiếu NHẬP HÀNG MỚI ghi `unit_cost` = giá báo của mã theo NGÀY NHẬP
 *    (`receiptUnitCostFromMarketer`), máy chủ tự đọc — giá client gửi lên bị bỏ qua.
 *  · Câu 2 ở trên ("lợi nhuận shop đứng trên giá vốn phiếu kho") VẪN ĐÚNG về đường đi: báo cáo lợi
 *    nhuận shop vẫn chỉ đọc phiếu kho, không đọc thẳng bảng giá báo. Nhưng vì phiếu kho giờ mang
 *    chính giá báo, phần chênh "shop giữ lại" (giá báo − giá vốn thật) về 0 cho hàng nhập theo luật
 *    mới; nó chỉ còn khác 0 khi giá báo đổi (hạ xả tồn) sau lúc nhập, hoặc với hàng nhập bằng giá cũ.
 *  · Mã CHƯA có giá báo ⇒ phiếu vẫn lưu được (kho không được bị chặn vì một việc của người khác), dòng
 *    ghi giá 0 = CHƯA BIẾT GIÁ (cùng quy ước "phiếu không ghi đơn giá" mọi báo cáo đã hiểu), và màn
 *    hình nói ra mã nào đang thiếu. Không bao giờ đoán giá.
 *  · Phiếu CŨ ghi giá 0 không tự đổi. Người có quyền giá báo bấm "Định giá phiếu nhập theo giá báo
 *    MKT" (xem trước → xác nhận, có nhật ký); dòng đã có giá thật KHÔNG bao giờ bị ghi đè.
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

/**
 * Đơn giá ghi lên một dòng PHIẾU NHẬP HÀNG MỚI theo giá báo MKT (chủ shop chốt 25/09/2026). Hàm THUẦN.
 *
 *  · Giá đang hiệu lực vào ngày nhập (dòng có `effectiveFrom` ≤ `at`, mới nhất thắng).
 *  · Hàng về TRƯỚC dòng giá đầu tiên ⇒ lấy dòng giá đầu tiên: "1 mã chỉ tính theo 1 giá từ đầu tới
 *    cuối" — ngày hiệu lực của dòng đầu là ngày người khai, không phải ngày mã bắt đầu có giá.
 *  · KHÔNG áp mốc `MARKETER_PRICE_EFFECTIVE_FROM`: mốc đó giữ lương các tháng đã trả (theo NGÀY LÊN
 *    ĐƠN), còn đây là giá của một lô hàng nhập.
 *  · Chưa khai dòng nào ⇒ `null` (chưa biết), KHÔNG phải 0.
 */
export function receiptUnitCostFromMarketer(entries: readonly MarketerPriceEntry[], at: Date): number | null {
  return receiptPriceEntry(entries, at)?.price ?? null;
}

/**
 * DÒNG giá báo mà luật trên chọn (không chỉ con số) — để nơi dùng in được "hiệu lực từ ngày nào,
 * ai khai". Cùng MỘT phép chọn cho phiếu nhập kho và giá vốn dự tính: hai chỗ cùng nói "giá của mã
 * này" thì không được chọn hai dòng khác nhau.
 */
export function receiptPriceEntry<T extends MarketerPriceEntry>(entries: readonly T[], at: Date): T | null {
  if (!entries.length) return null;
  let best: T | null = null;
  let first: T | null = null;
  for (const e of entries) {
    if (!first || e.effectiveFrom.getTime() < first.effectiveFrom.getTime()) first = e;
    if (e.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || e.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = e;
  }
  return best ?? first;
}

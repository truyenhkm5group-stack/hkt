/**
 * ═══════════ CPO HOÀ VỐN — MỘT PHÉP CHIA, HAI CÂU HỎI CÓ TÊN RIÊNG ═══════════
 *
 * "Mỗi đơn chốt được phép tốn tối đa bao nhiêu tiền quảng cáo" có ĐÚNG MỘT công thức trong ERP:
 *
 *     Trần chi cả kỳ  = LN trước QC ÷ (1 + %CP khác theo QC)
 *     CPO hoà vốn     = Trần chi cả kỳ ÷ số đơn chốt              (0 đơn ⇒ null)
 *
 * Hai màn hình đọc nó, và chúng CỐ Ý đưa vào hai tử số khác nhau — vì chúng trả lời hai câu khác nhau:
 *
 *  · `CONTRIBUTION` — bảng quyết định `/ads` (`buildDecisionRow`). Tử số là LỢI NHUẬN GÓP trước QC
 *    (doanh thu giao TC − giá vốn − cước), KHÔNG trừ vận hành, cố định, thuế, rủi ro tồn kho, và
 *    %CP khác = 0 vì bảng ấy không trừ khoản đó ở bất kỳ ô nào (`profitAfterAds`, `headroom`). Hỏi:
 *    *"tăng/giảm ngân sách dòng này thì biên góp còn dương không"*. Bất biến kiểm được:
 *    `CPO thực ≤ CPO hoà vốn ⟺ profitAfterAds ≥ 0`.
 *  · `NOMINAL_NET` — tab Lợi nhuận danh nghĩa (`adsCeiling`). Tử số là LN RÒNG danh nghĩa + CPQC +
 *    CP khác, tức ĐÃ trừ phần vận hành/cố định phân bổ, thuế, rủi ro tồn kho. Hỏi: *"chi tới đâu thì
 *    mã còn lãi sau MỌI chi phí"*. Luôn thấp hơn (chặt hơn) con số góp của cùng mã.
 *
 * Hai con số KHÔNG BAO GIỜ được in dưới cùng một cái nhãn trơn "CPO hoà vốn" — nhãn đi theo
 * `BREAK_EVEN_CPO_LABEL`. `tests/company-os-economics.test.ts` chứng minh hai đường gọi cùng hàm này
 * và ra cùng số khi cùng đầu vào.
 *
 * ≤ 0 là một câu trả lời thật: không tiêu đồng QC nào vẫn lỗ ở mức lợi nhuận ấy. Màn hình in câu đó,
 * không in "0 ₫" như thể còn được chạy tới 0.
 */

export type BreakEvenCpoBasis = "CONTRIBUTION_ACTUAL" | "CONTRIBUTION_PROJECTED" | "NOMINAL_NET";

export const BREAK_EVEN_CPO_LABEL: Record<BreakEvenCpoBasis, string> = {
  CONTRIBUTION_ACTUAL: "CPO hoà vốn · LN góp (số đo)",
  CONTRIBUTION_PROJECTED: "CPO hoà vốn · LN góp (tạm tính)",
  NOMINAL_NET: "Trần CPQC/đơn · LN ròng danh nghĩa",
};

export const BREAK_EVEN_CPO_NOTE: Record<BreakEvenCpoBasis, string> = {
  CONTRIBUTION_ACTUAL:
    "Lợi nhuận góp trước QC ĐÃ ĐO (doanh thu giao thành công − giá vốn − cước) chia cho số đơn chốt. Chưa trừ vận hành, cố định, thuế — đúng phạm vi của bảng quyết định. Dòng còn nhiều đơn đang đi thì con số này thấp hơn thật vì doanh thu chưa về.",
  CONTRIBUTION_PROJECTED:
    "Như số đo, cộng phần đơn đang treo đã cân theo tỷ lệ giao thành công ước tính của mã (và trừ cước dự phóng của đúng phần ấy). Đây là con số bảng quyết định dùng khi dòng đứng trên căn cứ TẠM TÍNH.",
  NOMINAL_NET:
    "(LN ròng danh nghĩa + CPQC + CP khác) ÷ (1 + %CP khác) ÷ số đơn chốt — đã trừ vận hành, cố định phân bổ, thuế, rủi ro tồn kho. Chặt hơn CPO hoà vốn theo lợi nhuận góp của cùng mã.",
};

/** Trần chi quảng cáo CẢ KỲ để lợi nhuận (ở mức tử số truyền vào) còn bằng 0. Có thể âm. */
export function breakEvenSpend(profitBeforeAds: number, otherCostPercentOfAds = 0): number {
  const heSo = 1 + Math.max(0, otherCostPercentOfAds || 0) / 100;
  return profitBeforeAds / heSo;
}

/** Chi trên mỗi đơn chốt. `null` khi chưa có đơn — CHƯA BIẾT, không phải 0 (mục 42). */
export function spendPerOrder(spend: number, orders: number): number | null {
  if (!Number.isFinite(spend) || !Number.isFinite(orders) || orders <= 0) return null;
  return Math.round(spend / orders);
}

/**
 * CPO hoà vốn / trần CPQC mỗi đơn chốt — ĐƯỜNG DUY NHẤT. `null` khi chưa có đơn hoặc tử số không
 * phải một con số (chưa biết thì không tính).
 */
export function maxAdCostPerOrder(input: { profitBeforeAds: number | null; orders: number; otherCostPercentOfAds?: number }): number | null {
  if (input.profitBeforeAds === null || !Number.isFinite(input.profitBeforeAds)) return null;
  return spendPerOrder(breakEvenSpend(input.profitBeforeAds, input.otherCostPercentOfAds ?? 0), input.orders);
}

/** Dư địa mỗi đơn = CPO hoà vốn − CPO thực. Dương = còn chỗ; âm = đang lỗ mỗi đơn ngần ấy. */
export function cpoHeadroom(breakEven: number | null, actual: number | null): number | null {
  return breakEven === null || actual === null ? null : breakEven - actual;
}

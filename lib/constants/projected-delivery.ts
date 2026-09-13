/**
 * ═══════════ MỘT HỢP ĐỒNG DUY NHẤT CHO "TỶ LỆ GIAO THÀNH CÔNG ƯỚC TÍNH" ═══════════
 *
 * ─── VẤN ĐỀ ĐÃ ĐO ĐƯỢC (truy từ mã nguồn, 13/09/2026) ───
 *
 * Hai trang đang trả lời cùng một câu hỏi bằng hai công thức khác nhau — và khác ở BỐN CHỖ ĐỘC LẬP,
 * nên chênh lệch cộng dồn chứ không triệt tiêu:
 *
 *                     │ /reports/returns                  │ /reports?tab=nominal
 *   ──────────────────┼───────────────────────────────────┼──────────────────────────────────
 *   mẫu số            │ vận đơn ĐÃ KẾT THÚC + chờ phát lại│ MỌI đơn của mã trong kỳ
 *   nhóm chưa rõ      │ loại hẳn khỏi phép tính           │ nhân với tỷ lệ hoàn GIẢ ĐỊNH
 *   mốc cohort        │ ngày ĐVVC tiếp nhận               │ ngày TẠO ĐƠN
 *   grain             │ mẫu mã                            │ sản phẩm
 *
 * `return-rate.ts:607`   : `(returned + failed × p) / (delivered + returned + failed)`
 * `profit-nominal.ts:459`: `(returned + failed × pFail + unknown × baseReturnRate/100) / base.orders`
 *
 * Không trang nào ghi cứng 22%. Nhưng `defaultReturnRate` là một GIẢ ĐỊNH DO NGƯỜI ĐẶT, và nó được
 * áp cho nhóm chưa rõ ở bảng nominal mà không áp ở bảng returns — tác dụng giống hệt một con số
 * ghi cứng, chỉ khó thấy hơn.
 *
 * Và `profit-nominal.ts:289` lấy `expectedRevenue = grossSales × (1 − r)`: nhân TOÀN BỘ doanh số
 * với một tỷ lệ duy nhất, thay vì cân từng đơn theo trạng thái thật của chính nó.
 *
 * ─── HỢP ĐỒNG ───
 *
 * Một xác suất cho MỖI TRẠNG THÁI, học từ lịch sử thật:
 *
 *     P(giao thành công │ đang ở trạng thái s)
 *   = số vận đơn TỪNG ở trạng thái s và sau đó GIAO THÀNH CÔNG
 *   ÷ số vận đơn TỪNG ở trạng thái s và ĐÃ CÓ KẾT CỤC CUỐI
 *
 * rồi:
 *
 *     Ước tính giao được = Đã giao thật + Σ(số kiện đang ở s × P(s))
 *     Tỷ lệ GTC ước tính = Ước tính giao được ÷ Đã gửi
 *
 * Ba điều quan trọng, cả ba đều là chỗ dễ làm sai:
 *
 *  1. **Vận đơn chưa có kết cục KHÔNG vào mẫu số học xác suất.** Đưa vào là trộn "chưa biết" với
 *     "đã biết là hỏng", và xác suất tụt xuống chỉ vì hôm nay có nhiều kiện mới.
 *  2. **Một vận đơn đi qua một trạng thái BAO NHIÊU LẦN cũng chỉ là MỘT quan sát.** Webhook của
 *     Viettel Post lặp và thử lại tới 5 lần; đếm theo sự kiện là để số lần thử lại quyết định xác
 *     suất.
 *  3. **Không trạng thái nào mặc nhiên giống trạng thái nào.** "Chờ phát lại" và "chờ xử lý" có
 *     tương lai khác hẳn nhau; gộp cả hai vào "đang giao" rồi dùng một xác suất chung là bỏ đi
 *     chính thông tin đang có.
 */

/** Phiên bản CÔNG THỨC. Đổi cách tính ⇒ tăng số, để ảnh chụp kỳ cũ không bị đọc bằng luật mới. */
export const PROJECTED_GTC_VERSION = "PROJECTED_GTC_V2";

/**
 * ĐỘ TIN CẬY THEO CỠ MẪU.
 *
 * Ngưỡng không phải con số đẹp: chúng là điểm mà sai số chuẩn của một tỷ lệ nhị phân quanh 0,5 rơi
 * xuống dưới mức còn dùng để quyết định được — ±5 điểm ở 100 mẫu, ±9 ở 30, ±16 ở 10. Dưới 10 thì
 * một kiện đổi kết cục làm tỷ lệ nhảy hơn 10 điểm, nên nó KHÔNG phải một xác suất; nó là tiếng ồn.
 */
export const CONFIDENCE_THRESHOLDS = { HIGH: 100, MEDIUM: 30, LOW: 10 } as const;

export type ProbabilityConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";

export function confidenceOf(sample: number): ProbabilityConfidence {
  if (sample >= CONFIDENCE_THRESHOLDS.HIGH) return "HIGH";
  if (sample >= CONFIDENCE_THRESHOLDS.MEDIUM) return "MEDIUM";
  if (sample >= CONFIDENCE_THRESHOLDS.LOW) return "LOW";
  return "INSUFFICIENT_DATA";
}

export const CONFIDENCE_LABEL: Record<ProbabilityConfidence, string> = {
  HIGH: "Tin cậy cao",
  MEDIUM: "Tin cậy vừa",
  LOW: "Mẫu nhỏ",
  INSUFFICIENT_DATA: "Chưa đủ dữ liệu",
};

/**
 * THỨ TỰ LÙI KHI MẪU KHÔNG ĐỦ — hẹp trước, rộng sau, và cuối cùng là THỪA NHẬN KHÔNG BIẾT.
 *
 * Cố ý KHÔNG có bậc nào trả về một con số mặc định. Hết bậc thì kết quả là `null`, và màn hình in
 * "chưa đo được" — khác hẳn 0% (đã đo và bằng không) và khác hẳn một con số đoán trông như đã đo.
 */
export const PROBABILITY_FALLBACK = ["PRODUCT_STATE", "GLOBAL_STATE", "NONE"] as const;
export type ProbabilityBasis = (typeof PROBABILITY_FALLBACK)[number];

export const BASIS_LABEL: Record<ProbabilityBasis, string> = {
  PRODUCT_STATE: "theo mã hàng + trạng thái",
  GLOBAL_STATE: "theo trạng thái (toàn shop)",
  NONE: "chưa đo được",
};

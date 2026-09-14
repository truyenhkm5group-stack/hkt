/**
 * BẢNG GIÁ MÔ HÌNH — phần CỐ ĐỊNH (đô la Mỹ trên một triệu token).
 *
 * Vì sao tách làm hai mảnh:
 *   · Đơn giá USD là SỰ THẬT CÔNG BỐ của nhà cung cấp — chép đúng, ghi rõ ngày chép.
 *   · Tỷ giá USD→VND là QUYẾT ĐỊNH KINH DOANH của chủ shop, đổi theo ngày, và ERP không có nguồn
 *     tỷ giá nào. KHÔNG đoán nó. Chưa khai tỷ giá thì chi phí phải là CHƯA BIẾT (`null`), đúng
 *     luật "NULL là chưa biết, không phải 0" — chứ không phải lặng lẽ tính ra một con số sai.
 *
 * Mẻ chạy thử đầu in "chi phí đã tính: 0đ" và con số ấy ĐÚNG, vì không gọi mô hình lần nào. Nhưng
 * nếu bật mô hình mà vẫn chưa khai bảng giá, `ai_runs.cost_vnd` sẽ là `null` ở cả 500 lượt — đó là
 * lý do phải khai TRƯỚC khi bật, không phải sau.
 */

/** Ngày chép bảng giá từ tài liệu nhà cung cấp. Đổi giá thì đổi luôn ngày này. */
export const MODEL_PRICE_SOURCE_DATE = "2026-06-24";

export type ModelUsdPrice = {
  /** USD trên 1 triệu token vào. */
  inputUsdPerMillion: number;
  /** USD trên 1 triệu token ra. */
  outputUsdPerMillion: number;
};

/**
 * Chỉ khai những mô hình nhân sự bán hàng THẬT SỰ dùng. Thêm mô hình khác thì thêm ở đây, đừng
 * rải đơn giá vào từng nơi gọi.
 */
export const MODEL_USD_PRICES: Record<string, ModelUsdPrice> = {
  // Nấc RẺ — hiểu ý khách, phân loại, bóc thực thể. Việc nhiều, câu ngắn.
  "claude-haiku-4-5": { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
  // Nấc MẠNH — chỉ gọi khi nấc rẻ không đủ tự tin.
  "claude-sonnet-5": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
};

/** Gợi ý mặc định cho hai biến môi trường, để hai nơi không nói hai mô hình khác nhau. */
export const DEFAULT_ECONOMY_MODEL = "claude-haiku-4-5";
export const DEFAULT_STRONG_MODEL = "claude-sonnet-5";

/**
 * Quy bảng giá USD sang VND theo MỘT tỷ giá do người khai. HÀM THUẦN.
 * Trả về đúng dạng `settings.ai.pricing` mà `sanitizePricing()` chấp nhận.
 */
export function buildVndPricing(usdToVnd: number): Record<string, { inputVndPerMillion: number; outputVndPerMillion: number }> {
  if (!Number.isFinite(usdToVnd) || usdToVnd <= 0) {
    throw new Error("Tỷ giá USD→VND phải là số dương — không có mặc định, vì đoán tỷ giá là bịa chi phí");
  }
  const out: Record<string, { inputVndPerMillion: number; outputVndPerMillion: number }> = {};
  for (const [model, gia] of Object.entries(MODEL_USD_PRICES)) {
    out[model] = {
      inputVndPerMillion: Math.round(gia.inputUsdPerMillion * usdToVnd),
      outputVndPerMillion: Math.round(gia.outputUsdPerMillion * usdToVnd),
    };
  }
  return out;
}

/**
 * Nhãn phiên bản bảng giá. Gắn cả NGÀY CHÉP GIÁ lẫn TỶ GIÁ, vì đổi một trong hai là ra con số
 * khác — hai kỳ mang nhãn khác nhau thì không ai vẽ nhầm một đường xu hướng qua chúng.
 */
export function pricingVersionLabel(usdToVnd: number): string {
  return `anthropic-${MODEL_PRICE_SOURCE_DATE}-usdvnd${Math.round(usdToVnd)}`;
}

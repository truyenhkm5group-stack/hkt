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
  /** Nhà cung cấp — cùng tên với adapter, vì khoá tra giá là `"<nhà>:<mẫu>"`. */
  provider: string;
  /** USD trên 1 triệu token vào, TÍNH ĐỦ GIÁ (không gồm phần đọc từ đệm). */
  inputUsdPerMillion: number;
  /** USD trên 1 triệu token ra. */
  outputUsdPerMillion: number;
  /**
   * USD trên 1 triệu token ĐỌC LẠI TỪ ĐỆM. `undefined` = nhà cung cấp không có đệm, hoặc CHƯA
   * KHAI — và hai nghĩa ấy dẫn tới cùng một hành vi đúng: chi phí lượt có token đệm là CHƯA BIẾT.
   *
   * Ô này là chỗ dễ quên nhất và tốn nhất. `estimateCostVnd()` trả `null` khi lượt gọi CÓ token
   * đệm mà bảng giá chưa khai đơn giá đệm — nên quên nó nghĩa là khai giá xong mà chi phí VẪN
   * chưa biết, ở đúng những lượt hay xảy ra nhất (nhà cung cấp đệm rất hăng phần lời dặn).
   */
  cachedInputUsdPerMillion?: number;
  /** USD trên 1 triệu token GHI VÀO đệm. `undefined` = không tính tiền lượt ghi (Gemini) hoặc chưa khai. */
  cacheWriteUsdPerMillion?: number;
  /** Có đưa vào bảng giá sinh ra hay không. `false` = đã khai nhưng chưa dùng. */
  enabled: boolean;
  /** Đơn giá này có hiệu lực từ ngày nào (ISO). Đổi giá = thêm dòng mới, không sửa dòng cũ. */
  effectiveFrom: string;
  /** Hết hiệu lực từ ngày nào. `null` = vẫn đang áp dụng. */
  effectiveTo: string | null;
  /** Lấy con số này ở đâu ra — để người sau kiểm lại được, và biết nó cũ tới mức nào. */
  sourceNote: string;
};

/**
 * Chỉ khai những mô hình nhân sự bán hàng THẬT SỰ dùng. Thêm mô hình khác thì thêm ở đây, đừng
 * rải đơn giá vào từng nơi gọi.
 */
export const MODEL_USD_PRICES: Record<string, ModelUsdPrice> = {
  // Nấc RẺ — hiểu ý khách, phân loại, bóc thực thể. Việc nhiều, câu ngắn.
  "claude-haiku-4-5": {
    provider: "anthropic",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 1.25,
    enabled: true,
    effectiveFrom: MODEL_PRICE_SOURCE_DATE,
    effectiveTo: null,
    sourceNote: `Bảng giá công bố của Anthropic, chép ngày ${MODEL_PRICE_SOURCE_DATE}`,
  },
  /*
    Nấc PHÂN TÍCH của AI Copilot — không nằm trên đường chat khách, nhưng nó TỐN TIỀN THẬT và
    trước bản này đơn giá của nó nằm ở một bảng thứ hai (`lib/ai/provider.ts::PRICE_PER_MTOK`).
    Hai bảng giá cho cùng một mô hình là hai con số có thể nói khác nhau về cùng một hoá đơn.
  */
  "claude-opus-5": {
    provider: "anthropic",
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 25,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 6.25,
    enabled: true,
    effectiveFrom: MODEL_PRICE_SOURCE_DATE,
    effectiveTo: null,
    sourceNote: `Bảng giá công bố của Anthropic, chép ngày ${MODEL_PRICE_SOURCE_DATE} (gộp từ lib/ai/provider.ts)`,
  },
  // Nấc MẠNH — chỉ gọi khi nấc rẻ không đủ tự tin.
  "claude-sonnet-5": {
    provider: "anthropic",
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 0.2,
    cacheWriteUsdPerMillion: 2.5,
    enabled: true,
    effectiveFrom: MODEL_PRICE_SOURCE_DATE,
    effectiveTo: null,
    sourceNote: `Bảng giá công bố của Anthropic, chép ngày ${MODEL_PRICE_SOURCE_DATE}`,
  },
  /*
    MÔ HÌNH ĐANG CHẠY THẬT (`gpt-5.6-luna`, `gpt-5.6-terra`) CỐ TÌNH KHÔNG CÓ Ở ĐÂY.

    Đây là chỗ dễ sai nhất của cả tệp, nên nói thẳng: tôi KHÔNG biết đơn giá công bố của chúng, và
    chép một con số nhớ mang máng vào đây sẽ tạo ra một bảng chi phí trông rất thuyết phục mà sai
    — kiểu sai không ai đi kiểm lại, vì nó đã có sẵn một con số.

    Đường đúng đã có sẵn và không cần sửa mã: chủ shop đọc bảng giá hiện hành rồi khai bằng
      npx tsx scripts/ai-set-pricing.ts --usd-vnd=<tỷ giá> \
        --model="gpt-5.6-luna:<usd vào>/<usd ra>[/<usd đệm>]"
    Con số vào CSDL kèm nhãn phiên bản, truy được về ngày khai, và đổi được mà không phải phát
    hành lại phần mềm.
  */
};

/** Gợi ý mặc định cho hai biến môi trường, để hai nơi không nói hai mô hình khác nhau. */
export const DEFAULT_ECONOMY_MODEL = "claude-haiku-4-5";
export const DEFAULT_STRONG_MODEL = "claude-sonnet-5";

/** Đúng dạng một dòng trong `settings.ai.pricing` mà `sanitizePricing()` chấp nhận. */
export type VndPrice = {
  inputVndPerMillion: number;
  outputVndPerMillion: number;
  cachedReadVndPerMillion?: number;
  cacheWriteVndPerMillion?: number;
};

/**
 * Quy bảng giá USD sang VND theo MỘT tỷ giá do người khai. HÀM THUẦN.
 * Trả về đúng dạng `settings.ai.pricing` mà `sanitizePricing()` chấp nhận.
 */
export function buildVndPricing(usdToVnd: number): Record<string, VndPrice> {
  if (!Number.isFinite(usdToVnd) || usdToVnd <= 0) {
    throw new Error("Tỷ giá USD→VND phải là số dương — không có mặc định, vì đoán tỷ giá là bịa chi phí");
  }
  const out: Record<string, VndPrice> = {};
  for (const [model, gia] of Object.entries(MODEL_USD_PRICES)) {
    if (!gia.enabled) continue;
    if (gia.effectiveTo !== null) continue; // đã hết hiệu lực ⇒ không đưa vào bảng đang chạy
    const dong: VndPrice = {
      inputVndPerMillion: Math.round(gia.inputUsdPerMillion * usdToVnd),
      outputVndPerMillion: Math.round(gia.outputUsdPerMillion * usdToVnd),
    };
    // Chỉ ghi ô đệm khi THẬT SỰ có khai. Ghi 0 vào đây là nói "đệm miễn phí", một lời khẳng định
    // khác hẳn "chưa biết giá đệm" — và nó làm chi phí thành một con số thay vì thành `null`.
    if (gia.cachedInputUsdPerMillion !== undefined) dong.cachedReadVndPerMillion = Math.round(gia.cachedInputUsdPerMillion * usdToVnd);
    if (gia.cacheWriteUsdPerMillion !== undefined) dong.cacheWriteVndPerMillion = Math.round(gia.cacheWriteUsdPerMillion * usdToVnd);
    /*
      GHI HAI KHOÁ cho cùng một mẫu: `"<nhà>:<mẫu>"` và `"<mẫu>"`.

      `estimateCostVnd()` tra `"<nhà>:<mẫu>"` trước rồi mới tới `"<mẫu>"`. Khoá có tên nhà là khoá
      ĐÚNG (cùng một tên mẫu chạy qua hai nhà có thể hai giá), còn khoá trần là đường lui cho những
      lượt mà `result.provider` về dạng khác với lúc khai (`erp:openai` chẳng hạn). Thiếu khoá trần
      thì mọi lượt đi qua cầu nối ERP sẽ tra trượt và chi phí là CHƯA BIẾT — đúng luật nhưng vô ích.
    */
    out[`${gia.provider}:${model}`] = dong;
    out[model] = dong;
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

/**
 * Đơn giá USD của một mô hình — ĐƯỜNG DUY NHẤT cho cả hai tầng AI của ERP.
 *
 * Trước bản này có HAI bảng: tệp này (nhân sự bán hàng) và `lib/ai/provider.ts::PRICE_PER_MTOK`
 * (AI Copilot). Cùng một mô hình, hai con số có thể trôi khác nhau, và không ai biết hoá đơn thật
 * đi theo bảng nào. Đặc tả gọi đúng tên vấn đề: một khoản chi có ĐÚNG MỘT nguồn.
 *
 * `null` = CHƯA KHAI GIÁ. Nơi gọi phải in "chưa biết", KHÔNG được thay bằng 0.
 */
export function usdPriceFor(model: string): ModelUsdPrice | null {
  const gia = MODEL_USD_PRICES[model];
  if (!gia || !gia.enabled || gia.effectiveTo !== null) return null;
  return gia;
}

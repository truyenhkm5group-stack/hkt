/**
 * MÔ PHỎNG ĐỊNH TUYẾN V1 — HÀM THUẦN, CHẠY NGẦM, KHÔNG CHẠM MỘT LƯỢT CHẠY THẬT NÀO.
 *
 * ═══ TỆP NÀY KHÔNG ĐỊNH TUYẾN GÌ CẢ ═══
 *
 * Bộ định tuyến ĐANG CHẠY là `lib/ai-workforce/model-router.ts` và phiên này KHÔNG đụng vào nó.
 * Tệp này trả lời một câu hỏi phản thực: *nếu* có một bộ định tuyến bốn tầng thì lượt chạy đã
 * xảy ra kia đáng lẽ đi đường nào, và tốn bao nhiêu. Kết quả chỉ để ĐỌC và ĐỐI CHIẾU — không một
 * đường nào trong kho mã được phép lấy nó để trả lời khách.
 *
 * Nó là hàm THUẦN vì đó là điều kiện để con số đáng tin: chạy lại trên cùng dữ liệu phải ra cùng
 * kết quả, và không lượt mô phỏng nào được ghi vào CSDL hay gọi một mô hình nào. Một "mô phỏng"
 * có tác dụng phụ thì không phải mô phỏng, nó là một bản triển khai thứ hai chạy lén.
 *
 * ═══ HAI CHIỀU, KHÔNG MỘT ═══
 *
 * ĐỘ KHÓ quyết định gọi mô hình MẠNH HƠN; RỦI RO NGHIỆP VỤ quyết định gọi NGƯỜI. Gộp hai chiều
 * vào một thang điểm là lỗi đắt nhất mà một bộ định tuyến có thể mắc: một khiếu nại đòi hoàn tiền
 * KHÔNG khó hiểu — nó dễ hiểu và phải về tay người. Nếu rủi ro chỉ làm tăng "độ khó" thì máy sẽ
 * đáp lại một khiếu nại bằng cách gọi một mô hình đắt hơn rồi tự trả lời, đúng thứ không được
 * phép. Đặc tả ghi thẳng điều này và mã phải giữ nó ở dạng hai nhánh tách rời.
 */

/** Sáu đường đi. `HUMAN` không phải một nấc mô hình — nó là lối ra khỏi mọi nấc mô hình. */
export const ROUTE_LANES = [
  "RULE_ONLY",
  "OPENAI_ROUTINE",
  "GEMINI_ROUTINE",
  "GEMINI_COMPLEX",
  "ANTHROPIC_COMPLEX",
  "HUMAN",
] as const;
export type RouteLane = (typeof ROUTE_LANES)[number];

export const ROUTE_LANE_LABEL: Record<RouteLane, string> = {
  RULE_ONLY: "Chỉ luật — không gọi mô hình",
  OPENAI_ROUTINE: "Việc thường · nhà cung cấp đang chạy",
  GEMINI_ROUTINE: "Việc thường · đối chứng Gemini",
  GEMINI_COMPLEX: "Việc khó · đối chứng Gemini",
  ANTHROPIC_COMPLEX: "Việc khó · Claude",
  HUMAN: "Về tay người",
};

/**
 * Ý định BẮT BUỘC về tay người, bất kể máy tự tin đến đâu.
 *
 * Giữ RIÊNG khỏi `HUMAN_ONLY_INTENTS` của `understand.ts` có chủ ý: đó là luật của dây chuyền
 * ĐANG CHẠY, còn đây là luật của một bộ định tuyến CHƯA chạy. Nối cứng hai thứ lại thì sửa mô
 * phỏng sẽ đổi hành vi thật — đúng điều phiên này cấm. Bài kiểm khẳng định tập này PHỦ tập kia,
 * nên chúng không trôi xa nhau mà vẫn không dính vào nhau.
 */
export const RISK_INTENTS_TO_HUMAN = ["COMPLAINT", "ASK_HUMAN", "AFTER_SALES", "PRICE_NEGOTIATION"] as const;

export type RouterSimInput = {
  /** Ý định bóc được từ câu khách (nhãn của dây chuyền đã chạy). */
  intents: string[];
  /** Độ tin của bậc LUẬT. `null` = luật không kết luận được. */
  ruleConfidence: number | null;
  /** Máy đã nối được về một mã hàng chưa. */
  hasProduct: boolean;
  /** Đã chốt được một mẫu mã chưa. */
  hasVariant: boolean;
  /** Số tiền máy chủ đã tính. `null` = CHƯA BIẾT. */
  quotedTotal: number | null;
  /** Người đã vào cầm hội thoại chưa. */
  humanTakeover: boolean;
  /** Dây chuyền thật đã kết luận chuyển người chưa, và vì sao. */
  handoffReason: string;
  /** Câu khách có kèm ảnh không — ảnh chỉ đi được đường có mắt. */
  hasImage: boolean;
  /** Số tin của khách trong hội thoại tính tới lượt này. Dài ⇒ ngữ cảnh khó hơn. */
  customerTurns: number;
};

export type RouterSimResult = {
  lane: RouteLane;
  /** Câu giải thích ĐỌC ĐƯỢC. Một bảng phân bổ không có lý do thì không ai sửa được gì từ nó. */
  why: string;
  /** Luật có tự trả lời được không — đo RIÊNG, vì nó là con số đáng giá nhất của cả phép mô phỏng. */
  ruleOnlyEligible: boolean;
  /** Độ khó ước tính (0–1). KHÔNG gộp rủi ro vào đây — xem chú thích đầu tệp. */
  complexity: number;
  /** Rủi ro nghiệp vụ (0–1). Cao ⇒ về tay người, KHÔNG phải ⇒ mô hình đắt hơn. */
  businessRisk: number;
};

/** Ngưỡng — khai ở một chỗ để chỉnh được, và để bài kiểm chỉ vào đúng con số khi nó đổi. */
export const SIM_THRESHOLDS = {
  /** Trên mức này thì bậc luật tự đủ, không cần mô hình. */
  ruleConfident: 0.75,
  /** Trên mức này thì việc được coi là KHÓ ⇒ nấc mô hình mạnh. */
  complex: 0.5,
  /** Trên mức này thì rủi ro nghiệp vụ buộc về tay người. */
  riskToHuman: 0.5,
  /** Hội thoại dài hơn ngần này tin khách thì ngữ cảnh bắt đầu khó. */
  longConversation: 6,
} as const;

/**
 * LUẬT CÓ TỰ TRẢ LỜI ĐƯỢC KHÔNG — con số đáng giá nhất của cả phép mô phỏng.
 *
 * Mỗi lượt trả lời được bằng luật là một lượt KHÔNG tốn token và KHÔNG có cơ hội bịa. Nên đây
 * không phải một phép tối ưu chi phí, nó là một phép giảm rủi ro mà tiết kiệm được tiền.
 *
 * Điều kiện CỐ Ý CHẶT: luật phải tự tin, KHÔNG có ý định rủi ro, và không có ảnh. Thà bỏ sót một
 * lượt đáng lẽ rẻ được còn hơn tuyên một lượt là "luật xử được" trong khi nó cần đọc hiểu — con
 * số này sẽ được dùng để quyết định có cắt bớt lượt gọi mô hình hay không, và một con số lạc quan
 * ở đây dẫn thẳng tới những câu trả lời máy móc gửi cho khách thật.
 */
export function isRuleOnlyEligible(input: RouterSimInput): boolean {
  if (input.hasImage) return false;
  if (input.humanTakeover) return false;
  if (input.intents.some((i) => (RISK_INTENTS_TO_HUMAN as readonly string[]).includes(i))) return false;
  return input.ruleConfidence !== null && input.ruleConfidence >= SIM_THRESHOLDS.ruleConfident;
}

/** ĐỘ KHÓ — thuần về "hiểu câu này khó tới đâu", không mang một chút rủi ro nghiệp vụ nào. */
export function complexityOf(input: RouterSimInput): number {
  let d = 0;
  // Luật không kết luận được là dấu hiệu khó mạnh nhất có thật.
  if (input.ruleConfidence === null) d += 0.4;
  else if (input.ruleConfidence < SIM_THRESHOLDS.ruleConfident) d += 0.25;
  // Chưa nối được về mã hàng ⇒ phải đọc hiểu để đoán khách đang hỏi mẫu nào.
  if (!input.hasProduct) d += 0.2;
  // Hội thoại dài: ngữ cảnh nhiều, dễ mất trạng thái.
  if (input.customerTurns > SIM_THRESHOLDS.longConversation) d += 0.15;
  // Nhiều ý định trong một câu.
  if (input.intents.length > 1) d += 0.1;
  // Ảnh thì không có đường nào rẻ: chỉ mô hình có mắt mới đọc được.
  if (input.hasImage) d += 0.4;
  return Math.min(1, Number(d.toFixed(2)));
}

/** RỦI RO NGHIỆP VỤ — hậu quả nếu máy trả lời sai, không phải độ khó của câu. */
export function businessRiskOf(input: RouterSimInput): number {
  let r = 0;
  if (input.intents.some((i) => (RISK_INTENTS_TO_HUMAN as readonly string[]).includes(i))) r += 0.6;
  // Dây chuyền thật đã kết luận chuyển người: đó là một phiếu bầu có thật, không phải suy đoán.
  if (input.handoffReason) r += 0.3;
  // Đã có tiền trên bàn mà chưa chốt được mẫu mã: sai một chữ là giao nhầm hàng.
  if (input.quotedTotal !== null && !input.hasVariant) r += 0.3;
  if (input.humanTakeover) r += 0.5;
  return Math.min(1, Number(r.toFixed(2)));
}

/**
 * Chọn đường cho MỘT lượt. Thứ tự các nhánh chính là thứ tự ưu tiên, và nó có ý nghĩa:
 *
 *   1. NGƯỜI trước tiên — rủi ro cao thì không có nấc mô hình nào đúng cả.
 *   2. LUẬT trước mô hình — rẻ nhất và không bịa được.
 *   3. ẢNH trước các nhánh còn lại — không có mắt thì mọi nấc đều vô dụng.
 *   4. Rồi mới tới KHÓ / THƯỜNG.
 *
 * `challenger` chỉ đổi nhà cung cấp trong CÙNG một nấc, không bao giờ đổi nấc. Nó là tham số của
 * mẻ đối chứng ngầm; đặt nó ở đây để mô phỏng đếm được cả hai kịch bản mà không phải viết hai hàm.
 */
export function simulateRoute(input: RouterSimInput, opts: { challenger?: boolean } = {}): RouterSimResult {
  const complexity = complexityOf(input);
  const businessRisk = businessRiskOf(input);
  const ruleOnlyEligible = isRuleOnlyEligible(input);

  if (businessRisk >= SIM_THRESHOLDS.riskToHuman) {
    return {
      lane: "HUMAN",
      why: input.humanTakeover
        ? "người đã vào cầm hội thoại"
        : `rủi ro nghiệp vụ ${businessRisk} ≥ ${SIM_THRESHOLDS.riskToHuman}${input.handoffReason ? ` · ${input.handoffReason}` : ""}`,
      ruleOnlyEligible,
      complexity,
      businessRisk,
    };
  }
  if (ruleOnlyEligible) {
    return { lane: "RULE_ONLY", why: `luật đã đủ tin (${input.ruleConfidence})`, ruleOnlyEligible, complexity, businessRisk };
  }
  if (input.hasImage) {
    // Chỉ Gemini trong sổ đang khai đọc được ảnh, nên ảnh KHÔNG có đường đối chứng — cả hai kịch
    // bản đều đi cùng một chỗ, và bảng phân bổ phải nói ra điều đó thay vì giả vờ có lựa chọn.
    return { lane: "GEMINI_COMPLEX", why: "có ảnh — chỉ mô hình có mắt đọc được", ruleOnlyEligible, complexity, businessRisk };
  }
  if (complexity >= SIM_THRESHOLDS.complex) {
    return {
      lane: opts.challenger ? "GEMINI_COMPLEX" : "ANTHROPIC_COMPLEX",
      why: `độ khó ${complexity} ≥ ${SIM_THRESHOLDS.complex}`,
      ruleOnlyEligible,
      complexity,
      businessRisk,
    };
  }
  return {
    lane: opts.challenger ? "GEMINI_ROUTINE" : "OPENAI_ROUTINE",
    why: `việc thường (độ khó ${complexity})`,
    ruleOnlyEligible,
    complexity,
    businessRisk,
  };
}

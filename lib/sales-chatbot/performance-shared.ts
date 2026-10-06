/**
 * ═══════════ HIỆU QUẢ AI BÁN HÀNG — SỔ CHỈ SỐ + PHÉP TÍNH THUẦN (docs/productization/TARGET_ARCHITECTURE.md §5.2–5.4) ═══════════
 *
 * Chỉ số của SẢN PHẨM AI Sales đo HỘI THOẠI và ĐƠN của một tổ chức, không đo một con người — nên chúng KHÔNG nằm trong
 * `METRIC_CATALOG` (sổ đó chấm người / phòng ban: grain PERSON / DEPARTMENT, mã phòng ban bắt buộc). Sổ này giữ đúng kỷ luật
 * của sổ kia: mỗi chỉ số trả lời đủ câu hỏi (định nghĩa · grain · tử · mẫu · nguồn · ai làm · mẫu tối thiểu · chiều · đơn vị),
 * KHOÁ KHÔNG ĐỔI, và chỉ số chưa có nguồn khai `UNAVAILABLE` kèm thiếu ĐÚNG cái gì — không thay bằng truy vấn gần đúng.
 *
 * Ba luật đọc số (AI_SALES_PRODUCT_SPEC.md §7):
 *  · «AI bán được» = đơn GIAO THÀNH CÔNG theo `ORDER_OUTCOME`, không phải «bot chốt». Hai số in cạnh nhau, kèm độ phủ kết cục.
 *  · «AI tự làm» và «AI rồi chuyển người» là HAI cột, không cộng gộp — và cột sau KHÁC ĐIỀU KIỆN (hội thoại khó mới bị chuyển),
 *    nên nó thấp hơn không có nghĩa người làm kém (luật 39).
 *  · Chi phí AI chưa định giá ⇒ tổng là CẬN DƯỚI; «tiết kiệm nhân sự» chỉ có khi chủ shop KHAI chi phí người, luôn mang nhãn
 *    ước tính (luật 38: không có ngưỡng / đơn giá mặc định).
 */
export type AiSalesMetric = {
  key: string;
  label: string;
  definition: string;
  grain: "CONVERSATION" | "ORDER" | "REPLY";
  numerator: string | null;
  denominator: string;
  source: string;
  /** Ai làm ra con số: AI · HUMAN · MIXED (AI rồi người). */
  actor: "AI" | "HUMAN" | "MIXED";
  minimumSample: number;
  direction: "HIGHER_BETTER" | "LOWER_BETTER" | "CONTEXT";
  unit: "PERCENT" | "COUNT" | "VND" | "SECONDS" | "RATIO";
  availability: "MEASURED" | "UNAVAILABLE";
  missingWhat?: string;
};

/** Mẫu tối thiểu chung — dưới ngưỡng thì tỷ lệ / trung vị trả `null` (luật 63), không phải một con số nhỏ. */
export const AI_SALES_MIN_SAMPLE = 10;

export const AI_SALES_METRICS: readonly AiSalesMetric[] = [
  { key: "ai_sales.conversations", label: "Hội thoại có khách nhắn", definition: "Số hội thoại (fanpage / web / Messenger) có ít nhất một tin khách trong kỳ.", grain: "CONVERSATION", numerator: null, denominator: "hội thoại có `message.received` trong kỳ, trừ khung thử", source: "sales_conversation_events", actor: "MIXED", minimumSample: 1, direction: "CONTEXT", unit: "COUNT", availability: "MEASURED" },
  { key: "ai_sales.ai_resolution_rate", label: "AI tự chốt", definition: "Phần hội thoại đi tới đơn chốt mà không chuyển người.", grain: "CONVERSATION", numerator: "hội thoại có `order.confirmed` KHÔNG do người chốt và KHÔNG có người chạm vào (`handoff.requested` · `human.took_over` · `human.replied` · đơn do người lên / chốt — `events-sql.ts`)", denominator: "hội thoại có khách nhắn trong kỳ", source: "sales_conversation_events", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.handoff_rate", label: "Chuyển người", definition: "Phần hội thoại bot phải chuyển cho nhân viên (theo mã lý do).", grain: "CONVERSATION", numerator: "hội thoại có `handoff.requested` hoặc `human.took_over`", denominator: "hội thoại có khách nhắn trong kỳ", source: "sales_conversation_events (reason_code)", actor: "MIXED", minimumSample: AI_SALES_MIN_SAMPLE, direction: "CONTEXT", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.lead_capture_rate", label: "Khách để lại SĐT", definition: "Phần hội thoại khách để lại số điện thoại.", grain: "CONVERSATION", numerator: "hội thoại có `customer.identified`", denominator: "hội thoại có khách nhắn trong kỳ", source: "sales_conversation_events", actor: "MIXED", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.first_response_seconds", label: "Thời gian trả lời", definition: "Từ tin khách tới câu trả lời đầu tiên của bot trong lượt (trung vị, p90).", grain: "REPLY", numerator: null, denominator: "lượt `ai.replied` chế độ AI / câu mẫu trong kỳ", source: "sales_conversation_events.payload.responseMs", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "LOWER_BETTER", unit: "SECONDS", availability: "MEASURED" },
  { key: "ai_sales.upsell_attach_rate", label: "Nhận lời mời mua thêm", definition: "Phần lời mời upsell dẫn tới đơn nháp tăng giá trị trước khi chốt.", grain: "CONVERSATION", numerator: "lượt mua có `upsell.accepted`", denominator: "lượt mua có `upsell.offered`", source: "sales_conversation_events", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.upsell_revenue", label: "Tiền mua thêm nhờ upsell", definition: "Σ phần đơn nháp tăng sau lời mời (giá trị hàng, chưa ship).", grain: "ORDER", numerator: null, denominator: "`upsell.accepted.amount_vnd` trong kỳ", source: "sales_conversation_events", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.confirmed_orders", label: "Đơn bot chốt", definition: "Đơn THẬT bot chốt trong kỳ (không tính khung thử).", grain: "ORDER", numerator: null, denominator: "`order.confirmed` có mã đơn, KHÔNG do người chốt (đơn nhân viên tạo trong khung chat là đơn của người — `events-sql.ts`)", source: "sales_conversation_events + orders", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "COUNT", availability: "MEASURED" },
  { key: "ai_sales.delivered_revenue", label: "Doanh thu giao thành công từ đơn bot", definition: "Σ giá trị đơn bot chốt có kết cục DELIVERED và được ghi doanh thu khi giao.", grain: "ORDER", numerator: null, denominator: "đơn bot chốt trong kỳ, kết cục theo ORDER_OUTCOME", source: "orders ⨝ shipments · ORDER_OUTCOME · REVENUE_RECOGNIZED_ON_DELIVERY", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.ai_cost_per_delivered_order", label: "Chi phí AI / đơn giao thành công", definition: "Chi phí AI phần bán hàng (trừ khung thử, trừ ghi đơn hộ nhân viên) chia cho đơn bot chốt đã giao thành công.", grain: "ORDER", numerator: "Σ chi phí `platform_ai_usage` feature sales_chatbot (ước tính, quy ₫)", denominator: "đơn bot chốt trong kỳ có kết cục DELIVERED", source: "platform_ai_usage + ORDER_OUTCOME", actor: "AI", minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.order_sync_orders", label: "Đơn AI ghi hộ nhân viên", definition: "Đơn nhân viên chốt trên fanpage, AI đọc hội thoại và ghi vào ERP.", grain: "ORDER", numerator: null, denominator: "`order.drafted` actor HUMAN, via ORDER_SYNC", source: "sales_conversation_events", actor: "HUMAN", minimumSample: 1, direction: "CONTEXT", unit: "COUNT", availability: "MEASURED" },
  { key: "ai_sales.multi_product_rate", label: "Đơn bot chốt có ≥ 2 sản phẩm (bán chéo)", definition: "Phần đơn bot chốt mà khách mua từ hai sản phẩm khác nhau trở lên — khách tới vì một món mà về với món khác.", grain: "ORDER", numerator: "đơn có ≥ 2 mã sản phẩm khác nhau (trừ hàng tặng)", denominator: "đơn bot chốt trong kỳ (`order.confirmed`, origin AI_AGENT), trừ kết cục HUỶ", source: "sales_conversation_events + orders + order_items (is_bonus = false) · ORDER_OUTCOME", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.cross_sell_value_delivered", label: "Giá trị bán chéo đã giao", definition: "Σ giá trị dòng hàng của sản phẩm KHÁC sản phẩm chính (giá trị dòng lớn nhất) trên đơn bot chốt đã giao thành công. Giá trị dòng hàng, không phải tiền thực thu.", grain: "ORDER", numerator: null, denominator: "đơn bot chốt trong kỳ có ORDER_OUTCOME = DELIVERED (đơn chưa ngã ngũ không tính)", source: "order_items (giá × số lượng, is_bonus = false) · ORDER_OUTCOME", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.experiment_conversion_lift", label: "Chênh lệch ra đơn AI − người (thử nghiệm)", definition: "Tỷ lệ ra đơn / hội thoại của nhánh AI trừ nhánh người, hai nhánh chia NGẪU NHIÊN theo băm và ghim từ lượt đầu (ý định điều trị).", grain: "CONVERSATION", numerator: "đơn gắn với hội thoại của nhánh (orders.sales_conversation_id)", denominator: "hội thoại của nhánh CÓ đường ghi đơn — nhánh người chỉ đo được khi «AI ghi đơn hộ nhân viên» bật, tắt ⇒ chưa đo, không có chênh lệch", source: "sales_chat_conversations.state.experiment + orders · ORDER_OUTCOME", actor: "MIXED", minimumSample: AI_SALES_MIN_SAMPLE, direction: "CONTEXT", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.copilot_adoption_rate", label: "Gợi ý copilot được dùng", definition: "Phần gợi ý AI mà nhân viên gửi gần như nguyên văn hoặc sửa nhẹ (độ giống với câu thật của page ≥ ngưỡng EDITED).", grain: "REPLY", numerator: "gợi ý chấm SAME hoặc EDITED", denominator: "gợi ý đã chấm có câu thật của page (trừ NO_REPLY — không ai trả lời không phải là từ chối gợi ý)", source: "sales_copilot_suggestions (verdict, similarity)", actor: "MIXED", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.replay_price_ungrounded_rate", label: "Câu báo giá không có căn cứ (phát lại)", definition: "Khi phát lại hội thoại cũ ở kênh THỬ: phần câu trả lời có số tiền KHÔNG nằm trong tập căn cứ (giá bảng · số công cụ trả · phí ship đã khai · số shop đã nói). Là cờ để người đọc, không phải bằng chứng chắc chắn bịa giá.", grain: "REPLY", numerator: "điểm phát lại mang cờ PRICE_UNGROUNDED", denominator: "điểm phát lại bot trả lời được (trừ cờ ERROR)", source: "sales_replay_points.flags", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "LOWER_BETTER", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.ai_only_delivered_revenue", label: "Doanh thu AI tự bán (đã giao)", definition: "Đơn bot chốt mà không ai chạm vào lượt mua trước mốc chốt — doanh thu GIAO THÀNH CÔNG.", grain: "ORDER", numerator: null, denominator: "đơn có `order.confirmed` trong kỳ gắn hội thoại, nhãn AI_ONLY (`attributeOrder`), kết cục theo ORDER_OUTCOME", source: "sales_conversation_events · orders ⨝ shipments · ORDER_OUTCOME · REVENUE_RECOGNIZED_ON_DELIVERY", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.ai_assisted_delivered_revenue", label: "Doanh thu AI góp công (đã giao)", definition: "Đơn có người chạm vào VÀ AI đã báo giá / lên nháp / mời mua thêm / lấy được SĐT trước mốc lên đơn — doanh thu GIAO THÀNH CÔNG. Không cộng gộp với AI tự bán.", grain: "ORDER", numerator: null, denominator: "đơn nhãn AI_ASSISTED (`attributeOrder`)", source: "sales_conversation_events · ORDER_OUTCOME", actor: "MIXED", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.human_only_delivered_revenue", label: "Doanh thu người bán trong hội thoại (đã giao)", definition: "Đơn người lên / chốt trong hội thoại mà AI không góp việc bán hàng nào (gồm đơn AI ghi hộ nhân viên). Đơn ngoài hội thoại không thuộc phép này.", grain: "ORDER", numerator: null, denominator: "đơn nhãn HUMAN_ONLY (`attributeOrder`)", source: "sales_conversation_events · ORDER_OUTCOME", actor: "HUMAN", minimumSample: 1, direction: "CONTEXT", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.followup_reply_rate", label: "Khách trả lời sau lời nhắc", definition: "Phần hội thoại bot nhắc trong kỳ mà khách nhắn lại sau lần nhắc (cùng lượt mua).", grain: "CONVERSATION", numerator: "hội thoại có `message.received` sau `followup.sent` cùng lượt mua", denominator: "hội thoại có `followup.sent` trong kỳ", source: "sales_conversation_events", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.followup_recovered_revenue", label: "Doanh thu follow-up thu hồi (đã giao)", definition: "Đơn chốt SAU khi khách trả lời một lời nhắc của bot (cùng lượt mua) — doanh thu GIAO THÀNH CÔNG. Khách tự quay lại không qua lời nhắc thì không tính.", grain: "ORDER", numerator: null, denominator: "đơn có `order.confirmed` trong kỳ, mốc lên đơn sau tin trả lời lời nhắc (`followupRecovery`)", source: "sales_conversation_events · ORDER_OUTCOME", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.aov", label: "Giá trị đơn bot chốt trung bình", definition: "Σ giá trị đơn bot chốt ÷ số đơn bot chốt (giá trị đặt, chưa phải doanh thu).", grain: "ORDER", numerator: "Σ giá trị đơn bot chốt", denominator: "đơn bot chốt trong kỳ", source: "sales_conversation_events + orders", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.delivered_revenue_per_conversation", label: "Doanh thu đã giao / hội thoại", definition: "Doanh thu giao thành công từ đơn bot ÷ hội thoại có khách nhắn.", grain: "CONVERSATION", numerator: "doanh thu giao thành công từ đơn bot", denominator: "hội thoại có khách nhắn trong kỳ", source: "sales_conversation_events · ORDER_OUTCOME", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.ai_cost_per_conversation", label: "Chi phí AI / hội thoại", definition: "Chi phí AI phần bán hàng ÷ hội thoại có khách nhắn. Có lượt chưa định giá ⇒ cận dưới.", grain: "CONVERSATION", numerator: "chi phí AI bán hàng (platform_ai_usage)", denominator: "hội thoại có khách nhắn trong kỳ", source: "platform_ai_usage · sales_conversation_events", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "LOWER_BETTER", unit: "VND", availability: "MEASURED" },
  { key: "ai_sales.revenue_per_ai_cost", label: "Doanh thu đã giao ÷ chi phí AI", definition: "Mỗi đồng chi phí AI bán hàng đi cùng bao nhiêu đồng doanh thu giao thành công từ đơn bot. Chi phí 0 / chưa biết ⇒ trống.", grain: "ORDER", numerator: "doanh thu giao thành công từ đơn bot", denominator: "chi phí AI bán hàng", source: "platform_ai_usage · ORDER_OUTCOME", actor: "AI", minimumSample: 1, direction: "HIGHER_BETTER", unit: "RATIO", availability: "MEASURED" },
  { key: "ai_sales.lost_reason_share", label: "Vì sao khách không mua", definition: "Hội thoại ngã ngũ mà không có đơn, chia theo lý do: từ chối rõ (câu lý do xếp nhóm bằng từ khoá — `LOST_REASON_VERSION`), chuyển người mà ERP không thấy đơn, im lặng quá 24 giờ sau / trước báo giá (SUY RA).", grain: "CONVERSATION", numerator: "hội thoại không mua mang lý do X", denominator: "hội thoại có khách nhắn trong kỳ, không có đơn, đã ngã ngũ", source: "sales_conversation_events (`lostReasonOf`)", actor: "MIXED", minimumSample: 1, direction: "CONTEXT", unit: "PERCENT", availability: "MEASURED" },
  { key: "ai_sales.per_staff_conversion", label: "Ra đơn theo từng nhân viên", definition: "So AI với TỪNG nhân viên trên cùng loại hội thoại.", grain: "CONVERSATION", numerator: "hội thoại nhân viên X xử lý ra đơn", denominator: "hội thoại nhân viên X xử lý", source: "—", actor: "HUMAN", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "UNAVAILABLE", missingWhat: "Pancake không cho biết nhân viên NÀO gõ tin trên page (không gửi uid). Cần nhân viên trả lời từ hộp thư trong ERP để có users.id cho từng câu trả lời (MIGRATION_PLAN.md M8)." },
  { key: "ai_sales.objection_rate", label: "Phản đối theo loại", definition: "Khách chê giá / chê ship / chưa tin / để suy nghĩ — bao nhiêu, bot gỡ được bao nhiêu.", grain: "CONVERSATION", numerator: "hội thoại có phản đối loại X", denominator: "hội thoại có khách nhắn", source: "—", actor: "AI", minimumSample: AI_SALES_MIN_SAMPLE, direction: "CONTEXT", unit: "PERCENT", availability: "UNAVAILABLE", missingWhat: "Chưa có bộ phân loại phản đối: bot không ghi nhãn loại phản đối của khách. Cần sự kiện `objection.raised` có nhãn trước khi đo." },
  { key: "ai_sales.csat", label: "Khách hài lòng", definition: "Khách chấm điểm cuộc trò chuyện.", grain: "CONVERSATION", numerator: "lượt chấm tốt", denominator: "lượt chấm", source: "—", actor: "MIXED", minimumSample: AI_SALES_MIN_SAMPLE, direction: "HIGHER_BETTER", unit: "PERCENT", availability: "UNAVAILABLE", missingWhat: "Chưa hỏi khách chấm điểm ở cuối hội thoại — không có dữ liệu nào để đọc." },
];

/** Một hội thoại trong kỳ, gộp từ sổ sự kiện. */
export type ConversationFacts = { quoted: boolean; identified: boolean; drafted: boolean; confirmed: boolean; human: boolean; upsellOffered: boolean; upsellAccepted: boolean };

export type FunnelRow = { conversations: number; quoted: number; identified: number; drafted: number; confirmed: number };
export type CohortTable = { aiOnly: FunnelRow; aiThenHuman: FunnelRow; total: FunnelRow };

const emptyRow = (): FunnelRow => ({ conversations: 0, quoted: 0, identified: 0, drafted: 0, confirmed: 0 });

/** Phễu theo hai nhóm. Tổng hai nhóm = tổng (không hội thoại nào rơi ra ngoài). HÀM THUẦN. */
export function cohortTable(facts: readonly ConversationFacts[]): CohortTable {
  const t: CohortTable = { aiOnly: emptyRow(), aiThenHuman: emptyRow(), total: emptyRow() };
  for (const f of facts) {
    for (const row of [f.human ? t.aiThenHuman : t.aiOnly, t.total]) {
      row.conversations += 1;
      if (f.quoted) row.quoted += 1;
      if (f.identified) row.identified += 1;
      if (f.drafted) row.drafted += 1;
      if (f.confirmed) row.confirmed += 1;
    }
  }
  return t;
}

/** Tỷ lệ có mẫu tối thiểu: dưới ngưỡng ⇒ `null` (chưa đủ dữ liệu), không phải một phần trăm trông chính xác. HÀM THUẦN. */
export function rateOrNull(num: number, den: number, minSample: number = AI_SALES_MIN_SAMPLE): number | null {
  if (den < minSample || den <= 0) return null;
  return num / den;
}

/** Phân vị (nội suy tuyến tính như percentile_cont). Dưới mẫu tối thiểu ⇒ `null`. HÀM THUẦN. */
export function percentileOrNull(values: readonly number[], p: number, minSample: number = AI_SALES_MIN_SAMPLE): number | null {
  if (values.length < minSample || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Cấu hình chủ shop KHAI cho màn hiệu quả — settings `ai.salesPerformance`. Không có giá trị mặc định (luật 38). */
export const AI_SALES_PERFORMANCE_SETTING_KEY = "ai.salesPerformance";
export type AiSalesPerformanceSettings = { humanCostPerConversationVnd: number | null; setBy: string | null; reason: string | null; at: string | null };

export function parsePerformanceSettings(v: unknown): AiSalesPerformanceSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const cost = typeof o.humanCostPerConversationVnd === "number" && Number.isInteger(o.humanCostPerConversationVnd) && o.humanCostPerConversationVnd > 0 ? o.humanCostPerConversationVnd : null;
  return { humanCostPerConversationVnd: cost, setBy: typeof o.setBy === "string" ? o.setBy : null, reason: typeof o.reason === "string" ? o.reason : null, at: typeof o.at === "string" ? o.at : null };
}

/**
 * Tiết kiệm nhân sự ƯỚC TÍNH = hội thoại AI tự xử lý trọn × chi phí một hội thoại do người làm (chủ shop khai). Chưa khai ⇒
 * `null`. Không bao giờ gộp với doanh thu. HÀM THUẦN.
 */
export function estimatedStaffSaving(aiOnlyConversations: number, humanCostPerConversationVnd: number | null): number | null {
  if (humanCostPerConversationVnd === null) return null;
  return aiOnlyConversations * humanCostPerConversationVnd;
}


/**
 * Bốn chỉ số kinh tế của bot, TÍNH TỪ đúng các số màn «Hiệu quả» đã có — không đọc nguồn thứ hai:
 *  · `aovVnd` — giá trị trung bình một đơn bot chốt (giá trị đặt, chưa phải doanh thu). Chưa có đơn ⇒ `null`.
 *  · `deliveredRevenuePerConversationVnd` — doanh thu GIAO THÀNH CÔNG của đơn bot ÷ hội thoại có khách nhắn (mẫu tối thiểu).
 *  · `aiCostPerConversationVnd` — chi phí AI bán hàng ÷ hội thoại (mẫu tối thiểu). Có lượt chưa định giá ⇒ CẬN DƯỚI.
 *  · `revenuePerAiCost` — doanh thu giao thành công ÷ chi phí AI bán hàng. Chi phí `null` hoặc 0 ⇒ `null` (không chia cho 0).
 * HÀM THUẦN.
 */
export type SalesEconomics = { aovVnd: number | null; deliveredRevenuePerConversationVnd: number | null; aiCostPerConversationVnd: number | null; revenuePerAiCost: number | null; costIsLowerBound: boolean };

export function salesEconomics(input: { conversations: number; confirmedOrders: number; confirmedValueVnd: number; deliveredRevenueVnd: number; aiCostVnd: number | null; unknownCostTurns: number }): SalesEconomics {
  const enough = input.conversations >= AI_SALES_MIN_SAMPLE && input.conversations > 0;
  const cost = input.aiCostVnd;
  return {
    aovVnd: input.confirmedOrders > 0 ? Math.round(input.confirmedValueVnd / input.confirmedOrders) : null,
    deliveredRevenuePerConversationVnd: enough ? Math.round(input.deliveredRevenueVnd / input.conversations) : null,
    aiCostPerConversationVnd: enough && cost !== null ? Math.round(cost / input.conversations) : null,
    revenuePerAiCost: cost !== null && cost > 0 ? input.deliveredRevenueVnd / cost : null,
    costIsLowerBound: input.unknownCostTurns > 0,
  };
}

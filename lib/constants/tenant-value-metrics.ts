/**
 * ═══════════ SỔ CHỈ SỐ GIÁ TRỊ THEO TỔ CHỨC — TRUNG TÂM GIÁ TRỊ SAAS (docs/saas/VALUE_CENTER.md) — CLIENT-SAFE ═══════════
 *
 * Grain là TỔ CHỨC (một workspace khách), không phải người / phòng ban — nên sổ này nằm NGOÀI `METRIC_CATALOG` (giống
 * `AI_SALES_METRICS`), và giữ đúng kỷ luật của sổ kia (luật 37): mỗi khoá trả lời đủ câu hỏi (tử · mẫu · nguồn THẬT · mốc lọc ·
 * mẫu tối thiểu · chiều · đơn vị · ai được thấy), KHOÁ KHÔNG ĐỔI (ảnh chụp PR-3 lưu khoá trong `metrics` jsonb — đổi là làm mồ côi
 * lịch sử), chưa có nguồn thì `UNAVAILABLE` kèm thiếu ĐÚNG cái gì. V1 KHÔNG dùng đích, KHÔNG tô màu đạt / không đạt (luật 38 · 44).
 *
 * BỐN DÒNG TIỀN KHÁCH KHÔNG TRỘN (chủ shop chốt):
 *  · TIỀN ĐÃ THU (`customer_spend_cash`) — hoá đơn ĐÃ TRẢ + nạp Số dư AI. Có cả tiền trả trước.
 *  · DOANH THU GHI NHẬN (`customer_spend_recognized`) — MRR theo ngày + Số dư AI ĐÃ DÙNG (AI_USAGE CASH − đảo) + phần vượt.
 *  · SỐ DƯ AI — TOPUP là tiền trả trước (NỢ PHẢI TRẢ), PROMO không phải doanh thu, chỉ AI_USAGE dùng từ tiền thật là doanh thu.
 *  · GIÁ VỐN NHÀ CUNG CẤP (nhóm `COGS`) — chi phí AI nền tảng trả (ước tính theo bảng giá) + chi phí biến đổi khai.
 * BYOK là tiền khách tự trả nhà cung cấp — không vào cột nào.
 *
 * QUY KẾT ĐƠN: bốn nhãn CHÍNH loại trừ nhau — AI tự chốt (`AI_ONLY` của `attributeOrder`), AI góp công (`AI_ASSISTED`), người bán
 * (`HUMAN_ONLY`), CHƯA QUY KẾT (`null` — không phải người). Bốn số cộng = tổng đơn chốt trong kỳ. Thu hồi / upsell là THUỘC TÍNH
 * CHỒNG (`overlay: true`) — tập con, không bao giờ cộng vào tổng.
 *
 * «AI TÁC ĐỘNG» ≠ «CÔNG CỦA AI»: `ai_influenced_*` = tự chốt + góp công (không phải công); `ai_credited_*` = tự chốt + c × góp công,
 * c là quyết định D2 — chưa quyết thì c = null ⇒ chỉ tự chốt, góp công in riêng, giá trị mang cờ tạm.
 *
 * `customerVisible = false` cho MỌI khoá chạm giá vốn của nền tảng / model / token / biên / nhà cung cấp — báo cáo phía khách
 * (PR-7) lọc bằng `CUSTOMER_KEYS`, không lọc ở từng trang.
 */
import { CUSTOMER_HEALTH_THRESHOLDS } from "@/lib/constants/customer-health";
import { AI_SALES_MIN_SAMPLE } from "@/lib/sales-chatbot/performance-shared";

/** Phiên bản CÔNG THỨC của bộ ghép (`buildTenantValue`). Đổi công thức ⇒ tăng; hai ảnh chụp khác phiên bản không so được (luật 40). */
export const TENANT_VALUE_VERSION = 1;

export const TENANT_VALUE_WINDOWS = [7, 30, 90] as const;
export type TenantValueWindow = (typeof TENANT_VALUE_WINDOWS)[number];

export const TENANT_VALUE_GROUPS = ["SPEND", "COGS", "VALUE", "QUALITY", "HEALTH"] as const;
export type TenantValueGroup = (typeof TENANT_VALUE_GROUPS)[number];
export const TENANT_VALUE_GROUP_LABEL: Record<TenantValueGroup, string> = {
  SPEND: "Khách trả",
  COGS: "Giá vốn & biên nền tảng",
  VALUE: "Giá trị khách nhận",
  QUALITY: "Chất lượng AI",
  HEALTH: "Sức khoẻ & rủi ro",
};

export type TenantValueAvailability = "MEASURED" | "ESTIMATED" | "UNAVAILABLE";
/** Mốc lọc của ô (luật 58) — mỗi ô in mốc của nó. */
export type TenantValuePeriodBasis = "ORDER_CONFIRMED_AT" | "AI_CALL_AT" | "RECOGNIZED_DAY" | "CASH_AT" | "LEDGER_AT" | "CONVERSATION_AT" | "SNAPSHOT_AT";
export type TenantValueUnit = "VND" | "COUNT" | "PERCENT" | "RATIO" | "MS" | "HOURS" | "LEVEL";
export type TenantValueDirection = "HIGHER_BETTER" | "LOWER_BETTER" | "CONTEXT";

export const TENANT_VALUE_DECISION_IDS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12"] as const;
export type TenantValueDecisionId = (typeof TENANT_VALUE_DECISION_IDS)[number];

export type TenantValueMetric = {
  key: string;
  label: string;
  group: TenantValueGroup;
  numerator: string | null;
  denominator: string | null;
  /** Bảng / cột / hàm CÓ THẬT. Khoá UNAVAILABLE ghi «—». */
  source: string;
  periodBasis: TenantValuePeriodBasis;
  availability: TenantValueAvailability;
  /** Bắt buộc khi UNAVAILABLE — thiếu ĐÚNG cái gì, tới mức sửa được. */
  missingWhat: string | null;
  /** Dưới ngưỡng ⇒ `null` (luật 63), không phải một con số nhỏ. 1 = chỉ cần mẫu số > 0. */
  minimumSample: number;
  direction: TenantValueDirection;
  unit: TenantValueUnit;
  customerVisible: boolean;
  /** Mã quyết định của chủ shop mà ô này đang chạy theo MẶC ĐỊNH TẠM (`TENANT_VALUE_DEFAULT_DECISIONS`). */
  decision: TenantValueDecisionId | null;
  /** Thuộc tính chồng (tập con của bốn nhãn) — không bao giờ cộng vào tổng. */
  overlay?: boolean;
};

const MIN = AI_SALES_MIN_SAMPLE;

export const TENANT_VALUE_METRICS = [
  // ─────────────────────────── KHÁCH TRẢ (bốn dòng tiền không trộn) ───────────────────────────
  { key: "customer_spend_recognized", label: "Khách trả — doanh thu ghi nhận", group: "SPEND", numerator: "MRR theo ngày + Số dư AI đã dùng (tiền thật) + phần vượt đã lập", denominator: null, source: "platform_saas_daily.mrr_vnd × 12 / 365 mỗi ngày · platform_ai_ledger_entries AI_USAGE CASH − đảo (aiBalanceRevenueVnd) · dòng vượt của bảng kê (platform_billing_statements)", periodBasis: "RECOGNIZED_DAY", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "VND", customerVisible: true, decision: "D1" },
  { key: "customer_spend_cash", label: "Khách trả — tiền đã thu", group: "SPEND", numerator: "hoá đơn ĐÃ TRẢ theo ngày trả + nạp Số dư AI (tiền trả trước)", denominator: null, source: "platform_invoices.paid_amount_vnd theo paid_at (status PAID) · platform_ai_ledger_entries TOPUP CASH theo occurred_at", periodBasis: "CASH_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "VND", customerVisible: true, decision: "D1" },
  { key: "saas_subscription_revenue", label: "Thuê bao ghi nhận theo ngày", group: "SPEND", numerator: "Σ mrr_vnd × 12 / 365 của từng ngày trong cửa sổ (ngày vắng = CHƯA CHỤP, không phải 0)", denominator: null, source: "platform_saas_daily.mrr_vnd (gồm add-on — không cộng thêm hoá đơn ADDON)", periodBasis: "RECOGNIZED_DAY", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "VND", customerVisible: true, decision: null },
  { key: "ai_balance_revenue", label: "Số dư AI đã dùng (doanh thu)", group: "SPEND", numerator: "AI_USAGE quỹ CASH − đảo khoản", denominator: null, source: "platform_ai_ledger_entries (entry_type AI_USAGE, funds_class CASH) · aiBalanceRevenueVnd (lib/billing/ai-balance-rules.ts)", periodBasis: "LEDGER_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "VND", customerVisible: true, decision: null },
  { key: "ai_overage_billed", label: "Phần vượt đã lập", group: "SPEND", numerator: "dòng vượt của bảng kê (khách không trả trước)", denominator: null, source: "platform_billing_statements (dòng OVERAGE) — theo tháng lịch", periodBasis: "RECOGNIZED_DAY", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "VND", customerVisible: true, decision: null },
  { key: "ai_balance_topup_cash", label: "Nạp Số dư AI (trả trước — nợ phải trả)", group: "SPEND", numerator: "TOPUP quỹ CASH", denominator: null, source: "platform_ai_ledger_entries (entry_type TOPUP, funds_class CASH)", periodBasis: "LEDGER_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "VND", customerVisible: true, decision: null },
  { key: "ai_balance_promo_used", label: "Số dư khuyến mãi đã dùng (không phải doanh thu)", group: "SPEND", numerator: "AI_USAGE quỹ PROMO (giá trị tuyệt đối)", denominator: null, source: "platform_ai_ledger_entries (entry_type AI_USAGE, funds_class PROMO)", periodBasis: "LEDGER_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "VND", customerVisible: true, decision: null },

  // ─────────────────────────── GIÁ VỐN & BIÊN NỀN TẢNG (KHÔNG BAO GIỜ TỚI KHÁCH) ───────────────────────────
  { key: "actual_ai_cogs", label: "Chi phí AI nền tảng trả (ước tính)", group: "COGS", numerator: "Σ cost_usd × tỷ giá, billing_source PLATFORM, trừ BLOCKED_QUOTA", denominator: null, source: "platform_ai_usage.cost_usd (bảng giá trong mã lib/ai/provider.ts) — chưa đối chiếu hoá đơn nhà cung cấp", periodBasis: "AI_CALL_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: "D11" },
  { key: "ai_selling_cogs", label: "Chi phí AI phần bán hàng", group: "COGS", numerator: "chi phí AI feature bán hàng (trừ khung thử, trừ ghi đơn hộ)", denominator: null, source: "platform_ai_usage qua loadAiSalesPerformance().cost.sellingVnd", periodBasis: "AI_CALL_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "ai_order_sync_cogs", label: "Chi phí AI ghi đơn hộ nhân viên", group: "COGS", numerator: "chi phí lượt ref order-sync:", denominator: null, source: "platform_ai_usage qua loadAiSalesPerformance().cost.orderSyncVnd", periodBasis: "AI_CALL_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "ai_vision_cogs", label: "Chi phí AI đọc ảnh", group: "COGS", numerator: "chi phí lượt modality VISION (dòng modality NULL = chưa biết)", denominator: null, source: "platform_ai_usage.modality = 'VISION'", periodBasis: "AI_CALL_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "ai_unpriced_calls", label: "Lượt AI chưa định giá", group: "COGS", numerator: "lượt PLATFORM chưa có giá (chi phí là cận dưới khi > 0)", denominator: null, source: "platform_ai_usage (cost_usd chưa định giá)", periodBasis: "AI_CALL_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "COUNT", customerVisible: false, decision: null },
  { key: "other_variable_cogs", label: "Chi phí biến đổi khác đã khai", group: "COGS", numerator: "khoản khai DIRECT hạng mục EXTERNAL_API · MESSAGING", denominator: null, source: "platform_cost_entries (category, allocation_basis DIRECT)", periodBasis: "RECOGNIZED_DAY", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "payment_fee_cogs", label: "Phí thanh toán", group: "COGS", numerator: null, denominator: null, source: "—", periodBasis: "CASH_AT", availability: "UNAVAILABLE", missingWhat: "platform_billing_payments không có cột phí; SePay / ngân hàng không trả phí trên từng giao dịch. Cần chủ shop khai % hoặc 0 có căn cứ (D6), rồi một hạng mục PAYMENT_FEE ở platform_cost_entries.", minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: "D6" },
  { key: "infra_allocated_cogs", label: "Hạ tầng / hỗ trợ phân bổ", group: "COGS", numerator: null, denominator: null, source: "—", periodBasis: "RECOGNIZED_DAY", availability: "UNAVAILABLE", missingWhat: "Spec 11 §6: chưa có căn cứ phân bổ (CPU / dung lượng CSDL theo tổ chức chưa đo) — V1 in ở cấp nền tảng. Mâu thuẫn với lib/saas/allocation.ts (EQUAL_ACTIVE_WORKSPACES) chờ D10.", minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: "D10" },
  { key: "variable_cogs_known", label: "Giá vốn biến đổi đã biết", group: "COGS", numerator: "chi phí AI + biến đổi khác + phí thanh toán — phần CÓ SỐ (cận dưới khi còn phần chưa biết)", denominator: null, source: "actual_ai_cogs + other_variable_cogs + payment_fee_cogs", periodBasis: "AI_CALL_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: "D6" },
  { key: "platform_contribution", label: "Đóng góp sau chi phí AI", group: "COGS", numerator: "khách trả (D1) − chi phí AI nền tảng trả — spec 11 §6 «biên đóng góp theo tổ chức»; chưa trừ phí thanh toán, chưa phân bổ hạ tầng", denominator: null, source: "customerEconomicsCore (lib/saas/policy.ts) không phân bổ", periodBasis: "RECOGNIZED_DAY", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: false, decision: "D1" },
  { key: "platform_gross_profit", label: "Lãi gộp nền tảng trên khách", group: "COGS", numerator: "khách trả (D1) − MỌI giá vốn biến đổi — chỉ khi mọi thành phần đã biết", denominator: null, source: "customerEconomicsCore (lib/saas/policy.ts) — cùng nhánh null", periodBasis: "RECOGNIZED_DAY", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: false, decision: "D6" },
  { key: "platform_gross_profit_ceiling", label: "Lãi gộp nền tảng — cận trên", group: "COGS", numerator: "khách trả − giá vốn ĐÃ BIẾT (giá vốn chỉ có thể lớn thêm)", denominator: null, source: "customerEconomicsCore (lib/saas/policy.ts)", periodBasis: "RECOGNIZED_DAY", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "platform_gross_margin", label: "Biên gộp nền tảng", group: "COGS", numerator: "lãi gộp nền tảng", denominator: "khách trả (D1)", source: "customerEconomicsCore.marginPct", periodBasis: "RECOGNIZED_DAY", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "PERCENT", customerVisible: false, decision: "D6" },
  { key: "cost_per_conversation", label: "Chi phí AI / hội thoại", group: "COGS", numerator: "chi phí AI phần bán hàng", denominator: "hội thoại có khách nhắn", source: "loadAiSalesPerformance().economics.aiCostPerConversationVnd", periodBasis: "CONVERSATION_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: MIN, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "cost_per_qualified_lead", label: "Chi phí AI / lead đủ điều kiện", group: "COGS", numerator: "chi phí AI phần bán hàng", denominator: "hội thoại khách để lại SĐT (D7 — tầng `identified` của phễu)", source: "loadAiSalesPerformance().cohorts.total.identified", periodBasis: "CONVERSATION_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: MIN, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: "D7" },
  { key: "cost_per_order", label: "Chi phí AI / đơn AI tác động", group: "COGS", numerator: "chi phí AI phần bán hàng", denominator: "đơn AI tự chốt + AI góp công", source: "loadAiSalesPerformance().cost.sellingVnd ÷ quy kết đơn", periodBasis: "ORDER_CONFIRMED_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "cost_per_recovered_order", label: "Chi phí AI / đơn thu hồi", group: "COGS", numerator: "chi phí AI phần bán hàng", denominator: "đơn follow-up thu hồi", source: "loadOrderAttribution().followup.recoveredOrders", periodBasis: "ORDER_CONFIRMED_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "VND", customerVisible: false, decision: null },
  { key: "revenue_per_ai_cost", label: "Doanh thu quy cho AI ÷ chi phí AI", group: "COGS", numerator: "doanh thu đã giao quy cho AI (ai_credited_delivered_revenue)", denominator: "chi phí AI phần bán hàng", source: "quy kết đơn · platform_ai_usage", periodBasis: "ORDER_CONFIRMED_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "RATIO", customerVisible: false, decision: "D2" },
  { key: "gross_profit_per_ai_cost", label: "Lãi gộp quy cho AI ÷ chi phí AI", group: "COGS", numerator: "lãi gộp đã giao quy cho AI (ai_credited_gross_profit)", denominator: "chi phí AI phần bán hàng", source: "quy kết đơn · orderCogsFast · platform_ai_usage", periodBasis: "ORDER_CONFIRMED_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "RATIO", customerVisible: false, decision: "D3" },

  // ─────────────────────────── GIÁ TRỊ KHÁCH NHẬN ───────────────────────────
  { key: "ai_auto_closed_orders", label: "Đơn AI tự chốt", group: "VALUE", numerator: "đơn nhãn AI_ONLY", denominator: null, source: "attributeOrder (lib/sales-chatbot/attribution-shared.ts) · sales_conversation_events order.confirmed trong kỳ", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "COUNT", customerVisible: true, decision: null },
  { key: "ai_assisted_orders", label: "Đơn AI góp công", group: "VALUE", numerator: "đơn nhãn AI_ASSISTED", denominator: null, source: "attributeOrder", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "COUNT", customerVisible: true, decision: null },
  { key: "human_only_orders", label: "Đơn người bán (trong hội thoại)", group: "VALUE", numerator: "đơn nhãn HUMAN_ONLY (gồm đơn AI ghi hộ)", denominator: null, source: "attributeOrder", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "COUNT", customerVisible: true, decision: null },
  { key: "unattributed_orders", label: "Đơn chưa quy kết", group: "VALUE", numerator: "đơn chốt trong kỳ mà attributeOrder trả null — CHƯA BIẾT, không phải người", denominator: null, source: "loadOrderAttribution().table.unattributed", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "COUNT", customerVisible: true, decision: null },
  { key: "attributed_orders_total", label: "Tổng đơn chốt trong hội thoại", group: "VALUE", numerator: "tự chốt + góp công + người bán + chưa quy kết", denominator: null, source: "loadOrderAttribution().table", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "COUNT", customerVisible: true, decision: null },
  { key: "ai_influenced_orders", label: "Đơn AI tác động (không phải công)", group: "VALUE", numerator: "tự chốt + góp công", denominator: null, source: "attributeOrder", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "COUNT", customerVisible: true, decision: null },
  { key: "ai_recovered_orders", label: "Đơn follow-up thu hồi", group: "VALUE", numerator: "đơn chốt sau khi khách trả lời lời nhắc của bot (cùng lượt mua)", denominator: null, source: "followupRecovery (attribution-shared.ts) · loadOrderAttribution().followup", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "COUNT", customerVisible: true, decision: null, overlay: true },
  { key: "ai_upsell_orders", label: "Đơn có upsell được nhận", group: "VALUE", numerator: null, denominator: null, source: "—", periodBasis: "ORDER_CONFIRMED_AT", availability: "UNAVAILABLE", missingWhat: "Chưa có thuộc tính chồng upsell ở mức ĐƠN: cần đếm đơn có `upsell.accepted` cùng lượt mua trước mốc chốt (sales_conversation_events.order_id) — PR-2 (`upsellOverlay` trong attribution-shared.ts).", minimumSample: 1, direction: "HIGHER_BETTER", unit: "COUNT", customerVisible: true, decision: null, overlay: true },
  { key: "ai_auto_closed_delivered_revenue", label: "Doanh thu AI tự chốt (đã giao)", group: "VALUE", numerator: "AI_ONLY · ORDER_OUTCOME = DELIVERED · doanh thu ghi nhận khi giao", denominator: null, source: "loadOrderAttribution (ORDER_OUTCOME · REVENUE_RECOGNIZED_ON_DELIVERY) — danh nghĩa, chưa phải tiền đã xác minh", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: null },
  { key: "ai_assisted_delivered_revenue", label: "Doanh thu AI góp công (đã giao)", group: "VALUE", numerator: "AI_ASSISTED · ORDER_OUTCOME = DELIVERED", denominator: null, source: "loadOrderAttribution", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: null },
  { key: "ai_influenced_delivered_revenue", label: "Doanh thu AI tác động (đã giao — không phải công)", group: "VALUE", numerator: "tự chốt + góp công, đã giao", denominator: null, source: "loadOrderAttribution · cùng số với VALUE_KPI revenue_attributed_to_ai (lib/pricing/value-kpis.ts)", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: null },
  { key: "ai_credited_delivered_revenue", label: "Doanh thu quy công cho AI (đã giao)", group: "VALUE", numerator: "tự chốt + c × góp công (c = D2; chưa quyết ⇒ chỉ tự chốt, góp công in riêng)", denominator: null, source: "loadOrderAttribution", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: "D2" },
  { key: "ai_recovered_delivered_revenue", label: "Doanh thu thu hồi (đã giao)", group: "VALUE", numerator: "đơn thu hồi · ORDER_OUTCOME = DELIVERED (tập con — không cộng thêm)", denominator: null, source: "loadOrderAttribution().followup.recoveredDeliveredRevenueVnd", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: null, overlay: true },
  { key: "incremental_upsell_revenue_delivered", label: "Doanh thu upsell (đã giao)", group: "VALUE", numerator: null, denominator: null, source: "—", periodBasis: "ORDER_CONFIRMED_AT", availability: "UNAVAILABLE", missingWhat: "Σ `upsell.accepted.amount_vnd` CHỈ của đơn ORDER_OUTCOME = DELIVERED — hiện `performance.ts` cộng mọi lời nhận kể cả đơn huỷ / hoàn; cần thuộc tính chồng upsell ở mức đơn (PR-2).", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: null, overlay: true },
  { key: "ai_credited_gross_profit", label: "Lãi gộp quy công cho AI (đã giao)", group: "VALUE", numerator: "lãi gộp tự chốt + c × góp công, CHỈ trên đơn biết giá vốn", denominator: null, source: "loadOrderAttribution (orderCogsFast · cogsUnknown đứng riêng)", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: "D3" },
  { key: "ai_credited_cogs_coverage", label: "Độ phủ giá vốn (phần quy công cho AI)", group: "VALUE", numerator: "doanh thu đã giao CÓ giá vốn", denominator: "doanh thu đã giao", source: "AttributionRow.costedRevenueVnd ÷ deliveredRevenueVnd", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "PERCENT", customerVisible: true, decision: "D3" },
  { key: "orders_pending", label: "Đơn bot chốt chưa ngã ngũ", group: "VALUE", numerator: "đơn bot chốt chưa có kết cục (độ chín của cửa sổ)", denominator: null, source: "loadAiSalesPerformance().orders.pending (ORDER_OUTCOME)", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "COUNT", customerVisible: true, decision: null },
  { key: "staff_hours_saved", label: "Giờ công tiết kiệm (ước tính)", group: "VALUE", numerator: "hội thoại AI tự xử lý trọn × phút người / hội thoại ÷ 60", denominator: null, source: "loadAiSalesPerformance().cohorts.aiOnly.conversations × phút khai (D5)", periodBasis: "CONVERSATION_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "HOURS", customerVisible: true, decision: "D5" },
  { key: "staff_cost_saved", label: "Tiết kiệm nhân sự (ước tính)", group: "VALUE", numerator: "hội thoại AI tự xử lý trọn × chi phí người / hội thoại (tổ chức khai)", denominator: null, source: "estimatedStaffSaving (performance-shared.ts) · settings ai.salesPerformance của tổ chức", periodBasis: "CONVERSATION_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: "D4" },
  { key: "customer_value_multiple", label: "Bội số giá trị (giá trị khách nhận ÷ khách trả)", group: "VALUE", numerator: "lãi gộp quy công cho AI (D4)", denominator: "khách trả (D1)", source: "ai_credited_gross_profit ÷ customer_spend_*", periodBasis: "ORDER_CONFIRMED_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: MIN, direction: "HIGHER_BETTER", unit: "RATIO", customerVisible: true, decision: "D4" },
  { key: "customer_roi", label: "ROI của khách", group: "VALUE", numerator: "giá trị khách nhận − khách trả", denominator: "khách trả (D1)", source: "(ai_credited_gross_profit − customer_spend_*) ÷ customer_spend_*", periodBasis: "ORDER_CONFIRMED_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: MIN, direction: "HIGHER_BETTER", unit: "RATIO", customerVisible: true, decision: "D4" },
  { key: "ai_incremental_profit", label: "Lợi nhuận TĂNG THÊM do AI", group: "VALUE", numerator: null, denominator: null, source: "—", periodBasis: "ORDER_CONFIRMED_AT", availability: "UNAVAILABLE", missingWhat: "Cần nhóm đối chứng: «doanh thu AI tác động» không phải lợi nhuận tăng thêm — phải so với nhánh người chia ngẫu nhiên cùng cửa sổ (sales_chat_conversations.state.experiment, `ai_sales.experiment_conversion_lift`) đủ mẫu, trừ giá vốn hàng và chi phí AI.", minimumSample: MIN, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: null },
  { key: "post_optimization_delta", label: "Cải thiện sau tối ưu", group: "VALUE", numerator: null, denominator: null, source: "—", periodBasis: "SNAPSHOT_AT", availability: "UNAVAILABLE", missingWhat: "Đo bằng so hai ảnh chụp CÙNG cửa sổ và CÙNG formula_version (snapshotsComparable) trước / sau một khuyến nghị — cần bảng ảnh chụp (PR-3) và sổ khuyến nghị platform_optimization_recommendations (PR-6).", minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: false, decision: null },

  // ─────────────────────────── CHẤT LƯỢNG (đứng cạnh mọi chỉ số chi phí) ───────────────────────────
  { key: "conversations", label: "Hội thoại có khách nhắn", group: "QUALITY", numerator: null, denominator: "hội thoại có message.received trong kỳ, trừ khung thử", source: "loadAiSalesPerformance().cohorts.total.conversations", periodBasis: "CONVERSATION_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "COUNT", customerVisible: true, decision: null },
  { key: "conversion_rate", label: "Tỷ lệ chốt", group: "QUALITY", numerator: "hội thoại có order.confirmed", denominator: "hội thoại có khách nhắn", source: "phễu Hiệu quả AI — cùng công thức VALUE_KPI conversion_rate", periodBasis: "CONVERSATION_AT", availability: "MEASURED", missingWhat: null, minimumSample: MIN, direction: "HIGHER_BETTER", unit: "PERCENT", customerVisible: true, decision: null },
  { key: "qualified_leads", label: "Lead đủ điều kiện", group: "QUALITY", numerator: "hội thoại khách để lại SĐT (D7)", denominator: null, source: "loadAiSalesPerformance().cohorts.total.identified (customer.identified)", periodBasis: "CONVERSATION_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "COUNT", customerVisible: true, decision: "D7" },
  { key: "lead_capture_rate", label: "Khách để lại SĐT", group: "QUALITY", numerator: "hội thoại có customer.identified", denominator: "hội thoại có khách nhắn", source: "loadAiSalesPerformance().rates.leadCapture", periodBasis: "CONVERSATION_AT", availability: "MEASURED", missingWhat: null, minimumSample: MIN, direction: "HIGHER_BETTER", unit: "PERCENT", customerVisible: true, decision: "D7" },
  { key: "aov", label: "Giá trị đơn bot chốt trung bình", group: "QUALITY", numerator: "Σ giá trị đơn bot chốt", denominator: "đơn bot chốt (giá trị đặt, chưa phải doanh thu)", source: "loadAiSalesPerformance().economics.aovVnd", periodBasis: "ORDER_CONFIRMED_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "HIGHER_BETTER", unit: "VND", customerVisible: true, decision: null },
  { key: "human_intervention_rate", label: "Tỷ lệ người can thiệp", group: "QUALITY", numerator: "hội thoại AI rồi người", denominator: "hội thoại có khách nhắn", source: "loadAiSalesPerformance().rates.handoff", periodBasis: "CONVERSATION_AT", availability: "MEASURED", missingWhat: null, minimumSample: MIN, direction: "CONTEXT", unit: "PERCENT", customerVisible: true, decision: null },
  { key: "response_p50_ms", label: "Thời gian trả lời (trung vị)", group: "QUALITY", numerator: null, denominator: "lượt ai.replied có responseMs (tin khách → câu trả lời, gồm công cụ)", source: "loadAiSalesPerformance().response.medianMs", periodBasis: "CONVERSATION_AT", availability: "MEASURED", missingWhat: null, minimumSample: MIN, direction: "LOWER_BETTER", unit: "MS", customerVisible: true, decision: null },
  { key: "response_p90_ms", label: "Thời gian trả lời (p90)", group: "QUALITY", numerator: null, denominator: "lượt ai.replied có responseMs", source: "loadAiSalesPerformance().response.p90Ms", periodBasis: "CONVERSATION_AT", availability: "MEASURED", missingWhat: null, minimumSample: MIN, direction: "LOWER_BETTER", unit: "MS", customerVisible: true, decision: null },
  { key: "model_latency_p50_ms", label: "Độ trễ lời gọi model (trung vị)", group: "QUALITY", numerator: null, denominator: "lượt platform_ai_usage có latency_ms (từ 0232; trước đó = chưa đo)", source: "platform_ai_usage.latency_ms", periodBasis: "AI_CALL_AT", availability: "MEASURED", missingWhat: null, minimumSample: MIN, direction: "LOWER_BETTER", unit: "MS", customerVisible: false, decision: null },
  { key: "ai_error_rate", label: "Tỷ lệ lượt AI lỗi", group: "QUALITY", numerator: "lượt ERROR", denominator: "tổng lượt AI", source: "platform_ai_usage.status (lớp lỗi 0237)", periodBasis: "AI_CALL_AT", availability: "MEASURED", missingWhat: null, minimumSample: CUSTOMER_HEALTH_THRESHOLDS.aiErrorRateMinSample, direction: "LOWER_BETTER", unit: "PERCENT", customerVisible: false, decision: null },

  // ─────────────────────────── SỨC KHOẺ & RỦI RO (mức + mã lý do, KHÔNG điểm /100 — D9) ───────────────────────────
  { key: "health_level", label: "Mức sức khoẻ", group: "HEALTH", numerator: null, denominator: null, source: "healthOf (lib/saas/tenant-health-rules.ts) trên classifyCustomer (lib/saas/customer-health.ts)", periodBasis: "SNAPSHOT_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "LEVEL", customerVisible: false, decision: "D9" },
  { key: "churn_risk", label: "Rủi ro rời bỏ", group: "HEALTH", numerator: null, denominator: null, source: "churnRiskOf (lib/saas/tenant-health-rules.ts) · bảng ánh xạ CHURN_RISK_RULES (lib/constants/churn-risk.ts)", periodBasis: "SNAPSHOT_AT", availability: "ESTIMATED", missingWhat: null, minimumSample: 1, direction: "LOWER_BETTER", unit: "LEVEL", customerVisible: false, decision: "D8" },
  { key: "top_issue", label: "Vấn đề lớn nhất hôm nay", group: "HEALTH", numerator: null, denominator: null, source: "topIssueOf (lib/saas/tenant-health-rules.ts)", periodBasis: "SNAPSHOT_AT", availability: "MEASURED", missingWhat: null, minimumSample: 1, direction: "CONTEXT", unit: "LEVEL", customerVisible: false, decision: null },
] as const satisfies readonly TenantValueMetric[];

export type TenantValueKey = (typeof TENANT_VALUE_METRICS)[number]["key"];
/** Khoá có SỐ (mọi nhóm trừ HEALTH — HEALTH là mức + mã lý do, do `healthOf` / `churnRiskOf` dựng). */
export type TenantValueNumericKey = Exclude<(typeof TENANT_VALUE_METRICS)[number], { group: "HEALTH" }>["key"];

export const TENANT_VALUE_METRIC_BY_KEY: Record<TenantValueKey, TenantValueMetric> = Object.fromEntries(TENANT_VALUE_METRICS.map((m) => [m.key, m])) as Record<TenantValueKey, TenantValueMetric>;

/** Người vận hành nền tảng thấy mọi khoá. */
export const OPERATOR_KEYS: readonly TenantValueKey[] = TENANT_VALUE_METRICS.map((m) => m.key);
/** Báo cáo phía khách (PR-7) chỉ được in những khoá này — DẪN XUẤT từ `customerVisible`, không phải danh sách thứ hai. */
export const CUSTOMER_KEYS: readonly TenantValueKey[] = TENANT_VALUE_METRICS.filter((m) => m.customerVisible).map((m) => m.key);

// ─────────────────────────── QUYẾT ĐỊNH CỦA CHỦ SHOP — MẶC ĐỊNH TẠM ───────────────────────────

export type TenantValueDecisions = {
  /** D1 — cơ sở «khách trả» cho biên / bội số. */
  spendBasis: "RECOGNIZED" | "CASH";
  /** D2 — phần công của AI trong đơn AI góp công (0..1). `null` = chưa quyết ⇒ chỉ tự chốt, góp công in riêng. */
  assistedCredit: number | null;
  /** D3 — độ phủ giá vốn tối thiểu (0..1) để in lãi gộp quy cho AI dùng cho bội số / tỷ số. */
  cogsCoverageMin: number;
  /** D4 — tử số giá trị khách nhận. */
  valueNumerator: "CREDITED_GROSS_PROFIT" | "CREDITED_GROSS_PROFIT_PLUS_STAFF";
  /** D5 — phút người cho một hội thoại. `null` ⇒ giờ công tiết kiệm không tính. */
  minutesPerConversation: number | null;
  /** D6 — phí thanh toán. `UNAVAILABLE` ⇒ không đoán, lãi gộp nền tảng `null` + cận trên. */
  paymentFee: "UNAVAILABLE" | "DECLARED";
  /** D7 — định nghĩa lead đủ điều kiện. */
  qualifiedLead: "PHONE_LEFT";
  /** D8 — mức giảm dùng (tỷ lệ so cửa sổ trước) coi là «giảm sử dụng», và mẫu tối thiểu của cửa sổ trước. */
  churnUsageDropRatio: number;
  churnUsageMinSample: number;
  /** D9 — điểm /100: KHÔNG. */
  healthScore: false;
  /** D10 — phân bổ hạ tầng / hỗ trợ về tổ chức. */
  infraAllocation: "NONE";
  /** D11 — nguồn tỷ giá USD→VND của chi phí AI (in ra nhãn). */
  fxSource: "ENV_FACEBOOK_USD_VND";
  /** D12 — cửa sổ mặc định; bội số dùng cửa sổ dài vì đơn cần chín. */
  defaultWindowDays: TenantValueWindow;
  multipleWindowDays: TenantValueWindow;
};

export type TenantValueImpact = "HIGH" | "MEDIUM" | "LOW";
export const TENANT_VALUE_IMPACT_LABEL: Record<TenantValueImpact, string> = { HIGH: "CAO", MEDIUM: "TB", LOW: "THẤP" };

export type TenantValueDecisionSpec = {
  question: string;
  /** Mặc định tạm đang chạy, một câu. */
  defaultLabel: string;
  value: Partial<TenantValueDecisions>;
  provisional: true;
  impact: TenantValueImpact;
  /** Hạn cần chủ shop quyết (YYYY-MM-DD, giờ VN). */
  decideBy: string;
  ifChanged: string;
};

export const TENANT_VALUE_DEFAULT_DECISIONS = {
  D1: { question: "«Khách trả» cho biên / bội số tính theo doanh thu ghi nhận hay tiền về?", defaultLabel: "Ghi nhận (MRR theo ngày + Số dư đã dùng + vượt); tiền về in cạnh", value: { spendBasis: "RECOGNIZED" }, provisional: true, impact: "HIGH", decideBy: "2026-10-13", ifChanged: "Chọn tiền về: biên / bội số nhảy theo ngày khách trả (tháng trả năm cao vọt, tháng sau ≈ 0); tăng TENANT_VALUE_VERSION." },
  D2: { question: "AI được bao nhiêu phần công trong đơn AI góp công?", defaultLabel: "c = null — chỉ tính AI tự chốt, góp công in riêng không cộng", value: { assistedCredit: null }, provisional: true, impact: "HIGH", decideBy: "2026-10-13", ifChanged: "Đặt c (0..1): doanh thu / lãi gộp quy công và bội số tăng theo c × góp công; ảnh chụp cũ khác phiên bản, không vẽ xu hướng qua mốc đổi." },
  D3: { question: "Thiếu giá vốn thì lãi gộp quy cho AI xử lý sao?", defaultLabel: "Để riêng; độ phủ giá vốn ≥ 80% mới in lãi gộp cho bội số / tỷ số", value: { cogsCoverageMin: 0.8 }, provisional: true, impact: "HIGH", decideBy: "2026-10-13", ifChanged: "Hạ ngưỡng: nhiều khách có bội số hơn nhưng lãi gộp thiếu phần lớn hơn; ước tính bằng biên khai thì phải gắn nhãn ESTIMATED và thêm nguồn khai." },
  D4: { question: "Tử số «giá trị kinh tế khách nhận» là gì?", defaultLabel: "Lãi gộp quy công cho AI; tiết kiệm nhân sự in RIÊNG, không cộng", value: { valueNumerator: "CREDITED_GROSS_PROFIT" }, provisional: true, impact: "HIGH", decideBy: "2026-10-13", ifChanged: "Cộng tiết kiệm nhân sự: bội số chỉ có ở tổ chức đã khai chi phí người; tổ chức chưa khai ⇒ bội số null." },
  D5: { question: "Giờ công tiết kiệm tính bằng bao nhiêu phút người cho một hội thoại?", defaultLabel: "Không mặc định nền tảng — null ⇒ giờ công tiết kiệm chưa tính; tổ chức tự khai sau", value: { minutesPerConversation: null }, provisional: true, impact: "MEDIUM", decideBy: "2026-10-20", ifChanged: "Đặt mặc định nền tảng: mọi tổ chức có số giờ, nhưng là ước tính chung, không phải số của shop đó." },
  D6: { question: "Phí thanh toán (SePay / chuyển khoản) là bao nhiêu?", defaultLabel: "UNAVAILABLE — không đoán; lãi gộp nền tảng null, in cận trên", value: { paymentFee: "UNAVAILABLE" }, provisional: true, impact: "MEDIUM", decideBy: "2026-10-20", ifChanged: "Khai % hoặc 0 có căn cứ: lãi gộp nền tảng có số cho mọi khách đã định giá đủ chi phí AI." },
  D7: { question: "«Lead đủ điều kiện» là gì?", defaultLabel: "Hội thoại khách đã để lại SĐT (tầng `identified` của phễu sẵn có)", value: { qualifiedLead: "PHONE_LEFT" }, provisional: true, impact: "MEDIUM", decideBy: "2026-10-20", ifChanged: "SĐT + địa chỉ / đã báo giá: số lead giảm, chi phí / lead tăng; cần cột phễu mới." },
  D8: { question: "Ngưỡng rủi ro rời bỏ?", defaultLabel: "Bảng ánh xạ mã → mức (CHURN_RISK_RULES); giảm sử dụng = giảm ≥ 50% hội thoại so cửa sổ trước, cửa sổ trước ≥ mẫu tối thiểu", value: { churnUsageDropRatio: 0.5, churnUsageMinSample: AI_SALES_MIN_SAMPLE }, provisional: true, impact: "MEDIUM", decideBy: "2026-10-20", ifChanged: "Đổi ngưỡng / ánh xạ: tăng CHURN_RULE_VERSION; mức rủi ro hai bên mốc đổi không so trực tiếp." },
  D9: { question: "Có chấm điểm sức khoẻ /100 không?", defaultLabel: "KHÔNG — mức + mã lý do (spec 11 §7)", value: { healthScore: false }, provisional: true, impact: "LOW", decideBy: "2026-10-31", ifChanged: "Cho phép điểm: chỉ khi có trọng số chủ shop khai và độ phủ in cạnh (tinh thần luật 27); ≥ 10 tổ chức đã rời mới kiểm chứng được." },
  D10: { question: "Phân bổ hạ tầng / hỗ trợ về từng tổ chức?", defaultLabel: "Không phân bổ trong V1 (spec 11 §6) — in ở cấp nền tảng", value: { infraAllocation: "NONE" }, provisional: true, impact: "MEDIUM", decideBy: "2026-10-31", ifChanged: "Chọn chia đều / theo AI: phải sửa cùng lúc lib/saas/allocation.ts hoặc spec, không để hai màn nói hai biên." },
  D11: { question: "Tỷ giá USD→VND cho chi phí AI?", defaultLabel: "Đọc nguồn sẵn có (env FACEBOOK_USD_VND) và in nhãn nguồn; đề xuất setting nền tảng riêng", value: { fxSource: "ENV_FACEBOOK_USD_VND" }, provisional: true, impact: "LOW", decideBy: "2026-10-31", ifChanged: "Khai tỷ giá riêng: chi phí AI quy ₫ đổi theo tỷ giá mới — đổi NGUỒN, ghi vào formula_version." },
  D12: { question: "Cửa sổ mặc định trên trang?", defaultLabel: "30 ngày; bội số dùng 90 ngày (đơn cần chín)", value: { defaultWindowDays: 30, multipleWindowDays: 90 }, provisional: true, impact: "LOW", decideBy: "2026-10-31", ifChanged: "Cửa sổ ngắn: số chưa chín nhiều hơn (đơn chưa ngã ngũ), bội số dao động." },
} as const satisfies Record<TenantValueDecisionId, TenantValueDecisionSpec>;

/** Giá trị đang chạy của mọi quyết định — GHÉP từ bảng trên (không gõ lại số ở chỗ khác). */
export const DEFAULT_TENANT_VALUE_DECISIONS: TenantValueDecisions = Object.assign({}, ...TENANT_VALUE_DECISION_IDS.map((id) => TENANT_VALUE_DEFAULT_DECISIONS[id].value)) as TenantValueDecisions;

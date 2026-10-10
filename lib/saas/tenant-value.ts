/**
 * ═══════════ GHÉP GIÁ TRỊ THEO TỔ CHỨC — HÀM THUẦN (docs/saas/VALUE_CENTER.md §3) ═══════════
 *
 * `buildTenantValue` KHÔNG đọc / ghi CSDL, không đọc đồng hồ: chạy hai lần trên cùng đầu vào ra một kết quả. Đầu vào là ĐÚNG đầu ra
 * của các bộ đọc đã có — lượt chụp (PR-3) chỉ việc chuyển sang:
 *  · `attribution` = `loadOrderAttribution({ days })` (lib/sales-chatbot/attribution.ts) — quy kết đơn, kết cục qua ORDER_OUTCOME,
 *    giá vốn qua `orderCogsFast`, đơn chưa có giá vốn đứng riêng. Không viết lại điều kiện kết cục ở đây.
 *  · `perf` = `loadAiSalesPerformance(code, { days, withMoney: true })` (lib/sales-chatbot/performance.ts) — phễu, phản hồi, chuyển
 *    người, chi phí AI phần bán hàng, `economics` (salesEconomics), tiết kiệm nhân sự (estimatedStaffSaving).
 *  · `spend` / `cogs` / `aiCalls` = sổ CSDL nhà (platform_saas_daily · platform_ai_ledger_entries · platform_invoices ·
 *    platform_ai_usage · platform_cost_entries), một lượt cho mọi tổ chức.
 *
 * Công thức DÙNG LẠI, không chép: lãi gộp nền tảng = `customerEconomicsCore` (lib/saas/policy.ts — cùng nhánh null: chi phí còn
 * khoản chưa biết ⇒ `null`); tỷ lệ có mẫu tối thiểu = `rateOrNull`; ô chất lượng chép THẲNG từ bộ đọc hiệu quả. Số «doanh thu AI
 * tác động» bằng đúng `revenue_attributed_to_ai` của 8 KPI giá trị (lib/pricing/value-kpis.ts) — bài kiểm khoá hai số bằng nhau.
 *
 * Mọi ô `null` là CHƯA BIẾT (luật 42), `state = NOT_APPLICABLE` là KHÔNG ÁP DỤNG (in N/A) — hai thứ khác nhau.
 * Ô PERCENT lưu dạng tỷ lệ 0..1.
 */
import { ATTRIBUTION_VERSION, type AttributionRow } from "@/lib/sales-chatbot/attribution-shared";
import type { OrderAttributionReport } from "@/lib/sales-chatbot/attribution";
import type { AiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { rateOrNull } from "@/lib/sales-chatbot/performance-shared";
import { customerEconomicsCore } from "@/lib/saas/policy";
import {
  DEFAULT_TENANT_VALUE_DECISIONS,
  TENANT_VALUE_DECISION_IDS,
  TENANT_VALUE_DEFAULT_DECISIONS,
  TENANT_VALUE_METRICS,
  TENANT_VALUE_METRIC_BY_KEY,
  TENANT_VALUE_VERSION,
  type TenantValueAvailability,
  type TenantValueDecisionId,
  type TenantValueDecisions,
  type TenantValueNumericKey,
  type TenantValueWindow,
} from "@/lib/constants/tenant-value-metrics";

// ─────────────────────────── Đầu vào ───────────────────────────

/** Khách trả trong cửa sổ — CSDL nhà. Mỗi ô `null` = nguồn chưa đọc được / chưa biết. */
export type TenantSpendInput = {
  /** Σ mrr_vnd × 12 / 365 của những ngày ĐÃ chụp trong cửa sổ. */
  mrrAccrualVnd: number | null;
  /** Số ngày trong cửa sổ chưa có dòng `platform_saas_daily` — > 0 ⇒ thuê bao ghi nhận là CẬN DƯỚI. */
  mrrDaysMissing: number;
  /** `aiBalanceRevenueVnd` — AI_USAGE CASH − đảo khoản. */
  aiBalanceRevenueVnd: number | null;
  /** Dòng vượt của bảng kê (khách trả trước ⇒ 0 thật). */
  overageBilledVnd: number | null;
  /** Hoá đơn ĐÃ TRẢ theo `paid_at`. */
  cashInvoicesVnd: number | null;
  /** Nạp Số dư AI quỹ CASH — tiền trả trước (nợ phải trả). */
  cashTopupVnd: number | null;
  /** AI_USAGE quỹ PROMO (giá trị tuyệt đối) — không phải doanh thu. */
  promoUsedVnd: number | null;
};

/** Giá vốn nền tảng trong cửa sổ — CSDL nhà (đã quy ₫ theo tỷ giá `fx`). */
export type TenantCogsInput = {
  /** Σ chi phí AI billing_source PLATFORM (trừ BLOCKED_QUOTA) — mọi workload. */
  aiPlatformVnd: number | null;
  /** Lượt PLATFORM chưa định giá — > 0 ⇒ chi phí là CẬN DƯỚI. */
  aiUnpricedCalls: number;
  aiVisionVnd: number | null;
  /** Σ khoản khai DIRECT (EXTERNAL_API · MESSAGING); có khoản chưa biết số ⇒ `null`. Không khoản nào ⇒ 0. */
  otherVariableVnd: number | null;
  /** Chỉ dùng khi D6 = DECLARED. */
  paymentFeeVnd: number | null;
};

export type TenantPerfInput = Pick<AiSalesPerformance, "cohorts" | "rates" | "response" | "economics" | "cost" | "orders" | "human">;

export type TenantValueInput = {
  window: TenantValueWindow;
  /** `marginApplicable(billingMode)` (lib/saas/policy.ts) — chargeback nội bộ ⇒ biên / bội số N/A. */
  marginApplicable: boolean;
  /** Tỷ giá đã dùng để quy chi phí AI ra ₫ + NGUỒN của nó (D11) — chỉ để in nhãn. */
  fx: { rateVndPerUsd: number | null; source: string };
  spend: TenantSpendInput | null;
  cogs: TenantCogsInput | null;
  attribution: OrderAttributionReport | null;
  /** Đếm ĐỘC LẬP số đơn có `order.confirmed` trong kỳ — đối chiếu bất biến «bốn nhãn cộng = tổng». */
  confirmedOrdersInPeriod?: number | null;
  perf: TenantPerfInput | null;
  /** Lượt AI của tổ chức trong cửa sổ (platform_ai_usage). */
  aiCalls: { total: number; errors: number; modelLatencyP50Ms: number | null } | null;
  /** Quyết định chủ shop đã chốt — thiếu ⇒ MẶC ĐỊNH TẠM của `TENANT_VALUE_DEFAULT_DECISIONS`. */
  decisions?: Partial<TenantValueDecisions>;
};

// ─────────────────────────── Đầu ra ───────────────────────────

export type TenantMetricState = "VALUE" | "UNKNOWN" | "NOT_APPLICABLE";
/** `LOWER` = số thật có thể lớn hơn; `UPPER` = số thật có thể nhỏ hơn. */
export type TenantMetricBound = "EXACT" | "LOWER" | "UPPER";

export type TenantMetricValue = {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  availability: TenantValueAvailability;
  state: TenantMetricState;
  /** Ô đang chạy theo một quyết định CHƯA chốt (mặc định tạm). */
  provisional: boolean;
  bound: TenantMetricBound;
  coverage: number | null;
  note: string | null;
};

export type TenantValue = {
  window: TenantValueWindow;
  /** `tv<TENANT_VALUE_VERSION>.attr<ATTRIBUTION_VERSION>` — hai ảnh chụp khác chuỗi này không so được. */
  formulaVersion: string;
  fxSource: string;
  fxRateVndPerUsd: number | null;
  decisions: TenantValueDecisions;
  /** Quyết định đang chạy theo mặc định tạm (không có trong `input.decisions`). */
  provisionalDecisions: TenantValueDecisionId[];
  metrics: Record<TenantValueNumericKey, TenantMetricValue>;
  checks: {
    /** Bốn nhãn cộng = đếm độc lập. `null` = không có đếm độc lập để so. */
    attributionSumMatches: boolean | null;
  };
};

export function tenantValueFormulaVersion(): string {
  return `tv${TENANT_VALUE_VERSION}.attr${ATTRIBUTION_VERSION}`;
}

// ─────────────────────────── Tiện ích ───────────────────────────

const SOURCE_MISSING = "Nguồn chưa đọc được trong lượt chụp này — chưa biết, không phải 0.";

type CellOpts = Partial<Omit<TenantMetricValue, "availability" | "state">> & { state?: TenantMetricState; availability?: TenantValueAvailability };

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sumOrNull(...parts: (number | null | undefined)[]): number | null {
  let s = 0;
  for (const p of parts) {
    const v = finiteOrNull(p);
    if (v === null) return null;
    s += v;
  }
  return s;
}

function normalizeDecisions(over: Partial<TenantValueDecisions> | undefined): TenantValueDecisions {
  const d: TenantValueDecisions = { ...DEFAULT_TENANT_VALUE_DECISIONS, ...(over ?? {}) };
  // Giá trị ngoài miền ⇒ rơi về phía HẸP hơn: công góp công không hợp lệ = chưa quyết; ngưỡng độ phủ ngoài [0,1] = 1 (đòi đủ).
  const c = d.assistedCredit;
  if (c !== null && !(Number.isFinite(c) && c >= 0 && c <= 1)) d.assistedCredit = null;
  if (!(Number.isFinite(d.cogsCoverageMin) && d.cogsCoverageMin >= 0 && d.cogsCoverageMin <= 1)) d.cogsCoverageMin = 1;
  if (d.minutesPerConversation !== null && !(Number.isFinite(d.minutesPerConversation) && d.minutesPerConversation > 0)) d.minutesPerConversation = null;
  return d;
}

function provisionalOf(over: Partial<TenantValueDecisions> | undefined): TenantValueDecisionId[] {
  const given = new Set(Object.keys(over ?? {}));
  return TENANT_VALUE_DECISION_IDS.filter((id) => Object.keys(TENANT_VALUE_DEFAULT_DECISIONS[id].value).every((k) => !given.has(k)));
}

/** Một phần của dòng quy kết nhân hệ số (công góp công c). */
function scaled(row: AttributionRow, k: number) {
  return { deliveredRevenueVnd: row.deliveredRevenueVnd * k, grossProfitVnd: row.grossProfitVnd * k, costedRevenueVnd: row.costedRevenueVnd * k, delivered: k > 0 ? row.delivered : 0 };
}

// ─────────────────────────── Bộ ghép ───────────────────────────

export function buildTenantValue(input: TenantValueInput): TenantValue {
  const d = normalizeDecisions(input.decisions);
  const provisional = provisionalOf(input.decisions);
  const isProv = (...ids: TenantValueDecisionId[]) => ids.some((id) => provisional.includes(id));
  const metrics = {} as Record<TenantValueNumericKey, TenantMetricValue>;

  const set = (key: TenantValueNumericKey, o: CellOpts): void => {
    const spec = TENANT_VALUE_METRIC_BY_KEY[key];
    const declared = o.availability ?? spec.availability;
    if (declared === "UNAVAILABLE") {
      metrics[key] = { value: null, numerator: null, denominator: null, availability: "UNAVAILABLE", state: "UNKNOWN", provisional: false, bound: "EXACT", coverage: null, note: spec.missingWhat };
      return;
    }
    const value = finiteOrNull(o.value);
    const state: TenantMetricState = o.state === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : value === null ? "UNKNOWN" : "VALUE";
    metrics[key] = {
      value: state === "VALUE" ? value : null,
      numerator: finiteOrNull(o.numerator),
      denominator: finiteOrNull(o.denominator),
      availability: declared,
      state,
      provisional: o.provisional ?? (spec.decision !== null && provisional.includes(spec.decision)),
      bound: state === "VALUE" ? (o.bound ?? "EXACT") : "EXACT",
      coverage: finiteOrNull(o.coverage),
      note: o.note ?? (state === "UNKNOWN" && value === null ? SOURCE_MISSING : null),
    };
  };

  // ───── KHÁCH TRẢ ─────
  const sp = input.spend;
  const mrrLower = !!sp && sp.mrrDaysMissing > 0;
  const lowerNote = mrrLower ? `${sp?.mrrDaysMissing} ngày trong cửa sổ chưa có ảnh chụp MRR — cận dưới.` : null;
  set("saas_subscription_revenue", { value: sp?.mrrAccrualVnd ?? null, bound: mrrLower ? "LOWER" : "EXACT", note: lowerNote });
  set("ai_balance_revenue", { value: sp?.aiBalanceRevenueVnd ?? null });
  set("ai_overage_billed", { value: sp?.overageBilledVnd ?? null });
  set("ai_balance_topup_cash", { value: sp?.cashTopupVnd ?? null, note: "Tiền trả trước — nợ phải trả, chưa phải doanh thu." });
  set("ai_balance_promo_used", { value: sp?.promoUsedVnd ?? null, note: "Khuyến mãi — không phải doanh thu." });
  const recognized = sp ? sumOrNull(sp.mrrAccrualVnd, sp.aiBalanceRevenueVnd, sp.overageBilledVnd) : null;
  set("customer_spend_recognized", { value: recognized, bound: mrrLower ? "LOWER" : "EXACT", note: recognized === null ? (sp ? "Còn thành phần chưa biết (MRR / Số dư đã dùng / phần vượt) — không cộng phần thiếu bằng 0." : SOURCE_MISSING) : lowerNote });
  const cash = sp ? sumOrNull(sp.cashInvoicesVnd, sp.cashTopupVnd) : null;
  set("customer_spend_cash", { value: cash, note: cash === null ? undefined : "Gồm tiền nạp trả trước — dòng tiền, không phải doanh thu." });

  /** Khách trả dùng cho biên / bội số (D1) — chỉ khi ĐỦ (cận dưới không dùng để chia). */
  const spendBase: number | null = d.spendBasis === "CASH" ? cash : mrrLower ? null : recognized;
  const spendNote = spendBase === null ? (mrrLower && d.spendBasis === "RECOGNIZED" ? "Khách trả còn ngày chưa chụp (cận dưới) — không dùng để tính biên / bội số." : "Khách trả chưa biết.") : null;

  // ───── GIÁ VỐN & BIÊN NỀN TẢNG ─────
  const cg = input.cogs;
  const aiPlatform = cg?.aiPlatformVnd ?? null;
  const unpriced = cg?.aiUnpricedCalls ?? 0;
  const aiLower = unpriced > 0;
  set("actual_ai_cogs", { value: aiPlatform, bound: aiLower ? "LOWER" : "EXACT", note: aiLower ? `${unpriced} lượt chưa định giá — cận dưới.` : `Ước tính theo bảng giá trong mã · tỷ giá: ${input.fx.source}.` });
  set("ai_unpriced_calls", { value: cg ? unpriced : null });
  set("ai_vision_cogs", { value: cg?.aiVisionVnd ?? null });
  set("other_variable_cogs", { value: cg?.otherVariableVnd ?? null });
  const fee = d.paymentFee === "DECLARED" ? (cg?.paymentFeeVnd ?? null) : null;
  set("payment_fee_cogs", d.paymentFee === "DECLARED" ? { value: fee, availability: "MEASURED" } : {});
  const cost = input.perf?.cost ?? null;
  const selling = cost?.sellingVnd ?? null;
  const sellingLower = (cost?.unknownCost ?? 0) > 0;
  set("ai_selling_cogs", { value: selling, bound: sellingLower ? "LOWER" : "EXACT" });
  set("ai_order_sync_cogs", { value: cost?.orderSyncVnd ?? null });

  const otherKnown = cg?.otherVariableVnd ?? null;
  const variableLower = aiLower || otherKnown === null || fee === null;
  set("variable_cogs_known", {
    value: aiPlatform === null ? null : aiPlatform + (otherKnown ?? 0) + (fee ?? 0),
    bound: variableLower ? "LOWER" : "EXACT",
    note: variableLower && aiPlatform !== null ? "Còn khoản chưa biết (lượt AI chưa định giá / chi phí khác / phí thanh toán — D6) — cận dưới." : undefined,
  });

  const na = !input.marginApplicable;
  const naNote = "Khách nội bộ (chargeback) — không phải doanh thu thị trường, biên KHÔNG ÁP DỤNG.";
  if (aiPlatform === null) {
    for (const k of ["platform_contribution", "platform_gross_profit", "platform_gross_profit_ceiling", "platform_gross_margin"] as const) set(k, na ? { state: "NOT_APPLICABLE", note: naNote } : {});
  } else {
    const full = customerEconomicsCore({ revenueVnd: spendBase, aiCostVnd: aiPlatform, unpricedAiCalls: unpriced, allocated: [{ amountVnd: otherKnown }, { amountVnd: fee }] });
    const contrib = customerEconomicsCore({ revenueVnd: spendBase, aiCostVnd: aiPlatform, unpricedAiCalls: unpriced, allocated: [] });
    const ceiling = spendBase === null ? null : spendBase - full.costVnd;
    if (na) {
      for (const k of ["platform_contribution", "platform_gross_profit", "platform_gross_profit_ceiling", "platform_gross_margin"] as const) set(k, { state: "NOT_APPLICABLE", note: naNote });
    } else {
      set("platform_contribution", { value: contrib.grossProfitVnd, numerator: spendBase, denominator: aiPlatform, note: contrib.grossProfitVnd === null ? (spendNote ?? `${unpriced} lượt AI chưa định giá — chưa kết luận (số thật nhỏ hơn khách trả − chi phí đã biết).`) : "Chưa trừ phí thanh toán, chưa phân bổ hạ tầng (spec 11 §6)." });
      set("platform_gross_profit", { value: full.grossProfitVnd, numerator: spendBase, denominator: full.costVnd, note: full.grossProfitVnd === null ? (spendNote ?? "Chi phí còn khoản chưa biết — xem cận trên.") : undefined });
      set("platform_gross_profit_ceiling", { value: ceiling, bound: full.costComplete ? "EXACT" : "UPPER", note: spendNote ?? undefined });
      const marginNa = spendBase !== null && spendBase <= 0;
      set("platform_gross_margin", marginNa ? { state: "NOT_APPLICABLE", note: "Khách chưa trả tiền trong kỳ — biên không áp dụng." } : { value: full.marginPct === null ? null : full.marginPct / 100, numerator: full.grossProfitVnd, denominator: spendBase, note: full.marginPct === null ? (spendNote ?? "Lãi gộp chưa biết.") : undefined });
    }
  }

  // ───── GIÁ TRỊ KHÁCH NHẬN ─────
  const at = input.attribution;
  const t = at?.table ?? null;
  const fu = at?.followup ?? null;
  const c = d.assistedCredit;
  const auto = t?.AI_ONLY ?? null;
  const assisted = t?.AI_ASSISTED ?? null;
  set("ai_auto_closed_orders", { value: auto?.orders ?? null });
  set("ai_assisted_orders", { value: assisted?.orders ?? null });
  set("human_only_orders", { value: t?.HUMAN_ONLY.orders ?? null });
  set("unattributed_orders", { value: t?.unattributed ?? null, note: t ? "Chưa quy kết — CHƯA BIẾT, không phải người bán." : undefined });
  const total = t ? t.AI_ONLY.orders + t.AI_ASSISTED.orders + t.HUMAN_ONLY.orders + t.unattributed : null;
  const indep = input.confirmedOrdersInPeriod ?? null;
  const sumMatches = total === null || indep === null ? null : total === indep;
  set("attributed_orders_total", { value: total, note: sumMatches === false ? `Lệch với đếm độc lập (${indep} đơn chốt) — quy kết đang sót / thừa đơn.` : undefined });
  const influencedOrders = auto && assisted ? auto.orders + assisted.orders : null;
  set("ai_influenced_orders", { value: influencedOrders, note: "AI tác động — không phải công của AI." });
  set("ai_recovered_orders", { value: fu?.recoveredOrders ?? null, note: "Thuộc tính chồng — tập con của bốn nhãn, không cộng vào tổng." });
  set("ai_upsell_orders", {});
  set("incremental_upsell_revenue_delivered", {});

  set("ai_auto_closed_delivered_revenue", { value: auto?.deliveredRevenueVnd ?? null });
  set("ai_assisted_delivered_revenue", { value: assisted?.deliveredRevenueVnd ?? null });
  const influencedRevenue = auto && assisted ? auto.deliveredRevenueVnd + assisted.deliveredRevenueVnd : null;
  set("ai_influenced_delivered_revenue", { value: influencedRevenue, note: "AI tác động (tự chốt + góp công) — KHÔNG phải công của AI, không phải lợi nhuận tăng thêm." });
  const part = auto && assisted ? scaled(assisted, c ?? 0) : null;
  const creditedNote = c === null ? "Chỉ AI tự chốt — AI góp công in riêng, chưa cộng (D2 chưa quyết)." : `AI tự chốt + ${c} × AI góp công (D2).`;
  const creditedRevenue = auto && part ? Math.round(auto.deliveredRevenueVnd + part.deliveredRevenueVnd) : null;
  set("ai_credited_delivered_revenue", { value: creditedRevenue, note: creditedNote });
  set("ai_recovered_delivered_revenue", { value: fu?.recoveredDeliveredRevenueVnd ?? null, note: "Tập con của doanh thu quy kết — không cộng thêm." });

  const creditedDeliveredRevenue = auto && part ? auto.deliveredRevenueVnd + part.deliveredRevenueVnd : null;
  const creditedCosted = auto && part ? auto.costedRevenueVnd + part.costedRevenueVnd : null;
  const creditedGpRaw = auto && part ? auto.grossProfitVnd + part.grossProfitVnd : null;
  const creditedDeliveredOrders = auto && part ? auto.delivered + part.delivered : null;
  const coverage = creditedDeliveredRevenue !== null && creditedCosted !== null && creditedDeliveredRevenue > 0 ? creditedCosted / creditedDeliveredRevenue : null;
  set("ai_credited_cogs_coverage", { value: coverage, numerator: creditedCosted, denominator: creditedDeliveredRevenue, note: creditedDeliveredRevenue === 0 ? "Chưa có doanh thu đã giao trong phần quy công." : undefined });
  const coverageOk = coverage !== null && coverage >= d.cogsCoverageMin;
  const coverageNote = `Độ phủ giá vốn ${coverage === null ? "—" : `${Math.round(coverage * 1000) / 10}%`} dưới ngưỡng ${Math.round(d.cogsCoverageMin * 100)}% (D3) — không suy lợi nhuận.`;
  /** Lãi gộp quy công dùng được: không có doanh thu đã giao ⇒ 0 thật; có mà độ phủ dưới ngưỡng ⇒ chưa biết. */
  const creditedGp: number | null = creditedGpRaw === null ? null : creditedDeliveredRevenue === 0 ? 0 : coverageOk ? Math.round(creditedGpRaw) : null;
  set("ai_credited_gross_profit", {
    value: creditedGp,
    coverage,
    numerator: creditedCosted,
    denominator: creditedDeliveredRevenue,
    note: creditedGpRaw === null ? undefined : creditedGp === null ? coverageNote : `Trên phần đơn có giá vốn · ${creditedNote}`,
    provisional: isProv("D2", "D3"),
  });

  const pf = input.perf;
  set("orders_pending", { value: pf?.orders.pending ?? null });
  const aiOnlyConv = pf ? pf.cohorts.aiOnly.conversations : null;
  set("staff_hours_saved", {
    value: aiOnlyConv !== null && d.minutesPerConversation !== null ? Math.round((aiOnlyConv * d.minutesPerConversation) / 6) / 10 : null,
    numerator: aiOnlyConv,
    note: d.minutesPerConversation === null ? "Chưa có phút người / hội thoại (D5) — chưa tính, không phải 0 giờ." : undefined,
  });
  const staffCost = pf?.human ? pf.human.estimatedSavingVnd : null;
  set("staff_cost_saved", { value: staffCost, numerator: aiOnlyConv, note: staffCost === null ? "Tổ chức chưa khai chi phí người / hội thoại — chưa tính, không phải 0 ₫." : "Ước tính — in riêng, không cộng vào doanh thu (D4)." });

  // Bội số & ROI.
  const multipleProv = isProv("D1", "D2", "D3", "D4", "D12");
  let economicValue: number | null = null;
  let multipleBlock: CellOpts | null = null;
  if (na) multipleBlock = { state: "NOT_APPLICABLE", note: naNote };
  else if (input.window !== d.multipleWindowDays) multipleBlock = { state: "NOT_APPLICABLE", note: `Bội số chỉ tính ở cửa sổ ${d.multipleWindowDays} ngày (D12) — đơn cần chín.` };
  else if (spendBase === null) multipleBlock = { note: spendNote ?? "Khách trả chưa biết." };
  else if (spendBase <= 0) multipleBlock = { state: "NOT_APPLICABLE", note: "Khách chưa trả tiền trong kỳ — bội số không áp dụng." };
  else if (creditedDeliveredOrders === null) multipleBlock = { note: SOURCE_MISSING };
  else if (creditedDeliveredOrders < TENANT_VALUE_METRIC_BY_KEY.customer_value_multiple.minimumSample) multipleBlock = { note: `Mới ${creditedDeliveredOrders} đơn đã giao trong phần quy công — dưới mẫu tối thiểu ${TENANT_VALUE_METRIC_BY_KEY.customer_value_multiple.minimumSample}.` };
  else if (!coverageOk) multipleBlock = { note: coverageNote };
  else {
    economicValue = d.valueNumerator === "CREDITED_GROSS_PROFIT_PLUS_STAFF" ? sumOrNull(creditedGp, staffCost) : creditedGp;
    if (economicValue === null) multipleBlock = { note: "Tử số giá trị chưa biết (tiết kiệm nhân sự chưa khai — D4)." };
  }
  if (multipleBlock) {
    set("customer_value_multiple", { ...multipleBlock, provisional: multipleProv });
    set("customer_roi", { ...multipleBlock, provisional: multipleProv });
  } else if (economicValue !== null && spendBase !== null) {
    const note = `Ước tính · ${creditedNote} · khách trả theo ${d.spendBasis === "CASH" ? "tiền về" : "ghi nhận"} (D1).`;
    set("customer_value_multiple", { value: economicValue / spendBase, numerator: economicValue, denominator: spendBase, coverage, provisional: multipleProv, note });
    set("customer_roi", { value: (economicValue - spendBase) / spendBase, numerator: economicValue - spendBase, denominator: spendBase, coverage, provisional: multipleProv, note });
  }
  set("ai_incremental_profit", {});
  set("post_optimization_delta", {});

  // Chi phí trên đơn vị (cần cả chi phí bán hàng lẫn mẫu số).
  const perUnit = (key: TenantValueNumericKey, den: number | null) => {
    const min = TENANT_VALUE_METRIC_BY_KEY[key].minimumSample;
    const r = selling === null || den === null ? null : rateOrNull(selling, den, min);
    set(key, { value: r === null ? null : Math.round(r), numerator: selling, denominator: den, bound: sellingLower ? "LOWER" : "EXACT", note: r === null && selling !== null && den !== null ? `Mẫu số ${den} dưới ngưỡng ${min}.` : undefined });
  };
  set("cost_per_conversation", { value: pf?.economics.aiCostPerConversationVnd ?? null, numerator: selling, denominator: pf?.cohorts.total.conversations ?? null, bound: pf?.economics.costIsLowerBound ? "LOWER" : "EXACT" });
  perUnit("cost_per_qualified_lead", pf ? pf.cohorts.total.identified : null);
  perUnit("cost_per_order", influencedOrders);
  perUnit("cost_per_recovered_order", fu?.recoveredOrders ?? null);
  set("revenue_per_ai_cost", { value: creditedRevenue !== null && selling !== null && selling > 0 ? creditedRevenue / selling : null, numerator: creditedRevenue, denominator: selling, bound: sellingLower ? "UPPER" : "EXACT", provisional: isProv("D2") });
  set("gross_profit_per_ai_cost", { value: creditedGp !== null && selling !== null && selling > 0 ? creditedGp / selling : null, numerator: creditedGp, denominator: selling, bound: sellingLower ? "UPPER" : "EXACT", provisional: isProv("D2", "D3"), note: creditedGpRaw !== null && creditedGp === null ? coverageNote : undefined });

  // ───── CHẤT LƯỢNG (chép thẳng bộ đọc hiệu quả) ─────
  const funnel = pf?.cohorts.total ?? null;
  set("conversations", { value: funnel?.conversations ?? null });
  set("conversion_rate", { value: funnel ? rateOrNull(funnel.confirmed, funnel.conversations) : null, numerator: funnel?.confirmed ?? null, denominator: funnel?.conversations ?? null });
  set("qualified_leads", { value: funnel?.identified ?? null });
  set("lead_capture_rate", { value: pf?.rates.leadCapture ?? null, numerator: funnel?.identified ?? null, denominator: funnel?.conversations ?? null });
  set("aov", { value: pf?.economics.aovVnd ?? null });
  set("human_intervention_rate", { value: pf?.rates.handoff ?? null, numerator: pf?.cohorts.aiThenHuman.conversations ?? null, denominator: funnel?.conversations ?? null });
  set("response_p50_ms", { value: pf?.response.medianMs ?? null, denominator: pf?.response.samples ?? null });
  set("response_p90_ms", { value: pf?.response.p90Ms ?? null, denominator: pf?.response.samples ?? null });
  const calls = input.aiCalls;
  set("model_latency_p50_ms", { value: calls?.modelLatencyP50Ms ?? null });
  set("ai_error_rate", { value: calls ? rateOrNull(calls.errors, calls.total, TENANT_VALUE_METRIC_BY_KEY.ai_error_rate.minimumSample) : null, numerator: calls?.errors ?? null, denominator: calls?.total ?? null });

  // Lưới an toàn: mọi khoá có số của sổ đều có ô (bài kiểm cũng khoá điều này).
  for (const m of TENANT_VALUE_METRICS) if (m.group !== "HEALTH" && !(m.key in metrics)) set(m.key as TenantValueNumericKey, {});

  return {
    window: input.window,
    formulaVersion: tenantValueFormulaVersion(),
    fxSource: input.fx.source,
    fxRateVndPerUsd: finiteOrNull(input.fx.rateVndPerUsd),
    decisions: d,
    provisionalDecisions: provisional,
    metrics,
    checks: { attributionSumMatches: sumMatches },
  };
}

/**
 * Hai ảnh chụp có so được không (câu hỏi 8 — «sau tối ưu cải thiện bao nhiêu»): CÙNG cửa sổ và CÙNG phiên bản công thức. Khác ⇒
 * «không so được» kèm lý do, không vẽ mũi tên (luật 40). HÀM THUẦN.
 */
export function snapshotsComparable(a: Pick<TenantValue, "window" | "formulaVersion">, b: Pick<TenantValue, "window" | "formulaVersion">): { comparable: boolean; reason: string | null } {
  if (a.window !== b.window) return { comparable: false, reason: `Khác cửa sổ (${a.window} ngày vs ${b.window} ngày).` };
  if (a.formulaVersion !== b.formulaVersion) return { comparable: false, reason: `Khác phiên bản công thức (${a.formulaVersion} vs ${b.formulaVersion}).` };
  return { comparable: true, reason: null };
}

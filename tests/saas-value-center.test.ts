/**
 * ═══════════ TRUNG TÂM GIÁ TRỊ SAAS — PR-1: SỔ CHỈ SỐ + HÀM THUẦN (docs/saas/VALUE_CENTER.md) ═══════════
 *
 * THUẦN hoàn toàn: không CSDL, không đồng hồ, không biến môi trường (luật 50 · 65). Khoá:
 *  1. Sổ chỉ số: khoá BẤT BIẾN (ghim danh sách — ảnh chụp PR-3 lưu khoá), UNAVAILABLE có missingWhat, `CUSTOMER_KEYS` không chứa
 *     khoá giá vốn / biên / model, 12 quyết định đều tạm + có mức ảnh hưởng + hạn, mặc định đọc từ MỘT bảng.
 *  2. Bốn nhãn quy kết cộng = tổng; thu hồi / upsell là thuộc tính chồng, không vào tổng.
 *  3. «AI tác động» ≠ «công của AI»; c = null ⇒ công chỉ là AI tự chốt, góp công in riêng.
 *  4. null ≠ 0 ở mọi nhánh: khách trả thiếu, chi phí AI chưa định giá (lãi gộp null + cận trên), giá vốn hàng thiếu, mẫu dưới ngưỡng.
 *  5. marginApplicable = false ⇒ N/A; lãi gộp nền tảng cùng nhánh null với `customerEconomicsCore`.
 *  6. Sức khoẻ / rủi ro rời bỏ: thiếu tín hiệu ⇒ UNKNOWN, mỗi mức ≥ 1 mã, không điểm /100; vấn đề lớn nhất chọn mã nặng nhất.
 *  7. Bộ ghép khớp số với 8 KPI giá trị (lib/pricing/value-kpis.ts) — không trôi thành công thức thứ hai.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHURN_REASONS, CHURN_RISK_LEVELS, type ChurnReasonCode } from "@/lib/constants/churn-risk";
import {
  CUSTOMER_KEYS,
  DEFAULT_TENANT_VALUE_DECISIONS,
  OPERATOR_KEYS,
  TENANT_VALUE_DECISION_IDS,
  TENANT_VALUE_DEFAULT_DECISIONS,
  TENANT_VALUE_METRICS,
  TENANT_VALUE_METRIC_BY_KEY,
  type TenantValueNumericKey,
} from "@/lib/constants/tenant-value-metrics";
import { buildValueKpis } from "@/lib/pricing/value-kpis";
import type { AttributionRow, AttributionTable } from "@/lib/sales-chatbot/attribution-shared";
import type { OrderAttributionReport } from "@/lib/sales-chatbot/attribution";
import { customerEconomicsCore } from "@/lib/saas/policy";
import { baseHealthFrom, churnRiskOf, healthOf, topIssueOf, usageDropped, type BaseHealth } from "@/lib/saas/tenant-health-rules";
import { buildTenantValue, snapshotsComparable, type TenantPerfInput, type TenantSpendInput, type TenantCogsInput, type TenantValueInput } from "@/lib/saas/tenant-value";

const goc = path.resolve(__dirname, "..");
const boChuThich = (ma: string) => ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const docMa = (rel: string) => boChuThich(readFileSync(path.join(goc, rel), "utf8"));

// ─────────────────────────── Dữ liệu dựng ───────────────────────────

function row(p: Partial<AttributionRow> = {}): AttributionRow {
  return { orders: 0, valueVnd: 0, delivered: 0, deliveredRevenueVnd: 0, settled: 0, cancelled: 0, grossProfitVnd: 0, costedRevenueVnd: 0, cogsUnknown: 0, cogsUnknownRevenueVnd: 0, ...p };
}

/** AI tự chốt 12 đơn (10 giao, 5.000.000 ₫, giá vốn đủ 90% → lãi gộp 1.800.000), góp công 6 đơn (4 giao, 2.000.000 ₫), người 7, chưa quy kết 3. */
function attribution(over: { table?: Partial<AttributionTable>; recovered?: number; recoveredRevenue?: number } = {}): OrderAttributionReport {
  const table: AttributionTable = {
    AI_ONLY: row({ orders: 12, valueVnd: 6_000_000, delivered: 10, deliveredRevenueVnd: 5_000_000, costedRevenueVnd: 4_500_000, grossProfitVnd: 1_800_000, cogsUnknown: 1, cogsUnknownRevenueVnd: 500_000 }),
    AI_ASSISTED: row({ orders: 6, valueVnd: 2_400_000, delivered: 4, deliveredRevenueVnd: 2_000_000, costedRevenueVnd: 2_000_000, grossProfitVnd: 700_000 }),
    HUMAN_ONLY: row({ orders: 7, valueVnd: 3_000_000, delivered: 5, deliveredRevenueVnd: 2_500_000, costedRevenueVnd: 2_500_000, grossProfitVnd: 900_000 }),
    unattributed: 3,
    ...over.table,
  };
  return {
    table,
    followup: { conversations: 20, replied: 8, replyRate: 0.4, recoveredOrders: over.recovered ?? 2, recoveredValueVnd: 900_000, recoveredDelivered: 2, recoveredDeliveredRevenueVnd: over.recoveredRevenue ?? 800_000 },
  };
}

function perf(over: { conversations?: number; identified?: number; human?: number | null; sellingVnd?: number | null; unknownCost?: number } = {}): TenantPerfInput {
  const conversations = over.conversations ?? 120;
  const identified = over.identified ?? 40;
  const funnel = (n: number, i: number, c: number) => ({ conversations: n, quoted: Math.round(n / 2), identified: i, drafted: c, confirmed: c });
  const sellingVnd = over.sellingVnd === undefined ? 600_000 : over.sellingVnd;
  return {
    cohorts: { aiOnly: funnel(80, 25, 12), aiThenHuman: funnel(conversations - 80, identified - 25, 6), total: funnel(conversations, identified, 18) },
    rates: { aiResolution: 0.1, handoff: (conversations - 80) / conversations, leadCapture: identified / conversations },
    response: { medianMs: 2_400, p90Ms: 7_000, samples: 300 },
    economics: { aovVnd: 444_444, deliveredRevenuePerConversationVnd: 50_000, aiCostPerConversationVnd: sellingVnd === null ? null : Math.round(sellingVnd / conversations), revenuePerAiCost: null, costIsLowerBound: (over.unknownCost ?? 0) > 0 },
    cost: sellingVnd === null ? null : { sellingVnd, unknownCost: over.unknownCost ?? 0, turns: 900, orderSyncVnd: 50_000, testVnd: 0, perDeliveredOrderVnd: null, perConfirmedOrderVnd: null, rateVndPerUsd: 26_000 },
    orders: { confirmed: 18, confirmedValueVnd: 8_000_000, settled: 0, delivered: 14, deliveredRevenueVnd: 7_000_000, returned: 1, cancelled: 1, pending: 2, deliveryRate: null },
    human: over.human === null ? null : { humanCostPerConversationVnd: 5_000, setBy: "chu@shop", reason: "khai", at: "x", estimatedSavingVnd: over.human ?? 400_000 },
  };
}

const spend = (p: Partial<TenantSpendInput> = {}): TenantSpendInput => ({ mrrAccrualVnd: 900_000, mrrDaysMissing: 0, aiBalanceRevenueVnd: 100_000, overageBilledVnd: 0, cashInvoicesVnd: 1_000_000, cashTopupVnd: 200_000, promoUsedVnd: 30_000, ...p });
const cogs = (p: Partial<TenantCogsInput> = {}): TenantCogsInput => ({ aiPlatformVnd: 700_000, aiUnpricedCalls: 0, aiVisionVnd: 40_000, otherVariableVnd: 0, paymentFeeVnd: null, ...p });

function input(p: Partial<TenantValueInput> = {}): TenantValueInput {
  return {
    window: 90,
    marginApplicable: true,
    fx: { rateVndPerUsd: 26_000, source: "ENV_FACEBOOK_USD_VND" },
    spend: spend(),
    cogs: cogs(),
    attribution: attribution(),
    confirmedOrdersInPeriod: 28,
    perf: perf(),
    aiCalls: { total: 900, errors: 9, modelLatencyP50Ms: 1_800 },
    ...p,
  };
}

const ALL_NULL: TenantValueInput = { window: 30, marginApplicable: true, fx: { rateVndPerUsd: null, source: "ENV_FACEBOOK_USD_VND" }, spend: null, cogs: null, attribution: null, perf: null, aiCalls: null };

// ─────────────────────────── 1 · Sổ chỉ số ───────────────────────────

/** Ghim danh sách khoá: ĐỔI một khoá là làm mồ côi lịch sử ảnh chụp (luật 37). Thêm khoá mới thì thêm vào đây. */
const KHOA_GHIM = [
  "customer_spend_recognized", "customer_spend_cash", "saas_subscription_revenue", "ai_balance_revenue", "ai_overage_billed", "ai_balance_topup_cash", "ai_balance_promo_used",
  "actual_ai_cogs", "ai_selling_cogs", "ai_order_sync_cogs", "ai_vision_cogs", "ai_unpriced_calls", "other_variable_cogs", "payment_fee_cogs", "infra_allocated_cogs", "variable_cogs_known", "platform_contribution", "platform_gross_profit", "platform_gross_profit_ceiling", "platform_gross_margin", "cost_per_conversation", "cost_per_qualified_lead", "cost_per_order", "cost_per_recovered_order", "revenue_per_ai_cost", "gross_profit_per_ai_cost",
  "ai_auto_closed_orders", "ai_assisted_orders", "human_only_orders", "unattributed_orders", "attributed_orders_total", "ai_influenced_orders", "ai_recovered_orders", "ai_upsell_orders", "ai_auto_closed_delivered_revenue", "ai_assisted_delivered_revenue", "ai_influenced_delivered_revenue", "ai_credited_delivered_revenue", "ai_recovered_delivered_revenue", "incremental_upsell_revenue_delivered", "ai_credited_gross_profit", "ai_credited_cogs_coverage", "orders_pending", "staff_hours_saved", "staff_cost_saved", "customer_value_multiple", "customer_roi", "ai_incremental_profit", "post_optimization_delta",
  "conversations", "conversion_rate", "qualified_leads", "lead_capture_rate", "aov", "human_intervention_rate", "response_p50_ms", "response_p90_ms", "model_latency_p50_ms", "ai_error_rate",
  "health_level", "churn_risk", "top_issue",
];

/**
 * Khoá chạm giá vốn NỀN TẢNG (chi phí nhà cung cấp) / biên / model / token / lỗi nhà cung cấp — không bao giờ tới khách. Giá vốn HÀNG
 * của chính khách (lãi gộp quy cho AI, độ phủ giá vốn `ai_credited_cogs_coverage`) là dữ liệu của khách — được thấy, để khách biết
 * phải nhập giá vốn.
 */
const CAM_KHACH = /_cogs(_known)?$|margin|platform_|model_|^cost_per|per_ai_cost|error_rate|unpriced|post_optimization/;

function testRegistry() {
  const keys = TENANT_VALUE_METRICS.map((m) => m.key);
  assert.deepEqual([...keys].sort(), [...KHOA_GHIM].sort(), "khoá chỉ số đã ghim — đổi / xoá khoá làm mồ côi ảnh chụp; thêm khoá thì thêm vào KHOA_GHIM");
  assert.equal(new Set(keys).size, keys.length, "khoá không trùng");
  for (const m of TENANT_VALUE_METRICS) {
    assert.match(m.key, /^[a-z][a-z0-9_]+$/, `${m.key}: khoá snake_case`);
    assert.ok(m.label.trim().length > 0, `${m.key}: có nhãn`);
    if (m.availability === "UNAVAILABLE") {
      assert.equal(m.source, "—", `${m.key}: UNAVAILABLE không trỏ nguồn`);
      assert.ok((m.missingWhat ?? "").length >= 60, `${m.key}: UNAVAILABLE phải khai thiếu ĐÚNG cái gì, tới mức sửa được`);
    } else {
      assert.notEqual(m.source, "—", `${m.key}: đo được thì phải trỏ nguồn có thật`);
      assert.equal(m.missingWhat, null, `${m.key}: đo được thì không có missingWhat`);
    }
    assert.ok(m.minimumSample >= 1, `${m.key}: mẫu tối thiểu ≥ 1`);
    if (m.decision) assert.ok((TENANT_VALUE_DECISION_IDS as readonly string[]).includes(m.decision), `${m.key}: mã quyết định hợp lệ`);
    if ("overlay" in m && m.overlay) assert.equal(m.group, "VALUE", `${m.key}: thuộc tính chồng nằm ở nhóm VALUE`);
    if (m.group === "COGS") assert.equal(m.customerVisible, false, `${m.key}: nhóm giá vốn & biên không tới khách`);
    if (CAM_KHACH.test(m.key)) assert.equal(m.customerVisible, false, `${m.key}: chạm giá vốn / biên / model ⇒ customerVisible = false`);
  }
  for (const k of CUSTOMER_KEYS) {
    assert.ok(OPERATOR_KEYS.includes(k), `${k}: CUSTOMER_KEYS ⊂ OPERATOR_KEYS`);
    assert.notEqual(TENANT_VALUE_METRIC_BY_KEY[k].group, "COGS", `${k}: khoá giá vốn lọt vào CUSTOMER_KEYS`);
    assert.ok(!CAM_KHACH.test(k), `${k}: khoá giá vốn / biên lọt vào CUSTOMER_KEYS`);
  }
  assert.deepEqual([...CUSTOMER_KEYS], TENANT_VALUE_METRICS.filter((m) => m.customerVisible).map((m) => m.key), "CUSTOMER_KEYS DẪN XUẤT từ customerVisible, không phải danh sách thứ hai");

  // «Lợi nhuận tăng thêm do AI» không tồn tại ở V1 dưới dạng số.
  const inc = TENANT_VALUE_METRIC_BY_KEY.ai_incremental_profit;
  assert.equal(inc.availability, "UNAVAILABLE");
  assert.match(inc.missingWhat ?? "", /đối chứng/, "lợi nhuận tăng thêm cần nhóm đối chứng");
  for (const m of TENANT_VALUE_METRICS) if (/tăng thêm|incremental/i.test(`${m.key} ${m.label}`)) assert.equal(m.availability, "UNAVAILABLE", `${m.key}: «tăng thêm» chưa đo được ở V1`);
  // Chất lượng đứng cạnh chi phí (luật 9 của chủ shop: không tối ưu token bằng tỷ lệ chốt).
  for (const k of ["conversion_rate", "human_intervention_rate", "ai_error_rate"] as const) assert.equal(TENANT_VALUE_METRIC_BY_KEY[k].group, "QUALITY", `${k} có trong nhóm chất lượng`);

  // 12 quyết định — tạm, có mức ảnh hưởng, có hạn; mặc định ghép từ MỘT bảng.
  assert.equal(TENANT_VALUE_DECISION_IDS.length, 12);
  for (const id of TENANT_VALUE_DECISION_IDS) {
    const dec = TENANT_VALUE_DEFAULT_DECISIONS[id];
    assert.equal(dec.provisional, true, `${id}: mặc định là TẠM`);
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(dec.impact), `${id}: có mức ảnh hưởng`);
    assert.match(dec.decideBy, /^2026-10-\d{2}$/, `${id}: có hạn quyết`);
    assert.ok(dec.question.endsWith("?") && dec.ifChanged.length > 20, `${id}: câu hỏi + hệ quả nếu đổi`);
  }
  const d = DEFAULT_TENANT_VALUE_DECISIONS;
  assert.deepEqual(
    { spendBasis: d.spendBasis, assistedCredit: d.assistedCredit, cogsCoverageMin: d.cogsCoverageMin, valueNumerator: d.valueNumerator, minutesPerConversation: d.minutesPerConversation, paymentFee: d.paymentFee, qualifiedLead: d.qualifiedLead, churnUsageDropRatio: d.churnUsageDropRatio, healthScore: d.healthScore, infraAllocation: d.infraAllocation, defaultWindowDays: d.defaultWindowDays, multipleWindowDays: d.multipleWindowDays },
    { spendBasis: "RECOGNIZED", assistedCredit: null, cogsCoverageMin: 0.8, valueNumerator: "CREDITED_GROSS_PROFIT", minutesPerConversation: null, paymentFee: "UNAVAILABLE", qualifiedLead: "PHONE_LEFT", churnUsageDropRatio: 0.5, healthScore: false, infraAllocation: "NONE", defaultWindowDays: 30, multipleWindowDays: 90 },
    "mặc định tạm đúng chủ shop đã giao",
  );
  for (const k of ["D1", "D2", "D3", "D4"] as const) assert.equal(TENANT_VALUE_DEFAULT_DECISIONS[k].impact, "HIGH");
  // Không gõ lại số quyết định ở bộ ghép / luật sức khoẻ.
  for (const f of ["lib/saas/tenant-value.ts", "lib/saas/tenant-health-rules.ts"]) {
    const ma = docMa(f);
    assert.ok(!/\b0\.8\b|\b0\.5\b|\b80\b|\b90\b/.test(ma.replace(/Math\.round\([^)]*\)/g, "")), `${f}: ngưỡng quyết định phải đọc từ DEFAULT_TENANT_VALUE_DECISIONS, không gõ lại`);
  }
}

// ─────────────────────────── 2 · Bốn nhãn & thuộc tính chồng ───────────────────────────

function testFourLabels() {
  const v = buildTenantValue(input());
  const m = v.metrics;
  const four = [m.ai_auto_closed_orders, m.ai_assisted_orders, m.human_only_orders, m.unattributed_orders].map((x) => x.value as number);
  assert.deepEqual(four, [12, 6, 7, 3]);
  assert.equal(four.reduce((a, b) => a + b, 0), m.attributed_orders_total.value, "bốn nhãn cộng = tổng");
  assert.equal(m.attributed_orders_total.value, 28);
  assert.equal(v.checks.attributionSumMatches, true, "khớp đếm độc lập");
  const lech = buildTenantValue(input({ confirmedOrdersInPeriod: 30 }));
  assert.equal(lech.checks.attributionSumMatches, false, "lệch đếm độc lập ⇒ cờ false, không im lặng");
  assert.match(lech.metrics.attributed_orders_total.note ?? "", /Lệch/);
  assert.equal(buildTenantValue(input({ confirmedOrdersInPeriod: null })).checks.attributionSumMatches, null, "không có đếm độc lập ⇒ null, không phải true");
  assert.equal(m.unattributed_orders.value, 3, "chưa quy kết in riêng — không gộp vào người");
  assert.equal(m.human_only_orders.value, 7, "chưa quy kết không cộng vào người bán");

  // Thuộc tính chồng: đổi số thu hồi KHÔNG đổi tổng / AI tác động / doanh thu.
  const a = buildTenantValue(input({ attribution: attribution({ recovered: 0, recoveredRevenue: 0 }) })).metrics;
  const b = buildTenantValue(input({ attribution: attribution({ recovered: 9, recoveredRevenue: 4_000_000 }) })).metrics;
  for (const k of ["attributed_orders_total", "ai_influenced_orders", "ai_influenced_delivered_revenue", "ai_credited_delivered_revenue", "ai_credited_gross_profit"] as const) {
    assert.equal(a[k].value, b[k].value, `${k}: thuộc tính chồng (thu hồi) không bao giờ cộng vào tổng`);
  }
  assert.equal(b.ai_recovered_orders.value, 9);
  assert.equal(b.ai_recovered_delivered_revenue.value, 4_000_000);
  // Upsell ở mức đơn chưa có ⇒ null, không phải 0.
  assert.equal(m.ai_upsell_orders.value, null);
  assert.equal(m.ai_upsell_orders.availability, "UNAVAILABLE");
  assert.equal(m.incremental_upsell_revenue_delivered.value, null);
  for (const meta of TENANT_VALUE_METRICS) if ("overlay" in meta && meta.overlay) assert.ok(!["attributed_orders_total"].includes(meta.key), "khoá chồng không phải khoá tổng");
}

// ─────────────────────────── 3 · AI tác động ≠ công của AI ───────────────────────────

function testInfluencedVsCredited() {
  const v = buildTenantValue(input());
  const m = v.metrics;
  assert.equal(m.ai_influenced_orders.value, 18, "AI tác động = tự chốt + góp công");
  assert.equal(m.ai_influenced_delivered_revenue.value, 7_000_000);
  assert.equal(m.ai_credited_delivered_revenue.value, 5_000_000, "c = null ⇒ công chỉ là AI tự chốt");
  assert.equal(m.ai_assisted_delivered_revenue.value, 2_000_000, "góp công in RIÊNG");
  assert.notEqual(m.ai_influenced_delivered_revenue.value, m.ai_credited_delivered_revenue.value, "influenced ≠ credited khi có đơn góp công");
  assert.equal(m.ai_credited_delivered_revenue.provisional, true, "c chưa quyết ⇒ cờ tạm");
  assert.match(m.ai_credited_delivered_revenue.note ?? "", /in riêng/);
  assert.ok(v.provisionalDecisions.includes("D2"));

  const half = buildTenantValue(input({ decisions: { assistedCredit: 0.5 } })).metrics;
  assert.equal(half.ai_credited_delivered_revenue.value, 6_000_000, "c = 0,5 ⇒ tự chốt + 0,5 × góp công");
  assert.equal(half.ai_credited_delivered_revenue.provisional, false, "D2 đã chốt ⇒ hết cờ tạm");
  assert.equal(half.ai_influenced_delivered_revenue.value, 7_000_000, "AI tác động không phụ thuộc c");
  assert.equal(buildTenantValue(input({ decisions: { assistedCredit: 1.7 } })).metrics.ai_credited_delivered_revenue.value, 5_000_000, "c ngoài [0,1] ⇒ coi như chưa quyết (phía hẹp)");

  // Khớp 8 KPI giá trị — cùng bảng quy kết, cùng số.
  const at = attribution();
  const p = perf();
  const kpi = buildValueKpis({ attribution: at.table, aiOrders: null, funnel: p.cohorts.total, upsell: null });
  assert.equal(m.ai_influenced_delivered_revenue.value, kpi.revenue_attributed_to_ai, "doanh thu AI tác động = revenue_attributed_to_ai của 8 KPI");
  assert.equal(m.ai_auto_closed_orders.value, kpi.orders_closed_by_ai);
  assert.equal(m.ai_assisted_orders.value, kpi.orders_assisted);
  assert.equal(m.conversion_rate.value, kpi.conversion_rate, "tỷ lệ chốt cùng công thức");
}

// ─────────────────────────── 4 · null ≠ 0 ───────────────────────────

function testNullIsNotZero() {
  // Không nguồn nào ⇒ MỌI ô có số đều null (không ô nào bịa 0).
  const empty = buildTenantValue(ALL_NULL);
  for (const [k, cell] of Object.entries(empty.metrics)) {
    assert.equal(cell.value, null, `${k}: không nguồn nào ⇒ null, không phải ${cell.value}`);
    assert.ok(cell.state === "UNKNOWN" || cell.state === "NOT_APPLICABLE", `${k}: trạng thái chưa biết / không áp dụng`);
  }
  // Mọi khoá có số của sổ đều có ô.
  for (const meta of TENANT_VALUE_METRICS) if (meta.group !== "HEALTH") assert.ok(meta.key in empty.metrics, `${meta.key}: có ô`);

  // Khách trả: thiếu một thành phần ⇒ tổng null (không cộng phần thiếu bằng 0).
  const noBal = buildTenantValue(input({ spend: spend({ aiBalanceRevenueVnd: null }) })).metrics;
  assert.equal(noBal.customer_spend_recognized.value, null, "Số dư đã dùng chưa biết ⇒ khách trả ghi nhận null");
  assert.equal(noBal.platform_gross_profit.value, null);
  assert.equal(noBal.customer_value_multiple.value, null);
  assert.equal(noBal.customer_value_multiple.state, "UNKNOWN");
  // Ngày MRR chưa chụp ⇒ cận dưới, không dùng để chia.
  const gap = buildTenantValue(input({ spend: spend({ mrrDaysMissing: 4 }), decisions: { paymentFee: "DECLARED" }, cogs: cogs({ paymentFeeVnd: 0 }) })).metrics;
  assert.equal(gap.customer_spend_recognized.value, 1_000_000);
  assert.equal(gap.customer_spend_recognized.bound, "LOWER", "ngày vắng = chưa chụp ⇒ cận dưới");
  assert.equal(gap.platform_gross_profit.value, null, "khách trả cận dưới ⇒ không suy lãi gộp");
  assert.equal(gap.customer_value_multiple.value, null, "khách trả cận dưới ⇒ không suy bội số");
  // Bốn dòng tiền đứng riêng.
  const m = buildTenantValue(input()).metrics;
  assert.equal(m.customer_spend_recognized.value, 1_000_000, "ghi nhận = MRR + Số dư đã dùng + vượt");
  assert.equal(m.customer_spend_cash.value, 1_200_000, "tiền về = hoá đơn đã trả + nạp");
  assert.equal(m.ai_balance_topup_cash.value, 200_000);
  assert.match(m.ai_balance_topup_cash.note ?? "", /trả trước/);
  assert.equal(m.ai_balance_promo_used.value, 30_000);
  assert.notEqual(m.customer_spend_recognized.value, (m.customer_spend_recognized.value ?? 0) + (m.ai_balance_promo_used.value ?? 0), "khuyến mãi không vào doanh thu");

  // Chi phí AI chưa định giá ⇒ lãi gộp null + cận trên.
  const unpriced = buildTenantValue(input({ cogs: cogs({ aiUnpricedCalls: 5 }), decisions: { paymentFee: "DECLARED" } })).metrics;
  assert.equal(unpriced.platform_gross_profit.value, null, "lượt chưa định giá ⇒ lãi gộp nền tảng null");
  assert.equal(unpriced.platform_gross_profit_ceiling.value, 300_000, "cận trên = khách trả − chi phí đã biết");
  assert.equal(unpriced.platform_gross_profit_ceiling.bound, "UPPER");
  assert.equal(unpriced.actual_ai_cogs.bound, "LOWER");
  assert.equal(unpriced.platform_gross_margin.value, null);
  assert.equal(unpriced.platform_contribution.value, null, "đóng góp cũng null khi chi phí AI chưa đủ");
  // Phí thanh toán chưa khai (D6 mặc định) ⇒ lãi gộp null dù chi phí AI đủ; đóng góp sau AI vẫn có số.
  assert.equal(m.payment_fee_cogs.value, null);
  assert.equal(m.payment_fee_cogs.availability, "UNAVAILABLE");
  assert.equal(m.platform_gross_profit.value, null, "D6 UNAVAILABLE ⇒ lãi gộp nền tảng null, không đoán phí = 0");
  assert.equal(m.platform_gross_profit_ceiling.value, 300_000);
  assert.equal(m.platform_contribution.value, 300_000, "đóng góp sau chi phí AI (spec 11 §6) có số");
  assert.equal(m.variable_cogs_known.bound, "LOWER");

  // Giá vốn hàng thiếu ⇒ lãi gộp quy cho AI null + độ phủ.
  const lowCov = attribution({ table: { AI_ONLY: row({ orders: 12, delivered: 10, deliveredRevenueVnd: 5_000_000, costedRevenueVnd: 2_000_000, grossProfitVnd: 800_000, cogsUnknown: 6, cogsUnknownRevenueVnd: 3_000_000 }) } });
  const cov = buildTenantValue(input({ attribution: lowCov })).metrics;
  assert.equal(cov.ai_credited_cogs_coverage.value, 0.4, "độ phủ = có giá vốn ÷ đã giao");
  assert.equal(cov.ai_credited_gross_profit.value, null, "độ phủ 40% < 80% (D3) ⇒ lãi gộp quy cho AI null");
  assert.match(cov.ai_credited_gross_profit.note ?? "", /D3/);
  assert.equal(cov.customer_value_multiple.value, null);
  assert.match(cov.customer_value_multiple.note ?? "", /D3/);
  assert.equal(cov.gross_profit_per_ai_cost.value, null);
  // Đủ độ phủ ⇒ có số (90% ≥ 80%).
  assert.equal(m.ai_credited_cogs_coverage.value, 0.9);
  assert.equal(m.ai_credited_gross_profit.value, 1_800_000);

  // Mẫu dưới ngưỡng ⇒ null.
  const few = buildTenantValue(input({ perf: perf({ conversations: 6, identified: 3 }) })).metrics;
  assert.equal(few.conversion_rate.value, null, "6 hội thoại < 10 ⇒ tỷ lệ chốt null");
  assert.equal(few.cost_per_qualified_lead.value, null, "3 lead < 10 ⇒ chi phí / lead null");
  assert.match(few.cost_per_qualified_lead.note ?? "", /dưới ngưỡng/);
  const fewOrders = attribution({ table: { AI_ONLY: row({ orders: 4, delivered: 3, deliveredRevenueVnd: 900_000, costedRevenueVnd: 900_000, grossProfitVnd: 300_000 }) } });
  const fm = buildTenantValue(input({ attribution: fewOrders })).metrics;
  assert.equal(fm.customer_value_multiple.value, null, "3 đơn đã giao < mẫu tối thiểu ⇒ bội số null");
  assert.match(fm.customer_value_multiple.note ?? "", /mẫu tối thiểu/);
  assert.equal(buildTenantValue(input({ aiCalls: { total: 12, errors: 3, modelLatencyP50Ms: null } })).metrics.ai_error_rate.value, null, "12 lượt < mẫu tối thiểu ⇒ tỷ lệ lỗi null");

  // Giờ công / tiết kiệm nhân sự chưa khai ⇒ null.
  assert.equal(m.staff_hours_saved.value, null, "D5 mặc định null ⇒ giờ công chưa tính, không phải 0 giờ");
  assert.equal(buildTenantValue(input({ decisions: { minutesPerConversation: 6 } })).metrics.staff_hours_saved.value, 8, "80 hội thoại × 6 phút = 8 giờ");
  assert.equal(buildTenantValue(input({ perf: perf({ human: null }) })).metrics.staff_cost_saved.value, null, "chưa khai chi phí người ⇒ null");
  // Chi phí bán hàng chưa biết ⇒ mọi chi phí trên đơn vị null.
  const noCost = buildTenantValue(input({ perf: perf({ sellingVnd: null }) })).metrics;
  for (const k of ["cost_per_conversation", "cost_per_qualified_lead", "cost_per_order", "cost_per_recovered_order", "revenue_per_ai_cost", "gross_profit_per_ai_cost"] as const) assert.equal(noCost[k].value, null, `${k}: chi phí chưa biết ⇒ null`);
  // Có lượt chưa định giá ở phần bán hàng ⇒ tỷ số là CẬN TRÊN.
  assert.equal(buildTenantValue(input({ perf: perf({ unknownCost: 3 }) })).metrics.revenue_per_ai_cost.bound, "UPPER");
  // Khoá UNAVAILABLE luôn null dù đầu vào đầy đủ.
  for (const meta of TENANT_VALUE_METRICS) if (meta.group !== "HEALTH" && meta.availability === "UNAVAILABLE") assert.equal(m[meta.key as TenantValueNumericKey].value, null, `${meta.key}: UNAVAILABLE ⇒ null`);
}

// ─────────────────────────── 5 · N/A và đối chiếu customerEconomicsCore ───────────────────────────

function testNotApplicableAndCore() {
  const internal = buildTenantValue(input({ marginApplicable: false })).metrics;
  for (const k of ["platform_contribution", "platform_gross_profit", "platform_gross_profit_ceiling", "platform_gross_margin", "customer_value_multiple", "customer_roi"] as const) {
    assert.equal(internal[k].state, "NOT_APPLICABLE", `${k}: chargeback nội bộ ⇒ N/A`);
    assert.equal(internal[k].value, null, `${k}: N/A không mang số`);
  }
  assert.equal(internal.actual_ai_cogs.value, 700_000, "chargeback vẫn in đủ chi phí");
  // Khách chưa trả tiền ⇒ biên / bội số không áp dụng (không phải 0%).
  const free = buildTenantValue(input({ spend: spend({ mrrAccrualVnd: 0, aiBalanceRevenueVnd: 0, overageBilledVnd: 0 }), decisions: { paymentFee: "DECLARED" }, cogs: cogs({ paymentFeeVnd: 0 }) })).metrics;
  assert.equal(free.platform_gross_margin.state, "NOT_APPLICABLE");
  assert.equal(free.customer_value_multiple.state, "NOT_APPLICABLE");
  assert.equal(free.platform_gross_profit.value, -700_000, "khách miễn phí: lãi gộp = − chi phí (số thật)");
  // Cửa sổ không phải cửa sổ bội số (D12) ⇒ N/A.
  assert.equal(buildTenantValue(input({ window: 30 })).metrics.customer_value_multiple.state, "NOT_APPLICABLE");

  // Bội số / ROI khi đủ điều kiện.
  const ok = buildTenantValue(input()).metrics;
  assert.equal(ok.customer_value_multiple.value, 1.8, "1.800.000 ÷ 1.000.000");
  assert.equal(ok.customer_value_multiple.availability, "ESTIMATED");
  assert.equal(ok.customer_value_multiple.provisional, true);
  assert.ok(Math.abs((ok.customer_roi.value ?? 0) - 0.8) < 1e-9);
  const cash = buildTenantValue(input({ decisions: { spendBasis: "CASH" } })).metrics;
  assert.equal(cash.customer_value_multiple.value, 1.5, "D1 = tiền về ⇒ chia cho 1.200.000");
  const plusStaff = buildTenantValue(input({ decisions: { valueNumerator: "CREDITED_GROSS_PROFIT_PLUS_STAFF" } })).metrics;
  assert.equal(plusStaff.customer_value_multiple.value, 2.2, "D4 cộng tiết kiệm nhân sự (400.000)");
  assert.equal(buildTenantValue(input({ decisions: { valueNumerator: "CREDITED_GROSS_PROFIT_PLUS_STAFF" }, perf: perf({ human: null }) })).metrics.customer_value_multiple.value, null, "D4 cộng nhân sự mà chưa khai ⇒ null");

  // Cùng nhánh với customerEconomicsCore trên nhiều trường hợp.
  const cases: { spend: TenantSpendInput; cogs: TenantCogsInput; fee: "DECLARED" | "UNAVAILABLE" }[] = [
    { spend: spend(), cogs: cogs({ paymentFeeVnd: 0 }), fee: "DECLARED" },
    { spend: spend(), cogs: cogs({ paymentFeeVnd: 15_000, otherVariableVnd: 20_000 }), fee: "DECLARED" },
    { spend: spend(), cogs: cogs({ aiUnpricedCalls: 2, paymentFeeVnd: 0 }), fee: "DECLARED" },
    { spend: spend(), cogs: cogs({ otherVariableVnd: null, paymentFeeVnd: 0 }), fee: "DECLARED" },
    { spend: spend(), cogs: cogs(), fee: "UNAVAILABLE" },
    { spend: spend({ overageBilledVnd: null }), cogs: cogs({ paymentFeeVnd: 0 }), fee: "DECLARED" },
    { spend: spend({ mrrAccrualVnd: 100_000, aiBalanceRevenueVnd: 0 }), cogs: cogs({ aiPlatformVnd: 900_000, paymentFeeVnd: 0 }), fee: "DECLARED" },
  ];
  for (const [i, c] of cases.entries()) {
    const v = buildTenantValue(input({ spend: c.spend, cogs: c.cogs, decisions: { paymentFee: c.fee } })).metrics;
    const revenue = c.spend.mrrAccrualVnd === null || c.spend.aiBalanceRevenueVnd === null || c.spend.overageBilledVnd === null ? null : c.spend.mrrAccrualVnd + c.spend.aiBalanceRevenueVnd + c.spend.overageBilledVnd;
    const core = customerEconomicsCore({ revenueVnd: revenue, aiCostVnd: c.cogs.aiPlatformVnd ?? 0, unpricedAiCalls: c.cogs.aiUnpricedCalls, allocated: [{ amountVnd: c.cogs.otherVariableVnd }, { amountVnd: c.fee === "DECLARED" ? c.cogs.paymentFeeVnd : null }] });
    assert.equal(v.platform_gross_profit.value, core.grossProfitVnd, `ca ${i}: lãi gộp nền tảng = customerEconomicsCore (cùng nhánh null)`);
    assert.equal(v.platform_gross_margin.value, core.marginPct === null ? null : core.marginPct / 100, `ca ${i}: biên = customerEconomicsCore.marginPct / 100`);
    assert.equal(v.platform_gross_profit.value === null, !core.costComplete || revenue === null, `ca ${i}: null đúng khi chi phí chưa đủ hoặc khách trả chưa biết`);
  }
}

// ─────────────────────────── 6 · Sức khoẻ · rủi ro rời bỏ · vấn đề lớn nhất ───────────────────────────

const healthy: BaseHealth = { level: "HEALTHY", reasonCodes: [], gapCodes: [] };
const usageOk = { current: 110, previous: 100 };

function testHealth() {
  const v = buildTenantValue(input());
  // Thiếu hết ⇒ UNKNOWN, không bao giờ HEALTHY.
  const none = healthOf({ base: null, value: null, usage: null });
  assert.equal(none.level, "UNKNOWN");
  assert.deepEqual(none.reasonCodes, ["SIGNALS_MISSING"]);
  for (const g of ["BASE_HEALTH_MISSING", "VALUE_SNAPSHOT_MISSING", "USAGE_TREND_UNMEASURED"] as const) assert.ok(none.gapCodes.includes(g), `thiếu ${g}`);
  // Đủ ⇒ HEALTHY kèm mã.
  const ok = healthOf({ base: healthy, value: v, usage: usageOk });
  assert.equal(ok.level, "HEALTHY");
  assert.deepEqual(ok.reasonCodes, ["ALL_SIGNALS_OK"]);
  // Bội số chưa đo là tín hiệu TUỲ CHỌN: vẫn khoẻ nhưng chỗ chưa đo được in ra.
  const v30 = buildTenantValue(input({ attribution: attribution({ table: { AI_ONLY: row({ orders: 12, delivered: 10, deliveredRevenueVnd: 5_000_000, costedRevenueVnd: 1_000_000, grossProfitVnd: 300_000 }) } }) }));
  const opt = healthOf({ base: healthy, value: v30, usage: usageOk });
  assert.equal(opt.level, "HEALTHY");
  assert.ok(opt.gapCodes.includes("VALUE_MULTIPLE_UNMEASURED"));
  // Cửa sổ trước dưới mẫu ⇒ UNKNOWN (tín hiệu BẮT BUỘC).
  assert.equal(healthOf({ base: healthy, value: v, usage: { current: 3, previous: 4 } }).level, "UNKNOWN");
  // Base còn chỗ chưa đo ⇒ UNKNOWN.
  assert.equal(healthOf({ base: { level: "UNKNOWN", reasonCodes: [], gapCodes: ["LOGIN_UNREADABLE"] }, value: v, usage: usageOk }).level, "UNKNOWN");
  // Dùng giảm ⇒ cần chú ý.
  const down = healthOf({ base: healthy, value: v, usage: { current: 40, previous: 100 } });
  assert.equal(down.level, "NEEDS_ATTENTION");
  assert.ok(down.reasonCodes.includes("USAGE_TREND_DOWN"));
  // Giá trị thấp hơn tiền trả.
  const low = buildTenantValue(input({ spend: spend({ mrrAccrualVnd: 3_900_000 }) }));
  assert.ok((low.metrics.customer_value_multiple.value ?? 9) < 1);
  assert.ok(healthOf({ base: healthy, value: low, usage: usageOk }).reasonCodes.includes("VALUE_BELOW_SPEND"));
  // Có hội thoại mà AI không ra đơn.
  const noOrders = buildTenantValue(input({ attribution: attribution({ table: { AI_ONLY: row(), AI_ASSISTED: row() } }) }));
  assert.ok(healthOf({ base: healthy, value: noOrders, usage: usageOk }).reasonCodes.includes("NO_AI_ORDERS"));
  // Base CRITICAL thắng.
  const crit = healthOf({ base: { level: "CRITICAL", reasonCodes: ["AI_FAILING"], gapCodes: [] }, value: v, usage: { current: 40, previous: 100 } });
  assert.equal(crit.level, "CRITICAL");
  // Đã dừng.
  const inact = healthOf({ base: { level: "INACTIVE", reasonCodes: [], gapCodes: [] }, value: v, usage: usageOk });
  assert.equal(inact.level, "INACTIVE");
  assert.deepEqual(inact.reasonCodes, ["INACTIVE"]);
  // Mọi mức ≥ 1 mã, mọi mã có câu giải thích, không có điểm.
  for (const h of [none, ok, opt, down, crit, inact]) {
    assert.ok(h.reasonCodes.length >= 1, `${h.level}: có ≥ 1 mã lý do`);
    for (const e of h.explanation) assert.ok(e.text.trim().length > 5, `${e.code}: có câu giải thích`);
    assert.ok(!("score" in h), "không có điểm");
  }
  // baseHealthFrom đọc đúng mã của classifyCustomer.
  const b = baseHealthFrom({ level: "NEEDS_ATTENTION", reasons: [{ code: "PAST_DUE", level: "NEEDS_ATTENTION", workspace: null, short: "", text: "" }, { code: "PAST_DUE", level: "NEEDS_ATTENTION", workspace: "x", short: "", text: "" }], gaps: [] });
  assert.deepEqual(b.reasonCodes, ["PAST_DUE"], "mã trùng gộp một");
  // usageDropped: không nền ⇒ null.
  assert.equal(usageDropped({ current: 0, previous: null }), null);
  assert.equal(usageDropped({ current: 50, previous: 100 }), true, "giảm 50% = ngưỡng D8 ⇒ bật");
  assert.equal(usageDropped({ current: 51, previous: 100 }), false);
  assert.equal(usageDropped({ current: 50, previous: 100 }, { churnUsageDropRatio: 0.9, churnUsageMinSample: 10 }), false, "ngưỡng đọc từ quyết định truyền vào");
}

function testChurn() {
  const v = buildTenantValue(input());
  const sub = { status: "ACTIVE" as const, everPaid: true };
  const h = (level: BaseHealth["level"], codes: string[] = []) => ({ level, reasonCodes: codes as never[] });

  const unknown = churnRiskOf({ health: null, subscription: null, usage: null, value: null });
  assert.equal(unknown.risk, "UNKNOWN", "thiếu tín hiệu bắt buộc ⇒ UNKNOWN, KHÔNG BAO GIỜ LOW mặc định");
  assert.deepEqual(unknown.reasonCodes, ["REQUIRED_SIGNAL_MISSING"]);
  assert.equal(churnRiskOf({ health: h("HEALTHY"), subscription: sub, usage: { current: 5, previous: 6 }, value: v }).risk, "UNKNOWN", "cửa sổ trước dưới mẫu ⇒ UNKNOWN");
  assert.equal(churnRiskOf({ health: h("HEALTHY"), subscription: null, usage: usageOk, value: v }).risk, "UNKNOWN", "thiếu thuê bao ⇒ UNKNOWN");
  const low = churnRiskOf({ health: h("HEALTHY"), subscription: sub, usage: usageOk, value: v });
  assert.equal(low.risk, "LOW");
  assert.deepEqual(low.reasonCodes, ["NO_RISK_SIGNAL"]);
  // Bội số chưa đo không chặn LOW (tín hiệu tuỳ chọn) nhưng phải in chỗ chưa đo.
  const lowGap = churnRiskOf({ health: h("HEALTHY"), subscription: sub, usage: usageOk, value: buildTenantValue(input({ window: 90, spend: null })) });
  assert.equal(lowGap.risk, "LOW");
  assert.ok(lowGap.gapCodes.includes("VALUE_MULTIPLE_UNMEASURED"));

  // Bảng ánh xạ — mỗi mã rủi ro bật ⇒ đúng mức của bảng.
  const fire: Record<Exclude<ChurnReasonCode, "NO_RISK_SIGNAL" | "REQUIRED_SIGNAL_MISSING" | "INACTIVE">, Parameters<typeof churnRiskOf>[0]> = {
    PRODUCT_DOWN: { health: h("CRITICAL", ["AI_FAILING"]), subscription: sub, usage: usageOk, value: v },
    PAID_THEN_EXPIRED: { health: h("HEALTHY"), subscription: { status: "EXPIRED", everPaid: true }, usage: usageOk, value: v },
    PAST_DUE_AND_USAGE_DOWN: { health: h("NEEDS_ATTENTION", ["PAST_DUE"]), subscription: { status: "PAST_DUE", everPaid: true }, usage: { current: 30, previous: 100 }, value: v },
    NO_LOGIN_AND_INBOUND_DROP: { health: h("NEEDS_ATTENTION", ["LOGIN_STALE", "INBOUND_DROP"]), subscription: sub, usage: usageOk, value: v },
    USAGE_TREND_DOWN: { health: h("HEALTHY"), subscription: sub, usage: { current: 30, previous: 100 }, value: v },
    VALUE_BELOW_SPEND: { health: h("HEALTHY"), subscription: sub, usage: usageOk, value: buildTenantValue(input({ spend: spend({ mrrAccrualVnd: 3_900_000 }) })) },
    NOT_ACTIVATED_AFTER_GRACE: { health: h("NEEDS_ATTENTION", ["NOT_ACTIVATED"]), subscription: sub, usage: usageOk, value: v },
  };
  for (const [code, inp] of Object.entries(fire) as [ChurnReasonCode, Parameters<typeof churnRiskOf>[0]][]) {
    const r = churnRiskOf(inp);
    assert.ok(r.reasonCodes.includes(code), `${code}: bật`);
    const worst = r.reasonCodes.map((c) => CHURN_REASONS[c].risk).sort((a, b) => CHURN_RISK_LEVELS.indexOf(a) - CHURN_RISK_LEVELS.indexOf(b))[0];
    assert.equal(r.risk, worst, `${code}: mức = mức nặng nhất của bảng ánh xạ`);
  }
  assert.equal(churnRiskOf(fire.PRODUCT_DOWN).risk, "CRITICAL");
  assert.equal(churnRiskOf(fire.PAST_DUE_AND_USAGE_DOWN).risk, "HIGH");
  assert.equal(churnRiskOf(fire.USAGE_TREND_DOWN).risk, "MEDIUM");
  assert.equal(churnRiskOf({ ...fire.PRODUCT_DOWN, usage: null, subscription: null }).risk, "CRITICAL", "mã đã bật quyết định mức dù còn tín hiệu khác thiếu");
  assert.ok(!churnRiskOf({ health: h("HEALTHY"), subscription: { status: "EXPIRED", everPaid: null }, usage: usageOk, value: v }).reasonCodes.includes("PAID_THEN_EXPIRED"), "chưa biết đã trả chưa ⇒ không khẳng định");
  assert.equal(churnRiskOf({ ...fire.USAGE_TREND_DOWN, decisions: { churnUsageDropRatio: 0.9 } }).risk, "LOW", "ngưỡng D8 đọc từ quyết định");
  const inact = churnRiskOf({ health: { level: "INACTIVE", reasonCodes: ["INACTIVE"] }, subscription: sub, usage: usageOk, value: v });
  assert.equal(inact.risk, "UNKNOWN");
  assert.deepEqual(inact.reasonCodes, ["INACTIVE"]);
  // Mọi mức ≥ 1 mã + giải thích; không điểm.
  for (const r of [unknown, low, lowGap, inact, ...Object.values(fire).map((x) => churnRiskOf(x))]) {
    assert.ok(r.reasonCodes.length >= 1, `${r.risk}: ≥ 1 mã`);
    for (const e of r.explanation) assert.ok(e.text.length > 5);
    assert.ok(!("score" in r));
  }
  // Không điểm /100 ở mã nguồn luật sức khoẻ / rủi ro.
  for (const f of ["lib/saas/tenant-health-rules.ts", "lib/constants/churn-risk.ts"]) assert.ok(!/score|\/\s*100\b/i.test(docMa(f)), `${f}: không có điểm /100 (D9)`);
}

function testTopIssue() {
  const v = buildTenantValue(input());
  const crit = healthOf({ base: { level: "CRITICAL", reasonCodes: ["AI_FAILING"], gapCodes: [] }, value: v, usage: { current: 30, previous: 100 } });
  const churn = churnRiskOf({ health: crit, subscription: { status: "ACTIVE", everPaid: true }, usage: { current: 30, previous: 100 }, value: v });
  const top = topIssueOf({ orgCode: "shop a", accountCode: "acc-1", health: crit, churn });
  assert.equal(top?.code, "AI_FAILING", "mã nặng nhất — lý do cụ thể đứng trước mã rủi ro dẫn xuất");
  assert.equal(top?.action.href, "/platform/org/shop%20a", "lối ra mã hoá mã tổ chức");
  const ok = healthOf({ base: healthy, value: v, usage: usageOk });
  assert.equal(topIssueOf({ orgCode: "a", accountCode: "b", health: ok, churn: churnRiskOf({ health: ok, subscription: { status: "ACTIVE", everPaid: true }, usage: usageOk, value: v }) }), null, "không vấn đề có chứng cứ ⇒ null");
  const gapOnly = healthOf({ base: null, value: v, usage: usageOk });
  const g = topIssueOf({ orgCode: "a", accountCode: "acc", health: gapOnly, churn: null });
  assert.equal(g?.source, "GAP", "chỉ có chỗ chưa đo ⇒ vấn đề là đi lấy dữ liệu");
  const below = buildTenantValue(input({ spend: spend({ mrrAccrualVnd: 3_900_000 }) }));
  const hb = healthOf({ base: healthy, value: below, usage: usageOk });
  const tb = topIssueOf({ orgCode: "o", accountCode: "acc-9", health: hb, churn: churnRiskOf({ health: hb, subscription: { status: "ACTIVE", everPaid: true }, usage: usageOk, value: below }) });
  assert.equal(tb?.code, "VALUE_BELOW_SPEND");
  assert.equal(tb?.action.href, "/platform/customers/acc-9");
  // Ổn định.
  assert.deepEqual(topIssueOf({ orgCode: "shop a", accountCode: "acc-1", health: crit, churn }), top);
}

function testPurityAndVersions() {
  assert.deepEqual(buildTenantValue(input()), buildTenantValue(input()), "chạy hai lần ra một kết quả");
  const v = buildTenantValue(input());
  assert.match(v.formulaVersion, /^tv\d+\.attr\d+$/);
  assert.equal(v.fxSource, "ENV_FACEBOOK_USD_VND", "nhãn nguồn tỷ giá đi theo kết quả (D11)");
  assert.deepEqual(snapshotsComparable(v, v), { comparable: true, reason: null });
  assert.equal(snapshotsComparable(v, { ...v, window: 30 }).comparable, false);
  assert.equal(snapshotsComparable(v, { ...v, formulaVersion: "tv2.attr1" }).comparable, false);
  for (const f of ["lib/saas/tenant-value.ts", "lib/saas/tenant-health-rules.ts", "lib/constants/tenant-value-metrics.ts", "lib/constants/churn-risk.ts"]) {
    const ma = docMa(f);
    assert.ok(!/from "@\/db"|getDb|getDbFor|withOrganization|drizzle-orm|Date\.now|new Date\(/.test(ma), `${f}: hàm thuần — không CSDL, không đồng hồ`);
    assert.ok(!/import \{[^}]*\} from "@\/lib\/sales-chatbot\/(attribution|performance)"/.test(ma), `${f}: bộ đọc máy chủ chỉ được import type`);
  }
  // Không viết lại điều kiện kết cục đơn (ORDER_OUTCOME là nguồn duy nhất).
  assert.ok(!/stage|"DELIVERED"|'DELIVERED'|RETURNED/.test(docMa("lib/saas/tenant-value.ts")), "bộ ghép không tự kết luận giao thành công");
}

export async function testSaasValueCenter() {
  testRegistry();
  testFourLabels();
  testInfluencedVsCredited();
  testNullIsNotZero();
  testNotApplicableAndCore();
  testHealth();
  testChurn();
  testTopIssue();
  testPurityAndVersions();
  console.log("  ✓ Trung tâm giá trị SaaS (PR-1): sổ chỉ số ghim khoá · bốn nhãn cộng = tổng, thu hồi/upsell chồng · AI tác động ≠ công (c = null) · null ≠ 0 mọi nhánh · N/A chargeback · lãi gộp nền tảng = customerEconomicsCore · sức khoẻ / rủi ro rời bỏ thiếu tín hiệu ⇒ UNKNOWN, không điểm /100");
}

if (process.argv[1] && /saas-value-center\.test\.ts$/.test(process.argv[1])) {
  testSaasValueCenter().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

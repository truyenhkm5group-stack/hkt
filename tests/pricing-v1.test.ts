/**
 * BẢNG GIÁ V1 CHỐT ĐƠN TỰ ĐỘNG (0228 · docs/saas/PRICING_V1.md) — bảng giá có phiên bản, đồng hồ khách AI, phần vượt, cảnh báo,
 * khách nội bộ cùng bộ máy, giá legacy không đổi.
 *
 *  1. THUẦN — phần vượt theo khối ở cả ba gói (biên 1.500 / 1.501 / 1.600 / 1.601), đơn KHÔNG sinh phí, fair-use không bao giờ
 *     tính tiền, số dùng chưa biết / đo chưa trọn ⇒ `null`, Enterprise theo hợp đồng, ngưỡng 80 · 100 · 120 · 150 và không ngưỡng
 *     nào tắt bot, dải biên, gói nhỏ nhất vừa số dùng, khoá khách AI (cùng khách cùng kỳ một khoá; hai trang hai khách; kỳ sau
 *     khoá khác), độ phủ đồng hồ (runtime cũ ⇒ chưa đo), phiên bản: legacy chỉ thay giá, gia hạn đúng gói giữ giá ghim, đổi gói
 *     đi giá hiện hành.
 *  2. VÒNG THẬT (PGlite) — migration gieo V1 đúng số + legacy chép ĐÚNG `platform_plans`; hoá đơn legacy trước / sau bằng nhau;
 *     phát hành phiên bản mới không đổi giá tổ chức đã ghim, lịch sử tái lập được; INBOX không có `ai_sales`; đồng hồ khách AI ở
 *     điểm gửi (`noteAiCustomerReply`; đường gửi THẬT đo ở tests/ai-customer-send.test.ts) — trả lời lặp / nhiều hội thoại / thử lại đồng thời = một dòng, TEST không đếm,
 *     lỗi ghi sổ không làm hỏng việc gửi, tổ chức A không chặn / đếm cho B; hoá đơn ước tính của khách; khách nội bộ: chạy thử
 *     → gán gói thường nhỏ nhất → bảng kê chargeback dùng cùng phép tính phần vượt.
 *
 * Mốc thời gian: dữ liệu gieo theo ĐỒNG HỒ THẬT, một `now` dùng chung cho ghi và đọc (AGENTS mục 50 · 65).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { addDays, quoteRenewal, vnDate } from "@/lib/billing/rules";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { loadTenantBilling, previewRenewal, setPlanPrice } from "@/lib/billing/service";
import { getPlanUsage, listPlans } from "@/lib/entitlements/check";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota, resolveAiLimits } from "@/lib/ai-usage/quota";
import { evaluateAiQuota, parseAiLimits } from "@/lib/ai-usage/types";
import { env } from "@/lib/env";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { captureSaasSnapshot } from "@/lib/platform/saas-ledger";
import { aiCustomerMeterErrors, noteAiCustomerReply, readAiCustomerCounts, readAiCustomerUsage, recordAiCustomer, resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { loadCustomerPlan } from "@/lib/pricing/customer";
import { hasFeature, invalidatePricing, resolveOrgPricing } from "@/lib/pricing/entitlements";
import { aiLimitCheck, planInternalFit, previousPeriodMonth } from "@/lib/pricing/internal-fit";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { finalizeStatement } from "@/lib/saas/billing";
import { accountOfWorkspace } from "@/lib/saas/accounts";
import { AI_CUSTOMER_METER_LIVE_KEY, resetAiLimitsMemoForTests, invalidatePriceBook, loadPriceBook, pinOrgPriceVersion, plansForOrg, readAiCustomerMeterLiveAt } from "@/lib/pricing/price-book";
import { buildValueKpis, VALUE_KPI_KEYS, VALUE_KPI_SPEC } from "@/lib/pricing/value-kpis";
import {
  aiCustomerBlocks,
  catalogAiLimits,
  aiCustomerCoverage,
  aiCustomerEventKey,
  computeOverage,
  currentCatalogVersion,
  DEFAULT_USAGE_ALERTS,
  estimateBill,
  fairUseVerdict,
  marginBand,
  meterMonthOf,
  overlayPlanRow,
  parseMarginConfig,
  parsePlanPrice,
  parseUsageAlerts,
  priceOf,
  renewalPricing,
  resolveOrgVersion,
  smallestFittingPlan,
  usageAlert,
  type BillableUsage,
  type PlanPrice,
  type PriceBook,
  type PriceVersion,
} from "@/lib/pricing/versions";
import { loadCommercialSnapshot } from "@/lib/saas/customers";
import { updateAccount } from "@/lib/saas/accounts";

const V1 = "v1-2026-10";
const A = "pv1-a";
const B = "pv1-b";
const LEG = "pv1-leg";
const INT = "pv1-int";
const ORGS = [A, B, LEG, INT] as const;

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "pv1-user", email: "pv1@local", name: "PV1", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

// ─────────────────────────── Bộ giá thử (thuần) — ĐÚNG số của quyết định 07/10/2026 ───────────────────────────

const row = (planKey: string, over: Partial<Parameters<typeof parsePlanPrice>[0]>) =>
  parsePlanPrice({ versionKey: V1, planKey, name: planKey, description: null, position: 0, listed: true, highlight: false, contactSales: false, monthlyVnd: null, yearlyVnd: null, yearlyFreeMonths: 2, priceFromVnd: null, trialDays: null, included: {}, overage: {}, features: [], addonPrices: {}, limits: {}, commercial: {}, ...over });
const AI = ["ai_sales", "ai_order_creation"];
const STARTER = row("starter", { monthlyVnd: 790_000, yearlyVnd: 7_900_000, position: 20, included: { aiCustomers: 1500, fanpages: 3, users: 5, aiConversations: 4500, aiReplies: 30000, orders: null }, overage: { mode: "BILLED", aiCustomerBlockSize: 100, aiCustomerBlockVnd: 59_000, extraFanpageVnd: 99_000, extraUserVnd: 49_000 }, features: AI });
const GROWTH = row("growth", { monthlyVnd: 1_490_000, yearlyVnd: 14_900_000, position: 30, included: { aiCustomers: 3000, fanpages: 10, users: 10, aiConversations: 10000, aiReplies: 75000, orders: null }, overage: { mode: "BILLED", aiCustomerBlockSize: 100, aiCustomerBlockVnd: 49_000, extraFanpageVnd: 99_000, extraUserVnd: 49_000 }, features: AI });
const SCALE = row("scale", { monthlyVnd: 2_990_000, yearlyVnd: 29_900_000, position: 36, included: { aiCustomers: 7500, fanpages: 30, users: 25, aiConversations: 30000, aiReplies: 200000, orders: null }, overage: { mode: "BILLED", aiCustomerBlockSize: 100, aiCustomerBlockVnd: 39_000, extraFanpageVnd: 99_000, extraUserVnd: 49_000 }, features: AI });
const INBOX = row("inbox", { monthlyVnd: 299_000, yearlyVnd: 2_990_000, position: 11, included: { aiCustomers: 0, fanpages: 3, users: 3, aiConversations: 0, aiReplies: 0, orders: null }, overage: { mode: "BILLED", extraFanpageVnd: 99_000, extraUserVnd: 49_000 }, features: ["multi_page_inbox"] });
const TRIAL = row("trial", { trialDays: 7, position: 10, yearlyFreeMonths: 0, included: { aiCustomers: 100, fanpages: 1, users: 2, aiConversations: 300, aiReplies: 2000, orders: null }, overage: { mode: "NONE" }, features: AI });
const ENTERPRISE = row("enterprise", { contactSales: true, priceFromVnd: 5_990_000, position: 40, yearlyFreeMonths: 0, included: { aiCustomers: null, fanpages: null, users: null, aiConversations: null, aiReplies: null, orders: null }, overage: { mode: "CONTRACT" }, features: AI });
const V1_PRICES: PlanPrice[] = [TRIAL, INBOX, STARTER, GROWTH, SCALE, ENTERPRISE];

const usg = (over: Partial<BillableUsage>): BillableUsage => ({ aiCustomers: 0, aiCustomersCoverage: "MEASURED", fanpages: 1, users: 1, aiConversations: 0, aiReplies: 0, ...over });

function testPure() {
  const big0 = () => ({ requestsToday: 99_999, requestsMonth: 999_999, costUsdMonth: 9_999, unknownCostMonth: 0 });
  // ── Khối khách AI: biên 1.500 → 0 · 1.501 → 1 · 1.600 → 1 · 1.601 → 2, cho cả ba gói (theo số gồm của từng gói).
  for (const [p, inc, unit] of [
    [STARTER, 1500, 59_000],
    [GROWTH, 3000, 49_000],
    [SCALE, 7500, 39_000],
  ] as const) {
    const amount = (used: number) => computeOverage(p, usg({ aiCustomers: used })).lines.find((l) => l.key === "aiCustomers")!;
    assert.deepEqual([amount(inc).blocks, amount(inc + 1).blocks, amount(inc + 100).blocks, amount(inc + 101).blocks], [0, 1, 1, 2], `${p.planKey}: làm tròn LÊN theo khối 100`);
    assert.deepEqual([amount(inc).amountVnd, amount(inc + 1).amountVnd, amount(inc + 100).amountVnd, amount(inc + 101).amountVnd], [0, unit, unit, 2 * unit], `${p.planKey}: đơn giá khối ${unit}`);
    assert.equal(computeOverage(p, usg({ aiCustomers: inc + 1 })).totalVnd, unit);
  }
  assert.deepEqual(aiCustomerBlocks(null, 1500, 100), { overUnits: null, blocks: null }, "chưa biết ⇒ chưa biết, không phải 0");
  assert.deepEqual(aiCustomerBlocks(10_000, null, 100), { overUnits: 0, blocks: 0 }, "gồm không giới hạn ⇒ không vượt");

  // ── ĐƠN không bao giờ sinh phí; hội thoại / trả lời AI là fair-use — không dòng tiền nào dù vượt xa.
  const base = computeOverage(STARTER, usg({ aiCustomers: 1200 }));
  const heavy = computeOverage(STARTER, usg({ aiCustomers: 1200, orders: 1_000_000, aiConversations: 999_999, aiReplies: 9_999_999 }));
  assert.equal(heavy.totalVnd, base.totalVnd, "đơn / hội thoại / trả lời không đổi tiền vượt");
  assert.equal(heavy.totalVnd, 0);
  assert.deepEqual(heavy.lines.map((l) => l.key).sort(), ["aiCustomers", "fanpages", "users"], "không có dòng vượt cho đơn / hội thoại / tin");
  const fair = fairUseVerdict({ aiConversations: 9000, aiReplies: 30_000 }, STARTER.included);
  assert.ok(fair.flagged && fair.review && fair.billable === false, "fair-use 200% ⇒ cờ + rà soát, KHÔNG tính tiền");
  assert.equal(fairUseVerdict({ aiConversations: 100, aiReplies: 100 }, STARTER.included).flagged, false);

  // ── Ghế: fanpage / người dùng thêm × đơn giá; không đo được ⇒ dòng đó `null`, tổng `null`.
  const seats = computeOverage(STARTER, usg({ aiCustomers: 100, fanpages: 5, users: 7 }));
  assert.equal(seats.totalVnd, 2 * 99_000 + 2 * 49_000);
  const unknownUsers = computeOverage(STARTER, usg({ aiCustomers: 100, users: null }));
  assert.equal(unknownUsers.totalVnd, null, "người dùng chưa đo ⇒ tổng chưa biết");
  assert.equal(unknownUsers.knownVnd, 0);
  // Đồng hồ đo chưa trọn kỳ / chưa đo ⇒ phần vượt khách AI `null` — cận dưới không phải số để thu.
  for (const cov of ["PARTIAL", "NOT_MEASURED"] as const) {
    const r = computeOverage(STARTER, usg({ aiCustomers: 5000, aiCustomersCoverage: cov }));
    assert.equal(r.lines.find((l) => l.key === "aiCustomers")?.amountVnd, null, `${cov} ⇒ không tính phần vượt`);
    assert.equal(r.totalVnd, null);
  }
  // Enterprise theo hợp đồng (không tự tính) · dùng thử không có phần vượt · INBOX không có dòng khách AI.
  assert.deepEqual([computeOverage(ENTERPRISE, usg({ aiCustomers: 99_999 })).totalVnd, computeOverage(ENTERPRISE, usg({})).mode], [null, "CONTRACT"]);
  assert.equal(computeOverage(TRIAL, usg({ aiCustomers: 5000 })).totalVnd, 0);
  assert.ok(!computeOverage(INBOX, usg({ aiCustomers: 50 })).lines.some((l) => l.key === "aiCustomers"));
  // Hoá đơn ước tính: gói + vượt; dùng thử = 0 thật; hợp đồng = chưa biết.
  assert.equal(estimateBill(STARTER, usg({ aiCustomers: 1601 }), { trial: false }).totalVnd, 790_000 + 118_000);
  assert.equal(estimateBill(TRIAL, usg({ aiCustomers: 1601 }), { trial: true }).totalVnd, 0);
  assert.equal(estimateBill(ENTERPRISE, usg({}), { trial: false }).totalVnd, null);

  // ── Ngưỡng 80 · 100 · 120 · 150 — và KHÔNG ngưỡng nào tắt bot.
  const lv = (used: number) => usageAlert(used, 1500);
  assert.deepEqual([lv(1199).level, lv(1200).level, lv(1500).level, lv(1501).level, lv(1800).level, lv(2250).level], ["OK", "NOTIFY", "NOTIFY", "OVERAGE", "STRONG", "REVIEW"]);
  assert.deepEqual([lv(1200).notifyCustomer, lv(1200).notifyOperator, lv(1200).overageBilling], [true, true, false], "80% ⇒ báo khách + vận hành");
  assert.deepEqual([lv(1501).overageBilling, lv(1501).suggestUpgrade], [true, false], "quá 100% ⇒ bắt đầu tính vượt");
  assert.deepEqual([lv(1800).suggestUpgrade, lv(1800).operatorReview], [true, false], "120% ⇒ cảnh báo mạnh + đề xuất nâng gói");
  assert.equal(lv(2250).operatorReview, true, "150% ⇒ người vận hành rà soát");
  for (const u of [0, 1200, 1501, 1800, 2250, 100_000]) assert.equal(usageAlert(u, 1500).pauseBot, false, "không ngưỡng nào tắt bot");
  assert.equal(usageAlert(null, 1500).level, "UNKNOWN");
  assert.deepEqual(parseUsageAlerts({ notifyPct: 90, overagePct: 80 }), DEFAULT_USAGE_ALERTS, "bộ sai thứ tự bị bỏ nguyên bộ");
  assert.equal(parseUsageAlerts({ notifyPct: 70, overagePct: 100, strongPct: 130, reviewPct: 200 }).strongPct, 130);
  // Dải biên: đích 75–85 · cảnh báo < 70 · nguy cấp < 60.
  assert.deepEqual([marginBand(59.9), marginBand(65), marginBand(72), marginBand(80), marginBand(90), marginBand(null)], ["CRITICAL", "WARN", "BELOW_TARGET", "ON_TARGET", "ABOVE_TARGET", "UNKNOWN"]);
  assert.equal(parseMarginConfig({ targetLowPct: 90, targetHighPct: 80 }).targetLowPct, 75, "bộ biên sai thứ tự ⇒ mặc định");

  // ── Gói thường nhỏ nhất vừa số dùng THẬT; thiếu số đo ⇒ không gán.
  assert.equal(smallestFittingPlan({ aiCustomers: 120, fanpages: 2, users: 4, needsAiSales: true }, V1_PRICES).plan?.planKey, "starter", "Inbox rẻ hơn nhưng không có AI bán hàng");
  assert.equal(smallestFittingPlan({ aiCustomers: 0, fanpages: 2, users: 3, needsAiSales: false }, V1_PRICES).plan?.planKey, "inbox");
  assert.equal(smallestFittingPlan({ aiCustomers: 2900, fanpages: 4, users: 4, needsAiSales: true }, V1_PRICES).plan?.planKey, "growth");
  assert.equal(smallestFittingPlan({ aiCustomers: 2000, fanpages: 12, users: 4, needsAiSales: true }, V1_PRICES).plan?.planKey, "scale", "fanpage vượt Growth");
  assert.equal(smallestFittingPlan({ aiCustomers: 50_000, fanpages: 1, users: 1, needsAiSales: true }, V1_PRICES).plan, null, "vượt mọi gói ⇒ hợp đồng");
  const missing = smallestFittingPlan({ aiCustomers: null, fanpages: 1, users: 1, needsAiSales: true }, V1_PRICES);
  assert.ok(missing.plan === null && /Chưa đo được/.test(missing.reason), "khách AI chưa đo ⇒ không gán bằng phỏng đoán");

  // ── Khoá khách AI: cùng khách cùng kỳ ⇒ cùng khoá; hai trang ⇒ hai khách; kỳ sau ⇒ khoá khác; thiếu khách ⇒ không ghi.
  const k = (page: string, cust: string, month = "2026-10") => aiCustomerEventKey({ month, channel: "FANPAGE", pageId: page, customerKey: cust });
  assert.equal(k("p1", "v1"), k("p1", "v1"));
  assert.notEqual(k("p1", "v1"), k("p2", "v1"), "hai trang khác nhau = hai khách");
  assert.notEqual(k("p1", "v1"), k("p1", "v1", "2026-11"), "kỳ sau đếm lại");
  assert.equal(aiCustomerEventKey({ month: "2026-10", channel: "FANPAGE", pageId: "p1", customerKey: null }), null);
  assert.equal(aiCustomerEventKey({ month: "2026-10", channel: "FANPAGE", pageId: "p1", customerKey: "x".repeat(300) }), null, "khoá quá dài ⇒ không cắt (cắt có thể gộp hai khách)");
  assert.equal(meterMonthOf(new Date("2026-10-31T16:59:59Z")), "2026-10", "23:59 giờ VN ngày 31 vẫn là tháng 10");
  assert.equal(meterMonthOf(new Date("2026-10-31T17:00:00Z")), "2026-11", "00:00 giờ VN ngày 1 sang tháng 11");
  // Độ phủ: runtime cũ ⇒ CHƯA ĐO (null), không phải 0; đồng hồ bật giữa kỳ ⇒ chưa trọn.
  const pf = new Date("2026-10-01T00:00:00+07:00");
  assert.equal(aiCustomerCoverage({ aiSalesOn: false, legacyChatbotOn: true, meterLiveAt: new Date("2026-09-01"), periodFrom: pf }).coverage, "NOT_MEASURED");
  assert.equal(aiCustomerCoverage({ aiSalesOn: true, legacyChatbotOn: true, meterLiveAt: new Date("2026-09-01"), periodFrom: pf }).coverage, "PARTIAL");
  assert.equal(aiCustomerCoverage({ aiSalesOn: true, legacyChatbotOn: false, meterLiveAt: new Date("2026-10-07"), periodFrom: pf }).coverage, "PARTIAL");
  assert.equal(aiCustomerCoverage({ aiSalesOn: true, legacyChatbotOn: false, meterLiveAt: new Date("2026-09-01"), periodFrom: pf }).coverage, "MEASURED");
  assert.equal(aiCustomerCoverage({ aiSalesOn: true, legacyChatbotOn: false, meterLiveAt: null, periodFrom: pf }).coverage, "NOT_MEASURED");

  // ── Phiên bản: legacy chỉ thay GIÁ; catalog thay giá + phần thương mại; gia hạn đúng gói giữ giá ghim, đổi gói đi giá hiện hành.
  const legacyStarter = parsePlanPrice({ versionKey: "legacy", planKey: "starter", name: "Khởi đầu", description: null, position: 20, listed: false, highlight: false, contactSales: false, monthlyVnd: 499_000, yearlyVnd: null, yearlyFreeMonths: 2, priceFromVnd: null, trialDays: null, included: {}, overage: { mode: "NONE" }, features: null, addonPrices: { users: 79_000 }, limits: {}, commercial: {} });
  const legacyPro = parsePlanPrice({ ...legacyStarter, planKey: "pro", name: "Chuyên nghiệp", monthlyVnd: "1990000", addonPrices: {} });
  assert.equal(legacyPro.monthlyVnd, 1_990_000, "bigint đọc từ chuỗi");
  const versions: PriceVersion[] = [
    { key: "legacy", label: "Giá cũ", kind: "LEGACY_SNAPSHOT", effectiveFrom: null, taxMode: "UNDECLARED", taxNote: null, alerts: DEFAULT_USAGE_ALERTS, note: null },
    { key: V1, label: "V1", kind: "CATALOG", effectiveFrom: new Date("2026-10-06T17:00:00Z"), taxMode: "UNDECLARED", taxNote: null, alerts: DEFAULT_USAGE_ALERTS, note: null },
    { key: "v2-future", label: "V2", kind: "CATALOG", effectiveFrom: new Date("2099-01-01T00:00:00Z"), taxMode: "UNDECLARED", taxNote: null, alerts: DEFAULT_USAGE_ALERTS, note: null },
  ];
  const book: PriceBook = { versions, prices: [legacyStarter, legacyPro, ...V1_PRICES, { ...STARTER, versionKey: "v2-future", monthlyVnd: 990_000, yearlyVnd: null }] };
  const now = new Date("2026-10-07T03:00:00Z");
  assert.equal(currentCatalogVersion(book, now)?.key, V1, "phiên bản tương lai chưa hiệu lực");
  assert.equal(currentCatalogVersion(book, new Date("2099-02-01T00:00:00Z"))?.key, "v2-future");
  assert.equal(priceOf(book, V1, "pro")?.source, "LEGACY_FALLBACK", "gói cũ không có ở V1 ⇒ giữ giá legacy cho thuê bao đang dùng");
  const lost = resolveOrgVersion(book, "phien-ban-da-mat", now);
  assert.deepEqual([lost.version?.key, lost.pinned], ["legacy", true], "ghim trỏ phiên bản mất ⇒ giá cũ + cảnh báo, không bao giờ V1");
  assert.equal(resolveOrgVersion(book, null, now).version?.key, V1, "chỉ tổ chức KHÔNG có ghim mới theo bảng giá hiện hành");
  const renewLegacy = renewalPricing({ book, pinKey: "legacy", now, currentPlanKey: "starter", targetPlanKey: "starter" });
  assert.ok(!("error" in renewLegacy) && renewLegacy.target.monthlyVnd === 499_000 && renewLegacy.targetVersionKey === "legacy", "gia hạn đúng gói ⇒ giá ghim (khách hiện tại không đổi số tiền)");
  const switchV1 = renewalPricing({ book, pinKey: "legacy", now, currentPlanKey: "starter", targetPlanKey: "growth" });
  assert.ok(!("error" in switchV1) && switchV1.target.monthlyVnd === 1_490_000 && switchV1.targetVersionKey === V1 && switchV1.current?.monthlyVnd === 499_000, "đổi gói ⇒ giá hiện hành, phần trừ theo giá ghim");
  assert.ok("error" in renewalPricing({ book, pinKey: "legacy", now, currentPlanKey: "starter", targetPlanKey: "pro" }), "gói cũ không còn bán mới");
  assert.ok("error" in renewalPricing({ book, pinKey: null, now, currentPlanKey: "trial", targetPlanKey: "enterprise" }), "Enterprise = hợp đồng, không tự mua");
  const futureRenew = renewalPricing({ book, pinKey: V1, now: new Date("2099-02-01T00:00:00Z"), currentPlanKey: "starter", targetPlanKey: "starter" });
  assert.ok(!("error" in futureRenew) && futureRenew.target.monthlyVnd === 790_000, "phiên bản mới ra đời KHÔNG đổi giá tổ chức đã ghim V1");
  const planRow = { key: "starter", name: "Khởi đầu", description: null, limits: { users: 5, ai: { platformCreditUsdPerMonth: 3 } }, position: 20, priceVnd: 1, addonPrices: {}, yearlyFreeMonths: 0, commercial: { features: ["api"] } };
  const leg = overlayPlanRow(planRow, { price: legacyStarter, source: "VERSION" }, "LEGACY_SNAPSHOT");
  assert.deepEqual([leg.priceVnd, leg.name, leg.commercial, leg.yearlyPriceVnd], [499_000, "Khởi đầu", planRow.commercial, 499_000 * 10], "legacy: chỉ thay giá");
  const cat = overlayPlanRow(planRow, { price: { ...STARTER, commercial: { features: ["ai_sales"] } }, source: "VERSION" }, "CATALOG");
  assert.deepEqual([cat.priceVnd, cat.name, (cat.limits as { users: number }).users, cat.yearlyPriceVnd, cat.commercial], [790_000, "starter", 5, 7_900_000, { features: ["ai_sales"] }], "catalog: giá + phần thương mại + người dùng gồm");
  assert.equal(overlayPlanRow(planRow, null, "CATALOG").priceVnd, null, "không có dòng giá ⇒ không bán");
  // Giá năm TƯỜNG MINH đi vào hoá đơn 12 tháng; tháng khác theo giá tháng.
  const terms = { billingEnabled: true, paidThrough: "2026-10-20", graceDays: 7 };
  const q12 = quoteRenewal({ terms, currentPlan: null, target: { key: "growth", name: "Growth", priceVnd: 1_490_000, yearlyFreeMonths: 2, yearlyPriceVnd: 14_000_000 }, months: 12, today: "2026-10-11" });
  assert.ok(!("error" in q12) && q12.listAmountVnd === 14_000_000, "giá năm tường minh của phiên bản thắng phép nhân");
  const q3 = quoteRenewal({ terms, currentPlan: null, target: { key: "growth", name: "Growth", priceVnd: 1_490_000, yearlyFreeMonths: 2, yearlyPriceVnd: 14_000_000 }, months: 3, today: "2026-10-11" });
  assert.ok(!("error" in q3) && q3.listAmountVnd === 3 * 1_490_000);

  // ── KPI giá trị: chỉ số chưa đo được khai UNAVAILABLE + thiếu gì; mẫu số 0 ⇒ null.
  assert.equal(VALUE_KPI_SPEC.cross_sell_rate.availability, "UNAVAILABLE");
  assert.ok((VALUE_KPI_SPEC.cross_sell_rate.missingWhat ?? "").length > 40);
  const empty = buildValueKpis({ attribution: null, aiOrders: null, funnel: { conversations: 0, quoted: 0, identified: 0, drafted: 0, confirmed: 0 }, upsell: { offered: 0, accepted: 0 } });
  assert.deepEqual([empty.conversion_rate, empty.upsell_rate, empty.cross_sell_rate, empty.orders_assisted], [null, null, null, null], "mẫu số 0 / chưa đo ⇒ null, không bao giờ 0%");
  const r = { orders: 0, valueVnd: 0, delivered: 0, deliveredRevenueVnd: 0, settled: 0, cancelled: 0, grossProfitVnd: 0, costedRevenueVnd: 0, cogsUnknown: 0, cogsUnknownRevenueVnd: 0 };
  const kp = buildValueKpis({ attribution: { AI_ONLY: { ...r, orders: 3, valueVnd: 900_000, deliveredRevenueVnd: 600_000 }, AI_ASSISTED: { ...r, orders: 2, valueVnd: 500_000, deliveredRevenueVnd: 0 }, HUMAN_ONLY: { ...r, orders: 9, valueVnd: 9_000_000 }, unattributed: 1 }, aiOrders: 4, funnel: { conversations: 20, quoted: 10, identified: 8, drafted: 6, confirmed: 5 }, upsell: { offered: 10, accepted: 3 } });
  assert.deepEqual([kp.orders_closed_by_ai, kp.orders_assisted, kp.revenue_attributed_to_ai, kp.gmv_attributed_to_ai, kp.conversion_rate, kp.upsell_rate], [3, 2, 600_000, 1_400_000, 0.25, 0.3], "doanh thu theo ORDER_OUTCOME, GMV = giá trị lúc tạo, người bán không tính cho AI");
  assert.equal(VALUE_KPI_KEYS.length, 8);

  // ── Trần AI kỹ thuật của gói AI V1: không trần cứng; ngân sách mềm = giá tháng × (1 − biên nguy cấp) ÷ tỷ giá.
  const vPrices = V1_PRICES;
  const ai = catalogAiLimits({ hit: { price: GROWTH, source: "VERSION" }, versionKind: "CATALOG", versionPrices: vPrices, criticalBelowPct: 60, usdToVnd: 25_000 });
  assert.deepEqual(ai, { requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: 23.84, hard: null }, platformCreditUsdPerMonth: 23.84, softOnly: true }, "Growth: 1.490.000 × 40% ÷ 25.000");
  const trialAi = catalogAiLimits({ hit: { price: TRIAL, source: "VERSION" }, versionKind: "CATALOG", versionPrices: vPrices, criticalBelowPct: 60, usdToVnd: 25_000 });
  assert.deepEqual(trialAi, { requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: 12.64, hard: 12.64 }, platformCreditUsdPerMonth: 12.64 }, "dùng thử (chưa trả tiền): ngân sách theo gói AI rẻ nhất, GIỮ trần tiền cứng");
  assert.equal(evaluateAiQuota("PLATFORM", trialAi!, { requestsToday: 1, requestsMonth: 1, costUsdMonth: 12.7, unknownCostMonth: 0 }).ok, false, "dùng thử vượt ngân sách ⇒ dừng (chính sách chi phí của tổ chức chưa trả tiền)");
  const noRate = catalogAiLimits({ hit: { price: GROWTH, source: "VERSION" }, versionKind: "CATALOG", versionPrices: vPrices, criticalBelowPct: 60, usdToVnd: 0 });
  assert.deepEqual([noRate?.costUsdPerMonth.soft, noRate?.costUsdPerMonth.hard, noRate?.softOnly], [null, null, true], "tỷ giá thiếu ⇒ ngân sách chưa biết");
  assert.equal(evaluateAiQuota("PLATFORM", noRate!, big0()).ok, true, "ngân sách chưa biết ⇒ không chặn (không thành NO_PLATFORM_CREDIT)");
  assert.equal(catalogAiLimits({ hit: { price: ENTERPRISE, source: "VERSION" }, versionKind: "CATALOG", versionPrices: vPrices, criticalBelowPct: 60, usdToVnd: 25_000 })?.platformCreditUsdPerMonth, 95.84, "hợp đồng: giá «từ …»");
  assert.equal(catalogAiLimits({ hit: { price: INBOX, source: "VERSION" }, versionKind: "CATALOG", versionPrices: vPrices, criticalBelowPct: 60, usdToVnd: 25_000 }), null, "INBOX: AI bán hàng tắt bằng entitlement, không bằng trần");
  assert.equal(catalogAiLimits({ hit: { price: STARTER, source: "VERSION" }, versionKind: "LEGACY_SNAPSHOT", versionPrices: vPrices, criticalBelowPct: 60, usdToVnd: 25_000 }), null, "legacy giữ trần cũ");
  assert.equal(catalogAiLimits({ hit: { price: STARTER, source: "LEGACY_FALLBACK" }, versionKind: "CATALOG", versionPrices: vPrices, criticalBelowPct: 60, usdToVnd: 25_000 }), null, "gói cũ đọc dòng legacy giữ trần cũ");
  const big = { requestsToday: 99_999, requestsMonth: 999_999, costUsdMonth: 9_999, unknownCostMonth: 0 };
  const v1Verdict = evaluateAiQuota("PLATFORM", ai!, big);
  assert.ok(v1Verdict.ok && v1Verdict.softExceeded, "dùng gấp nhiều lần ngân sách ⇒ vẫn cho chạy, chỉ cảnh báo");
  assert.equal(evaluateAiQuota("PLATFORM", { ...ai!, softOnly: false }, big).ok, false, "bỏ softOnly ⇒ credit thành trần cứng (đột biến phải đỏ)");

  // ── Đổi gói không được lặng lẽ chặn AI: trần AI kỹ thuật của gói đích thấp hơn số dùng thật ⇒ không gán.
  const lim = { requestsPerDay: 30, requestsPerMonth: 500, costUsdPerMonth: { soft: 30, hard: 60 }, platformCreditUsdPerMonth: 3 };
  assert.equal(aiLimitCheck({ requests: 400, costUsd: 10 }, lim).wouldExceed, false);
  assert.equal(aiLimitCheck({ requests: 501, costUsd: 10 }, lim).wouldExceed, true, "lượt / tháng vượt trần ⇒ không gán");
  assert.equal(aiLimitCheck({ requests: 10, costUsd: 61 }, lim).wouldExceed, true, "tiền AI vượt trần cứng ⇒ không gán");
  assert.equal(aiLimitCheck({ requests: 10_000, costUsd: 10_000 }, { ...lim, requestsPerMonth: null, costUsdPerMonth: { soft: null, hard: null } }).wouldExceed, false);
}

function testSource() {
  const goc = path.resolve(__dirname, "..");
  const ac = readFileSync(path.join(goc, "lib/pricing/ai-customer.ts"), "utf8");
  const note = ac.slice(ac.indexOf("export async function noteAiCustomerReply"), ac.indexOf("/** Số khách AI ĐÃ GHI"));
  assert.ok(/try \{[\s\S]*\} catch/.test(note), "lỗi ghi sổ bị nuốt — không làm hỏng việc gửi");
  // Hoá đơn không đọc thẳng giá ở `platform_plans` nữa — mọi đường giá đi qua sổ giá có phiên bản.
  const svc = readFileSync(path.join(goc, "lib/billing/service.ts"), "utf8");
  for (const fn of ["previewRenewal", "previewAddon", "loadTenantBilling"]) {
    const s = svc.slice(svc.indexOf(`export async function ${fn}`));
    const b = s.slice(0, s.indexOf("\n}\n"));
    assert.ok(!/listPlans\(\)/.test(b), `${fn} không đọc giá thẳng từ platform_plans`);
  }
}

// ─────────────────────────── 2 · VÒNG THẬT ───────────────────────────

async function cleanup(saved: { meterLive: unknown }) {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSaasDaily).where(inArray(schema.platformSaasDaily.orgCode, [...ORGS]));
  await pdb.delete(schema.platformTenantUsageDaily).where(inArray(schema.platformTenantUsageDaily.orgCode, [...ORGS]));
  await pdb.delete(schema.platformOrgMilestones).where(inArray(schema.platformOrgMilestones.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  const extra = await pdb.select({ key: schema.platformPriceVersions.key }).from(schema.platformPriceVersions).where(like(schema.platformPriceVersions.key, "cat-%"));
  if (extra.length) {
    const keys = extra.map((e) => e.key);
    await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.versionKey, keys));
    await pdb.delete(schema.platformPlanPrices).where(inArray(schema.platformPlanPrices.versionKey, keys));
    await pdb.delete(schema.platformPriceVersions).where(inArray(schema.platformPriceVersions.key, keys));
  }
  if (saved.meterLive === undefined) await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY));
  else await pdb.update(schema.platformSettings).set({ value: saved.meterLive }).where(eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformInvoices).where(inArray(schema.platformInvoices.orgCode, [...ORGS]));
  await pdb.delete(schema.platformOrgPricing).where(inArray(schema.platformOrgPricing.orgCode, [...ORGS]));
  const home = await getHomeOrganization();
  await pdb.delete(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, home.code), inArray(schema.platformAuditLog.action, ["PRICE_VERSION_PUBLISH"])));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, code));
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
      if (org.accountId) {
        const still = await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.accountId, org.accountId)).limit(1);
        if (!still.length) {
          await pdb.delete(schema.platformBillingStatements).where(eq(schema.platformBillingStatements.accountId, org.accountId));
          await pdb.delete(schema.platformAccounts).where(eq(schema.platformAccounts.id, org.accountId));
        }
      }
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  await pdb.execute(sql.raw("DROP TRIGGER IF EXISTS pv1_fail_usage ON platform_usage_events"));
  await pdb.execute(sql.raw("DROP FUNCTION IF EXISTS pv1_fail_usage_fn()"));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
  invalidatePriceBook();
  resetAiCustomerSeenForTests();
}

async function setOrgPlan(code: string, plan: string | null) {
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformOrganizations).set({ plan }).where(eq(schema.platformOrganizations.code, code));
  invalidateOrganizations();
  invalidatePricing();
}

async function setMeterLive(at: Date) {
  const pdb = await getPlatformDb();
  const value = { at: at.toISOString() };
  await pdb.insert(schema.platformSettings).values({ key: AI_CUSTOMER_METER_LIVE_KEY, value }).onConflictDoUpdate({ target: schema.platformSettings.key, set: { value } });
}

/** Gieo `n` khách AI đã ghi vào sổ của `org` ở mốc `at` (thô — như n lượt ghi thành công khác khoá). */
async function seedAiCustomers(org: string, n: number, at: Date, tag: string) {
  const pdb = await getPlatformDb();
  await pdb.execute(sql`
    insert into platform_usage_events (id, occurred_at, org_code, product_key, metric, quantity, unit, source, event_key, metadata)
    select gen_random_uuid()::text, ${at.toISOString()}::timestamptz, ${org}, 'chotdon', 'ai_customers', 1, 'khách AI', 'test', ${`ai_customer:${meterMonthOf(at)}:FANPAGE:seed-${tag}:`} || g::text, '{}'::jsonb
    from generate_series(1, ${n}) g`);
}

export async function testPricingV1() {
  testPure();
  testSource();
  const pdb = await getPlatformDb();
  const savedMeter = (await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY) }))?.value;
  const saved = { meterLive: savedMeter };
  await cleanup(saved);
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "pv1-op", email: "op@pv1.local", organization: { code: home.code, name: home.name, isHome: true } });

  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: code === LEG ? ["customers"] : ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "PricingV1@12345" }, source: "TEST", actor: null });
  try {
    // ── 1. Migration gieo V1 ĐÚNG số + legacy chép ĐÚNG platform_plans.
    invalidatePriceBook();
    const book = await loadPriceBook({ fresh: true });
    const now = new Date();
    assert.equal(currentCatalogVersion(book, now)?.key, V1, "V1 là bảng giá đang niêm yết");
    const v1 = (k: string) => book.prices.find((p) => p.versionKey === V1 && p.planKey === k)!;
    assert.deepEqual(
      ["trial", "inbox", "starter", "growth", "scale", "enterprise"].map((k) => [k, v1(k).monthlyVnd, v1(k).yearlyVnd, v1(k).priceFromVnd, v1(k).included.aiCustomers, v1(k).included.fanpages, v1(k).included.users, v1(k).overage.aiCustomerBlockVnd]),
      [
        ["trial", null, null, null, 100, 1, 2, null],
        ["inbox", 299_000, 2_990_000, null, 0, 3, 3, null],
        ["starter", 790_000, 7_900_000, null, 1500, 3, 5, 59_000],
        ["growth", 1_490_000, 14_900_000, null, 3000, 10, 10, 49_000],
        ["scale", 2_990_000, 29_900_000, null, 7500, 30, 25, 39_000],
        ["enterprise", null, null, 5_990_000, null, null, null, null],
      ],
    );
    assert.deepEqual([v1("starter").included.aiConversations, v1("starter").included.aiReplies, v1("growth").included.aiConversations, v1("scale").included.aiReplies, v1("trial").trialDays], [4500, 30_000, 10_000, 200_000, 7]);
    assert.ok(v1("growth").highlight && v1("enterprise").contactSales && v1("enterprise").overage.mode === "CONTRACT");
    assert.ok(!(v1("inbox").features ?? []).includes("ai_sales") && (v1("starter").features ?? []).includes("ai_sales"), "INBOX không có AI bán hàng");
    for (const k of ["starter", "growth", "scale", "inbox"]) assert.deepEqual([v1(k).overage.extraFanpageVnd, v1(k).overage.extraUserVnd], [99_000, 49_000]);
    assert.ok(["trial", "inbox", "starter", "growth", "scale", "enterprise"].every((k) => v1(k).included.orders === null), "đơn không giới hạn ở mọi gói");
    const versionRow = book.versions.find((v) => v.key === V1)!;
    assert.deepEqual([versionRow.taxMode, versionRow.alerts], ["UNDECLARED", { notifyPct: 80, overagePct: 100, strongPct: 120, reviewPct: 150 }], "không giả định VAT; ngưỡng 80/100/120/150");
    const plans = await listPlans();
    for (const p of plans) {
      const legacy = book.prices.find((x) => x.versionKey === "legacy" && x.planKey === p.key);
      if (!legacy) {
        assert.ok(["inbox", "scale"].includes(p.key), `gói ${p.key} có từ trước 0228 phải có dòng legacy`);
        continue;
      }
      assert.deepEqual([legacy.monthlyVnd, legacy.yearlyFreeMonths, JSON.stringify(legacy.addonPrices)], [p.priceVnd !== null && p.priceVnd > 0 ? p.priceVnd : null, p.yearlyFreeMonths, JSON.stringify(p.addonPrices)], `legacy ${p.key} chép đúng giá đang thu`);
    }
    assert.ok(!book.prices.some((x) => x.versionKey === V1 && ["basic", "pro", "internal", "standard"].includes(x.planKey)), "gói cũ không niêm yết ở V1");
    if (savedMeter === undefined) {
      const live = await readAiCustomerMeterLiveAt();
      assert.ok(live && live.getTime() <= Date.now(), "mốc đồng hồ khách AI = lúc 0228 ghi phiên bản V1 (không cần dòng cài đặt)");
    }

    // ── 2. Ghim legacy cho tổ chức có từ trước: đúng câu của migration (idempotent); tổ chức tạo sau KHÔNG bị ghim.
    const pinsBefore = new Set((await pdb.select({ o: schema.platformPricePins.orgCode }).from(schema.platformPricePins)).map((r) => r.o));
    const mig = readFileSync(path.join(process.cwd(), "drizzle/0228_pricing_v1_versions.sql"), "utf8");
    const pinSql = mig.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes('INSERT INTO "platform_price_pins"'));
    assert.ok(pinSql, "migration phải có câu ghim legacy");
    await pdb.execute(sql.raw(pinSql!.replace(/^--.*$/gm, "")));
    await pdb.execute(sql.raw(pinSql!.replace(/^--.*$/gm, "")));
    const added = (await pdb.select({ o: schema.platformPricePins.orgCode }).from(schema.platformPricePins)).map((r) => r.o).filter((o) => !pinsBefore.has(o) && o !== LEG);
    await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, added.length ? added : ["-"]));
    invalidatePriceBook();
    assert.equal((await pdb.select().from(schema.platformPricePins).where(eq(schema.platformPricePins.orgCode, LEG)))[0]?.versionKey, "legacy");

    // ── 3. HOÁ ĐƠN LEGACY TRƯỚC / SAU BẰNG NHAU — báo giá theo phiên bản = báo giá cũ đọc thẳng platform_plans.
    await setOrgPlan(LEG, "starter");
    const today = vnDate(now);
    await pdb.insert(schema.platformSubscriptions).values({ orgCode: LEG, billingEnabled: true, paidThrough: addDays(today, 20), graceDays: 7 });
    invalidateSubscriptions(LEG);
    const rawStarter = plans.find((p) => p.key === "starter")!;
    const oldEngine = { key: rawStarter.key, name: rawStarter.name, priceVnd: rawStarter.priceVnd, yearlyFreeMonths: rawStarter.yearlyFreeMonths };
    for (const months of [1, 3, 6, 12]) {
      const after = await previewRenewal(LEG, "starter", months, now);
      const before = quoteRenewal({ terms: { billingEnabled: true, paidThrough: addDays(today, 20), graceDays: 7 }, currentPlan: oldEngine, target: oldEngine, months, today, targetAddonMonthlyVnd: 0, currentAddonMonthlyVnd: 0 });
      assert.ok(!("error" in after) && !("error" in before), JSON.stringify({ after, before }));
      if (!("error" in after) && !("error" in before)) {
        assert.deepEqual([after.listAmountVnd, after.amountVnd, after.periodStart, after.periodEnd, after.kind], [before.listAmountVnd, before.amountVnd, before.periodStart, before.periodEnd, before.kind], `legacy ${months} tháng: số tiền không đổi sau 0228`);
        assert.equal(after.priceVersionKey, "legacy");
      }
    }
    const legPlans = await plansForOrg(LEG, now);
    assert.equal(legPlans.find((p) => p.key === "starter")?.priceVnd, rawStarter.priceVnd, "MRR / màn khách đọc giá ghim");
    const legView = await loadTenantBilling(LEG, now);
    assert.equal(legView?.offers.find((o) => o.key === "starter")?.priceVnd, rawStarter.priceVnd, "gói đang dùng gia hạn được ở giá cũ");
    assert.ok(legView?.offers.some((o) => o.key === "growth" && o.priceVnd === 1_490_000), "gói khác hiện giá V1");
    const legSwitch = await previewRenewal(LEG, "growth", 1, now);
    assert.ok(!("error" in legSwitch) && legSwitch.priceVersionKey === V1, "đổi gói ⇒ giá V1");
    // Lỗi ĐỌC ghim (CSDL chập) ⇒ từ chối báo giá / bỏ ảnh chụp MRR — KHÔNG BAO GIỜ rơi về V1 (hoá đơn ấy sẽ ghim khách cũ vào V1).
    await pdb.execute(sql.raw("ALTER TABLE platform_price_pins RENAME TO platform_price_pins_tam"));
    invalidatePriceBook();
    try {
      const blip = await previewRenewal(LEG, "starter", 1, now);
      assert.ok("error" in blip, `lỗi đọc ghim ⇒ không báo giá (nhận ${JSON.stringify(blip).slice(0, 120)})`);
      const blipV1 = await previewRenewal(LEG, "growth", 1, now);
      assert.ok("error" in blipV1, "kể cả đổi gói — không đoán khách là tổ chức mới");
      const snapBlip = await captureSaasSnapshot(now);
      assert.ok(snapBlip.errors.some((e) => e.startsWith(`${LEG}:`)), "ảnh chụp MRR bỏ dòng tổ chức không đọc được giá (không ghi 0)");
      assert.equal(await hasFeature("ai_sales", { orgCode: A }), true, "đường entitlement vẫn chạy (đọc phía hẹp)");
    } finally {
      await pdb.execute(sql.raw("ALTER TABLE platform_price_pins_tam RENAME TO platform_price_pins"));
      invalidatePriceBook();
    }
    assert.equal((await pdb.select().from(schema.platformSaasDaily).where(and(eq(schema.platformSaasDaily.orgCode, LEG), eq(schema.platformSaasDaily.day, today)))).length, 0, "không dòng MRR bịa cho LEG");

    // ── 4. Phiên bản mới (người vận hành sửa giá) KHÔNG đổi giá tổ chức đã ghim; lịch sử tái lập được.
    await setOrgPlan(A, "starter");
    await pinOrgPriceVersion(A, V1, { source: "TEST", reason: "bài kiểm", email: null });
    await pdb.insert(schema.platformSubscriptions).values({ orgCode: A, billingEnabled: true, paidThrough: addDays(today, 20), graceDays: 7 });
    invalidateSubscriptions(A);
    const beforeA = await previewRenewal(A, "starter", 1, now);
    assert.ok(!("error" in beforeA) && beforeA.listAmountVnd === 790_000);
    const outsider = sessionUser({ id: "pv1-out", permissions: ["platform:operate"], organization: { code: B, name: B, isHome: false } });
    assert.ok("error" in (await setPlanPrice(outsider, { planKey: "starter", priceVnd: 890_000, reason: "đổi giá" })), "người ngoài không đổi được giá");
    assert.ok("error" in (await setPlanPrice(op, { planKey: "pro", priceVnd: 2_000_000, reason: "gói cũ" })), "gói cũ không sửa ảnh chụp — chuyển phiên bản");
    const pub = await setPlanPrice(op, { planKey: "starter", priceVnd: 890_000, reason: "Chốt giá Starter mới" });
    assert.ok("ok" in pub, JSON.stringify(pub));
    const afterA = await previewRenewal(A, "starter", 1, now);
    assert.ok(!("error" in afterA) && afterA.listAmountVnd === 790_000 && afterA.priceVersionKey === V1, "tổ chức ghim V1 giữ 790.000");
    const afterLeg = await previewRenewal(LEG, "starter", 1, now);
    assert.ok(!("error" in afterLeg) && afterLeg.listAmountVnd === rawStarter.priceVnd, "tổ chức ghim legacy giữ giá cũ");
    const fresh = await previewRenewal(B, "starter", 1, new Date());
    assert.ok(!("error" in fresh) && fresh.listAmountVnd === 890_000 && fresh.priceVersionKey.startsWith("cat-"), "tổ chức chưa ghim mua mới ⇒ giá của phiên bản mới");
    const book2 = await loadPriceBook({ fresh: true });
    assert.equal(priceOf(book2, V1, "starter")?.price.monthlyVnd, 790_000, "dòng V1 không bị sửa — tính lại kỳ cũ ra đúng số cũ");
    assert.equal(estimateBill(priceOf(book2, V1, "starter")!.price, usg({ aiCustomers: 1601 }), { trial: false }).totalVnd, 908_000);
    assert.equal(book2.versions.filter((v) => v.key.startsWith("cat-")).length, 1, "một lần sửa ⇒ một phiên bản mới");
    // Dọn phiên bản thử để phần sau đọc V1 là bảng giá hiện hành.
    const cat = book2.versions.filter((v) => v.key.startsWith("cat-")).map((v) => v.key);
    await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.versionKey, cat));
    await pdb.delete(schema.platformPlanPrices).where(inArray(schema.platformPlanPrices.versionKey, cat));
    await pdb.delete(schema.platformPriceVersions).where(inArray(schema.platformPriceVersions.key, cat));
    invalidatePriceBook();

    // ── 5. Entitlement: INBOX không có ai_sales; hạn mức người dùng / fanpage đọc từ phiên bản. Không so tên gói ở runtime.
    await setOrgPlan(B, "inbox");
    assert.equal(await hasFeature("ai_sales", { orgCode: B }), false, "INBOX không có AI bán hàng");
    assert.equal(await hasFeature("multi_page_inbox", { orgCode: B }), true);
    const pB = await resolveOrgPricing({ code: B, isHome: false, plan: "inbox" });
    assert.deepEqual([pB.quotas.users, pB.quotas.fanpages, pB.plan?.priceVersionKey], [3, 3, V1]);
    await setOrgPlan(B, "growth");
    assert.equal(await hasFeature("ai_sales", { orgCode: B }), true);
    await setOrgPlan(B, null);

    // ── 5b. Trần kỹ thuật theo phiên bản: người dùng + AI. V1 đọc phiên bản; legacy giữ platform_plans.
    const usersLimit = async (code: string) => (await getPlanUsage(code)).rows.find((r) => r.kind === "users")?.limit;
    const legacyUsers = (code: string) => (plans.find((p) => p.key === code)?.limits as { users?: number }).users;
    for (const [plan, users] of [["trial", 2], ["inbox", 3], ["starter", 5], ["growth", 10], ["scale", 25]] as const) {
      await setOrgPlan(B, plan);
      assert.equal(await usersLimit(B), users, `V1 ${plan}: ${users} người dùng (checkEntitlement đọc phiên bản)`);
      const pq = await resolveOrgPricing({ code: B, isHome: false, plan });
      assert.equal(pq.quotas.users, users);
    }
    await setOrgPlan(B, null);
    assert.equal(await usersLimit(LEG), legacyUsers("starter"), "legacy: người dùng theo platform_plans cũ");
    assert.equal(await usersLimit(A), 5, "A (Starter V1) = 5");
    // Phần mua thêm đã có (0192) cộng TRÊN số gồm của phiên bản.
    await setOrgPlan(B, "growth");
    await pdb.insert(schema.platformSubscriptions).values({ orgCode: B, addons: { users: 2 } }).onConflictDoUpdate({ target: schema.platformSubscriptions.orgCode, set: { addons: { users: 2 } } });
    invalidateSubscriptions(B);
    assert.equal(await usersLimit(B), 12, "Growth V1 10 + mua thêm 2");
    await pdb.delete(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, B));
    invalidateSubscriptions(B);
    await setOrgPlan(B, null);
    // AI: tổ chức V1 Starter / Scale dùng GẤP ĐÔI mọi trần cũ ⇒ checkAiQuota vẫn cho; legacy bị chặn như cũ.
    await setOrgPlan(B, "scale");
    const scaleLimits = await resolveAiLimits(B);
    assert.ok(scaleLimits?.limits.softOnly && scaleLimits.limits.platformCreditUsdPerMonth > 0, "Scale V1: credit nền tảng = ngân sách mềm > 0 (credit 0 ở platform_plans không chặn)");
    assert.equal(scaleLimits?.limits.platformCreditUsdPerMonth, Math.round(((2_990_000 * 0.4) / env.facebook.usdToVnd) * 100) / 100);
    // Sổ AI đếm LƯỢT = dòng: gấp đôi trần lượt / ngày cũ của Starter + một lượt tốn gấp đôi trần tiền / credit.
    const starterOld = parseAiLimits(plans.find((p) => p.key === "starter")?.limits).limits;
    const rowsNeeded = 2 * (starterOld.requestsPerDay ?? 30) + 1;
    const bigCost = 2 * Math.max(starterOld.costUsdPerMonth.hard ?? 60, starterOld.platformCreditUsdPerMonth, scaleLimits!.limits.platformCreditUsdPerMonth) + 1;
    const usageAi = async (org: string) => {
      for (let i = 0; i < rowsNeeded; i++) await recordAiUsage({ orgCode: org, feature: "copilot", source: "PLATFORM", provider: "gemini", model: "gemini-3.1-flash-lite", requests: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.001, status: "OK", actorId: null, eventKey: `pv1-ai-${org}-${i}` });
      await recordAiUsage({ orgCode: org, feature: "copilot", source: "PLATFORM", provider: "gemini", model: "gemini-3.1-flash-lite", requests: 1, inputTokens: 1, outputTokens: 1, costUsd: bigCost, status: "OK", actorId: null, eventKey: `pv1-ai-${org}-big` });
    };
    for (const org of [A, B]) {
      await usageAi(org);
      const v = await checkAiQuota(org, "PLATFORM", { now: new Date(), notify: false });
      assert.ok(v.ok && v.softExceeded, `${org}: gói AI V1 dùng 2× ⇒ AI vẫn chạy, chỉ cảnh báo (${"error" in v ? v.error : ""})`);
    }
    await setOrgPlan(LEG, "starter");
    await usageAi(LEG);
    const legAi = await checkAiQuota(LEG, "PLATFORM", { now: new Date(), notify: false });
    assert.equal(legAi.ok, false, "legacy giữ trần cũ y nguyên");
    assert.equal((await resolveAiLimits(LEG))?.limits.softOnly, undefined);
    // Lỗi ĐỌC ghim tạm thời: tổ chức V1 Scale KHÔNG rơi về platform_plans thô (credit 0 ⇒ chặn bot) — dùng lần đọc tốt gần nhất,
    // chưa có thì không chặn.
    await setOrgPlan(B, "scale");
    await resolveAiLimits(B);
    await pdb.execute(sql.raw("ALTER TABLE platform_price_pins RENAME TO platform_price_pins_tam"));
    invalidatePriceBook();
    try {
      assert.equal((await resolveAiLimits(B))?.limits.softOnly, true, "lỗi đọc ⇒ trần AI đọc được gần nhất");
      assert.ok((await checkAiQuota(B, "PLATFORM", { now: new Date(), notify: false })).ok, "Scale V1: lỗi đọc ghim không chặn bot");
      resetAiLimitsMemoForTests();
      assert.ok((await checkAiQuota(B, "PLATFORM", { now: new Date(), notify: false })).ok, "chưa từng đọc được ⇒ không chặn (mềm)");
    } finally {
      await pdb.execute(sql.raw("ALTER TABLE platform_price_pins_tam RENAME TO platform_price_pins"));
      invalidatePriceBook();
    }
    // Cô lập đệm «đọc được gần nhất»: A (Starter) đọc thành công, B CÙNG gói đọc lỗi ⇒ B KHÔNG nhận giá trị của A.
    resetAiLimitsMemoForTests();
    const aGood = await resolveAiLimits(A);
    assert.ok(aGood?.limits.softOnly && aGood.limits.platformCreditUsdPerMonth > 0);
    await setOrgPlan(B, "starter");
    await pdb.execute(sql.raw("ALTER TABLE platform_price_pins RENAME TO platform_price_pins_tam"));
    invalidatePriceBook();
    try {
      const bRead = await resolveAiLimits(B);
      assert.deepEqual([bRead?.limits.platformCreditUsdPerMonth, bRead?.limits.costUsdPerMonth.soft, bRead?.limits.softOnly], [0, null, true], "B lỗi đọc ⇒ AI_LIMITS_UNREADABLE, không mượn đệm của A");
    } finally {
      await pdb.execute(sql.raw("ALTER TABLE platform_price_pins_tam RENAME TO platform_price_pins"));
      invalidatePriceBook();
    }
    await setOrgPlan(B, null);

    // ── 6. ĐỒNG HỒ KHÁCH AI — hàm ghi của điểm gửi (đường gửi thật: tests/ai-customer-send.test.ts).
    resetAiCustomerSeenForTests();
    const period = usagePeriodOf(now);
    const convIds = await withOrganization(A, async () => {
      const db = await getDb();
      const c = schema.salesChatConversations;
      const ins = async (channel: string, pageId: string, visitorKey: string) => (await db.insert(c).values({ channel, pageId, threadId: `t-${visitorKey}`, visitorKey }).returning({ id: c.id }))[0].id;
      return { c1: await ins("FANPAGE", "p1", "vk-1"), c2: await ins("FANPAGE", "p2", "vk-2"), test: await ins("TEST", "p1", "vk-test"), msg: await ins("WEB", "p1", "vk-3") };
    });
    await withOrganization(A, async () => {
      for (let i = 0; i < 3; i++) await noteAiCustomerReply(convIds.c1, now);
      await noteAiCustomerReply(convIds.c2, now);
      await noteAiCustomerReply(convIds.test, now);
      await noteAiCustomerReply(convIds.msg, now);
      await noteAiCustomerReply("khong-co-hoi-thoai", now);
    });
    const countA = async () => (await readAiCustomerCounts([A], period.from, new Date(now.getTime() + 1))).get(A) ?? 0;
    assert.equal(await countA(), 3, "3 lần trả lời cùng khách = 1; hai trang = hai khách; kênh web là khách khác; khung THỬ không đếm");
    // Nhiều hội thoại của CÙNG khách trong kỳ ⇒ vẫn một (cùng danh tính kênh).
    const again = await recordAiCustomer({ orgCode: A, channel: "FANPAGE", pageId: "p1", customerKey: "vk-1", conversationId: "hoi-thoai-khac", at: now });
    assert.equal(again.recorded, false);
    // Thử lại đồng thời CÙNG khoá (không qua đệm tiến trình) ⇒ chỉ mục duy nhất giữ đúng một dòng.
    resetAiCustomerSeenForTests();
    const burst = await Promise.all(Array.from({ length: 5 }, () => recordAiCustomer({ orgCode: A, channel: "FANPAGE", pageId: "p1", customerKey: "vk-9", at: now })));
    assert.equal(burst.filter((b) => b.recorded).length, 1, "5 lần thử lại đồng thời ⇒ 1 dòng");
    resetAiCustomerSeenForTests();
    assert.equal((await recordAiCustomer({ orgCode: A, channel: "FANPAGE", pageId: "p1", customerKey: "vk-1", at: now })).recorded, false, "đệm trống vẫn không ghi lần hai (khoá CSDL)");
    assert.equal(await countA(), 4);
    // Cô lập: cùng khoá ở tổ chức B là khách của B — không chặn, không đếm cho A.
    assert.equal((await recordAiCustomer({ orgCode: B, channel: "FANPAGE", pageId: "p1", customerKey: "vk-1", at: now })).recorded, true, "khoá của A không chặn B");
    assert.equal(await countA(), 4, "B không đếm vào A");
    assert.equal((await readAiCustomerCounts([B], period.from, new Date(now.getTime() + 1))).get(B), 1);
    // Kỳ trước giữ số của nó; khoá kỳ sau là khoá khác.
    const prevAt = new Date(period.from.getTime() - 3_600_000);
    assert.equal((await recordAiCustomer({ orgCode: A, channel: "FANPAGE", pageId: "p1", customerKey: "vk-1", at: prevAt })).recorded, true, "cùng khách, kỳ trước = một khách AI của kỳ trước");
    assert.equal(await countA(), 4);
    // Lỗi ghi sổ KHÔNG ném (không làm hỏng việc gửi): sổ dùng ném ⇒ hàm ghi nuốt + đếm.
    await pdb.execute(sql.raw(`CREATE OR REPLACE FUNCTION pv1_fail_usage_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sổ dùng hỏng (bài kiểm)'; END $$ LANGUAGE plpgsql`));
    await pdb.execute(sql.raw(`CREATE TRIGGER pv1_fail_usage BEFORE INSERT ON platform_usage_events FOR EACH ROW WHEN (NEW.org_code = '${A}') EXECUTE FUNCTION pv1_fail_usage_fn()`));
    resetAiCustomerSeenForTests();
    const errBefore = aiCustomerMeterErrors().n;
    await withOrganization(A, async () => {
      const db = await getDb();
      const c = schema.salesChatConversations;
      const id = (await db.insert(c).values({ channel: "FANPAGE", pageId: "p1", threadId: "t-vk-5", visitorKey: "vk-5" }).returning({ id: c.id }))[0].id;
      await noteAiCustomerReply(id, now);
    });
    assert.equal(aiCustomerMeterErrors().n, errBefore + 1, "lỗi được đếm, không ném");
    await pdb.execute(sql.raw("DROP TRIGGER IF EXISTS pv1_fail_usage ON platform_usage_events"));

    // ── 7. Độ phủ + hoá đơn ước tính của khách (đồng hồ bật trước kỳ ⇒ đo trọn).
    await setMeterLive(now);
    assert.equal((await readAiCustomerUsage([A], period, now)).get(A)?.coverage, now.getTime() > period.from.getTime() ? "PARTIAL" : "MEASURED", "đồng hồ bật giữa kỳ ⇒ chưa trọn");
    const partialView = await loadCustomerPlan(A, now);
    assert.equal(partialView?.meter?.aiCustomers.used, 4, "cận dưới vẫn in số đã đếm");
    assert.equal(partialView?.meter?.estimate?.overage.lines.find((l) => l.key === "aiCustomers")?.amountVnd, null, "đo chưa trọn kỳ ⇒ phần vượt khách AI chưa biết, không phải 0");
    assert.equal(partialView?.meter?.estimate?.totalVnd, null, "hoá đơn ước tính chưa biết khi còn dòng chưa biết");
    await setMeterLive(new Date(period.from.getTime() - 40 * 86_400_000));
    await seedAiCustomers(A, 1597, now, "a");
    const viewA = await loadCustomerPlan(A, now);
    assert.ok(viewA?.meter, "màn khách có khung V1");
    assert.deepEqual([viewA!.meter!.aiCustomers.used, viewA!.meter!.aiCustomers.included, viewA!.meter!.aiCustomers.coverage, viewA!.meter!.aiCustomers.alert.level], [1601, 1500, "MEASURED", "OVERAGE"]);
    assert.equal(viewA!.meter!.estimate?.overage.lines.find((l) => l.key === "aiCustomers")?.amountVnd, 118_000, "1.601 khách AI ở Starter ⇒ 2 khối × 59.000");
    assert.equal(viewA!.meter!.estimate?.totalVnd, 790_000 + 118_000);
    assert.equal(viewA!.meter!.aiCustomers.alert.pauseBot, false);
    assert.ok(!/inputTokens|outputTokens|costUsd|token/i.test(JSON.stringify(viewA!.meter)), "khách không thấy token / chi phí");

    // ── 8. KHÁCH NỘI BỘ đi CÙNG bộ máy: chạy thử → gán gói thường nhỏ nhất → chargeback dùng cùng phép tính phần vượt.
    const intAcct = (await pdb.select({ accountId: schema.platformOrganizations.accountId }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, INT)))[0]?.accountId;
    assert.ok(intAcct);
    await updateAccount(intAcct!, { accountType: "INTERNAL", billingMode: "INTERNAL_CHARGEBACK" }, { actor: null, source: "TEST", reason: "khách nội bộ thử" });
    const prevPeriod = previousPeriodMonth(now);
    await seedAiCustomers(INT, 120, new Date(new Date(`${prevPeriod}T00:00:00+07:00`).getTime() + 86_400_000), "int-prev");
    const dry = await planInternalFit({ orgCode: INT, now, source: "TEST" });
    assert.deepEqual([dry.applied, dry.fit.plan?.planKey, dry.usage.aiCustomers, dry.usage.needsAiSales], [false, "starter", 120, true], dry.message);
    assert.match(dry.message, /CHẠY THỬ/);
    assert.equal(dry.chargeback?.totalVnd, 790_000, "120 khách AI ⇒ Starter, không vượt");
    const planOf = async (code: string) => (await pdb.select({ plan: schema.platformOrganizations.plan }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, code)))[0]?.plan ?? null;
    assert.equal(await planOf(INT), null, "chạy thử không ghi gì");
    assert.equal(dry.aiLimits?.wouldExceed, false, "gói đích không chặn AI đang chạy");
    assert.equal((await planInternalFit({ orgCode: INT, now, apply: true, reason: "", source: "TEST" })).applied, false, "gán cần lý do");
    const applied = await planInternalFit({ orgCode: INT, now, apply: true, reason: "Gán gói theo số dùng thật tháng trước", source: "TEST" });
    assert.ok(applied.applied, applied.message);
    assert.equal(await planOf(INT), "starter", "gán = ghi cột gói của workspace (cột planKeyOf đọc)");
    assert.equal((await pdb.select().from(schema.platformPricePins).where(eq(schema.platformPricePins.orgCode, INT)))[0]?.versionKey, V1, "ghim bảng giá hiện hành");
    assert.match((await planInternalFit({ orgCode: INT, now, apply: true, reason: "Bấm gán lần hai", source: "TEST" })).message, /không đổi gì/, "gán lại cùng gói không ghi thêm");
    // Khách AI chưa đo trọn ⇒ không gán (khách ngoài A đang đo kỳ hiện tại; kỳ trước của B chưa có đồng hồ).
    await setMeterLive(now);
    const noFit = await planInternalFit({ orgCode: B, now, apply: true, reason: "thử gán khi chưa đo", source: "TEST" });
    assert.ok(!noFit.applied && noFit.fit.plan === null, "chưa đo trọn kỳ ⇒ không gán bằng phỏng đoán");
    await setMeterLive(new Date(period.from.getTime() - 40 * 86_400_000));
    await seedAiCustomers(INT, 1601, now, "int-cur");
    invalidatePriceBook();
    const snap = await loadCommercialSnapshot({ now });
    const intView = snap.customers.find((c) => c.account.id === intAcct)!;
    assert.equal(intView.statement.billingMode, "INTERNAL_CHARGEBACK");
    const planLine = intView.statement.lines.find((l) => l.kind === "PLAN" && l.orgCode === INT);
    assert.equal(planLine?.amountVnd, 790_000, "nội bộ: gói thường theo giá V1, không miễn phí ẩn");
    const over = intView.statement.lines.find((l) => l.kind === "OVERAGE" && l.productKey === "chotdon");
    assert.deepEqual([over?.quantity, over?.unitPriceVnd, over?.amountVnd], [2, 59_000, 118_000], "chargeback nội bộ dùng CÙNG phép tính phần vượt");
    const extA = snap.customers.find((c) => c.workspaces.some((w) => w.code === A))!;
    assert.equal(extA.workspaces[0].pricing.overage?.lines.find((l) => l.key === "aiCustomers")?.amountVnd, 118_000, "khách ngoài: cùng phép tính");
    const legWs = snap.customers.find((c) => c.workspaces.some((w) => w.code === LEG))!.workspaces[0];
    assert.deepEqual([legWs.pricing.versionKey, legWs.pricing.overage], ["legacy", null], "giá cũ không có phần vượt theo khách AI");
    // Lỗi đọc ghim ⇒ không lập / không chốt bảng kê (FINAL bất biến) — không bao giờ chốt khách legacy theo giá V1.
    const legAcct = await accountOfWorkspace(LEG);
    assert.ok(legAcct);
    await pdb.execute(sql.raw("ALTER TABLE platform_price_pins RENAME TO platform_price_pins_tam"));
    invalidatePriceBook();
    try {
      await assert.rejects(() => loadCommercialSnapshot({ now }), "bảng kê nháp không dựng trên ghim rỗng");
      const fin = await finalizeStatement(legAcct!.code, prevPeriod, { actor: null, email: null, reason: "chốt khi CSDL chập", source: "TEST", now });
      assert.ok("error" in fin, JSON.stringify(fin));
    } finally {
      await pdb.execute(sql.raw("ALTER TABLE platform_price_pins_tam RENAME TO platform_price_pins"));
      invalidatePriceBook();
    }
    assert.equal((await pdb.select().from(schema.platformBillingStatements).where(eq(schema.platformBillingStatements.accountId, legAcct!.id))).length, 0, "không dòng FINAL nào cho tổ chức legacy");
    const finOk = await finalizeStatement(legAcct!.code, prevPeriod, { actor: null, email: null, reason: "chốt kỳ trước khi đọc được", source: "TEST", now });
    assert.ok("ok" in finOk, JSON.stringify(finOk));
    const finRow = (await pdb.select().from(schema.platformBillingStatements).where(eq(schema.platformBillingStatements.accountId, legAcct!.id)))[0];
    const finWs = (finRow?.snapshot as { workspaces?: { code: string; priceVersionKey: string | null }[] }).workspaces?.find((w) => w.code === LEG);
    assert.equal(finWs?.priceVersionKey, "legacy", "bảng kê chốt ghi đúng phiên bản giá legacy");
    assert.equal(legWs.usage.find((u) => u.metric === "ai_customers")?.value, 0, "LEG không có AI bán hàng nào chạy ⇒ 0 thật");
  } finally {
    await cleanup(saved);
  }
  console.log(
    "✓ Giá V1 (0228): phiên bản giá — V1 gieo đúng 6 gói, legacy chép đúng platform_plans, hoá đơn legacy 1/3/6/12 tháng trước = sau, sửa giá = phiên bản mới (ghim V1 / legacy không đổi, chưa ghim theo giá mới, dòng cũ bất biến); đồng hồ khách AI ở điểm gửi thành công — trả lời lặp / nhiều hội thoại / 5 lần thử lại đồng thời = 1 dòng, hai trang = hai khách, THỬ không đếm, lỗi sổ không làm hỏng việc gửi, A không chặn / đếm cho B; vượt theo khối 1.500→0 · 1.501→1 · 1.600→1 · 1.601→2 ở Starter / Growth / Scale; đơn và fair-use không sinh phí; 80/100/120/150 không tắt bot; INBOX không ai_sales; nội bộ chạy thử → gán gói nhỏ nhất → chargeback cùng phép tính",
  );
}

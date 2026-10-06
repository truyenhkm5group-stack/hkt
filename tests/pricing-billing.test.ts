/**
 * NỀN MÓNG GIÁ & THU PHÍ (0222 · docs/platform/pricing-billing-foundation.md).
 *
 *  1. THUẦN — đọc `commercial` (ô thiếu = chưa khai), kiểm đầu vào của người vận hành, bảng chân lý tính năng (nhà · ghi đè
 *     · giữ từ trước · gói chưa khai · gói), bảng chân lý hạn mức (chưa khai · không giới hạn · chưa biết · 50/80/100% ·
 *     chính sách vượt · grace · bốn điều kiện chặn), chi phí tăng bất thường (chưa đủ ngày ⇒ CHƯA BIẾT), đề xuất model rẻ
 *     hơn, nguy cơ âm biên, dùng thử → trả tiền, kỳ đo theo tháng VN, giá năm = cùng phép tính với hoá đơn.
 *  2. MÃ NGUỒN — không nơi nào so khoá / tên gói bằng chuỗi gõ tay (`plan === "pro"`); khoá gói nội bộ chỉ khai một chỗ.
 *  3. VÒNG THẬT trên hai tổ chức PGlite riêng: gói gieo đọc được; migration 0222 ghi «giữ từ trước» cho tổ chức có sẵn;
 *     nâng / hạ gói đổi tính năng + hạn mức; ghi đè; dùng thử hết hạn không đụng tính năng; đồng hồ đo đếm đúng kỳ (đầu kỳ
 *     đếm lại từ 0); hạn mức mềm KHÔNG chặn; trần cứng chỉ chặn khi đủ bốn điều kiện; sự kiện đo trùng / thử lại không tính
 *     hai lần; ghi đồng thời không mất / không nhân đôi; tổ chức A không chạm sổ của B; người ngoài bị từ chối; màn khách
 *     không mang token / chi phí; trang giá công khai chỉ in tính năng có thật.
 *
 * Mốc thời gian: dữ liệu gieo theo ĐỒNG HỒ THẬT cùng nhịp với hàm đo (`usagePeriodOf(new Date())`), không ghim ngày tuyệt
 * đối rồi gieo tương đối (AGENTS.md mục 50 · 65). Các ca thuần nhận `now` làm tham số — không đọc đồng hồ.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { addDays, billedMonths, billingStanding, TRIAL_DAYS, vnDate } from "@/lib/billing/rules";
import { orgBillingStanding, invalidateSubscriptions } from "@/lib/billing/standing";
import { billingProvider } from "@/lib/billing/provider";
import { sourceUsage } from "@/lib/ai-usage/ledger";
import { HOME_PLAN_KEY } from "@/lib/entitlements/kinds";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { readPeriodUsage } from "@/lib/platform/usage-meter";
import { captureSaasSnapshot } from "@/lib/platform/saas-ledger";
import { normalizeCommercialInput, parseCommercial, planQuotas, trialDaysOf, yearlyPriceVnd } from "@/lib/pricing/catalog";
import { featureGranted, FEATURE_KEYS, FEATURE_SPEC } from "@/lib/pricing/features";
import { DEFAULT_GUARD_CONFIG, detectCostSpike, evaluateQuota, parseGuardConfig, suggestCheaperModel, usageLine, type GuardConfig } from "@/lib/pricing/guard";
import { marginRisk, projectToPeriodEnd, tenantUnitEconomics, trialConversion } from "@/lib/pricing/economics";
import { usageEventKey, usagePeriodOf } from "@/lib/pricing/meter";
import { checkUsageQuota, hasFeature, invalidatePricing, PRICING_GUARD_KEY, readOrgPricingRow, recordUsageEvent, resolveOrgPricing } from "@/lib/pricing/entitlements";
import { loadPricingAdmin, loadPricingEconomics, setAiUnitPrices, setOrgPricing, setPlanCommercial, setPricingGuard } from "@/lib/pricing/admin";
import { loadCustomerPlan } from "@/lib/pricing/customer";
import { AI_UNIT_PRICES_KEY, mergeUnitPrices, parseUnitPriceOverrides } from "@/lib/pricing/unit-prices";
import { getPublicPricing } from "@/lib/queries/public-pricing";

const A = "prc-a";
const B = "prc-b";
const C = "prc-c";
const ORGS = [A, B, C] as const;
const KEY = "prcev";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "prc-user", email: "prc@local", name: "PRC", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

const cfg = (over: Partial<GuardConfig> = {}): GuardConfig => ({ ...DEFAULT_GUARD_CONFIG, ...over });

// ─────────────────────────── 1 · THUẦN ───────────────────────────

function testPure() {
  // Đọc commercial: ô thiếu = CHƯA KHAI, không phải 0 / không giới hạn lặng lẽ.
  const empty = parseCommercial({});
  assert.equal(empty.features, null);
  assert.equal(empty.quotas.aiConversations, undefined);
  assert.ok(empty.undeclared.includes("features") && empty.undeclared.includes("quotas.aiConversations") && empty.undeclared.includes("overage.policy"));
  const full = parseCommercial({ publicListed: true, quotas: { aiConversations: 100, aiMessages: null, orders: 5, fanpages: 1 }, features: ["ai_sales", "khong-co", "api"], overage: { policy: "BILL_OVERAGE", unitPricesVnd: { aiConversations: 500, orders: -1 }, graceAllowancePct: 99 } });
  assert.deepEqual(full.features, ["ai_sales", "api"], "khoá lạ bị bỏ");
  assert.equal(full.quotas.aiMessages, null, "null = không giới hạn");
  assert.deepEqual(full.overage.unitPricesVnd, { aiConversations: 500 }, "đơn giá âm bị bỏ");
  assert.equal(full.overage.graceAllowancePct, 0, "grace ngoài 0–50 ⇒ 0, không kẹp đoán");
  assert.equal(full.undeclared.length, 0);
  assert.deepEqual(planQuotas({ users: 3 }, full).users, 3, "người dùng đọc từ limits.users — không khai lần hai");
  assert.equal(planQuotas({}, full).users, undefined);

  // Kiểm đầu vào người vận hành.
  assert.ok("error" in normalizeCommercialInput({ name: "x" }));
  assert.ok("error" in normalizeCommercialInput({ name: "Gói A", overagePolicy: "LẠ" }));
  assert.ok("error" in normalizeCommercialInput({ name: "Gói A", overagePolicy: "SOFT_ONLY", features: ["ai_sales", "bịa"] }));
  assert.ok("error" in normalizeCommercialInput({ name: "Gói A", overagePolicy: "SOFT_ONLY", quotas: { aiConversations: "-3" } }), "dấu trừ ⇒ sai, không lặng lẽ thành 3");
  assert.ok("error" in normalizeCommercialInput({ name: "Gói A", overagePolicy: "SOFT_ONLY", quotas: { aiConversations: "3 nghìn" } }), "chữ ⇒ sai, không đoán");
  const ok = normalizeCommercialInput({ name: " Gói A ", overagePolicy: "BILL_OVERAGE", quotas: { aiConversations: "1.000", orders: "" }, overageUnitPricesVnd: { aiConversations: "300" }, features: ["ai_sales"], limitModes: { aiConversations: "HARD", orders: "" }, publicListed: true });
  assert.ok("ok" in ok);
  if ("ok" in ok) {
    const c = parseCommercial(ok.commercial);
    assert.equal(ok.name, "Gói A");
    assert.equal(c.quotas.aiConversations, 1000);
    assert.equal(c.quotas.orders, null, "ô trống khi người vận hành lưu = không giới hạn");
    assert.deepEqual(c.limitModes, { aiConversations: "HARD" });
    assert.equal(c.overage.unitPricesVnd.aiConversations, 300);
  }

  // Giá năm — CÙNG phép tính với hoá đơn gia hạn.
  assert.equal(yearlyPriceVnd(499_000, 2), 499_000 * billedMonths(12, 2));
  assert.equal(yearlyPriceVnd(null, 2), null, "gói không bán không có giá năm (không phải 0)");
  assert.equal(trialDaysOf("trial"), TRIAL_DAYS, "số ngày dùng thử chỉ có MỘT nguồn: TRIAL_DAYS");
  assert.equal(trialDaysOf("growth"), null);

  // Bảng chân lý tính năng.
  const base = { key: "api" as const, isHome: false, grandfathered: false, overrides: {}, planFeatures: ["ai_sales" as const] };
  assert.deepEqual(featureGranted({ ...base, isHome: true }), { key: "api", granted: true, source: "HOME" });
  assert.equal(featureGranted(base).granted, false);
  assert.equal(featureGranted({ ...base, grandfathered: true }).source, "GRANDFATHERED");
  assert.equal(featureGranted({ ...base, grandfathered: true, overrides: { api: false } }).granted, false, "ghi đè thắng cả giữ từ trước");
  assert.equal(featureGranted({ ...base, overrides: { api: true } }).source, "OVERRIDE");
  assert.deepEqual(featureGranted({ ...base, planFeatures: null }), { key: "api", granted: true, source: "PLAN_UNDECLARED" }, "gói chưa khai ⇒ không đóng tính năng vì một ô trống");

  // Bảng chân lý hạn mức — ngưỡng 50 / 80 / 100.
  const q = (used: number | null, included: number | null | undefined, over: Partial<Parameters<typeof evaluateQuota>[0]> = {}) =>
    evaluateQuota({ key: "aiConversations", used, included, policy: "REQUIRE_UPGRADE", graceAllowancePct: 0, limitMode: "SOFT", enforcement: "SOFT", config: cfg(), ...over });
  assert.equal(q(10, undefined).level, "UNDECLARED");
  assert.equal(q(10, null).level, "UNLIMITED");
  assert.equal(q(null, 100).level, "UNKNOWN", "chưa biết ≠ 0");
  assert.equal(q(null, 100, { enforcement: "HARD", limitMode: "HARD", config: cfg({ hardLimitsEnabled: true }) }).blocked, false, "số dùng CHƯA BIẾT không bao giờ chặn");
  assert.deepEqual([q(49, 100).level, q(50, 100).level, q(79, 100).level, q(80, 100).level, q(99, 100).level, q(100, 100).level], ["OK", "NOTICE", "NOTICE", "WARN", "WARN", "LIMIT"]);
  assert.deepEqual([q(50, 100).action, q(80, 100).action, q(100, 100).action], ["NOTIFY", "WARN", "REQUIRE_UPGRADE"]);
  assert.equal(q(3, 0).level, "LIMIT", "gói cho 0 mà đã dùng ⇒ hết");
  assert.equal(q(0, 0).level, "OK");
  // Hạn mức MỀM không bao giờ chặn, kể cả vượt xa.
  assert.equal(q(10_000, 100).blocked, false);
  assert.equal(q(10_000, 100, { enforcement: "HARD", limitMode: "HARD" }).blocked, false, "công tắc nền tảng tắt ⇒ không chặn");
  assert.equal(q(10_000, 100, { limitMode: "HARD", config: cfg({ hardLimitsEnabled: true }) }).blocked, false, "tổ chức ở mức SOFT ⇒ không chặn");
  assert.equal(q(10_000, 100, { enforcement: "HARD", config: cfg({ hardLimitsEnabled: true }) }).blocked, false, "ô khai SOFT ⇒ không chặn");
  assert.equal(q(10_000, 100, { enforcement: "HARD", limitMode: "HARD", policy: "SOFT_ONLY", config: cfg({ hardLimitsEnabled: true }) }).blocked, false, "chính sách chỉ nhắc ⇒ không chặn");
  const hard = { enforcement: "HARD" as const, limitMode: "HARD" as const, config: cfg({ hardLimitsEnabled: true }) };
  assert.equal(q(99, 100, hard).blocked, false, "còn đúng 1 ⇒ lượt kế tiếp được");
  assert.equal(q(100, 100, hard).blocked, true, "đủ bốn điều kiện + hết ⇒ lượt kế tiếp bị chặn");
  assert.equal(q(100, 100, { ...hard, graceAllowancePct: 10 }).blocked, false, "grace 10% ⇒ chặn ở 110");
  assert.equal(q(109, 100, { ...hard, graceAllowancePct: 10 }).blocked, false);
  assert.equal(q(110, 100, { ...hard, graceAllowancePct: 10 }).blocked, true);
  assert.equal(q(95, 100, { ...hard, delta: 6 }).blocked, true, "hỏi trước một thao tác dùng 6 đơn vị");
  assert.equal(q(10_000, 100, { ...hard, enforcement: "OFF" }).action, "NONE", "người vận hành TẮT ⇒ không nhắc, không chặn");
  // Vượt: tính phí theo đơn giá; chưa khai đơn giá ⇒ chỉ nhắc, nói rõ chưa thu được.
  const bill = q(130, 100, { policy: "BILL_OVERAGE", unitPriceVnd: 500 });
  assert.deepEqual([bill.action, bill.overageUnits, bill.overageVnd], ["BILL_OVERAGE", 30, 15_000]);
  const unpriced = q(130, 100, { policy: "BILL_OVERAGE" });
  assert.equal(unpriced.action, "WARN");
  assert.equal(unpriced.overageVnd, null);
  assert.match(unpriced.message ?? "", /chưa khai đơn giá/);
  assert.equal(usageLine("aiConversations", 3245, 5000), "3.245 / 5.000 hội thoại AI");
  assert.equal(usageLine("aiConversations", null, 5000), "— / 5.000 hội thoại AI");

  // Ngưỡng ghi đè: bộ sai thứ tự bị bỏ NGUYÊN CẢ BỘ.
  assert.deepEqual([parseGuardConfig({ noticePct: 90, warnPct: 80, limitPct: 100 }).noticePct, parseGuardConfig({ noticePct: 90, warnPct: 80, limitPct: 100 }).warnPct], [50, 80]);
  assert.deepEqual([parseGuardConfig({ noticePct: 60, warnPct: 85, limitPct: 120 }).warnPct, parseGuardConfig({}).hardLimitsEnabled], [85, false], "mặc định trần cứng TẮT");

  // Chi phí tăng bất thường.
  assert.equal(detectCostSpike([0.1, 0.1], 5, cfg()).state, "UNKNOWN", "dưới 5 ngày lịch sử ⇒ chưa biết, không kết luận bình thường");
  assert.equal(detectCostSpike([0.2, 0.2, 0.3, 0.2, 0.2, 9], 0.25, cfg()).state, "NORMAL", "một ngày bão không kéo nền (trung vị)");
  assert.equal(detectCostSpike([0.2, 0.2, 0.3, 0.2, 0.2], 1.0, cfg()).state, "SPIKE");
  assert.equal(detectCostSpike([0.2, 0.2, 0.3, 0.2, 0.2], 0.62, cfg()).state, "NORMAL", "gấp ba nhưng chênh dưới ngưỡng tối thiểu");
  assert.equal(detectCostSpike([0, 0, 0, 0, 0], 0.8, cfg()).state, "SPIKE", "các ngày trước bằng 0, hôm nay vượt mức tối thiểu");

  // Đề xuất model rẻ hơn — cùng họ, chỉ đề xuất.
  const prices = { "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 }, "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 }, "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 }, "claude-haiku-4-5": { input: 1, output: 5 } };
  const keyOf = (m: string) => Object.keys(prices).filter((k) => m.startsWith(k)).sort((a, b) => b.length - a.length)[0] ?? null;
  const s = suggestCheaperModel({ model: "gemini-3.5-flash-lite-preview", inputTokens: 1_000_000, outputTokens: 200_000, prices, priceKeyOf: keyOf, minSavingsPct: 30 });
  assert.equal(s?.to, "gemini-2.5-flash-lite", "không bao giờ gợi ý khác họ (claude) cho model gemini");
  assert.match(s?.note ?? "", /không tự đổi model/);
  assert.equal(suggestCheaperModel({ model: "gemini-2.5-flash-lite", inputTokens: 1000, outputTokens: 1000, prices, priceKeyOf: keyOf, minSavingsPct: 30 }), null, "đã rẻ nhất ⇒ không đề xuất");
  assert.equal(suggestCheaperModel({ model: "model-la", inputTokens: 1000, outputTokens: 1000, prices, priceKeyOf: keyOf, minSavingsPct: 30 }), null, "model không có giá ⇒ không đoán");

  // Kinh tế đơn vị.
  assert.deepEqual(tenantUnitEconomics({ revenueVnd: 1_000_000, platformAiCostVnd: 200_000, aiCostComplete: true, aiOrders: 0, aiConversations: 40 }), { revenueVnd: 1_000_000, platformAiCostVnd: 200_000, aiCostComplete: true, grossProfitVnd: 800_000, grossMarginPct: 80, aiCostPerOrderVnd: null, aiCostPerConversationVnd: 5_000 });
  assert.equal(tenantUnitEconomics({ revenueVnd: null, platformAiCostVnd: 1, aiCostComplete: true, aiOrders: null, aiConversations: null }).grossMarginPct, null, "chưa biết doanh thu ⇒ —");
  assert.equal(marginRisk({ revenueVnd: 499_000, platformAiCostToDateVnd: 200_000, projectedPlatformAiCostVnd: 600_000 }), "NEGATIVE");
  assert.equal(marginRisk({ revenueVnd: 499_000, platformAiCostToDateVnd: 20_000, projectedPlatformAiCostVnd: 100_000 }), "OK");
  assert.equal(marginRisk({ revenueVnd: 0, platformAiCostToDateVnd: 20_000, projectedPlatformAiCostVnd: 100_000 }), "TRIAL_COST");
  assert.equal(marginRisk({ revenueVnd: 499_000, platformAiCostToDateVnd: 0, projectedPlatformAiCostVnd: 0 }), "NO_COST");
  assert.equal(marginRisk({ revenueVnd: null, platformAiCostToDateVnd: 20_000, projectedPlatformAiCostVnd: 100_000 }), "UNKNOWN", "chưa có ảnh chụp MRR ⇒ chưa biết, không phải «dùng thử»");
  assert.equal(projectToPeriodEnd(100, 2, 30), null, "dưới 3 ngày ⇒ không chiếu");
  assert.equal(projectToPeriodEnd(100, 10, 30), 300);
  const row = (day: string, orgCode: string, paying: boolean, billingEnabled = true) => ({ day, orgCode, isHome: false, orgStatus: "ACTIVE", billingEnabled, standing: "ACTIVE" as const, paying });
  const conv = trialConversion([row("2026-01-01", "x", false), row("2026-01-09", "x", true), row("2026-01-01", "y", false), row("2026-01-02", "z", true)]);
  assert.deepEqual([conv.trialOrgs, conv.converted, conv.rate], [2, 1, null], "z trả tiền ngay không qua dùng thử; mẫu < 5 ⇒ không in tỷ lệ");

  // Kỳ đo = tháng lịch giờ VN; đầu kỳ đếm lại.
  const endJan = usagePeriodOf(new Date("2026-01-31T16:59:59Z"));
  const startFeb = usagePeriodOf(new Date("2026-01-31T17:00:00Z"));
  assert.deepEqual([endJan.label, endJan.resetsOn, startFeb.label, startFeb.fromDay], ["01/2026", "2026-02-01", "02/2026", "2026-02-01"]);
  assert.equal(usageEventKey(["conv", "abc", 3]), "conv:abc:3");
  assert.equal(usageEventKey([null, ""]), null);
  assert.equal(usageEventKey(["x".repeat(500)])?.length, 200);

  // Giá đơn vị ESTIMATED: ghi đè thắng bảng trong mã, dòng sai hình bị bỏ.
  const o = parseUnitPriceOverrides({ "gemini-x": { input: 1, output: 2 }, "SAI HOA": { input: 1, output: 1 }, "m-am": { input: -1, output: 1 } });
  assert.deepEqual(Object.keys(o), ["gemini-x"]);
  const merged = mergeUnitPrices({ "gemini-x": { input: 9, output: 9 }, "claude-y": { input: 1, output: 5 } }, o);
  assert.deepEqual(merged.map((r) => [r.model, r.source, r.confidence, r.input]), [["claude-y", "CODE_TABLE", "ESTIMATED", 1], ["gemini-x", "OPERATOR_OVERRIDE", "ESTIMATED", 1]]);
}

// ─────────────────────────── 2 · MÃ NGUỒN ───────────────────────────

const PLAN_NAME = /["'](trial|basic|starter|growth|pro|enterprise|internal|standard|free|legacy)["']/;
const PLAN_COMPARE = new RegExp(String.raw`(?:\b(?:plan|planKey|plan_key|planName|tier)\b|\.plan\b|\bplan\.key\b|\bp\.key\b|\bkey\b)\s*[!=]==?\s*${PLAN_NAME.source}|${PLAN_NAME.source}\s*[!=]==?\s*(?:\w+\.)?(?:plan|planKey|key)\b`);

function testNoPlanNameComparisons() {
  // Tự kiểm bộ dò trước — không tin được nó thì luật mù.
  for (const bad of [`if (plan === "PRO".toLowerCase() || plan === "pro") {}`, `org.plan === 'growth'`, `p.key !== "internal"`, `"starter" === planKey`, `planKey == "enterprise"`]) assert.ok(PLAN_COMPARE.test(bad), `bộ dò phải bắt: ${bad}`);
  for (const good of [`p.key === HOME_PLAN_KEY`, `r.key === DEFAULT_PLAN_KEY`, `hasFeature("api")`, `status === "trialing"`]) assert.ok(!PLAN_COMPARE.test(good), `bộ dò không được bắt: ${good}`);
  const goc = path.resolve(__dirname, "..");
  const files = execSync("git ls-files", { cwd: goc, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((l) => l.trim().split(path.sep).join("/"))
    .filter((f) => /^(lib|app|components|chatbot)\/.*\.(ts|tsx|mjs|js)$/.test(f));
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const bad: string[] = [];
  let homeDefs = 0;
  for (const f of files) {
    const code = strip(readFileSync(path.join(goc, f), "utf8"));
    for (const line of code.split("\n")) if (PLAN_COMPARE.test(line)) bad.push(`${f}: ${line.trim().slice(0, 120)}`);
    if (/export const HOME_PLAN_KEY\s*=/.test(code)) homeDefs += 1;
  }
  assert.deepEqual(bad, [], "mã nghiệp vụ hỏi hasFeature(...) / checkUsageQuota(...), KHÔNG so khoá / tên gói bằng chuỗi gõ tay — gói là dữ liệu người vận hành sửa");
  assert.equal(homeDefs, 1, "HOME_PLAN_KEY khai đúng MỘT chỗ (lib/entitlements/kinds.ts)");
  // Trang giá công khai chỉ đọc BẢNG GIÁ ĐANG NIÊM YẾT (sổ giá có phiên bản, 0225) + chế độ đăng ký (qua public-site) — không
  // import truy vấn dữ liệu khách nào.
  const pub = readFileSync(path.join(goc, "lib/queries/public-pricing.ts"), "utf8");
  const imports = [...pub.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["@/lib/entitlements/kinds", "@/lib/pricing/catalog", "@/lib/pricing/features", "@/lib/pricing/price-book", "@/lib/pricing/versions", "@/lib/queries/public-site"], "public-pricing chỉ được đọc bảng giá và dữ liệu trang giới thiệu");
}

// ─────────────────────────── 3 · VÒNG THẬT ───────────────────────────

async function cleanup(saved: { commercial: Map<string, unknown>; guard: unknown; unit: unknown }) {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [...ORGS]));
  await pdb.delete(schema.platformOrgPricing).where(inArray(schema.platformOrgPricing.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  for (const [key, c] of saved.commercial) await pdb.update(schema.platformPlans).set({ commercial: (c ?? {}) as Record<string, unknown> }).where(eq(schema.platformPlans.key, key));
  for (const [k, v] of [
    [PRICING_GUARD_KEY, saved.guard],
    [AI_UNIT_PRICES_KEY, saved.unit],
  ] as const) {
    if (v === undefined) await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, k));
    else await pdb.update(schema.platformSettings).set({ value: v }).where(eq(schema.platformSettings.key, k));
  }
  const home = await getHomeOrganization();
  await pdb.delete(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, home.code), inArray(schema.platformAuditLog.action, ["PLAN_COMMERCIAL_SET", "PRICING_GUARD_SET", "AI_UNIT_PRICES_SET"])));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
}

async function setOrgPlan(code: string, plan: string | null) {
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformOrganizations).set({ plan }).where(eq(schema.platformOrganizations.code, code));
  invalidateOrganizations();
  invalidatePricing();
}

/** Gieo `n` hội thoại có AI trả lời trong CSDL của tổ chức, ở thời điểm `at` (mặc định: bây giờ). */
async function seedAiConversations(code: string, n: number, at?: Date) {
  await withOrganization(code, async () => {
    const db = await getDb();
    for (let i = 0; i < n; i++) {
      const [c] = await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE", ...(at ? { createdAt: at } : {}) }).returning({ id: schema.salesChatConversations.id });
      await db.insert(schema.salesChatMessages).values({ conversationId: c.id, seq: 1, role: "user", content: [{ type: "text", text: "Còn size M không shop?" }], ...(at ? { createdAt: at } : {}) });
      await db.insert(schema.salesChatMessages).values({ conversationId: c.id, seq: 2, role: "assistant", content: [{ type: "text", text: "Dạ còn ạ." }], ...(at ? { createdAt: at } : {}) });
    }
  });
  invalidatePricing();
}

export async function testPricingBilling() {
  testPure();
  testNoPlanNameComparisons();

  const pdb = await getPlatformDb();
  const plansBefore = await pdb.select({ key: schema.platformPlans.key, commercial: schema.platformPlans.commercial }).from(schema.platformPlans);
  const savedGuard = (await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PRICING_GUARD_KEY) }))?.value;
  const savedUnit = (await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, AI_UNIT_PRICES_KEY) }))?.value;
  const saved = { commercial: new Map(plansBefore.map((p) => [p.key, p.commercial])), guard: savedGuard, unit: savedUnit };
  await cleanup(saved);

  const home = await getHomeOrganization();
  const op = sessionUser({ id: "prc-op", email: "op@prc.local", organization: { code: home.code, name: home.name, isHome: true } });
  const homeViewer = sessionUser({ id: "prc-viewer", email: "xem@prc.local", role: "VIEWER", permissions: ["dashboard:view"], organization: op.organization });
  const otherAdmin = sessionUser({ id: "prc-khac", email: "qt@prc-b.local", permissions: ["platform:operate"], organization: { code: B, name: B, isHome: false } });

  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Pricing@12345" }, source: "TEST", actor: null });
  try {
    // ── Gói gieo bằng 0222 đọc được, không ô nào chưa khai; Doanh nghiệp không có giá ⇒ «Liên hệ».
    const plans = new Map((await pdb.select().from(schema.platformPlans)).map((p) => [p.key, p]));
    for (const k of ["trial", "basic", "starter", "growth", "pro", "enterprise", HOME_PLAN_KEY]) {
      const c = parseCommercial(plans.get(k)?.commercial);
      assert.deepEqual(c.undeclared, [], `gói ${k} gieo đủ phần thương mại`);
    }
    assert.equal(plans.get("enterprise")?.priceVnd, null, "Doanh nghiệp: không bán tự phục vụ (null, không phải 0)");
    assert.equal(parseCommercial(plans.get("enterprise")?.commercial).contactSales, true);
    assert.deepEqual([...(parseCommercial(plans.get(HOME_PLAN_KEY)?.commercial).features ?? [])].sort(), [...FEATURE_KEYS].sort(), "gói nội bộ khai đủ mọi tính năng");

    // ── Migration: tổ chức có sẵn lúc 0222 chạy ⇒ «giữ từ trước». Chạy lại đúng câu của migration (idempotent).
    assert.equal((await readOrgPricingRow(C, { fresh: true })).grandfathered, false, "tổ chức tạo SAU 0222 không tự được giữ từ trước");
    const mig = readFileSync(path.join(process.cwd(), "drizzle/0223_pricing_billing_foundation.sql"), "utf8");
    const grandfather = mig.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.startsWith('INSERT INTO "platform_org_pricing"'));
    assert.ok(grandfather, "migration 0222 phải có câu ghi giữ từ trước");
    await pdb.execute(sql.raw(grandfather));
    await pdb.execute(sql.raw(grandfather));
    invalidatePricing();
    const gRow = await readOrgPricingRow(C, { fresh: true });
    assert.deepEqual([gRow.grandfathered, gRow.enforcement], [true, "SOFT"], "giữ đủ tính năng, mức áp MỀM — deploy không bật trần cứng nào");
    assert.equal((await pdb.select().from(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, home.code))).length, 0, "tổ chức nhà không có dòng");
    assert.equal(await hasFeature("api", { orgCode: C }), true, "tổ chức có từ trước không mất tính năng dù gói Dùng thử không có API");
    // A, B là tổ chức "mới" trong bài này — bỏ dòng giữ từ trước để đo luật theo gói.
    await pdb.delete(schema.platformOrgPricing).where(inArray(schema.platformOrgPricing.orgCode, [A, B]));
    invalidatePricing();

    // ── Entitlement theo gói: dùng thử ⇒ nâng ⇒ hạ; ghi đè; nhà.
    assert.equal(await hasFeature("ai_sales", { orgCode: A }), true);
    assert.equal(await hasFeature("api", { orgCode: A }), false, "gói Dùng thử không có API");
    await setOrgPlan(A, "pro");
    assert.equal(await hasFeature("api", { orgCode: A }), true, "NÂNG lên Chuyên nghiệp ⇒ có API");
    assert.equal((await resolveOrgPricing({ code: A, isHome: false, plan: "pro" })).quotas.aiConversations, 1800);
    await setOrgPlan(A, "basic");
    assert.equal(await hasFeature("api", { orgCode: A }), false, "HẠ về Cơ bản ⇒ mất API");
    assert.equal(await hasFeature("multi_page_inbox", { orgCode: A }), false);
    assert.equal((await resolveOrgPricing({ code: A, isHome: false, plan: "basic" })).quotas.aiConversations, 180);
    assert.equal(await hasFeature("api", { orgCode: home.code }), true, "tổ chức nhà luôn đủ");
    assert.equal(await hasFeature("api", { orgCode: "khong-ton-tai" }), false, "không biết của ai ⇒ không cấp");

    // ── Người ngoài bị từ chối mọi thao tác; thiếu lý do bị từ chối; không đổi một dòng.
    for (const u of [homeViewer, otherAdmin]) {
      assert.ok("error" in (await setOrgPricing(u, { orgCode: A, featureOverrides: { api: true }, reason: "thử quyền" })));
      assert.ok("error" in (await setPlanCommercial(u, { planKey: "basic", name: "Cơ bản", overagePolicy: "SOFT_ONLY", reason: "thử quyền" })));
      assert.ok("error" in (await setPricingGuard(u, { config: { noticePct: 50, warnPct: 80, limitPct: 100 }, reason: "thử quyền" })));
      assert.ok("error" in (await setAiUnitPrices(u, { prices: {}, reason: "thử quyền" })));
      assert.equal((await loadPricingEconomics(u)).ok, false);
      assert.equal((await loadPricingAdmin(u)).ok, false);
      assert.ok("error" in (await billingProvider().cancelSubscription(u, { orgCode: A, reason: "thử quyền" })));
    }
    assert.equal(await hasFeature("api", { orgCode: A }), false, "người ngoài không đổi được gì");
    assert.ok("error" in (await setOrgPricing(op, { orgCode: A, featureOverrides: { api: true }, reason: "" })), "thiếu lý do");
    assert.ok("error" in (await setOrgPricing(op, { orgCode: home.code, enforcement: "HARD", reason: "nhà không giới hạn" })));
    assert.ok("error" in (await setOrgPricing(op, { orgCode: A, featureOverrides: { bia: true }, reason: "khoá lạ" })));
    const ov = await setOrgPricing(op, { orgCode: A, featureOverrides: { api: true }, reason: "Khách thử API một tuần" });
    assert.ok("ok" in ov, JSON.stringify(ov));
    assert.equal(await hasFeature("api", { orgCode: A }), true, "ghi đè có hiệu lực ngay");
    assert.equal(await hasFeature("api", { orgCode: B }), false, "ghi đè của A không chạm B");
    const audit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, A), eq(schema.platformAuditLog.action, "ORG_PRICING_SET")));
    assert.equal(audit.length, 1, "mỗi lượt ghi đè một dòng nhật ký nền tảng");
    assert.equal(audit[0].actorEmail, op.email);

    // ── Dùng thử hết hạn: tổ chức CHỈ XEM (luật cũ) — tính năng và hạn mức không bị đổi lặng lẽ.
    const today = vnDate(new Date());
    await pdb.insert(schema.platformSubscriptions).values({ orgCode: B, billingEnabled: true, paidThrough: addDays(today, -10), graceDays: 3 });
    invalidateSubscriptions(B);
    assert.equal((await orgBillingStanding({ code: B, isHome: false }, new Date(), { fresh: true })).kind, "LOCKED", "hết dùng thử + hết ân hạn ⇒ chỉ xem");
    assert.equal(billingStanding({ billingEnabled: true, paidThrough: addDays(today, -2), graceDays: 3 }, today).kind, "OVERDUE", "còn ân hạn ⇒ vẫn dùng đủ");
    assert.equal(await hasFeature("ai_sales", { orgCode: B }), true, "khoá thu phí là chiều riêng — không xoá tính năng");
    const viewB = await loadCustomerPlan(B);
    assert.ok(viewB, "khách hết hạn vẫn xem được trang gói");

    // ── Đồng hồ đo: đếm đúng kỳ; đầu kỳ đếm lại từ 0 (dữ liệu kỳ trước không lọt vào).
    const now = new Date();
    const period = usagePeriodOf(now);
    await seedAiConversations(A, 1, new Date(period.from.getTime() - 3_600_000));
    await seedAiConversations(A, 2);
    // Đọc SAU khi gieo, mốc cuối +1 giây: `created_at` do CSDL đặt tới micro giây, `Date` của JS chỉ tới mili giây — đọc đúng
    // "bây giờ" thì dòng vừa chèn trong cùng mili giây có thể nằm SAU mốc cuối (`< to`) và bài kiểm đỏ ngẫu nhiên.
    const cur = await readPeriodUsage({ code: A, isHome: false }, period, new Date(Date.now() + 1000));
    assert.deepEqual([cur.readings.ai_conversations, cur.readings.outgoing_ai_messages, cur.readings.incoming_messages, cur.errors.length], [2, 2, 2, 0], "chỉ hội thoại của KỲ NÀY");
    const prev = await readPeriodUsage({ code: A, isHome: false }, usagePeriodOf(new Date(period.from.getTime() - 3_600_000)), new Date());
    assert.equal(prev.readings.ai_conversations, 1, "kỳ trước giữ số của nó");
    assert.equal(cur.readings.fanpages_active, 0, "chưa nối fanpage nào ⇒ 0 thật (không có kết nối cũ)");

    // ── Hạn mức MỀM: vượt vẫn KHÔNG chặn (AI bán hàng không bị ngắt).
    const soft = await setOrgPricing(op, { orgCode: A, quotaOverrides: { aiConversations: 2 }, reason: "Đặt trần nhỏ để thử" });
    assert.ok("ok" in soft);
    const vSoft = await checkUsageQuota("aiConversations", { orgCode: A });
    assert.deepEqual([vSoft.level, vSoft.action, vSoft.blocked, vSoft.used, vSoft.included], ["LIMIT", "REQUIRE_UPGRADE", false, 2, 2], "gói Cơ bản: hết hạn mức ⇒ mời nâng gói, không chặn");

    // ── Trần CỨNG: chỉ chặn khi đủ bốn điều kiện.
    const basicNow = parseCommercial(plans.get("basic")?.commercial);
    const hardPlan = await setPlanCommercial(op, {
      planKey: "basic",
      name: plans.get("basic")!.name,
      description: plans.get("basic")!.description,
      publicListed: basicNow.publicListed,
      contactSales: false,
      quotas: Object.fromEntries(Object.entries(basicNow.quotas).map(([k, v]) => [k, v ?? ""])),
      features: basicNow.features ?? [],
      overagePolicy: basicNow.overage.policy,
      graceAllowancePct: 0,
      limitModes: { aiConversations: "HARD" },
      reason: "Thử trần cứng",
    });
    assert.ok("ok" in hardPlan, JSON.stringify(hardPlan));
    assert.equal((await checkUsageQuota("aiConversations", { orgCode: A })).blocked, false, "ô Cứng nhưng tổ chức SOFT + công tắc tắt ⇒ không chặn");
    assert.ok("ok" in (await setOrgPricing(op, { orgCode: A, enforcement: "HARD", reason: "Thử mức cứng" })));
    assert.equal((await checkUsageQuota("aiConversations", { orgCode: A })).blocked, false, "công tắc trần cứng của nền tảng còn TẮT ⇒ không chặn");
    assert.ok("error" in (await setPricingGuard(op, { config: { noticePct: 90, warnPct: 80, limitPct: 100 }, reason: "sai thứ tự" })));
    assert.ok("ok" in (await setPricingGuard(op, { config: { ...DEFAULT_GUARD_CONFIG, hardLimitsEnabled: true }, reason: "Bật trần cứng để thử" })));
    const vHard = await checkUsageQuota("aiConversations", { orgCode: A });
    assert.deepEqual([vHard.blocked, vHard.action], [true, "BLOCK"], "đủ bốn điều kiện ⇒ chặn");
    assert.equal((await checkUsageQuota("aiConversations", { orgCode: B })).blocked, false, "B ở mức SOFT — không bị kéo theo");
    assert.ok("ok" in (await setPricingGuard(op, { config: { ...DEFAULT_GUARD_CONFIG }, reason: "Tắt lại trần cứng" })));
    assert.equal((await checkUsageQuota("aiConversations", { orgCode: A })).blocked, false, "tắt công tắc ⇒ mở ngay");

    // ── Sự kiện đo: trùng / thử lại không tính hai lần; ghi đồng thời không mất, không nhân đôi; cô lập tổ chức.
    const ev = (org: string, key: string, cost = 0.01) => recordUsageEvent({ orgCode: org, feature: "sales_chatbot", source: "PLATFORM", provider: "gemini", model: "gemini-3.1-flash-lite", requests: 1, inputTokens: 1000, outputTokens: 100, costUsd: cost, status: "OK", actorId: null, ref: "conv-1", conversationId: "conv-1", modality: "TEXT", eventKey: key });
    assert.deepEqual(await ev(A, `${KEY}:once`), { recorded: true });
    assert.deepEqual(await ev(A, `${KEY}:once`), { recorded: false }, "gói tin trùng ⇒ không dòng thứ hai");
    await assert.rejects(() => recordUsageEvent({ orgCode: A, feature: "sales_chatbot", source: "PLATFORM", provider: null, model: null, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "OK", actorId: null, eventKey: "  " }), /khoá sự kiện/);
    const usageBefore = await sourceUsage(A, "PLATFORM");
    const retries = await Promise.all([1, 2, 3].map(() => ev(A, `${KEY}:retry`, 0.05)));
    assert.equal(retries.filter((r) => r.recorded).length, 1, "AI thử lại 3 lần cùng khoá ⇒ ghi đúng 1");
    const usageAfter = await sourceUsage(A, "PLATFORM");
    assert.ok(Math.abs(usageAfter.costUsdMonth - usageBefore.costUsdMonth - 0.05) < 1e-9, "tiền tính MỘT lần");
    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => ev(A, `${KEY}:c${i}`)));
    assert.equal(concurrent.filter((r) => r.recorded).length, 20, "20 sự kiện khác khoá ghi đồng thời ⇒ đủ 20");
    assert.deepEqual(await ev(B, `${KEY}:once`), { recorded: true }, "cùng khoá ở tổ chức KHÁC là sự kiện khác");
    const rowsA = await pdb.select({ n: sql<number>`count(*)::int` }).from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, A), like(schema.platformAiUsage.eventKey, `${KEY}%`)));
    assert.equal(rowsA[0].n, 22, "1 + 1 thử lại + 20 đồng thời");
    const meterA = await readPeriodUsage({ code: A, isHome: false }, period, new Date(Date.now() + 1000));
    const meterB = await readPeriodUsage({ code: B, isHome: false }, period, new Date(Date.now() + 1000));
    assert.deepEqual([meterA.readings.ai_calls, meterB.readings.ai_calls, meterA.readings.input_tokens], [22, 1, 22_000], "đồng hồ AI lọc đúng tổ chức");

    // ── Màn khách: đơn vị dễ hiểu, KHÔNG token / chi phí.
    const viewA = await loadCustomerPlan(A);
    assert.ok(viewA);
    assert.equal(viewA.quotas.find((r) => r.key === "aiConversations")?.line, "2 / 2 hội thoại AI");
    assert.ok(!/cost|token|usd/i.test(JSON.stringify(Object.keys(viewA))) && !/costUsd|inputTokens|outputTokens/.test(JSON.stringify(viewA)), "khách không thấy token / chi phí AI");
    assert.equal(viewA.features.find((f) => f.key === "api")?.granted, true);

    // ── Màn người vận hành: kinh tế đơn vị + Margin Guard (sau ảnh chụp MRR hôm nay — như trang /platform/saas).
    await captureSaasSnapshot();
    const econ = await loadPricingEconomics(op);
    assert.ok(econ.ok);
    if (econ.ok) {
      const rA = econ.value.tenants.find((t) => t.code === A);
      assert.ok(rA, "tổ chức A có dòng");
      assert.equal(rA.quotas.find((x) => x.key === "aiConversations")?.level, "LIMIT");
      assert.equal(rA.risk, "TRIAL_COST", "chưa trả tiền mà nền tảng đang chịu chi phí AI");
      assert.equal(rA.economics.grossMarginPct, null, "chưa có MRR ⇒ biên —, không phải 0%");
      assert.equal(econ.value.tenants.some((t) => t.code === home.code), false, "nhà không nằm trong bảng khách");
    }
    const adminView = await loadPricingAdmin(op);
    assert.ok(adminView.ok && adminView.value.unitPrices.rows.every((r) => r.confidence === "ESTIMATED"), "mọi giá đơn vị mang nhãn ESTIMATED");
    assert.ok(adminView.ok && !adminView.value.plans.some((p) => p.key === HOME_PLAN_KEY), "gói nội bộ không phải gói bán");
    assert.ok("error" in (await setAiUnitPrices(op, { prices: { "SAI HOA": { input: 1, output: 1 } }, reason: "dòng sai" })));
    assert.ok("ok" in (await setAiUnitPrices(op, { prices: { "model-moi": { input: 0.2, output: 0.8 } }, reason: "Giá nhà cung cấp mới" })));

    // ── Cổng thu tiền: một giao diện, bọc đường SePay đã có.
    const provider = billingProvider();
    assert.equal(provider.key, "SEPAY_BANK_TRANSFER");
    const cancel = await provider.cancelSubscription(op, { orgCode: A, reason: "Khách dừng" });
    assert.ok("ok" in cancel && /không có tự trừ tiền/.test(cancel.message), "không có hoá đơn mở ⇒ nói rõ, không làm gì");

    // ── Trang giá công khai: Liên hệ · dùng thử · chỉ tính năng có thật.
    const pub = await getPublicPricing();
    const ent = pub.plans.find((p) => p.key === "enterprise");
    assert.ok(ent?.contactSales && ent.priceVnd === null, "Doanh nghiệp: «Liên hệ»");
    assert.equal(pub.plans.find((p) => p.key === "trial")?.trialDays, TRIAL_DAYS);
    assert.ok(!pub.plans.some((p) => p.key === HOME_PLAN_KEY), "gói nội bộ không lên trang giá");
    assert.ok(pub.plans.every((p) => p.features.every((k) => FEATURE_SPEC[k].publicClaim)), "chỉ in tính năng cửa hàng tự đăng ký dùng được hôm nay");
    const growth = pub.plans.find((p) => p.key === "growth");
    assert.ok(growth && growth.yearlyPriceVnd === yearlyPriceVnd(growth.priceVnd, growth.yearlyFreeMonths));
  } finally {
    await cleanup(saved);
  }
  console.log(
    "✓ Giá & thu phí (0223): gói cấu hình được + Doanh nghiệp «Liên hệ»; tính năng theo gói / ghi đè / giữ từ trước (migration giữ đủ tính năng cho tổ chức có sẵn, mức áp mềm); nâng · hạ đổi tính năng + hạn mức; ngưỡng 50/80/100, hạn mức mềm không bao giờ chặn, trần cứng cần đủ bốn điều kiện + grace; vượt tính phí / mời nâng gói; đồng hồ đo đúng kỳ, đầu tháng đếm lại; sự kiện trùng / AI thử lại không tính hai lần, 20 ghi đồng thời đủ 20, A không chạm B; dùng thử hết hạn chỉ khoá ghi, không xoá tính năng; khách không thấy token / chi phí; bất thường cần ≥ 5 ngày; đề xuất model cùng họ, không tự đổi; không mã nào so tên gói",
  );
}

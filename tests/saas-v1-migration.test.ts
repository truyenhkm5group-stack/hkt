/**
 * CHUYỂN TỔ CHỨC TỪ GIÁ CŨ SANG BẢNG GIÁ V1 (lib/pricing/migration.ts · scripts/saas-v1-migration.ts · docs/saas/V1_MIGRATION.md)
 * + PHẦN GỒM TÍNH TIỀN DÙNG CHUNG (`billableIncluded`, docs/saas/OVERAGE.md §10 · O1).
 *
 *  1. THUẦN — phân loại (tự đăng ký · NHÀ · đã V1 · phiên bản riêng · hoãn); số chọn gói lấy LỚN NHẤT của đồng
 *     hồ và sổ AI, runtime cũ ⇒ chưa đo; KHÔNG THU ĐÔI GHẾ đã mua thêm; đánh giá gói đích: vượt / chưa đo / mất AI bán hàng / trần
 *     AI sau ghim chặn BYOK / Số dư AI bật / hoá đơn mở / thu phí bật (vượt được bằng cờ) / gói dùng thử bị từ chối / số đếm thật
 *     vượt trần KỸ THUẬT (không vượt được bằng cờ) / trần kỹ thuật hoặc nhịp luật thấp hơn (cờ riêng); ô arg của ops.
 *  2. VÒNG THẬT (PGlite) — chạy thử KHÔNG ghi một dòng nào; ghim đúng MỘT tổ chức: cột gói + ghim V1 + nhật ký ORG_PLAN_SET /
 *     PRICE_VERSION_PIN, thu phí vẫn tắt, không hoá đơn, không điều khoản dùng thử; từ chối gói nhỏ hơn số dùng (không đổi gì);
 *     tổ chức bị loại không đổi; workspace NHÀ không ghim được; legacy `standard` → `starter` bị chặn vì trần kỹ thuật thấp hơn và
 *     vì người dùng thật vượt trần mới; bot dùng khoá riêng (BYOK) KHÔNG bị cổng gói / trần AI chặn sau khi ghim; bảng kê không thu
 *     đôi ghế.
 *
 * Mốc thời gian: dữ liệu gieo theo ĐỒNG HỒ THẬT, một `now` dùng chung cho ghi và đọc (AGENTS mục 50 · 65).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { invalidateAiEntitlement, loadAiEntitlement, salesAiPlanGate } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { aiCustomerBasis, applyV1Migration, assessV1Target, classifyForV1, planV1Migration, remainingBlockers, V1_MIGRATION_DEFERRED, type V1OrgFacts } from "@/lib/pricing/migration";
import { invalidatePriceBook, loadPriceBook, pinOrgPriceVersion } from "@/lib/pricing/price-book";
import { billableIncluded, computeOverage, currentCatalogVersion, parsePlanPrice, PREPAID_AI_VERSION_KEY, type PlanPrice } from "@/lib/pricing/versions";
import { formatV1Row, parseV1Args } from "@/scripts/saas-v1-migration";

/**
 * Khoá phiên bản của bộ giá THỬ ở phần THUẦN — chỉ là nhãn của fixture (không đọc CSDL). Vòng thật KHÔNG gõ khoá V1: nó đọc
 * khoá CATALOG hiện hành từ CSDL sau khi 0228 gieo (`currentCatalogVersion`), đúng thứ lượt ghim dùng.
 */
const FIXTURE_CATALOG_KEY = "v1fixture";
const M1 = "v1mig-a";
const M2 = "v1mig-b";
const SELF = "v1mig-self";
const ORGS = [M1, M2, SELF] as const;

// ─────────────────────────── Bộ giá thử (thuần) — ĐÚNG số của quyết định 07/10/2026 ───────────────────────────

const row = (planKey: string, over: Partial<Parameters<typeof parsePlanPrice>[0]>) =>
  parsePlanPrice({ versionKey: FIXTURE_CATALOG_KEY, planKey, name: planKey, description: null, position: 0, listed: true, highlight: false, contactSales: false, monthlyVnd: null, yearlyVnd: null, yearlyFreeMonths: 2, priceFromVnd: null, trialDays: null, included: {}, overage: {}, features: [], addonPrices: {}, limits: {}, commercial: {}, ...over });
const AI_FEATURES = ["ai_sales", "ai_order_creation", "multi_user"];
const SEAT = { extraFanpageVnd: 99_000, extraUserVnd: 49_000 };
const STARTER = row("starter", { monthlyVnd: 790_000, position: 20, included: { aiCustomers: 1500, fanpages: 3, users: 5, aiConversations: 4500, aiReplies: 30000, orders: null }, overage: { mode: "BILLED", aiCustomerBlockSize: 100, aiCustomerBlockVnd: 59_000, ...SEAT }, features: AI_FEATURES, addonPrices: { users: 49_000 }, commercial: { features: AI_FEATURES } });
const GROWTH = row("growth", { monthlyVnd: 1_490_000, position: 30, included: { aiCustomers: 3000, fanpages: 10, users: 10, aiConversations: 10000, aiReplies: 75000, orders: null }, overage: { mode: "BILLED", aiCustomerBlockSize: 100, aiCustomerBlockVnd: 49_000, ...SEAT }, features: AI_FEATURES, addonPrices: { users: 49_000 }, commercial: { features: AI_FEATURES } });
const INBOX = row("inbox", { monthlyVnd: 299_000, position: 11, included: { aiCustomers: 0, fanpages: 3, users: 3, aiConversations: 0, aiReplies: 0, orders: null }, overage: { mode: "BILLED", ...SEAT }, features: ["multi_page_inbox", "multi_user"], commercial: { features: ["multi_page_inbox", "multi_user"] } });
const TRIAL = row("trial", { trialDays: 7, position: 10, included: { aiCustomers: 100, fanpages: 1, users: 2, aiConversations: 300, aiReplies: 2000, orders: null }, overage: { mode: "NONE" }, features: AI_FEATURES, commercial: { features: AI_FEATURES } });
const LEGACY_STARTER = { ...STARTER, versionKey: "legacy", monthlyVnd: 499_000, overage: { mode: "NONE" as const, aiCustomerBlockSize: null, aiCustomerBlockVnd: null, extraFanpageVnd: null, extraUserVnd: null } };
const CATALOG = { key: FIXTURE_CATALOG_KEY, label: "V1", kind: "CATALOG" as const, effectiveFrom: new Date("2026-10-06T17:00:00Z"), taxMode: "UNDECLARED" as const, taxNote: null, alerts: { notifyPct: 80, overagePct: 100, strongPct: 120, reviewPct: 150 }, note: null };
const LOOSE = { requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: null, hard: null }, platformCreditUsdPerMonth: 10 };
const ZERO_USE = { requestsToday: 0, requestsMonth: 0, costUsdMonth: 0, unknownCostMonth: 0 };
const LIMITS_STARTER = { users: 5, pages: 10, objects: 5, records: 5000, workflows: 10, aiDraftsPerDay: 20, storageMb: 1024 };
const COUNTS_SMALL = { users: 3, pages: 1, objects: 0, records: 10, workflows: 1, aiDraftsPerDay: 0, storageMb: 0.5 };
const planRow = (key: string, limits: Record<string, unknown>) => ({ key, name: key, description: null, limits, position: 0, priceVnd: null, addonPrices: {}, yearlyFreeMonths: 2, commercial: {} });

function facts(over: Partial<V1OrgFacts> = {}): V1OrgFacts {
  return {
    org: { code: "x", name: "X", status: "ACTIVE", isHome: false, plan: "starter", brand: null },
    planKey: "starter",
    pinKey: "legacy",
    version: { ...CATALOG, key: "legacy", kind: "LEGACY_SNAPSHOT", effectiveFrom: null },
    currentPrice: LEGACY_STARTER,
    catalog: CATALOG,
    catalogPrices: [TRIAL, INBOX, STARTER, GROWTH],
    plans: [
      planRow("inbox", { users: 3, pages: 5, objects: 2, records: 2000, workflows: 5, aiDraftsPerDay: 10, storageMb: 512, ai: { requestsPerDay: 20, requestsPerMonth: 300, costUsdPerMonth: { soft: 15, hard: 30 }, platformCreditUsdPerMonth: 0 } }),
      planRow("starter", { ...LIMITS_STARTER }),
      planRow("growth", { users: 15, pages: 30, objects: 15, records: 30000, workflows: 30, aiDraftsPerDay: 50, storageMb: 4096 }),
    ],
    usage: { aiCustomers: { meter: 40, meterCoverage: "PARTIAL", meterNote: null, ledgerConversations: 120, ledgerUnattributed: 0, basis: 120, basisNote: "" }, fanpages: 2, users: 3, needsAiSales: true },
    entitlements: { before: { ...LIMITS_STARTER }, counts: { ...COUNTS_SMALL }, cadenceBeforeMinutes: 10 },
    addons: {},
    quotaOverrides: {},
    grandfathered: false,
    featureOverrides: {},
    featuresBefore: ["ai_sales", "ai_order_creation", "multi_user"],
    billing: { enabled: false, paidThrough: null, openInvoices: 0 },
    aiBalanceOn: false,
    chotdonOwnPlanKey: null,
    ai: { override: {}, before: LOOSE, usage: { BYOK: ZERO_USE, PLATFORM: ZERO_USE }, criticalBelowPct: 60 },
    readErrors: [],
    ...over,
  };
}
const codes = (a: { blockers: { code: string }[] }) => a.blockers.map((b) => b.code).sort();

function testPure() {
  // ── Phân loại.
  const legacy = { key: "legacy", kind: "LEGACY_SNAPSHOT" as const };
  const ok = (o: Partial<{ code: string; status: string; brand: "vnx" | "chotdon" | null; isHome: boolean }>, pinKey: string | null, version: { key: string; kind: "LEGACY_SNAPSHOT" | "CATALOG" } | null) =>
    classifyForV1({ org: { code: "a", status: "ACTIVE", brand: null, isHome: false, ...o } as never, pinKey, version });
  assert.deepEqual(ok({}, "legacy", legacy), { eligible: true }, "ghim legacy ⇒ đủ điều kiện");
  const ex = (r: ReturnType<typeof classifyForV1>) => (r.eligible ? null : r.exclusion);
  assert.equal(ex(ok({ isHome: true }, null, legacy)), "HOME", "nhà không đổi gói qua lượt chuyển khách (đi pricing-internal-fit)");
  assert.equal(ex(ok({ isHome: true }, "legacy", legacy)), "HOME");
  assert.equal(ex(ok({ brand: "chotdon" }, "legacy", legacy)), "SELF_SIGNUP", "cửa hàng tự đăng ký bị loại kể cả khi ghim legacy");
  assert.equal(ex(ok({}, null, { key: FIXTURE_CATALOG_KEY, kind: "CATALOG" })), "ALREADY_CATALOG");
  assert.equal(ex(ok({}, PREPAID_AI_VERSION_KEY, { key: PREPAID_AI_VERSION_KEY, kind: "LEGACY_SNAPSHOT" })), "SPECIAL_VERSION", "phiên bản trả trước (#674) không bị kéo sang V1");
  assert.equal(ex(ok({ status: "ARCHIVED" }, "legacy", legacy)), "NOT_ACTIVE");
  assert.equal(ex(ok({ code: "hslc-hmt-shop" }, "legacy", legacy)), "DEFERRED", "HSLC hoãn — lộ trình trả trước");
  assert.ok(V1_MIGRATION_DEFERRED["hslc-hmt-shop"]);

  // ── Số chọn gói.
  assert.equal(aiCustomerBasis({ meter: 40, meterCoverage: "PARTIAL", meterNote: null, ledgerConversations: 120, ledgerUnattributed: 0 }).basis, 120, "lấy LỚN NHẤT (phía an toàn)");
  assert.equal(aiCustomerBasis({ meter: 900, meterCoverage: "MEASURED", meterNote: null, ledgerConversations: 120, ledgerUnattributed: 0 }).basis, 900);
  assert.equal(aiCustomerBasis({ meter: null, meterCoverage: "NOT_MEASURED", meterNote: "runtime cũ", ledgerConversations: 5000, ledgerUnattributed: 0 }).basis, null, "runtime cũ ⇒ chưa đo, không ước bằng sổ thiếu");
  assert.match(aiCustomerBasis({ meter: 1, meterCoverage: "PARTIAL", meterNote: null, ledgerConversations: 3, ledgerUnattributed: 2 }).basisNote, /không chắc là cận trên/);

  // ── KHÔNG THU ĐÔI GHẾ (O1): Starter gồm 5 + mua thêm 2 = 7; dùng đủ 7 ⇒ không có «người dùng thêm».
  const inc = billableIncluded(STARTER.included, { addons: { users: 2 } });
  assert.equal(inc.users, 7);
  const users7 = (included: PlanPrice["included"]) => computeOverage({ ...STARTER, included }, { aiCustomers: 0, aiCustomersCoverage: "MEASURED", fanpages: 1, users: 7, aiConversations: null, aiReplies: null }).lines.find((l) => l.key === "users")!.amountVnd;
  assert.equal(users7(STARTER.included), 98_000, "dòng giá thô: 2 × 49.000 — đây là phần THU ĐÔI cũ");
  assert.equal(users7(inc), 0, "phần gồm tính tiền cộng ghế đã mua ⇒ không thu đôi");
  assert.equal(computeOverage({ ...STARTER, included: inc }, { aiCustomers: 0, aiCustomersCoverage: "MEASURED", fanpages: 1, users: 8, aiConversations: null, aiReplies: null }).lines.find((l) => l.key === "users")!.amountVnd, 49_000, "ghế thứ 8 (chưa mua) vẫn tính");
  assert.equal(billableIncluded(STARTER.included, { quotaOverrides: { users: 12, fanpages: 4 }, addons: { users: 1 } }).users, 13, "ghi đè của người vận hành thắng dòng giá, rồi cộng ghế mua thêm");
  assert.equal(billableIncluded(STARTER.included, { quotaOverrides: { fanpages: 4 } }).fanpages, 4);
  assert.equal(billableIncluded({ ...STARTER.included, users: null }, { addons: { users: 3 } }).users, null, "không giới hạn vẫn không giới hạn");
  assert.equal(billableIncluded({ ...STARTER.included, users: undefined }, { addons: { users: 3 } }).users, undefined, "chưa khai vẫn chưa khai");
  assert.equal(billableIncluded(STARTER.included, { addons: { pages: 5 } }).fanpages, 3, "mua thêm «trang tuỳ biến» KHÔNG phải fanpage");

  // ── Đánh giá gói đích.
  const fine = assessV1Target(facts(), "starter");
  assert.deepEqual(codes(fine), [], JSON.stringify(fine.blockers));
  assert.deepEqual([fine.priceBeforeVnd, fine.priceAfterVnd, fine.overage?.totalVnd], [499_000, 790_000, 0]);
  const big = assessV1Target(facts({ usage: { ...facts().usage, aiCustomers: { ...facts().usage.aiCustomers, basis: 1650 } } }), "starter");
  assert.deepEqual(codes(big), ["OVERAGE_EXPECTED"], "gói nhỏ hơn số dùng ⇒ chặn");
  assert.equal(big.overage?.totalVnd, 118_000, "150 khách vượt ⇒ 2 khối × 59.000");
  assert.deepEqual(remainingBlockers(big, { overage: true }), [], "--accept-overage vượt được chặn vượt");
  assert.deepEqual(codes(assessV1Target(facts({ usage: { ...facts().usage, aiCustomers: { ...facts().usage.aiCustomers, basis: null } } }), "starter")), ["USAGE_UNKNOWN"], "chưa đo ⇒ chặn (vượt được bằng --accept-overage)");
  const inbox = assessV1Target(facts({ ai: { ...facts().ai, usage: { BYOK: { ...ZERO_USE, requestsToday: 25 }, PLATFORM: ZERO_USE } } }), "inbox");
  assert.ok(codes(inbox).includes("NO_AI_SALES"), "Inbox với tổ chức bot đang chạy ⇒ chặn");
  assert.ok(codes(inbox).includes("AI_WOULD_BLOCK"), "trần AI của gói đích chặn lượt BYOK đang chạy được ⇒ chặn");
  assert.ok(remainingBlockers(inbox, { overage: true, billingOn: true }).some((b) => b.code === "NO_AI_SALES"), "mất AI bán hàng KHÔNG vượt được bằng cờ");
  const byok = assessV1Target(facts({ ai: { ...facts().ai, usage: { BYOK: { requestsToday: 900, requestsMonth: 20_000, costUsdMonth: 400, unknownCostMonth: 0 }, PLATFORM: ZERO_USE } } }), "starter");
  assert.equal(byok.aiAfter?.BYOK.ok, true, "gói AI của V1 không trần cứng ⇒ bot BYOK dùng nhiều vẫn chạy sau khi ghim");
  assert.deepEqual(codes(byok), []);
  assert.deepEqual(codes(assessV1Target(facts({ aiBalanceOn: true }), "starter")), ["AI_BALANCE_ON"]);
  assert.deepEqual(codes(assessV1Target(facts({ billing: { enabled: false, paidThrough: null, openInvoices: 1 } }), "starter")), ["OPEN_INVOICE"]);
  const billingOn = assessV1Target(facts({ billing: { enabled: true, paidThrough: "2026-11-01", openInvoices: 0 } }), "starter");
  assert.deepEqual(codes(billingOn), ["BILLING_ON"]);
  assert.deepEqual(remainingBlockers(billingOn, { billingOn: true }), [], "--accept-billing-on vượt được chặn thu phí");
  assert.deepEqual(codes(assessV1Target(facts(), "trial")), ["TARGET_NOT_SELLABLE"], "không bao giờ ghim vào gói dùng thử (luật dùng thử dừng AI)");
  assert.deepEqual(codes(assessV1Target(facts(), "basic")), ["TARGET_NOT_IN_CATALOG"]);
  assert.deepEqual(codes(assessV1Target(facts({ featuresBefore: ["ai_sales", "api"] }), "starter")), ["FEATURE_LOSS"], "mất tính năng đang có ⇒ chặn");
  assert.deepEqual(codes(assessV1Target(facts({ featuresBefore: ["ai_sales", "api"], grandfathered: true }), "starter")), [], "tổ chức giữ từ trước không mất gì");
  assert.deepEqual(codes(assessV1Target(facts({ chotdonOwnPlanKey: "growth" }), "starter")), ["CHOTDON_OWN_PLAN"]);

  // ── Trần KỸ THUẬT (checkEntitlement): số đếm thật vượt trần mới ⇒ chặn KHÔNG vượt được; trần / nhịp thấp hơn ⇒ cờ riêng.
  const standard = { users: 25, pages: 50, objects: 20, records: 50000, workflows: 50, aiDraftsPerDay: 100, storageMb: 2048 };
  const down = assessV1Target(facts({ entitlements: { before: standard, counts: { ...COUNTS_SMALL }, cadenceBeforeMinutes: 10 } }), "starter");
  assert.deepEqual(codes(down), ["LOWER_LIMITS"], "legacy standard → starter: trần kỹ thuật thấp hơn hôm nay");
  assert.match(down.blockers[0].message, /người dùng 25 → 5/);
  assert.deepEqual(remainingBlockers(down, { lowerLimits: true }), [], "--accept-lower-limits vượt được trần thấp hơn");
  assert.deepEqual(remainingBlockers(down, { overage: true, billingOn: true }).map((b) => b.code), ["LOWER_LIMITS"], "--accept-overage KHÔNG che trần thấp hơn");
  const seven = assessV1Target(facts({ usage: { ...facts().usage, users: 7 }, entitlements: { before: standard, counts: { ...COUNTS_SMALL, users: 7, records: 9000 }, cadenceBeforeMinutes: 10 } }), "starter");
  assert.ok(codes(seven).includes("ENTITLEMENT_BELOW_USAGE"), JSON.stringify(seven.blockers));
  assert.match(seven.blockers.find((b) => b.code === "ENTITLEMENT_BELOW_USAGE")!.message, /người dùng đang có 7 > trần mới 5[\s\S]*bản ghi tuỳ biến đang có 9\.000 > trần mới 5\.000/);
  assert.match(seven.blockers.find((b) => b.code === "OVERAGE_EXPECTED")!.message, /KHÔNG thêm được người dùng/, "câu phần vượt người dùng nói rõ không thêm được người dùng");
  assert.ok(remainingBlockers(seven, { overage: true, billingOn: true, lowerLimits: true }).some((b) => b.code === "ENTITLEMENT_BELOW_USAGE"), "số dùng vượt trần kỹ thuật KHÔNG vượt được bằng cờ");
  assert.deepEqual(codes(assessV1Target(facts({ addons: { users: 2 }, usage: { ...facts().usage, users: 7 }, entitlements: { before: { ...LIMITS_STARTER, users: 7 }, counts: { ...COUNTS_SMALL, users: 7 }, cadenceBeforeMinutes: 10 } }), "starter")), [], "ghế đã mua thêm cộng vào trần mới (5 + 2 = 7)");
  const atCap = assessV1Target(facts({ usage: { ...facts().usage, users: 5 }, entitlements: { before: { ...LIMITS_STARTER }, counts: { ...COUNTS_SMALL, users: 5 }, cadenceBeforeMinutes: 10 } }), "starter");
  assert.ok(atCap.warnings.some((w) => /KHÔNG thêm được người dùng/.test(w)), "chạm trần mới ⇒ nói ra");
  const slow = assessV1Target(facts({ plans: [planRow("starter", { ...LIMITS_STARTER, workflowCadenceMinutes: 30 })] }), "starter");
  assert.deepEqual(codes(slow), ["LOWER_LIMITS"], "nhịp luật tự động chậm hơn cũng là trần thấp hơn");
  assert.match(slow.blockers[0].message, /nhịp luật tự động 10 → 30 phút/);
  assert.deepEqual(codes(assessV1Target(facts({ entitlements: { before: null, counts: null, cadenceBeforeMinutes: 10 } }), "starter")), ["READ_FAILED"], "không đọc được trần / số đếm ⇒ không ghim");
  const addon = assessV1Target(facts({ addons: { storageMb: 1024 } }), "starter");
  assert.deepEqual(codes(addon), [], "mua thêm hạng mục gói đích không bán: thu phí tắt ⇒ chỉ lưu ý");
  assert.ok(addon.warnings.some((w) => /không bán/.test(w)));
  assert.ok(codes(assessV1Target(facts({ addons: { storageMb: 1024 }, billing: { enabled: true, paidThrough: "2026-11-01", openInvoices: 0 } }), "starter")).includes("ADDON_NOT_SOLD"));

  // ── Ô arg của ops.
  assert.deepEqual(parseV1Args([]), { ok: true, apply: false, org: null, plan: null, reason: null, acceptOverage: false, acceptBillingOn: false, acceptLowerLimits: false });
  const ap = parseV1Args(["--apply", "--org=abc-shop", "--plan=starter", "--reason=chu", "shop", "giao", "08/10", "--accept-overage", "--accept-lower-limits"]);
  assert.ok(ap.ok && ap.apply && ap.org === "abc-shop" && ap.plan === "starter" && ap.reason === "chu shop giao 08/10" && ap.acceptOverage && !ap.acceptBillingOn && ap.acceptLowerLimits, JSON.stringify(ap));
  // Câu lỗi đi ra kênh tóm tắt CÔNG KHAI ⇒ không chép nội dung ô arg.
  for (const leak of [["--bimat-0912345678"], ["--org=abc", "--org=abc"], ["--apply", "--org=abc", "--plan=x"]]) {
    const r = parseV1Args(leak);
    assert.ok(!r.ok && !/0912345678|abc|«/.test(r.error), r.ok ? "" : r.error);
  }
  for (const bad of [["--apply", "--org=a1"], ["--plan=starter"], ["--apply", "--plan=starter", "--reason=abcdef"], ["--apply", "--org=abc", "--plan=starter", "--reason=ab"], ["--x"], ["--org=abc", "--org=abd"], ["--org=ABC"]]) assert.equal(parseV1Args(bad).ok, false, bad.join(" "));
}

// ─────────────────────────── Vòng thật (PGlite) ───────────────────────────

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const t of [schema.platformUsageEvents, schema.platformAiUsage, schema.platformPricePins, schema.platformSubscriptions, schema.platformInvoices, schema.platformOrgPricing]) await pdb.delete(t).where(inArray(t.orgCode, [...ORGS]));
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
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
  invalidatePriceBook();
  invalidateAiEntitlement();
}

/** Ảnh chụp mọi thứ một lượt ghim có thể chạm tới — chạy thử phải để nó NGUYÊN. */
async function footprint() {
  const pdb = await getPlatformDb();
  const orgs = await pdb.select({ code: schema.platformOrganizations.code, plan: schema.platformOrganizations.plan }).from(schema.platformOrganizations).where(inArray(schema.platformOrganizations.code, [...ORGS]));
  const pins = await pdb.select({ o: schema.platformPricePins.orgCode, v: schema.platformPricePins.versionKey }).from(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  const [audit] = await pdb.select({ n: sql<number>`count(*)::int` }).from(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  const subs = await pdb.select().from(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  const [inv] = await pdb.select({ n: sql<number>`count(*)::int` }).from(schema.platformInvoices).where(inArray(schema.platformInvoices.orgCode, [...ORGS]));
  const sort = <T>(xs: T[]) => JSON.stringify(xs.map((x) => JSON.stringify(x)).sort());
  return { orgs: sort(orgs), pins: sort(pins), audit: audit?.n ?? 0, subs: sort(subs), invoices: inv?.n ?? 0 };
}

export async function testSaasV1Migration() {
  testPure();
  await cleanup();
  const pdb = await getPlatformDb();
  const now = new Date();
  for (const code of ORGS)
    await provisionOrganization({ code, name: `Tổ chức ${code}`, ...(code === SELF ? { brand: "chotdon" as const } : {}), modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "V1Migration@12345" }, source: "TEST", actor: null });
  try {
    // Ba tổ chức "có từ trước V1": gói cũ `starter`, ghim legacy (như 0228 đã ghim 8/8 tổ chức khách).
    for (const code of ORGS) {
      await pdb.update(schema.platformOrganizations).set({ plan: code === M2 ? "standard" : "starter" }).where(eq(schema.platformOrganizations.code, code));
      await pinOrgPriceVersion(code, "legacy", { source: "TEST", reason: "giả lập 0228", email: null });
    }
    invalidateOrganizations();
    invalidatePricing();
    const book = await loadPriceBook({ fresh: true });
    // Khoá V1 đọc từ CSDL sau khi 0228 gieo — bảng giá CATALOG đang hiệu lực, đúng phiên bản lượt ghim sẽ dùng.
    const v1Key = currentCatalogVersion(book, now)?.key ?? null;
    assert.ok(v1Key && book.prices.some((p) => p.versionKey === v1Key && p.planKey === "starter" && p.monthlyVnd === 790_000), `bảng giá CATALOG hiện hành phải là V1 (Starter 790.000 ₫) — đọc được «${v1Key}»`);

    // M2: 1.600 hội thoại có lượt AI bán hàng trong 30 ngày (sổ AI) ⇒ số chọn gói 1.600 > 1.500 của Starter.
    await pdb.execute(sql`
      insert into platform_ai_usage (id, at, org_code, feature, billing_source, requests, status, conversation_id)
      select gen_random_uuid()::text, ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz, ${M2}, 'sales_chatbot', 'BYOK', 1, 'OK', 'v1mig-conv-' || g::text
      from generate_series(1, 1600) g`);
    // M2 có 7 người dùng đang bật (1 quản trị + 6) — vừa trần `standard` (25), vượt Starter V1 (5).
    await withOrganization(M2, async () => {
      const db = await getDb();
      await db.insert(schema.users).values(Array.from({ length: 6 }, (_, i) => ({ email: `nv${i}@${M2}.local`, name: `NV ${i}`, passwordHash: "x", active: true })));
    });
    // Gói cũ `standard` không khai tính năng ⇒ M2 có từ trước 0222 giữ mọi tính năng (grandfathered) như tổ chức thật.
    await pdb.insert(schema.platformOrgPricing).values({ orgCode: M2, grandfathered: true, reason: "có từ trước 0222" });
    invalidatePricing(M2);
    // M1: bot chạy bằng KHOÁ RIÊNG (BYOK) — vài lượt hôm nay.
    for (let i = 0; i < 12; i++) await recordAiUsage({ orgCode: M1, feature: "sales_chatbot", source: "BYOK", provider: "gemini", model: "gemini-test", requests: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.001, status: "OK", actorId: null, ref: `v1mig-a-conv-${i}`, conversationId: `v1mig-a-conv-${i}` });

    // ── 1. CHẠY THỬ: không ghi một dòng nào.
    const before = await footprint();
    const dry = await planV1Migration({ now });
    const mine = dry.rows.filter((r) => (ORGS as readonly string[]).includes(r.code));
    const byCode = new Map(mine.map((r) => [r.code, r]));
    assert.equal(byCode.get(SELF)?.exclusion, "SELF_SIGNUP", "cửa hàng tự đăng ký bị loại");
    const a = byCode.get(M1)!;
    assert.ok(a.eligible && a.facts, "M1 đủ điều kiện");
    assert.deepEqual([a.facts!.usage.users, a.facts!.usage.needsAiSales, a.facts!.usage.aiCustomers.ledgerConversations], [1, true, 12]);
    assert.equal(a.fit?.plan?.planKey, "starter", a.fit?.reason);
    assert.deepEqual(a.proposal?.blockers.map((x) => x.code), [], JSON.stringify(a.proposal?.blockers));
    assert.equal(a.proposal?.priceAfterVnd, 790_000);
    const b = byCode.get(M2)!;
    assert.equal(b.facts?.usage.aiCustomers.basis, 1600, b.facts?.usage.aiCustomers.basisNote);
    assert.deepEqual([b.facts?.entitlements.counts?.users, b.facts?.entitlements.before?.users], [7, 25], "số đếm thật + trần kỹ thuật hôm nay (standard)");
    const home = await getHomeOrganization();
    const h = dry.rows.find((r) => r.code === home.code);
    assert.ok(h && !h.eligible && h.exclusion === "HOME" && h.facts !== null && h.proposal === null, "nhà: chạy thử vẫn in số dùng, không đề xuất ghim");
    assert.equal(b.fit?.plan?.planKey, "growth", "1.600 khách AI ⇒ Growth là gói nhỏ nhất vừa");
    const out = formatV1Row(b);
    assert.ok(out.pub.every((l) => !/₫|\d{3}\.\d{3}/.test(l)), `dòng công khai không mang tiền / số dùng: ${out.pub.join(" | ")}`);
    assert.ok(out.priv.some((l) => /1\.490\.000 ₫/.test(l)), "phần mã hoá in giá mới");
    assert.deepEqual(await footprint(), before, "chạy thử KHÔNG ghi gì");

    // ── 2. Từ chối gói nhỏ hơn số dùng — không đổi gì.
    const refused = await applyV1Migration({ orgCode: M2, planKey: "starter", reason: "thử ghim gói nhỏ", now, source: "TEST" });
    assert.ok(!refused.applied && /OVERAGE_EXPECTED/.test(refused.message) && /LOWER_LIMITS/.test(refused.message) && /ENTITLEMENT_BELOW_USAGE/.test(refused.message), refused.message);
    const forced = await applyV1Migration({ orgCode: M2, planKey: "starter", reason: "ep moi co chap nhan", acceptOverage: true, acceptBillingOn: true, acceptLowerLimits: true, now, source: "TEST" });
    assert.ok(!forced.applied && /ENTITLEMENT_BELOW_USAGE/.test(forced.message), "người dùng thật vượt trần kỹ thuật ⇒ không cờ nào vượt được");
    const homeTry = await applyV1Migration({ orgCode: home.code, planKey: "scale", reason: "thu ghim workspace nha", acceptOverage: true, acceptLowerLimits: true, now, source: "TEST" });
    assert.ok(!homeTry.applied && /NHÀ/.test(homeTry.message), homeTry.message);
    assert.deepEqual(await footprint(), before, "từ chối ⇒ không ghi gì");
    // Tổ chức bị loại không đổi, kể cả khi người bấm chỉ định gói.
    const self = await applyV1Migration({ orgCode: SELF, planKey: "starter", reason: "thử ghim cửa hàng tự đăng ký", now, source: "TEST" });
    assert.ok(!self.applied && /tự đăng ký/.test(self.message), self.message);
    assert.equal((await applyV1Migration({ orgCode: M1, planKey: "starter", reason: "ab", now, source: "TEST" })).applied, false, "cần lý do");
    assert.deepEqual(await footprint(), before);

    // ── 3. GHIM ĐÚNG MỘT tổ chức.
    const ok = await applyV1Migration({ orgCode: M1, planKey: "starter", reason: "Chuyển V1 theo chủ shop 08/10", now, source: "TEST" });
    assert.ok(ok.applied, ok.message);
    const after = await footprint();
    assert.equal(after.invoices, before.invoices, "không tạo hoá đơn");
    assert.equal(after.subs, before.subs, "thuê bao / thu phí / dùng thử không bị chạm");
    const pins = await pdb.select().from(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
    assert.deepEqual(pins.map((p) => [p.orgCode, p.versionKey]).sort(), [[M1, v1Key], [M2, "legacy"], [SELF, "legacy"]].sort(), "chỉ M1 đổi ghim — sang đúng bảng giá CATALOG hiện hành");
    assert.equal(pins.find((p) => p.orgCode === M1)?.source, "TEST");
    const plan = (await pdb.select({ plan: schema.platformOrganizations.plan }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, M1)))[0]?.plan;
    assert.equal(plan, "starter");
    const logs = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, M1), inArray(schema.platformAuditLog.action, ["ORG_PLAN_SET", "PRICE_VERSION_PIN"])));
    assert.deepEqual(logs.map((l) => l.action).sort(), ["ORG_PLAN_SET", "PRICE_VERSION_PIN"], "hai dòng nhật ký nền tảng");
    assert.ok(logs.every((l) => l.source === "TEST" && l.reason === "Chuyển V1 theo chủ shop 08/10"));
    const sub = (await pdb.select().from(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, M1)))[0];
    assert.ok(!sub || (sub.billingEnabled === false && sub.trialEndsAt === null), "thu phí vẫn tắt, không điều khoản dùng thử");
    // Đã V1 ⇒ lượt sau bị loại (không ghim hai lần).
    assert.match((await applyV1Migration({ orgCode: M1, planKey: "starter", reason: "bấm lần hai", now, source: "TEST" })).message, /bảng giá niêm yết/);

    // ── 4. Bot BYOK KHÔNG bị chặn sau khi ghim: cổng gói cho, trần AI (BYOK) cho.
    invalidateAiEntitlement(M1);
    const ent = await loadAiEntitlement(M1, { now, fresh: true });
    assert.deepEqual([ent.allowed, ent.trial, ent.planKey], [true, false, "starter"], JSON.stringify(ent));
    const gate = await withOrganization(M1, () => salesAiPlanGate({ now }));
    assert.deepEqual(gate, { ok: true });
    const q = await checkAiQuota(M1, "BYOK", { now, notify: false });
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal(q.limits.costUsdPerMonth.hard, null, "gói AI của V1: không trần tiền cứng");
    // Số dư AI (cổng theo hội thoại) chưa bật ⇒ khách mới vẫn được trả lời.
    const conv = await withOrganization(M1, () => salesAiPlanGate({ now, conversation: { channel: "FANPAGE", pageId: "p1", threadId: "t-new", visitorKey: "v-new" } }));
    assert.deepEqual(conv, { ok: true });

    // ── 5. Bảng kê / màn khách không thu đôi ghế: M1 mua thêm 2 người dùng ⇒ phần gồm tính tiền 7.
    const { loadCommercialSnapshot } = await import("@/lib/saas/customers");
    await pdb.insert(schema.platformSubscriptions).values({ orgCode: M1, billingEnabled: false, addons: { users: 2 } }).onConflictDoUpdate({ target: schema.platformSubscriptions.orgCode, set: { addons: { users: 2 } } });
    invalidateSubscriptions(M1);
    const snap = await loadCommercialSnapshot({ now });
    const ws = snap.customers.flatMap((c) => c.workspaces).find((w) => w.code === M1)!;
    const usersLine = ws.pricing.overage?.lines.find((l) => l.key === "users");
    assert.deepEqual([usersLine?.included, usersLine?.amountVnd], [7, 0], "bảng kê: phần gồm = 5 + 2 ghế đã mua");
    const { loadCustomerPlan } = await import("@/lib/pricing/customer");
    const cust = await loadCustomerPlan(M1, now);
    assert.equal(cust?.meter?.users.included, 7, "màn khách: CÙNG phần gồm với bảng kê");

    // ── 6. Legacy standard → Growth: vừa số dùng, chỉ còn trần thấp hơn ⇒ ghim được khi người bấm chấp nhận tường minh.
    const g = await applyV1Migration({ orgCode: M2, planKey: "growth", reason: "standard len growth", now, source: "TEST" });
    assert.ok(!g.applied && /LOWER_LIMITS/.test(g.message) && !/ENTITLEMENT_BELOW_USAGE|OVERAGE_EXPECTED/.test(g.message), g.message);
    const g2 = await applyV1Migration({ orgCode: M2, planKey: "growth", reason: "standard len growth", acceptLowerLimits: true, now, source: "TEST" });
    assert.ok(g2.applied, g2.message);
    const audits = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, M2), eq(schema.platformAuditLog.action, "PRICE_VERSION_PIN")));
    assert.deepEqual(audits.map((x) => (x.after as { accepted?: string[] }).accepted), [["LOWER_LIMITS"]], "nhật ký ghi lại chặn đã được chấp nhận");
    assert.equal(await pdb.select().from(schema.platformInvoices).where(and(eq(schema.platformInvoices.orgCode, M1))).then((r) => r.length), 0);
  } finally {
    await cleanup();
  }
}

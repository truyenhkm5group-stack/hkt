/**
 * PHASE 14 — VNXCommerce đi CÙNG đường thương mại với khách ngoài (docs/saas/ENTITLEMENTS.md · PLAN.md Phase 14).
 *
 * Trước bản này, workspace nhà được "miễn" ở năm chỗ thương mại bằng `if (org.isHome)`: `planKeyOf`, `resolvePlan`,
 * `checkEntitlement`, `featureGranted` (nhánh HOME), `resolveOrgPricing` / `checkUsageQuota`, và trang `/settings/plan`.
 * Nay nhà đọc gói được GÁN cho nó qua ĐÚNG đường của khách: cột `platform_organizations.plan` (0225 ghi thành dữ liệu
 * đúng gói mã cũ tự gán — `internal`) → `platform_plans` → ghi đè `platform_org_pricing` → giữ từ trước. Không có gói ẩn
 * vô hạn nào trong mã (quyết định giá V1, 07/10/2026): gán gói khác cho nhà = ghi cột đó, resolver không phải sửa (bài so
 * này thì đổi theo — đó là thay đổi hành vi có chủ đích). Cột TRỐNG ở nhà ⇒ `internal` (nhánh khả dụng, xem `planKeyOf`).
 *
 * BÀI SO TRƯỚC / SAU. `legacyHomeDecisions()` là kết quả của mã CŨ (main 0b5ec24f) cho workspace nhà, chép thành giá trị:
 * mọi tính năng có, mọi hạn mức `{ ok: true, used: null, limit: null }`, mọi ô hạn mức tháng `UNLIMITED`, gói không giới hạn,
 * trang gói không có khung thanh toán / hạn mức tháng. Bài kiểm đã chạy NGUYÊN VĂN trên mã cũ (trước khi gỡ nhánh) và xanh —
 * tức bộ giá trị này đúng là hành vi cũ, không phải hành vi mới chép lại. Sau khi gỡ, `currentHomeDecisions()` (mã mới, đọc
 * thật từ CSDL) phải bằng nó TỪNG Ô.
 *
 * KIỂM ĐỘT BIẾN NGAY TRONG BÀI: nhà nay phụ thuộc DỮ LIỆU, nên phá dữ liệu phải làm bài so đỏ — gắn nhà vào `trial`, bỏ
 * một tính năng khỏi gói đang gán, đặt trần người dùng = 0, đặt trần hội thoại AI, ghi đè tắt một tính năng của nhà ⇒
 * bộ so PHẢI thấy khác. Một bộ so không bao giờ đỏ thì không chứng minh được gì. Gói gán cho nhà vắng khỏi sổ ⇒ nhà theo
 * đúng luật của khách (lùi về `trial`, báo `fellBack`) — không còn bản dựng sẵn "nhà = vô hạn".
 *
 * Mốc thời gian: không ghim ngày (luật 50 · 65) — đồng hồ đo đọc `new Date()` cùng nhịp với hàm được kiểm.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { checkEntitlement, getPlanUsage, planKeyOf, resolvePlan } from "@/lib/entitlements/check";
import { ENTITLEMENT_KINDS, HOME_PLAN_KEY } from "@/lib/entitlements/kinds";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { addDays, vnDate } from "@/lib/billing/rules";
import { invalidateSubscriptions, orgBillingStanding } from "@/lib/billing/standing";
import { loadTenantBilling } from "@/lib/billing/service";
import { QUOTA_KEYS } from "@/lib/pricing/catalog";
import { checkUsageQuota, featureDecisions, hasFeature, invalidatePricing, resolveOrgPricing } from "@/lib/pricing/entitlements";
import { FEATURE_KEYS } from "@/lib/pricing/features";
import { loadCustomerPlan, loadPlanPageFrame, planPageFrame } from "@/lib/pricing/customer";
import { accountOfWorkspace, updateAccount } from "@/lib/saas/accounts";
import { loadMyProducts } from "@/lib/saas/portal";
import { billingLockApplies } from "@/lib/saas/policy";

const MIGRATION = "drizzle/0225_internal_plan_binding.sql";
const DELTAS = [1, 1_000_000] as const;
const USAGE_QUOTAS = ["aiConversations", "aiMessages", "orders", "fanpages"] as const;

type Decisions = Record<string, unknown>;

/** Hành vi CŨ của mọi quyết định thương mại cho workspace nhà — giá trị, không gọi mã. */
function legacyHomeDecisions(planName: string, planDescription: string | null): Decisions {
  const out: Decisions = {};
  for (const k of FEATURE_KEYS) {
    out[`hasFeature:${k}`] = true;
    out[`featureDecision:${k}`] = true;
  }
  for (const kind of ENTITLEMENT_KINDS) for (const d of DELTAS) out[`checkEntitlement:${kind}:${d}`] = { ok: true, kind, planKey: HOME_PLAN_KEY, used: null, limit: null };
  for (const key of USAGE_QUOTAS)
    for (const d of DELTAS) out[`checkUsageQuota:${key}:${d}`] = { key, used: null, included: null, pct: null, level: "UNLIMITED", action: "NONE", blocked: false, graceLimit: null, overageUnits: 0, overageVnd: null, message: null };
  const unlimited = Object.fromEntries(ENTITLEMENT_KINDS.map((k) => [k, null]));
  out.resolvePlan = { key: HOME_PLAN_KEY, name: planName, description: planDescription, limits: unlimited, planLimits: unlimited, addons: {}, undeclared: [], fellBack: false };
  for (const kind of ENTITLEMENT_KINDS) out[`planUsage:${kind}`] = { limit: null, undeclared: false };
  out["pricing:quotas"] = Object.fromEntries(QUOTA_KEYS.map((k) => [k, null]));
  out["pricing:row"] = { grandfathered: false, featureOverrides: {}, quotaOverrides: {}, enforcement: "SOFT", reason: null, updatedByEmail: null, updatedAt: null };
  out["pricing:fellBack"] = false;
  out["pricing:planKey"] = HOME_PLAN_KEY;
  out.planKeyOf = HOME_PLAN_KEY;
  // Trang /settings/plan: nhà không có khung thanh toán, không có khung «Hạn mức tháng này».
  out["page:billing"] = null;
  out["page:customerPlan"] = null;
  out["page:billingFrame"] = false;
  out["page:monthlyFrame"] = false;
  return out;
}

/** Mã MỚI, đọc thật từ CSDL — cùng các câu hỏi, cùng thứ tự. */
async function currentHomeDecisions(orgCode: string): Promise<Decisions> {
  invalidateOrganizations();
  invalidatePricing();
  const out: Decisions = {};
  for (const k of FEATURE_KEYS) out[`hasFeature:${k}`] = await hasFeature(k, { orgCode });
  for (const d of await featureDecisions(orgCode)) out[`featureDecision:${d.key}`] = d.granted;
  for (const kind of ENTITLEMENT_KINDS) for (const d of DELTAS) out[`checkEntitlement:${kind}:${d}`] = await checkEntitlement(kind, d, { orgCode });
  for (const key of USAGE_QUOTAS) for (const d of DELTAS) out[`checkUsageQuota:${key}:${d}`] = await checkUsageQuota(key, { orgCode, delta: d });
  const home = await getHomeOrganization();
  out.resolvePlan = await resolvePlan(home);
  const usage = await getPlanUsage(orgCode);
  for (const r of usage.rows) out[`planUsage:${r.kind}`] = { limit: r.limit, undeclared: r.undeclared };
  const pricing = await resolveOrgPricing(home);
  out["pricing:quotas"] = pricing.quotas;
  out["pricing:row"] = pricing.row;
  out["pricing:fellBack"] = pricing.fellBack;
  out["pricing:planKey"] = pricing.plan?.key ?? null;
  out.planKeyOf = planKeyOf(home);
  const frame = await loadPlanPageFrame(orgCode);
  out["page:billing"] = frame.billing ? ((await loadTenantBilling(orgCode)) === null ? null : "SHOWN") : null;
  out["page:customerPlan"] = (await loadCustomerPlan(orgCode)) === null ? null : "SHOWN";
  out["page:billingFrame"] = frame.billing;
  out["page:monthlyFrame"] = frame.monthlyQuotas;
  return out;
}

function diffs(want: Decisions, got: Decisions): string[] {
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  const out: string[] = [];
  for (const k of keys) {
    const a = JSON.stringify(want[k]);
    const b = JSON.stringify(got[k]);
    if (a !== b) out.push(`${k}: trước ${a} · sau ${b}`);
  }
  return out;
}

/** Câu lệnh của migration 0225, chạy lại được (idempotent) — bài kiểm chạy lại đúng văn bản đã vào kho. */
function migrationStatements(): string[] {
  const src = readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  return src
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

function testSourceHasNoCommercialHomeBranch() {
  // Sáu tệp thương mại không còn ĐỌC `.isHome` để quyết định gói / hạn mức / tính năng / trang gói. Được giữ ĐÚNG hai lượt đọc,
  // cả hai là nhánh AN TOÀN (docs/saas/ENTITLEMENTS.md «Nhánh GIỮ»):
  //  · `planKeyOf`: cột gói TRỐNG ở nhà ⇒ `internal` (khả dụng trong lượt deploy / lô migration hỏng — gói đã gán luôn thắng);
  //  · trang gói, khung AI: `ai.limits.isHome` của `resolveAiLimits` — đi cùng nguồn khoá AI `HOME` (an toàn credential).
  // Khoá thanh toán đọc qua `lib/saas/policy.ts::billingLockApplies`, vị từ CHUNG với cổng ghi — không tệp nào ở đây tự hỏi.
  const allowed: Record<string, number> = { "lib/entitlements/check.ts": 1, "app/(dashboard)/settings/plan/page.tsx": 1 };
  const files = ["lib/entitlements/check.ts", "lib/pricing/entitlements.ts", "lib/pricing/features.ts", "lib/pricing/customer.ts", "lib/saas/entitlements.ts", "app/(dashboard)/settings/plan/page.tsx"];
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  for (const f of files) {
    const src = read(f)
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const reads = src.match(/\.isHome\b/g)?.length ?? 0;
    assert.equal(reads, allowed[f] ?? 0, `${f}: ${reads} lượt đọc .isHome (cho phép ${allowed[f] ?? 0}) — nhánh thương mại mới phải đi đường của khách`);
  }
  assert.ok(read("lib/entitlements/check.ts").includes("org.isHome ? HOME_PLAN_KEY : DEFAULT_PLAN_KEY"), "lượt đọc duy nhất ở check.ts là nhánh cột-trống của planKeyOf");
  assert.ok(read("app/(dashboard)/settings/plan/page.tsx").includes("ai.limits.isHome"), "lượt đọc duy nhất ở trang gói là khung AI");
  // Cổng ghi và trang gói đọc CÙNG một vị từ khoá thanh toán.
  assert.ok(read("lib/auth/session.ts").includes("billingLockApplies(org)"), "cổng ghi khoá thanh toán qua billingLockApplies");
  assert.ok(read("lib/pricing/customer.ts").includes("billingLockApplies(org)"), "trang gói hiện khung thanh toán qua billingLockApplies");
}

const C = "sbi-c";

async function cleanupChargebackCustomer() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, C) });
  if (org) {
    const accountId = org.accountId;
    await pdb.delete(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, C));
    await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, C));
    await pdb.delete(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, C));
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    if (accountId) {
      const still = await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.accountId, accountId));
      if (still.length === 0) {
        await pdb.delete(schema.platformBillingStatements).where(eq(schema.platformBillingStatements.accountId, accountId));
        await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.accountId, accountId));
        await pdb.delete(schema.platformAccounts).where(eq(schema.platformAccounts.id, accountId));
      }
    }
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, C));
  rmSync(organizationDatabaseUrl({ code: C, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  invalidateOrganizations();
  invalidateSubscriptions();
  invalidatePricing();
}

/**
 * ĐƯỜNG CỤT THANH TOÁN (review PR #622): workspace KHÁCH nằm trong tài khoản chargeback (`moveWorkspaceToAccount` /
 * `updateAccount`) vẫn bị cổng ghi khoá khi hết hạn — nên trang gói PHẢI có khung gia hạn QR và khung hạn mức tháng.
 */
async function testChargebackCustomerNotStranded() {
  await cleanupChargebackCustomer();
  await provisionOrganization({ code: C, name: "Khách trong tài khoản chargeback", modules: ["customers"], admin: { email: `admin@${C}.local`, name: "QT", password: "Sbi@123456789" }, source: "TEST", actor: null });
  try {
    const acct = await accountOfWorkspace(C);
    assert.ok(acct, "workspace mới có tài khoản thương mại");
    await updateAccount(acct.id, { accountType: "INTERNAL", billingMode: "INTERNAL_CHARGEBACK" }, { actor: null, source: "TEST", reason: "khách đặt dưới tài khoản chargeback" });
    const pdb = await getPlatformDb();
    await pdb.insert(schema.platformSubscriptions).values({ orgCode: C, billingEnabled: true, paidThrough: addDays(vnDate(new Date()), -10), graceDays: 3 });
    invalidateSubscriptions(C);
    invalidateOrganizations();
    const org = await findOrganization(C);
    assert.ok(org);
    assert.equal((await orgBillingStanding(org, new Date(), { fresh: true })).kind, "LOCKED", "hết hạn + hết ân hạn ⇒ chỉ xem");
    assert.equal(billingLockApplies(org), true, "cổng ghi KHOÁ workspace này (vị từ chung)");
    assert.deepEqual(await loadPlanPageFrame(C), { billing: true, monthlyQuotas: true }, "bị khoá ⇒ trang gói có khung thanh toán + hạn mức tháng");
    const tb = await loadTenantBilling(C);
    assert.ok(tb && tb.standing.kind === "LOCKED", "khung thanh toán dựng được (có chỗ cho mã QR gia hạn)");
    assert.ok(await loadCustomerPlan(C), "khung hạn mức tháng dựng được");
  } finally {
    await cleanupChargebackCustomer();
  }
}

export async function testSaasInternalPlan() {
  testSourceHasNoCommercialHomeBranch();
  // Vị từ khung trang gói — thuần: thanh toán theo khoá; hạn mức tháng khi có thanh toán HOẶC gói còn ô có trần.
  const uncapped = { quotas: { aiConversations: null, aiMessages: null, orders: null, fanpages: null, users: null } };
  assert.deepEqual(planPageFrame({ isHome: true }, uncapped), { billing: false, monthlyQuotas: false });
  assert.deepEqual(planPageFrame({ isHome: true }, { quotas: { ...uncapped.quotas, aiConversations: 950 } }), { billing: false, monthlyQuotas: true }, "gán cho nhà gói có trần ⇒ khung hạn mức tháng tự hiện");
  assert.deepEqual(planPageFrame({ isHome: false }, uncapped), { billing: true, monthlyQuotas: true }, "khách (kể cả gói không trần) giữ cả hai khung như trước");

  const pdb = await getPlatformDb();
  const home = await getHomeOrganization();
  assert.equal(home.plan, HOME_PLAN_KEY, "0225: workspace nhà được gắn gói internal bằng DỮ LIỆU (cột plan), không bằng nhánh mã");
  const internalRow = await pdb.query.platformPlans.findFirst({ where: eq(schema.platformPlans.key, HOME_PLAN_KEY) });
  assert.ok(internalRow, "gói internal phải có trong sổ gói");
  const saved = { plan: home.plan };
  const legacy = legacyHomeDecisions(internalRow.name, internalRow.description);

  const restore = async () => {
    await pdb.update(schema.platformOrganizations).set({ plan: saved.plan }).where(eq(schema.platformOrganizations.code, home.code));
    await pdb.delete(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, home.code));
    // Dòng gói khôi phục NGUYÊN VẸN (mọi cột) — bài này không được để lại dấu vết nào trên sổ gói.
    await pdb.insert(schema.platformPlans).values(internalRow).onConflictDoUpdate({ target: schema.platformPlans.key, set: { ...internalRow } });
    invalidateOrganizations();
    invalidatePricing();
  };

  try {
    // ── 1. SO TRƯỚC / SAU — từng quyết định thương mại của nhà giữ nguyên.
    const now = await currentHomeDecisions(home.code);
    assert.deepEqual(diffs(legacy, now), [], "workspace nhà KHÔNG đổi một quyết định thương mại nào sau khi gỡ nhánh isHome");
    // Cổng khách «Sản phẩm của tôi»: mọi tính năng hiệu lực đúng như thuê bao cho phép (cũ: nhánh HOME ⇒ có hết).
    const homeUser: SessionUser = { id: "sbi-op", email: "op@sbi.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
    const mine = await loadMyProducts(homeUser);
    assert.ok(!("error" in mine), "cổng khách đọc được sản phẩm của nhà");
    for (const p of mine.products) for (const f of p.features) assert.equal(f.effective, p.grantsUse, `${p.key}.${f.key}: nhà có mọi tính năng mà thuê bao cho dùng`);

    // ── 2. TRƯỚC 0225 (cột gói của nhà trống — lượt deploy chưa migrate xong, hoặc lô migration bị hoàn): nhánh khả dụng
    //       của `planKeyOf` cho đúng 64 quyết định cũ, KHÔNG rơi về trial.
    await pdb.update(schema.platformOrganizations).set({ plan: null }).where(eq(schema.platformOrganizations.code, home.code));
    assert.deepEqual(diffs(legacy, await currentHomeDecisions(home.code)), [], "nhà với cột gói trống (trước 0225) giữ nguyên mọi quyết định cũ");
    await pdb.update(schema.platformOrganizations).set({ plan: "  " }).where(eq(schema.platformOrganizations.code, home.code));
    invalidateOrganizations();
    assert.equal(planKeyOf(await getHomeOrganization()), HOME_PLAN_KEY, "cột chỉ có khoảng trắng = trống");
    // Migration chạy lại được (idempotent), chỉ ghi khi cột gói của nhà còn TRỐNG, không đụng workspace khách nào.
    await pdb.update(schema.platformOrganizations).set({ plan: null }).where(eq(schema.platformOrganizations.code, home.code));
    for (let i = 0; i < 2; i++) for (const s of migrationStatements()) await pdb.execute(sql.raw(s));
    assert.deepEqual(diffs(legacy, await currentHomeDecisions(home.code)), [], "chạy lại 0225 (hai lần) trên cột trống đưa nhà về đúng hành vi cũ");
    await pdb.update(schema.platformOrganizations).set({ plan: "basic" }).where(eq(schema.platformOrganizations.code, home.code));
    for (const s of migrationStatements()) await pdb.execute(sql.raw(s));
    const kept = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, home.code) });
    assert.equal(kept?.plan, "basic", "0225 không đè gói đã được gán cho nhà (vd phase D gán gói V1 trước khi 0225 chạy)");
    await restore();
    const others = await pdb.select({ code: schema.platformOrganizations.code, plan: schema.platformOrganizations.plan }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.isHome, false));
    assert.ok(others.every((o) => o.plan !== HOME_PLAN_KEY), "0225 không gắn gói internal cho workspace khách nào");

    // ── 3. ĐỘT BIẾN — nhà nay phụ thuộc dữ liệu, nên phá dữ liệu phải làm bài so đỏ.
    const mutate = async (label: string, fn: () => Promise<void>, expect: RegExp) => {
      await fn();
      const d = diffs(legacy, await currentHomeDecisions(home.code));
      assert.ok(d.some((x) => expect.test(x)), `đột biến «${label}» phải bị bài so bắt — nhận ${JSON.stringify(d.slice(0, 4))}`);
      await restore();
      assert.deepEqual(diffs(legacy, await currentHomeDecisions(home.code)), [], `khôi phục sau đột biến «${label}»`);
    };
    const plan = schema.platformPlans;
    await mutate("nhà gắn gói trial", () => pdb.update(schema.platformOrganizations).set({ plan: "trial" }).where(eq(schema.platformOrganizations.code, home.code)).then(() => undefined), /^(planKeyOf|checkEntitlement:users:1000000)/);
    await mutate("gói đang gán mất tính năng api", () => pdb.update(plan).set({ commercial: sql`jsonb_set(${plan.commercial}, '{features}', (${plan.commercial} -> 'features') - 'api')` }).where(eq(plan.key, HOME_PLAN_KEY)).then(() => undefined), /^hasFeature:api/);
    await mutate("gói đang gán có trần người dùng = 0", () => pdb.update(plan).set({ limits: sql`${plan.limits} || '{"users": 0}'::jsonb` }).where(eq(plan.key, HOME_PLAN_KEY)).then(() => undefined), /^checkEntitlement:users:1:/);
    await mutate("gói đang gán có trần hội thoại AI", () => pdb.update(plan).set({ commercial: sql`jsonb_set(${plan.commercial}, '{quotas,aiConversations}', '5'::jsonb)` }).where(eq(plan.key, HOME_PLAN_KEY)).then(() => undefined), /^checkUsageQuota:aiConversations/);
    await mutate("ghi đè tắt API của nhà", () => pdb.insert(schema.platformOrgPricing).values({ orgCode: home.code, featureOverrides: { api: false } }).then(() => undefined), /^hasFeature:api/);

    // ── 4. Gói gán cho nhà vắng khỏi sổ ⇒ nhà theo ĐÚNG luật của khách: lùi về `trial`, báo `fellBack` — không còn bản
    //       dựng sẵn "nhà = vô hạn" nào trong mã.
    await pdb.delete(plan).where(eq(plan.key, HOME_PLAN_KEY));
    invalidatePricing();
    const fallback = await resolvePlan(await getHomeOrganization());
    assert.ok(fallback && fallback.key === "trial" && fallback.fellBack, "gói vắng ⇒ trial + fellBack, như mọi khách");
    assert.equal((await resolveOrgPricing(await getHomeOrganization())).fellBack, true);
  } finally {
    await restore();
  }
  await testChargebackCustomerNotStranded();
  console.log("✓ Phase 14 · nhà đi đường thương mại của khách: bài so trước/sau khớp từng ô (tính năng · hạn mức · hạn mức tháng · gói · trang gói) · 0225 idempotent, không đè gói đã gán · năm đột biến dữ liệu bị bắt · gói vắng ⇒ nhà lùi trial như khách · cột gói trống (trước 0225) không khoá nhà · khách trong tài khoản chargeback bị khoá vẫn có khung gia hạn");
}

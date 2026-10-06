/**
 * PHASE 14 — VNXCommerce đi CÙNG đường thương mại với khách ngoài (docs/saas/ENTITLEMENTS.md · PLAN.md Phase 14).
 *
 * Trước bản này, workspace nhà được "miễn" ở năm chỗ thương mại bằng `if (org.isHome)`: `planKeyOf`, `resolvePlan`,
 * `checkEntitlement`, `featureGranted` (nhánh HOME), `resolveOrgPricing` / `checkUsageQuota`, và trang `/settings/plan`.
 * Nay nhà đọc gói được GÁN cho nó qua ĐÚNG đường của khách: cột `platform_organizations.plan` (0225 ghi thành dữ liệu
 * đúng gói mã cũ tự gán — `internal`) → `platform_plans` → ghi đè `platform_org_pricing` → giữ từ trước. Không có gói ẩn
 * vô hạn nào trong mã (quyết định giá V1, 07/10/2026): đổi gói của nhà = ghi cột đó, bài này không phải sửa.
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
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { checkEntitlement, getPlanUsage, planKeyOf, resolvePlan } from "@/lib/entitlements/check";
import { ENTITLEMENT_KINDS, HOME_PLAN_KEY } from "@/lib/entitlements/kinds";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { loadTenantBilling } from "@/lib/billing/service";
import { QUOTA_KEYS } from "@/lib/pricing/catalog";
import { checkUsageQuota, featureDecisions, hasFeature, invalidatePricing, resolveOrgPricing } from "@/lib/pricing/entitlements";
import { FEATURE_KEYS } from "@/lib/pricing/features";
import { loadCustomerPlan, loadPlanPageFrame } from "@/lib/pricing/customer";
import { loadMyProducts } from "@/lib/saas/portal";
import { selfServeBilling } from "@/lib/saas/policy";

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
  out["page:selfServe"] = false;
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
  out["page:billing"] = frame.selfServe ? ((await loadTenantBilling(orgCode)) === null ? null : "SHOWN") : null;
  out["page:customerPlan"] = (await loadCustomerPlan(orgCode)) === null ? null : "SHOWN";
  out["page:selfServe"] = frame.selfServe;
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
  // Năm tệp thương mại không còn hỏi "có phải nhà không". Trang gói được giữ đúng MỘT chỗ: khung AI đọc `ai.limits.isHome`
  // của `resolveAiLimits` — nhánh đó ĐI CÙNG nguồn AI `HOME` (khoá AI của nhà, an toàn credential), không gỡ ở đây.
  const files = ["lib/entitlements/check.ts", "lib/pricing/entitlements.ts", "lib/pricing/features.ts", "lib/pricing/customer.ts", "lib/saas/entitlements.ts", "app/(dashboard)/settings/plan/page.tsx"];
  for (const f of files) {
    const src = readFileSync(path.join(process.cwd(), f), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
      .replaceAll("ai.limits.isHome", "");
    assert.ok(!/\bisHome\b/.test(src), `${f}: còn nhánh isHome thương mại — nhà phải đi đường của khách (đọc gói internal)`);
  }
}

export async function testSaasInternalPlan() {
  testSourceHasNoCommercialHomeBranch();
  // Chính sách: chỉ hoá đơn khách mới có khung tự thanh toán; chargeback nội bộ thì không (dữ liệu tài khoản, không phải nhánh mã).
  assert.equal(selfServeBilling("EXTERNAL_INVOICE"), true);
  assert.equal(selfServeBilling("INTERNAL_CHARGEBACK"), false);

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

    // ── 2. Migration chạy lại được (idempotent), chỉ ghi khi cột gói của nhà còn TRỐNG, không đụng workspace khách nào.
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
  console.log("✓ Phase 14 · nhà đi đường thương mại của khách: bài so trước/sau khớp từng ô (tính năng · hạn mức · hạn mức tháng · gói · trang gói) · 0225 idempotent, không đè gói đã gán · năm đột biến dữ liệu bị bắt · gói vắng ⇒ nhà lùi trial như khách");
}

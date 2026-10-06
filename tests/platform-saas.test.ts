/**
 * SỔ KINH TẾ SAAS + OWNER COCKPIT (0203 · docs/productization/11_SAAS_METRICS_SPEC.md).
 *
 *  1. THUẦN — bảng chân lý biến động MRR (mới · quay lại · mở rộng · thu hẹp · rời · chưa biết), GRR / NRR / logo churn
 *     trên dữ liệu chọn tay có đáp án tính bằng tay, kỳ không có ảnh chụp ⇒ null (không phải 0), sổ bắt đầu giữa kỳ ⇒
 *     `partial`, vòng đời, phễu kích hoạt (mốc chưa đo được ⇒ null, trung vị dưới ngưỡng ⇒ null), biên lợi nhuận (chưa
 *     khai hạ tầng ⇒ null, không phải 100%), xu hướng.
 *  2. CSDL THẬT, hai tổ chức PGlite `saas-a` (trả tiền) / `saas-b` (dùng thử):
 *     · ảnh chụp dùng ĐÚNG công thức MRR của bảng thu phí (cùng số với `loadPlatformBilling`);
 *     · ngày đã qua ĐÓNG BĂNG: đổi gói rồi chụp ngày sau không sửa dòng ngày trước ⇒ biến động Mở rộng đọc ra đúng;
 *     · mốc kích hoạt đọc từ chứng từ của CHÍNH tổ chức đó — hội thoại của A không thành mốc của B (cô lập);
 *     · mốc ghi MỘT lần: chứng từ sớm hơn xuất hiện sau không đổi mốc đã ghi;
 *     · người ngoài (người xem của nhà, quản trị tổ chức khách) không đọc được cockpit, không khai được chi phí;
 *     · sổ dùng theo ngày (0204): đếm tin khách (không tính kết quả công cụ), tin bot (không tính tin page chép vào lịch sử),
 *       hội thoại bot trả lời, đơn AI — kênh THỬ không bao giờ tính, chứng từ của A không vào sổ của B.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { loadPlatformBilling } from "@/lib/billing/service";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { invalidatePriceBook, pinOrgPriceVersion } from "@/lib/pricing/price-book";
import { loadOwnerCockpit } from "@/lib/platform/saas-cockpit";
import { captureSaasSnapshot, PLATFORM_COSTS_KEY, readCostDeclaration, readMilestones, readSaasDaily, setPlatformCostDeclaration } from "@/lib/platform/saas-ledger";
import {
  activationFunnel,
  classifyMovement,
  median,
  monthRange,
  periodMovement,
  platformMargin,
  prevDay,
  tenantEconomics,
  tenantLifecycle,
  trendOf,
  weeklyBuckets,
  EMPTY_COST_DECLARATION,
  type SaasDailyRow,
} from "@/lib/platform/saas-metrics";

const A = "saas-a";
const B = "saas-b";
const ORGS = [A, B] as const;
/** Ngày giả của bài kiểm — xa mọi "hôm nay" thật để không đụng ảnh chụp thật; dọn theo `< 2021-01-01`. */
const D1 = new Date("2020-03-30T03:00:00Z");
const D2 = new Date("2020-04-02T03:00:00Z");

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "saas-user", email: "saas@local", name: "SAAS", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

function row(day: string, orgCode: string, mrrVnd: number | null, over: Partial<SaasDailyRow> = {}): SaasDailyRow {
  return { day, orgCode, orgStatus: "ACTIVE", isHome: false, planKey: "starter", billingEnabled: true, standing: "ACTIVE", paying: (mrrVnd ?? 0) > 0, mrrVnd, ...over };
}

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  // Bảng chân lý một tổ chức.
  assert.equal(classifyMovement(0, 499_000, false), "NEW");
  assert.equal(classifyMovement(0, 499_000, true), "REACTIVATION", "từng trả rồi ngưng ⇒ quay lại, không phải khách mới");
  assert.equal(classifyMovement(499_000, 999_000, true), "EXPANSION");
  assert.equal(classifyMovement(999_000, 499_000, true), "CONTRACTION");
  assert.equal(classifyMovement(499_000, 0, true), "CHURN");
  assert.equal(classifyMovement(499_000, 499_000, true), "RETAINED");
  assert.equal(classifyMovement(0, 0, false), "NONE");
  assert.equal(classifyMovement(null, 499_000, false), "UNKNOWN", "chưa biết không được đoán là mới");
  assert.equal(classifyMovement(499_000, null, true), "UNKNOWN", "chưa biết không được đoán là rời");

  // Kỳ tháng 11 với đầu kỳ = ảnh chụp 31/10. Đáp án tính tay:
  //   a: 499k → 999k (mở rộng +500k) · b: 999k → 0 (rời 999k) · c: 1.990k → 499k (thu hẹp 1.491k)
  //   d: 0 → 249k (mới; chưa từng trả) · e: từng trả 09/2026, 0 ở 31/10 → 499k (quay lại) · f: mới xuất hiện 15/11 với 499k (mới)
  //   g: 499k → null (chưa biết — không vào dòng nào)
  const rows: SaasDailyRow[] = [
    row("2026-09-15", "e", 499_000),
    row("2026-10-31", "a", 499_000),
    row("2026-10-31", "b", 999_000),
    row("2026-10-31", "c", 1_990_000),
    row("2026-10-31", "d", 0),
    row("2026-10-31", "e", 0),
    row("2026-10-31", "g", 499_000),
    row("2026-10-31", "home", 0, { isHome: true }),
    row("2026-11-30", "a", 999_000),
    row("2026-11-30", "b", 0),
    row("2026-11-30", "c", 499_000),
    row("2026-11-30", "d", 249_000),
    row("2026-11-30", "e", 499_000),
    row("2026-11-30", "f", 499_000),
    row("2026-11-30", "g", null),
    row("2026-11-30", "home", 0, { isHome: true }),
  ];
  const nov = monthRange("2026-11");
  assert.deepEqual(nov, { from: "2026-11-01", to: "2026-11-30" });
  const m = periodMovement(rows, nov.from, nov.to);
  assert.equal(m.startDay, "2026-10-31");
  assert.equal(m.endDay, "2026-11-30");
  assert.equal(m.partial, false);
  assert.equal(m.startMrrVnd, 499_000 + 999_000 + 1_990_000, "g (chưa biết) không vào MRR đầu kỳ");
  assert.equal(m.newMrrVnd, 249_000 + 499_000);
  assert.equal(m.reactivationMrrVnd, 499_000);
  assert.equal(m.expansionMrrVnd, 500_000);
  assert.equal(m.contractionMrrVnd, 1_491_000);
  assert.equal(m.churnedMrrVnd, 999_000);
  assert.equal(m.netNewMrrVnd, 249_000 + 499_000 + 499_000 + 500_000 - 1_491_000 - 999_000);
  assert.equal(m.endMrrVnd, (m.startMrrVnd ?? 0) + (m.netNewMrrVnd ?? 0), "MRR cuối = đầu + net new (cầu nối MRR khép kín)");
  assert.deepEqual(m.unknownOrgs, ["g"]);
  assert.equal(m.startPayingLogos, 3);
  assert.equal(m.churnedLogos, 1);
  assert.equal(m.newLogos, 2);
  const start = 3_488_000;
  assert.equal(m.grr, (start - 1_491_000 - 999_000) / start);
  assert.equal(m.nrr, (start + 500_000 - 1_491_000 - 999_000) / start, "NRR không có khách mới / quay lại");
  assert.equal(m.logoChurn, 1 / 3);
  assert.ok(m.note?.includes("chưa biết"), "tổ chức chưa biết phải được nói ra");
  assert.ok(!m.byOrg.some((o) => o.orgCode === "home"), "tổ chức nhà không vào biến động");

  // Không có ảnh chụp nào ⇒ mọi số null (không phải 0).
  const none = periodMovement(rows, "2025-01-01", "2025-01-31");
  assert.equal(none.startDay, null);
  assert.equal(none.netNewMrrVnd, null);
  assert.equal(none.grr, null);

  // Sổ bắt đầu GIỮA kỳ ⇒ partial, nói ra ngày bắt đầu.
  const mid = periodMovement([row("2026-10-04", "a", 499_000), row("2026-10-20", "a", 999_000)], "2026-10-01", "2026-10-31");
  assert.equal(mid.partial, true);
  assert.equal(mid.startDay, "2026-10-04");
  assert.equal(mid.expansionMrrVnd, 500_000);
  assert.ok(mid.note?.includes("2026-10-04"));
  // Một ảnh chụp duy nhất ⇒ không có biến động, không bịa "Mới".
  const one = periodMovement([row("2026-10-04", "a", 499_000)], "2026-10-01", "2026-10-31");
  assert.equal(one.newMrrVnd, 0);
  assert.equal(one.startMrrVnd, 499_000);
  // Đầu kỳ 0 ⇒ GRR / NRR null (không chia cho 0, không in 100%).
  const zero = periodMovement([row("2026-10-31", "a", 0), row("2026-11-30", "a", 499_000)], "2026-11-01", "2026-11-30");
  assert.equal(zero.grr, null);
  assert.equal(zero.nrr, null);
  assert.equal(zero.logoChurn, null);
  assert.equal(prevDay("2026-03-01"), "2026-02-28");
  assert.equal(prevDay("2028-03-01"), "2028-02-29");

  // Vòng đời.
  const base = { isHome: false, orgStatus: "ACTIVE", billingEnabled: true, standing: "ACTIVE" as const, paying: true, planKey: "starter" };
  assert.equal(tenantLifecycle(base, true), "PAID");
  assert.equal(tenantLifecycle(base, false), "PAID", "tính MRR = trả tiền, kể cả tiền về ngoài hệ thống");
  assert.equal(tenantLifecycle({ ...base, paying: false, planKey: "trial" }, false), "TRIAL");
  assert.equal(tenantLifecycle({ ...base, paying: false, standing: "LOCKED" }, true), "CHURNED");
  assert.equal(tenantLifecycle({ ...base, paying: false, standing: "LOCKED" }, false), "LOCKED", "dùng thử hết hạn chưa trả lần nào ≠ rời bỏ");
  assert.equal(tenantLifecycle({ ...base, paying: false, billingEnabled: false }, false), "FREE");
  assert.equal(tenantLifecycle({ ...base, orgStatus: "SUSPENDED" }, true), "SUSPENDED");
  assert.equal(tenantLifecycle({ ...base, isHome: true }, false), "INTERNAL");

  // Phễu kích hoạt.
  const t0 = new Date("2026-10-01T00:00:00Z");
  const plus = (d: number) => new Date(t0.getTime() + d * 86_400_000);
  const funnel = activationFunnel([
    { orgCode: "a", reached: { SIGNED_UP: t0, CATALOG_IMPORTED: plus(1), FIRST_AI_REPLY: plus(2) } },
    { orgCode: "b", reached: { SIGNED_UP: t0, CATALOG_IMPORTED: plus(3), FIRST_AI_REPLY: plus(4) } },
    { orgCode: "c", reached: { SIGNED_UP: t0, CATALOG_IMPORTED: plus(5) } },
  ]);
  const step = (k: string) => funnel.find((s) => s.milestone === k)!;
  assert.equal(step("CATALOG_IMPORTED").reached, 3);
  assert.equal(step("CATALOG_IMPORTED").medianDaysFromSignup, 3);
  assert.equal(step("FIRST_AI_REPLY").reached, 2);
  assert.equal(step("FIRST_AI_REPLY").medianDaysFromSignup, null, "2 tổ chức < ngưỡng 3 ⇒ trung vị null");
  assert.equal(step("FIRST_DELIVERED_AI_ORDER").reached, 0, "mốc đo được (ORDER_OUTCOME) mà chưa tổ chức nào tới ⇒ 0/3 thật");
  assert.equal(step("FIRST_DELIVERED_AI_ORDER").availability, "MEASURED");
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);

  // Biên lợi nhuận.
  const noCosts = platformMargin(10_000_000, 1_000_000, EMPTY_COST_DECLARATION);
  assert.equal(noCosts.grossMargin, null, "chưa khai hạ tầng ⇒ biên gộp chưa biết, không phải 90%");
  assert.equal(noCosts.aiOnlyMargin, 0.9);
  assert.deepEqual(noCosts.missing.length, 2);
  const declared = platformMargin(10_000_000, 1_000_000, { ...EMPTY_COST_DECLARATION, infraMonthlyVnd: 2_000_000, supportMonthlyVnd: 1_000_000 });
  assert.equal(declared.grossMargin, 0.7);
  assert.equal(declared.contributionMargin, 0.6);
  assert.equal(platformMargin(0, 0, declared as never).grossMargin, null, "chưa có doanh thu ⇒ không chia cho 0");
  const econ = tenantEconomics(499_000, { costUsd: 2, requests: 10, unpricedRequests: 1 }, 25_000);
  assert.equal(econ.platformAiCostVnd, 50_000);
  assert.equal(econ.contributionVnd, 449_000);
  assert.equal(econ.aiCostComplete, false, "lượt chưa định giá ⇒ số tiền là cận dưới");

  // Xu hướng.
  assert.equal(trendOf(3, 2), "NONE", "dưới 10 lượt không gọi là xu hướng");
  assert.equal(trendOf(0, 0), "NONE");
  assert.equal(trendOf(30, 10), "UP");
  assert.equal(trendOf(5, 20), "DOWN");
  assert.equal(trendOf(11, 10), "FLAT");
  assert.equal(trendOf(12, 0), "NEW");
  // Xu hướng tuần: tuần cuối kết thúc HÔM NAY; tuần không có ngày nào trong sổ ⇒ null (chưa đo), không phải 0.
  const wk = weeklyBuckets(
    [
      { day: "2026-10-04", conversationsStarted: 5, aiOrders: 1 },
      { day: "2026-09-29", conversationsStarted: 3, aiOrders: 0 },
      { day: "2026-09-27", conversationsStarted: 2, aiOrders: 1 },
    ],
    "2026-10-04",
  );
  assert.deepEqual(
    wk.map((w) => [w.from, w.to, w.days, w.conversations, w.aiOrders]),
    [
      ["2026-09-07", "2026-09-13", 0, null, null],
      ["2026-09-14", "2026-09-20", 0, null, null],
      ["2026-09-21", "2026-09-27", 1, 2, 1],
      ["2026-09-28", "2026-10-04", 2, 8, 1],
    ],
  );
  console.log("  ✓ kinh tế SaaS (thuần): biến động MRR, GRR/NRR, vòng đời, phễu kích hoạt, biên, xu hướng");
}

// ═══════════ 2 · CSDL THẬT ═══════════

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformSaasDaily).where(lt(schema.platformSaasDaily.day, "2021-01-01"));
  await pdb.delete(schema.platformSaasDaily).where(inArray(schema.platformSaasDaily.orgCode, [...ORGS]));
  await pdb.delete(schema.platformTenantUsageDaily).where(inArray(schema.platformTenantUsageDaily.orgCode, [...ORGS]));
  await pdb.delete(schema.platformOrgMilestones).where(inArray(schema.platformOrgMilestones.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  invalidatePriceBook();
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
}

async function setPlan(code: string, plan: string) {
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformOrganizations).set({ plan }).where(eq(schema.platformOrganizations.code, code));
  invalidateOrganizations();
}

export async function testPlatformSaas() {
  testPure();
  const pdb = await getPlatformDb();
  const savedCosts = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_COSTS_KEY) });
  await cleanup();
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "saas-op", email: "op@saas.local", organization: { code: home.code, name: home.name, isHome: true } });
  const homeViewer = sessionUser({ id: "saas-viewer", email: "xem@saas.local", role: "VIEWER", permissions: ["dashboard:view"], organization: op.organization });
  const tenantAdmin = sessionUser({ id: "saas-khac", email: "qt@saas-b.local", permissions: ["platform:operate"], organization: { code: B, name: B, isHome: false } });

  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Saas@12345678" }, source: "TEST", actor: null });
  try {
    // A trả tiền gói Khởi đầu, hạn rất xa; B dùng thử (gói không giá). A là khách CÓ TỪ TRƯỚC bảng giá V1 ⇒ ghim giá legacy
    // (0225: thuê bao hiện có giữ đúng giá đang thu — MRR đọc theo phiên bản đã ghim).
    await setPlan(A, "starter");
    await pinOrgPriceVersion(A, "legacy", { source: "TEST", reason: "khách có từ trước 0225", email: null });
    await pdb.insert(schema.platformSubscriptions).values([
      { orgCode: A, billingEnabled: true, paidThrough: "2099-12-31", graceDays: 7 },
      { orgCode: B, billingEnabled: true, paidThrough: "2099-12-31", graceDays: 7 },
    ]);
    invalidateSubscriptions();

    // Chứng từ của A: một sản phẩm, một hội thoại khách thật có lượt AI, một hội thoại THỬ (không được tính).
    const convAt = new Date("2026-09-20T02:00:00Z");
    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.products).values({ id: "saas-p1", name: "Sản phẩm thử" });
      await db.insert(schema.salesChatConversations).values([
        { channel: "TEST", aiCalls: 3, createdAt: new Date("2026-09-01T00:00:00Z") },
        { channel: "FANPAGE", aiCalls: 2, visitorKey: "saas-v1", createdAt: convAt },
      ]);
    });

    // ── Ngày 1: chụp.
    const s1 = await captureSaasSnapshot(D1);
    assert.equal(s1.day, "2020-03-30", "ngày theo giờ Việt Nam");
    assert.deepEqual(s1.errors, []);
    let daily = await readSaasDaily("2020-01-01");
    const a1 = daily.find((r) => r.day === "2020-03-30" && r.orgCode === A)!;
    const b1 = daily.find((r) => r.day === "2020-03-30" && r.orgCode === B)!;
    assert.equal(a1.mrrVnd, 499_000);
    assert.equal(a1.paying, true);
    assert.equal(b1.mrrVnd, 0, "dùng thử: 0 thật, không phải chưa biết");
    assert.equal(b1.paying, false);
    assert.ok(daily.some((r) => r.day === "2020-03-30" && r.isHome && r.mrrVnd === 0), "nhà có dòng, MRR 0");

    // Mốc kích hoạt: của A đọc từ CSDL A; B không có chứng từ nào ⇒ chỉ có mốc tạo.
    let ms = await readMilestones();
    const ma = ms.get(A)!;
    assert.ok(ma.SIGNED_UP, "mốc tạo cửa hàng");
    assert.ok(ma.CATALOG_IMPORTED);
    assert.equal(ma.FIRST_CONVERSATION?.toISOString(), convAt.toISOString(), "hội thoại THỬ sớm hơn không được tính");
    assert.equal(ma.FIRST_AI_REPLY?.toISOString(), convAt.toISOString());
    assert.equal(ma.FIRST_AI_ORDER, undefined);
    const mb = ms.get(B)!;
    assert.deepEqual(Object.keys(mb), ["SIGNED_UP"], "chứng từ của A không bao giờ thành mốc của B (cô lập tổ chức)");

    // Mốc ghi MỘT lần: một hội thoại sớm hơn xuất hiện sau không đổi mốc đã ghi.
    await withOrganization(A, async () => {
      await (await getDb()).insert(schema.salesChatConversations).values({ channel: "WEB", aiCalls: 1, createdAt: new Date("2026-09-10T00:00:00Z") });
    });

    // ── Đổi gói A lên Tăng trưởng, chụp ngày 2: dòng ngày 1 ĐÓNG BĂNG.
    await setPlan(A, "growth");
    const s2 = await captureSaasSnapshot(D2);
    assert.equal(s2.day, "2020-04-02");
    daily = await readSaasDaily("2020-01-01");
    assert.equal(daily.find((r) => r.day === "2020-03-30" && r.orgCode === A)?.mrrVnd, 499_000, "ngày đã qua không bị ghi lại");
    assert.equal(daily.find((r) => r.day === "2020-04-02" && r.orgCode === A)?.mrrVnd, 999_000);
    ms = await readMilestones();
    assert.equal(ms.get(A)!.FIRST_CONVERSATION?.toISOString(), convAt.toISOString(), "mốc đã ghi không đổi");

    // Chụp lại CÙNG ngày ⇒ vẫn một dòng mỗi tổ chức.
    await captureSaasSnapshot(new Date(D2.getTime() + 3_600_000));
    const sameDay = (await readSaasDaily("2020-04-02")).filter((r) => r.day === "2020-04-02" && r.orgCode === A);
    assert.equal(sameDay.length, 1);

    // Biến động đọc từ sổ: tháng 4/2020 so với ảnh chụp 30/03 ⇒ A mở rộng 500k.
    const apr = monthRange("2020-04");
    const mv = periodMovement(
      daily.filter((r) => r.day < "2021-01-01" && (r.orgCode === A || r.orgCode === B)),
      apr.from,
      apr.to,
    );
    assert.equal(mv.startDay, "2020-03-30");
    assert.equal(mv.expansionMrrVnd, 500_000);
    assert.equal(mv.byOrg.find((o) => o.orgCode === A)?.movement, "EXPANSION");
    assert.equal(mv.byOrg.find((o) => o.orgCode === B)?.movement, "NONE");

    // ── Sổ dùng theo ngày (0204): gieo HÔM NAY ở A — đúng thứ được đếm, đúng thứ bị bỏ.
    const now = new Date();
    await withOrganization(A, async () => {
      const db = await getDb();
      const c = schema.salesChatConversations;
      const [live1] = await db.insert(c).values({ channel: "FANPAGE", visitorKey: "saas-live", aiCalls: 1, createdAt: now }).returning({ id: c.id });
      const txt = (t: string) => [{ type: "text", text: t }];
      await db.insert(schema.salesChatMessages).values([
        { conversationId: live1.id, seq: 1, role: "user", content: txt("Chả mực bao nhiêu?") },
        { conversationId: live1.id, seq: 2, role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_current_price", input: {} }] },
        { conversationId: live1.id, seq: 3, role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "{}" }] },
        { conversationId: live1.id, seq: 4, role: "assistant", content: txt("Dạ 250.000đ ạ") },
        { conversationId: live1.id, seq: 5, role: "assistant", content: txt("[Shop đã nhắn] Chị cần gì thêm không ạ") },
      ]);
      const [test] = await db.insert(c).values({ channel: "TEST", aiCalls: 1, createdAt: now }).returning({ id: c.id });
      await db.insert(schema.salesChatMessages).values([{ conversationId: test.id, seq: 1, role: "user", content: txt("khung thử") }, { conversationId: test.id, seq: 2, role: "assistant", content: txt("thử") }]);
      await db.insert(schema.customers).values({ id: "saas-cus", name: "Khách" });
      await db.insert(schema.orders).values({ id: "saas-ord", customerId: "saas-cus", billFullName: "Khách", insertedAt: now });
      await db.update(c).set({ orderId: "saas-ord" }).where(eq(c.id, live1.id));
    });

    // ── Một công thức MRR: ảnh chụp hôm nay = MRR của bảng thu phí.
    const live = await captureSaasSnapshot(now);
    assert.ok(live.usageRows >= 4, "hôm qua + hôm nay cho mỗi tổ chức ACTIVE");
    const [usageA] = await pdb.select().from(schema.platformTenantUsageDaily).where(and(eq(schema.platformTenantUsageDaily.orgCode, A), eq(schema.platformTenantUsageDaily.day, live.day)));
    assert.deepEqual(
      [usageA.conversationsStarted, usageA.customerMessages, usageA.botMessages, usageA.aiActiveConversations, usageA.aiOrders],
      [1, 1, 1, 1, 1],
      "1 hội thoại khách · 1 tin khách (không tính kết quả công cụ) · 1 tin bot (không tính tin page chép vào, không tính kênh THỬ) · 1 đơn AI",
    );
    const [usageB] = await pdb.select().from(schema.platformTenantUsageDaily).where(and(eq(schema.platformTenantUsageDaily.orgCode, B), eq(schema.platformTenantUsageDaily.day, live.day)));
    assert.deepEqual([usageB.conversationsStarted, usageB.aiOrders], [0, 0], "chứng từ của A không vào sổ của B");
    const billing = await loadPlatformBilling(op, now);
    assert.ok(!("error" in billing));
    assert.equal(live.mrrVnd, billing.mrrVnd, "sổ SaaS và bảng thu phí dùng cùng một công thức MRR");

    // ── Cockpit: người ngoài bị từ chối; người vận hành thấy A trả tiền, B dùng thử.
    for (const u of [homeViewer, tenantAdmin]) {
      const r = await loadOwnerCockpit(u, now);
      assert.equal(r.ok, false, `${u.email} không được xem kinh tế nền tảng`);
    }
    const ck = await loadOwnerCockpit(op, now);
    assert.ok(ck.ok);
    const ra = ck.value.tenants.find((t) => t.code === A)!;
    const rb = ck.value.tenants.find((t) => t.code === B)!;
    assert.equal(ra.lifecycle, "PAID");
    assert.equal(ra.economics.mrrVnd, 999_000);
    assert.equal(ra.activated, true);
    assert.equal(ra.usage30d?.aiOrders, 1, "cột dùng AI của cockpit đọc sổ dùng");
    assert.equal(ra.usageWeeks.length, 4);
    assert.equal(ra.usageWeeks[3].aiOrders, 1, "tuần hiện tại đọc sổ dùng");
    assert.equal(ra.usageWeeks[0].conversations, null, "tuần chưa có ngày nào trong sổ ⇒ chưa đo");
    assert.ok(ck.value.ai.conversations !== null && ck.value.ai.conversations >= 1);
    assert.equal(rb.lifecycle, "TRIAL");
    assert.equal(rb.activated, false);
    assert.ok(ck.value.headline.payingTenants >= 1);
    assert.equal(ck.value.headline.arrVnd, ck.value.headline.mrrVnd * 12);
    assert.equal(ck.value.margin.grossMargin === null, ck.value.costs.infraMonthlyVnd === null, "biên gộp chỉ có số khi đã khai hạ tầng");
    assert.ok(!JSON.stringify(ck.value).includes("saas-v1"), "cockpit không mang dữ liệu hội thoại của khách");

    // ── Khai chi phí: người ngoài / thiếu căn cứ / số âm bị từ chối; người vận hành lưu được và có nhật ký.
    for (const u of [homeViewer, tenantAdmin]) assert.ok("error" in (await setPlatformCostDeclaration(u, { infraMonthlyVnd: "1000000", supportMonthlyVnd: "", reason: "khai thử chi phí" })));
    assert.ok("error" in (await setPlatformCostDeclaration(op, { infraMonthlyVnd: "1000000", reason: "" })), "thiếu căn cứ");
    assert.ok("error" in (await setPlatformCostDeclaration(op, { infraMonthlyVnd: "-5", reason: "khai thử chi phí" })), "số âm");
    const saved = await setPlatformCostDeclaration(op, { infraMonthlyVnd: "1.500.000", supportMonthlyVnd: "", reason: "Hoá đơn VPS tháng 10" });
    assert.ok("ok" in saved, JSON.stringify(saved));
    const decl = await readCostDeclaration();
    assert.equal(decl.infraMonthlyVnd, 1_500_000);
    assert.equal(decl.supportMonthlyVnd, null, "ô trống = CHƯA KHAI, không phải 0");
    const audit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.action, "PLATFORM_COSTS_SET"), eq(schema.platformAuditLog.targetOrgCode, home.code)));
    assert.ok(audit.some((x) => x.reason === "Hoá đơn VPS tháng 10" && x.actorEmail === op.email));
    const ck2 = await loadOwnerCockpit(op, now);
    assert.ok(ck2.ok);
    assert.equal(ck2.value.margin.infraVnd, 1_500_000);
    assert.equal(ck2.value.margin.contributionMargin, null, "chưa khai hỗ trợ ⇒ biên đóng góp chưa biết");
    console.log("  ✓ kinh tế SaaS (CSDL): một công thức MRR, ngày cũ đóng băng, mốc ghi một lần + cô lập, quyền người vận hành");
  } finally {
    await cleanup();
    await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.action, "PLATFORM_COSTS_SET"));
    if (savedCosts) await pdb.update(schema.platformSettings).set({ value: savedCosts.value }).where(eq(schema.platformSettings.key, PLATFORM_COSTS_KEY));
    else await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, PLATFORM_COSTS_KEY));
  }
}


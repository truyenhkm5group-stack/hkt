/**
 * ẢNH GIÁ TRỊ THEO TỔ CHỨC + SỨC KHOẺ THEO NGÀY (0240 · sứ mệnh saas-value-snapshots · docs/saas/VALUE_CENTER.md §8).
 *
 *  1. THUẦN — chọn tổ chức ở MỘT chỗ (nhà + workspace nghiệm thu + tổ chức không ACTIVE bị loại) · cửa sổ đúng cách tính kỳ của bộ
 *     đọc · khách trả / chi phí khác từ sổ nhà (nguồn hỏng ⇒ `null`, không có dòng ⇒ 0 thật, khoản cấp tài khoản ⇒ chưa biết) ·
 *     cột phẳng (`UNKNOWN` ⇒ NULL, 0 thật ⇒ 0, âm ⇒ NULL + ghi chú) · chỉ ghi được HÔM NAY.
 *  2. CSDL THẬT, hai tổ chức PGlite `tvs-a` / `tvs-b` (tự cấp, tự dọn), mốc = đồng hồ thật (luật 50 — lượt chụp chỉ ghi hôm nay):
 *     · một lượt = ba dòng mỗi tổ chức + một dòng sức khoẻ; nhà không được chụp;
 *     · chạy lại cùng ngày = BỎ QUA, không thêm / không ghi lại dòng nào (idempotent);
 *     · một nguồn của MỘT tổ chức hỏng ⇒ chỉ ô của nó NULL + `source_errors`, tổ chức kia nguyên; một nguồn NHÀ hỏng ⇒ cột của nguồn
 *       đó NULL ở mọi dòng (không phải 0); tổ chức không mở được ⇒ vẫn có dòng (chưa biết), tổ chức khác vẫn được chụp;
 *     · ngày đã qua không bị ghi (kể cả lượt `force`), lượt có `now` của hôm qua bị TỪ CHỐI.
 *  3. MÃ NGUỒN — chỉ tệp capture ghi bảng giá trị, chỉ tệp health ghi bảng sức khoẻ; không đường trang (app/**) nào gọi lượt chụp;
 *     `captureSaasSnapshot` chỉ chụp giá trị ở đường JOB; hai bảng khai đủ ba chỗ của bảng `platform_*`.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { vnDate } from "@/lib/billing/rules";
import { CONTROL_PLANE_TABLES } from "@/lib/blueprints/restore-drill";
import { ACCEPTANCE_WORKSPACES } from "@/lib/constants/saas-acceptance-registry";
import { TENANT_VALUE_WINDOWS } from "@/lib/constants/tenant-value-metrics";
import { env } from "@/lib/env";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { OFFBOARD_DELETE_ORDER, OFFBOARD_TABLES } from "@/lib/platform/offboard";
import { getHomeOrganization, invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import type { Organization } from "@/lib/platform/types";
import { captureTenantValue, flatColumns, otherVariableFor, spendFor, tenantValueTargets, valueWindow, type DirectCostEntry } from "@/lib/saas/tenant-value-capture";
import { tenantHealthRuleVersion, writableDay, writeTenantHealthDay } from "@/lib/saas/tenant-health-daily";
import { buildTenantValue, tenantValueFormulaVersion, type TenantValue } from "@/lib/saas/tenant-value";
import type { SaasDailyRow } from "@/lib/platform/saas-metrics";

const A = "tvs-a";
const B = "tvs-b";
const GHOST = "tvs-ghost";
const ORGS = [A, B] as const;
const DAY_MS = 86_400_000;

function org(code: string, over: Partial<Organization> = {}): Organization {
  return { id: `id-${code}`, code, name: code, status: "ACTIVE", isHome: false, moduleDefault: "ENABLED", plan: null, templateKey: null, ...over };
}

// ═══════════ 1 · THUẦN ═══════════

function emptyValue(): TenantValue {
  return buildTenantValue({ window: 30, marginApplicable: true, fx: { rateVndPerUsd: 25_000, source: "TEST" }, spend: null, cogs: null, attribution: null, perf: null, aiCalls: null });
}

function testPure() {
  // Chọn tổ chức — MỘT chỗ.
  const accept = ACCEPTANCE_WORKSPACES[0].code;
  const picked = tenantValueTargets([org("home", { isHome: true }), org(accept), org("tvs-paused", { status: "SUSPENDED" }), org("tvs-ok")]).map((o) => o.code);
  assert.deepEqual(picked, ["tvs-ok"], "nhà · workspace nghiệm thu · tổ chức không ACTIVE không được chụp");

  // Cửa sổ = ĐÚNG cách tính kỳ của loadOrderAttribution / loadAiSalesPerformance (đầu ngày VN − (n − 1) ngày → lúc chụp).
  const now = new Date();
  for (const days of TENANT_VALUE_WINDOWS) {
    const w = valueWindow(days, now);
    assert.equal(w.to.getTime(), now.getTime());
    assert.equal(vnDate(w.from), w.fromDay);
    assert.equal(Math.round((new Date(`${w.toDay}T00:00:00+07:00`).getTime() - w.from.getTime()) / DAY_MS), days - 1, `${days} ngày tính cả hôm nay`);
    assert.equal(vnDate(new Date(w.from.getTime() - 1)) < w.fromDay, true, "cửa sổ bắt đầu ĐÚNG đầu ngày VN");
  }

  // Khách trả: nguồn hỏng ⇒ null; không có dòng ⇒ 0 thật; MRR chỉ cộng ngày đã chụp, ngày vắng / MRR chưa biết vào «thiếu».
  const w7 = valueWindow(7, now);
  const daily: SaasDailyRow[] = [
    { day: w7.toDay, orgCode: "x", orgStatus: "ACTIVE", isHome: false, planKey: "p", billingEnabled: true, standing: "ACTIVE", paying: true, mrrVnd: 365_000 },
    { day: w7.fromDay, orgCode: "x", orgStatus: "ACTIVE", isHome: false, planKey: "p", billingEnabled: true, standing: "ACTIVE", paying: true, mrrVnd: null },
    { day: vnDate(new Date(w7.from.getTime() - DAY_MS)), orgCode: "x", orgStatus: "ACTIVE", isHome: false, planKey: "p", billingEnabled: true, standing: "ACTIVE", paying: true, mrrVnd: 999_000 },
  ];
  const sig = (prepaid: boolean) => new Map([["x", { orgCode: "x", accountId: "acc", accountCode: "acc", marginApplicable: true, prepaid, subscription: null, base: null }]]);
  const s1 = spendFor("x", 7, now, { commercial: sig(false), saasDaily: daily }, { balances: new Map(), invoices: new Map() });
  assert.equal(s1.mrrAccrualVnd, 12_000, "365.000 ₫ × 12 / 365 của MỘT ngày đã chụp; ngày ngoài cửa sổ không vào");
  assert.equal(s1.mrrDaysMissing, 6, "ngày có dòng mà MRR chưa biết vẫn là ngày thiếu");
  assert.equal(s1.aiBalanceRevenueVnd, 0, "đọc được sổ, không dòng nào ⇒ 0 thật");
  assert.equal(s1.cashInvoicesVnd, 0);
  assert.equal(s1.overageBilledVnd, null, "khách trả sau: bảng kê theo tháng không cắt được theo cửa sổ ⇒ chưa biết");
  assert.equal(spendFor("x", 7, now, { commercial: sig(true), saasDaily: daily }, { balances: new Map(), invoices: new Map() }).overageBilledVnd, 0, "khách trả trước ⇒ phần vượt 0 thật");
  const s2 = spendFor("x", 7, now, { commercial: null, saasDaily: null }, { balances: null, invoices: null });
  assert.deepEqual([s2.mrrAccrualVnd, s2.mrrDaysMissing, s2.aiBalanceRevenueVnd, s2.overageBilledVnd, s2.cashInvoicesVnd, s2.cashTopupVnd, s2.promoUsedVnd], [null, 7, null, null, null, null, null], "nguồn hỏng ⇒ mọi ô của nó null, không 0");
  assert.equal(spendFor("x", 7, now, { commercial: null, saasDaily: [] }, { balances: null, invoices: new Map([["x", { paidVnd: null }]]) }).mrrAccrualVnd, null, "không ngày nào biết MRR ⇒ null, không phải 0");
  assert.equal(spendFor("x", 7, now, { commercial: null, saasDaily: [] }, { balances: null, invoices: new Map([["x", { paidVnd: null }]]) }).cashInvoicesVnd, null, "hoá đơn ĐÃ THU thiếu số tiền ⇒ tổng chưa biết");

  // Chi phí khai DIRECT: chia theo ngày chồng lấn; khoản cấp TÀI KHOẢN ⇒ chưa biết; không khoản nào ⇒ 0.
  const month = `${w7.toDay.slice(0, 7)}-01`;
  const [y, m] = month.split("-").map(Number);
  const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ws: DirectCostEntry = { periodMonth: month, scope: "WORKSPACE", orgCode: "x", accountId: null, amountVnd: monthDays * 1000 };
  const overlap = Math.round((Date.parse(`${w7.toDay}T00:00:00Z`) - Date.parse(`${(w7.fromDay > month ? w7.fromDay : month)}T00:00:00Z`)) / DAY_MS) + 1;
  assert.equal(otherVariableFor("x", "acc", [ws], 7, now), overlap * 1000, "khoản tháng chia theo số ngày chồng lấn (luật 14)");
  assert.equal(otherVariableFor("y", "acc2", [ws], 7, now), 0, "khoản của tổ chức khác không vào; không khoản nào ⇒ 0 thật");
  assert.equal(otherVariableFor("x", "acc", [ws, { ...ws, scope: "ACCOUNT", orgCode: null, accountId: "acc" }], 7, now), null, "khoản khai cho cả tài khoản ⇒ chưa biết phần của workspace");
  assert.equal(otherVariableFor("x", undefined, [{ ...ws, scope: "ACCOUNT", orgCode: null, accountId: "khac" }], 7, now), null, "không biết tài khoản của tổ chức ⇒ khoản cấp tài khoản là chưa biết");
  assert.equal(otherVariableFor("x", "acc", null, 7, now), null, "sổ chi phí hỏng ⇒ null");

  // Cột phẳng: chỉ ô VALUE có số.
  const empty = emptyValue();
  assert.deepEqual(flatColumns(empty).flat, { customerSpendVnd: null, variableCogsVnd: null, platformGrossProfitVnd: null, aiCreditedGrossProfitVnd: null, valueMultipleMilli: null, ordersPending: null }, "nguồn trống ⇒ mọi cột NULL (chưa biết), không 0");
  const zero: TenantValue = { ...empty, metrics: { ...empty.metrics, variable_cogs_known: { ...empty.metrics.variable_cogs_known, value: 0, state: "VALUE" }, orders_pending: { ...empty.metrics.orders_pending, value: 0, state: "VALUE" }, customer_value_multiple: { ...empty.metrics.customer_value_multiple, value: 1.2345, state: "VALUE" } } };
  assert.equal(flatColumns(zero).flat.variableCogsVnd, 0, "0 thật vẫn là 0");
  assert.equal(flatColumns(zero).flat.ordersPending, 0);
  assert.equal(flatColumns(zero).flat.valueMultipleMilli, 1235, "bội số × 1000, làm tròn");
  const na: TenantValue = { ...empty, metrics: { ...empty.metrics, platform_gross_profit: { ...empty.metrics.platform_gross_profit, value: null, state: "NOT_APPLICABLE" } } };
  assert.equal(flatColumns(na).flat.platformGrossProfitVnd, null, "không áp dụng ⇒ NULL, không 0");
  const neg: TenantValue = { ...empty, metrics: { ...empty.metrics, customer_spend_recognized: { ...empty.metrics.customer_spend_recognized, value: -5000, state: "VALUE" } } };
  const fn = flatColumns(neg);
  assert.equal(fn.flat.customerSpendVnd, null, "khách trả âm không vào cột không-âm");
  assert.match(fn.notes[0], /^FLAT: /);

  // Chỉ HÔM NAY ghi được.
  assert.equal(writableDay(now, now), vnDate(now));
  assert.equal(writableDay(new Date(now.getTime() - DAY_MS), now), null, "ngày đã qua không ghi");
  assert.equal(writableDay(new Date(now.getTime() + DAY_MS), now), null, "ngày chưa tới không ghi");
  console.log("  ✓ ảnh giá trị (thuần): chọn tổ chức một chỗ · cửa sổ = kỳ của bộ đọc · nguồn hỏng ⇒ null, sổ trống ⇒ 0 thật · chi phí tháng chia theo ngày · cột phẳng null ≠ 0 · chỉ hôm nay");
}

// ═══════════ 2 · CSDL THẬT ═══════════

async function cleanup() {
  const pdb = await getPlatformDb();
  const codes = [...ORGS, GHOST];
  await pdb.delete(schema.platformTenantValueSnapshots).where(inArray(schema.platformTenantValueSnapshots.orgCode, codes));
  await pdb.delete(schema.platformTenantHealthDaily).where(inArray(schema.platformTenantHealthDaily.orgCode, codes));
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, codes));
  for (const code of ORGS) {
    const o = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (o) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, o.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, o.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, o.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
}

type Row = typeof schema.platformTenantValueSnapshots.$inferSelect;

async function valueRows(day: string, codes: readonly string[]): Promise<Row[]> {
  const pdb = await getPlatformDb();
  const t = schema.platformTenantValueSnapshots;
  return pdb.select().from(t).where(and(eq(t.capturedDay, day), inArray(t.orgCode, [...codes])));
}

async function testDb() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Tvs@12345678" }, source: "TEST", actor: null });
  const home = await getHomeOrganization();
  // Mốc theo ĐỒNG HỒ THẬT (luật 50): lượt chụp chỉ ghi hôm nay, dữ liệu gieo tương đối so với chính mốc này.
  const now = new Date();
  const today = vnDate(now);
  const fx = env.facebook.usdToVnd;
  // A có một lượt AI nền tảng trả 0,02 USD hôm nay; B không có lượt nào (0 THẬT, không phải chưa biết).
  await pdb.insert(schema.platformAiUsage).values({ orgCode: A, feature: "sales_chatbot", billingSource: "PLATFORM", requests: 1, costUsd: 0.02, status: "OK", at: new Date(now.getTime() - 60_000) });
  const all = await listOrganizations();
  const mine = [...all.filter((o) => (ORGS as readonly string[]).includes(o.code)), home];

  // ── Lượt 1: ba dòng mỗi tổ chức + một dòng sức khoẻ; nhà không được chụp.
  const r1 = await captureTenantValue(mine, now, { source: "JOB" });
  assert.equal(r1.status, "CAPTURED");
  assert.equal(r1.day, today);
  assert.equal(r1.targets, 2, "nhà không phải khách — không được chụp");
  assert.deepEqual(r1.orgs.map((o) => o.orgCode).sort(), [...ORGS]);
  assert.deepEqual(r1.errors, [], "mọi bộ đọc sổ nhà chạy được trên CSDL thật (ảnh thương mại, sức khoẻ, MRR, Số dư, hoá đơn, sổ AI, chi phí)");
  assert.deepEqual(r1.orgs.flatMap((o) => o.sourceErrors), [], "mọi bộ đọc CSDL tổ chức chạy được (quy kết, hiệu quả, cửa sổ trước)");
  for (const o of r1.orgs) {
    assert.equal(o.rows, TENANT_VALUE_WINDOWS.length);
    assert.equal(o.healthWritten, true);
    assert.ok(Number.isFinite(o.ms) && o.ms >= 0, "đo thời gian từng tổ chức");
  }
  let rows = await valueRows(today, [...ORGS, home.code]);
  assert.equal(rows.length, 6, "2 tổ chức × 3 cửa sổ, không dòng nào của nhà");
  for (const r of rows) {
    assert.equal(r.formulaVersion, tenantValueFormulaVersion());
    assert.ok(r.windowFrom < r.windowTo);
    assert.equal(typeof r.metrics, "object");
    assert.ok("customer_value_multiple" in r.metrics && "ai_auto_closed_orders" in r.metrics, "metrics là ĐÚNG ô của buildTenantValue");
  }
  const a30 = rows.find((r) => r.orgCode === A && r.windowDays === 30)!;
  const b30 = rows.find((r) => r.orgCode === B && r.windowDays === 30)!;
  assert.equal(a30.variableCogsVnd, Math.round(0.02 * fx), "giá vốn AI nền tảng của A quy ₫ theo đúng tỷ giá của mã");
  assert.equal(b30.variableCogsVnd, 0, "B đọc được sổ AI và không có lượt nào ⇒ 0 THẬT");
  assert.equal(a30.customerSpendVnd, null, "chưa có ảnh MRR nào trong cửa sổ ⇒ khách trả CHƯA BIẾT, không phải 0");
  assert.equal(b30.ordersPending, 0, "bộ đọc hiệu quả chạy được, không đơn nào đang chờ ⇒ 0 thật");
  const auto = (r: Row) => (r.metrics as Record<string, { state: string; value: number | null }>).ai_auto_closed_orders;
  assert.deepEqual([auto(b30).state, auto(b30).value], ["VALUE", 0], "quy kết đọc được: 0 đơn AI tự chốt là 0 thật");
  const health = await pdb.select().from(schema.platformTenantHealthDaily).where(and(eq(schema.platformTenantHealthDaily.day, today), inArray(schema.platformTenantHealthDaily.orgCode, [...ORGS])));
  assert.equal(health.length, 2);
  for (const h of health) {
    assert.ok(h.reasonCodes.length >= 1 && h.churnReasonCodes.length >= 1, "mọi mức có ít nhất một mã lý do");
    assert.equal(h.ruleVersion, tenantHealthRuleVersion());
    assert.ok(["CRITICAL", "NEEDS_ATTENTION", "UNKNOWN", "HEALTHY", "INACTIVE"].includes(h.level));
  }
  const firstAt = new Map(rows.map((r) => [`${r.orgCode}:${r.windowDays}`, r.capturedAt.getTime()]));

  // ── Lượt 2 cùng ngày: BỎ QUA — không thêm, không ghi lại dòng nào.
  const r2 = await captureTenantValue(mine, new Date(now.getTime() + 1000), { source: "JOB" });
  assert.equal(r2.status, "SKIPPED", "một lần mỗi ngày VN");
  assert.deepEqual(r2.alreadyCaptured.sort(), [...ORGS]);
  rows = await valueRows(today, [...ORGS]);
  assert.equal(rows.length, 6, "chạy hai lần một ngày = một bộ dòng");
  for (const r of rows) assert.equal(r.capturedAt.getTime(), firstAt.get(`${r.orgCode}:${r.windowDays}`), "lượt bỏ qua không ghi lại dòng nào");

  // ── Ngày đã qua: một dòng hôm qua (gieo thẳng như dữ liệu cũ) không bị đụng, lượt `now` hôm qua bị từ chối.
  const yesterday = new Date(now.getTime() - DAY_MS);
  const yDay = vnDate(yesterday);
  await pdb.insert(schema.platformTenantValueSnapshots).values({ capturedDay: yDay, orgCode: A, windowDays: 30, windowFrom: new Date(yesterday.getTime() - 29 * DAY_MS), windowTo: yesterday, metrics: {}, customerSpendVnd: 123, formulaVersion: "tv0.attr0", capturedAt: yesterday });
  const rOld = await captureTenantValue(mine, yesterday, { source: "JOB", force: true });
  assert.equal(rOld.status, "REFUSED", "lượt mang mốc hôm qua không được ghi");
  assert.equal(await writeTenantHealthDay(A, yesterday, { health: { level: "HEALTHY", reasonCodes: ["ALL_SIGNALS_OK"], gapCodes: [], explanation: [] }, churn: { risk: "LOW", reasonCodes: ["NO_RISK_SIGNAL"], gapCodes: [], explanation: [], ruleVersion: 1 }, topIssue: null }), false, "đường ghi sức khoẻ từ chối ngày đã qua");
  assert.equal((await pdb.select().from(schema.platformTenantHealthDaily).where(and(eq(schema.platformTenantHealthDaily.day, yDay), eq(schema.platformTenantHealthDaily.orgCode, A)))).length, 0);

  // ── Lượt `force` hôm nay với nguồn hỏng: quy kết của B ném · sổ AI nhà ném · thêm một tổ chức không mở được.
  const ghost = org(GHOST);
  const rBad = await captureTenantValue([...mine, ghost], new Date(now.getTime() + 2000), {
    source: "OPS",
    force: true,
    readers: {
      attribution: async (orgCode, o) => {
        if (orgCode === B) throw new Error("sổ sự kiện B hỏng (giả lập)");
        const { loadOrderAttribution } = await import("@/lib/sales-chatbot/attribution");
        return loadOrderAttribution(o);
      },
      aiUsage: async () => {
        throw new Error("sổ AI nhà hỏng (giả lập)");
      },
    },
  });
  assert.equal(rBad.status, "CAPTURED");
  assert.equal(rBad.targets, 3);
  rows = await valueRows(today, [...ORGS, GHOST]);
  assert.equal(rows.length, 9, "ghi đè hôm nay (ảnh cuối ngày thắng) + tổ chức không mở được VẪN có dòng (chưa biết)");
  const yRow = (await valueRows(yDay, [A]))[0];
  assert.equal(yRow.customerSpendVnd, 123, "dòng ngày đã qua không bị ghi lại");
  assert.equal(yRow.formulaVersion, "tv0.attr0");
  for (const r of rows) {
    assert.equal(r.variableCogsVnd, null, `${r.orgCode}/${r.windowDays}: sổ AI hỏng ⇒ giá vốn NULL (chưa biết), không phải 0`);
    assert.ok(r.sourceErrors.some((e) => e.startsWith("AI_USAGE (")), "lỗi nguồn nhà nằm trong source_errors của mọi dòng");
  }
  for (const r of rows.filter((x) => x.orgCode === B)) {
    assert.ok(r.sourceErrors.some((e) => e.startsWith("ATTRIBUTION:")), "B: quy kết hỏng được ghi tên nguồn");
    assert.equal(auto(r).state, "UNKNOWN", "B: ô quy kết CHƯA BIẾT");
    assert.equal(r.aiCreditedGrossProfitVnd, null);
    assert.equal(r.ordersPending, 0, "B: nguồn khác (hiệu quả AI) vẫn có số");
  }
  for (const r of rows.filter((x) => x.orgCode === A)) {
    assert.ok(!r.sourceErrors.some((e) => e.startsWith("ATTRIBUTION")), "A không mang lỗi của B");
    assert.equal(auto(r).state, "VALUE", "A: quy kết vẫn đọc được");
  }
  for (const r of rows.filter((x) => x.orgCode === GHOST)) {
    assert.ok(r.sourceErrors.some((e) => e.startsWith("ORG_CONTEXT:")), "tổ chức không mở được: nói rõ nguồn");
    assert.equal(r.ordersPending, null, "không mở được CSDL tổ chức ⇒ đơn chờ CHƯA BIẾT, không phải 0");
  }
  const hGhost = await pdb.select().from(schema.platformTenantHealthDaily).where(and(eq(schema.platformTenantHealthDaily.day, today), eq(schema.platformTenantHealthDaily.orgCode, GHOST)));
  assert.equal(hGhost.length, 1);
  assert.notEqual(hGhost[0].level, "HEALTHY", "thiếu tín hiệu không bao giờ ra «khoẻ»");
  assert.notEqual(hGhost[0].churnRisk, "LOW", "thiếu tín hiệu bắt buộc không bao giờ ra rủi ro thấp");

  // CHECK của bảng: cửa sổ ngoài 7/30/90, mã lý do sai dạng, chi âm bị từ chối.
  await assert.rejects(pdb.execute(sql`insert into platform_tenant_value_snapshots (captured_day, org_code, window_days, window_from, window_to, metrics, formula_version) values (${today}, ${GHOST}, 14, now() - interval '1 day', now(), '{}'::jsonb, 'x')`), "cửa sổ chỉ 7/30/90");
  await assert.rejects(pdb.execute(sql`insert into platform_tenant_value_snapshots (captured_day, org_code, window_days, window_from, window_to, metrics, formula_version, variable_cogs_vnd) values (${yDay}, ${GHOST}, 7, now() - interval '1 day', now(), '{}'::jsonb, 'x', -1)`), "giá vốn không âm");
  await assert.rejects(pdb.execute(sql`insert into platform_tenant_value_snapshots (captured_day, org_code, window_days, window_from, window_to, metrics, formula_version) values (${yDay}, ${GHOST}, 7, now() - interval '1 day', now(), '{}'::jsonb, '  ')`), "phiên bản công thức khác rỗng");
  await assert.rejects(pdb.execute(sql`insert into platform_tenant_health_daily (day, org_code, level, churn_risk, reason_codes, churn_reason_codes, rule_version) values (${yDay}, ${GHOST}, 'HEALTHY', 'LOW', array['khoe qua']::text[], array['NO_RISK_SIGNAL']::text[], 'v')`), "mã lý do phải là MÃ");
  await assert.rejects(pdb.execute(sql`insert into platform_tenant_health_daily (day, org_code, level, churn_risk, reason_codes, churn_reason_codes, rule_version) values (${yDay}, ${GHOST}, 'HEALTHY', 'LOW', '{}'::text[], array['NO_RISK_SIGNAL']::text[], 'v')`), "mọi mức có ít nhất một mã");
  await assert.rejects(pdb.execute(sql`insert into platform_tenant_health_daily (day, org_code, level, churn_risk, reason_codes, churn_reason_codes, rule_version) values (${yDay}, ${GHOST}, 'HEALTHY', 'RAT_THAP', array['ALL_SIGNALS_OK']::text[], array['NO_RISK_SIGNAL']::text[], 'v')`), "rủi ro trong danh sách đóng");

  const ms = r1.orgs.map((o) => o.ms);
  console.log(`  ✓ ảnh giá trị (CSDL): 3 dòng / tổ chức + 1 dòng sức khoẻ · chạy lại = bỏ qua · nguồn hỏng ⇒ chỉ ô của nó null + source_errors · ngày cũ không bị ghi · thời gian chụp fixture: sổ nhà ${r1.homeMs} ms, tổ chức ${ms.join(" / ")} ms, tổng ${r1.totalMs} ms`);
}

// ═══════════ 3 · MÃ NGUỒN ═══════════

const goc = path.resolve(__dirname, "..");
const boChuThich = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ma = (tep: string) => boChuThich(readFileSync(path.join(goc, tep), "utf8"));

function tepMa(): string[] {
  return execSync("git ls-files lib app components scripts db", { cwd: goc, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().split(path.sep).join("/"))
    .filter((l) => /\.(ts|tsx|mjs)$/.test(l));
}

/** Hai bảng, mỗi bảng ĐÚNG một tệp được ghi. `db/migrate.ts` chỉ DỌN bản sao trong CSDL tổ chức (mặt phẳng điều khiển chỉ thật ở nhà). */
const WRITERS = [
  { ident: "platformTenantValueSnapshots", table: "platform_tenant_value_snapshots", file: "lib/saas/tenant-value-capture.ts" },
  { ident: "platformTenantHealthDaily", table: "platform_tenant_health_daily", file: "lib/saas/tenant-health-daily.ts" },
] as const;

function testSource() {
  const files = tepMa();
  assert.ok(files.includes("lib/saas/tenant-value-capture.ts") && files.includes("lib/saas/tenant-health-daily.ts"), "hai tệp lượt chụp phải đã vào kho (bài quét đọc git ls-files)");
  for (const w of WRITERS) {
    const pham: string[] = [];
    for (const f of files) {
      const m = ma(f);
      const raw = new RegExp(String.raw`(?:insert\s+into|update|delete\s+from)\s+"?${w.table}\b`, "i").test(m);
      const viaOrm = m.includes(w.ident) && /\.(?:insert|update|delete)\(/.test(m);
      if (raw && f !== "db/migrate.ts") pham.push(`${f} (SQL thô)`);
      if (viaOrm && f !== w.file && f !== "db/schema.ts") pham.push(`${f} (ORM)`);
    }
    assert.deepEqual(pham, [], `${w.table}: chỉ ${w.file} được ghi`);
  }
  // Chỉ đường JOB gọi lượt chụp: không trang / component nào, không server action nào.
  const goi = files.filter((f) => f !== "lib/saas/tenant-value-capture.ts" && /\bcaptureTenantValue\(/.test(ma(f)));
  assert.deepEqual(goi, ["lib/platform/saas-ledger.ts"], "captureTenantValue chỉ được gọi từ captureSaasSnapshot (đường JOB)");
  const trang = files.filter((f) => (f.startsWith("app/") || f.startsWith("components/") || f.startsWith("lib/actions/")) && /tenant-value-capture|tenant-health-daily|captureTenantValue|writeTenantHealthDay/.test(ma(f)));
  assert.deepEqual(trang, [], "không đường trang / action nào chạm lượt chụp");
  // captureSaasSnapshot: lượt chụp giá trị CHỈ trong nhánh source === "JOB".
  const ledger = ma("lib/platform/saas-ledger.ts");
  const fnBody = ledger.slice(ledger.indexOf("export async function captureSaasSnapshot("), ledger.indexOf("// ─────────────────────────── Sổ dùng theo ngày"));
  const job = fnBody.indexOf('if (opts.source === "JOB") {');
  assert.ok(job > 0 && fnBody.indexOf("captureTenantValue(") > job, "captureSaasSnapshot gọi lượt chụp giá trị CHỈ trong nhánh JOB");
  assert.equal((fnBody.match(/captureTenantValue\(/g) ?? []).length, 1, "đúng một lời gọi");
  const cockpit = ma("lib/platform/saas-cockpit.ts");
  assert.equal((cockpit.match(/ensureSaasSnapshot\([^)]*"JOB"\)/g) ?? []).length, 1, "chỉ saasSnapshotForJob đi đường JOB");
  const pageLoad = cockpit.slice(cockpit.indexOf("export async function loadOwnerCockpit("));
  assert.ok(/ensureSaasSnapshot\(now\)/.test(pageLoad) && !/ensureSaasSnapshot\([^)]*"JOB"/.test(pageLoad), "lượt mở trang không chụp ảnh giá trị");
  // Bảng platform_* mới khai đủ ba chỗ (mặt phẳng điều khiển · xoá tổ chức · dọn CSDL tổ chức).
  const migrate = ma("db/migrate.ts");
  for (const w of WRITERS) {
    assert.ok((CONTROL_PLANE_TABLES as readonly string[]).includes(w.table), `${w.table} trong CONTROL_PLANE_TABLES`);
    assert.equal(OFFBOARD_TABLES[w.table as keyof typeof OFFBOARD_TABLES]?.disposition, "DELETE", `${w.table}: xoá tổ chức xoá dòng theo mã (mã được dùng lại)`);
    assert.ok(OFFBOARD_DELETE_ORDER.includes(w.table as (typeof OFFBOARD_DELETE_ORDER)[number]), `${w.table} trong thứ tự xoá`);
    assert.ok(migrate.includes(`delete from ${w.table}`), `${w.table}: migrateOrganizationDb dọn bản sao trong CSDL tổ chức`);
  }
  // Lượt chụp không tự viết lại điều kiện kết cục đơn — số đơn / doanh thu đi qua bộ đọc đã có (ORDER_OUTCOME).
  for (const f of ["lib/saas/tenant-value-capture.ts", "lib/saas/tenant-health-daily.ts"]) {
    assert.ok(!/ORDER_OUTCOME|"DELIVERED"|'DELIVERED'|shipments/.test(ma(f)), `${f}: không tự kết luận giao thành công`);
    assert.ok(!/getDbFor\b|getDbForInspection\b/.test(ma(f)), `${f}: mở CSDL tổ chức chỉ qua withOrganization`);
  }
  console.log("  ✓ ảnh giá trị (mã nguồn): mỗi bảng một tệp ghi · chỉ captureSaasSnapshot (nhánh JOB) gọi lượt chụp · không trang nào chạm · bảng khai đủ ba chỗ · không tự kết luận giao thành công");
}

export async function testSaasValueSnapshots() {
  testPure();
  testSource();
  await cleanup();
  try {
    await testDb();
  } finally {
    await cleanup();
  }
}

if (/saas-value-snapshots\.test\.ts$/.test(process.argv[1] ?? "")) testSaasValueSnapshots().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

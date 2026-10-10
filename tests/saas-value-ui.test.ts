/**
 * TRUNG TÂM GIÁ TRỊ SAAS PR-4 — màn hình ĐỌC ẢNH CHỤP (sứ mệnh saas-value-ui · docs/saas/VALUE_CENTER.md).
 *
 *  1. THUẦN — dựng ô hiển thị (`lib/saas/tenant-value-view.ts`): CHƯA BIẾT in «—», KHÔNG ÁP DỤNG in «N/A», 0 THẬT in «0 ₫»; không ô nào
 *     in 0 khi giá trị null (chạy trên ĐÚNG đầu ra của `buildTenantValue` khi mọi nguồn thiếu); cận dưới / trên in «≥» / «≤»; ô tạm
 *     mang mã quyết định; tooltip có «tử/mẫu»; mức rủi ro thiếu tín hiệu in «Chưa đủ dữ liệu»; lối ra lạ bị bỏ; `?w=` mặc định D12.
 *  2. CSDL THẬT (CSDL nhà PGlite) — bộ đọc bảng: ảnh MỚI NHẤT mỗi tổ chức, ĐÚNG cửa sổ, sắp theo cột phẳng với NULL CUỐI ở cả hai
 *     chiều, phân trang ghép lại đúng danh sách đầy đủ, ô bội số đọc từ ảnh 90 ngày, sức khoẻ ngày gần nhất; bộ đọc một khách: ba
 *     cửa sổ + dải 30 ngày (ngày chưa chụp là ô rỗng). Mốc = ĐỒNG HỒ THẬT (luật 50), dữ liệu gieo tương đối so với chính mốc đó.
 *  3. MÃ NGUỒN — đường khối giá trị (trang /platform/saas, tệp đọc, tệp dựng ô, component) KHÔNG nhắc getDbFor / withOrganization /
 *     captureTenantValue / ensureSaasSnapshot; khối giá trị dựng TRƯỚC mọi `Suspense`, khối cũ chỉ chạy sau ranh giới; client wrapper
 *     chỉ nhập KIỂU từ lib/saas; id cột sắp xếp trùng danh sách của truy vấn; không chuỗi «/100»; drill-down đọc sống chỉ ở tuyến riêng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { vnDate } from "@/lib/billing/rules";
import { TENANT_VALUE_SORTABLE, parseValueWindow } from "@/lib/constants/tenant-value-board";
import { DEFAULT_TENANT_VALUE_DECISIONS, TENANT_VALUE_METRICS, type TenantValueKey } from "@/lib/constants/tenant-value-metrics";
import { MISSING_TEXT, NOT_APPLICABLE_TEXT } from "@/lib/format";
import { buildTenantValue } from "@/lib/saas/tenant-value";
import type { SessionUser } from "@/lib/auth/session";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { loadAttributedOrdersAsOperator } from "@/lib/saas/tenant-value-drill";
import { HEALTH_STRIP_DAYS, loadTenantValueBoard, loadTenantValueDetail, readTenantValueBoard, readTenantValueDetail } from "@/lib/saas/tenant-value-read";
import { TENANT_VALUE_DETAIL_KEYS, healthView, metricCellView, readStoredCell, tenantValueRowView, tenantValueWindowView, type CellView } from "@/lib/saas/tenant-value-view";

const DAY_MS = 86_400_000;
const goc = path.resolve(__dirname, "..");
const boChuThich = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ma = (tep: string) => boChuThich(readFileSync(path.join(goc, tep), "utf8"));

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "tvu-user", email: "tvu@local", name: "TVU", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

const cell = (value: number | null, over: Record<string, unknown> = {}) => ({ value, numerator: null, denominator: null, availability: "MEASURED", state: value === null ? "UNKNOWN" : "VALUE", provisional: false, bound: "EXACT", coverage: null, note: null, ...over });

// ═══════════ 1 · THUẦN ═══════════

function cellsOfRow(r: ReturnType<typeof tenantValueRowView>): CellView[] {
  return [r.spend, r.spendCash, r.cogs, r.aiCogs, r.unpricedCalls, r.aiAutoOrders, r.aiInfluencedOrders, r.aiCreditedRevenue, r.aiInfluencedRevenue, r.ordersPending, r.multiple, r.multipleCoverage, r.contribution, r.grossProfit, r.grossProfitCeiling];
}

function testPure() {
  const today = vnDate(new Date());
  // Ba trạng thái, ba cách in.
  const unknown = metricCellView("customer_spend_recognized", readStoredCell({ customer_spend_recognized: cell(null, { note: "Thiếu ngày MRR." }) }, "customer_spend_recognized"));
  assert.equal(unknown.text, MISSING_TEXT, "chưa biết ⇒ «—»");
  assert.match(unknown.hint, /Thiếu ngày MRR/, "tooltip nói thiếu gì");
  const zero = metricCellView("customer_spend_recognized", readStoredCell({ customer_spend_recognized: cell(0) }, "customer_spend_recognized"));
  assert.equal(zero.text, "0 ₫", "0 THẬT ⇒ «0 ₫»");
  const na = metricCellView("customer_value_multiple", readStoredCell({ customer_value_multiple: cell(null, { state: "NOT_APPLICABLE" }) }, "customer_value_multiple"));
  assert.equal(na.text, NOT_APPLICABLE_TEXT, "không áp dụng ⇒ «N/A»");
  // Ô nói VALUE mà không có số hữu hạn ⇒ chưa biết, không phải 0.
  assert.equal(metricCellView("actual_ai_cogs", readStoredCell({ actual_ai_cogs: cell(null, { state: "VALUE" }) }, "actual_ai_cogs")).text, MISSING_TEXT);
  assert.equal(metricCellView("actual_ai_cogs", readStoredCell({ actual_ai_cogs: { value: "12", state: "VALUE" } }, "actual_ai_cogs")).text, MISSING_TEXT, "chuỗi trong jsonb không đọc thành số");
  // Ô vắng hẳn trong ảnh ⇒ «—» + missingWhat.
  const absent = metricCellView("payment_fee_cogs", readStoredCell({}, "payment_fee_cogs"));
  assert.equal(absent.text, MISSING_TEXT);
  // Cận · tử/mẫu · độ phủ · ước tính · tạm.
  const lower = metricCellView("variable_cogs_known", readStoredCell({ variable_cogs_known: cell(12_000, { bound: "LOWER", availability: "ESTIMATED", numerator: 12_000, denominator: 3 }) }, "variable_cogs_known"));
  assert.ok(lower.text.startsWith("≥ "), "cận dưới in «≥»");
  assert.equal(lower.estimated, true);
  assert.match(lower.hint, /Tử\/mẫu: 12\.000\/3/, "tooltip có tử/mẫu");
  const ceiling = metricCellView("platform_gross_profit_ceiling", readStoredCell({ platform_gross_profit_ceiling: cell(5_000, { bound: "UPPER" }) }, "platform_gross_profit_ceiling"));
  assert.ok(ceiling.text.startsWith("≤ "), "cận trên in «≤»");
  const prov = metricCellView("customer_spend_recognized", readStoredCell({ customer_spend_recognized: cell(1, { provisional: true }) }, "customer_spend_recognized"));
  assert.equal(prov.provisional, "D1", "ô tạm mang mã quyết định của sổ chỉ số");
  assert.match(prov.hint, /Quyết định TẠM D1/);
  const mult = metricCellView("customer_value_multiple", readStoredCell({ customer_value_multiple: cell(1.5, { coverage: 0.85, availability: "ESTIMATED" }) }, "customer_value_multiple"));
  assert.equal(mult.text, "1,50×");
  assert.match(mult.hint, /Độ phủ: 85/);

  // MỌI khoá có số: giá trị null ⇒ «—» hoặc «N/A», không bao giờ một chữ số.
  for (const m of TENANT_VALUE_METRICS) {
    if (m.group === "HEALTH") continue;
    for (const state of ["UNKNOWN", "VALUE", "NOT_APPLICABLE"]) {
      const v = metricCellView(m.key as TenantValueKey, readStoredCell({ [m.key]: cell(null, { state }) }, m.key));
      assert.ok(v.text === MISSING_TEXT || v.text === NOT_APPLICABLE_TEXT, `${m.key} (${state}, null) in «${v.text}» — chưa biết không được thành số`);
    }
  }
  // ĐÚNG đầu ra của bộ ghép khi mọi nguồn thiếu, qua vòng jsonb: không ô nào ra số.
  const empty = buildTenantValue({ window: 30, marginApplicable: true, fx: { rateVndPerUsd: 25_000, source: "TEST" }, spend: null, cogs: null, attribution: null, perf: null, aiCalls: null });
  const metrics = JSON.parse(JSON.stringify(empty.metrics));
  const row = tenantValueRowView({ orgCode: "x", orgName: null, orgStatus: null, accountCode: null, capturedDay: today, capturedAtMs: Date.now(), formulaVersion: empty.formulaVersion, sourceErrors: [], metrics, multiple: { metrics, capturedDay: today } }, null, today);
  for (const c of cellsOfRow(row)) assert.ok(c.text === MISSING_TEXT || c.text === NOT_APPLICABLE_TEXT || c.state === "VALUE", `ô «${c.text}» của ảnh rỗng`);
  for (const c of cellsOfRow(row)) if (c.state !== "VALUE") assert.ok(!/\d/.test(c.text), `ô chưa biết in «${c.text}»`);
  const wv = tenantValueWindowView({ capturedDay: today, capturedAtMs: Date.now(), formulaVersion: "tv1", sourceErrors: [], metrics }, today);
  for (const k of TENANT_VALUE_DETAIL_KEYS) if (wv.cells[k].state !== "VALUE") assert.ok(!/\d/.test(wv.cells[k].text), `${k}: ô chưa biết in «${wv.cells[k].text}»`);
  assert.equal(row.href, "/platform/org/x", "workspace chưa gắn tài khoản ⇒ chẩn đoán tổ chức");
  assert.equal(row.health, null);

  // Sức khoẻ: mức + mã, rủi ro thiếu tín hiệu = «Chưa đủ dữ liệu», lối ra lạ bị bỏ, ngày cũ đếm ngày.
  const yesterday = vnDate(new Date(Date.now() - DAY_MS));
  const h = healthView({ day: yesterday, level: "UNKNOWN", churnRisk: "UNKNOWN", reasonCodes: ["SIGNALS_MISSING"], gapCodes: ["USAGE_TREND_UNMEASURED"], churnReasonCodes: ["REQUIRED_SIGNAL_MISSING"], topIssue: { code: "X", label: "Việc", explanation: "e", action: { label: "Mở", href: "https://ngoai.example" } } }, today);
  assert.ok(h);
  assert.equal(h.churn.label, "Chưa đủ dữ liệu");
  assert.equal(h.levelLabel, "Chưa đủ dữ liệu");
  assert.equal(h.staleDays, 1);
  assert.equal(h.topIssue?.href, "", "lối ra không phải đường /platform/ ⇒ không in liên kết");
  assert.equal(h.gaps[0].label, "Chưa so được xu hướng dùng");
  const ok = healthView({ day: today, level: "CRITICAL", churnRisk: "CRITICAL", reasonCodes: ["AI_OFF"], gapCodes: [], churnReasonCodes: ["PRODUCT_DOWN"], topIssue: { code: "AI_OFF", label: "AI đang tắt", explanation: "e", action: { label: "Mở chẩn đoán", href: "/platform/org/x" } } }, today);
  assert.equal(ok?.topIssue?.href, "/platform/org/x");
  assert.equal(ok?.churn.reasons[0].label, "Sản phẩm không chạy cho khách");

  // `?w=` — mặc định đọc từ D12, không gõ lại.
  assert.equal(parseValueWindow(undefined), DEFAULT_TENANT_VALUE_DECISIONS.defaultWindowDays);
  assert.equal(parseValueWindow("abc"), DEFAULT_TENANT_VALUE_DECISIONS.defaultWindowDays);
  assert.equal(parseValueWindow("7"), 7);
  assert.equal(parseValueWindow(["90", "7"]), 90);
  console.log("  ✓ giá trị khách hàng (thuần): «—» chưa biết · «N/A» không áp dụng · 0 thật · không ô null nào in số · cận ≥/≤ · tử/mẫu · tạm theo mã quyết định · rủi ro thiếu tín hiệu «Chưa đủ dữ liệu» · cửa sổ mặc định D12");
}

// ═══════════ 2 · CSDL THẬT ═══════════

const A = "tvu-a";
const B = "tvu-b";
const C = "tvu-c";
const CODES = [A, B, C];

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformTenantValueSnapshots).where(inArray(schema.platformTenantValueSnapshots.orgCode, CODES));
  await pdb.delete(schema.platformTenantHealthDaily).where(inArray(schema.platformTenantHealthDaily.orgCode, CODES));
}

async function testDb() {
  const pdb = await getPlatformDb();
  // Mốc theo ĐỒNG HỒ THẬT (luật 50); dữ liệu gieo tương đối so với chính mốc này, và bộ đọc nhận cùng mốc.
  const now = new Date();
  const day = (n: number) => vnDate(new Date(now.getTime() - n * DAY_MS));
  const snap = (org: string, d: number, w: number, spend: number | null, extra: Record<string, unknown> = {}, milli: number | null = null) => ({
    capturedDay: day(d),
    orgCode: org,
    windowDays: w,
    windowFrom: new Date(now.getTime() - (d + w) * DAY_MS),
    windowTo: new Date(now.getTime() - d * DAY_MS),
    metrics: { customer_spend_recognized: cell(spend, { provisional: true }), ...extra },
    customerSpendVnd: spend,
    valueMultipleMilli: milli,
    formulaVersion: "tv1.attr1",
    capturedAt: new Date(now.getTime() - d * DAY_MS),
  });
  await pdb.insert(schema.platformTenantValueSnapshots).values([
    snap(A, 2, 30, 100),
    snap(A, 1, 30, 300),
    snap(A, 1, 7, 999),
    snap(A, 1, 90, 900, { customer_value_multiple: cell(1.5, { availability: "ESTIMATED", coverage: 0.9 }) }, 1500),
    snap(B, 1, 30, null),
    snap(C, 0, 30, 200),
  ]);
  await pdb.insert(schema.platformTenantHealthDaily).values([
    { day: day(3), orgCode: A, level: "HEALTHY", churnRisk: "LOW", reasonCodes: ["ALL_SIGNALS_OK"], gapCodes: [], churnReasonCodes: ["NO_RISK_SIGNAL"], topIssue: null, ruleVersion: "t" },
    { day: day(1), orgCode: A, level: "NEEDS_ATTENTION", churnRisk: "MEDIUM", reasonCodes: ["USAGE_TREND_DOWN"], gapCodes: [], churnReasonCodes: ["USAGE_TREND_DOWN"], topIssue: { code: "USAGE_TREND_DOWN", source: "HEALTH", rank: 2, label: "Dùng giảm", explanation: "e", action: { label: "Xem", href: `/platform/org/${A}` } }, ruleVersion: "t" },
  ]);

  const mine = (rows: { orgCode: string }[]) => rows.filter((r) => CODES.includes(r.orgCode)).map((r) => r.orgCode);
  const desc = await readTenantValueBoard({ window: 30, page: 1, pageSize: 100, sort: "customerSpend", dir: "desc", now });
  assert.deepEqual(mine(desc.rows), [A, C, B], "giảm dần: 300 · 200 · NULL cuối");
  const asc = await readTenantValueBoard({ window: 30, page: 1, pageSize: 100, sort: "customerSpend", dir: "asc", now });
  assert.deepEqual(mine(asc.rows), [C, A, B], "tăng dần: 200 · 300 · NULL VẪN cuối");
  const a = desc.rows.find((r) => r.orgCode === A)!;
  assert.equal(a.capturedDay, day(1), "ảnh MỚI NHẤT của tổ chức");
  assert.equal(a.spend.text, "300 ₫", "không phải ảnh cũ (100) hay cửa sổ khác (999)");
  assert.equal(a.spend.provisional, "D1");
  assert.equal(a.staleDays, 1);
  assert.equal(a.multiple.text, "1,50×", "bội số đọc từ ảnh 90 ngày cùng tổ chức");
  assert.equal(a.multipleDay, day(1));
  assert.equal(a.health?.level, "NEEDS_ATTENTION", "sức khoẻ NGÀY GẦN NHẤT");
  assert.equal(a.health?.topIssue?.href, `/platform/org/${A}`);
  const b = desc.rows.find((r) => r.orgCode === B)!;
  assert.equal(b.spend.text, MISSING_TEXT, "NULL ⇒ «—»");
  assert.equal(b.multiple.text, MISSING_TEXT, "chưa có ảnh 90 ngày ⇒ «—»");
  assert.equal(b.health, null);
  assert.equal(desc.rows.length, desc.total, "trang đủ rộng ⇒ mọi tổ chức");
  assert.ok(desc.capturedToday >= 1, "C có ảnh hôm nay");
  assert.equal(desc.latestCapturedDay, day(0));

  // Phân trang: các trang ghép lại = danh sách đầy đủ, thứ tự ổn định.
  const pages: string[] = [];
  for (let p = 1; p <= desc.pageCount * 3; p++) {
    const r = await readTenantValueBoard({ window: 30, page: p, pageSize: 2, sort: "customerSpend", dir: "desc", now });
    assert.equal(r.total, desc.total, "tổng không đổi theo trang");
    assert.equal(r.pageCount, Math.ceil(desc.total / 2));
    if (!r.rows.length) break;
    pages.push(...r.rows.map((x) => x.orgCode));
  }
  assert.deepEqual(pages, desc.rows.map((x) => x.orgCode), "trang 2 dòng ghép lại đúng thứ tự");

  // Đúng cửa sổ.
  const w7 = await readTenantValueBoard({ window: 7, page: 1, pageSize: 100, now });
  assert.deepEqual(mine(w7.rows), [A]);
  assert.equal(w7.rows.find((r) => r.orgCode === A)?.spend.text, "999 ₫");
  // Cửa sổ chỉ có ảnh hôm qua: «chưa có ảnh hôm nay» (chỉ khẳng định khi không có dòng của bài kiểm khác trong cửa sổ đó).
  const w90 = await readTenantValueBoard({ window: 90, page: 1, pageSize: 100, now });
  const t = schema.platformTenantValueSnapshots;
  const [foreign] = await pdb.select({ n: sql<number>`count(*)::int` }).from(t).where(and(eq(t.windowDays, 90), notInArray(t.orgCode, CODES)));
  if (Number(foreign?.n ?? 0) === 0) assert.equal(w90.capturedToday, 0, "ảnh 90 ngày chỉ có hôm qua ⇒ không tổ chức nào có ảnh hôm nay");
  // Sắp theo cột lạ ⇒ mặc định; theo tên tổ chức (không có dòng tổ chức ⇒ theo mã).
  const odd = await readTenantValueBoard({ window: 30, page: 1, pageSize: 100, sort: "drop table", now });
  assert.equal(odd.sort, "customerSpend");
  const byOrg = await readTenantValueBoard({ window: 30, page: 1, pageSize: 100, sort: "org", dir: "asc", now });
  assert.deepEqual(mine(byOrg.rows), [A, B, C]);
  const byMult = await readTenantValueBoard({ window: 30, page: 1, pageSize: 100, sort: "valueMultiple", dir: "asc", now });
  assert.equal(mine(byMult.rows)[0], A, "bội số (ảnh 90 ngày) có số đứng trước NULL");

  // Một khách: ba cửa sổ + dải 30 ngày.
  const d = await readTenantValueDetail([A, B], now);
  const da = d.orgs.find((o) => o.orgCode === A)!;
  assert.deepEqual(Object.keys(da.windows).map(Number).sort((x, y) => x - y), [7, 30, 90]);
  assert.equal(da.windows[30]?.cells.customer_spend_recognized.text, "300 ₫", "ảnh mới nhất của cửa sổ 30");
  assert.equal(da.windows[90]?.cells.customer_value_multiple.text, "1,50×");
  assert.equal(da.strip.length, HEALTH_STRIP_DAYS);
  assert.equal(da.strip.at(-1)?.day, day(0), "dải kết thúc ở hôm nay");
  const filled = da.strip.filter((s) => s.health).map((s) => s.day);
  assert.deepEqual(filled, [day(3), day(1)], "ngày chưa chụp là ô rỗng, không phải «khoẻ»");
  assert.equal(da.latest?.level, "NEEDS_ATTENTION");
  const dbb = d.orgs.find((o) => o.orgCode === B)!;
  assert.equal(dbb.windows[7], undefined, "chưa có ảnh cửa sổ ⇒ vắng, không phải ô 0");
  assert.equal(dbb.latest, null);

  // Cổng người vận hành: người ngoài tổ chức nhà bị từ chối TRƯỚC lượt đọc; drill-down không đọc chéo bằng cách đổi `?org=`.
  const home = await getHomeOrganization();
  const op = sessionUser({ organization: { code: home.code, name: home.name, isHome: true } });
  const outsider = sessionUser({ permissions: ["platform:operate"], organization: { code: B, name: B, isHome: false } });
  assert.equal((await loadTenantValueBoard(outsider, { window: 30, page: 1 })).ok, false, "tổ chức khách không đọc được bảng nền tảng");
  assert.equal((await loadTenantValueDetail(outsider, [A])).ok, false);
  assert.equal((await loadTenantValueBoard(op, { window: 30, page: 1, now })).ok, true);
  const denied = await loadAttributedOrdersAsOperator(outsider, { accountCode: "x", orgCode: A, days: 30, page: 1, filter: null });
  assert.ok(denied && !denied.ok, "drill-down hỏi người vận hành trước");
  assert.equal(await loadAttributedOrdersAsOperator(op, { accountCode: "khong-co", orgCode: home.code, days: 30, page: 1, filter: null }), null, "workspace không thuộc tài khoản trên đường dẫn ⇒ 404");
  console.log("  ✓ giá trị khách hàng (CSDL): ảnh mới nhất mỗi tổ chức · đúng cửa sổ · NULL cuối cả hai chiều · trang ghép đúng · bội số từ ảnh 90 ngày · sức khoẻ ngày gần nhất · một khách ba cửa sổ + dải 30 ngày");
}

// ═══════════ 3 · MÃ NGUỒN ═══════════

const VALUE_PATH = [
  "app/(dashboard)/platform/saas/page.tsx",
  "lib/saas/tenant-value-read.ts",
  "lib/saas/tenant-value-view.ts",
  "lib/constants/tenant-value-board.ts",
  "components/platform/tenant-value-section.tsx",
  "components/platform/tenant-value-table.tsx",
  "components/platform/tenant-value-detail.tsx",
];

function testSource() {
  const CAM = /\b(getDbFor|getDbForInspection|withOrganization|captureTenantValue|ensureSaasSnapshot|captureSaasSnapshot)\b/;
  for (const f of [...VALUE_PATH, "app/(dashboard)/platform/customers/[code]/page.tsx"]) {
    const m = ma(f);
    assert.ok(!CAM.test(m), `${f}: đường khối giá trị không mở CSDL tổ chức / không chụp ảnh (${m.match(CAM)?.[0]})`);
    assert.ok(!/tenant-value-capture|tenant-health-daily/.test(m), `${f}: không nhập lượt chụp`);
  }
  // Không chuỗi «/100» ở bất kỳ tệp nào của màn hình (D9 — không điểm).
  for (const f of VALUE_PATH) assert.ok(!readFileSync(path.join(goc, f), "utf8").includes("/100"), `${f}: không chuỗi «/100»`);

  // /platform/saas: khối giá trị dựng TRƯỚC, khối cũ (mở CSDL từng tổ chức) chỉ sau ranh giới Suspense.
  const page = ma("app/(dashboard)/platform/saas/page.tsx");
  const main = page.slice(page.indexOf("export default async function OwnerCockpitPage("), page.indexOf("async function CockpitBlocks("));
  assert.ok(main.length > 100, "tách được thân trang");
  for (const heavy of ["loadOwnerCockpit(", "loadPricingEconomics(", "loadPricingAdmin(", "loadPlatformAiControl(", "loadPlatformModelAb("]) assert.ok(!main.includes(heavy), `thân trang không chờ ${heavy} trước khi dựng khối giá trị`);
  assert.ok(/loadTenantValueBoard\(/.test(main), "thân trang đọc ảnh chụp");
  const iValue = main.indexOf("<TenantValueSection");
  const iSuspense = main.indexOf("<Suspense");
  assert.ok(iValue > 0 && iSuspense > iValue, "khối giá trị đứng TRƯỚC ranh giới Suspense");
  assert.ok(/<Suspense\b[^\n]*>\s*<CockpitBlocks\b/.test(main), "cockpit cũ nằm trong Suspense");
  const cockpit = page.slice(page.indexOf("async function CockpitBlocks("), page.indexOf("async function HeavyBlocks("));
  assert.ok(/<Suspense\b[^\n]*>\s*<HeavyBlocks\b/.test(cockpit), "AI Model Control · A/B · Kinh tế đơn vị nằm trong Suspense (vẫn còn, không xoá)");
  const heavyFn = page.slice(page.indexOf("async function HeavyBlocks("));
  for (const k of ["loadPricingEconomics(", "loadPlatformAiControl(", "loadPlatformModelAb(", "<PlatformAiModelControlSection", "<PricingEconomicsSection"]) assert.ok(heavyFn.includes(k), `chức năng cũ còn nguyên: ${k}`);

  // Client wrapper: "use client", chỉ nhập KIỂU từ lib/saas, không lib/queries; id cột sắp xếp trùng danh sách của truy vấn.
  const tableRaw = readFileSync(path.join(goc, "components/platform/tenant-value-table.tsx"), "utf8");
  assert.ok(/^\s*"use client"/.test(tableRaw));
  for (const m of tableRaw.matchAll(/^import\s+(type\s+)?[^;]*from\s+"(@\/lib\/[^"]+)"/gm)) {
    if (m[2].startsWith("@/lib/saas/") || m[2].startsWith("@/lib/queries/")) assert.ok(m[1], `client chỉ nhập KIỂU từ ${m[2]}`);
  }
  assert.ok(tableRaw.includes("<DataTable"), "bảng đi qua DataTable");
  const ids = [...tableRaw.matchAll(/\{\s*id:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  for (const s of TENANT_VALUE_SORTABLE) assert.ok(ids.includes(s), `cột sắp xếp «${s}» phải có trong bảng`);
  assert.ok(/sortable=\{\[\.\.\.TENANT_VALUE_SORTABLE\]\}/.test(tableRaw), "DataTable nhận ĐÚNG danh sách sắp xếp của truy vấn");
  const read = ma("lib/saas/tenant-value-read.ts");
  for (const s of TENANT_VALUE_SORTABLE) assert.ok(new RegExp(`\\b${s}:\\s*"`).test(read), `truy vấn ánh xạ cột «${s}»`);
  assert.ok(/distinct on \(org_code\)/.test(read) && /nulls last/.test(read) && /window_days = \$\{window\}/.test(read), "một câu distinct on theo cửa sổ, NULL cuối");
  // Server Component không truyền hàm sang client: section chỉ truyền dữ liệu.
  assert.ok(/<TenantValueTable rows=\{b\.rows\} pageCount=\{b\.pageCount\} total=\{b\.total\} \/>/.test(ma("components/platform/tenant-value-section.tsx")));

  // Drill-down đọc sống: chỉ tuyến riêng nhập tệp drill; tệp drill hỏi người vận hành TRƯỚC withOrganization.
  const drill = ma("lib/saas/tenant-value-drill.ts");
  assert.ok(drill.indexOf("platformOperatorDenial(user)") > 0 && drill.indexOf("platformOperatorDenial(user)") < drill.indexOf("withOrganization("), "hỏi người vận hành trước khi mở CSDL tổ chức");
  assert.ok(/listAttributedOrders\(/.test(drill), "đọc qua listAttributedOrders (cùng tập, cùng luật)");
  for (const f of [...VALUE_PATH, "app/(dashboard)/platform/customers/[code]/page.tsx"]) assert.ok(!ma(f).includes("tenant-value-drill"), `${f}: không đọc sống đơn trong lượt dựng`);
  assert.ok(ma("app/(dashboard)/platform/customers/[code]/attributed-orders/page.tsx").includes("loadAttributedOrdersAsOperator("));
  assert.ok(ma("components/platform/tenant-value-detail.tsx").includes("/attributed-orders?org="), "lối bấm sang drill-down");
  console.log("  ✓ giá trị khách hàng (mã nguồn): đường khối giá trị không mở CSDL tổ chức / không chụp · khối giá trị trước Suspense, khối cũ còn nguyên sau ranh giới · client chỉ nhập kiểu · id cột = danh sách sắp xếp · không «/100» · drill-down chỉ ở tuyến riêng");
}

export async function testSaasValueUi() {
  testPure();
  testSource();
  await cleanup();
  try {
    await testDb();
  } finally {
    await cleanup();
  }
}

if (/saas-value-ui\.test\.ts$/.test(process.argv[1] ?? "")) testSaasValueUi().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

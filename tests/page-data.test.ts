/**
 * PHASE 4 · SỔ NGUỒN DỮ LIỆU + SỔ ACTION + TRÌNH PHÂN GIẢI KHỐI (docs/platform/phase-4-contracts.md G4–G6, G8–G10).
 *
 * Hai tổ chức THẬT (`pd-a` bật đủ module bán hàng + kho + tài chính; `pd-b` chỉ khách / sản phẩm / đơn) — CSDL PGlite
 * riêng, `provisionOrganization`, tự dọn. Khoá lại:
 *  · sổ ĐÓNG: mọi khoá có hàm đọc / handler, ≥ 6 chỉ số, ≥ 3 chuỗi;
 *  · số đơn KHỚP hàm có sẵn (`orderKpis` của Tổng quan), không tự tính; chuỗi theo ngày cộng lại ra đúng số ấy;
 *  · KPI chưa biết ⇒ `null` (tỷ lệ hoàn khi chưa đơn nào kết thúc);
 *  · cô lập: khối của A không bao giờ trả dòng của B, kể cả khi cấu hình trỏ id của B;
 *  · module tắt ⇒ MODULE_DISABLED, thiếu quyền tài chính ⇒ FORBIDDEN — cả hai với 0 lượt gọi nguồn;
 *  · lọc field không `filterable` ⇒ INVALID_CONFIG (0 lượt gọi); lọc field không được xem ⇒ FORBIDDEN;
 *  · kanban: chỉ field custom kiểu status; đích kéo theo đúng luật chuyển; không quyền sửa ⇒ không kéo được;
 *  · action: `update_safe_field` qua kiểm hợp lệ Phase 2 (chuyển trạng thái sai bị từ chối), phần GHIM thắng client;
 *    `executePageAction` từ chối khối chỉ có trong bản NHÁP; `request_approval` qua luật có cửa duyệt, từ chối khi
 *    một luật không cửa duyệt cũng khớp.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { isModuleKey } from "@/lib/constants/platform-modules";
import { PERMISSION_LABEL } from "@/lib/auth/permissions";
import { createCustomField } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { saveCustomValues } from "@/lib/metadata/values";
import { executePageAction, PAGE_ACTION_HANDLER_KEYS, type PublishedPageLoader } from "@/lib/pages/actions";
import { METRIC_SOURCES, PAGE_ACTIONS, SERIES_SOURCES, LIST_SOURCES, TIMELINE_SOURCES } from "@/lib/pages/catalog";
import { listDataSources, METRIC_WIRING_GAPS, pageDataProbe, resolveBlock, resolvePage, SERIES_WIRING_GAPS, TIMELINE_WIRING_GAPS } from "@/lib/pages/data-sources";
import type { BlockType, PageBlock, PageRenderContext, PageSchema, TableData, KanbanData, KpiData, ChartData, TimelineData, ButtonData } from "@/lib/pages/types";
import { summaries } from "@/lib/perf/registry";
import { clearMemo } from "@/lib/cache";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { orderKpis } from "@/lib/queries/dashboard";
import { resolvePeriod } from "@/lib/search-params";
import { saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";

const A = "pd-a";
const B = "pd-b";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function adminOf(org: string): Promise<SessionUser> {
  return withOrganization(org, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null };
  });
}

function block<T extends BlockType>(id: string, type: T, config: PageBlock<T>["config"]): PageBlock<T> {
  return { id, type, span: 6, config };
}

const ctxOf = (searchParams: Record<string, string | undefined> = {}): PageRenderContext => ({ searchParams, period: "30d" });

async function ok<T>(p: Promise<{ ok: true; data: unknown } | { ok: false; issue: { code: string; message: string } }>, msg: string): Promise<T> {
  const r = await p;
  assert.ok(r.ok, `${msg}: ${r.ok ? "" : `${r.issue.code} — ${r.issue.message}`}`);
  return (r as { data: T }).data;
}

/** Khối phải bị từ chối với đúng mã, và KHÔNG gọi xuống nguồn dữ liệu nào. */
async function denied(p: () => Promise<{ ok: boolean; issue?: { code: string } }>, code: string, msg: string) {
  const before = pageDataProbe.sourceCalls;
  const r = await p();
  assert.equal(r.ok, false, `${msg}: phải bị từ chối`);
  assert.equal(r.issue?.code, code, `${msg}: mã lỗi`);
  assert.equal(pageDataProbe.sourceCalls, before, `${msg}: 0 lượt gọi nguồn dữ liệu`);
}

function testCatalogWiring() {
  assert.ok(METRIC_SOURCES.length >= 6, "≥ 6 nguồn chỉ số");
  assert.ok(SERIES_SOURCES.length >= 3, "≥ 3 nguồn chuỗi");
  for (const k of ["orders_today", "booked_revenue", "delivered_revenue", "available_stock", "returns_in_period", "return_rate"]) assert.ok(METRIC_SOURCES.some((s) => s.key === k), `thiếu chỉ số ${k}`);
  for (const k of ["orders_by_day", "booked_revenue_by_day", "orders_by_stage"]) assert.ok(SERIES_SOURCES.some((s) => s.key === k), `thiếu chuỗi ${k}`);
  for (const k of ["customer", "order", "product", "shipment", "return"]) assert.ok(LIST_SOURCES.some((s) => s.objectKey === k), `thiếu danh sách ${k}`);
  for (const k of ["order", "shipment", "model", "custom_record_customer"]) assert.ok(TIMELINE_SOURCES.some((s) => s.key === k), `thiếu dòng thời gian ${k}`);
  assert.deepEqual(METRIC_WIRING_GAPS, [], "mọi chỉ số có hàm đọc + khai phạm vi, và ngược lại");
  assert.deepEqual(SERIES_WIRING_GAPS, [], "mọi chuỗi có hàm đọc + khai phạm vi");
  assert.deepEqual(TIMELINE_WIRING_GAPS, [], "mọi dòng thời gian có hàm đọc");
  assert.deepEqual([...PAGE_ACTION_HANDLER_KEYS].sort(), PAGE_ACTIONS.map((a) => a.key).sort(), "mọi action có handler, và ngược lại");
  const all = [...METRIC_SOURCES, ...SERIES_SOURCES, ...LIST_SOURCES, ...TIMELINE_SOURCES, ...PAGE_ACTIONS];
  for (const s of all) {
    if (s.module) assert.ok(isModuleKey(s.module), `module lạ: ${s.module}`);
    if (s.permission) assert.ok(PERMISSION_LABEL[s.permission], `khoá quyền lạ: ${s.permission}`);
  }
  const keys = [...METRIC_SOURCES, ...SERIES_SOURCES, ...TIMELINE_SOURCES].map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "khoá nguồn không trùng");
  const approval = PAGE_ACTIONS.find((a) => a.key === "request_approval");
  assert.ok(approval?.requiresApproval && approval.sideEffect === "WRITE", "request_approval: WRITE + cần duyệt");
  assert.equal(PAGE_ACTIONS.find((a) => a.key === "run_workflow")?.permission, "workflow:manage");
  console.log(`✓ Trang động · sổ đóng: ${METRIC_SOURCES.length} chỉ số · ${SERIES_SOURCES.length} chuỗi · ${LIST_SOURCES.length} danh sách · ${TIMELINE_SOURCES.length} dòng thời gian · ${PAGE_ACTIONS.length} action — mỗi khoá có hàm đọc / handler, module + quyền là khoá thật`);
}

export async function testPageData() {
  testCatalogWiring();

  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await provisionOrganization({ code: A, name: "Trang A", modules: ["customers", "products", "orders", "inventory", "logistics", "returns", "finance"], admin: { email: `admin@${A}.local`, name: "QT A", password: "Page@12345" }, source: "TEST", actor: null });
  await provisionOrganization({ code: B, name: "Trang B", modules: ["customers", "products", "orders"], admin: { email: `admin@${B}.local`, name: "QT B", password: "Page@12345" }, source: "TEST", actor: null });
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);
    const actorA: MetadataActor = { id: adminA.id, email: adminA.email };
    // Nhân viên CSKH: xem đơn / khách / hàng hoàn, KHÔNG có quyền tài chính, KHÔNG sửa được khách.
    const staffA: SessionUser = { id: "pd-a-staff", email: "staff@pd-a.local", name: "NV", role: "CS", permissions: ["orders:read", "customers:view", "returns:view", "products:view"], scope: "ALL", departmentCodes: [], positionId: null };
    const now = new Date();

    // ── Dữ liệu B (để A không bao giờ thấy) ──
    await withOrganization(B, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values({ id: "pd-b-c1", name: "Khách B1" });
      await db.insert(schema.orders).values({ id: "pd-b-o1", stage: "CONFIRMED", insertedAt: now, totalPriceAfterDiscount: 999_000 });
    });

    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.users).values({ id: staffA.id, email: staffA.email, name: "NV A", passwordHash: "x", role: "CS", active: true });
      await db.insert(schema.customers).values([
        { id: "pd-a-c1", name: "Khách A1" },
        { id: "pd-a-c2", name: "Khách A2" },
        { id: "pd-a-c3", name: "Khách A3" },
        { id: "pd-a-c1x", name: "Khách A1x" },
      ]);
      await db.insert(schema.orders).values([
        { id: "pd-a-o1", stage: "CONFIRMED", insertedAt: now, totalPriceAfterDiscount: 100_000 },
        { id: "pd-a-o2", stage: "CONFIRMED", insertedAt: now, totalPriceAfterDiscount: 200_000 },
        { id: "pd-a-o3", stage: "PACKING", insertedAt: now, totalPriceAfterDiscount: 300_000 },
        // Đơn Mới chưa chốt: KHÔNG phải đơn lên (population "đã xác nhận").
        { id: "pd-a-o4", stage: "NEW", insertedAt: now, totalPriceAfterDiscount: 50_000 },
        { id: "pd-a-o5", stage: "CONFIRMED", insertedAt: new Date(now.getTime() - 40 * 86_400_000), totalPriceAfterDiscount: 70_000 },
      ]);
      for (const input of [
        { key: "giai_doan", label: "Giai đoạn", type: "status", filterable: true, options: [{ value: "lead", label: "Tiềm năng" }, { value: "vip", label: "VIP" }, { value: "lost", label: "Mất" }], transitions: { lead: ["vip"], vip: ["lost"] } },
        { key: "ghi_chu", label: "Ghi chú", type: "text", filterable: false },
        { key: "bi_mat", label: "Bí mật", type: "text", filterable: true, viewPermission: "metadata:manage" },
      ]) {
        const f = await createCustomField("customer", input, actorA);
        assert.ok(f.ok, `${input.key}: ${JSON.stringify(f)}`);
      }
      for (const [id, v] of [["pd-a-c1", "lead"], ["pd-a-c2", "vip"], ["pd-a-c1x", "lead"]] as const) assert.ok((await saveCustomValues("customer", id, { giai_doan: v }, adminA)).ok);
      assert.ok((await saveCustomValues("customer", "pd-a-c1x", { giai_doan: "vip" }, adminA)).ok);
      assert.ok((await saveCustomValues("customer", "pd-a-c1x", { giai_doan: "lost" }, adminA)).ok);
      assert.ok((await saveCustomValues("customer", "pd-a-c2", { bi_mat: "không cho CSKH xem" }, adminA)).ok);
      clearMemo();

      // ── 1. Số đơn đi qua hàm có sẵn ──
      const today = resolvePeriod({ period: "today" }, "today");
      const d30 = resolvePeriod({ period: "30d" }, "30d");
      const k = await orderKpis(today.from, today.to);
      assert.equal(k.orders, 3, "fixture: 3 đơn đã xác nhận hôm nay (đơn Mới không tính)");
      const todayKpi = await ok<KpiData>(resolveBlock(block("don_hom_nay", "kpi", { metric: "orders_today" }), adminA, ctxOf()), "orders_today");
      assert.equal(todayKpi.value, k.orders, "orders_today = orderKpis(hôm nay).orders — không tự tính");
      assert.equal(todayKpi.value, 3, "A không đếm đơn của B");
      assert.equal(todayKpi.format, "number");
      const booked = await ok<KpiData>(resolveBlock(block("dt", "kpi", { metric: "booked_revenue", period: "today" }), adminA, ctxOf()), "booked_revenue");
      assert.equal(booked.value, k.revenue, "doanh thu lên đơn = orderKpis().revenue");
      assert.equal(booked.value, 600_000);
      const k30 = await orderKpis(d30.from, d30.to);
      const byDay = await ok<ChartData>(resolveBlock(block("theo_ngay", "chart", { series: "orders_by_day", kind: "bar", period: "30d" }), adminA, ctxOf()), "orders_by_day");
      assert.equal(byDay.points.reduce((s, p) => s + (p.y ?? 0), 0), k30.orders, "cộng chuỗi theo ngày = orderKpis(30 ngày).orders");
      assert.equal(byDay.points.length, 30, "30 ngày, ngày không đơn là 0 thật");
      const revDay = await ok<ChartData>(resolveBlock(block("dt_ngay", "chart", { series: "booked_revenue_by_day", kind: "line", period: "30d" }), adminA, ctxOf()), "booked_revenue_by_day");
      assert.equal(revDay.points.reduce((s, p) => s + (p.y ?? 0), 0), k30.revenue);
      const stage = await ok<ChartData>(resolveBlock(block("tt", "chart", { series: "orders_by_stage", kind: "pie", period: "today" }), adminA, ctxOf()), "orders_by_stage");
      assert.deepEqual(stage.points.map((p) => [p.x, p.y]).sort(), [["Mới", 1], ["Đang đóng hàng", 1], ["Đã xác nhận", 2]].sort(), "phân bố nhãn Pancake, nhãn theo cấu hình trạng thái");
      await denied(() => resolveBlock(block("sai_kieu", "chart", { series: "orders_by_stage", kind: "line" }), adminA, ctxOf()), "INVALID_CONFIG", "dạng biểu đồ không khai cho chuỗi");

      // ── 2. CHƯA BIẾT ⇒ null ──
      const rate = await ok<KpiData>(resolveBlock(block("ty_le_hoan", "kpi", { metric: "return_rate" }), adminA, ctxOf()), "return_rate");
      assert.equal(rate.value, null, "chưa đơn nào kết thúc ⇒ tỷ lệ hoàn null, không phải 0%");
      const stock = await ok<KpiData>(resolveBlock(block("ton", "kpi", { metric: "available_stock" }), adminA, ctxOf()), "available_stock");
      assert.equal(stock.value, null, "không mẫu mã nào có phiếu nhập ⇒ tồn khả dụng CHƯA BIẾT, không phải 0");
      await denied(() => resolveBlock(block("khong_co", "kpi", { metric: "loi_nhuan_tu_che" }), adminA, ctxOf()), "INVALID_CONFIG", "chỉ số ngoài sổ");

      // ── 3. Thiếu quyền tài chính ⇒ FORBIDDEN, 0 truy vấn ──
      await denied(() => resolveBlock(block("dt_giao", "kpi", { metric: "delivered_revenue" }), staffA, ctxOf()), "FORBIDDEN", "CSKH đọc doanh thu giao thành công");
      await denied(() => resolveBlock(block("cod", "kpi", { metric: "cod_outstanding" }), staffA, ctxOf()), "FORBIDDEN", "CSKH đọc COD");
      const delivered = await ok<KpiData>(resolveBlock(block("dt_giao", "kpi", { metric: "delivered_revenue" }), adminA, ctxOf()), "delivered_revenue (quản trị)");
      assert.equal(delivered.format, "vnd");

      // ── 4. Bảng: cô lập + cột + lọc ──
      const orders = await ok<TableData>(resolveBlock(block("don", "table", { source: "order", filters: [{ ref: "system:id", op: "eq", value: "pd-b-o1" }] }), adminA, ctxOf()), "bảng đơn lọc id của B");
      assert.equal(orders.total, 0, "cấu hình trỏ id đơn của B ⇒ A không thấy dòng nào");
      const allOrders = await ok<TableData>(resolveBlock(block("don_all", "table", { source: "order", rowLink: true }), adminA, ctxOf()), "bảng đơn");
      assert.equal(allOrders.total, 5);
      assert.ok(allOrders.rows.every((r) => r.id.startsWith("pd-a-")), "chỉ dòng của A");
      assert.equal(allOrders.rows.find((r) => r.id === "pd-a-o4")?.cells["system:stage"], "Mới", "trạng thái đơn in nhãn theo cấu hình");
      assert.equal(allOrders.rows[0].href?.startsWith("/orders/"), true);
      const cus = await ok<TableData>(resolveBlock(block("khach", "table", { source: "customer", pageSize: 500 }), adminA, ctxOf()), "bảng khách");
      assert.equal(cus.pageSize, 100, "pageSize bị kẹp ≤ 100");
      assert.equal(cus.total, 4);
      assert.ok(cus.columns.some((c) => c.id === "custom:bi_mat"), "quản trị thấy cột bí mật");
      const cusStaff = await ok<TableData>(resolveBlock(block("khach", "table", { source: "customer" }), staffA, ctxOf()), "bảng khách (CSKH)");
      assert.ok(!cusStaff.columns.some((c) => c.id === "custom:bi_mat"), "CSKH không có cột field không được xem");
      assert.ok(cusStaff.rows.every((r) => !("custom:bi_mat" in r.cells)));
      const vip = await ok<TableData>(resolveBlock(block("vip", "table", { source: "customer", filters: [{ ref: "custom:giai_doan", op: "eq", value: "vip" }] }), adminA, ctxOf()), "lọc custom");
      assert.deepEqual(vip.rows.map((r) => r.id), ["pd-a-c2"]);
      assert.equal(vip.rows[0].cells["custom:giai_doan"], "VIP", "giá trị trạng thái in theo nhãn");
      await denied(() => resolveBlock(block("loc_sai", "table", { source: "customer", filters: [{ ref: "system:address", op: "eq", value: "x" }] }), adminA, ctxOf()), "INVALID_CONFIG", "lọc field hệ thống không filterable");
      await denied(() => resolveBlock(block("loc_sai2", "table", { source: "customer", filters: [{ ref: "custom:ghi_chu", op: "eq", value: "x" }] }), adminA, ctxOf()), "INVALID_CONFIG", "lọc field custom không filterable");
      await denied(() => resolveBlock(block("loc_sai3", "table", { source: "customer", filters: [{ ref: "custom:khong_co", op: "eq", value: "x" }] }), adminA, ctxOf()), "INVALID_CONFIG", "lọc field không tồn tại");
      await denied(() => resolveBlock(block("loc_sai4", "table", { source: "order", filters: [{ ref: "system:stage", op: "contains", value: 5 }] }), adminA, ctxOf()), "INVALID_CONFIG", "bộ lọc sai hình");
      await denied(() => resolveBlock(block("loc_bm", "table", { source: "customer", filters: [{ ref: "custom:bi_mat", op: "not_empty" }] }), staffA, ctxOf()), "FORBIDDEN", "lọc theo field không được xem");
      await denied(() => resolveBlock(block("sx_custom", "table", { source: "customer", sort: { ref: "custom:giai_doan", dir: "asc" } }), adminA, ctxOf()), "INVALID_CONFIG", "sắp theo field custom");
      await denied(() => resolveBlock(block("ngoai_so", "table", { source: "users" }), adminA, ctxOf()), "INVALID_CONFIG", "nguồn danh sách ngoài sổ");

      // ── 5. Kanban (G6) ──
      const kb = await ok<KanbanData>(resolveBlock(block("bang", "kanban", { objectKey: "customer", statusField: "custom:giai_doan", cardFields: ["system:name", "custom:bi_mat"], allowMove: true }), adminA, ctxOf()), "kanban");
      const col = (v: string) => kb.columns.find((c) => c.value === v)!;
      assert.deepEqual(kb.columns.map((c) => c.value), ["", "lead", "vip", "lost"], "cột 'Chưa đặt' + tuỳ chọn theo thứ tự");
      assert.deepEqual(col("").cards.map((c) => c.id), ["pd-a-c3"]);
      const card = (id: string) => kb.columns.flatMap((c) => c.cards).find((c) => c.id === id)!;
      assert.deepEqual(card("pd-a-c1").moveTargets, ["vip"], "lead ⇒ chỉ vip (luật chuyển)");
      assert.deepEqual(card("pd-a-c2").moveTargets, ["lost"], "vip ⇒ chỉ lost");
      assert.deepEqual(card("pd-a-c1x").moveTargets, [], "lost không có luật đi tiếp ⇒ không kéo được");
      assert.deepEqual(card("pd-a-c3").moveTargets.sort(), ["lead", "lost", "vip"], "chưa đặt ⇒ mọi tuỳ chọn đang bật");
      assert.equal(kb.truncated, false);
      assert.equal(card("pd-a-c1").title, "Khách A1");
      const kbStaff = await ok<KanbanData>(resolveBlock(block("bang", "kanban", { objectKey: "customer", statusField: "custom:giai_doan", cardFields: ["custom:bi_mat"], allowMove: true }), staffA, ctxOf()), "kanban (CSKH)");
      assert.equal(kbStaff.allowMove, false, "không có customers:write ⇒ không kéo");
      assert.ok(kbStaff.columns.every((c) => c.cards.every((x) => x.moveTargets.length === 0 && x.fields.length === 0)), "CSKH: không đích kéo, không field bí mật trên thẻ");
      const kbSmall = await ok<KanbanData>(resolveBlock(block("bang_nho", "kanban", { objectKey: "customer", statusField: "custom:giai_doan", cardFields: [], allowMove: false, limit: 2 }), adminA, ctxOf()), "kanban giới hạn");
      assert.equal(kbSmall.truncated, true, "vượt trần thẻ ⇒ truncated");
      await denied(() => resolveBlock(block("kb_sys", "kanban", { objectKey: "order", statusField: "system:stage", cardFields: [], allowMove: true }), adminA, ctxOf()), "INVALID_CONFIG", "kanban trên trạng thái HỆ THỐNG");
      await denied(() => resolveBlock(block("kb_txt", "kanban", { objectKey: "customer", statusField: "custom:ghi_chu", cardFields: [], allowMove: true }), adminA, ctxOf()), "INVALID_CONFIG", "kanban trên field không phải status");

      // ── 6. Dòng thời gian ──
      await denied(() => resolveBlock(block("tl", "timeline", { source: "custom_record_customer" }), adminA, ctxOf({ id: "pd-a-c1x" })), "INVALID_CONFIG", "thiếu recordParam");
      await denied(() => resolveBlock(block("tl", "timeline", { source: "custom_record_customer", recordParam: "id" }), adminA, ctxOf({ id: "pd-b-c1" })), "NOT_FOUND", "id khách của B");
      const tl = await ok<TimelineData>(resolveBlock(block("tl", "timeline", { source: "custom_record_customer", recordParam: "id" }), adminA, ctxOf({ id: "pd-a-c1" })), "lịch sử custom");
      assert.ok(tl.entries.some((e) => e.detail === "Giai đoạn: — → Tiềm năng"), `sự kiện đổi trạng thái in nhãn: ${JSON.stringify(tl.entries)}`);
      assert.ok(!tl.entries.some((e) => e.detail?.includes("Mất")), "id 'pd-a-c1' KHÔNG kéo theo lịch sử của 'pd-a-c1x'");
      const tl2 = await ok<TimelineData>(resolveBlock(block("tl2", "timeline", { source: "custom_record_customer", recordParam: "id" }), staffA, ctxOf({ id: "pd-a-c2" })), "lịch sử custom (CSKH)");
      assert.ok(!tl2.entries.some((e) => e.detail?.includes("Bí mật")), "CSKH không thấy mốc của field không được xem");
      const tlOrder = await ok<TimelineData>(resolveBlock(block("tl_don", "timeline", { source: "order", recordParam: "don" }), adminA, ctxOf({ don: "pd-a-o1" })), "dòng thời gian đơn");
      assert.ok(tlOrder.entries.some((e) => e.title === "Đơn được tạo"));
      await denied(() => resolveBlock(block("tl_don", "timeline", { source: "order", recordParam: "don" }), adminA, ctxOf({ don: "pd-b-o1" })), "NOT_FOUND", "đơn của B");

      // ── 7. Form ──
      const createForm = await ok<{ mode: string; props: Record<string, unknown> }>(resolveBlock(block("tao", "form", { objectKey: "customer", formKey: "create", mode: "create" }), adminA, ctxOf()), "form tạo");
      assert.equal(createForm.mode, "create");
      assert.ok(Array.isArray(createForm.props.system) && createForm.props.schema, "props của DynamicForm");
      await denied(() => resolveBlock(block("tao", "form", { objectKey: "customer", formKey: "create", mode: "create" }), staffA, ctxOf()), "FORBIDDEN", "CSKH tạo khách");
      await denied(() => resolveBlock(block("tao_don", "form", { objectKey: "order", formKey: "create", mode: "create" }), adminA, ctxOf()), "INVALID_CONFIG", "đơn không có form");
      const edit = await ok<{ recordId: string; props: { values: { custom: Record<string, unknown>; system: Record<string, unknown> }; customEditable: string[] } }>(resolveBlock(block("sua", "form", { objectKey: "customer", formKey: "profile", mode: "edit", recordParam: "id" }), adminA, ctxOf({ id: "pd-a-c2" })), "form sửa");
      assert.equal(edit.props.values.custom.giai_doan, "vip");
      assert.equal(edit.props.values.system.name, "Khách A2");
      const view = await ok<{ props: { customEditable: string[]; custom: { key: string }[] } }>(resolveBlock(block("xem", "form", { objectKey: "customer", formKey: "profile", mode: "view", recordParam: "id" }), staffA, ctxOf({ id: "pd-a-c2" })), "form xem");
      assert.deepEqual(view.props.customEditable, [], "xem ⇒ không ô nào sửa được");
      assert.ok(!view.props.custom.some((f) => f.key === "bi_mat"), "định nghĩa field không được xem không lên trình duyệt");
      await denied(() => resolveBlock(block("sua", "form", { objectKey: "customer", formKey: "profile", mode: "edit", recordParam: "id" }), adminA, ctxOf({ id: "pd-b-c1" })), "NOT_FOUND", "form trỏ khách của B");

      // ── 8. Nút + chữ + trang song song ──
      const btnAdmin = await ok<ButtonData>(resolveBlock(block("nut", "button", { action: "run_workflow", label: "Chạy luật" }), adminA, ctxOf()), "nút (QT)");
      assert.equal(btnAdmin.enabled, true);
      const btnStaff = await ok<ButtonData>(resolveBlock(block("nut", "button", { action: "run_workflow", label: "Chạy luật" }), staffA, ctxOf()), "nút (CSKH)");
      assert.equal(btnStaff.enabled, false, "thiếu workflow:manage ⇒ nút tắt");
      await denied(() => resolveBlock(block("nut_la", "button", { action: "xoa_don", label: "Xoá" }), adminA, ctxOf()), "INVALID_CONFIG", "action ngoài sổ");
      const page: PageSchema = {
        version: 1,
        sections: [
          { key: "tren", blocks: [block("k1", "kpi", { metric: "orders_today" }), block("k2", "kpi", { metric: "delivered_revenue" }), block("t1", "text", { heading: "Chào", body: "<b>thô</b>" })] },
          { key: "duoi", blocks: [block("b1", "table", { source: "customer", pageSize: 2 })] },
        ],
      };
      const rendered = await resolvePage(page, staffA, ctxOf(), "pd-trang");
      const flat = rendered.sections.flatMap((s) => s.blocks);
      assert.deepEqual(flat.map((b) => [b.block.id, b.ok]), [["k1", true], ["k2", false], ["t1", true], ["b1", true]], "khối thiếu quyền hỏng riêng, trang vẫn dựng");
      assert.equal(flat[1].ok === false && flat[1].issue.code, "FORBIDDEN");
      assert.ok(summaries().some((s) => s.name === "page:pd-trang"), "ghi thời gian dựng trang vào sổ đo");
      const ds = listDataSources(staffA);
      assert.ok(!ds.metrics.some((m) => m.key === "delivered_revenue") && ds.metrics.some((m) => m.key === "orders_today"), "trình soạn chỉ gợi ý nguồn người này dùng được");
      assert.ok(!ds.actions.some((a) => a.key === "run_workflow"));

      // ── 8b. Phase 5: tổng hợp theo field · thanh lọc · cột ──
      assert.ok((await createCustomField("customer", { key: "diem", label: "Điểm", type: "number", filterable: true }, actorA)).ok);
      for (const [id, v] of [["pd-a-c1", 10], ["pd-a-c2", 5.5]] as const) assert.ok((await saveCustomValues("customer", id, { diem: v }, adminA)).ok);
      clearMemo();
      const agg = (id: string, aggregate: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, type: "kpi", span: 3, config: { aggregate, ...extra } }) as unknown as PageBlock<"kpi">;
      const aggVal = async (a: Record<string, unknown>, extra: Record<string, unknown> = {}, user: SessionUser = adminA) => (await ok<KpiData>(resolveBlock(agg("agg", a, extra), user, ctxOf()), `tổng hợp ${JSON.stringify(a)}`)).value;
      assert.equal(await aggVal({ objectKey: "customer", fn: "count" }), 4, "đếm khách của A (không đếm của B)");
      assert.equal(await aggVal({ objectKey: "customer", fn: "sum", field: "custom:diem" }), 15.5, "cộng field số tuỳ biến");
      assert.equal(await aggVal({ objectKey: "customer", fn: "avg", field: "custom:diem" }), 7.75, "trung bình trên bản ghi CÓ giá trị");
      assert.equal(await aggVal({ objectKey: "customer", fn: "min", field: "custom:diem" }), 5.5);
      assert.equal(await aggVal({ objectKey: "customer", fn: "max", field: "custom:diem" }), 10);
      assert.equal(await aggVal({ objectKey: "customer", fn: "count", field: "custom:diem" }), 2, "đếm bản ghi CÓ giá trị field");
      assert.equal(await aggVal({ objectKey: "customer", fn: "count", filters: [{ ref: "custom:giai_doan", op: "eq", value: "vip" }] }), 1, "lọc cố định custom trong tổng hợp");
      assert.equal(await aggVal({ objectKey: "customer", fn: "sum", field: "custom:diem", filters: [{ ref: "custom:giai_doan", op: "eq", value: "lost" }] }), null, "không bản ghi nào có giá trị ⇒ CHƯA BIẾT (null), không phải 0");
      assert.equal(await aggVal({ objectKey: "order", fn: "count" }, { dateField: "system:inserted_at", period: "today" }), 4, "đếm đơn tạo hôm nay (kể cả đơn Mới — đếm bản ghi, không phải 'đơn lên')");
      assert.equal(await aggVal({ objectKey: "customer", fn: "avg", field: "system:order_count" }), 0, "field hệ thống khai aggregatable (số đơn đồng bộ, mặc định 0 thật)");
      await denied(() => resolveBlock(agg("dt", { objectKey: "order", fn: "sum", field: "system:total" }), adminA, ctxOf()), "INVALID_CONFIG", "cộng tiền đơn bị từ chối — doanh thu chỉ qua ORDER_OUTCOME");
      await denied(() => resolveBlock(agg("dt", { objectKey: "customer", fn: "sum", field: "system:purchased_amount" }), adminA, ctxOf()), "INVALID_CONFIG", "tiền khách đã mua không tổng hợp");
      await denied(() => resolveBlock(agg("bm", { objectKey: "customer", fn: "count", field: "custom:bi_mat" }), staffA, ctxOf()), "FORBIDDEN", "tổng hợp theo field không được xem");
      await denied(() => resolveBlock(agg("kh", { objectKey: "customer", fn: "count" }), { ...staffA, permissions: ["orders:read"] }, ctxOf()), "FORBIDDEN", "thiếu quyền xem khách");
      await denied(() => resolveBlock(agg("nv", { objectKey: "employee", fn: "count" }), adminA, ctxOf()), "INVALID_CONFIG", "đối tượng ngoài sổ danh sách");

      const chartOf = (id: string, config: Record<string, unknown>) => ({ id, type: "chart", span: 6, config }) as unknown as PageBlock<"chart">;
      const byStage = await ok<ChartData>(resolveBlock(chartOf("tt", { aggregate: { objectKey: "order", fn: "count" }, kind: "pie", groupBy: { ref: "system:stage" } }), adminA, ctxOf()), "đơn theo trạng thái");
      assert.deepEqual(byStage.points.map((p) => [p.x, p.y]).sort(), [["Mới", 1], ["Đang đóng hàng", 1], ["Đã xác nhận", 3]].sort(), "nhóm theo trạng thái hệ thống, nhãn theo cấu hình");
      const byStatus = await ok<ChartData>(resolveBlock(chartOf("gd", { aggregate: { objectKey: "customer", fn: "count" }, kind: "bar", groupBy: { ref: "custom:giai_doan" } }), adminA, ctxOf()), "khách theo giai đoạn");
      assert.deepEqual(byStatus.points.map((p) => [p.x, p.y]).sort(), [["Chưa đặt", 1], ["Mất", 1], ["Tiềm năng", 1], ["VIP", 1]].sort(), "nhóm theo trạng thái tuỳ biến — nhãn tuỳ chọn, bản ghi chưa có giá trị ở «Chưa đặt»");
      const sumBy = await ok<ChartData>(resolveBlock(chartOf("sd", { aggregate: { objectKey: "customer", fn: "sum", field: "custom:diem" }, kind: "bar", groupBy: { ref: "custom:giai_doan" } }), adminA, ctxOf()), "tổng điểm theo giai đoạn");
      assert.equal(sumBy.points.find((p) => p.x === "Mất")?.y, null, "nhóm không có giá trị ⇒ null, không vẽ thành 0");
      assert.equal(sumBy.points.find((p) => p.x === "Tiềm năng")?.y, 10);
      const perDay = await ok<ChartData>(resolveBlock(chartOf("nd", { aggregate: { objectKey: "order", fn: "count" }, kind: "bar", groupBy: { bucket: "day", dateField: "system:inserted_at" }, period: "30d" }), adminA, ctxOf()), "đơn theo ngày");
      assert.equal(perDay.points.length, 30, "30 mốc — ngày không có bản ghi là 0 thật");
      assert.equal(perDay.points.reduce((s, p) => s + (p.y ?? 0), 0), 4, "đơn 40 ngày trước nằm ngoài kỳ");
      const perMonth = await ok<ChartData>(resolveBlock(chartOf("nt", { aggregate: { objectKey: "order", fn: "count" }, kind: "line", groupBy: { bucket: "month", dateField: "system:inserted_at" }, period: "all" }), adminA, ctxOf()), "đơn theo tháng");
      assert.equal(perMonth.points.reduce((s, p) => s + (p.y ?? 0), 0), 5, "kỳ toàn bộ: mọi đơn");
      assert.ok(perMonth.points.every((p) => /^\d{2}\/\d{4}$/.test(p.x)), `nhãn tháng MM/YYYY: ${JSON.stringify(perMonth.points)}`);
      await denied(() => resolveBlock(chartOf("sx", { aggregate: { objectKey: "customer", fn: "count" }, kind: "bar", groupBy: { ref: "system:name" } }), adminA, ctxOf()), "INVALID_CONFIG", "nhóm theo field chữ");

      // Thanh lọc: áp ĐÚNG khối đích cùng đối tượng; field không filterable / giá trị hỏng bị BỎ, không làm hỏng trang.
      const filterPage: PageSchema = {
        version: 1,
        sections: [
          {
            key: "loc",
            variant: "plain",
            blocks: [
              {
                id: "loc",
                type: "filter",
                span: 12,
                config: {
                  period: true,
                  fields: [
                    { objectKey: "order", ref: "system:stage", op: "eq" },
                    { objectKey: "customer", ref: "custom:giai_doan", op: "in", label: "Giai đoạn" },
                    { objectKey: "customer", ref: "system:address", op: "eq" },
                    { objectKey: "customer", ref: "custom:ghi_chu", op: "eq" },
                  ],
                  targets: ["don_bang", "khach_bang", "dem_khach"],
                },
              } as PageBlock,
            ],
          },
          {
            key: "noi_dung",
            blocks: [
              block("don_bang", "table", { source: "order" }),
              block("khach_bang", "table", { source: "customer" }),
              block("khach_all", "table", { source: "customer" }),
              { id: "cot", type: "column", span: 4, config: {}, children: [agg("dem_khach", { objectKey: "customer", fn: "count" }), agg("dem_all", { objectKey: "customer", fn: "count" })] } as PageBlock,
            ],
          },
        ],
      };
      const run1 = await resolvePage(filterPage, adminA, ctxOf({ pf_loc_0: "CONFIRMED", pf_loc_1: "vip,lead,khong_co", pf_loc_2: "x", pf_loc_3: "y" }), "pd-loc");
      const got = new Map(run1.sections.flatMap((s) => s.blocks).map((b) => [b.block.id, b]));
      const dataOf = <T,>(id: string): T => {
        const r = got.get(id);
        assert.ok(r?.ok, `${id}: ${JSON.stringify(r)}`);
        return r.data as T;
      };
      assert.equal(dataOf<TableData>("don_bang").total, 3, "bảng đơn chỉ còn đơn Đã xác nhận");
      assert.equal(dataOf<TableData>("don_bang").appliedFilters, 1);
      assert.deepEqual(dataOf<TableData>("khach_bang").rows.map((r) => r.id).sort(), ["pd-a-c1", "pd-a-c2"], "bảng khách lọc theo giai đoạn (giá trị lạ trong danh sách bị bỏ)");
      assert.equal(dataOf<TableData>("khach_all").total, 4, "bảng KHÔNG là đích ⇒ không bị lọc");
      const cot = dataOf<{ children: { block: { id: string }; ok: boolean; data?: KpiData }[] }>("cot");
      assert.deepEqual(cot.children.map((c) => [c.block.id, c.ok && c.data?.value]), [["dem_khach", 2], ["dem_all", 4]], "KPI tổng hợp trong cột: đích bị lọc, không đích thì không");
      const bar = dataOf<{ fields: { param: string; value: unknown; input: string; options?: unknown[] }[]; dropped: { reason: string }[]; pageParams: string[] }>("loc");
      assert.deepEqual(bar.fields.map((f) => [f.param, f.value]), [["pf_loc_0", "CONFIRMED"], ["pf_loc_1", ["vip", "lead"]]], "thanh lọc: hai ô dùng được, giá trị ĐÃ PARSE");
      assert.equal(bar.dropped.length, 2, "field không bật lọc bị bỏ (kèm lý do), không làm hỏng thanh lọc");
      assert.ok(bar.fields[0].options?.length && bar.fields[1].input === "select");
      assert.deepEqual(bar.pageParams, ["don_bang_page", "khach_bang_page", "dem_khach_page"]);
      const run2 = await resolvePage(filterPage, adminA, ctxOf({ pf_loc_0: "KHONG_CO_TRANG_THAI_NAY", pf_loc_1: "'; drop table customers; --" }), "pd-loc");
      const got2 = new Map(run2.sections.flatMap((s) => s.blocks).map((b) => [b.block.id, b]));
      const total2 = (id: string) => {
        const r = got2.get(id);
        assert.ok(r?.ok, `${id}: ${JSON.stringify(r)}`);
        return (r.data as TableData).total;
      };
      assert.equal(total2("don_bang"), 5, "giá trị hỏng ⇒ bỏ qua, không lọc, không lỗi");
      assert.equal(total2("khach_bang"), 4);
      const run3 = await resolvePage(filterPage, staffA, ctxOf({ pf_loc_1: "vip" }), "pd-loc");
      const staffBar = run3.sections[0].blocks[0];
      assert.ok(staffBar.ok && (staffBar.data as { fields: unknown[] }).fields.length === 2, "CSKH có customers:view ⇒ vẫn lọc được theo giai đoạn");
      assert.ok(run3.sections[1].blocks[1].ok && (run3.sections[1].blocks[1].data as TableData).total === 1, "bảng khách của CSKH lọc đúng (VIP)");

      // Cột: con hỏng (thiếu quyền) không kéo con lành; trần 20 đếm cả con.
      const colPage: PageSchema = { version: 1, sections: [{ key: "a", blocks: [{ id: "cot2", type: "column", span: 4, config: {}, children: [block("c_don", "kpi", { metric: "orders_today" }), block("c_tien", "kpi", { metric: "delivered_revenue" })] } as PageBlock, block("ben", "text", { body: "x" })] }] };
      const colRun = await resolvePage(colPage, staffA, ctxOf(), "pd-cot");
      const colRes = colRun.sections[0].blocks[0];
      assert.ok(colRes.ok, "cột dựng được dù một con hỏng");
      assert.deepEqual((colRes.data as { children: { block: { id: string }; ok: boolean; issue?: { code: string } }[] }).children.map((c) => [c.block.id, c.ok ? "ok" : c.issue?.code]), [["c_don", "ok"], ["c_tien", "FORBIDDEN"]]);
      assert.ok(colRun.sections[0].blocks[1].ok, "khối cạnh cột không bị kéo theo");
      const capPage: PageSchema = {
        version: 1,
        sections: [{ key: "a", blocks: [{ id: "cot3", type: "column", span: 4, config: {}, children: Array.from({ length: 6 }, (_, i) => block(`con_${i}`, "text", { body: "x" })) } as PageBlock, ...Array.from({ length: 14 }, (_, i) => block(`t_${i}`, "text", { body: "x" }))] }],
      };
      const capRun = await resolvePage(capPage, adminA, ctxOf(), "pd-tran");
      const last = capRun.sections[0].blocks[capRun.sections[0].blocks.length - 1];
      assert.ok(!last.ok && last.issue.code === "INVALID_CONFIG" && /trần 20/.test(last.issue.message), "khối thứ 21 (đếm cả 6 con của cột) vượt trần");
      assert.ok(capRun.sections[0].blocks.slice(0, -1).every((b) => b.ok), "20 khối đầu (kể cả con) dựng bình thường");

      // ── 9. Action: đọc lại bản ĐÃ XUẤT BẢN ──
      const published: PageSchema = {
        version: 1,
        sections: [
          {
            key: "chinh",
            blocks: [
              block("bang", "kanban", { objectKey: "customer", statusField: "custom:giai_doan", cardFields: [], allowMove: true }),
              block("nut_sua", "button", { action: "update_safe_field", label: "Đặt tiềm năng", input: { objectKey: "customer", field: "giai_doan" } }),
              block("nut_duyet", "button", { action: "request_approval", label: "Xin duyệt VIP", input: { ruleKey: "pd_vip" } }),
              block("nut_chay", "button", { action: "run_workflow", label: "Chạy" }),
              block("chu", "text", { body: "x" }),
            ],
          },
        ],
      };
      const draft: PageSchema = { version: 1, sections: [{ key: "chinh", blocks: [...published.sections[0].blocks, block("nut_nhap", "button", { action: "update_safe_field", label: "Nháp", input: { objectKey: "customer", field: "ghi_chu" } })] }] };
      await db.insert(schema.metaPages).values({ slug: "pd-trang", name: "Trang thử", moduleKey: "customers", draft, published, publishedVersion: 1 });
      const loadPublished: PublishedPageLoader = async (slug) => {
        const d = await getDb();
        const [row] = await d.select({ published: schema.metaPages.published }).from(schema.metaPages).where(eq(schema.metaPages.slug, slug)).limit(1);
        return (row?.published as PageSchema | null) ?? null;
      };
      const run = (blockId: string, input: unknown, user: SessionUser = adminA) => executePageAction("pd-trang", blockId, input, user, { loadPublished });
      const nhap = await run("nut_nhap", { recordId: "pd-a-c1", value: "x" });
      assert.ok(!nhap.ok && nhap.code === "NOT_FOUND", "khối chỉ có trong bản NHÁP ⇒ từ chối");
      const cvOf = async (id: string) => (await db.select({ v: schema.customValues.values }).from(schema.customValues).where(and(eq(schema.customValues.objectKey, "customer"), eq(schema.customValues.recordId, id))))[0]?.v ?? {};
      assert.equal((await cvOf("pd-a-c1")).ghi_chu, undefined, "không ghi gì qua khối nháp");
      assert.ok(!(await run("chu", {})).ok, "khối chữ không có thao tác");
      assert.ok(!(await run("khong_co", {})).ok, "khối không tồn tại");

      const sai = await run("bang", { recordId: "pd-a-c1", value: "lost" });
      assert.ok(!sai.ok && sai.code === "INVALID", `kéo lead ⇒ lost trái luật chuyển bị Phase 2 từ chối: ${JSON.stringify(sai)}`);
      assert.equal((await cvOf("pd-a-c1")).giai_doan, "lead");
      const dung = await run("bang", { recordId: "pd-a-c1", value: "vip" });
      assert.ok(dung.ok, JSON.stringify(dung));
      assert.equal((await cvOf("pd-a-c1")).giai_doan, "vip");
      const ghim = await run("nut_sua", { recordId: "pd-a-c3", value: "lead", field: "ghi_chu", objectKey: "order" });
      assert.ok(ghim.ok, JSON.stringify(ghim));
      assert.equal((await cvOf("pd-a-c3")).giai_doan, "lead", "phần GHIM (objectKey + field) thắng đầu vào client");
      assert.equal((await cvOf("pd-a-c3")).ghi_chu, undefined, "client không đổi được field của nút");
      const la = await run("nut_sua", { recordId: "pd-a-c3", value: "lead", extra: 1 });
      assert.ok(!la.ok && la.code === "INVALID", "khoá lạ trong đầu vào ⇒ từ chối");
      const nv = await run("bang", { recordId: "pd-a-c2", value: "lost" }, staffA);
      assert.ok(!nv.ok && nv.code === "FORBIDDEN", `CSKH không sửa được khách: ${JSON.stringify(nv)}`);
      const cheo = await run("bang", { recordId: "pd-b-c1", value: "vip" });
      assert.ok(!cheo.ok && cheo.code === "NOT_FOUND", "id khách của B qua trang của A ⇒ không tồn tại");
      const chayNv = await run("nut_chay", {}, staffA);
      assert.ok(!chayNv.ok && chayNv.code === "FORBIDDEN", "thiếu workflow:manage");
      const nhatKy = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "PAGE_ACTION_RUN"));
      assert.ok(nhatKy.length >= 3 && nhatKy.every((a) => a.entityId.startsWith("pd-trang#")), "mọi lượt WRITE qua trang có nhật ký");

      // ── 10. request_approval qua luật có cửa duyệt ──
      const gated = await saveRule({ key: "pd_vip", name: "Lên VIP cần duyệt", trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "giai_doan", to: ["vip"] }, conditions: { all: [{ field: "system:name", op: "not_empty" }] }, actions: [{ kind: "notify", message: "Khách lên VIP" }], gate: { kind: "approval", reason: "Quản lý xác nhận VIP" } }, actorA);
      assert.ok(gated.ok, JSON.stringify(gated));
      const chuaBat = await run("nut_duyet", { recordId: "pd-a-c3" });
      assert.ok(!chuaBat.ok && chuaBat.code === "INVALID", "luật chưa bật chạy thật ⇒ từ chối");
      assert.ok((await setRuleStatus(gated.rule.id, "ACTIVE", actorA)).ok);
      assert.ok((await setRuleMode(gated.rule.id, "LIVE", actorA)).ok);
      const loose = await saveRule({ key: "pd_vip_ngay", name: "Lên VIP báo ngay", trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "giai_doan", to: ["vip"] }, conditions: null, actions: [{ kind: "notify", message: "VIP" }], gate: null }, actorA);
      assert.ok(loose.ok, JSON.stringify(loose));
      assert.ok((await setRuleStatus(loose.rule.id, "ACTIVE", actorA)).ok);
      assert.ok((await setRuleMode(loose.rule.id, "LIVE", actorA)).ok);
      const xungDot = await run("nut_duyet", { recordId: "pd-a-c3" });
      assert.ok(!xungDot.ok && xungDot.code === "CONFLICT", `luật không cửa duyệt cũng khớp ⇒ từ chối: ${JSON.stringify(xungDot)}`);
      assert.equal((await cvOf("pd-a-c3")).giai_doan, "lead", "từ chối ⇒ không đổi giá trị");
      assert.ok((await setRuleStatus(loose.rule.id, "PAUSED", actorA)).ok);
      const duyet = await run("nut_duyet", { recordId: "pd-a-c3" });
      assert.ok(duyet.ok, JSON.stringify(duyet));
      assert.equal((await cvOf("pd-a-c3")).giai_doan, "vip");
      const yc = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.group, "WORKFLOW"), eq(schema.approvalRequests.status, "PENDING")));
      assert.equal(yc.length, 1, "đúng một yêu cầu duyệt do bộ máy workflow tạo");
      assert.equal(duyet.ok && duyet.message, "Đã gửi yêu cầu duyệt.");

      // ── 12. Hành động theo dòng (Phase 5): bản ĐÃ XUẤT BẢN + bản ghi tồn tại + trong phạm vi người bấm ──
      const rowTable = (rowActions: Record<string, unknown>[]) => block("bang_khach", "table", { source: "customer", rowActions } as never);
      const rowPublished: PageSchema = {
        version: 1,
        sections: [
          {
            key: "chinh",
            blocks: [
              rowTable([
                { action: "update_safe_field", label: "Đánh dấu mất", input: { field: "giai_doan", value: "lost" }, confirm: "Chắc chưa?" },
                { action: "open_record", label: "Mở" },
              ]),
              { id: "cot_nut", type: "column", span: 4, config: {}, children: [block("nut_trong_cot", "button", { action: "open_page", label: "Sang", input: { slug: "pd-trang" } })] } as PageBlock,
            ],
          },
        ],
      };
      const rowDraft: PageSchema = { version: 1, sections: [{ key: "chinh", blocks: [rowTable([...((rowPublished.sections[0].blocks[0].config as { rowActions: unknown[] }).rowActions as Record<string, unknown>[]), { action: "open_record", label: "Chỉ trong nháp" }])] }] };
      await db.insert(schema.metaPages).values({ slug: "pd-trang-dong", name: "Trang hành động dòng", moduleKey: "customers", draft: rowDraft, published: rowPublished, publishedVersion: 1 });
      const runRow = (recordId: unknown, actionIndex: unknown, user: SessionUser = adminA, input: unknown = {}) =>
        executePageAction("pd-trang-dong", "bang_khach", input, user, { loadPublished, recordId: recordId as string, actionIndex: actionIndex as number });
      const tbRow = await ok<TableData>(resolveBlock(rowPublished.sections[0].blocks[0] as PageBlock<"table">, adminA, ctxOf()), "bảng có hành động theo dòng");
      assert.deepEqual(tbRow.rowActions?.map((a) => [a.index, a.label, a.enabled]), [[0, "Đánh dấu mất", true], [1, "Mở", true]]);
      assert.equal(tbRow.rowActions?.[0].confirm, "Chắc chưa?");
      const tbStaff = await ok<TableData>(resolveBlock(rowPublished.sections[0].blocks[0] as PageBlock<"table">, staffA, ctxOf()), "bảng (CSKH)");
      assert.equal(tbStaff.rowActions?.[0].enabled, false, "CSKH không sửa được field ⇒ nút dòng tắt kèm lý do");
      assert.ok(tbStaff.rowActions?.[0].reason);

      assert.equal((await cvOf("pd-a-c2")).giai_doan, "vip");
      const rOk = await runRow("pd-a-c2", 0, adminA, { recordId: "pd-a-c1", field: "ghi_chu", objectKey: "order", value: "vip" });
      assert.ok(rOk.ok, `hành động dòng chạy: ${JSON.stringify(rOk)}`);
      assert.equal((await cvOf("pd-a-c2")).giai_doan, "lost", "bản ghi của DÒNG (máy chủ ghim) — client không đổi được bản ghi / field / giá trị ghim");
      assert.equal((await cvOf("pd-a-c1")).ghi_chu, undefined);
      const open = await runRow("pd-a-c1", 1, adminA, { recordId: "pd-b-c1" });
      assert.ok(open.ok && open.redirectTo === "/customers/pd-a-c1", `mở bản ghi của dòng: ${JSON.stringify(open)}`);
      const cross = await runRow("pd-b-c1", 1);
      assert.ok(!cross.ok && cross.code === "NOT_FOUND", "id khách của B ⇒ không tồn tại");
      const crossWrite = await runRow("pd-b-c1", 0);
      assert.ok(!crossWrite.ok && crossWrite.code === "NOT_FOUND", "sửa field trên id khách của B ⇒ không tồn tại");
      const crossLog = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "PAGE_ACTION_RUN"), eq(schema.auditLogs.entityId, "pd-trang-dong#bang_khach")));
      assert.ok(!crossLog.some((l) => (l.detail as { recordId?: string } | null)?.recordId === "pd-b-c1"), "bản ghi ngoài phạm vi bị chặn TRƯỚC handler — không có lượt chạy nào được ghi");
      const ghostId = await runRow("khong-co-khach-nay", 1);
      assert.ok(!ghostId.ok && ghostId.code === "NOT_FOUND");
      const draftOnlyRow = await runRow("pd-a-c1", 2);
      assert.ok(!draftOnlyRow.ok && draftOnlyRow.code === "NOT_FOUND", "hành động dòng chỉ có trong NHÁP ⇒ không chạy");
      const badIndex = await runRow("pd-a-c1", "0");
      assert.ok(!badIndex.ok, "vị trí không phải số nguyên ⇒ từ chối");
      const noRecord = await runRow(undefined, 1);
      assert.ok(!noRecord.ok && noRecord.code === "INVALID", "thiếu bản ghi của dòng");
      // Người phạm vi HẸP (Chỉ của mình) trên khách hàng — bảng khách không có cột người ⇒ không dòng nào của họ.
      const narrow: SessionUser = { ...staffA, id: "pd-a-narrow", permissions: ["customers:view", "customers:write"], scope: "SELF" };
      const outScope = await runRow("pd-a-c1", 1, narrow);
      assert.ok(!outScope.ok && outScope.code === "NOT_FOUND", `bản ghi ngoài phạm vi người bấm ⇒ không tồn tại: ${JSON.stringify(outScope)}`);
      const onKanban = await executePageAction("pd-trang", "bang", {}, adminA, { loadPublished, recordId: "pd-a-c1", actionIndex: 0 });
      assert.ok(!onKanban.ok && onKanban.code === "INVALID", "khối không phải bảng không có hành động theo dòng");
      const inColumn = await executePageAction("pd-trang-dong", "nut_trong_cot", {}, adminA, { loadPublished });
      assert.ok(inColumn.ok && inColumn.redirectTo === "/p/pd-trang", "nút nằm TRONG cột vẫn tra được trong bản đã xuất bản");
      const rowLog = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "PAGE_ACTION_RUN"), eq(schema.auditLogs.entityId, "pd-trang-dong#bang_khach")));
      assert.ok(rowLog.some((l) => (l.detail as { recordId?: string } | null)?.recordId === "pd-a-c2"), "nhật ký ghi bản ghi của dòng");
    });

    // ── 11. Tổ chức B: module tắt ⇒ MODULE_DISABLED; không thấy gì của A ──
    await withOrganization(B, async () => {
      clearMemo();
      await denied(() => resolveBlock(block("dt_giao", "kpi", { metric: "delivered_revenue" }), adminB, ctxOf()), "MODULE_DISABLED", "B tắt Tài chính (kể cả quản trị)");
      await denied(() => resolveBlock(block("hoan", "kpi", { metric: "return_rate" }), adminB, ctxOf()), "MODULE_DISABLED", "B tắt Hàng hoàn");
      await denied(() => resolveBlock(block("vd", "table", { source: "shipment" }), adminB, ctxOf()), "MODULE_DISABLED", "B tắt Vận chuyển");
      await denied(() => resolveBlock({ id: "dem_vd", type: "kpi", span: 3, config: { aggregate: { objectKey: "shipment", fn: "count" } } } as PageBlock<"kpi">, adminB, ctxOf()), "MODULE_DISABLED", "tổng hợp trên đối tượng của module tắt");
      const demB = await ok<KpiData>(resolveBlock({ id: "dem_kh", type: "kpi", span: 3, config: { aggregate: { objectKey: "customer", fn: "count" } } } as PageBlock<"kpi">, adminB, ctxOf()), "đếm khách (B)");
      assert.equal(demB.value, 1, "tổng hợp của B chỉ đếm khách của B (memo không lẫn tổ chức)");
      const b = await ok<KpiData>(resolveBlock(block("don_hom_nay", "kpi", { metric: "orders_today" }), adminB, ctxOf()), "orders_today (B)");
      assert.equal(b.value, 1, "B chỉ thấy đơn của mình");
      const bRows = await ok<TableData>(resolveBlock(block("khach", "table", { source: "customer", filters: [{ ref: "system:name", op: "contains", value: "Khách A" }] }), adminB, ctxOf()), "bảng khách B lọc tên của A");
      assert.equal(bRows.total, 0, "B không bao giờ thấy khách của A");
      const loadB: PublishedPageLoader = async (slug) => {
        const d = await getDb();
        const [row] = await d.select({ published: schema.metaPages.published }).from(schema.metaPages).where(eq(schema.metaPages.slug, slug)).limit(1);
        return (row?.published as PageSchema | null) ?? null;
      };
      const r = await executePageAction("pd-trang", "bang", { recordId: "pd-a-c2", value: "lost" }, adminB, { loadPublished: loadB });
      assert.ok(!r.ok && r.code === "NOT_FOUND", "trang của A không tồn tại trong B");
      const n = await getDb().then((d) => d.select({ n: sql<number>`count(*)` }).from(schema.customValues));
      assert.equal(Number(n[0].n), 0, "B không có giá trị custom nào — không lượt ghi nào chạm B");
    });

    console.log(
      "✓ Trang động · trình phân giải hai tổ chức: số đơn = orderKpis (chuỗi theo ngày cộng lại khớp) · tỷ lệ hoàn / tồn chưa biết ⇒ null · thiếu quyền tài chính ⇒ FORBIDDEN, module tắt ⇒ MODULE_DISABLED, lọc field không filterable ⇒ INVALID_CONFIG — cả ba 0 lượt gọi nguồn · id của B trong cấu hình A ⇒ 0 dòng · kanban đúng luật chuyển · action đọc bản ĐÃ XUẤT BẢN, phần ghim thắng client, update_safe_field qua kiểm Phase 2, request_approval qua luật có cửa duyệt",
    );
  } finally {
    for (const code of [A, B]) await cleanupOrg(code);
  }
}

/**
 * ═══════════ PILOT BÁN BUÔN — ĐƠN HÀNG TẠO TAY (P0 #3) + LUẬT / KPI / DUYỆT / VAI TRÒ (P1 #7 #8 · P2 #17 #18) ═══════════
 *
 * Tổ chức THẬT `po-si` (mẫu bán buôn, KHÔNG bật Pancake; tự cấp, tự dọn):
 *  · tạo đơn tay có dòng hàng ⇒ id `erp-`, lời khai gốc ERP_MANUAL, nhật ký, hiện trong truy vấn /orders;
 *  · kết quả đơn theo ORDER_OUTCOME NHƯ LUẬT HIỆN TẠI (không vận đơn ⇒ NOT_SHIPPED, huỷ ⇒ CANCELLED — không bao giờ DELIVERED);
 *  · tồn THỰC TẾ không đổi khi tạo / sửa / huỷ đơn (luật 10) — lối "Lập phiếu xuất kho" điền sẵn đúng số trên đơn;
 *  · thiếu `orders:write` ⇒ FORBIDDEN; sửa đơn đồng bộ (id không `erp-`) ⇒ NOT_SUPPORTED; huỷ hai lần không ghi thêm;
 *  · khối KPI chỉ số sổ giữ NHÃN GỐC, tên trang đặt chỉ là tên phụ (P1 #8).
 * Tổ chức NHÀ (bật Pancake): cổng đóng, action từ chối kể cả Quản trị; báo cáo danh nghĩa + hiệu quả QC theo marketer
 * KHÔNG đổi một đơn / một đồng khi CSDL có một đơn `erp-` đã xác nhận (luật 3.9 — đơn tay nằm ngoài phép so).
 * Phần thuần: phép tính tiền, sổ đối tượng ↔ `SYNCED_SOURCE_MODULE`, quyền chỉ Quản trị, luật `custom_record.*` trên đối
 * tượng hệ thống bị từ chối ở cả ba cửa, thứ tự số tiền duyệt, chỉ số cần kết nối, vai trò AI mang quyền ngoài gói.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { buildSystemPrompt } from "@/lib/ai-builder/prompt";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS_ADDED_AFTER_SNAPSHOT } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import type { Blueprint } from "@/lib/blueprints/types";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { clearMemo } from "@/lib/cache";
import { isManualOrderId, manualOrderRaw, manualOrderTotals, MANUAL_ORDER_ID_PREFIX, issueReceiptHref } from "@/lib/constants/manual-orders";
import { objectDef } from "@/lib/constants/object-registry";
import { moduleOfPermission } from "@/lib/constants/platform-modules";
import { kpiHeading, METRIC_SOURCES, metricAvailableFor, metricSource } from "@/lib/pages/catalog";
import { listDataSources, resolveBlock } from "@/lib/pages/data-sources";
import { getEnabledModules, invalidateCapabilities, orgHasSyncedSource, SYNCED_SOURCE_MODULE } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { getAdsPerformance } from "@/lib/queries/ads-performance";
import { listOrders, ORDER_SORTABLE } from "@/lib/queries/orders";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { listVariantsForReceipt } from "@/lib/queries/stock";
import { cancelManualOrderCore, createManualOrderCore, manualOrderGate, manualOrderIssuePrefill, updateManualOrderCore } from "@/lib/records/order-create";
import { parseListParams, type Period } from "@/lib/search-params";
import { validateRuleInput } from "@/lib/workflow/rules";
import { approvalAmountOf } from "@/lib/workflow/subject";
import { recordEventObjectProblem } from "@/lib/workflow/trigger-object";
import type { PageBlock } from "@/lib/pages/types";

const ORG = "po-si";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);
const fieldsOf = (r: { ok: true } | { ok: false; errors: { field: string }[] }) => (r.ok ? [] : r.errors.map((e) => e.field));
const clone = <T>(x: T): T => structuredClone(x);
const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

async function outcomeOf(orderId: string): Promise<string | null> {
  const db = await getDb();
  const [r] = await db
    .select({ outcome: ORDER_OUTCOME })
    .from(schema.orders)
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT))
    .where(eq(schema.orders.id, orderId));
  return r?.outcome ?? null;
}

// ─────────────────────────── Phần THUẦN ───────────────────────────

function testPure() {
  // Phép tính tiền: dòng − chiết khấu dòng − chiết khấu đơn; phí ship tách riêng (cùng nghĩa cột Pancake).
  const t = manualOrderTotals(
    [
      { variantId: "a", quantity: 3, unitPrice: 100_000, discount: 20_000 },
      { variantId: "b", quantity: 2, unitPrice: 50_000, discount: 0 },
    ],
    30_000,
    25_000,
  );
  assert.ok(t.ok);
  assert.deepEqual([t.totals.totalPrice, t.totals.totalDiscount, t.totals.totalPriceAfterDiscount, t.totals.grandTotal, t.totals.totalQuantity], [400_000, 50_000, 350_000, 375_000, 5]);
  const bad = manualOrderTotals([{ variantId: "a", quantity: 0, unitPrice: -1, discount: 0 }, { variantId: "a", quantity: 1, unitPrice: 10, discount: 11 }], 0, 0);
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ["lines.0.quantity", "lines.0.unitPrice", "lines.1.discount", "lines.1.variantId"].sort(), "lỗi gắn đúng ô: SL 0, giá âm, trùng mẫu mã, chiết khấu > tiền dòng");
  const over = manualOrderTotals([{ variantId: "a", quantity: 1, unitPrice: 10_000, discount: 0 }], 10_001, 0);
  assert.ok(!over.ok && over.errors[0].field === "orderDiscount", "chiết khấu đơn không được vượt tiền hàng");
  assert.ok(isManualOrderId("erp-1") && !isManualOrderId("123456789") && !isManualOrderId(null));
  assert.equal(manualOrderRaw({ id: 1, status: 1 }), null, "payload Pancake không phải lời khai tay");

  // Sổ đối tượng ↔ MỘT câu hỏi "có nguồn đồng bộ không" (dùng chung với sản phẩm / khách — B1).
  assert.deepEqual(objectDef("order")?.capabilities.create, { requiresModuleOff: SYNCED_SOURCE_MODULE.orders });
  assert.equal(SYNCED_SOURCE_MODULE.orders, "connector_pancake");

  // `orders:write`: thuộc module Đơn hàng, CHỈ Quản trị có mặc định, không tự cấp cho danh sách quyền lưu cũ.
  assert.ok((ALL_PERMISSIONS as string[]).includes("orders:write"));
  assert.equal(moduleOfPermission("orders:write"), "orders");
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) assert.equal((perms as string[]).includes("orders:write"), role === "ADMIN", `mặc định ${role} ${role === "ADMIN" ? "có" : "KHÔNG có"} orders:write`);
  assert.ok(!PERMISSIONS_ADDED_AFTER_SNAPSHOT.includes("orders:write"));

  // P1 #7: `custom_record.*` chỉ phát cho đối tượng tự tạo.
  assert.match(recordEventObjectProblem("custom_record.created", "customer") ?? "", /custom_status/, "đối tượng hệ thống ⇒ từ chối, gợi ý custom_status");
  assert.equal(recordEventObjectProblem("custom_record.created", "x_hop_dong"), null);
  assert.equal(recordEventObjectProblem("custom_status.changed", "customer"), null, "custom_status phát cho mọi đối tượng — không chặn");
  assert.equal(recordEventObjectProblem("custom_record.created", null), null, "không lọc đối tượng ⇒ nghe mọi đối tượng tự tạo");
  const bpRule = clone(WHOLESALE_BLUEPRINT) as Blueprint;
  bpRule.workflows![0] = { ...bpRule.workflows![0], trigger: { kind: "event", event: "custom_record.created", objectKey: "customer" } };
  assert.ok(validateBlueprint(bpRule).errors.some((e) => e.path === "workflows.0.trigger.objectKey" && /custom_status/.test(e.message)), "validateBlueprint (mẫu / AI) từ chối luật tạo-bản-ghi trên khách");
  const editorSrc = readFileSync("lib/platform-ui/workflow-admin-shared.ts", "utf8");
  assert.match(editorSrc, /recordEventObjectProblem\(draft\.event, draft\.objectKey\)/, "trình soạn luật kiểm sớm cùng hàm");

  // P2 #17: số tiền duyệt — field tiền TUỲ BIẾN mà điều kiện dùng ⇒ tiền tuỳ biến khác ⇒ mới tới field hệ thống.
  const refs = ["system:total", "custom:dat_coc", "custom:gia_tri"];
  const fields = { "system:total": "900000", "custom:dat_coc": 1_000_000, "custom:gia_tri": 25_000_000 };
  assert.equal(approvalAmountOf({ field: "custom:gia_tri", op: "gte", value: 20_000_000 }, fields, refs), 25_000_000, "field tuỳ biến điều kiện dùng thắng");
  assert.equal(approvalAmountOf(null, fields, refs), 1_000_000, "không điều kiện ⇒ field tiền TUỲ BIẾN trước field hệ thống");
  assert.equal(approvalAmountOf({ field: "system:total", op: "gte", value: 1 }, fields, refs), 1_000_000, "điều kiện chỉ so field hệ thống ⇒ tuỳ biến vẫn đứng trước");
  assert.equal(approvalAmountOf(null, { "system:total": "900000" }, refs), 900_000, "không field tuỳ biến nào có giá trị ⇒ field hệ thống");

  // P1 #8: chỉ số cần kết nối vận chuyển; nhãn chỉ số sổ không đổi được.
  const cod = metricSource("cod_outstanding")!;
  assert.equal(metricAvailableFor(cod, ["finance"]), false);
  assert.equal(metricAvailableFor(cod, ["finance", "connector_viettelpost"]), true);
  assert.equal(metricAvailableFor(metricSource("booked_revenue")!, ["orders"]), true);
  const finUser = sessionOf({ id: "po-fin", email: "f@po.local" }, { modules: ["core", "orders", "finance", "customers", "products"] });
  assert.ok(!listDataSources(finUser).metrics.some((m) => m.key === "cod_outstanding"), "trình soạn KHÔNG gợi ý COD cho tổ chức không có kết nối vận chuyển");
  assert.ok(listDataSources({ ...finUser, modules: [...finUser.modules!, "logistics", "connector_viettelpost"] }).metrics.some((m) => m.key === "cod_outstanding"));
  const prompt = buildSystemPrompt("new");
  const metricLine = prompt.split("\n").find((l) => l.startsWith("- Chỉ số (kpi.metric)")) ?? "";
  assert.ok(metricLine && !metricLine.includes("cod_outstanding"), "sổ gửi AI: COD không nằm trong danh sách chỉ số dùng tự do");
  assert.match(prompt, /cod_outstanding\[cần connector_viettelpost\]/);
  assert.deepEqual(kpiHeading("Công nợ phải thu", { label: "COD đã giao mà tiền chưa về", labelLocked: true }), { label: "COD đã giao mà tiền chưa về", note: "Tên trên trang: Công nợ phải thu" });
  assert.deepEqual(kpiHeading(undefined, { label: "Tổng giá trị", note: "x" }), { label: "Tổng giá trị", note: "x" }, "KPI tổng hợp giữ nhãn trang");
  const bpKpi = clone(WHOLESALE_BLUEPRINT) as Blueprint;
  (bpKpi.pages![0].schema as { sections: { blocks: unknown[] }[] }).sections[0].blocks.push({ id: "cong_no_cod", type: "kpi", span: 4, title: "Công nợ phải thu", config: { metric: "cod_outstanding" } });
  assert.ok(validateBlueprint(bpKpi).errors.some((e) => /config\.metric$/.test(e.path)), "gói không có kết nối vận chuyển mà dùng COD ⇒ lỗi");
  assert.ok(METRIC_SOURCES.filter((s) => s.requiresAnyModule?.length).every((s) => s.key === "cod_outstanding"), "hôm nay chỉ COD bị gác");

  // P2 #18: vai trò mang quyền của module ngoài gói — mẫu: cảnh báo; AI: lỗi để AI bỏ quyền đó.
  const bpRole = clone(WHOLESALE_BLUEPRINT) as Blueprint;
  bpRole.roles = [...(bpRole.roles ?? []), { key: "giao_van", label: "Giao vận", base: "WAREHOUSE", permissions: ["shipments:view", "orders:read"] } as NonNullable<Blueprint["roles"]>[number]];
  const warn = validateBlueprint(bpRole);
  assert.ok(warn.warnings.some((w) => /shipments:view/.test(w.message)) && !warn.errors.some((e) => /shipments:view/.test(e.message)), "mặc định (mẫu / tệp): cảnh báo");
  assert.ok(validateBlueprint(bpRole, { roleModulePermissions: "error" }).errors.some((e) => /shipments:view/.test(e.message) && /bỏ quyền này/.test(e.message)), "AI: lỗi");
  assert.match(readFileSync("lib/ai-builder/draft.ts", "utf8"), /validateBlueprint\(n\.bp, \{ roleModulePermissions: "error" \}\)/, "AI Builder dùng chế độ lỗi");
  assert.ok(validateBlueprint(WHOLESALE_BLUEPRINT, { roleModulePermissions: "error" }).ok, "mẫu bán buôn vẫn sạch ở chế độ chặt");
}

// ─────────────────────────── Tổ chức NHÀ (bật Pancake) ───────────────────────────

async function testHome() {
  const db = await getDb();
  const admin = sessionOf({ id: "po-home", email: "po@home.local" });
  const gate = await manualOrderGate(admin);
  assert.equal(gate.allowed ? "ALLOWED" : gate.code, "NOT_SUPPORTED", "nhà đồng bộ đơn từ Pancake ⇒ không tạo tay, KỂ CẢ Quản trị");
  assert.equal(await orgHasSyncedSource("orders"), true);
  const count = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.orders).where(like(schema.orders.id, `${MANUAL_ORDER_ID_PREFIX}%`)))[0].n);
  const n0 = await count();
  assert.equal(codeOf(await createManualOrderCore(admin, { customerId: "x", stage: "CONFIRMED", lines: [{ variantId: "x", quantity: 1, unitPrice: 1 }] })), "NOT_SUPPORTED");
  assert.equal(codeOf(await updateManualOrderCore(admin, "erp-x", { customerId: "x", stage: "NEW", lines: [] })), "NOT_SUPPORTED");
  assert.equal(codeOf(await cancelManualOrderCore(admin, "erp-x", { reason: "thử" })), "NOT_SUPPORTED");
  assert.equal(await count(), n0, "bị từ chối ⇒ 0 đơn mới");
  // Nút tạo đơn trên /orders đi qua CÙNG cổng; trang /orders/new 404 khi cổng đóng.
  assert.match(readFileSync("app/(dashboard)/orders/page.tsx", "utf8"), /createGate\.allowed \? \(/);
  assert.match(readFileSync("app/(dashboard)/orders/new/page.tsx", "utf8"), /if \(!gate\.allowed\) notFound\(\)/);

  // Luật 3.9: một đơn `erp-` ĐÃ XÁC NHẬN nằm trong CSDL nhà ⇒ báo cáo danh nghĩa + hiệu quả QC theo marketer KHÔNG đổi.
  clearMemo();
  const before = await getNominalProfitReport(ALL);
  const perfBefore = await getAdsPerformance(ALL);
  const oid = "erp-po-home-fixture";
  await db.insert(schema.products).values({ id: "po-home-prod", name: "PO mã tay (fixture)" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: "po-home-var", productId: "po-home-prod", sku: "PO-HOME-1", retailPrice: 300_000 }).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: oid, stage: "CONFIRMED", status: 1, statusName: "Đã xác nhận", billFullName: "Khách tay", totalPrice: 300_000, totalPriceAfterDiscount: 300_000, insertedAt: new Date(), raw: { origin: "ERP_MANUAL", orderDiscount: 0, createdBy: null } });
  await db.insert(schema.orderItems).values({ id: `${oid}-1`, orderId: oid, variantId: "po-home-var", productId: "po-home-prod", productName: "PO mã tay (fixture)", sku: "PO-HOME-1", quantity: 1, unitPrice: 300_000, lineTotal: 300_000 });
  try {
    clearMemo();
    const after = await getNominalProfitReport(ALL);
    const perfAfter = await getAdsPerformance(ALL);
    assert.equal(after.totals.ordersDistinct, before.totals.ordersDistinct, "số đơn xác nhận (Pancake) của báo cáo danh nghĩa không đổi");
    assert.equal(after.totals.salesAfterDiscount, before.totals.salesAfterDiscount, "doanh số xác nhận không đổi");
    assert.ok(!after.rows.some((r) => r.productId === "po-home-prod"), "mã chỉ có đơn tay không vào bảng theo mã");
    assert.equal(perfAfter.totals.orders, perfBefore.totals.orders, "hiệu quả QC: tổng đơn theo marketer không đổi");
    const sum = (p: typeof perfAfter) => p.marketers.reduce((t, m) => t + m.orders, 0);
    assert.equal(sum(perfAfter), sum(perfBefore), "Σ đơn marketer + Chưa gán không đổi");
    assert.equal(perfAfter.totals.orders, after.totals.ordersDistinct, "phép so 3.9 vẫn khép: marketer = đơn xác nhận");
  } finally {
    await db.delete(schema.orders).where(eq(schema.orders.id, oid));
    await db.delete(schema.productVariants).where(eq(schema.productVariants.id, "po-home-var"));
    await db.delete(schema.products).where(eq(schema.products.id, "po-home-prod"));
    clearMemo();
  }
}

// ─────────────────────────── Tổ chức bán buôn THẬT (không Pancake) ───────────────────────────

async function testWholesaleOrg() {
  await cleanupOrg(ORG);
  const modules = WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work");
  await provisionOrganization({ code: ORG, name: "Bán buôn thử đơn", plan: "standard", modules, admin: { email: `admin@${ORG}.local`, name: "QT bán buôn", password: "DonHang@12345" }, source: "TEST", actor: null });
  try {
    const enabled = await getEnabledModules(ORG);
    assert.ok(enabled.has("orders") && enabled.has("inventory") && !enabled.has("connector_pancake"), "mẫu bán buôn: có Đơn hàng + Kho, không Pancake");
    assert.equal(await orgHasSyncedSource("orders", ORG), false);

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Bán buôn thử đơn", isHome: false };
      const admin = sessionOf(u, { name: "QT bán buôn", organization: org, modules: [...enabled] });
      assert.equal((await manualOrderGate(admin)).allowed, true, "không Pancake + Quản trị ⇒ được tạo đơn");

      // Dữ liệu có sẵn: một khách, hai mẫu mã tạo tay (erp-), phiếu NHẬP 10 cái cho mẫu A.
      const [c] = await db.insert(schema.customers).values({ name: "Đại lý Pilot", phone: "0962727812", address: "12 Láng Hạ", province: "Hà Nội" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-po-prod", name: "Nước suối 500ml", raw: { origin: "ERP_MANUAL", unit: "thùng" } });
      await db.insert(schema.productVariants).values([
        { id: "erp-po-var-a", productId: "erp-po-prod", sku: "NS-24", size: "24 chai", retailPrice: 120_000 },
        { id: "erp-po-var-b", productId: "erp-po-prod", sku: "NS-12", size: "12 chai", retailPrice: 65_000 },
      ]);
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-1", totalQuantity: 10, createdBy: u.email }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: "erp-po-var-a", quantity: 10, unitCost: 80_000 });
      const stockOf = async (id: string) => (await listVariantsForReceipt()).find((v) => v.id === id)?.currentStock;
      assert.equal(await stockOf("erp-po-var-a"), 10);

      const orderCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.orders))[0].n);
      const n0 = await orderCount();
      const input = { customerId: c.id, stage: "CONFIRMED", channel: "Gọi điện", note: "Giao trước 10h", orderDiscount: 10_000, shippingFee: 30_000, lines: [{ variantId: "erp-po-var-a", quantity: 3, unitPrice: 120_000, discount: 0 }, { variantId: "erp-po-var-b", quantity: 2, unitPrice: 65_000, discount: 5_000 }] };

      // Quyền: thiếu orders:write ⇒ từ chối, 0 dòng.
      const sales = sessionOf(u, { role: "MANAGER", permissions: ["orders:read", "customers:view", "products:view"], organization: org, modules: [...enabled] });
      assert.equal(codeOf(await createManualOrderCore(sales, input)), "FORBIDDEN", "thiếu orders:write ⇒ từ chối");
      // Đầu vào sai ⇒ lỗi đúng ô, 0 dòng.
      assert.ok(fieldsOf(await createManualOrderCore(admin, { ...input, customerId: "khong-co" })).includes("customerId"));
      assert.ok(fieldsOf(await createManualOrderCore(admin, { ...input, orderDiscount: 0, lines: [{ variantId: "khong-co", quantity: 1, unitPrice: 1 }] })).includes("lines.0.variantId"));
      assert.ok(fieldsOf(await createManualOrderCore(admin, { ...input, stage: "DELIVERED" })).includes("stage"), "không chọn được 'Đã nhận' — giao / thu chưa có luật cho đơn không ĐVVC (G-ORDER)");
      assert.equal(await orderCount(), n0, "mọi lượt bị từ chối ⇒ 0 đơn");

      const created = await createManualOrderCore(admin, input);
      assert.ok(created.ok, JSON.stringify(created));
      assert.ok(created.id.startsWith(MANUAL_ORDER_ID_PREFIX), "id `erp-` — không bao giờ va id Pancake");
      const row = await db.query.orders.findFirst({ where: eq(schema.orders.id, created.id) });
      assert.ok(row);
      assert.deepEqual(manualOrderRaw(row.raw), { origin: "ERP_MANUAL", orderDiscount: 10_000, createdBy: u.id }, "nguồn ERP khai rõ");
      assert.deepEqual([row.stage, row.status, row.customerId, row.billFullName, row.shipProvince, row.source], ["CONFIRMED", 1, c.id, "Đại lý Pilot", "Hà Nội", "Gọi điện"]);
      assert.deepEqual([row.totalPrice, row.totalDiscount, row.totalPriceAfterDiscount, row.shippingFee, row.totalQuantity, row.itemsCount], [490_000, 15_000, 475_000, 30_000, 5, 2]);
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, created.id));
      assert.deepEqual(items.map((i) => [i.variantId, i.quantity, i.lineTotal]).sort(), [["erp-po-var-a", 3, 360_000], ["erp-po-var-b", 2, 125_000]].sort());
      const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "ORDER_MANUAL_CREATE"), eq(schema.auditLogs.entityId, created.id)));
      assert.equal(logs.length, 1, "tạo đơn để lại một dòng nhật ký");

      // Đơn hiện trong truy vấn của /orders (cùng tham số mặc định của trang).
      const params = parseListParams({}, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "carrier", "seller", "payment", "tag", "address", "fulfillment"], sortable: ORDER_SORTABLE, defaultPeriod: "30d" });
      assert.ok((await listOrders(params)).rows.some((r) => r.id === created.id), "đơn tay hiện ở danh sách /orders");

      // Kết quả đơn NHƯ LUẬT HIỆN TẠI: không vận đơn ⇒ NOT_SHIPPED (không bao giờ DELIVERED).
      assert.equal(await outcomeOf(created.id), "NOT_SHIPPED");
      // Tồn THỰC TẾ không đổi (luật 10): tạo đơn không ghi phiếu kho nào.
      assert.equal(await stockOf("erp-po-var-a"), 10, "tạo đơn KHÔNG trừ tồn thực tế");
      assert.equal(Number((await db.select({ n: sql<number>`count(*)` }).from(schema.stockReceipts))[0].n), 1, "không phiếu kho mới");
      // Lối "Lập phiếu xuất kho": điền sẵn đúng mẫu mã + số lượng của đơn.
      const pre = await manualOrderIssuePrefill(created.id);
      assert.deepEqual(pre?.qty, { "erp-po-var-a": 3, "erp-po-var-b": 2 });
      assert.equal(pre?.customerName, "Đại lý Pilot");
      assert.ok(issueReceiptHref(created.id).startsWith("/inventory/receipts?xuat-don="));

      // Sửa: thay dòng hàng, đổi trạng thái; nhật ký kèm trước / sau.
      const upd = await updateManualOrderCore(admin, created.id, { ...input, stage: "NEW", lines: [{ variantId: "erp-po-var-a", quantity: 4, unitPrice: 120_000, discount: 0 }] });
      assert.ok(upd.ok, JSON.stringify(upd));
      const row2 = await db.query.orders.findFirst({ where: eq(schema.orders.id, created.id) });
      assert.deepEqual([row2?.stage, row2?.totalPriceAfterDiscount, row2?.itemsCount], ["NEW", 470_000, 1]);
      assert.equal((await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, created.id))).length, 1, "dòng hàng thay nguyên bộ");
      assert.equal(await stockOf("erp-po-var-a"), 10, "sửa đơn KHÔNG đổi tồn thực tế");

      // Đơn ĐỒNG BỘ (id không `erp-`) KHÔNG sửa / huỷ được — kể cả ở tổ chức không Pancake.
      await db.insert(schema.orders).values({ id: "88001234", stage: "CONFIRMED", status: 1, billFullName: "Đơn nhập khác", insertedAt: new Date() });
      assert.equal(codeOf(await updateManualOrderCore(admin, "88001234", input)), "NOT_SUPPORTED");
      assert.equal(codeOf(await cancelManualOrderCore(admin, "88001234", { reason: "thử huỷ" })), "NOT_SUPPORTED");
      assert.equal(await manualOrderIssuePrefill("88001234"), null);

      // KPI chỉ số sổ trên trang của tổ chức: nhãn GỐC, tên trang đặt chỉ là tên phụ (P1 #8).
      const kpi = { id: "k1", type: "kpi", span: 4, config: { metric: "booked_revenue", period: "30d", label: "Công nợ phải thu" } } as unknown as PageBlock<"kpi">;
      const res = await resolveBlock(kpi, admin, { searchParams: {}, period: "30d" });
      assert.ok(res.ok, JSON.stringify(res));
      const d = (res as { ok: true; data: { label: string; customLabel?: string; labelLocked?: boolean } }).data;
      assert.deepEqual([d.label, d.customLabel, d.labelLocked], ["Doanh thu lên đơn", "Công nợ phải thu", true], "AI / trang không đổi được nghĩa con số bằng nhãn");

      // P1 #7 ở cửa CSDL (`validateRuleInput`): luật "khi tạo khách" bằng custom_record.* bị từ chối kèm gợi ý.
      const rule = await validateRuleInput({ key: "khach_moi", name: "Khách mới", trigger: { kind: "event", event: "custom_record.created", objectKey: "customer" }, actions: [{ kind: "notify", message: "Có khách mới" }] });
      assert.ok(!rule.ok && rule.errors.some((e) => e.field === "trigger.objectKey" && /custom_status/.test(e.message)), "luật không bao giờ chạy bị chặn lúc lưu");

      // Huỷ: bắt buộc lý do; ORDER_OUTCOME ⇒ CANCELLED; huỷ lần hai không ghi thêm (mục 61).
      assert.ok(fieldsOf(await cancelManualOrderCore(admin, created.id, { reason: "" })).includes("reason"));
      assert.ok((await cancelManualOrderCore(admin, created.id, { reason: "Khách đổi ý" })).ok);
      assert.equal(await outcomeOf(created.id), "CANCELLED");
      assert.equal(codeOf(await cancelManualOrderCore(admin, created.id, { reason: "bấm lại" })), "CONFLICT", "đơn đã huỷ: không huỷ lại");
      assert.equal(codeOf(await updateManualOrderCore(admin, created.id, input)), "CONFLICT", "đơn đã huỷ: không sửa");
      assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "ORDER_MANUAL_CANCEL"), eq(schema.auditLogs.entityId, created.id)))).length, 1, "một lượt huỷ ⇒ đúng một dòng nhật ký");
      assert.equal(await stockOf("erp-po-var-a"), 10, "huỷ đơn KHÔNG đổi tồn thực tế");
      assert.equal(await manualOrderIssuePrefill(created.id), null, "đơn đã huỷ: không mời xuất kho");
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testPilotOrders() {
  testPure();
  await testHome();
  await testWholesaleOrg();
  console.log("  ✓ pilot đơn tay: tạo / sửa / huỷ ở tổ chức không Pancake (erp-, orders:write, nhật ký, /orders), ORDER_OUTCOME + tồn thực tế không đổi, nhà từ chối + marketer 3.9 không đổi; luật custom_record trên đối tượng hệ thống bị chặn; nhãn KPI sổ cố định, COD chỉ khi có kết nối; số tiền duyệt ưu tiên field tuỳ biến; vai trò AI không mang quyền ngoài gói");
}

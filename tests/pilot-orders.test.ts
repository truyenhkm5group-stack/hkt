/**
 * ═══════════ PILOT BÁN BUÔN — ĐƠN HÀNG TẠO TAY (P0 #3) + LUẬT / KPI / DUYỆT / VAI TRÒ (P1 #7 #8 · P2 #17 #18) ═══════════
 *
 * Tổ chức THẬT `po-si` (mẫu bán buôn, KHÔNG bật Pancake; tự cấp, tự dọn):
 *  · tạo đơn tay có dòng hàng ⇒ id `erp-`, lời khai gốc ERP_MANUAL, nhật ký, hiện trong truy vấn /orders;
 *  · kết quả đơn theo ORDER_OUTCOME NHƯ LUẬT HIỆN TẠI (không vận đơn ⇒ NOT_SHIPPED, huỷ ⇒ CANCELLED — không bao giờ DELIVERED);
 *  · tồn THỰC TẾ không đổi khi tạo / sửa / huỷ đơn (luật 10);
 *  · G-ORDER: xác nhận giao bằng phiếu có ký nhận ⇒ DELIVERED, tồn thực tế giảm ĐÚNG MỘT lần, khả dụng không trừ hai lần
 *    (đo lại ca P1: 150 → giao 35 ⇒ thực tế 115, khả dụng 115), tiền KHÔNG đổi (UNVERIFIED, doanh thu giao 0 ₫); huỷ
 *    phiếu có lý do ⇒ như chưa giao; đơn NEW / huỷ / đồng bộ bị từ chối;
 *  · thiếu `orders:write` ⇒ FORBIDDEN; sửa đơn đồng bộ (id không `erp-`) ⇒ NOT_SUPPORTED; huỷ hai lần không ghi thêm;
 *  · khối KPI chỉ số sổ giữ NHÃN GỐC, tên trang đặt chỉ là tên phụ (P1 #8).
 * Tổ chức NHÀ (bật Pancake): cổng đóng, action từ chối kể cả Quản trị; báo cáo danh nghĩa + hiệu quả QC theo marketer
 * KHÔNG đổi một đơn / một đồng khi CSDL có một đơn `erp-` đã xác nhận (luật 3.9 — đơn tay nằm ngoài phép so).
 * Phần thuần: phép tính tiền, sổ đối tượng ↔ `SYNCED_SOURCE_MODULE`, quyền chỉ Quản trị, luật `custom_record.*` trên đối
 * tượng hệ thống bị từ chối ở cả ba cửa, thứ tự số tiền duyệt, chỉ số cần kết nối, vai trò AI mang quyền ngoài gói.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { buildSystemPrompt } from "@/lib/ai-builder/prompt";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS_ADDED_AFTER_SNAPSHOT } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import type { Blueprint } from "@/lib/blueprints/types";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { clearMemo } from "@/lib/cache";
import { canConfirmManualDelivery, isManualOrderId, manualOrderRaw, manualOrderTotals, MANUAL_ORDER_ID_PREFIX } from "@/lib/constants/manual-orders";
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
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { availableStockExpr, erpStockExpr, listReservedOrderLines, listVariantsForReceipt, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { orderKpis } from "@/lib/queries/dashboard";
import { getProfitReport } from "@/lib/queries/reports";
import { COUNT_DELIVERED, DELIVERED_REVENUE } from "@/lib/queries/metrics";
import { cancelManualOrderCore, confirmManualDeliveryCore, createManualOrderCore, manualOrderDeliveryView, manualOrderGate, updateManualOrderCore, voidManualDeliveryCore } from "@/lib/records/order-create";
import { recordManualPaymentCore, voidManualPaymentCore } from "@/lib/records/order-payments";
import { manualOrderPaymentView } from "@/lib/queries/order-payments";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
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
  return (await outcomesOf(orderId))?.outcome ?? null;
}

/** Kết quả đơn + kết quả theo tiền + hai tổng của lớp chỉ số (doanh thu giao / số đơn giao) cho MỘT đơn. */
async function outcomesOf(orderId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ outcome: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED, deliveredRevenue: DELIVERED_REVENUE, deliveredCount: COUNT_DELIVERED })
    .from(schema.orders)
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT))
    .where(eq(schema.orders.id, orderId))
    .groupBy(schema.orders.id, schema.shipments.id);
  return r ? { outcome: r.outcome, verified: r.verified, deliveredRevenue: Number(r.deliveredRevenue), deliveredCount: Number(r.deliveredCount) } : null;
}

/** Tồn THỰC TẾ và tồn KHẢ DỤNG của một mẫu mã — đúng hai biểu thức của sổ kho (luật 10). */
async function stockOfVariant(variantId: string): Promise<{ actual: number; available: number }> {
  const db = await getDb();
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const [r] = await db
    .select({ actual: erpStockExpr(sales, receipts), available: availableStockExpr(sales, receipts) })
    .from(schema.productVariants)
    .leftJoin(sales, eq(sales.variantId, schema.productVariants.id))
    .leftJoin(receipts, eq(receipts.variantId, schema.productVariants.id))
    .where(eq(schema.productVariants.id, variantId));
  return { actual: Number(r?.actual ?? 0), available: Number(r?.available ?? 0) };
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
  assert.equal(codeOf(await confirmManualDeliveryCore(admin, "erp-x", { signedAt: new Date().toISOString(), receiverName: "Khách" })), "NOT_SUPPORTED", "G-ORDER: nhà đồng bộ đơn từ Pancake ⇒ không xác nhận giao tay, kể cả Quản trị");
  assert.equal(codeOf(await voidManualDeliveryCore(admin, "erp-x", { reason: "thử huỷ" })), "NOT_SUPPORTED");
  assert.equal(codeOf(await recordManualPaymentCore(admin, "erp-x", { kind: "RECEIPT", method: "CASH", amount: 100_000, paidAt: new Date().toISOString() })), "NOT_SUPPORTED", "0181: nhà đồng bộ đơn từ Pancake ⇒ không ghi chứng từ thanh toán tay, kể cả Quản trị");
  assert.equal(codeOf(await voidManualPaymentCore(admin, "erp-x", { paymentId: "x", reason: "thử huỷ" })), "NOT_SUPPORTED");
  assert.equal(await count(), n0, "bị từ chối ⇒ 0 đơn mới");
  // Nút tạo đơn trên /orders đi qua CÙNG cổng; trang /orders/new 404 khi cổng đóng.
  assert.match(readFileSync("app/(dashboard)/orders/page.tsx", "utf8"), /createGate\.allowed \? \(/);
  assert.match(readFileSync("app/(dashboard)/orders/new/page.tsx", "utf8"), /if \(!gate\.allowed\) notFound\(\)/);

  // Luật 3.9: một đơn `erp-` ĐÃ XÁC NHẬN và một đơn `erp-` ĐÃ GIAO (phiếu ký nhận — G-ORDER) nằm trong CSDL nhà ⇒ báo cáo
  // danh nghĩa + hiệu quả QC theo marketer KHÔNG đổi; doanh thu giao thành công / lợi nhuận KHÔNG đổi một đồng.
  clearMemo();
  const before = await getNominalProfitReport(ALL);
  const perfBefore = await getAdsPerformance(ALL);
  const profitBefore = (await getProfitReport(ALL, "created")).current;
  const kpiBefore = await orderKpis(null, null);
  const oid = "erp-po-home-fixture";
  await db.insert(schema.products).values({ id: "po-home-prod", name: "PO mã tay (fixture)" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: "po-home-var", productId: "po-home-prod", sku: "PO-HOME-1", retailPrice: 300_000 }).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: oid, stage: "CONFIRMED", status: 1, statusName: "Đã xác nhận", billFullName: "Khách tay", totalPrice: 300_000, totalPriceAfterDiscount: 300_000, insertedAt: new Date(), raw: { origin: "ERP_MANUAL", orderDiscount: 0, createdBy: null } });
  await db.insert(schema.orderItems).values({ id: `${oid}-1`, orderId: oid, variantId: "po-home-var", productId: "po-home-prod", productName: "PO mã tay (fixture)", sku: "PO-HOME-1", quantity: 1, unitPrice: 300_000, lineTotal: 300_000 });
  const oidGiao = "erp-po-home-delivered";
  await db.insert(schema.orders).values({ id: oidGiao, stage: "DELIVERED", status: 3, statusName: "Đã nhận", billFullName: "Khách tay", totalPrice: 450_000, totalPriceAfterDiscount: 450_000, insertedAt: new Date(), raw: { origin: "ERP_MANUAL", orderDiscount: 0, createdBy: null } });
  await db.insert(schema.orderItems).values({ id: `${oidGiao}-1`, orderId: oidGiao, variantId: "po-home-var", productId: "po-home-prod", productName: "PO mã tay (fixture)", sku: "PO-HOME-1", quantity: 1, unitPrice: 450_000, lineTotal: 450_000 });
  await db.insert(schema.orderDeliveryNotes).values({ orderId: oidGiao, signedAt: new Date(), receiverName: "Khách tay" });
  // 0181: đơn tay ĐÃ THU ĐỦ theo chứng từ (lọt vào CSDL nhà — thực tế action từ chối) — các báo cáo theo DELIVERED vẫn không đổi.
  await db.insert(schema.orderPayments).values({ orderId: oidGiao, kind: "RECEIPT", method: "CASH", amount: 450_000, paidAt: new Date() });
  // Đơn Pancake không bao giờ mang được chứng từ tay (CHECK ở CSDL) ⇒ số của nhà không thể đổi vì bảng này.
  await assert.rejects(async () => {
    await db.insert(schema.orderPayments).values({ orderId: "88990000", kind: "RECEIPT", method: "CASH", amount: 1, paidAt: new Date() });
  }, "đơn không `erp-` không nhận chứng từ thanh toán tay");
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
    assert.equal(await outcomeOf(oidGiao), "DELIVERED", "phiếu giao ⇒ DELIVERED (logistics) — kể cả khi dòng lọt vào CSDL nhà");
    const profitAfter = (await getProfitReport(ALL, "created")).current;
    const kpiAfter = await orderKpis(null, null);
    assert.equal(profitAfter.revenue, profitBefore.revenue, "G-ORDER: báo cáo lợi nhuận — doanh thu giao thành công KHÔNG cộng đơn tay giao bằng phiếu");
    assert.equal(profitAfter.cogs, profitBefore.cogs, "giá vốn đi cùng doanh thu — không ghi cho đơn tay chưa có chứng từ tiền");
    assert.equal(kpiAfter.successRevenue, kpiBefore.successRevenue, "Tổng quan: doanh thu giao thành công không đổi");
    assert.equal(kpiAfter.successOrders, kpiBefore.successOrders + 1, "…nhưng SỐ ĐƠN giao thành công có thêm đơn tay (chiều logistics)");
    assert.equal((await outcomesOf(oidGiao))?.verified, "DELIVERED", "0181: đơn tay giao + thu đủ theo chứng từ ⇒ tiền đã xác minh");
  } finally {
    await db.delete(schema.orders).where(eq(schema.orders.id, oidGiao));
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
      assert.deepEqual([row.stage, row.status, row.customerId, row.billFullName, row.shipProvince, row.source], ["CONFIRMED", 1, c.id, "Đại lý Pilot", "Thành phố Hà Nội", "Gọi điện"], "tỉnh ghi theo tên chuẩn của địa giới mới (05/10/2026)");
      assert.deepEqual([row.totalPrice, row.totalDiscount, row.totalPriceAfterDiscount, row.shippingFee, row.totalQuantity, row.itemsCount], [490_000, 15_000, 475_000, 30_000, 5, 2]);
      assert.equal(row.customerPayFee, true, "phí ship của đơn tay là tiền khách trả — trang đơn in dòng «Phí ship thu của khách» theo cờ này");
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
      assert.equal(codeOf(await confirmManualDeliveryCore(admin, created.id, { signedAt: new Date().toISOString(), receiverName: "Đại lý" })), "CONFLICT", "đơn đã huỷ: không xác nhận giao");

      const deliveredId = await testDeliveryFlow(db, { admin, sales, customerId: c.id, orderInput: input });
      await testPaymentFlow(db, { admin, sales, customerId: c.id, orderInput: input, deliveredId, cancelledId: created.id });
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

/**
 * ═══ G-ORDER — XÁC NHẬN GIAO BẰNG PHIẾU CÓ KÝ NHẬN (ORDER_OUTCOME.md mục 11), ĐO LẠI ĐÚNG CA P1 ĐÃ BÁO ═══
 *
 * Ca nợ P1 của pilot: tồn thực tế 150, đơn tay đã xác nhận 35 cái, kho lập phiếu XUẤT TAY 35 ⇒ thực tế 115 nhưng khả
 * dụng 80 (trừ hai lần: phiếu xuất + đơn còn giữ hàng). Nay: xác nhận giao (không phiếu xuất) ⇒ thực tế 115, khả dụng
 * 115 — hàng rời kho ĐÚNG MỘT lần, và thôi bị giữ. Tiền KHÔNG đổi: doanh thu giao thành công vẫn 0, tiền UNVERIFIED.
 */
async function testDeliveryFlow(db: Awaited<ReturnType<typeof getDb>>, ctx: { admin: SessionUser; sales: SessionUser; customerId: string; orderInput: Record<string, unknown> }): Promise<string> {
  const { admin, sales } = ctx;
  await db.insert(schema.productVariants).values({ id: "erp-po-var-c", productId: "erp-po-prod", sku: "NS-6", size: "6 chai", retailPrice: 40_000 });
  const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-150", totalQuantity: 150, createdBy: "kho@po.local" }).returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: "erp-po-var-c", quantity: 150, unitCost: 25_000 });
  const receiptCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.stockReceipts))[0].n);
  const receipts0 = await receiptCount();
  assert.deepEqual(await stockOfVariant("erp-po-var-c"), { actual: 150, available: 150 });

  const lines = [{ variantId: "erp-po-var-c", quantity: 35, unitPrice: 40_000, discount: 0 }];
  const neu = await createManualOrderCore(admin, { ...ctx.orderInput, customerId: ctx.customerId, stage: "NEW", orderDiscount: 0, shippingFee: 0, lines });
  assert.ok(neu.ok, JSON.stringify(neu));
  const note = { signedAt: new Date(Date.now() - 3_600_000).toISOString(), receiverName: "Anh Tuấn (thủ kho đại lý)", note: "Phiếu PG-001" };
  // Đơn NEW / WAITING chưa chốt ⇒ KHÔNG xác nhận giao được, 0 dòng phiếu.
  assert.equal(codeOf(await confirmManualDeliveryCore(admin, neu.id, note)), "CONFLICT", "đơn «Mới» không xác nhận giao được — chốt đơn trước");
  assert.equal(canConfirmManualDelivery("WAITING"), false);
  assert.equal(canConfirmManualDelivery("CANCELLED"), false);
  assert.equal((await db.select().from(schema.orderDeliveryNotes).where(eq(schema.orderDeliveryNotes.orderId, neu.id))).length, 0);

  const upd = await updateManualOrderCore(admin, neu.id, { ...ctx.orderInput, customerId: ctx.customerId, stage: "CONFIRMED", orderDiscount: 0, shippingFee: 0, lines });
  assert.ok(upd.ok, JSON.stringify(upd));
  const id = neu.id;
  assert.deepEqual(await stockOfVariant("erp-po-var-c"), { actual: 150, available: 115 }, "đã xác nhận: thực tế 150, khả dụng giữ 35");

  // Tiền TRƯỚC khi giao — để so sau.
  clearMemo();
  const kpi0 = await orderKpis(null, null);

  // Quyền + đầu vào: thiếu orders:write ⇒ FORBIDDEN; thiếu tên / mốc tương lai ⇒ lỗi đúng ô; 0 ghi.
  assert.equal(codeOf(await confirmManualDeliveryCore(sales, id, note)), "FORBIDDEN");
  assert.ok(fieldsOf(await confirmManualDeliveryCore(admin, id, { ...note, receiverName: "  " })).includes("receiverName"));
  assert.ok(fieldsOf(await confirmManualDeliveryCore(admin, id, { ...note, signedAt: "hôm qua" })).includes("signedAt"));
  assert.ok(fieldsOf(await confirmManualDeliveryCore(admin, id, { ...note, signedAt: new Date(Date.now() + 86_400_000).toISOString() })).includes("signedAt"), "mốc ký ở tương lai bị từ chối");
  assert.equal((await db.select().from(schema.orderDeliveryNotes).where(eq(schema.orderDeliveryNotes.orderId, id))).length, 0, "mọi lượt bị từ chối ⇒ 0 phiếu");
  // Đơn đồng bộ (id số) không nhận phiếu giao tay.
  assert.equal(codeOf(await confirmManualDeliveryCore(admin, "88001234", note)), "NOT_SUPPORTED");

  // XÁC NHẬN GIAO.
  const ok = await confirmManualDeliveryCore(admin, id, note);
  assert.ok(ok.ok, JSON.stringify(ok));
  const row = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
  assert.deepEqual([row?.stage, row?.status], ["DELIVERED", 3], "stage ⇒ DELIVERED («Đã nhận»)");
  const o1 = await outcomesOf(id);
  assert.equal(o1?.outcome, "DELIVERED", "ORDER_OUTCOME: phiếu giao có ký nhận ⇒ GIAO THÀNH CÔNG");
  assert.equal(o1?.verified, "UNVERIFIED", "tiền: CHƯA XÁC MINH — phiếu giao không phải chứng từ thanh toán");
  assert.equal(o1?.deliveredCount, 1, "đếm vào số đơn giao thành công (logistics)");
  assert.equal(o1?.deliveredRevenue, 0, "KHÔNG vào doanh thu giao thành công (tiền)");
  assert.deepEqual(await stockOfVariant("erp-po-var-c"), { actual: 115, available: 115 }, "CA P1: thực tế 150 → xuất 35 ⇒ 115; khả dụng 115 — KHÔNG trừ hai lần");
  assert.equal((await listReservedOrderLines({ variantId: "erp-po-var-c" })).lines.length, 0, "đơn đã giao không còn trong danh sách chờ xuất");
  assert.equal(await receiptCount(), receipts0, "xác nhận giao KHÔNG lập phiếu kho nào (không phiếu XUẤT TAY)");
  const view = await manualOrderDeliveryView(id);
  assert.deepEqual([view.active?.receiverName, view.active?.recordedByName, view.voided.length, view.priorIssues.length], ["Anh Tuấn (thủ kho đại lý)", "QT bán buôn", 0, 0]);
  const [phieu] = await db.select().from(schema.orderDeliveryNotes).where(eq(schema.orderDeliveryNotes.orderId, id));
  assert.equal(phieu.recordedByUserId, admin.id, "người ghi đi bằng KHOÁ tài khoản (AGENTS 34)");
  clearMemo();
  const kpi1 = await orderKpis(null, null);
  assert.equal(kpi1.successRevenue, kpi0.successRevenue, "Tổng quan: doanh thu giao thành công KHÔNG tăng vì phiếu giao");
  assert.equal(kpi1.successCogs, kpi0.successCogs, "giá vốn đi cùng doanh thu — không tăng");
  assert.equal(kpi1.successOrders, kpi0.successOrders + 1, "số đơn giao thành công tăng 1");
  const profit = (await getProfitReport(ALL, "created")).current;
  assert.equal(profit.revenue, 0, "báo cáo lợi nhuận: doanh thu 0 ₫ — chưa có chứng từ thanh toán nào");

  // Đơn đã giao: không giao lại, không sửa, không huỷ; bấm hai lần không ghi thêm.
  assert.equal(codeOf(await confirmManualDeliveryCore(admin, id, note)), "CONFLICT", "bấm hai lần ⇒ không phiếu thứ hai");
  assert.equal(codeOf(await updateManualOrderCore(admin, id, { ...ctx.orderInput, customerId: ctx.customerId, stage: "CONFIRMED", orderDiscount: 0, shippingFee: 0, lines })), "CONFLICT");
  assert.equal(codeOf(await cancelManualOrderCore(admin, id, { reason: "thử huỷ đơn đã giao" })), "CONFLICT");
  assert.equal((await db.select().from(schema.orderDeliveryNotes).where(eq(schema.orderDeliveryNotes.orderId, id))).length, 1);
  assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "ORDER_MANUAL_DELIVER"), eq(schema.auditLogs.entityId, id)))).length, 1, "một lượt giao ⇒ một dòng nhật ký");

  // HUỶ PHIẾU (ghi nhầm): bắt buộc lý do; phiếu giữ làm vết; đơn về như chưa giao.
  assert.equal(codeOf(await voidManualDeliveryCore(sales, id, { reason: "ghi nhầm" })), "FORBIDDEN");
  assert.ok(fieldsOf(await voidManualDeliveryCore(admin, id, { reason: "" })).includes("reason"));
  assert.ok((await voidManualDeliveryCore(admin, id, { reason: "Ghi nhầm — phiếu của đơn khác" })).ok);
  const o2 = await outcomesOf(id);
  assert.equal(o2?.outcome, "NOT_SHIPPED", "huỷ phiếu ⇒ quay về như chưa giao");
  assert.equal((await db.query.orders.findFirst({ where: eq(schema.orders.id, id) }))?.stage, "CONFIRMED");
  assert.deepEqual(await stockOfVariant("erp-po-var-c"), { actual: 150, available: 115 }, "huỷ phiếu ⇒ hàng về lại kho, lại bị giữ");
  assert.equal(codeOf(await voidManualDeliveryCore(admin, id, { reason: "bấm lại" })), "CONFLICT", "huỷ lần hai không ghi gì");
  const all = await db.select().from(schema.orderDeliveryNotes).where(eq(schema.orderDeliveryNotes.orderId, id));
  assert.deepEqual([all.length, all[0].voidReason, all[0].voidedByUserId], [1, "Ghi nhầm — phiếu của đơn khác", admin.id], "không xoá cứng: phiếu còn, mang lý do + khoá người huỷ");
  assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "ORDER_MANUAL_DELIVERY_VOID"), eq(schema.auditLogs.entityId, id)))).length, 1);

  // Phiếu XUẤT TAY cũ (bản trước có lối tắt điền `reference` = id đơn) ⇒ trang đơn nêu ra; ERP KHÔNG tự sửa kho.
  await db.insert(schema.stockReceipts).values({ kind: "ISSUE", receivedAt: new Date(), reference: id, totalQuantity: -35, createdBy: "kho@po.local" });
  assert.deepEqual((await manualOrderDeliveryView(id)).priorIssues.map((r) => r.totalQuantity), [35], "phiếu xuất cũ của đơn được nêu để kho lập điều chỉnh");
  const ok2 = await confirmManualDeliveryCore(admin, id, { ...note, receiverName: "Anh Tuấn" });
  assert.ok(ok2.ok, "giao lại sau khi huỷ phiếu nhầm: được (một phiếu còn hiệu lực)");
  assert.equal((await db.select().from(schema.orderDeliveryNotes).where(and(eq(schema.orderDeliveryNotes.orderId, id), isNull(schema.orderDeliveryNotes.voidedAt)))).length, 1);
  assert.equal(await receiptCount(), receipts0 + 1, "chỉ có phiếu xuất do bài kiểm gieo — xác nhận giao không tự lập hay tự sửa phiếu nào");

  // Lối "Lập phiếu xuất kho" cho đơn tay đã bỏ khỏi trang đơn và trang phiếu kho — không bao giờ trừ hai lần.
  const trangDon = readFileSync("app/(dashboard)/orders/[id]/page.tsx", "utf8");
  assert.ok(!trangDon.includes("issueReceiptHref") && !trangDon.includes(">Lập phiếu xuất kho<") && trangDon.includes("ConfirmManualDeliveryButton"), "trang đơn tay: nút xác nhận giao thay cho lối xuất tay");
  assert.ok(!readFileSync("app/(dashboard)/inventory/receipts/page.tsx", "utf8").includes("manualOrderIssuePrefill"));
  return id;
}

/**
 * ═══ CHỨNG TỪ THANH TOÁN CỦA ĐƠN TAY (0181 — ORDER_OUTCOME.md mục 11.1) ═══
 *
 * Đơn `deliveredId` đã giao bằng phiếu ký nhận: 35 × 40.000 = 1.400.000 ₫, không phí ship. Tiền đi theo chứng từ, không
 * theo phiếu giao: chưa có chứng từ ⇒ UNPAID / UNVERIFIED; thu một phần ⇒ PARTIALLY_PAID; thu đủ ⇒ PAID + tiền đã xác
 * minh; huỷ chứng từ ⇒ số đổi ngược lại; hoàn tiền trừ và không vượt số đã thu. Thực thu đơn tay vào đúng một chỉ số
 * (Chân lý tài chính → Tiền thực nhận, theo `paid_at`). Tồn kho và kết quả giao không đổi vì chứng từ tiền.
 */
async function testPaymentFlow(db: Awaited<ReturnType<typeof getDb>>, ctx: { admin: SessionUser; sales: SessionUser; customerId: string; orderInput: Record<string, unknown>; deliveredId: string; cancelledId: string }) {
  const { admin, sales, deliveredId: id } = ctx;
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
  const payCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.orderPayments))[0].n);
  const manualCash = async () => {
    clearMemo();
    return (await getFinancialTruth(ALL)).cash;
  };
  const stock0 = await stockOfVariant("erp-po-var-c");
  const view0 = await manualOrderPaymentView({ id, totalPriceAfterDiscount: 1_400_000, shippingFee: 0 });
  assert.deepEqual([view0?.state.status, view0?.state.amountDue, view0?.payments.length], ["UNPAID", 1_400_000, 0], "phiếu giao KHÔNG làm đơn thành PAID");
  assert.equal((await outcomesOf(id))?.verified, "UNVERIFIED");
  const cash0 = await manualCash();
  assert.equal(cash0.manualReceipts, 0);
  const n0 = await payCount();

  // Quyền, đơn đồng bộ, đầu vào sai ⇒ từ chối, 0 dòng.
  const receipt = { kind: "RECEIPT", method: "CASH", amount: 500_000, paidAt: at(30), reference: "PT-001", note: "Đại lý trả đợt 1" };
  assert.equal(codeOf(await recordManualPaymentCore(sales, id, receipt)), "FORBIDDEN", "thiếu orders:write ⇒ từ chối");
  assert.equal(codeOf(await recordManualPaymentCore(admin, "88001234", receipt)), "NOT_SUPPORTED", "đơn đồng bộ (id số) không nhận chứng từ tay");
  assert.ok(fieldsOf(await recordManualPaymentCore(admin, id, { ...receipt, amount: 0 })).includes("amount"));
  assert.ok(fieldsOf(await recordManualPaymentCore(admin, id, { ...receipt, method: "MOMO" })).includes("method"));
  assert.ok(fieldsOf(await recordManualPaymentCore(admin, id, { ...receipt, paidAt: new Date(Date.now() + 86_400_000).toISOString() })).includes("paidAt"), "mốc thanh toán ở tương lai bị từ chối");
  assert.ok(fieldsOf(await recordManualPaymentCore(admin, id, { ...receipt, kind: "REFUND" })).includes("amount"), "chưa thu đồng nào ⇒ không hoàn được");
  assert.equal(codeOf(await recordManualPaymentCore(admin, ctx.cancelledId, receipt)), "CONFLICT", "đơn đã huỷ không nhận tiền mới");
  assert.equal(await payCount(), n0, "mọi lượt bị từ chối ⇒ 0 chứng từ");

  // Thu một phần.
  const r1 = await recordManualPaymentCore(admin, id, receipt);
  assert.ok(r1.ok, JSON.stringify(r1));
  const [pt1] = await db.select().from(schema.orderPayments).where(eq(schema.orderPayments.id, r1.paymentId));
  assert.deepEqual([pt1.orderId, pt1.kind, pt1.method, pt1.amount, pt1.status, pt1.createdByUserId, pt1.reference], [id, "RECEIPT", "CASH", 500_000, "CONFIRMED", admin.id, "PT-001"], "người ghi đi bằng KHOÁ tài khoản (AGENTS 34)");
  let v = await manualOrderPaymentView({ id, totalPriceAfterDiscount: 1_400_000, shippingFee: 0 });
  assert.deepEqual([v?.state.status, v?.state.net, v?.state.outstanding], ["PARTIALLY_PAID", 500_000, 900_000]);
  assert.equal((await outcomesOf(id))?.verified, "UNVERIFIED", "thu một phần ⇒ tiền chưa xác minh đủ");
  assert.equal((await manualCash()).manualReceipts, 500_000, "Thực thu đơn tay = Σ chứng từ theo paid_at");

  // Thu đủ (chuyển khoản).
  const r2 = await recordManualPaymentCore(admin, id, { ...receipt, method: "BANK_TRANSFER", amount: 900_000, reference: "FT26273" });
  assert.ok(r2.ok, JSON.stringify(r2));
  v = await manualOrderPaymentView({ id, totalPriceAfterDiscount: 1_400_000, shippingFee: 0 });
  assert.deepEqual([v?.state.status, v?.state.net, v?.state.outstanding, v?.state.overpaid], ["PAID", 1_400_000, 0, 0]);
  const o = await outcomesOf(id);
  assert.deepEqual([o?.outcome, o?.verified], ["DELIVERED", "DELIVERED"], "giao + thu đủ theo chứng từ ⇒ tiền ĐÃ XÁC MINH; logistics không đổi");
  assert.equal(o?.deliveredRevenue, 0, "nợ P1 (pilot-readiness mục 4): doanh thu theo DELIVERED vẫn loại đơn tay — thực thu đọc ở Chân lý tài chính");
  const cash2 = await manualCash();
  assert.deepEqual([cash2.manualReceipts, cash2.manualReceiptDocs, cash2.total - cash0.total], [1_400_000, 2, 1_400_000], "Tiền thực nhận tăng đúng Σ chứng từ");
  const params = parseListParams({}, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "carrier", "seller", "payment", "tag", "address", "fulfillment"], sortable: ORDER_SORTABLE, defaultPeriod: "30d" });
  const listed = (await listOrders(params)).rows.find((r) => r.id === id);
  assert.equal(listed?.payment?.status, "PAID", "danh sách /orders: trạng thái thanh toán đơn tay theo chứng từ");
  assert.deepEqual(await stockOfVariant("erp-po-var-c"), stock0, "chứng từ tiền KHÔNG chạm tồn kho");

  // Huỷ chứng từ ghi nhầm: bắt buộc lý do; giữ vết; số đổi ngược lại; huỷ lần hai không ghi gì.
  assert.ok(fieldsOf(await voidManualPaymentCore(admin, id, { paymentId: r2.paymentId, reason: "" })).includes("reason"));
  assert.equal(codeOf(await voidManualPaymentCore(sales, id, { paymentId: r2.paymentId, reason: "ghi nhầm" })), "FORBIDDEN");
  assert.equal(codeOf(await voidManualPaymentCore(admin, ctx.cancelledId, { paymentId: r2.paymentId, reason: "sai đơn" })), "NOT_FOUND", "chứng từ của đơn khác ⇒ không tìm thấy");
  assert.ok((await voidManualPaymentCore(admin, id, { paymentId: r2.paymentId, reason: "Ghi nhầm số tiền" })).ok);
  assert.equal(codeOf(await voidManualPaymentCore(admin, id, { paymentId: r2.paymentId, reason: "bấm lại" })), "CONFLICT", "huỷ lần hai không ghi gì");
  const [pt2] = await db.select().from(schema.orderPayments).where(eq(schema.orderPayments.id, r2.paymentId));
  assert.deepEqual([pt2.status, pt2.voidReason, pt2.voidedByUserId], ["VOIDED", "Ghi nhầm số tiền", admin.id], "không xoá cứng: chứng từ còn, mang lý do + khoá người huỷ");
  v = await manualOrderPaymentView({ id, totalPriceAfterDiscount: 1_400_000, shippingFee: 0 });
  assert.deepEqual([v?.state.status, v?.state.net], ["PARTIALLY_PAID", 500_000], "chứng từ đã huỷ không vào phép tính");
  assert.equal((await outcomesOf(id))?.verified, "UNVERIFIED");
  assert.equal((await manualCash()).manualReceipts, 500_000);

  // Hoàn tiền: không vượt số đang thu ròng; hoàn hết ⇒ REFUNDED; huỷ phiếu THU khi đã hoàn ⇒ bị chặn.
  assert.ok(fieldsOf(await recordManualPaymentCore(admin, id, { ...receipt, kind: "REFUND", amount: 600_000 })).includes("amount"), "hoàn vượt số đã thu ⇒ từ chối");
  const r3 = await recordManualPaymentCore(admin, id, { ...receipt, kind: "REFUND", amount: 500_000, reference: "HT-01" });
  assert.ok(r3.ok, JSON.stringify(r3));
  v = await manualOrderPaymentView({ id, totalPriceAfterDiscount: 1_400_000, shippingFee: 0 });
  assert.deepEqual([v?.state.status, v?.state.net], ["REFUNDED", 0]);
  assert.equal(codeOf(await voidManualPaymentCore(admin, id, { paymentId: r1.paymentId, reason: "thử huỷ phiếu thu" })), "CONFLICT", "huỷ phiếu thu khi đã hoàn ⇒ số hoàn vượt số thu ⇒ chặn");
  assert.equal((await manualCash()).manualReceipts, 0, "thu 500K − hoàn 500K = 0 trong kỳ (phiếu 900K đã huỷ)");
  assert.equal((await outcomesOf(id))?.outcome, "DELIVERED", "hoàn tiền không ghi đè sự kiện logistics");

  // Đơn đã huỷ: chỉ nhận phiếu HOÀN (và chỉ khi đã thu).
  assert.ok(fieldsOf(await recordManualPaymentCore(admin, ctx.cancelledId, { ...receipt, kind: "REFUND" })).includes("amount"), "đơn huỷ chưa thu đồng nào ⇒ không có gì để hoàn");

  // Thu TRƯỚC khi giao là hợp lệ và KHÔNG làm đơn thành đã giao.
  const truoc = await createManualOrderCore(admin, { ...ctx.orderInput, customerId: ctx.customerId, stage: "CONFIRMED", orderDiscount: 0, shippingFee: 20_000, lines: [{ variantId: "erp-po-var-c", quantity: 1, unitPrice: 40_000, discount: 0 }] });
  assert.ok(truoc.ok, JSON.stringify(truoc));
  const r4 = await recordManualPaymentCore(admin, truoc.id, { ...receipt, method: "COD", amount: 60_000 });
  assert.ok(r4.ok, JSON.stringify(r4));
  assert.equal((await manualOrderPaymentView({ id: truoc.id, totalPriceAfterDiscount: 40_000, shippingFee: 20_000 }))?.state.status, "PAID", "số phải trả gồm phí ship khách trả (40K + 20K)");
  const ot = await outcomesOf(truoc.id);
  assert.deepEqual([ot?.outcome, ot?.verified], ["NOT_SHIPPED", "NOT_SHIPPED"], "thu đủ mà chưa có phiếu giao ⇒ CHƯA GIAO — tiền không suy ra giao hàng");

  const logs = async (action: string) => (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action))).length;
  assert.equal(await logs("ORDER_PAYMENT_RECORD"), 4, "mỗi chứng từ ghi được ⇒ một dòng nhật ký");
  assert.equal(await logs("ORDER_PAYMENT_VOID"), 1, "một lượt huỷ ⇒ một dòng nhật ký");
  const trangDon = readFileSync("app/(dashboard)/orders/[id]/page.tsx", "utf8");
  assert.ok(trangDon.includes("RecordManualPaymentButton") && trangDon.includes("manualOrderPaymentView"), "trang đơn tay có khối Thanh toán");
}

export async function testPilotOrders() {
  testPure();
  await testHome();
  await testWholesaleOrg();
  console.log("  ✓ pilot đơn tay: tạo / sửa / huỷ ở tổ chức không Pancake (erp-, orders:write, nhật ký, /orders), ORDER_OUTCOME + tồn thực tế không đổi; G-ORDER phiếu giao ký nhận ⇒ DELIVERED + trừ tồn một lần (150→115/115) + tiền UNVERIFIED + huỷ phiếu quay về; chứng từ thanh toán (0181) UNPAID→PARTIALLY_PAID→PAID→REFUNDED, huỷ có lý do, hoàn không vượt thu, thực thu theo paid_at; nhà từ chối + marketer 3.9 không đổi; luật custom_record trên đối tượng hệ thống bị chặn; nhãn KPI sổ cố định, COD chỉ khi có kết nối; số tiền duyệt ưu tiên field tuỳ biến; vai trò AI không mang quyền ngoài gói");
}

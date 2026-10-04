/**
 * ═══════════ ĐƠN TAY: GIAO KHÔNG THÀNH CÔNG · PHÍ GIAO ĐỒNG GIÁ · DOANH THU KHI ĐÃ GIAO (ORDER_OUTCOME.md mục 11.2 / 11.3) ═══════════
 *
 * Chủ shop HSLC chốt 03/10/2026 trên một tổ chức CHỈ CÓ ĐƠN TAY (không đồng bộ Pancake — `mo-hslc`, tự cấp, tự dọn):
 *  · «Giao không thành công» từ «Đã xác nhận» ⇒ «Đã hoàn», ORDER_OUTCOME = RETURNED, hàng QUAY LẠI TỒN NGAY (không phiếu kho);
 *    bắt buộc lý do, bấm hai lần không ghi thêm, đơn hoàn không sửa / huỷ được, hoàn tác ⇒ giữ hàng lại; đơn có phiếu giao
 *    phải huỷ phiếu trước.
 *  · Phí giao 40.000 ₫ mỗi đơn GIAO THÀNH CÔNG ⇒ `partner_fee` lúc xác nhận giao, về 0 khi huỷ phiếu; đơn hoàn 0 ₫; chưa khai
 *    ⇒ không ghi gì; quyền cấu hình + số hợp lệ.
 *  · Doanh thu + giá vốn đơn tay tính KHI ĐÃ GIAO (báo cáo lợi nhuận, Tổng quan, báo cáo danh nghĩa); tiền thật vẫn chỉ theo
 *    phiếu thu (UNVERIFIED tới khi thu đủ). Tổ chức đồng bộ Pancake giữ nguyên luật 3.9 — `tests/pilot-orders.test.ts`.
 *  · Trang tỷ lệ giao thành công: tham số mốc mặc định do trang truyền (không module vận chuyển ⇒ ngày lên đơn).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { canMarkManualDeliveryFailed, manualOrderComplete, parseManualDeliveryFee } from "@/lib/constants/manual-orders";
import { syncedOrderGroupText } from "@/lib/sales-chatbot/order-sync-shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { orderKpis } from "@/lib/queries/dashboard";
import { COUNT_DELIVERED, DELIVERED_REVENUE } from "@/lib/queries/metrics";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { getProfitReport } from "@/lib/queries/reports";
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { returnsPageParams, withDefaultReturnsBasis } from "@/lib/queries/returns-report-page";
import { availableStockExpr, erpStockExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import {
  cancelManualOrderCore,
  confirmManualDeliveryCore,
  createManualOrderCore,
  loadAutoConfirmComplete,
  loadManualDeliveryFee,
  saveAutoConfirmCompleteCore,
  markManualDeliveryFailedCore,
  saveManualDeliveryFeeCore,
  undoManualDeliveryFailedCore,
  updateManualOrderCore,
  voidManualDeliveryCore,
} from "@/lib/records/order-create";
import type { Period } from "@/lib/search-params";

const ORG = "mo-hslc";
const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };
const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);
const fieldsOf = (r: { ok: true } | { ok: false; errors: { field: string }[] }) => (r.ok ? [] : r.errors.map((e) => e.field));

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function outcomesOf(orderId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ outcome: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED, deliveredRevenue: DELIVERED_REVENUE, deliveredCount: COUNT_DELIVERED })
    .from(schema.orders)
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT))
    .where(eq(schema.orders.id, orderId))
    .groupBy(schema.orders.id, schema.shipments.id);
  return { outcome: r.outcome, verified: r.verified, deliveredRevenue: Number(r.deliveredRevenue), deliveredCount: Number(r.deliveredCount) };
}

async function stockOf(variantId: string): Promise<{ actual: number; available: number }> {
  const db = await getDb();
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const [r] = await db
    .select({ actual: erpStockExpr(sales, receipts), available: availableStockExpr(sales, receipts) })
    .from(schema.productVariants)
    .leftJoin(sales, eq(sales.variantId, schema.productVariants.id))
    .leftJoin(receipts, eq(receipts.variantId, schema.productVariants.id))
    .where(eq(schema.productVariants.id, variantId));
  return { actual: Number(r.actual), available: Number(r.available) };
}

function testPure() {
  assert.deepEqual([parseManualDeliveryFee(40_000), parseManualDeliveryFee("40000"), parseManualDeliveryFee(0)], [40_000, 40_000, 0]);
  assert.deepEqual([parseManualDeliveryFee(-1), parseManualDeliveryFee(1.5), parseManualDeliveryFee("abc"), parseManualDeliveryFee(null), parseManualDeliveryFee(""), parseManualDeliveryFee(20_000_000)], [null, null, null, null, null, null]);
  assert.deepEqual(["CONFIRMED", "NEW", "WAITING", "DELIVERED", "RETURNED", "CANCELLED"].map(canMarkManualDeliveryFailed), [true, false, false, false, false, false], "chỉ «Đã xác nhận» mới báo giao không thành công");
  // Đơn đủ thông tin (chủ shop HSLC 04/10/2026): SĐT 8–15 số · địa chỉ ≥ 5 ký tự · ≥ 1 dòng hàng.
  assert.equal(manualOrderComplete({ phone: "0912 345 678", address: "12 Hàng Bạc" }, 1), true);
  assert.deepEqual([manualOrderComplete({ phone: "", address: "12 Hàng Bạc" }, 1), manualOrderComplete({ phone: "0912345678", address: "HN" }, 1), manualOrderComplete({ phone: "0912345678", address: "12 Hàng Bạc" }, 0), manualOrderComplete({ phone: "1234", address: "12 Hàng Bạc" }, 1)], [false, false, false, false]);
  const gt = { code: "#A", name: "Lan", phone: "0912345678", address: "12 Hàng Bạc", province: "Hà Nội", lines: [{ name: "Chả cá", quantity: 1, unitPrice: 280_000, lineTotal: 280_000 }], subtotal: 280_000, shippingFee: 0, shipText: null, warnings: [] };
  assert.match(syncedOrderGroupText({ ...gt, confirmed: true }), /ĐÃ TÍNH ĐƠN[\s\S]*Đơn đã tính — sai thì sửa \/ huỷ trên ERP\.$/, "đơn tự xác nhận: tin nhóm không bảo «chốt đơn» nữa");
  assert.match(syncedOrderGroupText(gt), /chờ kiểm[\s\S]*Kiểm thông tin rồi chốt đơn trên ERP\.$/);
  assert.equal(returnsPageParams(withDefaultReturnsBasis({}, true)).basis, "SHIPPED", "có vận chuyển: mặc định cũ không đổi (tổ chức nhà, job giữ ấm)");
  assert.equal(returnsPageParams(withDefaultReturnsBasis({}, false)).basis, "ORDERED", "không module vận chuyển ⇒ ngày lên đơn");
  assert.equal(returnsPageParams(withDefaultReturnsBasis({ basis: "SHIPPED" }, false)).basis, "SHIPPED", "người dùng chọn mốc thì mốc đó thắng");
}

export async function testManualOrderOutcome() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản thử kết quả đơn", plan: "standard", modules: ["customers", "products", "orders", "inventory", "finance"], admin: { email: `admin@${ORG}.local`, name: "QT hải sản", password: "KetQua@12345" }, source: "TEST", actor: null });
  try {
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Hải sản thử kết quả đơn", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT hải sản", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org, modules: [...enabled] };
      const sales: SessionUser = { ...admin, role: "MANAGER", permissions: ["orders:read", "orders:write", "customers:view", "products:view"] };
      const [c] = await db.insert(schema.customers).values({ name: "Chị Lan", phone: "0912345678", address: "12 Hàng Bạc", province: "Hà Nội" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-mo-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL", unit: "kg" } });
      await db.insert(schema.productVariants).values({ id: "erp-mo-var", productId: "erp-mo-prod", sku: "CCT-1", size: "1kg", retailPrice: 280_000 });
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-MO", totalQuantity: 20, createdBy: u.email }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: "erp-mo-var", quantity: 20, unitCost: 150_000 });
      const receiptCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.stockReceipts))[0].n);
      const receipts0 = await receiptCount();
      const input = (qty: number) => ({ customerId: c.id, stage: "CONFIRMED", orderDiscount: 0, shippingFee: 0, lines: [{ variantId: "erp-mo-var", quantity: qty, unitPrice: 280_000, discount: 0 }] });

      // ── PHÍ GIAO ĐỒNG GIÁ ──
      assert.equal(await loadManualDeliveryFee(), null, "chưa khai ⇒ null, không đoán");
      assert.equal(codeOf(await saveManualDeliveryFeeCore(sales, 40_000)), "FORBIDDEN", "khai phí giao cần quyền cấu hình");
      assert.ok(fieldsOf(await saveManualDeliveryFeeCore(admin, -5)).includes("fee"));
      assert.ok((await saveManualDeliveryFeeCore(admin, 40_000)).ok);
      assert.equal(await loadManualDeliveryFee(), 40_000);

      // ── GIAO THÀNH CÔNG: doanh thu + giá vốn + phí giao ──
      const a = await createManualOrderCore(admin, input(2));
      assert.ok(a.ok, JSON.stringify(a));
      assert.deepEqual(await stockOf("erp-mo-var"), { actual: 20, available: 18 });
      clearMemo();
      const kpi0 = await orderKpis(null, null);
      const nominal0 = await getNominalProfitReport(ALL);
      assert.equal(nominal0.totals.ordersDistinct, 1, "báo cáo danh nghĩa: đơn tay ĐÃ XÁC NHẬN có mặt (tổ chức không đồng bộ đơn)");
      assert.equal(nominal0.totals.salesAfterDiscount, 560_000);
      assert.ok((await confirmManualDeliveryCore(admin, a.id, { signedAt: new Date(Date.now() - 60_000).toISOString(), receiverName: "Chị Lan" })).ok);
      const rowA = await db.query.orders.findFirst({ where: eq(schema.orders.id, a.id) });
      assert.equal(rowA?.partnerFee, 40_000, "xác nhận giao ⇒ cước 40.000 ₫ vào đơn");
      const oa = await outcomesOf(a.id);
      assert.deepEqual([oa.outcome, oa.verified, oa.deliveredCount, oa.deliveredRevenue], ["DELIVERED", "UNVERIFIED", 1, 560_000], "đã giao ⇒ doanh thu danh nghĩa 560.000 ₫; tiền thật vẫn chờ phiếu thu");
      clearMemo();
      const kpi1 = await orderKpis(null, null);
      assert.equal(kpi1.successRevenue - kpi0.successRevenue, 560_000, "Tổng quan: doanh thu giao thành công có đơn tay");
      assert.equal(kpi1.successCogs - kpi0.successCogs, 300_000, "giá vốn đi cùng doanh thu: 2 × 150.000 (phiếu nhập)");
      const profit = (await getProfitReport(ALL, "created")).current;
      assert.equal(profit.revenue, 560_000, "báo cáo lợi nhuận: doanh thu của đơn tay đã giao");
      // Huỷ phiếu giao ⇒ cước về 0, doanh thu rút ra.
      assert.ok((await voidManualDeliveryCore(admin, a.id, { reason: "Ghi nhầm đơn" })).ok);
      assert.equal((await db.query.orders.findFirst({ where: eq(schema.orders.id, a.id) }))?.partnerFee, 0, "huỷ phiếu giao ⇒ không còn phí giao");
      assert.equal((await outcomesOf(a.id)).deliveredRevenue, 0);

      // ── GIAO KHÔNG THÀNH CÔNG ──
      assert.deepEqual(await stockOf("erp-mo-var"), { actual: 20, available: 18 }, "đơn A lại ở «Đã xác nhận» — giữ 2");
      const neu = await createManualOrderCore(admin, { ...input(1), stage: "NEW" });
      assert.ok(neu.ok);
      assert.equal(codeOf(await markManualDeliveryFailedCore(admin, neu.id, { reason: "khách không nhận" })), "CONFLICT", "đơn «Mới» chưa chốt ⇒ không báo giao hỏng");
      assert.equal(codeOf(await markManualDeliveryFailedCore({ ...admin, permissions: ["orders:read"], role: "MANAGER" }, a.id, { reason: "khách không nhận" })), "FORBIDDEN");
      assert.ok(fieldsOf(await markManualDeliveryFailedCore(admin, a.id, { reason: "" })).includes("reason"), "bắt buộc lý do");
      assert.equal(codeOf(await markManualDeliveryFailedCore(admin, "88001234", { reason: "khách không nhận" })), "NOT_FOUND");
      assert.ok((await markManualDeliveryFailedCore(admin, a.id, { reason: "Khách không nghe máy, bưu tá trả về" })).ok);
      const rowF = await db.query.orders.findFirst({ where: eq(schema.orders.id, a.id) });
      assert.deepEqual([rowF?.stage, rowF?.status, rowF?.partnerFee], ["RETURNED", 5, 0], "«Đã hoàn», không phí giao");
      const of = await outcomesOf(a.id);
      assert.deepEqual([of.outcome, of.deliveredCount, of.deliveredRevenue], ["RETURNED", 0, 0], "ORDER_OUTCOME: giao không thành công ⇒ HOÀN");
      assert.deepEqual(await stockOf("erp-mo-var"), { actual: 20, available: 20 }, "hàng quay lại tồn NGAY (chủ shop chọn) — thôi giữ 2");
      assert.equal(await receiptCount(), receipts0, "không phiếu kho nào được tạo");
      assert.equal(codeOf(await markManualDeliveryFailedCore(admin, a.id, { reason: "bấm lại" })), "CONFLICT", "bấm hai lần ⇒ không ghi thêm");
      assert.equal(codeOf(await updateManualOrderCore(admin, a.id, input(2))), "CONFLICT", "đơn hoàn không sửa được");
      assert.equal(codeOf(await cancelManualOrderCore(admin, a.id, { reason: "thử huỷ" })), "CONFLICT", "đơn hoàn không huỷ được");
      assert.equal(codeOf(await confirmManualDeliveryCore(admin, a.id, { signedAt: new Date().toISOString(), receiverName: "X" })), "CONFLICT", "đơn hoàn không xác nhận giao được");
      const hist = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "ORDER_MANUAL_DELIVERY_FAILED"), eq(schema.auditLogs.entityId, a.id)));
      assert.deepEqual([hist.length, hist[0].reason], [1, "Khách không nghe máy, bưu tá trả về"], "một lượt ⇒ một dòng nhật ký, mang lý do");
      // Hoàn tác.
      assert.ok(fieldsOf(await undoManualDeliveryFailedCore(admin, a.id, { reason: "" })).includes("reason"));
      assert.ok((await undoManualDeliveryFailedCore(admin, a.id, { reason: "Ghi nhầm — khách đã nhận" })).ok);
      assert.equal((await db.query.orders.findFirst({ where: eq(schema.orders.id, a.id) }))?.stage, "CONFIRMED");
      assert.equal((await outcomesOf(a.id)).outcome, "NOT_SHIPPED");
      assert.deepEqual(await stockOf("erp-mo-var"), { actual: 20, available: 18 }, "hoàn tác ⇒ giữ hàng lại");
      assert.equal(codeOf(await undoManualDeliveryFailedCore(admin, a.id, { reason: "bấm lại" })), "CONFLICT", "hoàn tác hai lần không ghi gì");
      // Đơn có phiếu giao còn hiệu lực ⇒ phải huỷ phiếu trước.
      assert.ok((await confirmManualDeliveryCore(admin, a.id, { signedAt: new Date(Date.now() - 60_000).toISOString(), receiverName: "Chị Lan" })).ok);
      const r = await markManualDeliveryFailedCore(admin, a.id, { reason: "khách hoàn sau khi nhận" });
      assert.ok(!r.ok && r.code === "CONFLICT" && /huỷ phiếu giao/.test(r.errors[0].message), "đã có phiếu giao ⇒ hướng dẫn huỷ phiếu trước");

      // Phí giao xoá ⇒ đơn giao sau không mang phí (đơn đã giao giữ phí cũ).
      assert.ok((await saveManualDeliveryFeeCore(admin, null)).ok);
      assert.equal(await loadManualDeliveryFee(), null);
      const b = await createManualOrderCore(admin, input(1));
      assert.ok(b.ok);
      assert.ok((await confirmManualDeliveryCore(admin, b.id, { signedAt: new Date(Date.now() - 60_000).toISOString(), receiverName: "Chị Lan" })).ok);
      assert.equal((await db.query.orders.findFirst({ where: eq(schema.orders.id, b.id) }))?.partnerFee, 0, "chưa khai phí ⇒ không ghi gì");
      assert.equal((await db.query.orders.findFirst({ where: eq(schema.orders.id, a.id) }))?.partnerFee, 40_000, "đơn giao trước đó giữ phí cũ");

      // ── ĐƠN ĐỦ THÔNG TIN = ĐÃ XÁC NHẬN (chủ shop HSLC 04/10/2026) ──
      const stageOf = async (id: string) => (await db.query.orders.findFirst({ where: eq(schema.orders.id, id) }))?.stage;
      assert.equal(await loadAutoConfirmComplete(), false, "mặc định TẮT");
      const cu = await createManualOrderCore(admin, { ...input(1), stage: "NEW" });
      assert.ok(cu.ok);
      assert.equal(await stageOf(cu.id), "NEW", "công tắc tắt ⇒ đơn Mới vẫn Mới");
      // Khách thiếu địa chỉ ⇒ đơn thiếu thông tin; khách có hạn mức nợ 0 ⇒ xác nhận sẽ vượt hạn mức.
      const [noAddr] = await db.insert(schema.customers).values({ name: "Khách thiếu địa chỉ", phone: "0933000111", address: "" }).returning({ id: schema.customers.id });
      const thieu = await createManualOrderCore(admin, { ...input(1), customerId: noAddr.id, stage: "NEW" });
      assert.ok(thieu.ok);
      const [noCredit] = await db.insert(schema.customers).values({ name: "Đại lý hết hạn mức", phone: "0933000222", address: "5 Lê Lợi, Huế" }).returning({ id: schema.customers.id });
      await db.insert(schema.customerTradeTerms).values({ customerId: noCredit.id, creditLimit: 0 });
      const no = await createManualOrderCore(admin, { ...input(1), customerId: noCredit.id, stage: "NEW" });
      assert.ok(no.ok);
      const avail0 = (await stockOf("erp-mo-var")).available;
      clearMemo();
      const nominalBefore = (await getNominalProfitReport(ALL)).totals.ordersDistinct;
      assert.equal(codeOf(await saveAutoConfirmCompleteCore(sales, true)), "FORBIDDEN", "đổi cách tính đơn cần quyền cấu hình");
      const on = await saveAutoConfirmCompleteCore(admin, true);
      assert.ok(on.ok && on.enabled, JSON.stringify(on));
      assert.deepEqual([on.ok && on.promoted, on.ok && on.kept], [2, 2], "bật ⇒ 2 đơn Mới đủ thông tin (đơn «neu» của đoạn trước + cu) được xác nhận NGAY; thiếu địa chỉ + vượt hạn mức nợ giữ Mới");
      assert.deepEqual([await stageOf(neu.id), await stageOf(cu.id), await stageOf(thieu.id), await stageOf(no.id)], ["CONFIRMED", "CONFIRMED", "NEW", "NEW"]);
      assert.equal((await stockOf("erp-mo-var")).available, avail0 - 2, "đơn vừa tính giữ hàng ở kho như mọi đơn đã chốt");
      clearMemo();
      assert.equal((await getNominalProfitReport(ALL)).totals.ordersDistinct, nominalBefore + 2, "báo cáo danh nghĩa (nền của /ads) đếm đơn vừa tính");
      assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORDER_AUTO_CONFIRM_COMPLETE"))).length, 1);
      // Đơn MỚI tạo sau khi bật: đủ thông tin ⇒ thẳng «Đã xác nhận»; «Chờ hàng» là lựa chọn của người ⇒ giữ nguyên.
      const moi = await createManualOrderCore(admin, { ...input(1), stage: "NEW" });
      assert.ok(moi.ok);
      assert.equal(await stageOf(moi.id), "CONFIRMED", "đơn đủ SĐT · địa chỉ · hàng tính là đơn ngay");
      const cho = await createManualOrderCore(admin, { ...input(1), stage: "WAITING" });
      assert.ok(cho.ok);
      assert.equal(await stageOf(cho.id), "WAITING");
      // Sửa đơn thiếu thông tin cho đủ ⇒ tự xác nhận ở lượt sửa.
      assert.ok((await updateManualOrderCore(admin, thieu.id, { ...input(1), customerId: noAddr.id, stage: "NEW", recipient: { name: "Khách", phone: "0933000111", address: "9 Trần Phú, Đà Nẵng", province: "" } })).ok);
      assert.equal(await stageOf(thieu.id), "CONFIRMED");
      // Huỷ vẫn là huỷ.
      assert.ok((await cancelManualOrderCore(admin, moi.id, { reason: "khách huỷ" })).ok);
      assert.equal(await stageOf(moi.id), "CANCELLED");
      // Tắt ⇒ đơn Mới mới tạo lại phải xác nhận tay.
      assert.ok((await saveAutoConfirmCompleteCore(admin, false)).ok);
      const sau = await createManualOrderCore(admin, { ...input(1), stage: "NEW" });
      assert.ok(sau.ok);
      assert.equal(await stageOf(sau.id), "NEW");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ đơn tay: giao không thành công ⇒ HOÀN + hàng về tồn ngay + hoàn tác · phí giao đồng giá theo đơn giao thành công · doanh thu + giá vốn khi đã giao (tiền thật vẫn theo phiếu thu) · báo cáo danh nghĩa có đơn tay · mốc trang GTC theo module vận chuyển · đơn đủ thông tin = đã xác nhận (công tắc theo tổ chức, hạn mức nợ thắng, Chờ hàng giữ nguyên)");
}

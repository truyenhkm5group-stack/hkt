import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { VerifiedOutcome } from "@/lib/constants/data-quality";
import { dataQualityOrders, dataQualitySummary, returnsAwaitingWarehouse, unlinkedShipments } from "@/lib/queries/data-quality";
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED } from "@/lib/queries/return-rate";
import { markReturnReceived } from "@/lib/returns/warehouse";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/** Đọc cả hai cách xếp loại của cùng một đơn để so sánh legacy ↔ thực tế. */
async function outcomes(db: Db, id: string) {
  const [row] = await db
    .select({ legacy: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(eq(schema.orders.id, id));
  return row as { legacy: string; verified: VerifiedOutcome };
}

/** Dựng đơn + vận đơn riêng cho bộ kiểm thử này (fixture rr-* bị các khối trước sửa trạng thái). */
async function mk(db: Db, id: string, orderStage: (typeof schema.orders.$inferInsert)["stage"], ship?: Partial<typeof schema.shipments.$inferInsert>, order?: Partial<typeof schema.orders.$inferInsert>) {
  await db.insert(schema.orders).values({ id, systemId: Number(id.replace(/\D/g, "")) || null, stage: orderStage, status: 0, insertedAt: new Date(),
    cod: ship?.codAmount ?? 0, totalPriceAfterDiscount: 499000, ...order });
  await db.insert(schema.orderItems).values({ id: `${id}-i`, orderId: id, variantId: "dq-var", productId: "dq-prod", productName: "Áo kiểm thử DQ", sku: "DQ-001", quantity: 1, unitPrice: 499000, lineTotal: 499000 });
  if (ship) await db.insert(schema.shipments).values({ orderId: id, carrier: "Viettel Post", ...ship });
}

export async function testDataQuality(db: Db) {
  await db.insert(schema.products).values({ id: "dq-prod", name: "Áo kiểm thử DQ" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: "dq-var", productId: "dq-prod", sku: "DQ-001", color: "Xanh", size: "M", retailPrice: 499000 }).onConflictDoNothing();

  // ───────── 1. Quy tắc phân loại theo TIỀN THẬT ─────────

  // Viettel Post báo giao, COD khai báo 499K, nhưng KHÔNG có số thực thu nào.
  // Legacy tính là doanh thu; quy tắc thực tế phải nói "chưa xác minh", không được đoán.
  await mk(db, "dq-901", "DELIVERED", { stage: "DELIVERED", codAmount: 499000, shippingFee: 17000, vtpOrderNumber: "DQ901" });
  const declared = await outcomes(db, "dq-901");
  assert.equal(declared.legacy, "DELIVERED", "legacy vẫn tin trạng thái vận đơn");
  assert.equal(declared.verified, "UNVERIFIED", "VTP báo giao nhưng chưa có đồng thực thu nào → chưa xác minh");

  // COD đã thực thu 499K và đã về ngân hàng: tiền trao tay tại cửa → giao thành công thật,
  // dù trạng thái vận đơn vẫn là IN_TRANSIT.
  await mk(db, "dq-902", "SHIPPED", { stage: "IN_TRANSIT", codAmount: 499000, codCollected: 499000, codStatus: "PAID_TO_BANK", shippingFee: 17000, vtpOrderNumber: "DQ902" });
  assert.equal((await outcomes(db, "dq-902")).verified, "DELIVERED", "COD thực thu > 100K → giao thành công dù vận đơn chưa cập nhật");

  // Trần tiền dưới ngưỡng → kết luận CHẮC CHẮN, không cần số thực thu và không được coi là UNKNOWN.
  await mk(db, "dq-903", "DELIVERED", { stage: "DELIVERED", codAmount: 30000, shippingFee: 17000, vtpOrderNumber: "DQ903" });
  assert.equal((await outcomes(db, "dq-903")).verified, "RETURNED", "trần 30K < 50K → chắc chắn hoàn, không cần chờ xác minh");

  await mk(db, "dq-904", "DELIVERED", { stage: "DELIVERED", codAmount: 60000, shippingFee: 17000, vtpOrderNumber: "DQ904" });
  assert.equal((await outcomes(db, "dq-904")).verified, "RETURNED_BY_RULE", "trần 60K trong khoảng 50–100K → chắc chắn không thành công");

  await mk(db, "dq-905", "DELIVERED", { stage: "DELIVERED", codAmount: 0, shippingFee: 8501, vtpOrderNumber: "DQ905" });
  assert.equal((await outcomes(db, "dq-905")).verified, "RETURNED", "giao xong nhưng không có gì để thu → hoàn");

  // Đúng ranh giới 100K: bằng ngưỡng thì CHƯA phải giao thành công.
  await mk(db, "dq-906", "DELIVERED", { stage: "DELIVERED", codAmount: 100000, codCollected: 100000, codStatus: "COLLECTED", shippingFee: 17000, vtpOrderNumber: "DQ906" });
  assert.equal((await outcomes(db, "dq-906")).verified, "RETURNED_BY_RULE", "thu đúng 100K không vượt ngưỡng → chưa phải giao thành công");
  await mk(db, "dq-907", "DELIVERED", { stage: "DELIVERED", codAmount: 100001, codCollected: 100001, codStatus: "COLLECTED", shippingFee: 17000, vtpOrderNumber: "DQ907" });
  assert.equal((await outcomes(db, "dq-907")).verified, "DELIVERED", "thu 100.001đ vượt ngưỡng → giao thành công");

  // Huỷ / đang giao / đã hoàn.
  await mk(db, "dq-908", "SHIPPED", { stage: "IN_TRANSIT", codAmount: 499000, vtpOrderNumber: "DQ908" });
  assert.equal((await outcomes(db, "dq-908")).verified, "IN_TRANSIT");
  await mk(db, "dq-909", "CANCELLED");
  assert.equal((await outcomes(db, "dq-909")).verified, "CANCELLED");

  // ───────── 2. Đang giao / đã hoàn KHÔNG bị tiền ghi đè ─────────
  await db.insert(schema.orders).values({ id: "dq-prepaid-transit", systemId: 970001, stage: "SHIPPED", status: 0, insertedAt: new Date(), prepaid: 499000 });
  await db.insert(schema.shipments).values({ orderId: "dq-prepaid-transit", carrier: "Viettel Post", vtpOrderNumber: "DQ970001", stage: "IN_TRANSIT", codAmount: 0 });
  assert.equal((await outcomes(db, "dq-prepaid-transit")).verified, "IN_TRANSIT", "khách trả trước 499K nhưng hàng đang đi → vẫn là đang giao");

  await db.insert(schema.orders).values({ id: "dq-paid-returned", systemId: 970002, stage: "DELIVERED", status: 0, insertedAt: new Date(), cod: 499000 });
  await db.insert(schema.shipments).values({ orderId: "dq-paid-returned", carrier: "Viettel Post", vtpOrderNumber: "DQ970002", stage: "RETURNED", codAmount: 499000, codCollected: 499000, codStatus: "COLLECTED" });
  assert.equal((await outcomes(db, "dq-paid-returned")).verified, "RETURNED", "đã từng thu tiền nhưng vận đơn đã hoàn → vẫn là hoàn");

  // Pancake khai "đã thanh toán" mà không có vận đơn và không có tiền → chưa xác minh, KHÔNG phải doanh thu.
  await db.insert(schema.orders).values({ id: "dq-declared-only", systemId: 970003, stage: "PAID", status: 0, insertedAt: new Date(), cod: 499000, totalPriceAfterDiscount: 499000 });
  const declaredOnly = await outcomes(db, "dq-declared-only");
  assert.equal(declaredOnly.legacy, "DELIVERED", "legacy tin trạng thái Pancake");
  assert.equal(declaredOnly.verified, "UNVERIFIED", "Pancake khai suông không phải bằng chứng tiền");

  // ───────── 3. KPI tổng hợp + không bao giờ đổi UNKNOWN thành 0 ─────────
  const summary = await dataQualitySummary(ALL);
  assert.ok(summary.unverified >= 3, `phải phát hiện được các đơn chưa xác minh, đang có ${summary.unverified}`);
  assert.ok(summary.mismatch >= 2, "phải nêu được số đơn legacy và thực tế xếp khác nhau");
  assert.ok(summary.legacyRevenue > summary.verifiedRevenue, "doanh thu legacy phải cao hơn doanh thu có bằng chứng");
  assert.ok(summary.pancakeDeclared >= 1, "phải đếm được đơn Pancake khai suông");
  assert.equal(typeof summary.provenCash, "number");

  // Tỷ lệ là null khi chưa có mẫu số — giao diện hiện "—", tuyệt đối không hiện 0%.
  const empty = await dataQualitySummary({ key: "custom", from: new Date("1990-01-01"), to: new Date("1990-01-02"), label: "Kỳ rỗng", fromKey: "1990-01-01", toKey: "1990-01-02" });
  assert.equal(empty.successRate, null, "kỳ không có đơn → tỷ lệ là null, không phải 0");
  assert.equal(empty.delivered, 0);

  // ───────── 4. Drill-down trả đúng danh sách ─────────
  const unverifiedList = await dataQualityOrders("unverified", ALL, 1, 50, "");
  assert.equal(unverifiedList.total, summary.unverified, "drill-down khớp đúng con số trên thẻ KPI");
  assert.ok(unverifiedList.rows.every((r) => r.verifiedOutcome === "UNVERIFIED"));
  assert.ok(unverifiedList.rows.some((r) => r.id === "dq-901"));
  assert.ok(unverifiedList.rows.every((r) => r.hasCashProof === false), "đơn chưa xác minh thì không có bằng chứng tiền");

  const conflictList = await dataQualityOrders("status-conflict", ALL, 1, 50, "");
  assert.equal(conflictList.total, summary.statusConflict);
  assert.ok(conflictList.rows.some((r) => r.id === "dq-paid-returned"), "Pancake nói đã giao, VTP nói đã hoàn → xung đột");

  // Tìm kiếm trong drill-down.
  assert.equal((await dataQualityOrders("unverified", ALL, 1, 50, "dq-901")).rows.length, 1);

  // ───────── 5. Vận đơn ngoài ERP: đếm được nhưng KHÔNG vào doanh thu ─────────
  const orphans = await unlinkedShipments(1, 50, "", "updatedAt", "desc");
  assert.equal(orphans.total, summary.unlinkedShipments);
  assert.ok(orphans.total >= 1, "fixture có vận đơn VTP ngoài Pancake");
  assert.ok(orphans.rows.every((r) => r.vtpOrderNumber || r.orderReference), "vận đơn chưa đối soát vẫn tra cứu được");
  const [orphanCheck] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.shipments)
    .where(sql`${schema.shipments.orderId} is null`);
  assert.equal(Number(orphanCheck.n), orphans.total);
  // Không có đơn nào trong không gian doanh thu tham chiếu tới các vận đơn này.
  assert.ok(orphans.rows.every((r) => !unverifiedList.rows.some((o) => o.vtpOrderNumber === r.vtpOrderNumber)), "vận đơn chưa đối soát không lẫn vào danh sách đơn ERP");
  assert.equal((await unlinkedShipments(1, 50, "khong-ton-tai-xxx", "updatedAt", "desc")).total, 0, "tìm kiếm lọc đúng");

  // ───────── 6. Hàng hoàn chỉ về tồn khi kho xác nhận ─────────
  const waiting = await returnsAwaitingWarehouse(1, 50, "");
  assert.equal(waiting.total, summary.returnRiskShipments, "số vận đơn chờ nhận hoàn khớp KPI");
  assert.ok(waiting.rows.every((r) => r.returnReceivedAt === null), "danh sách chờ chỉ gồm vận đơn chưa xác nhận");
  const target = waiting.rows[0];
  assert.ok(target, "phải có ít nhất một vận đơn hoàn đang chờ kho");
  const first = await markReturnReceived([target.id], "test-kho", "Đếm đủ hàng");
  assert.equal(first.count, 1);
  const second = await markReturnReceived([target.id], "test-kho-2");
  assert.equal(second.count, 0, "xác nhận lần hai không ghi đè, không cộng trùng");
  const [after] = await db.select({ by: schema.shipments.returnReceivedBy }).from(schema.shipments).where(eq(schema.shipments.id, target.id));
  assert.equal(after.by, "test-kho", "giữ nguyên người xác nhận lần đầu");
  assert.equal((await returnsAwaitingWarehouse(1, 50, "")).total, waiting.total - 1, "đã nhận thì rời khỏi danh sách chờ");

  console.log(`✓ Chất lượng dữ liệu: ${summary.unverified} đơn chưa xác minh · ${summary.mismatch} đơn lệch legacy · ${summary.unlinkedShipments} vận đơn chưa đối soát · ${summary.returnRiskUnits} SP hoàn chưa về kho`);
  console.log(`✓ Doanh thu legacy ${summary.legacyRevenue} → có bằng chứng ${summary.verifiedRevenue}; GTC legacy ${summary.legacySuccessRate}% → thực tế ${summary.successRate}%`);
}

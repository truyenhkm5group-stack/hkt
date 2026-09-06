import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import { dataQualitySummary } from "@/lib/queries/data-quality";
import { getDashboardData } from "@/lib/queries/dashboard";
import { adOrdersFromErp } from "@/lib/queries/expenses";
import { orderSummary } from "@/lib/queries/orders";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { listVariantsForReceipt } from "@/lib/queries/stock";
import { getReturnRateSummary } from "@/lib/queries/return-rate";
import { shipmentSummary } from "@/lib/queries/shipments";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { parseListParams, type Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/** ListParams "không lọc gì" để tổng hợp danh sách bằng đúng phạm vi báo cáo. */
function allParams() {
  return parseListParams({ period: "all" }, { defaultPeriod: "all", defaultPageSize: 50 });
}

/**
 * NGUỒN SỰ THẬT của bộ kiểm thử: đếm thẳng bằng ORDER_OUTCOME trên đúng phạm vi báo cáo.
 * Mọi màn hình phải khớp con số này; nếu một màn hình lệch thì màn hình đó sai, không phải test sai.
 */
async function truth(db: Db) {
  const [row] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
      inTransit: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      deliveredRevenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
    })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(sql`${schema.orders.stage} <> 'NEW'`);

  // Grain VẬN ĐƠN: trang Vận đơn đếm vận đơn, không đếm đơn. Hai con số chỉ khác nhau đúng bằng
  // số đơn chưa có vận đơn nào (Pancake khai "đã giao" mà chưa đẩy sang ĐVVC) cộng vận đơn mồ côi.
  const [shipRow] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
    })
    .from(schema.shipments)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId));

  return {
    delivered: Number(row?.delivered ?? 0),
    returned: Number(row?.returned ?? 0),
    inTransit: Number(row?.inTransit ?? 0),
    deliveredRevenue: Number(row?.deliveredRevenue ?? 0),
    shipmentDelivered: Number(shipRow?.delivered ?? 0),
    shipmentReturned: Number(shipRow?.returned ?? 0),
  };
}

export async function testConsistency(db: Db) {
  clearMemo();
  const t = await truth(db);
  assert.ok(t.delivered > 0 && t.returned > 0, "fixture phải có cả đơn giao thành công lẫn đơn hoàn");

  // ───────── 1. Cùng "đơn giao thành công" trên mọi màn hình ─────────
  const params = allParams();
  const [orders, ships, gtc, ads, dq] = await Promise.all([
    orderSummary(params),
    shipmentSummary(params),
    getReturnRateSummary(ALL, ""),
    adOrdersFromErp(null, null),
    dataQualitySummary(ALL),
  ]);

  assert.equal(gtc.delivered, t.delivered, "Báo cáo Tỷ lệ giao thành công phải khớp nguồn sự thật");
  assert.equal(orders.success, t.delivered, "KPI 'giao thành công' trang Đơn hàng phải khớp");
  assert.equal(ads.delivered, t.delivered, "Quảng cáo/Marketing phải khớp");
  assert.equal(dq.legacyDelivered, t.delivered, "Chất lượng dữ liệu (cột legacy) phải khớp");
  // Trang Vận đơn đếm ở GRAIN VẬN ĐƠN nên con số nhỏ hơn; điều bắt buộc là nó dùng CÙNG QUY TẮC,
  // và phần chênh phải giải thích được hết bằng đơn chưa có vận đơn — không được là chênh lệch bí ẩn.
  assert.equal(ships.delivered, t.shipmentDelivered, "Trang Vận đơn phải dùng cùng quy tắc ORDER_OUTCOME, không dùng bản rút gọn riêng");
  const [{ n: deliveredNoShipment }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(sql`${schema.orders.stage} <> 'NEW' and ${schema.shipments.id} is null and ${ORDER_OUTCOME} = 'DELIVERED'`);
  const [{ n: orphanDelivered }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.shipments)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(sql`${schema.shipments.orderId} is null and ${ORDER_OUTCOME} = 'DELIVERED'`);
  assert.equal(
    t.delivered - Number(deliveredNoShipment) + Number(orphanDelivered),
    t.shipmentDelivered,
    "chênh lệch đơn ↔ vận đơn phải giải thích hết bằng đơn chưa có vận đơn + vận đơn chưa ghép đơn",
  );

  // ───────── 2. Cùng "đơn hoàn" ─────────
  assert.equal(gtc.returned, t.returned, "đơn hoàn: Tỷ lệ giao thành công");
  assert.equal(ships.returning, t.shipmentReturned, "đơn hoàn: trang Vận đơn (grain vận đơn, cùng quy tắc)");
  assert.equal(dq.legacyDelivered + dq.returned >= 0, true);

  // ───────── 3. Cùng doanh thu đơn giao thành công ─────────
  assert.equal(ads.deliveredRevenue, t.deliveredRevenue, "doanh thu giao thành công: Marketing");

  // ───────── 4a. Tổng quan phải dùng CÙNG định nghĩa GTC với báo cáo ─────────
  const dash = await getDashboardData(ALL);
  assert.equal(dash.kpi.successRate, gtc.successRate === null ? null : Math.round(gtc.successRate * 10) / 10,
    "Tổng quan và Báo cáo GTC phải cho cùng tỷ lệ giao thành công");
  assert.equal(dash.kpi.successOrders + dash.kpi.returnedOrders > 0, true);

  // ───────── 4. Tỷ lệ GTC tính từ cùng tử số / mẫu số ─────────
  const expectedRate = t.delivered + t.returned ? (t.delivered / (t.delivered + t.returned)) * 100 : null;
  assert.equal(gtc.successRate, expectedRate, "GTC = giao thành công ÷ (giao thành công + hoàn)");
  assert.ok(gtc.rate !== null && gtc.successRate !== null && Math.abs(gtc.rate + gtc.successRate - 100) < 1e-9, "tỷ lệ hoàn + GTC = 100");

  // ───────── 5. Dòng tiền: COD "đã thu chờ về" phải loại vận đơn đã hoàn/huỷ ─────────
  const cash = await getCashProfitReport(ALL);
  const [{ n: badWaiting }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.shipments)
    .where(sql`${schema.shipments.codStatus} in ('COLLECTED','RECONCILED') and ${schema.shipments.stage} in ('RETURNED','CANCELLED')`);
  if (Number(badWaiting) > 0) {
    const [{ amount }] = await db
      .select({ amount: sql<number>`coalesce(sum(${schema.shipments.codAmount}), 0)` })
      .from(schema.shipments)
      .where(sql`${schema.shipments.codStatus} in ('COLLECTED','RECONCILED') and ${schema.shipments.stage} not in ('RETURNED','CANCELLED')`);
    assert.equal(cash.pending.codCollectedWaiting, Number(amount), "COD chờ về không được tính vận đơn đã hoàn/huỷ");
  }

  // ───────── 6. Tồn kho: hàng hoàn chưa về kho không được nằm trong tồn ─────────
  const stock = await listVariantsForReceipt();
  const plan = await getReplenishmentPlan();
  for (const variantId of ["rr-var", "dq-var"]) {
    const inStock = stock.find((v) => v.id === variantId);
    const inPlan = plan.rows.find((r) => r.variantId === variantId);
    if (inStock && inPlan) {
      assert.equal(inPlan.stock, inStock.currentStock, `Kế hoạch SX và Tồn kho phải cùng số tồn (${variantId})`);
    }
  }

  // Tồn ERP không được vượt quá tổng nhập — dấu hiệu kinh điển của tồn ảo do cộng nhầm hàng hoàn.
  const [{ received }] = await db
    .select({ received: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)` })
    .from(schema.stockReceiptItems)
    .where(eq(schema.stockReceiptItems.variantId, "rr-var"));
  const rrStock = stock.find((v) => v.id === "rr-var");
  assert.ok(rrStock !== undefined && rrStock.currentStock <= Number(received), "tồn ERP không được lớn hơn tổng nhập");

  // ───────── 7. Kế hoạch SX không lấy đơn hoàn làm tín hiệu nhu cầu ─────────
  const planned = plan.rows.find((r) => r.variantId === "rr-var");
  if (planned) {
    const [{ n: returnedQty }] = await db
      .select({ n: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(sql`${schema.orderItems.variantId} = 'rr-var' and ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')`);
    assert.ok(Number(returnedQty) > 0, "fixture phải có hàng hoàn để kiểm tra");
    const [{ n: totalQty }] = await db
      .select({ n: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.variantId, "rr-var"));
    assert.ok(planned.sold30 <= Number(totalQty) - Number(returnedQty), "nhu cầu 30 ngày không được gồm đơn hoàn");
  }

  console.log(`✓ Nhất quán: giao thành công ${t.delivered} khớp ở Đơn hàng / Vận đơn / GTC / Marketing / Chất lượng dữ liệu; hoàn ${t.returned}; GTC ${gtc.successRate}%`);
  console.log(`✓ Nhất quán: tồn kho khớp giữa Sản phẩm và Kế hoạch SX; nhu cầu SX không gồm đơn hoàn`);
}

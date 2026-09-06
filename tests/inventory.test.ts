import assert from "node:assert/strict";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { computePlan } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { listProducts, productSummary } from "@/lib/queries/products";
import { markReturnReceived } from "@/lib/returns/warehouse";
import { parseListParams } from "@/lib/search-params";

function allParams() {
  return parseListParams({ period: "all", pageSize: "200" }, { defaultPeriod: "all", defaultPageSize: 200 });
}

async function productRow(variantId: string) {
  const { rows } = await listProducts(allParams(), 200);
  const row = rows.find((r) => r.id === variantId);
  assert.ok(row, `không tìm thấy mẫu mã ${variantId} trong danh sách sản phẩm`);
  return row;
}

export async function testInventory(db: Db) {
  clearMemo();

  // ───────── 1. Bốn trạng thái KHÔNG được trộn vào nhau ─────────
  const rr = await productRow("rr-var");
  assert.equal(
    rr.returned,
    rr.returnedPending + rr.returnedReceived,
    "tổng hàng hoàn phải bằng đúng (chờ về kho + đã nhận) — không được đếm trùng hay bỏ sót",
  );
  assert.equal(
    rr.erpStock,
    rr.received - rr.delivered - rr.inTransit - rr.returnedPending,
    "tồn khả dụng = nhập − giao thật − đang giao − hàng hoàn chưa về kho",
  );
  assert.ok(rr.returnedPending >= 0 && rr.returnedReceived >= 0);
  // Hàng ĐÃ nhận hoàn nằm trong tồn, KHÔNG bị trừ lần nữa.
  assert.ok(
    rr.erpStock >= rr.received - rr.delivered - rr.inTransit - rr.returned,
    "hàng hoàn đã nhận không được trừ khỏi tồn",
  );

  // ───────── 2. Tồn không bao giờ vượt tổng nhập ─────────
  assert.ok(rr.erpStock <= rr.received, "tồn ERP không thể lớn hơn tổng đã nhập");

  // ───────── 3. Kho xác nhận nhận hoàn → tồn tăng ĐÚNG số lượng, không nhân đôi ─────────
  const pending = await db
    .select({ id: schema.shipments.id })
    .from(schema.shipments)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, schema.orders.id))
    .where(and(eq(schema.orderItems.variantId, "rr-var"), isNull(schema.shipments.returnReceivedAt)));
  if (pending.length) {
    const target = pending[0].id;
    const [{ qty }] = await db
      .select({ qty: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
      .innerJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(and(eq(schema.shipments.id, target), eq(schema.orderItems.variantId, "rr-var")));
    const before = await productRow("rr-var");
    clearMemo();
    await markReturnReceived([target], "test-kho-inventory");
    clearMemo();
    const after = await productRow("rr-var");
    assert.equal(after.erpStock, before.erpStock + Number(qty), "tồn tăng đúng số lượng kho vừa nhận");
    assert.equal(after.returnedPending, before.returnedPending - Number(qty), "số chờ về kho giảm đúng bằng số đã nhận");
    assert.equal(after.returnedReceived, before.returnedReceived + Number(qty), "số đã nhận tăng đúng bằng số vừa nhận");
    assert.equal(after.returned, before.returned, "tổng hàng hoàn không đổi — chỉ chuyển trạng thái, không sinh thêm");

    // Bấm lại lần hai không được cộng tồn thêm lần nữa.
    await markReturnReceived([target], "test-kho-inventory-2");
    clearMemo();
    const twice = await productRow("rr-var");
    assert.equal(twice.erpStock, after.erpStock, "xác nhận lại không cộng trùng tồn");
  }

  // ───────── 4. Chưa có phiếu nhập ⇒ tồn là KHÔNG BIẾT, không phải 0 ─────────
  const [{ n: receiptRows }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.stockReceiptItems)
    .where(eq(schema.stockReceiptItems.variantId, "dq-var"));
  assert.equal(Number(receiptRows), 0, "fixture: dq-var cố ý không có phiếu nhập nào");
  const dq = await productRow("dq-var");
  assert.equal(dq.stockKnown, false, "mẫu mã chưa có phiếu nhập phải bị đánh dấu là chưa tính được tồn");
  assert.equal(rr.stockKnown, true, "mẫu mã đã có phiếu nhập thì tính được tồn");

  // Không được đếm mẫu mã chưa biết tồn vào "hết hàng".
  const summary = await productSummary(allParams());
  assert.ok(summary.unknownStock >= 1, "phải đếm được mẫu mã chưa tính được tồn");
  assert.equal(summary.returned, summary.returnedPending + summary.returnedReceived, "tổng hoàn = chờ về kho + đã nhận");

  // ───────── 5. Kế hoạch SX KHÔNG đề xuất đặt khi chưa biết tồn ─────────
  clearMemo();
  const plan = await getReplenishmentPlan();
  const unknownRow = plan.rows.find((r) => r.variantId === "dq-var");
  assert.ok(unknownRow, "mẫu mã chưa có phiếu nhập vẫn phải hiện trong kế hoạch để chủ shop bổ sung phiếu");
  assert.equal(unknownRow.status, "UNKNOWN", "trạng thái phải là UNKNOWN, không phải 'hết hàng'");
  assert.equal(unknownRow.suggested, 0, "không được đề xuất đặt hàng dựa trên tồn bịa ra");
  assert.equal(unknownRow.stockKnown, false);
  assert.ok(plan.summary.unknown >= 1, "tổng hợp kế hoạch phải nêu số mẫu mã chưa tính được tồn");

  // Không mẫu mã UNKNOWN nào được cộng vào tổng đề xuất đặt.
  const suggestedFromUnknown = plan.rows.filter((r) => !r.stockKnown).reduce((t, r) => t + r.suggested, 0);
  assert.equal(suggestedFromUnknown, 0, "tổng đề xuất không được chứa mẫu mã chưa biết tồn");

  // ───────── 6. computePlan: ranh giới của quy tắc ─────────
  const base = { committed: 0, soldInWindow: 14, windowDays: 14, leadTimeDays: 7, coverDays: 14, safetyDays: 3, roundTo: 1 };
  assert.equal(computePlan({ ...base, stock: 100, stockKnown: false }).suggested, 0, "không biết tồn thì không đề xuất");
  assert.equal(computePlan({ ...base, stock: 100, stockKnown: false }).status, "UNKNOWN");
  assert.ok(computePlan({ ...base, stock: 0, stockKnown: true }).suggested > 0, "biết tồn và hết hàng thì phải đề xuất");
  assert.equal(computePlan({ ...base, stock: 0, stockKnown: true }).status, "OUT");

  // ───────── 7. Sản phẩm và Kế hoạch SX không được cho hai số tồn khác nhau ─────────
  for (const row of plan.rows) {
    const product = (await listProducts(allParams(), 200)).rows.find((p) => p.id === row.variantId);
    if (product) {
      assert.equal(row.stock, product.erpStock, `tồn lệch giữa Kế hoạch SX và Sản phẩm: ${row.variantId}`);
      assert.equal(row.stockKnown, product.stockKnown, `cờ 'tính được tồn' lệch giữa hai trang: ${row.variantId}`);
    }
  }

  console.log(`✓ Tồn kho: 4 trạng thái tách bạch · ${summary.unknownStock} mẫu mã chưa có phiếu nhập không bị coi là hết hàng · kế hoạch SX không đặt theo tồn bịa`);
}

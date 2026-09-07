import assert from "node:assert/strict";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { computePlan } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { listProducts, productSummary } from "@/lib/queries/products";
import { RETURN_PENDING_WAREHOUSE } from "@/lib/queries/return-rate";
import { listPendingReturnedIds, markReturnReceived, pendingReturnedForWarehouse, pendingReturnsByVariant } from "@/lib/returns/warehouse";
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

  // ───────── 1. SỔ KHO: tồn phải ra đúng từ một phương trình duy nhất ─────────
  const rr = await productRow("rr-var");
  assert.equal(
    rr.received,
    rr.receiptIn + rr.returnIn + rr.adjust - rr.manualOut,
    "tổng phiếu kho = nhập mới + tái nhập + điều chỉnh − xuất tay",
  );
  assert.equal(rr.erpStock, rr.received - rr.shipped, "tồn thực tế = tổng phiếu kho − đã xuất qua ĐVVC");
  assert.equal(rr.available, rr.erpStock - rr.reserved, "khả dụng bán = tồn thực tế − hàng đã chốt đơn chờ xuất");
  assert.ok(rr.shipped >= rr.inTransit, "đang ở ngoài là tập con của đã xuất");
  assert.ok(rr.shipped >= rr.awaitingReturn, "hoàn chờ nhận là tập con của đã xuất");

  // ───────── 2. Hàng hoàn KHÔNG tự quay lại tồn khi chưa có phiếu tái nhập ─────────
  // Đây là điểm khác cốt lõi: ĐVVC báo "đã hoàn" chỉ nghĩa là hàng đang trên đường / đã tới shop,
  // không nghĩa là hàng đã nằm trong kho. Chỉ phiếu tái nhập mới cộng tồn.
  assert.ok(rr.erpStock <= rr.received, "tồn không thể lớn hơn tổng phiếu kho");

  // ───────── 3. Kho nhận hoàn → ERP lập phiếu tái nhập → tồn tăng ĐÚNG số lượng ─────────
  const pending = await db
    .select({ id: schema.shipments.id })
    .from(schema.shipments)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, schema.orders.id))
    .where(and(eq(schema.orderItems.variantId, "rr-var"), isNull(schema.shipments.returnReceivedAt), RETURN_PENDING_WAREHOUSE));
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
    assert.equal(after.returnIn, before.returnIn + Number(qty), "phiếu tái nhập ghi đúng số món kho nhận về");
    assert.equal(after.erpStock, before.erpStock + Number(qty), "tồn tăng đúng số lượng kho vừa nhận");
    assert.equal(after.awaitingReturn, before.awaitingReturn - Number(qty), "hoàn chờ nhận giảm đúng bằng số đã nhận");
    assert.equal(after.shipped, before.shipped, "đã xuất không đổi — nhận hoàn không phải là xuất thêm");

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

  const summary = await productSummary(allParams());
  assert.ok(summary.unknownStock >= 1, "phải đếm được mẫu mã chưa tính được tồn");
  assert.ok(summary.shipped >= summary.awaitingReturn, "tổng hợp: hoàn chờ nhận là tập con của đã xuất");

  // ───────── 5. Kế hoạch SX KHÔNG đề xuất đặt khi chưa biết tồn ─────────
  clearMemo();
  const plan = await getReplenishmentPlan();
  const unknownRow = plan.rows.find((r) => r.variantId === "dq-var");
  assert.ok(unknownRow, "mẫu mã chưa có phiếu nhập vẫn phải hiện trong kế hoạch để chủ shop bổ sung phiếu");
  assert.equal(unknownRow.status, "UNKNOWN", "trạng thái phải là UNKNOWN, không phải 'hết hàng'");
  assert.equal(unknownRow.suggested, 0, "không được đề xuất đặt hàng dựa trên tồn bịa ra");
  assert.equal(unknownRow.stockKnown, false);
  assert.ok(plan.summary.unknown >= 1, "tổng hợp kế hoạch phải nêu số mẫu mã chưa tính được tồn");

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

  // ───────── 8. Xác nhận hàng loạt chỉ đụng hàng ĐÃ VỀ TỚI SHOP ─────────
  await db.insert(schema.orders).values([
    { id: "bulk-da-ve", stage: "RETURNED", insertedAt: new Date() },
    { id: "bulk-dang-ve", stage: "SHIPPED", insertedAt: new Date() },
  ]);
  await db.insert(schema.orderItems).values([
    { id: "bulk-i1", orderId: "bulk-da-ve", variantId: "rr-var", quantity: 3 },
    { id: "bulk-i2", orderId: "bulk-da-ve", variantId: "rr-var", quantity: 2, isBonus: true },
    { id: "bulk-i3", orderId: "bulk-dang-ve", variantId: "rr-var", quantity: 7 },
  ]);
  await db.insert(schema.shipments).values([
    { id: "bulk-ship-da-ve", orderId: "bulk-da-ve", stage: "RETURNED", returnedAt: new Date(Date.now() - 20 * 86_400_000) },
    { id: "bulk-ship-dang-ve", orderId: "bulk-dang-ve", stage: "RETURNING" },
  ]);

  // Vận đơn chiều hoàn do Viettel Post tự tạo (mã ...1P1) cũng ở trạng thái RETURNED khi phát
  // thành công về shop, nhưng không gắn đơn và không có món hàng nào — không được lọt vào hàng
  // chờ kho, nếu không danh sách sẽ đầy dòng rỗng.
  await db.insert(schema.shipments).values({ id: "bulk-ship-chieu-hoan", orderReference: "PKE-GOC", stage: "RETURNED", returnedAt: new Date() });

  const cho = await pendingReturnedForWarehouse();
  const ids = await listPendingReturnedIds(500);
  assert.ok(ids.includes("bulk-ship-da-ve"), "vận đơn Viettel Post đã trả xong phải nằm trong danh sách chờ kho");
  assert.ok(!ids.includes("bulk-ship-dang-ve"), "vận đơn còn đang trên đường về KHÔNG được xác nhận hàng loạt");
  assert.ok(!ids.includes("bulk-ship-chieu-hoan"), "vận đơn chiều hoàn không gắn đơn không được vào hàng chờ kho");
  assert.ok(cho.count >= 1);
  assert.ok(cho.items >= 5, "số món phải khớp cách tính tồn của ERP, gồm cả hàng tặng");
  assert.ok(cho.oldestAt && Date.now() - new Date(cho.oldestAt).getTime() >= 19 * 86_400_000, "phải nêu được kiện chờ lâu nhất");

  // Hai kiện trên đều đã rời kho nên đều nằm trong "hoàn chờ nhận" của mẫu mã.
  clearMemo();
  const choTheoMauMa = await pendingReturnsByVariant();
  assert.ok((choTheoMauMa.get("rr-var") ?? 0) >= 12, "hoàn chờ nhận theo mẫu mã phải gồm cả kiện đã về (5) và kiện đang về (7)");

  clearMemo();
  const truoc = await productRow("rr-var");
  await markReturnReceived(["bulk-ship-da-ve"], "test-kho-hang-loat");
  clearMemo();
  const sau = await productRow("rr-var");
  assert.equal(sau.erpStock, truoc.erpStock + 5, "kiện đã về cộng đúng 5 món (3 bán + 2 tặng) — hàng tặng cũng nằm trong kiện quay về");
  assert.equal(sau.returnIn, truoc.returnIn + 5, "phiếu tái nhập ghi đúng 5 món");

  // Kiện đang trên đường về vẫn nằm ngoài tồn cho tới khi Viettel Post trả hàng xong.
  await markReturnReceived(ids, "test-kho-hang-loat-2");
  clearMemo();
  const sauTatCa = await productRow("rr-var");
  assert.ok(sauTatCa.erpStock < truoc.erpStock + 5 + 7, "7 món của kiện đang trên đường về không được cộng vào tồn");
  assert.equal((await listPendingReturnedIds(500)).length, 0, "xác nhận hàng loạt xong thì không còn kiện nào chờ");
  assert.equal((await markReturnReceived(ids, "test-lap-lai")).count, 0, "bấm lại lần hai không cộng trùng tồn");

  // ───────── 9. Hàng xuất tay (không qua ĐVVC) trừ tồn như hàng gửi ĐVVC ─────────
  clearMemo();
  const truocXuatTay = await productRow("rr-var");
  const [issue] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "ISSUE", receivedAt: new Date(), reference: "test-xuat-tay", totalQuantity: -4, totalCost: 0, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: issue.id, variantId: "rr-var", quantity: -4, unitCost: 0 });
  clearMemo();
  const sauXuatTay = await productRow("rr-var");
  assert.equal(sauXuatTay.manualOut, truocXuatTay.manualOut + 4, "phiếu xuất tay ghi nhận 4 món đã ra khỏi kho");
  assert.equal(sauXuatTay.erpStock, truocXuatTay.erpStock - 4, "xuất tay trừ tồn đúng 4 món");
  assert.equal(sauXuatTay.shipped, truocXuatTay.shipped, "xuất tay không được cộng vào 'đã xuất qua ĐVVC'");

  console.log(
    `✓ Sổ kho: tồn = phiếu kho − đã xuất (ĐVVC) · hàng hoàn chỉ về tồn qua phiếu tái nhập · xuất tay trừ tồn · ${summary.unknownStock} mẫu mã chưa có phiếu nhập không bị coi là hết hàng`,
  );
}

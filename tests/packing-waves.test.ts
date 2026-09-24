import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { lineKey, normalizeLines, PACK_BATCH_MIN, planPackingWaves, type PackOrder } from "@/lib/constants/packing-waves";
import { getPackingWaves } from "@/lib/queries/packing-waves";
import { getStockShortage } from "@/lib/queries/stock-shortage";

/**
 * ═══════════ ĐÓNG GÓI THEO LƯỢT ═══════════
 *
 * Ba chỗ một bảng gom đơn dễ nói sai nhất, và mỗi cái đẩy kho đi làm việc thừa:
 *  1. Gom đơn CHỜ HÀNG vào lượt — kho đi tìm cái áo không tồn tại.
 *  2. Gom đơn ĐÃ ĐÓNG (chờ lấy hàng) — kho đóng lại một gói đã đóng.
 *  3. Coi hai đơn "gần giống" là giống hệt — dây chuyền đóng liền tay dán nhầm hàng.
 */

export function testPackingWavesPure() {
  const t0 = new Date("2026-09-24T01:00:00Z").getTime();
  const at = (phut: number) => new Date(t0 + phut * 60_000);
  const don = (id: string, phut: number, lines: [string, number][]): PackOrder => ({
    orderId: id,
    systemId: Number(id.replace(/\D/g, "")) || null,
    customer: `Khách ${id}`,
    insertedAt: at(phut),
    lines: lines.map(([v, q]) => ({ variantId: v, label: `Mẫu ${v}`, qty: q })),
  });

  const orders = [
    don("d1", 5, [["A", 1]]),
    don("d2", 1, [["A", 1]]),
    don("d3", 3, [["A", 1]]),
    // Cùng mẫu KHÁC số lượng ⇒ KHÔNG giống hệt.
    don("d4", 2, [["A", 2]]),
    // Hai dòng cùng mẫu trong một đơn ⇒ gộp thành 2× A ⇒ giống hệt d4.
    don("d5", 4, [["A", 1], ["A", 1]]),
    // Hai mẫu, thứ tự dòng khác nhau ⇒ vẫn giống hệt.
    don("d6", 6, [["A", 1], ["B", 1]]),
    don("d7", 7, [["B", 1], ["A", 1]]),
    don("d8", 8, [["C", 3]]),
    // Đơn không còn dòng hàng nào (số lượng 0) ⇒ không phải việc đóng gói.
    don("d9", 9, [["A", 0]]),
  ];

  const p = planPackingWaves(orders);
  assert.equal(p.totals.orders, 8, "đơn không còn dòng hàng nào không được tính là đơn cần đóng");
  assert.deepEqual(
    p.batches.map((b) => b.orders.map((o) => o.orderId)),
    [["d2", "d3", "d1"], ["d4", "d5"], ["d6", "d7"]],
    "lượt đông nhất trước; trong một lượt, đơn lên trước đứng trước",
  );
  assert.deepEqual(p.singles.map((o) => o.orderId), ["d8"], "đơn không trùng ai là đơn lẻ");
  assert.equal(p.totals.ordersInBatches, 7);
  assert.equal(lineKey([{ variantId: "A", label: "", qty: 1 }, { variantId: "B", label: "", qty: 1 }]), lineKey([{ variantId: "B", label: "", qty: 1 }, { variantId: "A", label: "", qty: 1 }]), "thứ tự dòng không đổi khoá");
  assert.notEqual(lineKey([{ variantId: "A", label: "", qty: 1 }]), lineKey([{ variantId: "A", label: "", qty: 2 }]), "khác số lượng là khác gói — dán nhầm nhãn nếu gộp");
  assert.deepEqual(normalizeLines([{ variantId: "A", label: "x", qty: 1 }, { variantId: "A", label: "x", qty: 2 }]), [{ variantId: "A", label: "x", qty: 3 }], "dòng trùng mẫu trong một đơn được cộng lại");

  // Phiếu lấy hàng tổng: mỗi mẫu một dòng, số cái = tổng mọi đơn, mẫu nhiều cái nhất trước.
  assert.deepEqual(
    p.pickList.map((r) => [r.variantId, r.qty, r.orders]),
    [["A", 9, 7], ["C", 3, 1], ["B", 2, 2]],
    "A: d1+d2+d3 (3) + d4 (2) + d5 (2) + d6 + d7 (2) = 9 cái trong 7 đơn",
  );
  assert.equal(p.totals.units, 14);
  assert.equal(
    p.totals.units,
    [...p.batches.flatMap((b) => b.orders), ...p.singles].reduce((s, o) => s + o.lines.reduce((x, l) => x + l.qty, 0), 0),
    "phiếu lấy hàng phải cộng ĐÚNG bằng số cái của mọi đơn được đóng — lệch là kho lấy thiếu hoặc thừa",
  );

  // Ổn định: đảo thứ tự đầu vào không đổi kết quả.
  const dao = planPackingWaves([...orders].reverse());
  assert.deepEqual(dao.batches.map((b) => b.key), p.batches.map((b) => b.key), "chạy hai lần ra cùng thứ tự — kho đang đóng dở không bị xáo lại");
  assert.deepEqual(dao.singles.map((o) => o.orderId), p.singles.map((o) => o.orderId));

  assert.equal(PACK_BATCH_MIN, 2);
  assert.deepEqual(planPackingWaves([]).totals, { orders: 0, units: 0, variants: 0, ordersInBatches: 0 }, "không có đơn thì không bịa lượt nào");
  console.log("✓ Đóng gói theo lượt (hàm thuần): giống hệt = cùng mẫu CÙNG số lượng · dòng trùng được gộp · phiếu lấy hàng cộng đúng số cái · ổn định");
}

const P = "pkw-";
const H = 3_600_000;

async function donDep(db: Db) {
  const ids = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.canonicalOrderOutcome).where(inArray(schema.canonicalOrderOutcome.orderId, ids));
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, ids));
    await db.delete(schema.orders).where(inArray(schema.orders.id, ids));
  }
  const receipts = (await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(like(schema.stockReceipts.reference, `${P}%`))).map((r) => r.id);
  if (receipts.length) {
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, receipts));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receipts));
  }
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

/**
 * Trên CSDL thật (PGlite): dữ liệu RIÊNG phủ đủ tám nhánh. Mốc đi theo đồng hồ thật (mục 50).
 *
 * Đen/M có 3 cái. Phân bổ ai lên trước được hàng trước: w1 (60h) · w4 (55h, ĐÃ đóng — chờ lấy
 * hàng, vẫn GIỮ hàng) · w2 (50h) lấy hết 3 cái ⇒ w5 (30h) chờ hàng. Trắng/M có 5 cái. Xanh/M chưa
 * có phiếu nhập ⇒ tồn chưa biết.
 */
export async function testPackingWavesQueries(db: Db) {
  await donDep(db);
  const ago = (h: number) => new Date(Date.now() - h * H);
  await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm kiểm gom đơn", customId: "PKW01" });
  await db.insert(schema.productVariants).values([
    { id: `${P}den-m`, productId: `${P}prod`, sku: "PKW-DEN-M", color: "Đen", size: "M", retailPrice: 500_000 },
    { id: `${P}trang-m`, productId: `${P}prod`, sku: "PKW-TRANG-M", color: "Trắng", size: "M", retailPrice: 500_000 },
    { id: `${P}xanh-m`, productId: `${P}prod`, sku: "PKW-XANH-M", color: "Xanh", size: "M", retailPrice: 500_000 },
  ]);
  const [phieu] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: ago(300), reference: `${P}lo-1`, totalQuantity: 8, totalCost: 1_600_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values([
    { receiptId: phieu.id, variantId: `${P}den-m`, quantity: 3, unitCost: 200_000 },
    { receiptId: phieu.id, variantId: `${P}trang-m`, quantity: 5, unitCost: 200_000 },
  ]);
  type Stage = "CONFIRMED" | "PACKING" | "READY_TO_SHIP";
  const don = async (id: string, stage: Stage, variantId: string, qty: number, hoursAgo: number, opt: { phone?: string; promisedInHours?: number } = {}) => {
    await db.insert(schema.orders).values({
      id: `${P}${id}`,
      systemId: 950_000 + Number(id.replace(/\D/g, "")),
      billFullName: `Khách ${id}`,
      billPhone: opt.phone ?? "0900000000",
      shipAddress: "1 Đường A",
      shipProvince: "Hà Nội",
      totalPriceAfterDiscount: 500_000 * qty,
      stage,
      insertedAt: ago(hoursAgo),
      lastUpdateStatusAt: ago(hoursAgo),
      customerPromisedAt: opt.promisedInHours === undefined ? null : new Date(Date.now() + opt.promisedInHours * H),
    });
    await db.insert(schema.orderItems).values({ id: `${P}${id}-i`, orderId: `${P}${id}`, variantId, productId: `${P}prod`, productName: "Đầm kiểm gom đơn", quantity: qty, unitPrice: 500_000, lineTotal: 500_000 * qty });
  };
  await don("w1", "CONFIRMED", `${P}den-m`, 1, 60);
  await don("w4", "READY_TO_SHIP", `${P}den-m`, 1, 55);
  await don("w2", "PACKING", `${P}den-m`, 1, 50);
  await don("w5", "CONFIRMED", `${P}den-m`, 1, 30);
  await don("w3", "CONFIRMED", `${P}trang-m`, 2, 40);
  await don("w6", "CONFIRMED", `${P}xanh-m`, 1, 20);
  await don("w7", "CONFIRMED", `${P}trang-m`, 1, 10, { phone: "" });
  await don("w8", "CONFIRMED", `${P}trang-m`, 1, 5, { promisedInHours: 240 });

  try {
    clearMemo();
    const w = await getPackingWaves();
    const snap = await getStockShortage();
    const cuaToi = (list: PackOrder[]) => list.map((o) => o.orderId).filter((id) => id.startsWith(P)).map((id) => id.slice(P.length));

    const luot = w.batches.filter((b) => b.orders.some((o) => o.orderId.startsWith(P)));
    assert.deepEqual(luot.map((b) => cuaToi(b.orders)), [["w1", "w2"]], "hai đơn 1× Đen/M đủ hàng (một Đã xác nhận, một Đang đóng hàng) phải là MỘT lượt, đơn lên trước đứng trước");
    assert.deepEqual(cuaToi(w.singles), ["w3"], "2× Trắng/M không trùng ai ⇒ đơn lẻ");
    const tatCa = [...w.batches.flatMap((b) => b.orders), ...w.singles].map((o) => o.orderId);
    assert.ok(!tatCa.includes(`${P}w4`), "đơn CHỜ LẤY HÀNG đã đóng xong — không được vào danh sách đóng gói");
    assert.ok(!tatCa.includes(`${P}w5`), "đơn CHỜ HÀNG không được gom — kho sẽ đi tìm cái áo không có");
    assert.ok(!tatCa.includes(`${P}w6`), "tồn CHƯA BIẾT không được coi là đủ");
    assert.ok(!tatCa.includes(`${P}w7`), "đơn thiếu SĐT chưa tạo được vận đơn — không đóng trước");
    assert.ok(!tatCa.includes(`${P}w8`), "khách hẹn giao xa — chưa cần đóng hôm nay");
    assert.equal(snap.orders.get(`${P}w4`)?.state, "READY", "đơn chờ lấy hàng vẫn GIỮ hàng trong phân bổ — nó bị loại vì đã đóng, không vì thiếu");
    assert.equal(snap.orders.get(`${P}w5`)?.state, "WAITING_STOCK", "đơn đã đóng vẫn được phân hàng trước ⇒ w5 hết hàng: phép phân bổ không bị bẻ riêng cho trang này");
    assert.ok(w.excluded.waitingStock >= 1 && w.excluded.stockUnknown >= 1 && w.excluded.dataBlocked >= 1 && w.excluded.promisedLater >= 1, `mỗi lý do loại phải được ĐẾM: ${JSON.stringify(w.excluded)}`);
    const den = w.pickList.find((r) => r.variantId === `${P}den-m`);
    assert.deepEqual([den?.qty, den?.orders], [2, 2], "phiếu lấy hàng: Đen/M lấy 2 cái cho 2 đơn — KHÔNG tính cái của đơn đã đóng, KHÔNG tính cái của đơn chờ hàng");

    // Bất biến trên TOÀN BỘ danh sách (cả dữ liệu mẫu khác đang có trong CSDL).
    assert.equal(tatCa.length, w.totals.orders, "tổng đơn = đơn trong lượt + đơn lẻ");
    assert.equal(new Set(tatCa).size, tatCa.length, "một đơn không được nằm ở hai chỗ");
    for (const id of tatCa) assert.equal(snap.orders.get(id)?.state, "READY", `đơn ${id} được gom mà sổ kho không nói ĐỦ HÀNG`);
    const rows = await db.select({ id: schema.orders.id, stage: schema.orders.stage }).from(schema.orders).where(inArray(schema.orders.id, tatCa));
    for (const r of rows) assert.ok(r.stage === "CONFIRMED" || r.stage === "PACKING", `đơn ${r.id} ở giai đoạn ${r.stage} — đơn đã đóng không được vào danh sách đóng gói`);
    console.log(
      `✓ Đóng gói theo lượt (CSDL): lượt w1+w2 · đơn lẻ w3 · loại đúng đơn chờ lấy hàng / chờ hàng / chưa biết tồn / thiếu SĐT / hẹn xa · phiếu lấy hàng không đếm hàng của đơn đã đóng`,
    );
  } finally {
    await donDep(db);
    clearMemo();
  }
}

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { allocateStock, buildShortageLarkCard, stillShortAfterOrder, type ShortageVariantInput } from "@/lib/constants/stock-shortage";
import {
  batchActualCost,
  openBatchQtyByVariant,
  deliveryStatus,
  laborCost,
  normalizeProductCode,
  paidTotals,
  PAYMENT_STATE_LABEL,
  PAYMENT_STATE_TONE,
  PAYMENT_STATES,
  paymentStatus,
  productActualCost,
  DELIVERY_STATES,
  DELIVERY_STATE_LABEL,
  DELIVERY_STATE_TONE,
} from "@/lib/constants/workshop-ledger";
import { getWorkshopLedger } from "@/lib/queries/workshop-ledger";
import { batchInput, paymentInput } from "@/lib/validation/workshop-ledger";

/**
 * ═══════════ SỔ ĐẶT XƯỞNG ═══════════
 *
 * Bốn chỗ sổ này dễ nói sai nhất:
 *  1. Tái hiện SAI bảng tính cũ — con số chủ shop đã quen (TỔNG, còn phải thanh toán) phải ra y hệt.
 *  2. Ô trống thành 0 — đơn giá chưa có mà "còn phải trả 0đ, Đã xong" là lời nói dối dễ tin nhất.
 *  3. Giá SX thực tế ra một con số rẻ giả vì thiếu vải / thiếu tiền công.
 *  4. Sổ công nợ lọt vào báo cáo lợi nhuận — giá vốn bị trừ hai lần (AGENTS.md mục 15).
 */

const DAY = 86_400_000;

function viPhamRangBuoc(ten: string) {
  return (e: unknown) => {
    const chuoi: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 5 && cur; i++) {
      chuoi.push(String((cur as { message?: string })?.message ?? cur));
      cur = (cur as { cause?: unknown })?.cause;
    }
    return chuoi.join(" | ").includes(ten);
  };
}

export function testWorkshopLedgerPure() {
  // ───────── 1. Ra đúng các dòng của bảng tính "Thành phẩm" ─────────
  // Q002 lô 1: chốt 335 × 60.000 = 20.100.000, đã trả 20.000.000 ⇒ còn 100.000.
  const q2l1 = laborCost({ agreedQty: 335, laborUnitPrice: 60_000, adjustment: 0 }, 335);
  assert.equal(q2l1.amount, 20_100_000);
  assert.equal(q2l1.basis, "AGREED");
  const tt1 = paymentStatus(q2l1.amount, [{ kind: "PAYMENT", amount: 20_000_000 }]);
  assert.deepEqual([tt1.remaining, tt1.state], [100_000, "PARTIAL"]);
  // Q002 lô 2: chốt 1.039 (= 240 + 335 + 190 + 274 xưởng trả) × 60.000 = 62.340.000; trả 62.040.000 ⇒ còn 300.000.
  const q2l2 = laborCost({ agreedQty: 1039, laborUnitPrice: 60_000, adjustment: 0 }, 240 + 335 + 190 + 274);
  assert.equal(q2l2.amount, 62_340_000);
  assert.equal(paymentStatus(q2l2.amount, [{ kind: "PAYMENT", amount: 62_040_000 }]).remaining, 300_000);
  // Q001 lô 1: 146 × 60.000 = 8.760.000, trả đủ ⇒ Đã xong.
  assert.equal(paymentStatus(laborCost({ agreedQty: 146, laborUnitPrice: 60_000, adjustment: 0 }, 146).amount, [{ kind: "PAYMENT", amount: 8_760_000 }]).state, "PAID");
  // Thưởng / phạt cộng thẳng vào tiền công (X001 lô 1: 40 × 25.600 + 6.000 = 1.030.000 như bảng tính).
  assert.equal(laborCost({ agreedQty: 40, laborUnitPrice: 25_600, adjustment: 6_000 }, 40).amount, 1_030_000);

  // ───────── 2. Ô trống KHÔNG phải 0 ─────────
  const khongGia = laborCost({ agreedQty: 300, laborUnitPrice: null, adjustment: 0 }, 300);
  assert.equal(khongGia.amount, null, "chưa có đơn giá ⇒ tiền công CHƯA BIẾT, không phải 0đ");
  const ttKhongGia = paymentStatus(khongGia.amount, [{ kind: "DEPOSIT", amount: 5_000_000 }]);
  assert.equal(ttKhongGia.state, "NO_PRICE", "chưa biết phải trả bao nhiêu thì không được nói 'Đã xong' hay 'Trả thừa'");
  assert.equal(ttKhongGia.remaining, null, "còn phải trả của khoản chưa biết là CHƯA BIẾT");
  assert.equal(ttKhongGia.paid, 5_000_000, "nhưng số ĐÃ trả vẫn là số thật");
  // Chưa chốt SL: tạm tính theo số xưởng ĐÃ TRẢ (Q003 lô 1 đặt 400 mà xưởng chỉ trả 240) — không theo số đặt.
  const tamTinh = laborCost({ agreedQty: null, laborUnitPrice: 60_000, adjustment: 0 }, 240);
  assert.deepEqual([tamTinh.amount, tamTinh.basis], [14_400_000, "DELIVERED_ESTIMATE"]);
  assert.equal(laborCost({ agreedQty: null, laborUnitPrice: 60_000, adjustment: 0 }, 0).amount, null, "chưa chốt và xưởng chưa trả chiếc nào ⇒ chưa có căn cứ nào để nhân");

  // ───────── Tiền đã trả: cọc, hoàn tiền, trả thừa ─────────
  assert.deepEqual(paidTotals([{ kind: "DEPOSIT", amount: 3_000_000 }, { kind: "PAYMENT", amount: 5_000_000 }, { kind: "REFUND", amount: 1_000_000 }]), { paid: 7_000_000, deposit: 3_000_000, count: 3 });
  assert.equal(paymentStatus(10_000_000, [{ kind: "DEPOSIT", amount: 3_000_000 }]).state, "DEPOSITED", "mới trả cọc là 'Đã cọc', không phải 'Trả một phần'");
  assert.equal(paymentStatus(10_000_000, []).state, "UNPAID");
  assert.equal(paymentStatus(10_000_000, [{ kind: "PAYMENT", amount: 10_500_000 }]).state, "OVERPAID");
  assert.equal(paymentStatus(10_000_000, [{ kind: "PAYMENT", amount: 10_500_000 }, { kind: "REFUND", amount: 500_000 }]).state, "PAID", "bên kia hoàn phần thừa ⇒ về đúng số");

  // ───────── Trạng thái trả hàng ─────────
  const now = new Date("2026-09-25T05:00:00Z");
  const han = new Date(now.getTime() - 3 * DAY);
  assert.equal(deliveryStatus({ status: "DONE", orderedQty: 400, agreedQty: null, dueDate: han }, 240, now).state, "DONE", "'Đã xong' do người bấm — đặt 400 trả 240 rồi dừng vẫn là xong");
  assert.equal(deliveryStatus({ status: "DONE", orderedQty: 400, agreedQty: null, dueDate: han }, 240, now).overdueDays, null, "lô đã xong không còn trễ hạn");
  assert.equal(deliveryStatus({ status: "OPEN", orderedQty: 400, agreedQty: null, dueDate: han }, 100, now).overdueDays, 3);
  assert.equal(deliveryStatus({ status: "OPEN", orderedQty: 400, agreedQty: null, dueDate: new Date(now.getTime() + DAY) }, 0, now).overdueDays, null);
  assert.equal(deliveryStatus({ status: "OPEN", orderedQty: 400, agreedQty: 380, dueDate: null }, 0, now).target, 380, "đích đếm theo SL đã chốt khi có");

  // ───────── 3. Giá SX thực tế = (vải + công) / số xưởng thực trả ─────────
  const lo = batchActualCost({ fabricSource: "SHOP", fabricAmount: 19_400_000, fabricOrderCount: 1, labor: laborCost({ agreedQty: 240, laborUnitPrice: 60_000, adjustment: 0 }, 240), delivered: 240, status: "DONE" });
  assert.equal(lo.total, 33_800_000);
  assert.equal(lo.unitCost, Math.round(33_800_000 / 240));
  assert.equal(lo.provisional, false);
  const thieuVai = batchActualCost({ fabricSource: "SHOP", fabricAmount: 0, fabricOrderCount: 0, labor: q2l1, delivered: 335, status: "DONE" });
  assert.equal(thieuVai.unitCost, null, "shop lo vải mà chưa gán đợt vải nào ⇒ CHƯA BIẾT, không phải giá rẻ bằng tiền công");
  assert.equal(thieuVai.fabricCost, null);
  const xuongLoVai = batchActualCost({ fabricSource: "WORKSHOP", fabricAmount: 0, fabricOrderCount: 0, labor: q2l1, delivered: 335, status: "DONE" });
  assert.equal(xuongLoVai.unitCost, 60_000, "xưởng lo vải ⇒ tiền vải 0đ là THẬT, giá SX = giá trọn gói");
  assert.equal(batchActualCost({ fabricSource: "SHOP", fabricAmount: 1, fabricOrderCount: 1, labor: q2l1, delivered: 0, status: "OPEN" }).unitCost, null, "chưa trả chiếc nào ⇒ không chia cho 0");
  assert.equal(batchActualCost({ fabricSource: "SHOP", fabricAmount: 1_000, fabricOrderCount: 1, labor: tamTinh, delivered: 240, status: "DONE" }).provisional, true, "SL chưa chốt ⇒ tạm tính");
  assert.equal(batchActualCost({ fabricSource: "SHOP", fabricAmount: 1_000, fabricOrderCount: 1, labor: q2l1, delivered: 335, status: "OPEN" }).provisional, true, "lô chưa trả xong ⇒ tạm tính");

  // Cấp MÃ: vải mua một lần dùng cho hai lô, và một đợt vải chưa gán lô, đều vào tử số.
  const ma = productActualCost({
    batches: [
      { status: "DONE", fabricSource: "SHOP", delivered: 335, labor: q2l1 },
      { status: "DONE", fabricSource: "SHOP", delivered: 1039, labor: q2l2 },
      // Lô huỷ giữa chừng: xưởng đã giao 20 chiếc, chưa có đơn giá — không được kéo cả mã về CHƯA BIẾT.
      { status: "CANCELLED", fabricSource: "SHOP", delivered: 20, labor: khongGia },
    ],
    fabricAmount: 50_000_000,
    fabricOrderCount: 3,
  });
  assert.equal(ma.delivered, 1374);
  assert.equal(ma.unitCost, Math.round((50_000_000 + 20_100_000 + 62_340_000) / 1374), "lô huỷ không kéo cả mã về CHƯA BIẾT");
  const maThieuCong = productActualCost({ batches: [{ status: "OPEN", fabricSource: "SHOP", delivered: 100, labor: khongGia }, { status: "DONE", fabricSource: "SHOP", delivered: 335, labor: q2l1 }], fabricAmount: 5_000_000, fabricOrderCount: 1 });
  assert.equal(maThieuCong.unitCost, null, "một lô đã nhận hàng mà chưa có tiền công ⇒ cả mã chưa tính được (chia thiếu tử số cho đủ mẫu số là giá rẻ giả)");

  // ───────── Nhãn & lược đồ đầu vào ─────────
  for (const s of PAYMENT_STATES) assert.ok(PAYMENT_STATE_LABEL[s] && PAYMENT_STATE_TONE[s], `thiếu nhãn/màu trạng thái thanh toán ${s}`);
  for (const s of DELIVERY_STATES) assert.ok(DELIVERY_STATE_LABEL[s] && DELIVERY_STATE_TONE[s], `thiếu nhãn/màu trạng thái trả hàng ${s}`);
  assert.equal(normalizeProductCode("  q0 02 "), "Q002");
  const lo1 = batchInput.safeParse({ productCode: "Q002", batchNo: "1", orderedAt: "2026-08-01", orderedQty: "281", agreedQty: "", laborUnitPrice: "" });
  assert.ok(lo1.success);
  assert.equal(lo1.success && lo1.data.agreedQty, null, "ô SL chốt để trống ⇒ null, không phải 0");
  assert.equal(lo1.success && lo1.data.laborUnitPrice, null, "ô đơn giá để trống ⇒ null, không phải 0");
  assert.ok(!("laborTotal" in (lo1.success ? lo1.data : {})), "không có ô gõ TỔNG tiền công — tiền công luôn tính từ SL × đơn giá");
  assert.equal(paymentInput.safeParse({ batchId: "a", fabricOrderId: "b", amount: 1, paidAt: "2026-08-01" }).success, false, "một đợt tiền gắn cả lô lẫn đợt vải là tiền bị đếm hai nơi");
  assert.equal(paymentInput.safeParse({ amount: 1, paidAt: "2026-08-01" }).success, false, "tiền không gắn vào đâu là tiền trôi nổi");
  assert.equal(paymentInput.safeParse({ batchId: "a", amount: 0, paidAt: "2026-08-01" }).success, false);

  // ───────── Phạt xưởng ("Hoàn phạt MKT") trừ vào tiền công ─────────
  assert.equal(laborCost({ agreedQty: 335, laborUnitPrice: 60_000, adjustment: 0, penalty: 500_000 }, 335).amount, 19_600_000, "phạt xưởng 500.000 ⇒ trả xưởng ít đi đúng 500.000");
  assert.equal(laborCost({ agreedQty: 335, laborUnitPrice: 60_000, adjustment: 0, penalty: -500_000 }, 335).amount, 20_100_000, "tiền phạt âm không được biến thành tiền thưởng");

  // ───────── 5. Hàng đã đặt mà chưa về, theo từng mẫu ─────────
  const dat = openBatchQtyByVariant(
    [
      { id: "b1", status: "OPEN", cells: { den: 100, do: 50 }, orderedQty: 150, agreedQty: null, dueDate: new Date("2026-10-01T00:00:00Z"), productionOrderId: "po-1" },
      { id: "b2", status: "OPEN", cells: { den: 20 }, orderedQty: 20, agreedQty: null, dueDate: new Date("2026-09-28T00:00:00Z"), productionOrderId: null },
      { id: "b3", status: "DONE", cells: { den: 400 }, orderedQty: 400, agreedQty: null, dueDate: null, productionOrderId: "po-3" },
      { id: "b4", status: "OPEN", cells: {}, orderedQty: 300, agreedQty: null, dueDate: null, productionOrderId: null },
      { id: "b5", status: "OPEN", cells: { do: 30 }, orderedQty: 30, agreedQty: null, dueDate: null, productionOrderId: null },
    ],
    [
      { batchId: "b1", quantity: 40, cells: { den: 40 } },
      { batchId: "b1", quantity: 60, cells: { den: 70, do: -10 } },
      { batchId: "b4", quantity: 100, cells: {} },
      { batchId: "b5", quantity: 12, cells: {} },
    ],
  );
  assert.equal(dat.qtyByVariant.get("den"), 0 + 20, "b1 Đen đặt 100 trả 110 ⇒ còn 0 (không âm); b2 còn 20; lô ĐÃ XONG không đếm");
  assert.equal(dat.qtyByVariant.get("do"), 60, "b1 Đỏ 50 − (−10 trả lại xưởng) = 60; b5 có đợt trả ghi tổng ⇒ không góp");
  assert.equal(dat.earliestDueByVariant.get("den")?.toISOString(), "2026-09-28T00:00:00.000Z", "hạn sớm nhất trong các lô còn hàng chưa về");
  assert.deepEqual([...dat.linkedProductionOrderIds].sort(), ["po-1", "po-3"], "lệnh đã có lô nối vào — kể cả lô đã xong — không được đếm lại ở phía lệnh");
  assert.deepEqual(
    dat.unsplit.map((u) => [u.batchId, u.reason, u.remaining]),
    [
      ["b4", "NO_CELLS", 200],
      ["b5", "DELIVERY_NOT_SPLIT", 18],
    ],
    "lô không trừ được vào mẫu nào phải được ĐẾM RIÊNG kèm lý do",
  );

  // ───────── 6. Đặt đủ thì Lark im, đặt thiếu thì nhắc phần còn thiếu ─────────
  assert.equal(stillShortAfterOrder(5, 3), 2);
  assert.equal(stillShortAfterOrder(5, 9), 0);
  assert.equal(stillShortAfterOrder(5, -2), 5, "số đặt âm (sổ lệch) không được làm thiếu tăng giả");
  const mau = (variantId: string, openPoQty: number): ShortageVariantInput => ({
    variantId, productId: "p", productCode: "Q9", productName: "Áo", color: variantId, size: "M", sku: variantId,
    onHand: 0, stockKnown: true, pancakeStock: null, planSuggested: null, incoming: 0, openPoQty, openPoDueAt: null, alternatives: [],
  });
  const gio = new Date("2026-09-25T03:00:00Z");
  const snap = allocateStock([mau("du", 5), mau("thieu", 2), mau("chua", 0)], [
    { orderId: "o1", systemId: 1, variantId: "du", qty: 5, insertedAt: new Date(gio.getTime() - 3_600_000), promisedAt: null, customer: "A", value: 1 },
    { orderId: "o2", systemId: 2, variantId: "thieu", qty: 5, insertedAt: new Date(gio.getTime() - 3_600_000), promisedAt: null, customer: "B", value: 1 },
    { orderId: "o3", systemId: 3, variantId: "chua", qty: 4, insertedAt: new Date(gio.getTime() - 3_600_000), promisedAt: null, customer: "C", value: 1 },
  ], { now: gio, urgentAfterHours: 24 });
  const r = (id: string) => snap.variants.find((v) => v.variantId === id)!;
  assert.deepEqual([r("du").muted, r("du").stillShortAfterOrder], [true, 0], "đặt đủ ⇒ im");
  assert.deepEqual([r("thieu").muted, r("thieu").stillShortAfterOrder], [false, 3], "đặt 2 thiếu 5 ⇒ nhắc 3");
  assert.deepEqual([r("chua").muted, r("chua").stillShortAfterOrder], [false, 4]);
  assert.equal(snap.totals.waitingOrders, 3, "im trên Lark KHÔNG giấu đơn đang chờ");
  assert.equal(snap.totals.stillShortUnits, 7);
  const the = buildShortageLarkCard(snap, { appUrl: "https://erp.example", reason: "MORNING" });
  const bang = (the.elements as { tag: string; rows?: Record<string, unknown>[]; columns?: { display_name: string }[] }[]).find((e) => e.tag === "table")!;
  assert.deepEqual(bang.rows?.map((x) => x.still), [3, 4], "mẫu đã đặt đủ KHÔNG vào bảng Lark; mẫu còn lại in đúng phần còn thiếu");
  assert.ok(bang.columns?.some((c) => c.display_name === "Còn thiếu sau đặt"));
  const src = readFileSync("lib/alerts/stock-shortage-digest.ts", "utf8");
  assert.ok(/v\.stillShortAfterOrder\]/.test(src), "sổ chống gửi lại phải đếm PHẦN CÒN THIẾU SAU ĐẶT — đếm số thiếu gộp thì đặt bổ sung xong Lark vẫn nhắc");

  // ───────── 4. Sổ công nợ KHÔNG được lọt vào phép tính nào khác ─────────
  /*
    Giá vốn vào lợi nhuận chỉ đi theo phiếu kho (mục 15). Nếu một truy vấn lợi nhuận / chi phí / dòng
    tiền đọc tiền trả xưởng ở đây, mỗi chiếc áo bị tính giá vốn hai lần — và con số vẫn "trông hợp lý".
    Nên chỉ bốn tệp của chính sổ được nhắc tới bốn bảng này.
  */
  const DUOC_PHEP = new Set(["lib/queries/workshop-ledger.ts", "lib/actions/workshop-ledger.ts", "lib/workshop/sheet-import-db.ts"]);
  // Trang Thiếu hàng / Quyết định vốn chỉ nhận SỐ LƯỢNG qua `openBatchQtyByVariantFromLedger`, không đọc bảng.
  assert.ok(readFileSync("lib/queries/inventory-decision.ts", "utf8").includes("openBatchQtyByVariantFromLedger()"), "hàng đã đặt theo mẫu phải đi qua đúng một hàm của sổ");
  const tep = execSync("git ls-files lib app components && git ls-files --others --exclude-standard lib app components", { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const lot = tep.filter((f) => !DUOC_PHEP.has(f) && /productionBatches|productionDeliveries|fabricOrders|supplierPayments|production_batches|production_deliveries|fabric_orders|supplier_payments/.test(readFileSync(f, "utf8")));
  assert.deepEqual(lot, [], `sổ đặt xưởng là công nợ và giá thành — chỉ ${[...DUOC_PHEP].join(", ")} được đọc/ghi bốn bảng của nó`);

  console.log("✓ Sổ đặt xưởng (hàm thuần): ra đúng dòng bảng tính Q001/Q002/X001 · ô trống là CHƯA BIẾT · tạm tính theo số xưởng trả · giá SX thực tế không rẻ giả · không lọt vào lợi nhuận");
}

const P = "wsl-";

async function donDep(db: Db) {
  const batches = (await db.select({ id: schema.productionBatches.id }).from(schema.productionBatches).where(like(schema.productionBatches.productCode, "WSL%"))).map((r) => r.id);
  const fabrics = (await db.select({ id: schema.fabricOrders.id }).from(schema.fabricOrders).where(like(schema.fabricOrders.productCode, "WSL%"))).map((r) => r.id);
  if (batches.length) await db.delete(schema.supplierPayments).where(inArray(schema.supplierPayments.batchId, batches));
  if (fabrics.length) await db.delete(schema.supplierPayments).where(inArray(schema.supplierPayments.fabricOrderId, fabrics));
  if (fabrics.length) await db.delete(schema.fabricOrders).where(inArray(schema.fabricOrders.id, fabrics));
  if (batches.length) await db.delete(schema.productionBatches).where(inArray(schema.productionBatches.id, batches));
  const rc = (await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(like(schema.stockReceipts.reference, `${P}%`))).map((r) => r.id);
  if (rc.length) {
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, rc));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, rc));
  }
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testWorkshopLedgerQueries(db: Db) {
  await donDep(db);
  const now = new Date();
  const at = (d: number) => new Date(now.getTime() - d * DAY);
  try {
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm kiểm sổ xưởng", customId: "WSL1" });
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, sku: "WSL1-M", color: "Đỏ", size: "M", retailPrice: 400_000 });
    // Phiếu kho ghi giá 150.000 — thứ báo cáo lợi nhuận đang dùng; sổ xưởng chỉ ĐẶT CẠNH, không sửa.
    await db.insert(schema.stockReceipts).values({ id: `${P}rc`, kind: "RECEIPT", receivedAt: at(1), reference: `${P}rc`, totalQuantity: 10, totalCost: 1_500_000 });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}rc-i`, receiptId: `${P}rc`, variantId: `${P}var`, quantity: 10, unitCost: 150_000 });

    await db.insert(schema.productionBatches).values([
      { id: `${P}b1`, productId: `${P}prod`, productCode: "WSL1", batchNo: 1, orderedAt: at(30), orderedQty: 400, agreedQty: 240, laborUnitPrice: 60_000, status: "DONE", dueDate: at(20) },
      { id: `${P}b2`, productId: `${P}prod`, productCode: "WSL1", batchNo: 2, orderedAt: at(10), orderedQty: 300, laborUnitPrice: null, status: "OPEN", dueDate: at(2) },
    ]);

    // ── Ràng buộc ở CSDL, không chỉ ở lược đồ đầu vào ──
    await assert.rejects(
      () => db.insert(schema.productionBatches).values({ id: `${P}dup`, productCode: "WSL1", batchNo: 1, orderedAt: at(1), orderedQty: 1 }).then(() => undefined),
      viPhamRangBuoc("production_batches_code_no_uq"),
      "hai lô cùng mã cùng số thì tiền trả xưởng không biết về lô nào",
    );
    await assert.rejects(
      () => db.insert(schema.supplierPayments).values({ id: `${P}p-bad`, amount: 1_000, paidAt: at(1) }).then(() => undefined),
      viPhamRangBuoc("supplier_payments_target_check"),
      "đợt tiền không gắn lô / đợt vải nào phải bị CSDL chặn",
    );
    await assert.rejects(
      () => db.insert(schema.productionDeliveries).values({ id: `${P}d-bad`, batchId: `${P}b1`, deliveredAt: at(1), quantity: 0 }).then(() => undefined),
      viPhamRangBuoc("production_deliveries_qty_check"),
    );

    await db.insert(schema.productionDeliveries).values([
      { id: `${P}d1`, batchId: `${P}b1`, deliveredAt: at(25), quantity: 115, note: "đỏ" },
      { id: `${P}d2`, batchId: `${P}b1`, deliveredAt: at(24), quantity: 48 },
      { id: `${P}d3`, batchId: `${P}b1`, deliveredAt: at(22), quantity: 77 },
      { id: `${P}d4`, batchId: `${P}b2`, deliveredAt: at(1), quantity: 50 },
    ]);
    await db.insert(schema.fabricOrders).values([
      { id: `${P}f1`, productId: `${P}prod`, productCode: "WSL1", batchId: `${P}b1`, orderedAt: at(32), receivedAt: at(31), amount: 19_400_000, quantity: 220.5, unit: "m" },
      { id: `${P}f2`, productId: `${P}prod`, productCode: "WSL1", batchId: null, orderedAt: at(12), amount: 3_000_000 },
    ]);
    await db.insert(schema.supplierPayments).values([
      { id: `${P}p1`, batchId: `${P}b1`, kind: "DEPOSIT", amount: 4_000_000, paidAt: at(30) },
      { id: `${P}p2`, batchId: `${P}b1`, kind: "PAYMENT", amount: 10_000_000, paidAt: at(20) },
      { id: `${P}p3`, batchId: `${P}b2`, kind: "DEPOSIT", amount: 2_000_000, paidAt: at(9) },
      { id: `${P}p4`, fabricOrderId: `${P}f1`, kind: "PAYMENT", amount: 19_400_000, paidAt: at(30) },
    ]);
    await assert.rejects(
      () => db.delete(schema.productionBatches).where(eq(schema.productionBatches.id, `${P}b1`)).then(() => undefined),
      "xoá lô đã có tiền trả là xoá dấu vết tiền — CSDL phải chặn (RESTRICT)",
    );

    const s = await getWorkshopLedger(now);
    const b1 = s.batches.find((b) => b.id === `${P}b1`)!;
    const b2 = s.batches.find((b) => b.id === `${P}b2`)!;
    assert.equal(b1.delivered, 240, "115 + 48 + 77");
    assert.equal(b1.labor.amount, 14_400_000);
    assert.deepEqual([b1.pay.paid, b1.pay.deposit, b1.pay.remaining, b1.pay.state], [14_000_000, 4_000_000, 400_000, "PARTIAL"]);
    assert.equal(b1.delivery.state, "DONE");
    assert.equal(b1.cost.unitCost, Math.round((19_400_000 + 14_400_000) / 240));

    assert.equal(b2.pay.state, "NO_PRICE", "lô chưa có đơn giá không được hiện 'Đã cọc' như thể biết còn nợ bao nhiêu");
    assert.equal(b2.pay.remaining, null);
    assert.equal(b2.delivery.overdueDays, 2, "lô còn mở, quá hạn 2 ngày");
    assert.equal(b2.cost.unitCost, null);

    const f1 = s.fabrics.find((f) => f.id === `${P}f1`)!;
    assert.deepEqual([f1.pay.state, f1.batchLabel], ["PAID", "WSL1 · lô 1"]);
    assert.equal(s.fabrics.find((f) => f.id === `${P}f2`)!.pay.state, "UNPAID");

    const p4 = s.payments.find((p) => p.id === `${P}p4`)!;
    assert.equal(p4.targetKind, "FABRIC");
    assert.equal(p4.batchIdForLink, `${P}b1`, "tiền vải của lô mở được trang lô");

    const ma = s.products.find((p) => p.productCode === "WSL1")!;
    assert.equal(ma.unassignedFabric, 3_000_000);
    assert.equal(ma.cost.unitCost, null, "lô 2 đã nhận 50 chiếc mà chưa có đơn giá ⇒ cả mã CHƯA TÍNH ĐƯỢC");
    assert.equal(ma.receiptUnitCost, 150_000, "giá trên phiếu kho gần nhất đứng cạnh để so");

    // Chốt đơn giá lô 2 ⇒ mã tính được, và phiếu kho KHÔNG bị đụng tới.
    await db.update(schema.productionBatches).set({ laborUnitPrice: 60_000, agreedQty: 50 }).where(eq(schema.productionBatches.id, `${P}b2`));
    const s2 = await getWorkshopLedger(now);
    const ma2 = s2.products.find((p) => p.productCode === "WSL1")!;
    assert.equal(ma2.cost.unitCost, Math.round((19_400_000 + 3_000_000 + 14_400_000 + 3_000_000) / 290));
    assert.equal(ma2.cost.provisional, true, "lô 2 còn mở ⇒ giá cấp mã là tạm tính");
    const [phieu] = await db.select({ unitCost: schema.stockReceiptItems.unitCost }).from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.id, `${P}rc-i`));
    assert.equal(phieu.unitCost, 150_000, "sổ xưởng không bao giờ sửa giá trên phiếu kho");

    console.log("✓ Sổ đặt xưởng (CSDL): mã + lô là duy nhất · tiền phải gắn đúng một chỗ · lô đã có tiền không xoá được · còn nợ / tạm tính / chưa biết đúng từng lô · giá phiếu kho đặt cạnh, không bị sửa");
  } finally {
    await donDep(db);
  }
}

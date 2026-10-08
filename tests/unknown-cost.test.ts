import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { computePlan } from "@/lib/constants/planning";
import { liveLineUnitCost, liveOrderCogs, orderGrossMargin } from "@/lib/constants/live-cogs";
import { customerEconomicsCore, losingMoneyApplies } from "@/lib/saas/policy";
import { getOrderDetail } from "@/lib/queries/orders";
import { getProductStockPlan, type PlanRow } from "@/lib/queries/planning";
import { getProductDetail } from "@/lib/queries/products";

/**
 * ───────────── GIÁ VỐN CHƯA BIẾT KHÔNG ĐƯỢC IN RA THÀNH 0 (AGENTS.md mục 42, mục 3.13) ─────────────
 *
 * Ba chỗ từng kết thúc chuỗi giá vốn bằng 0:
 *  · chi tiết đơn (`|| 0`) ⇒ "Giá vốn 0 ₫" và lãi gộp = nguyên doanh thu, tô xanh;
 *  · dòng kế hoạch / trang sản phẩm (`coalesce(…, 0)`) ⇒ "vốn 0 ₫", giá trị tồn 0 ₫;
 *  · kinh tế khách SaaS (`?? 0` cho khoản phân bổ chưa biết) ⇒ biên gộp đẹp hơn thật.
 *
 * Theo mục 3.13, đơn giá 0 trên phiếu nhập / giá nhập mẫu mã 0 / giá vốn Pancake 0 đều là CHƯA KHAI GIÁ
 * — nên "0 thật" duy nhất của giá vốn là phần KHÔNG có hàng đi ra (dòng số lượng 0, mẫu mã hết tồn).
 */

const PROD = "uc-prod";
const V_NONE = "uc-v-none"; // không nguồn giá nào
const V_KNOWN = "uc-v-known"; // phiếu nhập 150.000
const V_ZERO = "uc-v-zero"; // phiếu nhập ghi đơn giá 0 = CHƯA KHAI GIÁ (mục 3.13)
const ORDERS = ["uc-o-none", "uc-o-known", "uc-o-mixed", "uc-o-zero"];
const REF = "uc-unknown-cost";

function testPure() {
  // Thứ tự nguồn mục 3.13, chỉ số DƯƠNG là căn cứ.
  assert.deepEqual(liveLineUnitCost({ receipt: 150_000, orderSnapshot: 90_000, variantDefault: 80_000 }), { unitCost: 150_000, source: "RECEIPT" });
  assert.deepEqual(liveLineUnitCost({ receipt: null, orderSnapshot: 90_000, variantDefault: 80_000 }), { unitCost: 90_000, source: "ORDER_SNAPSHOT" });
  assert.deepEqual(liveLineUnitCost({ receipt: 0, orderSnapshot: 0, variantDefault: 80_000 }), { unitCost: 80_000, source: "VARIANT_DEFAULT" });
  assert.deepEqual(liveLineUnitCost({ receipt: 0, orderSnapshot: 0, variantDefault: 0 }), { unitCost: null, source: null }, "ba nguồn đều 0 ⇒ CHƯA BIẾT, không phải 0 ₫");
  assert.deepEqual(liveLineUnitCost({ receipt: undefined, orderSnapshot: Number.NaN, variantDefault: null }), { unitCost: null, source: null });

  assert.equal(liveOrderCogs([{ unitCost: 100_000, quantity: 2 }, { unitCost: 50_000, quantity: 1 }]).cogs, 250_000);
  const mixed = liveOrderCogs([{ unitCost: 100_000, quantity: 2 }, { unitCost: null, quantity: 1 }]);
  assert.equal(mixed.cogs, null, "thiếu giá MỘT dòng ⇒ giá vốn cả đơn CHƯA BIẾT");
  assert.deepEqual({ knownLines: mixed.knownLines, totalLines: mixed.totalLines, knownCogs: mixed.knownCogs }, { knownLines: 1, totalLines: 2, knownCogs: 200_000 });
  assert.equal(liveOrderCogs([]).cogs, null, "đơn không có dòng hàng nào ⇒ không có căn cứ nói 0 ₫");
  assert.equal(liveOrderCogs([{ unitCost: null, quantity: 0 }]).cogs, 0, "không có hàng đi ra là 0 THẬT");

  assert.equal(orderGrossMargin(500_000, null, 30_000, 0), null, "giá vốn chưa biết ⇒ lãi gộp chưa biết");
  assert.equal(orderGrossMargin(500_000, 200_000, 30_000, 10_000), 260_000);

  // Kinh tế khách SaaS.
  const du = customerEconomicsCore({ revenueVnd: 1_000_000, aiCostVnd: 200_000, unpricedAiCalls: 0, allocated: [{ amountVnd: 100_000 }] });
  assert.deepEqual(du, { costVnd: 300_000, costComplete: true, grossProfitVnd: 700_000, marginPct: 70, lossCheckGrossProfitVnd: 700_000 });
  const thieuPhanBo = customerEconomicsCore({ revenueVnd: 1_000_000, aiCostVnd: 200_000, unpricedAiCalls: 0, allocated: [{ amountVnd: 100_000 }, { amountVnd: null }] });
  assert.equal(thieuPhanBo.costComplete, false);
  assert.equal(thieuPhanBo.costVnd, 300_000, "chi phí in ra là phần ĐÃ BIẾT (cận dưới)");
  assert.equal(thieuPhanBo.grossProfitVnd, null, "khoản phân bổ chưa biết số ⇒ lãi gộp chưa đủ dữ liệu, không tính với 0");
  assert.equal(thieuPhanBo.marginPct, null);
  assert.equal(losingMoneyApplies(1_000_000, thieuPhanBo.lossCheckGrossProfitVnd), false, "chưa biết ≠ lỗ");
  const aiChuaDinhGia = customerEconomicsCore({ revenueVnd: 1_000_000, aiCostVnd: 200_000, unpricedAiCalls: 3, allocated: [] });
  assert.equal(aiChuaDinhGia.grossProfitVnd, null, "lượt AI chưa định giá ⇒ lãi gộp chưa đủ dữ liệu");
  // Phần đã biết ĐÃ vượt doanh thu ⇒ lỗ chắc chắn dù thiếu chi phí (chi phí chỉ có thể lớn thêm).
  const loChac = customerEconomicsCore({ revenueVnd: 100_000, aiCostVnd: 300_000, unpricedAiCalls: 0, allocated: [{ amountVnd: null }] });
  assert.equal(loChac.grossProfitVnd, null);
  assert.equal(loChac.lossCheckGrossProfitVnd, -200_000);
  assert.equal(losingMoneyApplies(100_000, loChac.lossCheckGrossProfitVnd), true, "cờ lỗ không được tắt chỉ vì thiếu một khoản chi");
}

async function seed(db: Db) {
  await db.insert(schema.products).values({ id: PROD, name: "Áo kiểm giá vốn chưa biết" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values([
      { id: V_NONE, productId: PROD, sku: "UC-NONE", color: "Đen", size: "M", retailPrice: 400_000 },
      { id: V_KNOWN, productId: PROD, sku: "UC-KNOWN", color: "Trắng", size: "M", retailPrice: 400_000 },
      { id: V_ZERO, productId: PROD, sku: "UC-ZERO", color: "Xám", size: "M", retailPrice: 400_000 },
    ])
    .onConflictDoNothing();
  const [phieu] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date(Date.now() - 3 * 86_400_000), reference: REF, totalQuantity: 15, totalCost: 1_500_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values([
    { receiptId: phieu.id, variantId: V_KNOWN, quantity: 10, unitCost: 150_000 },
    // Phiếu nhập không ghi đơn giá (mã chưa có giá báo MKT) — mục 3.13: "dòng ghi 0 = CHƯA BIẾT".
    { receiptId: phieu.id, variantId: V_ZERO, quantity: 5, unitCost: 0 },
  ]);
  const now = new Date();
  await db
    .insert(schema.orders)
    .values(ORDERS.map((id) => ({ id, stage: "CONFIRMED" as const, status: 1, insertedAt: now, totalPriceAfterDiscount: 400_000 })))
    .onConflictDoNothing();
  const line = (id: string, orderId: string, variantId: string) => ({ id, orderId, variantId, productId: PROD, productName: "Áo kiểm giá vốn chưa biết", quantity: 1, unitPrice: 400_000, lineTotal: 400_000 });
  await db
    .insert(schema.orderItems)
    .values([
      line("uc-i-none", "uc-o-none", V_NONE),
      line("uc-i-known", "uc-o-known", V_KNOWN),
      line("uc-i-mixed-1", "uc-o-mixed", V_KNOWN),
      line("uc-i-mixed-2", "uc-o-mixed", V_NONE),
      line("uc-i-zero", "uc-o-zero", V_ZERO),
    ])
    .onConflictDoNothing();
}

async function cleanup(db: Db) {
  await db.delete(schema.orders).where(inArray(schema.orders.id, ORDERS));
  const phieu = await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.reference, REF));
  if (phieu.length) {
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, phieu.map((p) => p.id)));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, phieu.map((p) => p.id)));
  }
  await db.delete(schema.productVariants).where(eq(schema.productVariants.productId, PROD));
  await db.delete(schema.products).where(eq(schema.products.id, PROD));
  clearMemo();
}

/** Mọi trường mà `computePlan` sinh ra — phần QUYẾT ĐỊNH của dòng kế hoạch. */
function decision(r: PlanRow) {
  const plan = computePlan(r.input);
  return Object.fromEntries(Object.keys(plan).map((k) => [k, r[k as keyof PlanRow]]));
}

export async function testUnknownCost(db: Db) {
  testPure();
  clearMemo();
  await seed(db);
  try {
    // ───────── 1. Chi tiết đơn ─────────
    const none = await getOrderDetail("uc-o-none");
    assert.ok(none);
    assert.equal(none.items[0].liveUnitCost, null, "dòng không nguồn giá nào ⇒ giá vốn dòng CHƯA BIẾT");
    assert.equal(none.liveCogs, null, "đơn không nguồn giá ⇒ giá vốn đơn null, không phải 0 ₫");
    assert.equal(orderGrossMargin(none.totalPriceAfterDiscount, none.liveCogs, none.partnerFee, none.returnFee), null, "lãi gộp không được bằng nguyên doanh thu");
    assert.deepEqual(none.liveCogsCoverage, { knownCogs: 0, knownLines: 0, totalLines: 1 });

    const known = await getOrderDetail("uc-o-known");
    assert.ok(known);
    assert.equal(known.liveCogs, 150_000, "giá vốn có phiếu nhập giữ nguyên con số");
    assert.equal(known.items[0].liveCostSource, "RECEIPT");
    assert.equal(orderGrossMargin(known.totalPriceAfterDiscount, known.liveCogs, known.partnerFee, known.returnFee), 400_000 - 150_000 - known.partnerFee - known.returnFee);

    const mixed = await getOrderDetail("uc-o-mixed");
    assert.ok(mixed);
    assert.equal(mixed.liveCogs, null, "một dòng biết giá, một dòng không ⇒ giá vốn đơn CHƯA BIẾT (không cộng nửa vời)");
    assert.deepEqual(mixed.liveCogsCoverage, { knownCogs: 150_000, knownLines: 1, totalLines: 2 }, "nhưng độ phủ x/y dòng vẫn in được");

    const zero = await getOrderDetail("uc-o-zero");
    assert.ok(zero);
    assert.equal(zero.liveCogs, null, "phiếu nhập đơn giá 0 = CHƯA KHAI GIÁ (mục 3.13) ⇒ không thành giá vốn 0 ₫");

    // ───────── 2. Trang sản phẩm / dòng kế hoạch ─────────
    const detail = await getProductDetail(PROD);
    assert.ok(detail);
    const v = (id: string) => {
      const x = detail.variants.find((y) => y.id === id);
      assert.ok(x?.ledger, `thiếu dòng sổ kho của ${id}`);
      return x;
    };
    assert.equal(v(V_NONE).ledger?.unitCostKnown, null, "mẫu mã không nguồn giá ⇒ giá vốn null");
    assert.equal(v(V_NONE).ledger?.unitCost, 0, "ô cũ `unitCost` giữ kiểu số cho nơi đọc đã tự coi 0 là chưa biết");
    assert.equal(v(V_KNOWN).ledger?.unitCostKnown, 150_000);
    assert.equal(v(V_ZERO).ledger?.unitCostKnown, null, "phiếu nhập giá 0 không phải giá vốn");
    assert.equal(v(V_KNOWN).stockValue, 10 * 150_000, "tồn đã biết giá × giá");
    assert.equal(v(V_ZERO).erpStock, 5, "fixture: mẫu mã có phiếu nhập 5 cái ⇒ biết tồn");
    assert.equal(v(V_ZERO).stockValue, null, "còn hàng mà chưa biết giá ⇒ giá trị tồn CHƯA BIẾT, không phải 0 ₫");
    assert.equal(v(V_NONE).stockValue, null, "chưa biết tồn ⇒ chưa biết giá trị tồn");
    assert.equal(detail.totals.stockValue, 1_500_000, "tổng chỉ cộng phần đã biết giá");
    assert.equal(detail.totals.stockValueUnpriced, 1, "và nói ra có 1 mẫu chưa có giá đứng ngoài tổng");

    // ───────── 3. Quyết định kế hoạch KHÔNG đổi khi giá vốn đổi ─────────
    // Giá vốn không phải đầu vào của `computePlan`. Đo trực tiếp: biết thêm giá của V_ZERO thì chỉ ô
    // giá đổi, mọi trường của phép tính đặt hàng đứng yên.
    const before = (await getProductStockPlan(PROD)).rows.find((r) => r.variantId === V_ZERO);
    assert.ok(before);
    assert.equal(before.unitCostKnown, null);
    assert.ok(!Object.keys(before.input).some((k) => /cost|price/i.test(k)), "PlanInput không được có ô giá — giá vốn không quyết định số đặt");
    await db.update(schema.productVariants).set({ lastImportedPrice: 90_000 }).where(eq(schema.productVariants.id, V_ZERO));
    clearMemo();
    const after = (await getProductStockPlan(PROD)).rows.find((r) => r.variantId === V_ZERO);
    assert.ok(after);
    assert.equal(after.unitCostKnown, 90_000, "giá nhập mẫu mã > 0 là căn cứ bậc 2 của mục 3.13");
    assert.deepEqual(after.input, before.input, "đầu vào kế hoạch không đổi");
    assert.deepEqual(decision(after), decision(before), "quyết định kế hoạch (computePlan) không đổi theo giá vốn");
    assert.deepEqual(decision(before), Object.fromEntries(Object.entries(computePlan(before.input))), "dòng kế hoạch = đúng computePlan của đầu vào");
    assert.equal(after.orderCostKnown, after.suggested === 0 ? 0 : after.suggested * 90_000);
    if (before.suggested > 0) assert.equal(before.orderCostKnown, null, "có đề xuất đặt mà chưa biết giá ⇒ tiền đặt CHƯA BIẾT");
  } finally {
    await cleanup(db);
  }
  console.log("✓ Giá vốn chưa biết: đơn · sản phẩm · kế hoạch · kinh tế khách đều ra null, không ra 0 ₫");
}

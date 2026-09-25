import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { receiptUnitCostFromMarketer } from "@/lib/constants/marketer-price";
import { applyReceiptRepricing, priceReceiptLines, receiptRepricingPlan, summarizeRepricing, type RepricingLine } from "@/lib/inventory/receipt-pricing";
import { stockReceiptSchema } from "@/lib/validation/stock";

/**
 * ═══════════ GIÁ NHẬP KHO = GIÁ BÁO MKT ═══════════
 *
 * Chủ shop chốt 25/09/2026: "Có thể lấy giá báo MKT làm giá ở phần nhập kho, hoặc bỏ phần giá ở khâu
 * nhập kho vì kho không cần biết giá" → chọn "Luôn lấy giá báo MKT". Khoá năm điều:
 *  1. Phiếu nhập mới lấy giá báo theo NGÀY NHẬP; hàng về trước dòng giá đầu tiên lấy dòng đầu tiên.
 *  2. Mốc 01/09/2026 của lương KHÔNG chặn giá nhập (nó giữ lương theo ngày lên đơn, không phải giá lô).
 *  3. Mã chưa có giá báo ⇒ CHƯA BIẾT (null), không phải 0; giá báo 0đ không thành giá 0 trên sổ kho.
 *  4. Định giá phiếu cũ chỉ lấp dòng NHẬP HÀNG đang 0/trống — không ghi đè dòng đã có giá, không đụng
 *     phiếu điều chỉnh, chạy lại không đổi gì thêm.
 *  5. Máy chủ bỏ qua giá client gửi lên ở phiếu nhập (đường ghi đọc `priceReceiptLines`).
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const P = "rpk-";

export function testReceiptPricingPure() {
  const bang = [
    { price: 150_000, effectiveFrom: d("2026-09-10") },
    { price: 120_000, effectiveFrom: d("2026-12-01") },
  ];
  assert.equal(receiptUnitCostFromMarketer([], d("2026-10-01")), null, "chưa khai giá báo ⇒ chưa biết, KHÔNG phải 0");
  assert.equal(receiptUnitCostFromMarketer(bang, d("2026-09-10")), 150_000, "đúng ngày hiệu lực thì áp");
  assert.equal(receiptUnitCostFromMarketer(bang, d("2026-09-02")), 150_000, "hàng về trước ngày khai giá ⇒ lấy dòng giá đầu tiên (một mã một giá từ đầu)");
  assert.equal(receiptUnitCostFromMarketer(bang, d("2026-08-15")), 150_000, "mốc 01/09/2026 của LƯƠNG không chặn giá nhập kho");
  assert.equal(receiptUnitCostFromMarketer(bang, d("2026-12-05")), 120_000, "hàng về sau lúc hạ giá ⇒ giá mới");
  assert.equal(receiptUnitCostFromMarketer([...bang].reverse(), d("2026-11-30")), 150_000, "không phụ thuộc thứ tự dòng");

  const l = (code: string, qty: number, price: number | null, receiptId = "a"): RepricingLine => ({ itemId: `${code}${qty}`, receiptId, variantId: code, code, quantity: qty, receivedAt: d("2026-09-20"), price });
  const t = summarizeRepricing([l("Q004", 100, 160_000, "a"), l("Q004", 50, 160_000, "b"), l("Q005", 30, null, "b")]);
  assert.deepEqual(t.priced, { lines: 2, quantity: 150, amount: 150 * 160_000, receipts: 2 });
  assert.deepEqual(t.missing, { lines: 1, quantity: 30, codes: ["Q005"] }, "mã chưa có giá báo đứng riêng, không cộng 0 ₫ vào tổng");
  assert.equal(t.byCode[0].code, "Q004", "dòng định giá được đứng trước");
  assert.equal(t.byCode.at(-1)?.price, null);

  // Kho không còn phải gửi giá: trường giá là tuỳ chọn.
  const ok = stockReceiptSchema.safeParse({ kind: "RECEIPT", receivedAt: "2026-09-25", reference: "", supplier: "", note: "", items: [{ variantId: "v", quantity: 3 }] });
  assert.ok(ok.success, "phiếu nhập không mang giá vẫn hợp lệ");
  assert.equal(ok.success && ok.data.items[0].unitCost, 0);

  // Đường ghi: giá phiếu nhập do máy chủ đọc từ giá báo, không lấy từ client.
  const src = readFileSync("lib/actions/stock.ts", "utf8");
  assert.match(src, /priceReceiptLines\(db, variantIds, vnStartOfDay\(data\.receivedAt\)\)/, "createStockReceipt phải định giá phiếu nhập theo giá báo ở ngày nhập");
  assert.match(src, /unitCost: dinhGia \? \(dinhGia\.price\.get\(i\.variantId\) \?\? 0\) : i\.unitCost/, "phiếu nhập bỏ qua giá client gửi; loại phiếu khác giữ nguyên");
  const dlg = readFileSync("app/(dashboard)/inventory/receipts/receipt-dialog.tsx", "utf8");
  assert.ok(!/Giá nhập \(₫\)/.test(dlg), "form nhập hàng không còn cột giá — kho không cần biết giá");
  console.log("✓ Giá nhập kho = giá báo MKT (hàm thuần): theo ngày nhập · trước dòng đầu lấy dòng đầu · không chặn bởi mốc lương · chưa có giá báo ⇒ chưa biết");
}

async function donDep(db: Db) {
  await db.delete(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like 'rpk-%'`);
  await db.delete(schema.stockReceipts).where(sql`${schema.stockReceipts.id} like 'rpk-%'`);
  await db.delete(schema.marketerPrices).where(sql`${schema.marketerPrices.productId} like 'rpk-%'`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like 'rpk-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'rpk-%'`);
}

export async function testReceiptPricingDb(db: Db) {
  await donDep(db);
  try {
    await db.insert(schema.products).values([
      { id: `${P}p1`, name: "Đầm giá báo kho", customId: "RPK1" },
      { id: `${P}p2`, name: "Áo chưa có giá báo", customId: "RPK2" },
      { id: `${P}p3`, name: "Quần giá báo 0", customId: "RPK3" },
    ]);
    await db.insert(schema.productVariants).values([
      { id: `${P}v1`, productId: `${P}p1`, sku: "RPK1-M", color: "Đen", size: "M" },
      { id: `${P}v1b`, productId: `${P}p1`, sku: "RPK1-L", color: "Đen", size: "L" },
      { id: `${P}v2`, productId: `${P}p2`, sku: "RPK2-M", color: "Trắng", size: "M" },
      { id: `${P}v3`, productId: `${P}p3`, sku: "RPK3-M", color: "Xanh", size: "M" },
    ]);
    await db.insert(schema.marketerPrices).values([
      { productId: `${P}p1`, productCode: "RPK1", price: 160_000, effectiveFrom: d("2031-01-10") },
      { productId: `${P}p1`, productCode: "RPK1", price: 110_000, effectiveFrom: d("2031-03-01") },
      { productId: `${P}p3`, productCode: "RPK3", price: 0, effectiveFrom: d("2031-01-01") },
    ]);

    // ── Phiếu MỚI: giá theo ngày nhập, mã thiếu giá báo nói ra tên ──
    const moi = await priceReceiptLines(db, [`${P}v1`, `${P}v1b`, `${P}v2`, `${P}v3`], d("2031-03-05"));
    assert.equal(moi.price.get(`${P}v1`), 110_000, "nhập sau lúc hạ giá ⇒ giá đã hạ");
    assert.equal(moi.price.get(`${P}v1b`), 110_000, "mọi mẫu mã của cùng mã hàng dùng chung giá báo");
    assert.equal(moi.price.has(`${P}v2`), false);
    assert.equal(moi.price.has(`${P}v3`), false, "giá báo 0đ không thành giá 0 trên sổ kho (giá 0 ở đó nghĩa là CHƯA BIẾT)");
    assert.deepEqual(moi.missing, ["RPK2", "RPK3"]);
    assert.equal((await priceReceiptLines(db, [`${P}v1`], d("2031-01-02"))).price.get(`${P}v1`), 160_000, "hàng về trước ngày khai giá ⇒ dòng giá đầu tiên");

    // ── Phiếu CŨ: ba dòng giá 0 + một dòng đã có giá + một phiếu điều chỉnh giá 0 ──
    await db.insert(schema.stockReceipts).values([
      { id: `${P}r1`, kind: "RECEIPT", receivedAt: d("2031-02-01"), totalQuantity: 190, totalCost: 10 * 90_000 },
      { id: `${P}r2`, kind: "RECEIPT", receivedAt: d("2031-03-10"), totalQuantity: 40, totalCost: 0 },
      { id: `${P}r3`, kind: "ADJUSTMENT", receivedAt: d("2031-03-10"), totalQuantity: 5, totalCost: 0 },
    ]);
    await db.insert(schema.stockReceiptItems).values([
      { id: `${P}i1`, receiptId: `${P}r1`, variantId: `${P}v1`, quantity: 100, unitCost: 0 },
      { id: `${P}i2`, receiptId: `${P}r1`, variantId: `${P}v1b`, quantity: 10, unitCost: 90_000 },
      { id: `${P}i3`, receiptId: `${P}r1`, variantId: `${P}v2`, quantity: 80, unitCost: 0 },
      { id: `${P}i4`, receiptId: `${P}r2`, variantId: `${P}v1`, quantity: 40, unitCost: 0 },
      { id: `${P}i5`, receiptId: `${P}r3`, variantId: `${P}v1`, quantity: 5, unitCost: 0 },
    ]);
    const plan = await receiptRepricingPlan(db);
    const cuaTa = plan.lines.filter((x) => x.itemId.startsWith(P));
    assert.deepEqual(cuaTa.map((x) => x.itemId).sort(), [`${P}i1`, `${P}i3`, `${P}i4`], "chỉ dòng NHẬP HÀNG giá 0 — dòng đã có giá và phiếu điều chỉnh không phải ứng viên");
    assert.equal(cuaTa.find((x) => x.itemId === `${P}i1`)?.price, 160_000, "phiếu 01/02 ⇒ giá 160.000");
    assert.equal(cuaTa.find((x) => x.itemId === `${P}i4`)?.price, 110_000, "phiếu 10/03 ⇒ giá đã hạ 110.000");
    assert.equal(cuaTa.find((x) => x.itemId === `${P}i3`)?.price, null, "mã chưa có giá báo ⇒ để nguyên, không đoán");

    const done = await applyReceiptRepricing(db, { ...plan, lines: cuaTa });
    assert.equal(done.lines, 2);
    const items = await db.select({ id: schema.stockReceiptItems.id, unitCost: schema.stockReceiptItems.unitCost }).from(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like 'rpk-%'`);
    const gia = Object.fromEntries(items.map((x) => [x.id, x.unitCost]));
    assert.equal(gia[`${P}i1`], 160_000);
    assert.equal(gia[`${P}i2`], 90_000, "dòng đã có giá thật KHÔNG bị ghi đè");
    assert.equal(gia[`${P}i3`], 0, "mã chưa có giá báo vẫn 0 = chưa biết");
    assert.equal(gia[`${P}i4`], 110_000);
    assert.equal(gia[`${P}i5`], 0, "phiếu điều chỉnh không bị đụng");
    const tong = await db.select({ id: schema.stockReceipts.id, totalCost: schema.stockReceipts.totalCost }).from(schema.stockReceipts).where(inArray(schema.stockReceipts.id, [`${P}r1`, `${P}r2`]));
    assert.equal(tong.find((x) => x.id === `${P}r1`)?.totalCost, 100 * 160_000 + 10 * 90_000, "tổng phiếu tính lại từ dòng");
    assert.equal(tong.find((x) => x.id === `${P}r2`)?.totalCost, 40 * 110_000);

    // Chạy lại: không còn gì để lấp, trừ mã chưa có giá báo.
    const lai = (await receiptRepricingPlan(db)).lines.filter((x) => x.itemId.startsWith(P));
    assert.deepEqual(lai.map((x) => x.itemId), [`${P}i3`], "chạy hai lần không ghi thêm");
    // Người vừa sửa tay dòng i3 giữa lúc xem và lúc ghi ⇒ không bị đè.
    await db.update(schema.stockReceiptItems).set({ unitCost: 70_000 }).where(eq(schema.stockReceiptItems.id, `${P}i3`));
    const khongDe = await applyReceiptRepricing(db, { ...plan, lines: [{ ...cuaTa.find((x) => x.itemId === `${P}i3`)!, price: 999_000 }] });
    assert.equal(khongDe.lines, 0, "điều kiện 'đang 0' đi cùng lệnh cập nhật ⇒ giá vừa sửa tay không bị đè");
    console.log("✓ Định giá phiếu nhập theo giá báo MKT: chỉ lấp dòng nhập hàng giá 0 · không đè giá thật · không đụng điều chỉnh · chạy lại không đổi");
  } finally {
    await donDep(db);
  }
}

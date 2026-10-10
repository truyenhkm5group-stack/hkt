/**
 * ═══════════ QUY CÁCH ≠ SỐ LƯỢNG (10/10/2026 · HSLC «Việt Phệ») ═══════════
 *
 * Khách «A lấy thử 2kg», danh mục có mẫu mã «2kg» = 540.000 ₫ ⇒ bot lên 2kg × 2 = 1.080.000 ₫ (4kg, gấp đôi tiền). Máy chủ bắt
 * đúng mẫu lỗi đó và trả câu sửa cho model; ca khách THẬT SỰ muốn nhiều gói (nói «4kg», «2 túi», «x2») không bị chặn.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gramsMentioned, packQuantityMistake, QUANTITY_HINT } from "@/lib/sales-chatbot/tools";
import { DEFAULT_VOLUME_DISCOUNT, toUnitPacks, volumeDiscountFor, volumeDiscountPolicyText } from "@/lib/sales-chatbot/volume-discount";

export function testPackQuantity() {
  assert.deepEqual(gramsMentioned("A lấy thử 2kg trc. Sđt 0903648768"), [2000]);
  assert.deepEqual(gramsMentioned("lấy 0,5 kg chả mực với 500g chả cá, 3 ký nữa"), [500, 500, 3000]);
  assert.deepEqual(gramsMentioned("SĐT 0903648768, hẻm 354"), [], "số điện thoại / số nhà không phải khối lượng");

  const two = (quantity: number) => [{ name: "Chả cá thu (2kg)", quantity, weightGrams: 2000 }];
  const viet = "A lấy thử 2kg trc. Em ghi địa chỉ giúp A: A.Việt - Kho Bulong, hẻm 354 Lý Thường Kiệt, phường Diên Hồng, TpHCM. Sđt 0903648768";
  const msg = packQuantityMistake(two(2), viet);
  assert.ok(msg && /quantity = 1/.test(msg) && /4kg/.test(msg), `ca thật «Việt Phệ» bị bắt: ${msg}`);
  assert.equal(packQuantityMistake(two(1), viet), null, "2kg × 1 đúng ý khách");
  assert.equal(packQuantityMistake([{ name: "Chả cá thu (1kg)", quantity: 2, weightGrams: 1000 }], viet), null, "1kg × 2 = 2kg đúng ý khách");
  assert.equal(packQuantityMistake(two(2), "cho a 4kg nhé"), null, "khách nói tổng 4kg ⇒ 2 gói 2kg là đúng");
  assert.equal(packQuantityMistake(two(2), "lấy 2 túi 2kg"), null, "khách nói rõ số gói");
  assert.equal(packQuantityMistake(two(2), "2kg x2 nha"), null);
  assert.equal(packQuantityMistake(two(2), "lấy 2 hộp loại 2kg"), null);
  assert.equal(packQuantityMistake(two(2), "ok em"), null, "câu không nói khối lượng ⇒ không đoán");
  assert.equal(packQuantityMistake([{ name: "Nước mắm", quantity: 2, weightGrams: null }], viet), null, "mẫu mã không rõ khối lượng ⇒ không đoán");
  assert.ok(/KHÔNG BAO GIỜ 2kg × 2/.test(QUANTITY_HINT));

  // Luật gói đơn vị + giảm theo khối lượng (chủ shop 10/10/2026) — phần thuần.
  const on = { enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "ONCE" as const };
  assert.deepEqual([1000, 2000, 3000, 4000, 5000].map((g) => volumeDiscountFor(g, on)), [0, 20_000, 20_000, 20_000, 20_000]);
  assert.deepEqual([1000, 2000, 3000, 4000, 5000].map((g) => volumeDiscountFor(g, { ...on, mode: "PER_STEP" })), [0, 20_000, 20_000, 40_000, 40_000]);
  assert.equal(volumeDiscountFor(null, on), 0, "không rõ khối lượng ⇒ không giảm (không đoán)");
  assert.equal(volumeDiscountFor(4000, DEFAULT_VOLUME_DISCOUNT), 0, "mặc định TẮT");
  const cat = [
    { variantId: "1kg", productId: "cct", price: 280_000, weightGrams: 1000 },
    { variantId: "2kg", productId: "cct", price: 540_000, weightGrams: 2000 },
    { variantId: "05kg", productId: "cct", price: 140_000, weightGrams: 500, addOnOnly: true },
    { variantId: "muc2", productId: "muc", price: 780_000, weightGrams: 2000 },
  ];
  assert.deepEqual(toUnitPacks([{ variantId: "2kg", quantity: 2 }, { variantId: "1kg", quantity: 1 }], cat, on), [{ variantId: "1kg", quantity: 5 }]);
  assert.deepEqual(toUnitPacks([{ variantId: "05kg", quantity: 1 }], cat, on), [{ variantId: "05kg", quantity: 1 }], "gói 0,5kg bán kèm giữ nguyên");
  assert.deepEqual(toUnitPacks([{ variantId: "muc2", quantity: 1 }], cat, on), [{ variantId: "muc2", quantity: 1 }], "món không có gói 1kg ⇒ giữ nguyên, không bịa mẫu mã");
  assert.deepEqual(toUnitPacks([{ variantId: "2kg", quantity: 1 }], cat, { ...on, enabled: false }), [{ variantId: "2kg", quantity: 1 }], "luật tắt ⇒ không đổi gì");
  assert.match(volumeDiscountPolicyText(on, (n) => `${n.toLocaleString("vi-VN")} ₫`), /từ 2kg .*20\.000 ₫/);

  const src = readFileSync("lib/sales-chatbot/tools.ts", "utf8");
  assert.match(src, /const packMistake = v\.data\.items \? packQuantityMistake\(priced.asked, ctx\.lastUserText\) : null;/, "lên / sửa đơn nháp đi qua phép kiểm");
  assert.equal((src.match(/quantity: \{ type: "integer", minimum: 1, description: QUANTITY_HINT \}/g) ?? []).length, 2, "lược đồ create + update mô tả nghĩa của quantity");
  console.log("✓ Quy cách ≠ số lượng: «lấy 2kg» + mẫu mã 2kg ⇒ không bao giờ × 2 · «4kg» / «2 túi» / «x2» vẫn lên được · không rõ khối lượng ⇒ không đoán");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { valuePurchase } from "@/lib/queries/profit-nominal";

/**
 * ═══════════ GIÁ TRỊ HÀNG NHẬP KHI PHIẾU NHẬP KHÔNG GHI ĐƠN GIÁ ═══════════
 *
 * Chủ shop chốt 25/09/2026: dòng phiếu nhập không ghi đơn giá được định giá bằng giá vốn DỰ TÍNH
 * đặt tay ở "Bàn dự tính". Trước đó phần ấy bị tính 0 ₫ và "LN theo hàng nhập" in lãi giả — Q005
 * +42 tr, Q004 +23,6 tr trong khi tiền hàng của hai mã chưa hề được trừ.
 *
 * Khoá bốn điều:
 *  1. Không thiếu giá ⇒ đúng số trên phiếu, không đụng giá dự tính.
 *  2. Thiếu giá + có giá dự tính ⇒ phiếu + số sp thiếu × giá dự tính, phần dự tính tách riêng.
 *  3. Thiếu giá, KHÔNG giá dự tính ⇒ CHƯA BIẾT — không bao giờ là "biết, bằng 0".
 *  4. Màn hình: ô LN theo hàng nhập đeo cờ `profitOnPurchaseKnown` (in "—" khi chưa biết), và ô
 *     "Đặt giá dự tính" hiện cả ở mã có phiếu nhập thiếu giá.
 */
export function testPurchaseValuation() {
  assert.deepEqual(valuePurchase(undefined, null), { cost: 0, known: true, unpricedQty: 0, estimated: 0 }, "không nhập gì ⇒ 0 THẬT");
  assert.deepEqual(valuePurchase({ cost: 5_000_000, unknownQty: 0 }, { unitCost: 160_000 }), { cost: 5_000_000, known: true, unpricedQty: 0, estimated: 0 }, "phiếu đủ giá ⇒ giá dự tính KHÔNG được chen vào");
  assert.deepEqual(
    valuePurchase({ cost: 1_000_000, unknownQty: 195 }, { unitCost: 160_000 }),
    { cost: 1_000_000 + 195 * 160_000, known: true, unpricedQty: 195, estimated: 195 * 160_000 },
    "195 sp thiếu giá × 160.000 ₫ dự tính, cộng phần có giá trên phiếu",
  );
  const chuaBiet = valuePurchase({ cost: 0, unknownQty: 266 }, null);
  assert.equal(chuaBiet.known, false, "thiếu giá mà không có giá dự tính ⇒ CHƯA BIẾT, không phải 0 ₫");
  assert.equal(chuaBiet.unpricedQty, 266);
  assert.equal(valuePurchase({ cost: 0, unknownQty: 10 }, { unitCost: 0 }).known, false, "giá dự tính 0 ₫ không phải một cái giá");

  const tab = readFileSync("app/(dashboard)/reports/nominal-tab.tsx", "utf8");
  assert.ok(/value=\{r\.profitOnPurchase\}\s*known=\{r\.profitOnPurchaseKnown\}/.test(tab), "ô LN theo hàng nhập phải đeo cờ profitOnPurchaseKnown — chưa biết thì in —, không in lãi giả");
  assert.ok(/value=\{t\.profitOnPurchase\}\s*known=\{t\.profitOnPurchaseKnown\}/.test(tab), "dòng Tổng cũng vậy");
  const ban = readFileSync("app/(dashboard)/reports/ads-ceiling-table.tsx", "utf8");
  assert.ok(/const coCho = r\.cogsUnknownQty > 0 \|\| r\.purchaseUnpricedQty > 0;/.test(ban), "ô Đặt giá dự tính phải hiện cả ở mã có phiếu nhập thiếu đơn giá");
  console.log("✓ Hàng nhập thiếu đơn giá: định giá bằng giá dự tính (tách riêng, dán nhãn) · không giá dự tính ⇒ chưa biết · LN theo hàng nhập không còn in lãi giả");
}

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PANCAKE_POS_WEB, pancakeConversationUrl, pancakePosOrderSearchUrl, pancakePosOrderUrl, pancakePosProductsUrl } from "@/lib/constants/pancake";

/**
 * ═══════════ LIÊN KẾT SANG WEB POS PANCAKE ═══════════
 *
 * 27/09/2026 cả bốn nút "Mở trên Pancake / POS" của ERP đều hỏng, và không bài kiểm nào thấy: mỗi
 * trang tự gõ một mẫu đường dẫn đoán ra. Đo thật: `/shop/<id>/orders?id=…` → 404, `/shop/<id>/products`
 * → 404, `/shop/orders?search=…` → POS đọc "orders" thành mã shop. Mẫu đúng đọc từ chính mã web POS
 * (xem chú thích ở `lib/constants/pancake.ts`).
 *
 * Bài này khoá hai điều: (1) mẫu đường dẫn, (2) KHÔNG tệp nào ngoài `lib/constants/pancake.ts` tự gõ
 * `pos.pancake.vn` — một bản gõ tay thứ hai là đúng thứ đã hỏng bốn lần cùng lúc.
 */
export function testPancakeLinks() {
  // ───────── 1. Một đơn: trang `order` SỐ ÍT, tham số `order_id` = orders.id ─────────
  assert.equal(pancakePosOrderUrl("0f1e-42", "408063069"), `${PANCAKE_POS_WEB}/shop/408063069/order?order_id=0f1e-42`);
  const url = pancakePosOrderUrl("123", "9") ?? "";
  assert.ok(!/\/orders(\?|$|\/)/.test(url), "web POS không có trang 'orders' số nhiều — đường dẫn đó trả 404");
  assert.ok(!/[?&]id=/.test(url), "tham số mở một đơn là order_id, không phải id");
  // Không biết shop ⇒ KHÔNG có liên kết (mở nhầm shop tệ hơn không có nút).
  assert.equal(pancakePosOrderUrl("123", null), null);
  assert.equal(pancakePosOrderUrl("123", "  "), null);
  assert.equal(pancakePosOrderUrl("", "9"), null);

  // ───────── 2. Danh sách đơn lọc theo từ khoá: tham số POS đọc từ URL là o_c_i ─────────
  assert.equal(pancakePosOrderSearchUrl("9", 6304), `${PANCAKE_POS_WEB}/shop/9/order?o_c_i=6304`);
  assert.equal(pancakePosOrderSearchUrl("9", null), `${PANCAKE_POS_WEB}/shop/9/order`, "không có từ khoá ⇒ danh sách trần, không phải ?o_c_i= rỗng");
  assert.equal(pancakePosOrderSearchUrl(null, 6304), null, "thiếu shop ⇒ không dựng — '/shop/orders' làm POS đọc chữ 'orders' thành mã shop");

  // ───────── 3. Sản phẩm: /product/management, không phải /products ─────────
  assert.equal(pancakePosProductsUrl("9"), `${PANCAKE_POS_WEB}/shop/9/product/management`);
  assert.equal(pancakePosProductsUrl(""), null);

  // ───────── 4. Chat khách ─────────
  assert.equal(pancakeConversationUrl("p1", "c1"), "https://pancake.vn/p1?c_id=c1");
  assert.equal(pancakeConversationUrl("p1", ""), null);

  // ───────── 5. MỘT chỗ dựng đường dẫn POS ─────────
  const goc = path.resolve(__dirname, "..");
  const cho = "lib/constants/pancake.ts";
  const tep = execSync("git ls-files app lib components", { cwd: goc, encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== cho);
  const goTay = tep.filter((f) => readFileSync(path.join(goc, ...f.split("/")), "utf8").includes("pos.pancake.vn"));
  assert.deepEqual(goTay, [], `đường dẫn POS gõ tay ngoài ${cho} — gọi pancakePosOrderUrl / pancakePosOrderSearchUrl / pancakePosProductsUrl`);

  console.log(`✓ Liên kết POS Pancake: đơn = /order?order_id=, tìm = /order?o_c_i=, sản phẩm = /product/management · thiếu shop thì không vẽ nút · ${tep.length} tệp không tự gõ đường dẫn POS`);
}

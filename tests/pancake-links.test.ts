import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PANCAKE_POS_WEB, pancakeConversationUrl, pancakePosOrderSearchUrl, pancakePosOrderUrlFromLink, pancakePosOrderUrlFromRaw, pancakePosProductsUrl } from "@/lib/constants/pancake";

/**
 * ═══════════ LIÊN KẾT SANG WEB POS PANCAKE ═══════════
 *
 * 27/09/2026 cả bốn nút "Mở trên Pancake / POS" của ERP đều hỏng, và không bài kiểm nào thấy: mỗi
 * trang tự gõ một mẫu đường dẫn đoán ra. Đo linkThat: `/shop/<id>/orders?id=…` → 404, `/shop/<id>/products`
 * → 404, `/shop/orders?search=…` → POS đọc "orders" thành mã shop. Mẫu đúng đọc từ chính mã web POS
 * (xem chú thích ở `lib/constants/pancake.ts`).
 *
 * Bài này khoá hai điều: (1) mẫu đường dẫn, (2) KHÔNG tệp nào ngoài `lib/constants/pancake.ts` tự gõ
 * `pos.pancake.vn` — một bản gõ tay thứ hai là đúng thứ đã hỏng bốn lần cùng lúc.
 */
export function testPancakeLinks() {
  // ───────── 1. Một đơn: dựng từ `order_link` Pancake gửi, KHÔNG từ orders.id ─────────
  // Dữ liệu linkThat production 28/09/2026: API id = system_id = 4063, còn POS mở đơn bằng mã nội bộ
  // 10920003274 — mở bằng order_id=4063 thì POS ra danh sách trống.
  const linkThat = "https://pos.pages.fm/shop/408063069/order?order_id=10920003274";
  const url = pancakePosOrderUrlFromLink(linkThat);
  assert.equal(url, `${PANCAKE_POS_WEB}/shop/408063069/order?order_id=10920003274`, "giữ MÃ NỘI BỘ POS, dựng lại trên pos.pancake.vn");
  assert.ok(url && !url.includes("order_id=4063"), "không bao giờ mở POS bằng orders.id");
  assert.ok(url && !/\/orders(\?|$|\/)/.test(url), "web POS không có trang 'orders' số nhiều — đường dẫn đó trả 404");
  assert.equal(pancakePosOrderUrlFromLink("https://pos.pancake.vn/shop/9/order?order_id=77"), `${PANCAKE_POS_WEB}/shop/9/order?order_id=77`);
  assert.equal(pancakePosOrderUrlFromRaw({ id: 4063, system_id: 4063, order_link: linkThat }), url, "đọc thẳng từ orders.raw");
  // Sai hình dạng ⇒ null để nơi gọi rơi về tìm theo số đơn — không đoán, không vẽ link mở ra trang trống.
  for (const hong of [null, undefined, "", "khong-phai-url", "https://evil.example/shop/1/order?order_id=2", "https://pos.pages.fm/shop/1/orders?order_id=2", "https://pos.pages.fm/shop/1/order?order_id=abc", "https://pos.pages.fm/shop/1/order", 4063]) {
    assert.equal(pancakePosOrderUrlFromLink(hong), null, `order_link hỏng phải ra null: ${String(hong)}`);
  }
  assert.equal(pancakePosOrderUrlFromRaw(null), null);
  assert.equal(pancakePosOrderUrlFromRaw({ id: 4063 }), null, "không có order_link ⇒ null, KHÔNG dựng từ id");

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
  assert.deepEqual(goTay, [], `đường dẫn POS gõ tay ngoài ${cho} — gọi pancakePosOrderUrlFromLink / pancakePosOrderSearchUrl / pancakePosProductsUrl`);

  console.log(`✓ Liên kết POS Pancake: đơn = order_link Pancake (mã nội bộ POS, không phải orders.id), tìm = /order?o_c_i=, sản phẩm = /product/management · thiếu shop thì không vẽ nút · ${tep.length} tệp không tự gõ đường dẫn POS`);
}

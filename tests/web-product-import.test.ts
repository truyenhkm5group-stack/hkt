/**
 * NHẬP SẢN PHẨM TỪ LINK WEBSITE (lib/products/web-import.ts) + TẢI URL CÔNG KHAI AN TOÀN (lib/net/public-url.ts).
 * Không gọi mạng thật (luật 65): `fetch` và bộ phân giải DNS đều giả.
 *
 *  1. Chặn SSRF: địa chỉ riêng / nội bộ / siêu dữ liệu đám mây ⇒ từ chối TRƯỚC khi gửi request; chuyển hướng về nội bộ ⇒
 *     dừng; tên miền phân giải ra MỘT địa chỉ riêng trong nhiều địa chỉ ⇒ từ chối; trần dung lượng.
 *  2. Ba nguồn đọc: /products.json (mỗi biến thể một dòng) · WooCommerce (giá chia theo đơn vị nhỏ nhất) · JSON-LD; thử
 *     đúng thứ tự, nguồn trước có thì không hỏi nguồn sau.
 *  3. Giá không rõ ⇒ ô trống (CHƯA KHAI), không phải 0 đ.
 *  4. CSV dựng ra đi qua ĐÚNG trình đọc tệp của trình nhập và tự ghép đủ cột (tên · SKU · giá · danh mục).
 */
import assert from "node:assert/strict";
import { fetchPublicUrl, isPrivateAddress, normalizeUserUrl } from "@/lib/net/public-url";
import { guessImportMapping } from "@/lib/products/import-shared";
import { readProductImportFile } from "@/lib/products/import";
import { fromJsonLd, fromShopifyProducts, fromWooProducts, moneyFrom, readWebsiteProducts, webRowsToCsv } from "@/lib/products/web-import";

const PUBLIC_IP = "93.184.216.34";
const resolvePublic = async () => [PUBLIC_IP];

function fakeFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; hits: string[] } {
  const hits: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hits.push(url);
    return routes[url]?.() ?? new Response("không có", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, hits };
}
const json = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

async function testSsrf() {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"]) {
    assert.ok(isPrivateAddress(ip), `${ip} là địa chỉ nội bộ / đặc biệt`);
  }
  for (const ip of [PUBLIC_IP, "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!isPrivateAddress(ip), `${ip} công khai`);
  assert.ok(isPrivateAddress("không-phải-ip"), "không phải IP ⇒ phía hẹp");

  const u = normalizeUserUrl("shop.vn/collections/all");
  assert.ok(!("error" in u) && u.toString() === "https://shop.vn/collections/all", "thiếu giao thức ⇒ https");
  for (const bad of ["", "ftp://shop.vn", "javascript:alert(1)", "https://user:pw@shop.vn", "https://shop.vn:8080", "http://intranet"]) assert.ok("error" in normalizeUserUrl(bad), `«${bad}» bị từ chối`);

  const f1 = fakeFetch({});
  const r1 = await fetchPublicUrl("https://noi-bo.example.vn", { fetch: f1.fetch, resolve: async () => [PUBLIC_IP, "10.0.0.5"] });
  assert.ok(!r1.ok && f1.hits.length === 0, "MỘT địa chỉ riêng trong nhiều địa chỉ ⇒ từ chối, không gửi request nào");
  const f2 = fakeFetch({});
  assert.ok(!(await fetchPublicUrl("http://169.254.169.254/latest/meta-data", { fetch: f2.fetch, resolve: resolvePublic })).ok && f2.hits.length === 0, "IP siêu dữ liệu đám mây ⇒ từ chối");
  assert.ok(!(await fetchPublicUrl("https://localhost.", { fetch: f2.fetch, resolve: resolvePublic })).ok);
  const f3 = fakeFetch({ "https://shop.vn/": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000/admin" } }) });
  const r3 = await fetchPublicUrl("https://shop.vn/", { fetch: f3.fetch, resolve: resolvePublic });
  assert.ok(!r3.ok && f3.hits.length === 1, "chuyển hướng về nội bộ ⇒ dừng ở bước kiểm, không đi theo");
  const f4 = fakeFetch({ "https://shop.vn/a": () => new Response(null, { status: 301, headers: { location: "/b" } }), "https://shop.vn/b": () => new Response("ok") });
  const r4 = await fetchPublicUrl("https://shop.vn/a", { fetch: f4.fetch, resolve: resolvePublic });
  assert.ok(r4.ok && r4.url === "https://shop.vn/b" && new TextDecoder().decode(r4.body) === "ok", "chuyển hướng công khai ⇒ đi theo");
  const big = fakeFetch({ "https://shop.vn/big": () => new Response(new Uint8Array(3_000_001)) });
  assert.ok(!(await fetchPublicUrl("https://shop.vn/big", { fetch: big.fetch, resolve: resolvePublic })).ok, "quá 3 MB ⇒ bỏ");
}

function testExtractors() {
  assert.equal(moneyFrom("199000.00"), 199000);
  assert.equal(moneyFrom(25000), 25000);
  assert.equal(moneyFrom("19900000", 100), 199000, "WooCommerce: chia theo đơn vị nhỏ nhất");
  for (const bad of ["", "0", "-5", "1,2", "abc", null, undefined]) assert.equal(moneyFrom(bad), null, `«${String(bad)}» ⇒ chưa khai`);

  const shop = fromShopifyProducts({
    products: [
      { title: "Áo sơ mi linen", product_type: "Áo", variants: [{ title: "S / Trắng", sku: "SM-S-T", price: "359000.00" }, { title: "M / Trắng", sku: "SM-M-T", price: "359000.00" }] },
      { title: "Túi tote", product_type: "", variants: [{ title: "Default Title", sku: "", price: "0.00" }] },
    ],
  });
  assert.deepEqual(shop, [
    { name: "Áo sơ mi linen - S / Trắng", sku: "SM-S-T", price: 359000, category: "Áo" },
    { name: "Áo sơ mi linen - M / Trắng", sku: "SM-M-T", price: 359000, category: "Áo" },
    { name: "Túi tote", sku: "", price: null, category: "" },
  ], "mỗi biến thể một dòng; «Default Title» ⇒ tên trơn; giá 0 ⇒ chưa khai");

  assert.deepEqual(fromWooProducts([{ name: "Chả cá thu &amp; mực", sku: "CCT", prices: { price: "280000", currency_minor_unit: 0 }, categories: [{ name: "Chả" }] }]), [{ name: "Chả cá thu & mực", sku: "CCT", price: 280000, category: "Chả" }]);

  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Nước mắm cốt","sku":"NM-1L","offers":{"@type":"Offer","price":"150000","priceCurrency":"VND"}}]}</script>
    <script type="application/ld+json">{ hỏng }</script>
    <script type='application/ld+json'>{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"Ruốc tôm","offers":[{"price":95000}]}}]}</script>
  </head></html>`;
  assert.deepEqual(fromJsonLd(html), [
    { name: "Nước mắm cốt", sku: "NM-1L", price: 150000, category: "" },
    { name: "Ruốc tôm", sku: "", price: 95000, category: "" },
  ], "JSON-LD trong @graph và ItemList; khối hỏng bị bỏ");

  // CSV dựng ra đi qua ĐÚNG trình đọc tệp + tự ghép cột.
  const csv = webRowsToCsv([...shop, { name: 'Bánh "đặc biệt", hộp', sku: "", price: 120000, category: "Bánh" }]);
  const parsed = readProductImportFile({ fileName: "san-pham-tu-shop.vn.csv", data: new TextEncoder().encode(csv) });
  assert.ok(!("error" in parsed), JSON.stringify(parsed));
  assert.deepEqual(guessImportMapping(parsed.headers), ["name", "sku", "price", "category"], "tự ghép đủ bốn cột");
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rows[3].cells[0], 'Bánh "đặc biệt", hộp', "dấu phẩy / ngoặc kép trong tên giữ nguyên");
  assert.equal(parsed.rows[2].cells[2], "", "giá chưa khai ⇒ ô trống, không phải 0");
}

async function testSources() {
  // Shopify-chuẩn: có ⇒ không hỏi WooCommerce / trang.
  const s = fakeFetch({ "https://shop.vn/products.json?limit=250&page=1": json({ products: [{ title: "Váy", variants: [{ title: "Default Title", sku: "V1", price: "499000.00" }] }] }) });
  const r1 = await readWebsiteProducts("shop.vn", { fetch: s.fetch, resolve: resolvePublic });
  assert.ok("ok" in r1 && r1.source === "SHOPIFY" && r1.count === 1 && r1.fileName === "san-pham-tu-shop.vn.csv", JSON.stringify(r1));
  assert.ok(!s.hits.some((h) => h.includes("wp-json")), "nguồn trước có ⇒ không hỏi nguồn sau");
  assert.ok(Buffer.from(r1.base64, "base64").toString("utf8").includes("Váy,V1,499000"));
  // WooCommerce.
  const w = fakeFetch({ "https://woo.vn/wp-json/wc/store/v1/products?per_page=100&page=1": json([{ name: "Áo", sku: "A", prices: { price: "15000000", currency_minor_unit: 2 }, categories: [] }]) });
  const r2 = await readWebsiteProducts("https://woo.vn/shop", { fetch: w.fetch, resolve: resolvePublic });
  assert.ok("ok" in r2 && r2.source === "WOOCOMMERCE" && Buffer.from(r2.base64, "base64").toString("utf8").includes("Áo,A,150000"), JSON.stringify(r2));
  // JSON-LD của chính trang được dán.
  const page = '<script type="application/ld+json">{"@type":"Product","name":"Mứt gừng","offers":{"price":"75000"}}</script>';
  const j = fakeFetch({ "https://web.vn/p/mut-gung": () => new Response(page, { status: 200, headers: { "content-type": "text/html" } }) });
  const r3 = await readWebsiteProducts("https://web.vn/p/mut-gung", { fetch: j.fetch, resolve: resolvePublic });
  assert.ok("ok" in r3 && r3.source === "JSONLD" && r3.count === 1, JSON.stringify(r3));
  // Không nguồn nào ⇒ nói thẳng, không bịa.
  const none = fakeFetch({ "https://trong.vn/": () => new Response("<html>không có gì</html>") });
  const r4 = await readWebsiteProducts("trong.vn", { fetch: none.fetch, resolve: resolvePublic });
  assert.ok("error" in r4 && /tệp mẫu/.test(r4.error), JSON.stringify(r4));
  // Website nội bộ ⇒ không request nào.
  const intra = fakeFetch({});
  const r5 = await readWebsiteProducts("https://noi-bo.vn", { fetch: intra.fetch, resolve: async () => ["192.168.0.10"] });
  assert.ok("error" in r5 && intra.hits.length === 0, "website phân giải về mạng nội bộ ⇒ không một request nào");
}

export async function testWebProductImport() {
  await testSsrf();
  testExtractors();
  await testSources();
  console.log("✓ Nhập sản phẩm từ website: chặn SSRF (địa chỉ riêng, siêu dữ liệu đám mây, chuyển hướng về nội bộ, trần dung lượng); /products.json · WooCommerce · JSON-LD đúng thứ tự; giá không rõ ⇒ trống; CSV qua đúng trình đọc tệp và tự ghép cột");
}

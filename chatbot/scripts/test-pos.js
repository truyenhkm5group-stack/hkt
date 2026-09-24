// Kiem tra ket noi Pancake POS: liet ke shop, dong bo san pham, in text catalog se dua vao prompt
import { assertConfig, config } from "../src/config.js";
import { catalog } from "../src/catalog.js";

assertConfig({ needPancake: false, needGemini: false, needPos: true });

const shops = await catalog.client.listShops();
console.log("== Shops cua api_key nay ==");
for (const s of shops.shops || []) console.log(` - ${s.id}  ${s.name}  (${(s.pages || []).length} page)`);
console.log(`\nDang dung POS_SHOP_ID=${config.pos.shopId}\n`);

const products = await catalog.refresh();
console.log(`== ${products.length} san pham ==`);
console.log(catalog.summary());

console.log("\n== Text catalog dua vao system prompt ==\n");
console.log(catalog.toPromptText());

const first = products[0];
if (first) {
  console.log(`\n== Test tim anh: [[IMG:${first.code}]] ->`);
  for (const u of catalog.findImages(first.code)) console.log("  ", u);
}

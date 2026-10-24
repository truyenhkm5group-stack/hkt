/**
 * ═══ OPS `cart-unit-probe` (pha 3 trùng đơn, vụ HSLC Ngọc «1l nước mắm và 1k chả mực») ═══
 *
 * Khoá: (1) câu thật ⇒ «k ký» + «l», bộ đọc giỏ HIỆN TẠI không thấy số lượng (đúng phần dạy bộ đọc sẽ cứu); (2) «k» tiền tách khỏi «k ký»
 * — «ship 30k», «giá là 150k», «150k đ»; «chả mực GIÃ tay» (gập dấu = «gia») KHÔNG làm «1k chả mực giã tay» thành tiền; cùng tin có cả
 * hai ⇒ đếm cả hai; (3) mẫu số = tin đặt hàng, rỗng ⇒ tỷ lệ null (không phải 0%); (4) chạy được trên CSDL thật của bài kiểm, tóm tắt
 * không chữ tin / SĐT; (5) script chỉ đọc, tự chứa, khai đủ ở ops-vps / platform-isolation-static.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { getDb } from "@/db";
import { classifyUnitMentions, measureOf, parseUnitProbeArgs, runCartUnitProbe, summarizeUnits } from "../scripts/cart-unit-probe";

const WEIGHT = ["Chả mực giã tay", "Chả cá thu"];
const CATALOG = [...WEIGHT, "Nước mắm"];

function testPure() {
  assert.deepEqual(parseUnitProbeArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", days: 30 });
  assert.deepEqual(parseUnitProbeArgs(["hslc-hmt-shop", "--days=7"]), { code: "hslc-hmt-shop", days: 7 });
  for (const bad of [[], ["HSLC!"], ["x", "--days=0"], ["x", "--days=91"]]) assert.ok("error" in parseUnitProbeArgs(bad), JSON.stringify(bad));
  assert.deepEqual([measureOf("Size: 1kg"), measureOf("500g"), measureOf("2 lạng"), measureOf("500ml"), measureOf("Chai 1 lít"), measureOf("Hộp 10 cái")], ["WEIGHT", "WEIGHT", "WEIGHT", "VOLUME", "VOLUME", null]);

  const ngoc = classifyUnitMentions("1l nước mắm và 1k chả mực giã tay", WEIGHT, CATALOG);
  assert.deepEqual(ngoc, { kWeight: true, volume: true, kMoney: false, readerSees: false }, "câu thật: k ký + l, bộ đọc hiện tại bỏ sót");
  assert.equal(classifyUnitMentions("ship 30k nhé em", WEIGHT, CATALOG).kMoney, true);
  assert.equal(classifyUnitMentions("giá là 150k hả em", WEIGHT, CATALOG).kMoney, true);
  assert.equal(classifyUnitMentions("chuyển 150k đ rồi nha", WEIGHT, CATALOG).kMoney, true);
  const giaTay = classifyUnitMentions("lấy 1k chả mực giã tay", WEIGHT, CATALOG);
  assert.deepEqual([giaTay.kWeight, giaTay.kMoney], [true, false], "«giã» gập dấu = «gia» không làm thành tiền");
  const both = classifyUnitMentions("1k chả cá thu, ship 30k", WEIGHT, CATALOG);
  assert.deepEqual([both.kWeight, both.kMoney], [true, true], "một tin có cả hai ⇒ đếm cả hai");
  const kg = classifyUnitMentions("cho chị 1kg chả cá thu", WEIGHT, CATALOG);
  assert.deepEqual([kg.kWeight, kg.readerSees], [false, true], "«1kg» bộ đọc đã hiểu — không phải ca «k»");
  assert.deepEqual(classifyUnitMentions("cho chị 2k nhé", WEIGHT, CATALOG), { kWeight: false, volume: false, kMoney: false, readerSees: false }, "«2k» không món, không từ tiền ⇒ không xếp nhóm nào");

  const s = summarizeUnits([ngoc, both, kg, classifyUnitMentions("shop ở đâu vậy", WEIGHT, CATALOG)]);
  assert.deepEqual([s.messages, s.orderMessages, s.kWeight, s.volume, s.kMoney, s.kBoth, s.readerMisses], [4, 3, 2, 1, 1, 1, 2], "«1k chả cá thu, ship 30k» bộ đọc hiện tại cũng bỏ sót ⇒ 2 tin bỏ sót");
  assert.equal(s.kWeightRate, 2 / 3);
  assert.equal(summarizeUnits([classifyUnitMentions("shop ở đâu vậy", WEIGHT, CATALOG)]).kWeightRate, null, "không có tin đặt hàng ⇒ null, không 0%");
}

async function testOnDb() {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    const db = await getDb();
    const s = await runCartUnitProbe(db, { since: new Date(Date.now() - 30 * 86_400_000), label: "kiểm thử" });
    assert.ok(s.messages >= 0, "câu SQL chạy được trên lược đồ thật");
  } finally {
    console.log = orig;
  }
  const summary = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
  assert.ok(summary.length >= 3, "có khối tóm tắt");
  for (const l of summary) assert.ok(!/0\d{9}/.test(l) && !/«[^»]*[a-z]{3,}[^»]*» \d/.test(l.replace(/«<[^»]*»/g, "")), `tóm tắt không chữ tin / SĐT: ${l}`);
}

function testSourceFences() {
  const src = readFileSync("scripts/cart-unit-probe.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(src, /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1";\nimport "dotenv\/config";/, "đặt ERP_READ_ONLY TRƯỚC khi nạp @/db");
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection/);
  assert.ok(!/\bgetDb\(|withOrganization/.test(code), "không gọi lib đọc getDb() — chỉ handle chỉ đọc của tổ chức đã chọn");
  assert.ok(!/\b(insert|update|delete)\s+(into|from)?\s*\w|\.insert\(|\.update\(|\.delete\(/i.test(code.replace(/\/\/.*$/gm, "")), "không ghi gì");
  for (const m of code.matchAll(/from "@\/([^"]+)"/g)) assert.ok(existsSync(`${m[1]}.ts`) || existsSync(`${m[1]}/index.ts`), `import @/${m[1]} phải có sẵn`);
  assert.ok(!/\(\?<[=!]/.test(code), "không nhìn-ngược");
  assert.match(src, /process\.stdout\.write\("", \(\) => done\(\)\)/, "xả stdout trước khi thoát");
  assert.ok(!/tomTat\([^)]*\.text\b|tomTat\([^)]*mask\(/.test(code), "tóm tắt không in chữ tin");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- cart-unit-probe\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bcart-unit-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bcart-unit-probe\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+cart-unit-probe\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/cart-unit-probe\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/cart-unit-probe.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

export async function testCartUnitProbe() {
  testPure();
  await testOnDb();
  testSourceFences();
  console.log("  ✓ ops cart-unit-probe: câu thật «1l nước mắm và 1k chả mực» ⇒ k ký + l, bộ đọc hiện tại bỏ sót · k tiền tách khỏi k ký («giã» không thành «giá») · mẫu số tin đặt hàng, rỗng ⇒ null · chạy được trên CSDL · chỉ đọc, tóm tắt không chữ tin");
}

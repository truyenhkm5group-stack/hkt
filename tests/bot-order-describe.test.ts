/**
 * ops `bot-order-describe` — câu bot nhà sẽ nói về ≤ 5 đơn POS, CHỈ ĐỌC, chạy trong container erp-chatbot (23/10/2026).
 * Khoá: đối số chỉ mã đơn số, ≤ 5 · kênh tóm tắt công khai bỏ tên hàng / tiền · script chỉ GET, không gửi tin, không đọc tên / SĐT ·
 * ops khai đủ bốn chỗ, kết quả mã hoá.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function testBotOrderDescribe() {
  // Hàm thuần nằm ở tệp riêng: nạp nó KHÔNG nạp config.js của bot.
  const lib = (await import(pathToFileURL(path.resolve("chatbot/scripts/order-describe-lib.js")).href)) as {
    MAX_ORDERS: number;
    parseOrderIds: (a: string[]) => { ids?: string[]; error?: string };
    publicLine: (s: string) => string;
  };
  assert.deepEqual(lib.parseOrderIds(["6457", "6266,6457"]), { ids: ["6457", "6266"] }, "dấu cách / dấu phẩy, bỏ trùng");
  assert.ok(lib.parseOrderIds([]).error && lib.parseOrderIds(["1", "2", "3", "4", "5", "6"]).error, `rỗng / > ${lib.MAX_ORDERS} ⇒ lỗi`);
  assert.ok(lib.parseOrderIds(["6457;rm"]).error && lib.parseOrderIds(["erp-abc"]).error, "chỉ mã số");
  const cau = "Đơn #6457: Đơn đã được gửi lại – gồm 1 x CCT-1KG – mã vận đơn mới 155281559687 (Viettel Post, đã giao thành công) – thu hộ 524.000đ";
  assert.equal(lib.publicLine(cau), "Đơn #6457: Đơn đã được gửi lại – mã vận đơn mới 155281559687 (Viettel Post, đã giao thành công)", "công khai bỏ tên hàng + tiền");

  const src = readFileSync("chatbot/scripts/order-describe.js", "utf8");
  assert.match(src, /import \{ describeOrder, erpOrderView, orderSync \} from "\.\.\/src\/orders\.js";/, "dùng đúng hàm bot đang dùng");
  assert.match(src, /orderSync\._call\("GET", `\/shops\/\$\{config\.pos\.shopId\}\/orders\/\$\{id\}`\)/, "đọc đơn bằng đường của bot");
  assert.doesNotMatch(src, /_call\("(POST|PUT|DELETE)"/, "không ghi gì lên POS");
  assert.doesNotMatch(src, /sendMessage|reply\(|\.send\(/, "không gửi tin");
  assert.doesNotMatch(src, /bill_full_name|bill_phone|phone_number|shipping_address/, "không đọc tên / SĐT / địa chỉ");
  assert.match(src, /tomTat\(publicLine\(sentence\)\)/, "kênh công khai chỉ in bản rút gọn");

  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- bot-order-describe\s+#/, "lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bbot-order-describe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NHE="[^"]*\bbot-order-describe\b/, "làn đọc nhẹ");
  assert.match(ops, /bot-order-describe\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-chatbot node scripts\/order-describe\.js ;;/, "nhánh chạy trong container bot");
  console.log("✓ ops bot-order-describe: ≤ 5 mã đơn số · công khai bỏ tên hàng / tiền · chỉ GET, không gửi tin, không đọc tên / SĐT · khai đủ bốn chỗ, mã hoá");
}

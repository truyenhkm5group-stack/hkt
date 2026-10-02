/**
 * ═══════════ BOT LÊN ĐƠN → CHUÔNG ERP ═══════════
 *
 * Chủ shop 02/10/2026: kiểm mỗi SĐT 30 phút/lần, quá 3 lần chưa đủ thông tin thì "thông báo về ERP". Job `alerts` hỏi
 * bot rồi mở / đóng thông báo theo `planOrderBotAlerts` (hàm thuần): mỗi lần rơi vào cần duyệt đúng MỘT thông báo,
 * hỏi lại bao nhiêu lần cũng không đẻ thêm, hội thoại rời cần duyệt thì thông báo tự đóng.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/chatbot-orderbot-alerts.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ORDERBOT_ALERT_PREFIX, orderBotAlertKey, planOrderBotAlerts } from "@/lib/constants/chatbot-orderbot";

export function testChatbotOrderBotAlerts() {
  const a = { key: "conv1", customerName: "Võ Liêu", page: "Linh Tây Luxury CS1", reasons: ["Đã kiểm 3 lần (30 phút/lần) vẫn chưa đủ thông tin: màu"], reviewAt: 1_759_400_000_000 };
  const b = { key: "conv2", customerName: "Thu Cúc", page: "Linh Tây Luxury", reasons: [], reviewAt: 1_759_400_100_000 };
  const kA = orderBotAlertKey(a)!;
  assert.equal(kA, `${ORDERBOT_ALERT_PREFIX}conv1:1759400000000`);
  assert.equal(orderBotAlertKey({ key: "x" }), null, "không có mốc thì chưa báo được — không bịa mốc");

  // Lượt đầu: mở cả hai
  let p = planOrderBotAlerts([a, b], []);
  assert.deepEqual(p.create.map((c) => c.conversationKey), ["conv1", "conv2"]);
  assert.match(p.create[0].body, /^Võ Liêu · Linh Tây Luxury CS1 — Đã kiểm 3 lần/);
  assert.match(p.create[1].body, /chưa đủ thông tin để lên đơn/, "không có lý do thì vẫn nói rõ vì sao báo");
  assert.doesNotMatch(p.create.map((c) => c.title).join(" "), /\d{3}\.\d{3}|đ\b/, "tiêu đề không chứa số tiền");
  assert.deepEqual(p.resolve, []);

  // Hỏi lại khi cả hai còn mở: không mở thêm dòng nào
  p = planOrderBotAlerts([a, b], [kA, orderBotAlertKey(b)!]);
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.resolve, []);

  // conv2 đã lên đơn (rời cần duyệt) → đóng; conv1 rơi vào cần duyệt LẦN HAI (mốc mới) → một thông báo mới, đóng cái cũ
  const a2 = { ...a, reviewAt: a.reviewAt + 3_600_000 };
  p = planOrderBotAlerts([a2], [kA, orderBotAlertKey(b)!, "ship-failed:123"]);
  assert.deepEqual(p.create.map((c) => c.dedupeKey), [orderBotAlertKey(a2)]);
  assert.deepEqual(p.resolve.sort(), [kA, orderBotAlertKey(b)!].sort());
  assert.ok(!p.resolve.includes("ship-failed:123"), "không bao giờ đóng thông báo của nguồn khác");

  // Job alerts gọi đường này, và lỗi hỏi bot không làm hỏng lượt cảnh báo
  const jobs = readFileSync(path.join(process.cwd(), "lib/sync/jobs.ts"), "utf8");
  assert.match(jobs, /syncOrderBotReviewAlerts\(\)\.catch\(/);
  const io = readFileSync(path.join(process.cwd(), "lib/integrations/chatbot/orderbot-alerts.ts"), "utf8");
  assert.match(io, /activeUserIdsWhoCan\("cs:config"\)/, "báo đúng người mở được trang Bot chat");
  assert.doesNotMatch(io, /sendLark|sendTelegram/, "không thêm kênh gửi ra ngoài");
  console.log("✓ bot lên đơn → chuông ERP: mỗi lần rơi cần duyệt một thông báo, tự đóng khi rời, không đụng nguồn khác");
}

if (import.meta.url === `file://${process.argv[1]}`) testChatbotOrderBotAlerts();

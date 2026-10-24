/**
 * Bot nhà (chatbot/) — hộp thư của tin riêng trả lời bình luận (P0 24/10/2026, cùng lỗi với lib/sales-chatbot/fanpage.ts): `private_reply_conversation.id`
 * là mã TIN riêng «m_…», luồng hộp thư nằm ở `conversation_id` dạng <page_id>_<PSID>. Bản cũ gửi ảnh vào «/conversations/m_…» ⇒ ảnh câu trả lời
 * bình luận không bao giờ tới khách. Module THUẦN (không nạp config / logger của bot) — nạp bằng đường file như order-view.js.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Inbox = { replied: boolean; inboxId: string | null; source: "PANCAKE_CONV_ID" | "DERIVED_PAGE_PSID" | "NONE" };
type Mod = { privateReplyInboxId: (prc: unknown, pageId: unknown, fromId: unknown) => Inbox };

export async function testHomeBotCommentInbox() {
  const m = (await import(pathToFileURL(path.resolve("chatbot/src/comment-inbox.js")).href)) as Mod;
  const PAGE = "100200300400500";
  const PSID = "29100200300400500";
  assert.deepEqual(m.privateReplyInboxId({ id: "m_lw1IYLkXVlTJ0Auv", conversation_id: `${PAGE}_${PSID}` }, PAGE, PSID), { replied: true, inboxId: `${PAGE}_${PSID}`, source: "PANCAKE_CONV_ID" }, "payload production: conversation_id, không phải mã tin");
  assert.deepEqual(m.privateReplyInboxId({ id: "m_lw1IYLkXVlTJ0Auv" }, PAGE, PSID), { replied: true, inboxId: `${PAGE}_${PSID}`, source: "DERIVED_PAGE_PSID" }, "chỉ mã tin ⇒ dựng page_PSID");
  assert.deepEqual(m.privateReplyInboxId("m_x", PAGE, "khong-phai-so"), { replied: true, inboxId: null, source: "NONE" }, "không đoán");
  assert.deepEqual(m.privateReplyInboxId(`${PAGE}_${PSID}`, Number(PAGE), PSID).inboxId, `${PAGE}_${PSID}`, "page_id dạng số vẫn so được");
  assert.deepEqual(m.privateReplyInboxId({ conversation_id: `999_${PSID}` }, PAGE, PSID).inboxId, `${PAGE}_${PSID}`, "hộp thư page khác không được nhận");
  for (const none of [null, undefined, ""]) assert.equal(m.privateReplyInboxId(none, PAGE, PSID).replied, false);
  for (const prc of [{ id: "m_a", conversation_id: "m_b" }, "m_a", { id: "m_a" }]) assert.ok(!m.privateReplyInboxId(prc, PAGE, PSID).inboxId?.startsWith("m_"), JSON.stringify(prc));
  // Mã nguồn: bot.js gửi ảnh vào hộp thư qua ĐÚNG hàm này, không còn `prc?.id || prc?.conversation_id`.
  const bot = readFileSync("chatbot/src/bot.js", "utf8");
  assert.match(bot, /privateReplyInboxId\(mine\?\.private_reply_conversation, pageId, last\.from\?\.id\)/);
  assert.doesNotMatch(bot, /prc\?\.id \|\| prc\?\.conversation_id/, "không còn lấy id tin trước conversation_id");
  assert.doesNotMatch(readFileSync("chatbot/src/comment-inbox.js", "utf8"), /^import /m, "module thuần: không import gì (không chốt DATA_DIR của bot)");
  console.log("✓ Bot nhà: hộp thư tin riêng của bình luận chỉ dạng page_PSID (conversation_id · dựng từ from_id · không đoán · không «m_…») — ảnh trả lời bình luận gửi đúng hộp thư");
}

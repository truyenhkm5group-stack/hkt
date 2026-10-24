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
  // ── Rơi về câu cũ khi đọc góc nhìn ERP: lý do + thời gian thật, đếm theo page (lead duyệt 24/10/2026 sau phép đo route nguội 106 ms).
  type Done = { ok: boolean; reason: string | null; ms: number };
  type View = {
    erpOrderView: (orders: Record<string, unknown>[], opts: Record<string, unknown>) => Promise<{ byCode: Record<string, unknown>; byOrder: Record<string, unknown> }>;
    erpFallbackReason: (e: unknown) => string;
  };
  const v = (await import(pathToFileURL(path.resolve("chatbot/src/order-view.js")).href)) as View;
  const err = (name: string, message: string, code?: string) => Object.assign(new Error(message), { name, ...(code ? { cause: { code } } : {}) });
  assert.equal(v.erpFallbackReason(err("TimeoutError", "The operation was aborted due to timeout")), "TIMEOUT");
  assert.equal(v.erpFallbackReason(err("Error", "ERP tra 503")), "HTTP_503");
  assert.equal(v.erpFallbackReason(err("TypeError", "fetch failed", "ENOTFOUND")), "DNS");
  assert.equal(v.erpFallbackReason(err("TypeError", "fetch failed", "ECONNREFUSED")), "NETWORK");
  assert.equal(v.erpFallbackReason(err("SyntaxError", "Unexpected token")), "BAD_BODY");
  assert.equal(v.erpFallbackReason("lạ"), "OTHER");
  let clock = 1_000;
  const done: Done[] = [];
  const order = (id: number) => ({ id, partner: { order_number_vtp: `15528155${String(id).padStart(4, "0")}` } });
  const run = (id: number, fetchImpl: () => Promise<unknown>) => v.erpOrderView([order(id)], { token: "t", fetchImpl, now: () => clock, onDone: (d: Done) => done.push(d) });
  const slow = async () => { clock += 1_600; throw err("TimeoutError", "aborted"); };
  assert.deepEqual(await run(1, slow), { byCode: {}, byOrder: {} }, "rơi về câu cũ ⇒ góc nhìn rỗng");
  await run(2, async () => ({ ok: false, status: 503 }));
  await run(3, async () => { throw err("TypeError", "fetch failed", "ENOTFOUND"); });
  await run(4, async () => { clock += 40; return { ok: true, json: async () => ({ states: [], orders: [] }) }; });
  assert.deepEqual(done, [{ ok: false, reason: "TIMEOUT", ms: 1600 }, { ok: false, reason: "HTTP_503", ms: 0 }, { ok: false, reason: "DNS", ms: 0 }, { ok: true, reason: null, ms: 40 }], `lý do + thời gian thật: ${JSON.stringify(done)}`);
  // Lớp bọc của bot đếm theo page (hiện ở «Hôm nay» của chatbot-status) và bot.js truyền pageId.
  const ordersSrc = readFileSync("chatbot/src/orders.js", "utf8");
  assert.match(ordersSrc, /store\.bumpStat\(pageId, "erpViewOk"\)/);
  assert.match(ordersSrc, /store\.bumpStat\(pageId, `erpViewFallback_\$\{reason\}`\)/);
  assert.match(bot, /await erpOrderView\(orders, \{ pageId \}\)/, "bot.js truyền pageId để đếm theo page");

  console.log("✓ Bot nhà: hộp thư tin riêng của bình luận chỉ dạng page_PSID (conversation_id · dựng từ from_id · không đoán · không «m_…») · rơi về câu cũ khi đọc ERP: lý do (TIMEOUT · HTTP · DNS · NETWORK) + thời gian thật, đếm theo page");
}

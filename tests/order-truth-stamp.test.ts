/**
 * ORDER TRUTH — DẤU LỜI NHẮC TRÊN ĐƠN BOT CHỐT + HỘI THOẠI TRONG SỔ CHI PHÍ AI (Master Mission mục «Order Truth»).
 *
 *  · `promptStampOf` THUẦN: cùng đầu vào ⇒ cùng dấu; thứ tự khai công cụ không đổi dấu; đổi một chữ của lời nhắc / thêm công
 *    cụ / đổi cấu hình ⇒ đổi dấu tương ứng; chỉ dấu băm (16 ký tự hex), không chứa nguyên văn lời nhắc; bản mã chưa biết ⇒ `null`.
 *  · Sự kiện `order.confirmed` mang `payload.stamp` khi đơn chốt có dấu; đơn chốt trước khi có dấu (state cũ) ⇒ không bịa dấu.
 *  · Mã nguồn: mọi dòng sổ chi phí AI của lượt chat mang `conversationId` cạnh `ref`; công cụ chốt gắn dấu của ĐÚNG lần gọi.
 *
 * Vòng thật qua `chatTurn` (lời nhắc + tập công cụ của lượt ra lệnh chốt băm lại đúng bằng dấu, model của lần gọi, mọi dòng sổ AI
 * của hội thoại có `conversation_id`) nằm trong hội thoại vàng (`tests/sales-agent-golden`, trường `final.confirmed.stamp` và
 * `final.aiUsageConversation`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveTurnEvents, type TurnMessage, type TurnSnapshot } from "@/lib/sales-chatbot/events-shared";
import { promptStampOf } from "@/lib/sales-chatbot/prompt-stamp";

const snap = (p: Partial<TurnSnapshot> = {}): TurnSnapshot => ({ status: "OPEN", handoffReason: null, state: {}, maxSeq: 1, turns: 0, quickReplies: 0, aiCalls: 0, ...p });

function testStampPure() {
  const base = { system: "Bạn là trợ lý bán hàng của shop A.", tools: ["quote_price", "confirm_order"], config: { tone: "thân thiện" }, model: "m-1", codeVersion: "abc123" };
  const s1 = promptStampOf(base);
  assert.deepEqual(promptStampOf(base), s1, "cùng đầu vào ⇒ cùng dấu");
  assert.match(s1.promptHash, /^[0-9a-f]{16}$/);
  assert.match(s1.configHash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(s1).includes("trợ lý bán hàng"), "chỉ dấu băm — không chép nguyên văn lời nhắc vào sổ");
  assert.equal(promptStampOf({ ...base, tools: ["confirm_order", "quote_price"] }).promptHash, s1.promptHash, "thứ tự khai công cụ không đổi dấu");
  assert.notEqual(promptStampOf({ ...base, system: `${base.system} ` }).promptHash, s1.promptHash, "đổi một ký tự lời nhắc ⇒ đổi dấu");
  assert.notEqual(promptStampOf({ ...base, tools: [...base.tools, "get_order_status"] }).promptHash, s1.promptHash, "thêm công cụ ⇒ đổi dấu");
  assert.equal(promptStampOf({ ...base, config: { tone: "trang trọng" } }).promptHash, s1.promptHash, "cấu hình đổi ⇒ dấu lời nhắc giữ (lời nhắc không đổi)…");
  assert.notEqual(promptStampOf({ ...base, config: { tone: "trang trọng" } }).configHash, s1.configHash, "…nhưng dấu cấu hình đổi");
  assert.equal(promptStampOf({ ...base, codeVersion: null }).codeVersion, null, "bản mã chưa biết ⇒ null, không bịa chuỗi");

  // Sự kiện chốt mang dấu; state cũ (không dấu) ⇒ không có khoá `stamp`.
  const confirmed = { orderId: "erp-ot-1", simulated: false, total: 350_000, at: "2026-10-08T03:00:00.000Z" };
  // Sự kiện của lượt chỉ dựng khi lượt có tin (mốc lượt = tin cuối) — một tin khách đồng ý chốt.
  const turn: TurnMessage[] = [{ seq: 3, role: "user", content: [{ type: "text", text: "Ok chốt đơn giúp em" }], at: new Date("2026-10-08T03:00:00Z") }];
  const ev = (state: TurnSnapshot["state"]) => deriveTurnEvents({ before: snap(), after: snap({ maxSeq: 3, state }), messages: turn, acceptedInCycle: false }).find((e) => e.type === "order.confirmed");
  assert.deepEqual(ev({ confirmed: { ...confirmed, stamp: s1 } })?.payload, { simulated: false, stamp: s1 });
  assert.deepEqual(ev({ confirmed })?.payload, { simulated: false }, "đơn chốt trước khi có dấu ⇒ không bịa dấu");
}

function testStampSource() {
  const engine = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  const refs = engine.match(/ref: conv\.id(?!, conversationId: conv\.id)/g) ?? [];
  assert.equal(refs.length, 0, "mọi dòng sổ chi phí AI của lượt chat mang conversationId cạnh ref");
  assert.match(engine, /promptStamp: \{ \.\.\.stampBase, model: res\.model \|\| prov\.provider\.model \}/, "dấu của ĐÚNG lần gọi model ra lệnh công cụ");
  assert.match(readFileSync("lib/sales-chatbot/followup.ts", "utf8"), /ref: row\.id, conversationId: row\.id/, "lời nhắc tự động cũng vào đúng hội thoại");
  assert.match(readFileSync("lib/sales-chatbot/tools.ts", "utf8"), /state\.confirmed = \{[^\n]*stamp: ctx\.promptStamp/, "công cụ chốt gắn dấu ngay lúc chốt");
}

export function testOrderTruthStamp() {
  testStampPure();
  testStampSource();
  console.log(
    "✓ Order Truth: dấu lời nhắc thuần (cùng đầu vào cùng dấu · thứ tự công cụ không đổi dấu · đổi lời nhắc / công cụ / cấu hình đổi đúng phần dấu · chỉ băm, không nguyên văn · bản mã chưa biết ⇒ null) · order.confirmed mang dấu, đơn cũ không bịa dấu · sổ chi phí AI của lượt chat mang conversationId",
  );
}

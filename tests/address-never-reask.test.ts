/**
 * ═══════════ AGENTS 3.12b — ĐỊA CHỈ KHÁCH KHÔNG BAO GIỜ HỎI LẠI (chủ shop chốt 22/10/2026 · address-resolver-ladder PR-A) ═══════════
 *
 * Khoá:
 *  1. BIÊN `addressTextGiven` cả hai phía: dòng địa chỉ · mảnh đường · tên phường / tỉnh / quận cũ · vế địa chỉ lẫn trong câu mua ⇒ CÓ;
 *     «gần chợ» · tên người · SĐT · «2kg» · câu HỎI phí ship có tên tỉnh ⇒ KHÔNG.
 *  2. Điểm chặn cuối `dropAddressAsks` / `guardAssistantContent`: bỏ mọi câu hỏi / xin / xác nhận địa chỉ · phường · tỉnh · số nhà · «như
 *     lần trước», giữ câu kể và câu khác; khối công cụ không đổi. Mã nguồn: mọi dòng chữ bot của lượt đi qua `appendMessage`; tin theo dõi
 *     có hàng rào riêng.
 *  3. Nguồn câu hỏi của máy chủ tắt khi đã có chữ địa chỉ: `address_check.ask_customer` · NEED_ADDRESS · cổng tự chốt khi chưa đọc được
 *     tỉnh (A1 — đổi luật chốt đơn cho mọi tổ chức).
 *  4. Hội thoại thật (`chatTurn`, model kịch bản): model cố hỏi phường sau khi khách đã gửi địa chỉ ⇒ khách không nhận câu đó; chưa có địa
 *     chỉ ⇒ được hỏi ĐÚNG một lần; thiếu tỉnh · tên cũ trước sáp nhập · hai nơi khớp ⇒ chốt kèm cờ, 0 câu hỏi, 0 vận đơn; chữ địa chỉ
 *     nguyên văn nằm ở `raw.addressText`.
 * Dữ liệu dựng (không PII): SĐT 0961006xxx, số nhà / ngõ hư cấu.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { orderReadiness } from "@/lib/sales-chatbot/cart-commitment";
import { ADDRESS_KNOWN_TEXT, addressTextGiven, addressTextLines, dropAddressAsks } from "@/lib/sales-chatbot/address-memory";
import { CLAIM_SAFE_TEXT } from "@/lib/sales-chatbot/claim-guard";
import { guardAssistantContent } from "@/lib/sales-chatbot/engine";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { addressCheckOf, autoConfirmBlocker, type ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { addressReviewOpenOf } from "@/lib/shipping/route";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

/** Câu bot hỏi / xin địa chỉ (bản kiểm của bài — rộng, cố ý bắt nhầm hơn là bỏ sót). */
const ASKS_ADDRESS = /(?:phường|xã|tỉnh|thành phố|địa chỉ|số nhà|tên đường|như lần trước)[^.!?]*\?|xin (?:thêm )?(?:tên )?(?:phường|xã|tỉnh|địa chỉ|số nhà)|\shay\s[^.!?]*\?/iu;

export function testAddressNeverReaskPure() {
  // 1 · Biên.
  const yes = ["Số 10 ngõ 5 Lương Định Của, Hà Nội", "Phường Kim Liên", "Hà Nội", "ở Đống Đa nhé", "Số 5 ngõ 10", "Thôn 3 xã Đông La", "Cho chị 1 hộp ruốc bông tôm, Lan 0961006100, Số 5 ngõ 12 xóm Chùa", "F4/22A ấp 4, xã Bà Điểm, Hóc Môn"];
  const no = ["gần chợ", "Lan", "0961006100", "2kg", "ship ra Hà Nội bao nhiêu?", "ở nhà em", "Cho chị 1 hộp ruốc, Lan", "ok em", "lấy 2"];
  for (const t of yes) assert.equal(addressTextGiven([t]), true, `«${t}» là chữ địa chỉ`);
  for (const t of no) assert.equal(addressTextGiven([t]), false, `«${t}» KHÔNG phải chữ địa chỉ`);
  assert.deepEqual(addressTextLines(["Cho chị 2kg", "Lan 0961006100\nSố 5 ngõ 12 xóm Chùa", "Phường Kim Liên", "Phường Kim Liên"]), ["Số 5 ngõ 12 xóm Chùa", "Phường Kim Liên"], "chỉ dòng địa chỉ, bỏ SĐT, bỏ trùng");

  // 2 · Điểm chặn cuối.
  for (const ask of ["Dạ mình cho em xin tên phường / xã để em lên đơn nhé.", "Dạ mình ở tỉnh nào ạ?", "Dạ em giao về Số 10 như lần trước được không ạ?", "Dạ mình cho em xin số nhà, tên đường ạ.", "Dạ mình xác nhận giúp em phường Kim Liên đúng không ạ?", "Dạ mình cho em xin thêm tỉnh / thành phố giao hàng ạ.", "Nguyễn Trãi bên Thanh Xuân hay Hà Đông ạ?", "Đại Kim cũ nay là phường nào theo tên mới ạ?"])
    assert.deepEqual(dropAddressAsks(ask, true), { text: ADDRESS_KNOWN_TEXT, dropped: 1 }, ask);
  for (const keep of ["Dạ bên em giao 2-3 ngày tới địa chỉ của mình ạ.", "Dạ mình muốn giao giờ nào ạ?", "Dạ mình lấy thêm 1 hũ ruốc không ạ?", "Dạ em lên đơn 2kg chả cá cho mình rồi ạ.", "Đơn tạm tính 350.000 ₫ + phí ship (báo sau), anh xác nhận giúp em nhé.", "Dạ mình lấy như lần trước không ạ?", "Dạ mình lấy thêm đường phèn không ạ?", "Dạ mình lấy 1kg hay 2kg ạ?", "Dạ bên em ở Hà Nội, giao toàn quốc ạ."]) assert.deepEqual(dropAddressAsks(keep, true), { text: keep, dropped: 0 }, keep);
  // Câu thay của chính hàng rào KHÔNG bao giờ bị coi là câu hỏi (gập dấu «ghi nhan dia chi» từng khớp «nhan dia chi») — nếu không, mỗi lần
  // gửi nó lại đẻ một sự kiện KNOWN_ADDRESS_REASKED giả và làm phồng số 2B.
  assert.deepEqual(dropAddressAsks(ADDRESS_KNOWN_TEXT, true), { text: ADDRESS_KNOWN_TEXT, dropped: 0 }, "câu ghi nhận của máy không phải câu hỏi");
  assert.equal(dropAddressAsks("Dạ mình cho em ghi nhận lại địa chỉ nhé.", true).dropped, 1, "«ghi nhận LẠI địa chỉ» vẫn là lời xin lại");
  assert.deepEqual(dropAddressAsks("Dạ em lên đơn 2kg chả cá rồi ạ. Mình cho em xin tên phường nhé.", true), { text: "Dạ em lên đơn 2kg chả cá rồi ạ.", dropped: 1 }, "chỉ bỏ câu hỏi, giữ câu khác");
  assert.deepEqual(dropAddressAsks("Dạ mình ở tỉnh nào ạ?", false), { text: "Dạ mình ở tỉnh nào ạ?", dropped: 0 }, "chưa có chữ địa chỉ ⇒ được hỏi");
  const blocks = [{ type: "text" as const, text: "Dạ mình ở phường nào ạ?" }, { type: "tool_use" as const, id: "t1", name: "create_customer", input: { address: "x" } }];
  const g = guardAssistantContent(blocks, true);
  assert.equal(g.dropped, 1);
  assert.deepEqual(g.content[1], blocks[1], "khối công cụ giữ nguyên");

  // 3 · Nguồn câu hỏi của máy chủ.
  const chk = addressCheckOf({ address: "Số 5 ngõ 12 xóm Chùa", province: "" }, { customerTexts: ["Số 5 ngõ 12 xóm Chùa"] });
  assert.equal(chk.view.ask_customer, null, "đã có chữ địa chỉ ⇒ công cụ không đưa câu hỏi cho model");
  const st = (address: string): ChatState => ({ draft: { orderId: null, lines: [{ variantId: "v1", quantity: 1 }], unitPrices: {}, recipient: { name: "Lan", phone: "0961006100", address, province: "" }, note: "", simulated: false, quote: { quoteId: "q", priceVersion: "p", verified: true, subtotal: 1, total: 1, amounts: [1], reasons: [], at: "x" } }, customer: { id: null, name: "Lan", phone: "0961006100", address, province: "", simulated: false } }) as unknown as ChatState;
  assert.equal(autoConfirmBlocker(st("Số 5 ngõ 12 xóm Chùa"), { lastUserText: "Số 5 ngõ 12 xóm Chùa", turn: 2, prevTurn: 1 }), null, "A1: có chữ địa chỉ mà chưa đọc được tỉnh ⇒ KHÔNG chặn tự chốt");
  assert.match(autoConfirmBlocker(st("x"), { lastUserText: "ok em", turn: 2, prevTurn: 1, roundCustomerTexts: ["ok em"] }) ?? "", /Địa chỉ chưa đủ/, "chưa có chữ địa chỉ nào ⇒ vẫn chặn, hỏi");
  const cart = { selectedItems: [{ customerExplicit: true, productId: "p1", match: "x", quantity: 1 }] } as never;
  assert.equal(orderReadiness({ cart, blocker: null, lastUserText: "Số 5 ngõ 12 xóm Chùa", hesitating: false, customer: { phone: "0961006100", address: "Số 5 ngõ 12 xóm Chùa", province: "" }, addressGiven: true }).level, "ORDER_READY");
  assert.equal(orderReadiness({ cart, blocker: null, lastUserText: "ok", hesitating: false, customer: { phone: "0961006100", address: "", province: "" } }).level, "NEED_ADDRESS", "chưa có địa chỉ ⇒ NEED_ADDRESS như cũ");

  // Mã nguồn: MỘT điểm chặn cho mọi chữ bot của lượt; tin theo dõi có hàng rào riêng; không module gửi khách nào tự chèn dòng chữ bot.
  const files = execFileSync("git", ["ls-files", "lib"], { encoding: "utf8" }).split("\n").filter((f) => /\.tsx?$/.test(f));
  const inserters = files.filter((f) => /insert\(schema\.salesChatMessages\)/.test(readFileSync(f, "utf8")));
  assert.deepEqual(inserters, ["lib/sales-chatbot/engine.ts"], "chỉ engine.ts chèn dòng hội thoại (qua appendMessage)");
  const engine = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.equal(engine.match(/insert\(schema\.salesChatMessages\)/g)?.length, 3, "ba chỗ chèn: lời chào mở hội thoại · appendMessage · chuyển tin khi gộp hội thoại");
  assert.match(engine, /async function appendMessage[\s\S]{0,400}guardAssistantContent\(content, turnAddressGiven\.get\(conversationId\) === true\)/, "appendMessage đi qua điểm chặn cuối");
  // Cờ đặt qua MỘT hàm (markAddressGiven — 23/10/2026: đặt ngay khi lượt có tin khách, không đợi giữa chatTurnCore).
  assert.match(engine, /function markAddressGiven[\s\S]{0,300}turnAddressGiven\.set\(conversationId, addressTextGiven\(texts\)\)/);
  assert.match(engine, /const roundCustomerTexts = markAddressGiven\(conv\.id, msgs, st0, text\)/);
  assert.match(engine, /finally \{\n {4}turnAddressGiven\.delete\(args\[0\]\);/, "ô của lượt luôn được dọn");
  assert.match(readFileSync("lib/sales-chatbot/followup.ts", "utf8"), /\n {6}if \(sentencesOf\(text\)\.some\(asksAnyAddressPart\) && addressTextGiven\(await roundCustomerTextsFor\(row\.id, freshConv\.state\)[^\n]*\n(?:[^\n]*\n){3} {8}await trace\("PRE_SEND", "SUPPRESS", "AI_TEXT_REJECTED"[^\n]*\n {8}continue;/, "tin theo dõi: hỏi lại địa chỉ khách đã gửi ⇒ BỎ lần nhắc (điều kiện thật, có continue)");
  console.log("  ✓ thuần: biên addressTextGiven hai phía · điểm chặn cuối bỏ đúng câu hỏi địa chỉ · công cụ / NEED_ADDRESS / tự chốt không hỏi khi đã có chữ địa chỉ · một điểm chặn cho mọi chữ bot");
}

const ITEM = (v: (sku: string) => string) => [{ variant_id: v("RUOC-TOM"), quantity: 1 }];
const MODEL_OK = "Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ.";
const orderTurn = (said: string, phone: string, address: string, extraSay?: string) => ({
  say: said,
  ai: [
    () => [tool("create_customer", { name: "Lan", phone, address })],
    ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: ITEM(v) })],
    () => [say(extraSay ? `${MODEL_OK} ${extraSay}` : MODEL_OK)],
  ],
});

type Expect = { confirmed: boolean; asks: number; addressText?: boolean };
const EXPECT: Record<string, Expect> = {
  "anr-model-hoi-phuong": { confirmed: true, asks: 0, addressText: true },
  "anr-thieu-tinh": { confirmed: true, asks: 0, addressText: true },
  "anr-ten-cu": { confirmed: true, asks: 0, addressText: true },
  "anr-hai-noi": { confirmed: true, asks: 0, addressText: true },
  "anr-chua-co-dia-chi": { confirmed: false, asks: 1 },
};

const CASES: GoldenCase[] = [
  {
    key: "anr-model-hoi-phuong",
    title: "Khách gửi tên + SĐT + địa chỉ có tỉnh, thiếu phường; model cố hỏi phường trong câu chốt ⇒ khách KHÔNG nhận câu hỏi",
    shop: "food",
    channel: "WEB",
    turns: [orderTurn("Cho chị 1 hộp ruốc bông tôm, Lan 0961006201, Số 5 ngõ 12 xóm Chùa, Hà Nội", "0961006201", "Số 5 ngõ 12 xóm Chùa, Hà Nội", "Mình cho em xin tên phường / xã để em giao đúng nhé.")],
  },
  {
    key: "anr-thieu-tinh",
    title: "Chữ địa chỉ không đọc được tỉnh ⇒ vẫn tự chốt kèm cờ (A1), model hỏi tỉnh bị chặn",
    shop: "food",
    channel: "WEB",
    turns: [orderTurn("Cho chị 1 hộp ruốc bông tôm, Lan 0961006202, Số 5 ngõ 12 xóm Chùa", "0961006202", "Số 5 ngõ 12 xóm Chùa", "Mình ở tỉnh / thành phố nào ạ?")],
  },
  {
    key: "anr-ten-cu",
    title: "Địa chỉ theo địa giới CŨ trước sáp nhập (phường + quận cũ) ⇒ không hỏi khách tên phường mới",
    shop: "food",
    channel: "WEB",
    turns: [orderTurn("Cho chị 1 hộp ruốc bông tôm, Lan 0961006203, Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội", "0961006203", "Số 8 ngõ 2 phường Đại Kim, quận Hoàng Mai, Hà Nội", "Đại Kim cũ nay là phường nào theo tên mới ạ?")],
  },
  {
    key: "anr-hai-noi",
    title: "Hai nơi khớp (tên đường có ở nhiều phường) ⇒ không hỏi khách chọn, máy / nhân viên kiểm",
    shop: "food",
    channel: "WEB",
    turns: [orderTurn("Cho chị 1 hộp ruốc bông tôm, Lan 0961006204, Số 12 Nguyễn Trãi, Hà Nội", "0961006204", "Số 12 Nguyễn Trãi, Hà Nội", "Nguyễn Trãi bên Thanh Xuân hay Hà Đông ạ?")],
  },
  {
    key: "anr-chua-co-dia-chi",
    title: "Khách CHƯA gửi chữ địa chỉ nào ⇒ được hỏi địa chỉ ĐÚNG một lần",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "Cho chị 1 hộp ruốc bông tôm, sđt 0961006205", ai: [() => [say("Dạ mình cho em xin địa chỉ nhận hàng nhé.")]] }],
  },
];

export async function testAddressNeverReaskChat() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-anr",
    beforeCase: async () => {
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false, autoUpsellOffer: false });
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx: GoldenHookCtx, t) => {
      seen.add(c.key);
      const e = EXPECT[c.key];
      const all = t.turns.flatMap((x) => x.shown);
      const asks = all.filter((s) => ASKS_ADDRESS.test(s));
      assert.equal(asks.length, e.asks, `[${c.key}] số câu hỏi địa chỉ tới khách: ${all.join(" | ")}`);
      assert.ok(!all.some((s) => s === CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS || s === CLAIM_SAFE_TEXT.ORDER_RECEIVED), `[${c.key}] không câu «ghi nhận / nhân viên xác nhận địa chỉ»: ${all.join(" | ")}`);
      const db = await getDb();
      const [o] = await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      if (!e.confirmed) {
        assert.ok(!o || o.stage !== "CONFIRMED", `[${c.key}] chưa có địa chỉ ⇒ chưa chốt`);
        return;
      }
      assert.ok(o && o.stage === "CONFIRMED", `[${c.key}] đơn tự chốt: ${o?.stage} · ${JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results))).slice(0, 900)}`);
      assert.ok(all.some((s) => s.startsWith(MODEL_OK)), `[${c.key}] câu chốt THƯỜNG đi qua: ${all.join(" | ")}`);
      if (!o.shipCommune) assert.equal(addressReviewOpenOf(o.raw), true, `[${c.key}] chưa ghép được xã ⇒ cờ địa chỉ mở (việc nội bộ)`);
      const shipments = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.orderId, o.id));
      assert.equal(shipments.length, 0, `[${c.key}] chưa xác minh địa chỉ ⇒ không vận đơn`);
      const at = (o.raw as { addressText?: { lines?: string[] } }).addressText;
      if (e.addressText) assert.ok(at?.lines?.length, `[${c.key}] chữ địa chỉ nguyên văn lưu ở raw.addressText: ${JSON.stringify(at)}`);
      assert.ok(!JSON.stringify(at ?? {}).includes("0961006"), `[${c.key}] raw.addressText không mang SĐT`);
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  console.log("  ✓ chatTurn: model hỏi phường / tỉnh / phường mới / chọn nơi ⇒ khách không nhận · chưa có địa chỉ ⇒ hỏi đúng một lần · chốt + cờ + 0 vận đơn · chữ địa chỉ nguyên văn lưu lên đơn");
}

export async function testAddressNeverReask(): Promise<void> {
  testAddressNeverReaskPure();
  await testAddressNeverReaskChat();
  console.log("✓ AGENTS 3.12b — địa chỉ khách không bao giờ hỏi lại: biên chặt · một điểm chặn cuối cho mọi chữ bot + tin theo dõi · công cụ / giỏ / tự chốt không hỏi · chốt + upsell như đơn thường, vận đơn giữ lại");
}

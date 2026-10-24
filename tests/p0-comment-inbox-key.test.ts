/**
 * ═══════════ P0 HSLC 24/10/2026 — BÌNH LUẬN SANG HỘP THƯ MẤT MẠCH + LƯỢT ĐÃ CHUYỂN NGƯỜI VẪN LÊN ĐƠN (ca «Trần Thị Ngọc», đã che) ═══════════
 *
 * Đo production (ops comment-inbox-link-probe run 40079521758 · 40079613553): khách bình luận SĐT + địa chỉ ⇒ bot chốt đơn ở hội thoại
 * BÌNH LUẬN; lượt chép sang hộp thư «MOVED» đổi khoá hội thoại sang `fanpageVisitorKey(page, "m_…")` — `m_…` là mã TIN NHẮN Meta mà
 * `privateReplyInbox` lấy từ `private_reply_conversation.id` trước `conversation_id`. Webhook hộp thư mang luồng `<page_id>_<PSID>` ⇒ mở
 * hội thoại MỚI, trắng ngữ cảnh ⇒ câu mẫu «xin SĐT + địa chỉ» ⇒ «Địa chỉ gửi rồi mà» ⇒ hàng rào chuyển người SAU vòng công cụ, khi
 * create_customer + create_draft_order đã ghi đơn thứ hai. 58/58 lượt chép trong 3 ngày đi đường ấy.
 *
 * Khoá:
 *  1. `privateReplyInboxId`: chỉ nhận mã dạng `<page_id>_\d+`; payload thật (id = «m_…», conversation_id = page_PSID) ⇒ conversation_id;
 *     chỉ có «m_…» ⇒ dựng page + from_id; from_id không phải số ⇒ KHÔNG đoán; không bao giờ trả «m_…».
 *  2. `complainsOfContactReask`: «Địa chỉ gửi rôi mà» (chữ thật, thiếu dấu) sau câu xin SĐT + địa chỉ ⇒ có; không có câu xin trước ⇒ không.
 *  3. `handoffBlocksWrite`: lượt đã quyết chuyển người ⇒ bốn công cụ ghi bị chặn; mốc của lượt trước không chặn; công cụ đọc không chặn.
 *  4. Hội thoại thật (`chatTurn`, model kịch bản, FANPAGE): đúng trình tự 07:01–07:03 ⇒ lượt phàn nàn KHÔNG hỏi model (0 vòng), HANDOFF,
 *     0 đơn; và lượt model gọi handoff_to_human rồi create_draft_order CÙNG vòng ⇒ đơn không được lên.
 * Dữ liệu dựng (không PII): SĐT 0961007xxx, địa chỉ hư cấu.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ADDRESS_HANDOFF_REASON, complainsOfContactReask } from "@/lib/sales-chatbot/address-memory";
import { privateReplyInboxId } from "@/lib/sales-chatbot/fanpage";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { HANDOFF_BLOCKED_WRITE_TOOLS, handoffBlocksWrite } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const PAGE = "100200300400500";
const PSID = "29100200300400500";

export function testCommentInboxKeyPure() {
  // 1 · Mã hộp thư.
  const real = privateReplyInboxId({ id: "m_shyjBB5_IsPdFxVG1efyZQ", conversation_id: `${PAGE}_${PSID}` }, PAGE, PSID);
  assert.deepEqual(real, { replied: true, inboxId: `${PAGE}_${PSID}`, source: "PANCAKE_CONV_ID" }, "payload ca Ngọc: conversation_id, KHÔNG phải id tin «m_…»");
  assert.deepEqual(privateReplyInboxId({ id: "m_shyjBB5_IsPdFxVG1efyZQ" }, PAGE, PSID), { replied: true, inboxId: `${PAGE}_${PSID}`, source: "DERIVED_PAGE_PSID" }, "chỉ có mã tin ⇒ dựng page_PSID từ from_id");
  assert.deepEqual(privateReplyInboxId(`${PAGE}_${PSID}`, PAGE, PSID), { replied: true, inboxId: `${PAGE}_${PSID}`, source: "PANCAKE_CONV_ID" }, "chuỗi trần đúng dạng");
  assert.deepEqual(privateReplyInboxId("m_x", PAGE, PSID).source, "DERIVED_PAGE_PSID", "chuỗi trần «m_…» không bao giờ thành khoá");
  assert.deepEqual(privateReplyInboxId({ id: "m_x" }, PAGE, "not-a-psid"), { replied: true, inboxId: null, source: "NONE" }, "from_id không phải số ⇒ không đoán");
  assert.deepEqual(privateReplyInboxId({ conversation_id: `999_${PSID}` }, PAGE, PSID).inboxId, `${PAGE}_${PSID}`, "mã hộp thư của page KHÁC không được nhận");
  for (const none of [null, undefined, "", "  "]) assert.deepEqual(privateReplyInboxId(none, PAGE, PSID), { replied: false, inboxId: null, source: "NONE" }, `chưa nhắn riêng: ${String(none)}`);
  for (const prc of [{ id: "m_a", conversation_id: "m_b" }, "m_a", { id: "m_a" }]) {
    assert.ok(!privateReplyInboxId(prc, PAGE, PSID).inboxId?.startsWith("m_"), `không bao giờ trả mã tin: ${JSON.stringify(prc)}`);
  }
  // Mã nguồn: hai lời đọc hộp thư của deliverCommentReply đi qua hàm thuần, và «đã nhắn riêng» đọc `replied` (không phải mã có hay không).
  const src = readFileSync("lib/sales-chatbot/fanpage.ts", "utf8");
  assert.equal((src.match(/privateReplyInbox\(pageId, threadId, commentId, input\.fromId, token, fetchImpl\)/g) ?? []).length, 2, "cả hai lần đọc hộp thư truyền from_id");
  assert.match(src, /if \(before\.replied\) \{/, "Pancake / nhân viên đã nhắn riêng ⇒ không nhắn lần hai, kể cả khi không ra được mã hộp thư");
  assert.doesNotMatch(src, /str\(\(prc as \{ id\?: unknown \}\)\.id\) \|\| str\(\(prc as \{ conversation_id/, "không còn lấy id TRƯỚC conversation_id");

  // 2 · Lời phàn nàn trên tin khách.
  const asked = ["Dạ, mình đặt hàng cho em xin SĐT + địa chỉ, em giao hàng ạ!"];
  assert.equal(complainsOfContactReask("Địa chỉ gửi rôi mà", asked), true, "chữ thật của ca Ngọc (thiếu dấu)");
  assert.equal(complainsOfContactReask("Địa chỉ gửi rồi mà", asked), true);
  assert.equal(complainsOfContactReask("Địa chỉ gửi rồi mà", ["Dạ bên em có chả mực giã tay ạ."]), false, "chưa ai xin thông tin ⇒ không phải phàn nàn bị hỏi lại");
  assert.equal(complainsOfContactReask("ok em", asked), false);
  assert.equal(complainsOfContactReask("Địa chỉ gửi rồi mà", ["[Shop đã nhắn] cho em xin SĐT + địa chỉ ạ"]), false, "tin page / nhân viên chép vào lịch sử không phải câu bot (như hàng rào)");

  // 3 · Lưới công cụ ghi.
  const turn = new Date("2026-10-24T07:03:08Z");
  const thisTurn = { handoff: { reason: ADDRESS_HANDOFF_REASON.COMPLAINT, at: "2026-10-24T07:03:09.000Z" } };
  const lastTurn = { handoff: { reason: "x", at: "2026-10-24T06:00:00.000Z" } };
  for (const t of HANDOFF_BLOCKED_WRITE_TOOLS) assert.equal(handoffBlocksWrite(t, thisTurn, turn), true, `${t} bị chặn khi lượt đã chuyển người`);
  assert.deepEqual([...HANDOFF_BLOCKED_WRITE_TOOLS].sort(), ["confirm_order", "create_customer", "create_draft_order", "update_draft_order"]);
  assert.equal(handoffBlocksWrite("create_draft_order", lastTurn, turn), false, "mốc chuyển người của lượt TRƯỚC không chặn");
  assert.equal(handoffBlocksWrite("create_draft_order", {}, turn), false);
  assert.equal(handoffBlocksWrite("search_products", thisTurn, turn), false, "công cụ đọc không bị chặn");
  assert.equal(handoffBlocksWrite("create_draft_order", thisTurn, undefined), false, "không có đồng hồ lượt (gọi lẻ) ⇒ không xét");
  console.log("  ✓ thuần: mã hộp thư chỉ dạng page_PSID (payload ca Ngọc ⇒ conversation_id · chỉ «m_…» ⇒ dựng · không đoán) · phàn nàn trên tin khách · lưới bốn công cụ ghi");
}

const PHONE = "0961007101";
const CASES: GoldenCase[] = [
  {
    key: "ngoc-phan-nan-hoi-lai",
    title: "07:01 xin SĐT + địa chỉ → 07:03 «Địa chỉ gửi rôi mà» ⇒ chuyển người TRƯỚC model, 0 đơn",
    shop: "food",
    channel: "FANPAGE",
    turns: [
      { say: "Cho 1l nước mắm cá cơm và 1k chả mực xem như thế mào nhé", ai: [() => [say("Dạ, mình đặt hàng cho em xin SĐT + địa chỉ, em giao hàng ạ!")]] },
      {
        say: "Địa chỉ gửi rôi mà",
        ai: [
          () => [tool("create_customer", { name: "Khách", phone: PHONE, address: "Số 7 ngõ 1, xã Thử Nghiệm, tỉnh Hà Tĩnh" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
        ],
      },
    ],
  },
  {
    key: "ngoc-luoi-cong-cu-ghi",
    title: "model gọi handoff_to_human rồi create_draft_order CÙNG vòng ⇒ đơn không được lên",
    shop: "food",
    channel: "FANPAGE",
    turns: [
      {
        say: `Cho chị 1kg chả mực, sđt ${PHONE}, số 7 ngõ 1 xã Thử Nghiệm Hà Tĩnh`,
        ai: [({ v }) => [tool("handoff_to_human", { reason: "Khách cần nhân viên kiểm" }), tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })]],
      },
    ],
  },
];

export async function testCommentInboxKeyChat() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-cik",
    beforeCase: async () => {
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: false, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false, autoUpsellOffer: false });
    },
    afterCase: async (c, ctx: GoldenHookCtx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const orders = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results))).slice(0, 900);
      assert.equal(orders.length, 0, `[${c.key}] lượt đã chuyển người KHÔNG lên đơn: ${results}`);
      assert.equal(t.final.status, "HANDOFF", `[${c.key}] hội thoại chuyển người`);
      if (c.key === "ngoc-phan-nan-hoi-lai") {
        assert.equal(t.turns[1].rounds.length, 0, `lượt phàn nàn KHÔNG hỏi model (không vòng công cụ nào): ${results}`);
        assert.equal(t.final.handoffReason, ADDRESS_HANDOFF_REASON.COMPLAINT);
        assert.deepEqual(t.turns[1].shown, [], "fanpage: bot không nhắn gì, nhân viên tiếp quản");
      }
      if (c.key === "ngoc-luoi-cong-cu-ghi") assert.match(results, /Lượt này ĐÃ chuyển nhân viên/, `create_draft_order trả lỗi «đã chuyển nhân viên»: ${results}`);
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  console.log("  ✓ chatTurn FANPAGE: trình tự 07:01–07:03 ca Ngọc ⇒ chuyển người trước model, 0 vòng công cụ, 0 đơn · handoff + ghi cùng vòng ⇒ không ghi");
}

export async function testCommentInboxKey(): Promise<void> {
  testCommentInboxKeyPure();
  await testCommentInboxKeyChat();
  console.log("✓ P0 24/10 bình luận → hộp thư: khoá hộp thư chỉ dạng page_PSID, không bao giờ «m_…» · khách phàn nàn bị hỏi lại ⇒ chuyển người trước model · lượt đã chuyển người không ghi khách / đơn");
}

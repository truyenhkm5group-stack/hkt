/**
 * ═══ BÌNH LUẬN CỦA CHÍNH KHÁCH ⇒ HỘP THƯ BIẾT (lib/sales-chatbot/comment-facts.ts — P2-3 / P2-4, P0 HSLC 24/10/2026, ca «Trần Thị Ngọc») ═══
 *
 * Khoá: chu kỳ tra (chưa tra · không thấy và quá 10 phút ⇒ tra lại · đã thấy ⇒ thôi) · hồ sơ bình luận dùng được (không phải thử, có SĐT
 * hoặc địa chỉ) chép sang mang nguồn COMMENT · lời nhắc rỗng khi không liên kết, nêu đơn bằng mã ngắn · mã nguồn: chỉ kênh FANPAGE, trước
 * khối đơn thật, không ghi vào hội thoại bình luận, không chạm `otherConversationOrders` (pha 3 của code-erp-95) · hội thoại thật
 * (`chatTurn`, model kịch bản): model xin SĐT + địa chỉ ⇒ khách KHÔNG nhận câu đó, hồ sơ chép sang, lời nhắc nêu đơn; khách KHÁC (cùng
 * page, khác PSID) ⇒ không nối, không chép.
 * Dữ liệu dựng (không PII): SĐT 0961007xxx, số nhà hư cấu, mã Facebook dựng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { MANUAL_ORDER_ID_PREFIX, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { COMMENT_CONTACT_KNOWN_TEXT, LINKED_COMMENT_RECHECK_MS, commentContactHeld, dropCommentContactAsks, linkedCommentPrompt, needsLinkedCheck, usableCommentCustomer } from "@/lib/sales-chatbot/comment-facts";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { runGoldenCases, say, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const PAGE = "100200300400777";
const PSID = "29100200300400777";
const POST = "481260000000777";
const CID = "1132201893038777";
const META_TEXT = `Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.(https://facebook.com/${PAGE}/posts/${POST}/?comment_id=${CID})`;
const ORDER_ID = `${MANUAL_ORDER_ID_PREFIX}ab12cd34-0000-4000-8000-000000000777`;
const CUSTOMER = { id: null, name: "Ngọc", phone: "0961007201", address: "Số 9 ngõ 3 xóm Đình, Hà Nội", province: "Hà Nội", simulated: false };

const MODEL_ASK = "Dạ chị cho em xin SĐT và địa chỉ nhận hàng để em lên đơn nhé.";
/** Câu bot xin / hỏi SĐT hoặc địa chỉ (bản kiểm của bài — rộng). */
const ASKS_CONTACT = /xin (?:lại )?(?:sđt|số điện thoại|địa chỉ)|(?:sđt|số điện thoại|địa chỉ)[^.!?]*\?/iu;

export function testCommentFactsPure() {
  const now = new Date("2026-10-24T08:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(needsLinkedCheck({}, now), true, "chưa tra ⇒ tra");
  assert.equal(needsLinkedCheck({ linkedComment: { checkedAt: ago(60_000), found: false } }, now), false, "không thấy, chưa quá chu kỳ ⇒ thôi");
  assert.equal(needsLinkedCheck({ linkedComment: { checkedAt: ago(LINKED_COMMENT_RECHECK_MS), found: false } }, now), true, "không thấy, đủ chu kỳ ⇒ tra lại");
  assert.equal(needsLinkedCheck({ linkedComment: { checkedAt: ago(86_400_000), found: true } }, now), false, "đã thấy ⇒ không tra nữa");
  assert.equal(needsLinkedCheck({ linkedComment: { checkedAt: "x", found: false } }, now), true, "mốc hỏng ⇒ tra");

  assert.equal(usableCommentCustomer(undefined, "c1", now), null);
  assert.equal(usableCommentCustomer({ ...CUSTOMER, simulated: true }, "c1", now), null, "hồ sơ thử không chép");
  assert.equal(usableCommentCustomer({ ...CUSTOMER, phone: " ", address: "" }, "c1", now), null, "không SĐT lẫn địa chỉ ⇒ không chép");
  const u = usableCommentCustomer(CUSTOMER, "c1", now);
  assert.deepEqual([u?.source, u?.sourceConversationId, u?.phone, u?.at], ["COMMENT", "c1", CUSTOMER.phone, now.toISOString()], "mang nguồn + id hội thoại + mốc");

  assert.equal(linkedCommentPrompt(undefined), "");
  assert.equal(linkedCommentPrompt({ checkedAt: now.toISOString(), found: false }), "", "không liên kết ⇒ không lời nhắc");
  const p = linkedCommentPrompt({ checkedAt: now.toISOString(), found: true, conversationId: "c1", orderId: ORDER_ID, customerCopied: true });
  assert.match(p, /KHÔNG xin lại/);
  assert.ok(p.includes(`#${manualOrderShortCode(ORDER_ID)}`) && !p.includes(ORDER_ID), `đơn nêu bằng mã ngắn: ${p}`);
  const noCopy = linkedCommentPrompt({ checkedAt: now.toISOString(), found: true, conversationId: "c1", orderId: null, customerCopied: false });
  assert.ok(!/KHÔNG xin lại/.test(noCopy) && !/ĐÃ CÓ đơn/.test(noCopy), "không chép, không đơn ⇒ chỉ dòng đầu");

  // Điểm chặn: hồ sơ chép từ bình luận còn đứng ⇒ bỏ câu xin lại SĐT / địa chỉ, kể cả lần hỏi ĐẦU.
  const fromComment = { customer: { ...CUSTOMER, source: "COMMENT" as const, sourceConversationId: "c1" } };
  assert.deepEqual(commentContactHeld(fromComment, "Chị muốn lấy thêm 1 hũ ruốc nữa"), { address: true, phone: true }, "nói tiếp về đơn ⇒ hồ sơ đứng");
  assert.deepEqual(commentContactHeld(fromComment, "Gửi cho mẹ chị dưới quê nhé"), { address: false, phone: false }, "đổi người / nơi nhận ⇒ được hỏi");
  assert.deepEqual(commentContactHeld({ customer: CUSTOMER }, "Chị muốn lấy thêm 1 hũ ruốc nữa"), { address: false, phone: false }, "hồ sơ không mang nguồn COMMENT ⇒ hàng rào chung lo");
  const held = { address: true, phone: true };
  assert.deepEqual(dropCommentContactAsks(MODEL_ASK, held), { text: COMMENT_CONTACT_KNOWN_TEXT, dropped: 1 });
  assert.deepEqual(dropCommentContactAsks("Dạ em thêm 1 hũ ruốc cho chị nhé. Chị cho em xin SĐT ạ.", held), { text: "Dạ em thêm 1 hũ ruốc cho chị nhé.", dropped: 1 }, "giữ câu khác");
  assert.deepEqual(dropCommentContactAsks("Chị cho em xin SĐT ạ.", { address: true, phone: false }), { text: "Chị cho em xin SĐT ạ.", dropped: 0 }, "chưa có SĐT ⇒ được xin SĐT");
  assert.deepEqual(dropCommentContactAsks("Dạ chị lấy 1 hay 2 hũ ạ?", held), { text: "Dạ chị lấy 1 hay 2 hũ ạ?", dropped: 0 });

  // Mã nguồn.
  const engine = readFileSync("lib/sales-chatbot/engine.ts", "utf8").replace(/\r\n/g, "\n");
  const at = engine.indexOf('if (opts.channel === "FANPAGE" && needsLinkedCheck(st0, now))');
  assert.ok(at > 0 && at < engine.indexOf("// ĐƠN THẬT THẮNG STATE CŨ"), "chỉ kênh FANPAGE, trước khối đơn thật");
  assert.match(engine, /loadLinkedComment\(conv\.id, now\)\.catch\(\(\) => null\)/, "lỗi tra ⇒ bỏ qua, không chặn lượt");
  assert.match(engine, /lc\.customer && !st0\.customer \? \{ customer: lc\.customer \}/, "chỉ chép khi hộp thư CHƯA có hồ sơ");
  assert.match(engine, /linkedCommentPrompt\(known\.linkedComment\)/);
  assert.match(engine, /async function appendMessage[\s\S]{0,900}dropCommentContactAsks\(b\.text, held\)/, "mọi chữ bot của lượt đi qua điểm chặn hồ sơ bình luận");
  assert.match(engine, /turnAddressGiven\.delete\(args\[0\]\);\n {4}turnCommentContact\.delete\(args\[0\]\);/, "ô của lượt luôn được dọn");
  const src = readFileSync("lib/sales-chatbot/comment-facts.ts", "utf8");
  assert.ok(!/\.(?:update|insert|delete)\(/.test(src), "comment-facts.ts chỉ đọc");
  assert.ok(!/otherConversationOrders/.test(src), "không chạm gộp đơn (pha 3 của code-erp-95)");
  console.log("  ✓ thuần: chu kỳ tra · hồ sơ bình luận dùng được mang nguồn COMMENT · lời nhắc rỗng khi không liên kết, đơn bằng mã ngắn · mã nguồn: FANPAGE, trước đơn thật, chỉ đọc");
}

/** Gieo hội thoại bình luận (+ tin hệ thống Meta khi `meta`), rồi biến hội thoại vàng thành hộp thư `<page>_<inboxPsid>`. Hai ca chung một tổ chức thử ⇒ PSID hộp thư riêng từng ca. */
async function seed(ctx: GoldenHookCtx, inboxPsid: string, commentPsid: string, meta: boolean) {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const thread = `m_cf_${commentPsid.slice(-4)}`;
  await db.insert(c).values({
    channel: "FANPAGE",
    pageId: PAGE,
    threadId: thread,
    visitorKey: fanpageVisitorKey(PAGE, thread),
    state: {
      postContext: { postId: POST, text: null },
      commentOrigin: { postId: POST, commentIds: [`${POST}_${CID}`], fromIds: [commentPsid], at: new Date().toISOString() },
      customer: CUSTOMER,
      confirmed: { orderId: ORDER_ID, simulated: false, total: 350_000, at: new Date().toISOString() },
    },
  });
  await db.update(c).set({ pageId: PAGE, threadId: `${PAGE}_${inboxPsid}` }).where(eq(c.id, ctx.conversationId));
  if (meta) await db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: `${PAGE}_${inboxPsid}`, messageId: `cf-meta-${commentPsid.slice(-4)}`, text: META_TEXT, status: "DONE", note: "PAGE_REPLY", senderKind: "META_SYSTEM" });
}

const CASES: GoldenCase[] = [
  {
    key: "cf-cung-khach",
    title: "Khách bình luận SĐT + địa chỉ, bot chốt ở bình luận; khách nhắn hộp thư ⇒ không bị xin lại, đơn được nêu",
    shop: "food",
    channel: "FANPAGE",
    turns: [{ say: "Chị muốn lấy thêm 1 hũ ruốc nữa", before: (ctx) => seed(ctx, PSID, PSID, true), ai: [() => [say(MODEL_ASK)]] }],
  },
  {
    key: "cf-khach-khac",
    title: "Bình luận của người KHÁC (khác PSID) cùng page ⇒ không nối, không chép hồ sơ",
    shop: "food",
    channel: "FANPAGE",
    turns: [{ say: "Chị muốn lấy 1 hũ ruốc", before: (ctx) => seed(ctx, "29100200300408888", "29100200300409999", false), ai: [() => [say(MODEL_ASK)]] }],
  },
];

export async function testCommentFactsChat() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-cf",
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const [row] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const st = (row.state ?? {}) as ChatState;
      const shown = t.turns.flatMap((x) => x.shown);
      const prompt = t.prompts[t.turns[0].rounds[0]?.prompt ?? -1] ?? "";
      if (c.key === "cf-cung-khach") {
        assert.ok(st.linkedComment?.found && st.linkedComment.customerCopied, `[${c.key}] đã nối: ${JSON.stringify(st.linkedComment)}`);
        assert.deepEqual([st.customer?.phone, st.customer?.address, st.customer?.source], [CUSTOMER.phone, CUSTOMER.address, "COMMENT"], `[${c.key}] hồ sơ chép sang: ${JSON.stringify(st.customer)}`);
        // Harness chuẩn hoá mã đơn trong prompt thành «#<MÃ ĐƠN>» — mã ngắn thật đã khoá ở phần thuần.
        assert.ok(prompt.includes("KHÁCH NÀY VỪA BÌNH LUẬN") && /KHÔNG xin lại/.test(prompt) && /ĐÃ CÓ đơn #(?:<MÃ ĐƠN>|[A-Z0-9]{8}) lên từ lượt bình luận/.test(prompt), `[${c.key}] lời nhắc nêu bình luận + đơn: ${prompt.slice(-600)}`);
        assert.ok(!shown.some((s) => ASKS_CONTACT.test(s)), `[${c.key}] khách không nhận câu xin SĐT / địa chỉ: ${shown.join(" | ")}`);
      } else {
        assert.equal(st.linkedComment?.found, false, `[${c.key}] khác PSID ⇒ không nối: ${JSON.stringify(st.linkedComment)}`);
        assert.equal(st.customer, undefined, `[${c.key}] không chép hồ sơ người khác`);
        assert.ok(!prompt.includes("KHÁCH NÀY VỪA BÌNH LUẬN"), `[${c.key}] không lời nhắc`);
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  console.log("  ✓ chatTurn: cùng khách (VERIFIED) ⇒ hồ sơ chép sang nguồn COMMENT, lời nhắc nêu đơn, khách không bị xin lại · khác PSID ⇒ không nối, không chép");
}

export async function testCommentFacts(): Promise<void> {
  testCommentFactsPure();
  await testCommentFactsChat();
  console.log("✓ P2-3 / P2-4 — bình luận của chính khách ⇒ hộp thư biết: chỉ VERIFIED · chép hồ sơ khi hộp thư chưa có · đơn chỉ được NÊU · không ghi vào bình luận");
}

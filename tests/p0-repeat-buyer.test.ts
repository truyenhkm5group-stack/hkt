/**
 * P0 17/10/2026 — KHÁCH CŨ MUA LẠI, BOT LẤY NHẦM ĐƠN CŨ (HSLC «Honganh Tran», đã che tên / SĐT / địa chỉ):
 *
 *  · 27/05 khách nhắn «Cho 1kg» (lượt mua trước, không chốt qua bot). 17/10 khách BÌNH LUẬN «Cho 1,5 kg gửi đc cũ». Bot nhắn riêng, khách
 *    trả lời trong hộp thư ⇒ bot lên đơn 1 kg 280.000 ₫ và hỏi lại phường / xã.
 *  · Gốc 1: lượt mua chỉ được cắt khi bot TỰ chốt (`confirmed` ⇒ `pastOrders`) ⇒ đơn lên ngoài bot không để lại mốc ⇒ lời mua tháng 5 là
 *    «lượt mua hiện tại». Nay: im lặng quá NEW_ROUND_GAP_MS ⇒ lượt mua mới (`roundStartAt`).
 *  · Gốc 2: hội thoại bình luận chỉ được chuyển sang hộp thư khi hộp thư CHƯA có hội thoại — khách cũ luôn đã có ⇒ lời mua trong bình
 *    luận nằm lại. Nay: `carryCommentTurn` chép lượt bình luận sang hội thoại hộp thư, mở lượt mua mới ở đó, mang giỏ của bình luận theo.
 *
 * Mốc trong bài là khoảng cách so với «bây giờ» của CHÍNH lượt chạy (truyền vào hàm) — không ghim ngày tuyệt đối (luật 50).
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { customerTextsSince } from "@/lib/sales-chatbot/cart-commitment";
import { carryCommentTurn, COMMENT_BATCH_WINDOW_MS, freshPurchaseRound, lastCustomerTextAt, NEW_ROUND_GAP_MS, openConversation, purchaseRoundStart } from "@/lib/sales-chatbot/engine";
import { fanpageBotSendersForTests, fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { setPageRuntimeReaderForTests } from "@/lib/sales-chatbot/page-runtime";
import { orderBeforeRound, orderIdempotencyKey } from "@/lib/sales-chatbot/tools";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { runGoldenCases, say, type GoldenCase } from "./sales-agent-golden/harness";

const NGAY = 24 * 3_600_000;
const cart = (grams: number) => ({ selectedItems: [{ label: "Chả cá thu", match: "cha ca thu", productId: null, variantId: null, sku: null, quantity: grams, unit: "g" as const, sourceMessageId: 2, confidence: "HIGH" as const, customerExplicit: true }] });

function testThuan() {
  const now = new Date();
  const t = (d: number) => new Date(now.getTime() - d * NGAY).toISOString();
  assert.equal(purchaseRoundStart({}), null, "không đơn, không mốc ⇒ cả hội thoại");
  assert.equal(purchaseRoundStart({ roundStartAt: t(1) })?.toISOString(), t(1), "mốc lượt mua mới tự nó là ranh giới");
  assert.equal(purchaseRoundStart({ roundStartAt: t(10), pastOrders: [{ orderId: null, simulated: false, total: 1, at: t(2) }] })?.toISOString(), t(2), "lấy mốc MUỘN NHẤT");
  const st: ChatState = { cart: cart(1000) as ChatState["cart"], quote: { id: "q", priceVersion: "pv", verified: true, subtotal: 280_000, total: 280_000, amounts: [] } as unknown as ChatState["quote"], pastOrders: [] };
  const f = freshPurchaseRound(st, 7, now, new Date(now.getTime() - 1));
  assert.equal(f.cart, undefined, "lượt mua mới không mang giỏ cũ");
  assert.equal(f.quote, undefined, "lượt mua mới không mang báo giá cũ");
  assert.equal(f.cycleStartTurns, 7);
  assert.equal(f.roundStartAt, new Date(now.getTime() - 1).toISOString());
  assert.deepEqual(f.pastOrders, [], "không có đơn chốt ⇒ pastOrders không thêm gì");
  const c = freshPurchaseRound({ confirmed: { orderId: "o1", simulated: false, total: 1, at: t(5) } }, 1, now);
  assert.equal(c.pastOrders?.length, 1, "đơn chốt sang lượt mua trước");
  assert.equal(c.confirmed, undefined);
  assert.equal(c.roundStartAt, undefined, "đường cũ (bot đã chốt) không đặt mốc mới — mốc là lúc chốt");
  const text = (s: string) => [{ type: "text" as const, text: s }];
  assert.equal(lastCustomerTextAt([{ role: "user", content: text("Cho 1kg"), at: new Date(t(150)) }, { role: "assistant", content: text("Dạ"), at: new Date(t(1)) }])?.toISOString(), t(150));
  assert.equal(lastCustomerTextAt([]), null);
  assert.ok(NEW_ROUND_GAP_MS >= 3 * NGAY, "khách hỏi hôm nay, chốt vài hôm sau vẫn là MỘT lượt mua");
}

async function tinCua(conversationId: string) {
  const db = await getDb();
  const rows = await db.select().from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, conversationId)).orderBy(schema.salesChatMessages.seq);
  return rows.map((r) => ({ role: (r.role === "assistant" ? "assistant" : "user") as "user" | "assistant", at: r.createdAt, text: ((r.content ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") }));
}

async function testChepBinhLuan() {
  const db = await getDb();
  const now = new Date();
  const m = schema.salesChatMessages;
  const c = schema.salesChatConversations;
  const moi = async (key: string) => (await openConversation("FANPAGE", { visitorKey: `p0-repeat-${key}-${now.getTime()}` })).id;
  // Hộp thư CŨ: lời mua tháng 5.
  const hopThu = await moi("inbox");
  await db.insert(m).values({ conversationId: hopThu, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1kg" }], createdAt: new Date(now.getTime() - 143 * NGAY) });
  await db.update(c).set({ state: { cart: cart(1000) } as Record<string, unknown> }).where(eq(c.id, hopThu));
  // Hội thoại BÌNH LUẬN hôm nay.
  const binhLuan = await moi("comment");
  await db.insert(m).values([
    { conversationId: binhLuan, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1,5 kg gửi đc cũ" }] },
    { conversationId: binhLuan, seq: 3, role: "assistant", content: [{ type: "text", text: "Dạ em nhắn riêng chị ạ" }] },
  ]);
  await db.update(c).set({ state: { cart: cart(1500) } as Record<string, unknown> }).where(eq(c.id, binhLuan));

  assert.ok((await carryCommentTurn(binhLuan, hopThu, now, { botReplySent: true })).copied > 0);
  const [row] = await db.select().from(c).where(eq(c.id, hopThu));
  const st = (row.state ?? {}) as ChatState;
  const tin = await tinCua(hopThu);
  const luot = customerTextsSince(tin, purchaseRoundStart(st));
  assert.ok(luot.some((x) => /Cho 1,5 kg gửi đc cũ/.test(x) && /bình luận/.test(x)), `lời mua của bình luận vào lượt mua hiện tại của hộp thư: ${JSON.stringify(luot)}`);
  assert.ok(!luot.includes("Cho 1kg"), "lời mua tháng 5 KHÔNG còn là lượt mua hiện tại");
  assert.equal(st.cart?.selectedItems?.[0]?.quantity, 1500, "giỏ của bình luận (1,5 kg) đi theo, không phải giỏ cũ 1 kg");
  assert.ok(tin.some((x) => x.role === "assistant" && x.text === "Dạ em nhắn riêng chị ạ"), "tin bot của lượt bình luận cũng sang (bot không nhắn lại điều đã nói)");
  const soTin = tin.length;
  assert.deepEqual(await carryCommentTurn(binhLuan, hopThu, new Date(now.getTime() + 60_000), { botReplySent: true }), { copied: 0, already: true }, "chạy lại (webhook lặp) không chép hai lần");
  assert.equal((await tinCua(hopThu)).length, soTin);
  assert.deepEqual(await carryCommentTurn(hopThu, hopThu, now, { botReplySent: true }), { copied: 0, already: false }, "cùng một hội thoại ⇒ không làm gì");

  // Hộp thư đang có đơn bot CHỐT trong POST_ORDER_HANDOFF_MS ⇒ chỉ chép tin, KHÔNG xoá lượt mua đang chạy (không đụng đơn đang giao).
  const dangChot = await moi("inbox-chot");
  const chot = { orderId: "o-dang-giao", simulated: false, total: 280_000, at: new Date(now.getTime() - NGAY).toISOString() };
  await db.update(c).set({ state: { confirmed: chot, cart: cart(1000) } as Record<string, unknown> }).where(eq(c.id, dangChot));
  const bl2 = await moi("comment-2");
  await db.insert(m).values({ conversationId: bl2, seq: 2, role: "user", content: [{ type: "text", text: "Cho thêm 1kg nhé" }] });
  assert.ok((await carryCommentTurn(bl2, dangChot, now, { botReplySent: true })).copied > 0);
  const [r2] = await db.select().from(c).where(eq(c.id, dangChot));
  const s2 = (r2.state ?? {}) as ChatState;
  assert.equal(s2.confirmed?.orderId, "o-dang-giao", "đơn đang chạy giữ nguyên");
  assert.equal(s2.roundStartAt, undefined, "không mở lượt mua mới khi đơn vừa chốt còn trong hạn");
  assert.ok((await tinCua(dangChot)).some((x) => /Cho thêm 1kg nhé/.test(x.text)), "lời của bình luận vẫn tới hộp thư");

  // (review #886 · 1) Hộp thư đang có LƯỢT MUA CHẠY (khách «Cho chị 2kg» 10 phút trước, nháp, giỏ 2 kg, đã mời thêm) + khách bình luận
  // «còn hàng không shop» ⇒ CHỈ chép tin: nháp / giỏ / lời mời / mốc lượt mua giữ nguyên.
  const dangMua = await moi("inbox-dang-mua");
  await db.insert(m).values({ conversationId: dangMua, seq: 2, role: "user", content: [{ type: "text", text: "Cho chị 2kg" }], createdAt: new Date(now.getTime() - 10 * 60_000) });
  const stMua = { cart: cart(2000), draft: { orderId: "o-nhap", lines: [], unitPrices: {}, recipient: {}, note: "", simulated: false }, upsellSent: 3 };
  await db.update(c).set({ state: stMua as Record<string, unknown> }).where(eq(c.id, dangMua));
  const bl3 = await moi("comment-3");
  await db.insert(m).values([
    { conversationId: bl3, seq: 2, role: "user", content: [{ type: "text", text: "còn hàng không shop" }] },
    { conversationId: bl3, seq: 3, role: "assistant", content: [{ type: "text", text: "Dạ còn ạ" }] },
  ]);
  assert.ok((await carryCommentTurn(bl3, dangMua, now, { botReplySent: false })).copied > 0);
  const [r3] = await db.select().from(c).where(eq(c.id, dangMua));
  const s3 = (r3.state ?? {}) as ChatState;
  assert.equal(s3.draft?.orderId, "o-nhap", "nháp của lượt mua đang chạy giữ nguyên");
  assert.equal(s3.cart?.selectedItems?.[0]?.quantity, 2000, "giỏ 2 kg khách vừa nói giữ nguyên");
  assert.equal(s3.upsellSent, 3, "sổ lời mời của lượt giữ nguyên (#868)");
  assert.equal(s3.roundStartAt, undefined, "không cắt lượt mua đang chạy");
  const tin3 = await tinCua(dangMua);
  assert.ok(customerTextsSince(tin3, purchaseRoundStart(s3)).includes("Cho chị 2kg"), "lời mua 2 kg vẫn thuộc lượt hiện tại (#842/#864)");
  // (review #886 · 3) Nhánh ALREADY (Pancake / nhân viên đã nhắn riêng): câu bot soạn chưa từng tới khách ⇒ KHÔNG chép.
  assert.ok(tin3.some((x) => x.role === "user" && /còn hàng không shop/.test(x.text)), "tin khách của bình luận vẫn sang");
  assert.ok(!tin3.some((x) => x.role === "assistant" && x.text === "Dạ còn ạ"), "ALREADY ⇒ không chép câu bot chưa gửi");

  // Hộp thư do NGƯỜI giữ (HANDOFF), im lâu ⇒ chép tin, KHÔNG mở lượt mua mới, không xoá dấu chuyển người.
  const nguoi = await moi("inbox-handoff");
  await db.insert(m).values({ conversationId: nguoi, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1kg" }], createdAt: new Date(now.getTime() - 40 * NGAY) });
  await db.update(c).set({ status: "HANDOFF", state: { cart: cart(1000), handoff: { reason: "x" } } as Record<string, unknown> }).where(eq(c.id, nguoi));
  const bl4 = await moi("comment-4");
  await db.insert(m).values({ conversationId: bl4, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1,5 kg gửi đc cũ" }] });
  assert.ok((await carryCommentTurn(bl4, nguoi, now, { botReplySent: true })).copied > 0);
  const [r4] = await db.select().from(c).where(eq(c.id, nguoi));
  assert.equal(((r4.state ?? {}) as ChatState).roundStartAt, undefined, "người đang giữ ⇒ không cắt lượt mua");
  assert.ok(((r4.state ?? {}) as Record<string, unknown>).handoff, "không xoá dấu chuyển người");
  assert.ok((await tinCua(nguoi)).some((x) => /Cho 1,5 kg gửi đc cũ/.test(x.text)), "nhân viên vẫn thấy lời mua của bình luận trong hộp thư");

  // (review #886 · 4) Bình luận tách HAI tin («Cho 1,5kg» rồi «gửi đc cũ») ⇒ chép CẢ HAI, không chỉ tin cuối.
  const hai = await moi("inbox-hai-tin");
  const bl5 = await moi("comment-5");
  await db.insert(m).values([
    { conversationId: bl5, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1,5kg" }] },
    { conversationId: bl5, seq: 3, role: "user", content: [{ type: "text", text: "gửi đc cũ" }] },
    { conversationId: bl5, seq: 4, role: "assistant", content: [{ type: "text", text: "Dạ em nhắn riêng ạ" }] },
  ]);
  assert.ok((await carryCommentTurn(bl5, hai, now, { botReplySent: false })).copied > 0);
  const tin5 = (await tinCua(hai)).filter((x) => x.role === "user").map((x) => x.text);
  assert.ok(tin5.some((x) => /Cho 1,5kg/.test(x)) && tin5.some((x) => /gửi đc cũ/.test(x)), `cả hai tin của bình luận sang: ${JSON.stringify(tin5)}`);

  // (review #886 · 2) Đơn tạo TRƯỚC mốc lượt mua hiện tại = đơn của lượt CŨ ⇒ save_order không được dùng lại (và chuyển người).
  const maDon = `p0rb-don-${now.getTime()}`;
  await db.insert(schema.orders).values({ id: maDon, insertedAt: new Date(now.getTime() - 30 * NGAY) });
  assert.equal(await orderBeforeRound(maDon, { roundStartAt: new Date(now.getTime() - NGAY).toISOString() }), true, "đơn 30 ngày trước, lượt mua mở hôm qua ⇒ đơn lượt cũ");
  assert.equal(await orderBeforeRound(maDon, { roundStartAt: new Date(now.getTime() - 40 * NGAY).toISOString() }), false, "đơn thuộc lượt hiện tại ⇒ dùng lại được (gọi lại)");
  assert.equal(await orderBeforeRound(maDon, {}), false, "không có mốc lượt mua ⇒ không chặn");

  // (review #886 · 3) Hội thoại bình luận còn tin khách CŨ không ai trả lời («Cho 1kg» 4 tháng trước) + bình luận mới ⇒ CHỈ tin mới sang.
  const hopCu = await moi("inbox-binh-luan-cu");
  const bl6 = await moi("comment-6");
  await db.insert(m).values([
    { conversationId: bl6, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1kg" }], createdAt: new Date(now.getTime() - 120 * NGAY) },
    { conversationId: bl6, seq: 3, role: "user", content: [{ type: "text", text: "Cho 1,5 kg gửi đc cũ" }] },
  ]);
  assert.ok((await carryCommentTurn(bl6, hopCu, now, { botReplySent: false })).copied > 0);
  const tin6 = (await tinCua(hopCu)).filter((x) => x.role === "user").map((x) => x.text);
  assert.ok(tin6.some((x) => /Cho 1,5 kg gửi đc cũ/.test(x)), "bình luận mới sang");
  assert.ok(!tin6.some((x) => /\] Cho 1kg$/.test(x)), `bình luận 4 tháng trước KHÔNG sang: ${JSON.stringify(tin6)}`);
  assert.ok(COMMENT_BATCH_WINDOW_MS <= 60 * 60_000, "cửa sổ một lượt bình luận tính bằng phút, không phải ngày");
  console.log("  ✓ bình luận mua lại của khách cũ: chép sang hộp thư cũ, lượt mua mới từ lúc bình luận, giỏ 1,5 kg đi theo · chạy lại không chép hai lần · đơn đang chốt / lượt mua đang chạy / người đang giữ không bị cắt · ALREADY không chép câu bot chưa gửi");
}


function testKhoaDon() {
  const now = Date.now();
  assert.equal(orderIdempotencyKey("cv1", {}), "sales-chat:cv1:0", "hội thoại chưa có lượt mua mới giữ đúng khoá cũ");
  assert.equal(orderIdempotencyKey("cv1", { pastOrders: [{ orderId: null, simulated: false, total: 1, at: new Date(now).toISOString() }] }), "sales-chat:cv1:1");
  const a = orderIdempotencyKey("cv1", { roundStartAt: new Date(now - 1000).toISOString() });
  const b = orderIdempotencyKey("cv1", { roundStartAt: new Date(now).toISOString() });
  assert.notEqual(a, "sales-chat:cv1:0", "nháp bỏ dở rồi lượt mua mới ⇒ khoá MỚI, lõi đơn không trả lại đơn cũ (review #886 · 2)");
  assert.notEqual(a, b, "mỗi lượt mua mới một khoá");
  assert.equal(orderIdempotencyKey("cv1", { roundStartAt: new Date(now).toISOString() }), b, "cùng lượt ⇒ cùng khoá (gọi lại không đẻ đơn thứ hai)");
}

/** Đường THẬT: deliverCommentReply (Pancake đã nhắn riêng ⇒ ALREADY) → carryIntoInbox → hội thoại hộp thư theo visitorKey. */
async function testDuongThat() {
  const db = await getDb();
  const now = new Date();
  const PAGE = `p0rb-page-${now.getTime()}`;
  const INBOX = `${PAGE}_${now.getTime()}1`; // luồng hộp thư Pancake dạng <page_id>_<số> (đo production 24/10/2026)
  const hopThu = (await openConversation("FANPAGE", { visitorKey: fanpageVisitorKey(PAGE, INBOX) })).id;
  await db.insert(schema.salesChatMessages).values({ conversationId: hopThu, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1kg" }], createdAt: new Date(now.getTime() - 143 * NGAY) });
  const binhLuan = (await openConversation("FANPAGE", { visitorKey: `p0rb-cmt-${now.getTime()}` })).id;
  await db.insert(schema.salesChatMessages).values({ conversationId: binhLuan, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1,5 kg gửi đc cũ" }] });
  const fetchGia = (async (url: string | URL) => {
    if (/[/]messages[?]/.test(String(url))) return new Response(JSON.stringify({ messages: [{ id: "cmt-p0rb", private_reply_conversation: INBOX }] }), { status: 200 });
    return new Response(JSON.stringify({ success: false }), { status: 500 });
  }) as typeof fetch;
  // Page thử LIVE (cổng page đọc qua móc của bài kiểm — cùng cách tests/saas-page-gate.test.ts), trả lại ngay sau lời gọi.
  setPageRuntimeReaderForTests(async () => ({ [PAGE]: { mode: "LIVE" } }));
  const r = await fanpageBotSendersForTests.deliverCommentReply({ pageId: PAGE, threadId: "cmt-thread", commentId: "cmt-p0rb", postId: "post-1", fromId: "cust-1", text: "Dạ em nhắn riêng ạ", imageIds: [], conversationId: binhLuan }, { fetch: fetchGia, now: () => now }).finally(() => setPageRuntimeReaderForTests(null));
  assert.equal(r.kind, "ALREADY", JSON.stringify(r));
  const tin = await tinCua(hopThu);
  assert.ok(tin.some((x) => x.role === "user" && /bình luận/.test(x.text) && /Cho 1,5 kg gửi đc cũ/.test(x.text)), "lời mua của bình luận tới hộp thư cũ qua đường thật");
  assert.ok(!tin.some((x) => x.text === "Dạ em nhắn riêng ạ"), "ALREADY ⇒ không chép câu bot chưa gửi");
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, hopThu));
  assert.ok(((row.state ?? {}) as ChatState).roundStartAt, "hộp thư im 5 tháng ⇒ lượt mua mới");
  const [blRow] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, binhLuan));
  assert.deepEqual({ ...(((blRow.state ?? {}) as ChatState).commentCarry ?? {}), at: undefined }, { outcome: "EXISTING_INBOX", copied: 1, at: undefined, inboxSource: "PANCAKE_CONV_ID" }, "kết quả ghi lại: chép sang hộp thư ĐÃ CÓ, 1 tin · mã hộp thư Pancake trả đúng dạng page_<số>");

  // Ca THẬT 42f28794 (17/10): Meta / Pancake nhắn riêng TRƯỚC, hộp thư CHƯA có hội thoại ⇒ mở hội thoại hộp thư, lời mua đi vào đó.
  const INBOX2 = `${PAGE}_${now.getTime()}2`;
  const binhLuan2 = (await openConversation("FANPAGE", { visitorKey: `p0rb-cmt2-${now.getTime()}` })).id;
  await db.insert(schema.salesChatMessages).values([
    { conversationId: binhLuan2, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1,5 kg gửi đc cũ" }] },
    { conversationId: binhLuan2, seq: 3, role: "assistant", content: [{ type: "text", text: "Dạ em nhắn riêng chị ạ" }] },
  ]);
  const fetchGia2 = (async (url: string | URL) => {
    if (/[/]messages[?]/.test(String(url))) return new Response(JSON.stringify({ messages: [{ id: "cmt-p0rb-2", private_reply_conversation: INBOX2 }] }), { status: 200 });
    return new Response(JSON.stringify({ success: false }), { status: 500 });
  }) as typeof fetch;
  setPageRuntimeReaderForTests(async () => ({ [PAGE]: { mode: "LIVE" } }));
  const r2 = await fanpageBotSendersForTests.deliverCommentReply({ pageId: PAGE, threadId: "cmt-thread-2", commentId: "cmt-p0rb-2", postId: "post-1", fromId: "cust-2", text: "Dạ em nhắn riêng chị ạ", imageIds: [], conversationId: binhLuan2 }, { fetch: fetchGia2, now: () => now }).finally(() => setPageRuntimeReaderForTests(null));
  assert.equal(r2.kind, "ALREADY", JSON.stringify(r2));
  const [moi2] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.visitorKey, fanpageVisitorKey(PAGE, INBOX2)));
  assert.ok(moi2, "hộp thư chưa có hội thoại ⇒ mở hội thoại hộp thư");
  assert.notEqual(moi2.id, binhLuan2, "không chuyển hội thoại bình luận (mang câu bot chưa gửi) sang");
  assert.equal(moi2.pageId, PAGE, "mở bằng đúng đường fanpage (page + luồng cho follow-up)");
  const tin2 = await tinCua(moi2.id);
  assert.ok(tin2.some((x) => x.role === "user" && /Cho 1,5 kg gửi đc cũ/.test(x.text)), "lời mua của bình luận có trong hội thoại hộp thư khi khách nhắn tới");
  assert.ok(!tin2.some((x) => x.text === "Dạ em nhắn riêng chị ạ"), "không chép câu bot chưa gửi");
  const [bl2Row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, binhLuan2));
  assert.equal(((bl2Row.state ?? {}) as ChatState).commentCarry?.outcome, "OPENED_NEW", "kết quả ghi lại: mở hộp thư rồi chép");

  // Bot TỰ nhắn riêng (SENT), hộp thư chưa có hội thoại ⇒ hội thoại bình luận được CHUYỂN thành hội thoại hộp thư ⇒ kết quả MOVED.
  const INBOX3 = `${PAGE}_${now.getTime()}3`;
  const binhLuan3 = (await openConversation("FANPAGE", { visitorKey: `p0rb-cmt3-${now.getTime()}` })).id;
  await db.insert(schema.salesChatMessages).values({ conversationId: binhLuan3, seq: 2, role: "user", content: [{ type: "text", text: "Cho 2kg" }] });
  let docLan = 0;
  const fetchGia3 = (async (url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") return new Response(JSON.stringify({ success: true, id: "m-p0rb-3" }), { status: 200 });
    docLan += 1;
    return new Response(JSON.stringify({ messages: [{ id: "cmt-p0rb-3", ...(docLan > 1 ? { private_reply_conversation: INBOX3 } : {}) }] }), { status: 200 });
  }) as typeof fetch;
  setPageRuntimeReaderForTests(async () => ({ [PAGE]: { mode: "LIVE" } }));
  const r3 = await fanpageBotSendersForTests.deliverCommentReply({ pageId: PAGE, threadId: "cmt-thread-3", commentId: "cmt-p0rb-3", postId: "post-1", fromId: "cust-3", text: "Dạ em nhắn riêng ạ", imageIds: [], conversationId: binhLuan3 }, { fetch: fetchGia3, now: () => now }).finally(() => setPageRuntimeReaderForTests(null));
  assert.equal(r3.kind, "SENT", JSON.stringify(r3));
  const [bl3Row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, binhLuan3));
  assert.equal(bl3Row.visitorKey, fanpageVisitorKey(PAGE, INBOX3), "hội thoại bình luận thành hội thoại hộp thư");
  assert.equal(((bl3Row.state ?? {}) as ChatState).commentCarry?.outcome, "MOVED", "kết quả ghi lại: chuyển cả hội thoại");
  console.log("  ✓ đường thật: deliverCommentReply (ALREADY) → carryIntoInbox → hộp thư cũ theo visitorKey · hộp thư CHƯA có hội thoại ⇒ mở rồi chép (ca thật 42f28794) · bot tự nhắn riêng ⇒ MOVED · mỗi lần đều ghi mã kết quả");
}

const CASES: GoldenCase[] = [
  {
    key: "p0rb-quay-lai-sau-5-thang",
    title: "Khách cũ nhắn lại sau 5 tháng, lượt trước không chốt qua bot ⇒ lượt mua MỚI: giỏ 1 kg cũ không sang, lời mua cũ không còn là lượt hiện tại",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: async (ctx) => {
          const db = await getDb();
          const cu = new Date(Date.now() - 143 * NGAY);
          await db.insert(schema.salesChatMessages).values([
            { conversationId: ctx.conversationId, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1kg" }], createdAt: cu },
            { conversationId: ctx.conversationId, seq: 3, role: "assistant", content: [{ type: "text", text: "Dạ em ghi 1kg ạ" }], createdAt: cu },
          ]);
          await db.update(schema.salesChatConversations).set({ state: { cart: cart(1000) } as Record<string, unknown> }).where(eq(schema.salesChatConversations.id, ctx.conversationId));
        },
        say: "Cho 1,5 kg gửi đc cũ",
        ai: [() => [say("Dạ em ghi 1,5kg cho chị ạ.")]],
      },
    ],
  },
  {
    key: "p0rb-hoi-gia-roi-chot-hom-sau",
    title: "Khách hỏi hôm qua, chốt hôm nay (dưới NEW_ROUND_GAP_MS) ⇒ VẪN một lượt mua, giỏ giữ nguyên",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: async (ctx) => {
          const db = await getDb();
          await db.insert(schema.salesChatMessages).values({ conversationId: ctx.conversationId, seq: 2, role: "user", content: [{ type: "text", text: "Cho 1kg" }], createdAt: new Date(Date.now() - NGAY) });
          await db.update(schema.salesChatConversations).set({ state: { cart: cart(1000) } as Record<string, unknown> }).where(eq(schema.salesChatConversations.id, ctx.conversationId));
        },
        say: "ok chị lấy nhé",
        ai: [() => [say("Dạ vâng ạ.")]],
      },
    ],
  },
];

async function testGolden() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-p0rb",
    afterCase: async (k, ctx) => {
      seen.add(k.key);
      const db = await getDb();
      const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const st = (row.state ?? {}) as ChatState;
      const luot = customerTextsSince(await tinCua(ctx.conversationId), purchaseRoundStart(st));
      if (k.key === "p0rb-quay-lai-sau-5-thang") {
        assert.ok(st.roundStartAt, "lượt mua mới có mốc");
        assert.ok(!luot.includes("Cho 1kg"), `lời mua tháng 5 không còn là lượt hiện tại: ${JSON.stringify(luot)}`);
        assert.ok(luot.includes("Cho 1,5 kg gửi đc cũ"), "lời mua hôm nay là lượt hiện tại");
        assert.ok(!(st.cart?.selectedItems ?? []).some((x) => x.quantity === 1000), `giỏ 1 kg cũ không sang lượt mới: ${JSON.stringify(st.cart)}`);
      } else {
        assert.equal(st.roundStartAt, undefined, "dưới ngưỡng ⇒ không mở lượt mua mới");
        assert.ok(luot.includes("Cho 1kg"), "lời mua hôm qua vẫn thuộc lượt này");
        assert.equal(st.cart?.selectedItems?.[0]?.quantity, 1000, "giỏ giữ nguyên");
      }
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
  console.log(`  ✓ khách cũ quay lại: ${CASES.length} hội thoại qua chatTurn thật — sau 5 tháng mở lượt mua mới, giỏ 1 kg cũ không sang · hỏi hôm qua chốt hôm nay vẫn một lượt`);
}

export async function testP0RepeatBuyer() {
  testThuan();
  testKhoaDon();
  await testChepBinhLuan();
  await testDuongThat();
  await testGolden();
}

if (process.argv[1] && /p0-repeat-buyer.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0RepeatBuyer)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

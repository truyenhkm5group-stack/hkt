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
import { carryCommentTurn, freshPurchaseRound, lastCustomerTextAt, NEW_ROUND_GAP_MS, openConversation, purchaseRoundStart } from "@/lib/sales-chatbot/engine";
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

  assert.equal(await carryCommentTurn(binhLuan, hopThu, now), true);
  const [row] = await db.select().from(c).where(eq(c.id, hopThu));
  const st = (row.state ?? {}) as ChatState;
  const tin = await tinCua(hopThu);
  const luot = customerTextsSince(tin, purchaseRoundStart(st));
  assert.ok(luot.some((x) => /Cho 1,5 kg gửi đc cũ/.test(x) && /bình luận/.test(x)), `lời mua của bình luận vào lượt mua hiện tại của hộp thư: ${JSON.stringify(luot)}`);
  assert.ok(!luot.includes("Cho 1kg"), "lời mua tháng 5 KHÔNG còn là lượt mua hiện tại");
  assert.equal(st.cart?.selectedItems?.[0]?.quantity, 1500, "giỏ của bình luận (1,5 kg) đi theo, không phải giỏ cũ 1 kg");
  assert.ok(tin.some((x) => x.role === "assistant" && x.text === "Dạ em nhắn riêng chị ạ"), "tin bot của lượt bình luận cũng sang (bot không nhắn lại điều đã nói)");
  const soTin = tin.length;
  assert.equal(await carryCommentTurn(binhLuan, hopThu, new Date(now.getTime() + 60_000)), false, "chạy lại (webhook lặp) không chép hai lần");
  assert.equal((await tinCua(hopThu)).length, soTin);
  assert.equal(await carryCommentTurn(hopThu, hopThu, now), false, "cùng một hội thoại ⇒ không làm gì");

  // Hộp thư đang có đơn bot CHỐT trong POST_ORDER_HANDOFF_MS ⇒ chỉ chép tin, KHÔNG xoá lượt mua đang chạy (không đụng đơn đang giao).
  const dangChot = await moi("inbox-chot");
  const chot = { orderId: "o-dang-giao", simulated: false, total: 280_000, at: new Date(now.getTime() - NGAY).toISOString() };
  await db.update(c).set({ state: { confirmed: chot, cart: cart(1000) } as Record<string, unknown> }).where(eq(c.id, dangChot));
  const bl2 = await moi("comment-2");
  await db.insert(m).values({ conversationId: bl2, seq: 2, role: "user", content: [{ type: "text", text: "Cho thêm 1kg nhé" }] });
  assert.equal(await carryCommentTurn(bl2, dangChot, now), true);
  const [r2] = await db.select().from(c).where(eq(c.id, dangChot));
  const s2 = (r2.state ?? {}) as ChatState;
  assert.equal(s2.confirmed?.orderId, "o-dang-giao", "đơn đang chạy giữ nguyên");
  assert.equal(s2.roundStartAt, undefined, "không mở lượt mua mới khi đơn vừa chốt còn trong hạn");
  assert.ok((await tinCua(dangChot)).some((x) => /Cho thêm 1kg nhé/.test(x.text)), "lời của bình luận vẫn tới hộp thư");
  console.log("  ✓ bình luận mua lại của khách cũ: chép sang hộp thư cũ, lượt mua mới từ lúc bình luận, giỏ 1,5 kg đi theo · chạy lại không chép hai lần · đơn đang chốt không bị xoá");
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
  await testChepBinhLuan();
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

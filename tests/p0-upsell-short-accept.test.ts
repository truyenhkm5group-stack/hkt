/**
 * P0 21/10/2026 (chủ shop, ca HSLC «Vit Xiem» — hội thoại a470ae92…): khách «Lấy 1/2 ram tôm bề bề» ⇒ bot đề xuất ĐÚNG MỘT món + giá
 * («… hộp 10 cái giá 120.000 ₫, mình lấy 1 hộp luôn nha?») ⇒ khách 👍 + «Ok» ⇒ bot bắt khách «nhắn giúp em "lấy 1 hộp …"». Luật mới: lời mời
 * có đúng một mẫu mã + giá, khách trả lời TRỰC TIẾP bằng «Ok» / «vâng» / 👍 ⇒ ĐỒNG Ý ⇒ máy chủ thêm, không hỏi lại tên món. Đơn khoá / giá
 * đổi ⇒ chuyển người, không đơn thứ hai, không nói đã thêm. Thuần + chatTurn thật (`gd-food-sa`). Dữ liệu dựng, không PII.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import type { CatalogItem } from "@/lib/sales-chatbot/catalog";
import { CLAIM_SAFE_TEXT } from "@/lib/sales-chatbot/claim-guard";
import { confirmedAddIssue, isShortYes, postConfirmOfferText } from "@/lib/sales-chatbot/next-best-action";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { acceptsOffer, isShortAccept, proposalOf, type DirectOffer } from "@/lib/sales-chatbot/short-accept";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { MESSENGER_LIKE_STICKER_IDS, pancakeLikeSticker } from "@/lib/sales-chatbot/vision";
import { formatVND } from "@/lib/format";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const PROPOSAL = "Dạ nem hải sản tôm bề bề nhà em đóng hộp 10 cái giá 120.000 ₫, mình lấy 1 hộp luôn nha anh/chị?";

function testThuan() {
  for (const yes of ["Ok", "ok em", "Ok 👍", "👍", "👌", "vâng", "dạ vâng", "được", "lấy luôn", "thêm nhé", "ok thêm giúp chị", "Dạ"]) assert.ok(isShortAccept(yes), yes);
  for (const no of ["ok nhưng để chị hỏi chồng", "ok?", "thêm à", "không em", "thôi em", "😢", "ok thêm 2 hộp", "ship mấy ngày em", ""]) assert.ok(!isShortAccept(no), no);
  // Biểu tượng buồn / khóc / giận / chê / nghi ngờ đi kèm chữ «có» ⇒ KHÔNG phải đồng ý (bộ đọc từng bỏ mọi biểu tượng trước khi so chữ).
  for (const no of ["ok 😢", "Ok 😭", "vâng 😔", "được 😞", "ok 😡", "lấy luôn 👎", "ok 🤔", "ok :(", "dạ :'(", "ok T_T", "Ok T.T", "👍😢", "ok 🥺"]) {
    assert.ok(!isShortAccept(no), `«${no}» không phải đồng ý`);
    assert.ok(!isShortYes(no), `«${no}»: đường hỏi-sau-chốt (isShortYes) cùng một luật`);
  }
  for (const yes of ["ok 😍", "Ok 😊", "vâng 🥰", "ok 👍👍", "được ❤️"]) assert.ok(isShortAccept(yes), `«${yes}» vẫn là đồng ý — chỉ biểu tượng tiêu cực mới chặn`);

  const cat = (productId: string, variantId: string, name: string, price: number | null): CatalogItem => ({ productId, variantId, name, sku: variantId, variant: "", price, fields: {} });
  const catalog = [cat("p-nem", "v-nem10", "Nem hải sản tôm bề bề", 120_000), cat("p-nem", "v-nem20", "Nem hải sản tôm bề bề", 230_000), cat("p-cha", "v-cha1", "Chả cá thu", 280_000)];
  assert.deepEqual(proposalOf(PROPOSAL, catalog, new Set()), { productId: "p-nem", variantId: "v-nem10", name: "Nem hải sản tôm bề bề", price: 120_000, source: "BOT_PROPOSAL" }, "ca thật: một món + giá đúng một mẫu mã");
  assert.equal(proposalOf(PROPOSAL, catalog, new Set(["p-nem"])), null, "món đã có trong đơn — câu đọc lại đơn không phải lời mời");
  assert.equal(proposalOf("Dạ nem hải sản tôm bề bề 120.000 ₫ và chả cá thu 280.000 ₫, mình lấy món nào ạ?", catalog, new Set()), null, "hai món ⇒ không món đích");
  assert.equal(proposalOf("Dạ nem hải sản tôm bề bề giá 150.000 ₫, mình lấy luôn nha?", catalog, new Set()), null, "giá không khớp mẫu mã nào ⇒ không đoán");
  assert.equal(proposalOf("Dạ nem hải sản tôm bề bề hộp 10 cái giá 120.000 ₫ ạ.", catalog, new Set()), null, "câu kể giá, không mời");

  const offer: DirectOffer = { productId: "p-nem", variantId: "v-nem10", name: "Nem hải sản tôm bề bề", price: 120_000, turn: 30, at: new Date().toISOString(), source: "BOT_PROPOSAL" };
  const base = { offer, prevTurn: 30, text: "Ok", humanBetween: false, declined: false };
  assert.equal(acceptsOffer(base), offer, "trả lời trực tiếp ⇒ đồng ý");
  assert.equal(acceptsOffer({ ...base, prevTurn: 28 }), null, "có tin khách khác xen giữa ⇒ không phải trả lời trực tiếp");
  assert.equal(acceptsOffer({ ...base, humanBetween: true }), null, "nhân viên nhắn xen giữa ⇒ «Ok» có thể trả lời người");
  assert.equal(acceptsOffer({ ...base, offer: { ...offer, ambiguous: true } }), null, "lượt mời còn câu hỏi khác ⇒ mơ hồ");
  assert.equal(acceptsOffer({ ...base, declined: true }), null);
  assert.equal(acceptsOffer({ ...base, text: "ok nhưng để mai" }), null);

  const added = [{ productId: "p-nem", variantId: "v-nem10", name: "Nem hải sản tôm bề bề", quantity: 1, weightGrams: null }];
  assert.deepEqual(confirmedAddIssue(added, undefined, "Ok", {}), { kind: "UNNAMED", names: ["Nem hải sản tôm bề bề"], ask: null }, "không có đồng ý đã quyết ⇒ luật cũ");
  assert.equal(confirmedAddIssue(added, undefined, "Ok", { accepted: { productId: "p-nem", variantId: "v-nem10" } }), null, "đồng ý đã quyết ⇒ căn cứ của khách");
  assert.equal(confirmedAddIssue([{ ...added[0], variantId: "v-nem20" }], undefined, "Ok", { accepted: { productId: "p-nem", variantId: "v-nem10" } })?.kind, "WRONG_VARIANT", "khác mẫu mã đã mời ⇒ không");

  const like = [...MESSENGER_LIKE_STICKER_IDS][0];
  assert.ok(pancakeLikeSticker({ attachments: [{ type: "sticker", sticker_id: like }] }));
  assert.ok(pancakeLikeSticker({ attachments: [{ type: "sticker", payload: { sticker_id: Number(like) } }] }), "sticker_id dạng số");
  assert.ok(!pancakeLikeSticker({ attachments: [{ type: "sticker", sticker_id: "123456" }] }), "nhãn dán khác KHÔNG phải đồng ý");
  assert.doesNotMatch(postConfirmOfferText({ name: "Chả mực giã tay", productId: "p", variantId: "v", variant: "Size: 0,5kg", price: 200_000 }, formatVND), /nhắn em|nhắn giúp/, "câu mời không bắt nhắn lại cú pháp");
  console.log("  ✓ thuần: đồng ý ngắn (ok · vâng · 👍) · lời mời một món đọc từ câu bot (một món + giá đúng một mẫu mã) · trả lời trực tiếp · người xen giữa · mơ hồ · nhãn like Messenger");
}

function testNguon() {
  // Bỏ mọi câu bắt khách nhắn lại cú pháp — mã nguồn và câu hệ thống.
  for (const f of ["lib/sales-chatbot/next-best-action.ts", "lib/sales-chatbot/tools.ts", "lib/sales-chatbot/engine.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /nhắn em «thêm \$\{/, `${f}: không câu mẫu «nhắn em "thêm …"»`);
  }
  const eng = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  // Mọi lời gọi công cụ của lượt (vòng model · tra đơn · bước máy chủ) mang cùng quyết định đồng ý.
  assert.ok((eng.match(/customer360: c360, (?:knownPhone, )?acceptedOffer: accepted,/g) ?? []).length >= 3, "công cụ của đường model nhận cùng quyết định đồng ý");
  assert.match(eng, /if \(accepted && state\.draft\?\.orderId && !state\.handoff/, "máy chủ tự thêm khi có đơn của lượt");
  console.log("  ✓ mã nguồn: không câu bắt nhắn lại cú pháp · một quyết định đồng ý cho bước máy chủ lẫn công cụ");
}

const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const INFO = (phone: string) => `Cho chị 1 hộp ruốc bông tôm, Lan ${phone}, ${ADDR}`;
const OFFER = "Dạ chả mực giã tay 1kg giá 400.000 ₫, mình lấy 1 hộp luôn nha?";
const orderInfo = (phone: string) => [
  () => [tool("create_customer", { name: "Lan", phone, address: ADDR })],
  ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
  () => [say("Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.")],
];
const ask = { say: "Lấy thêm chả mực giã tay", ai: [() => [say(OFFER)]] };
const NO_AUTO = new Set(["sa-don-khoa", "sa-ok-don-chinh"]);

const CASES: GoldenCase[] = [
  { key: "sa-vit-xiem", title: "Dáng ca thật: bot đề xuất ĐÚNG MỘT món + giá, khách «Ok» ⇒ máy chủ thêm (không gọi model), báo tổng ERP", shop: "food", channel: "WEB", turns: [{ say: INFO("0961006101"), ai: orderInfo("0961006101") }, ask, { say: "Ok", ai: [] }] },
  { key: "sa-like", title: "👍 trả lời trực tiếp ⇒ đồng ý", shop: "food", channel: "WEB", turns: [{ say: INFO("0961006102"), ai: orderInfo("0961006102") }, ask, { say: "👍", ai: [] }] },
  { key: "sa-tu-choi", title: "Từ chối ⇒ không thêm", shop: "food", channel: "WEB", turns: [{ say: INFO("0961006103"), ai: orderInfo("0961006103") }, ask, { say: "thôi em, không lấy đâu", ai: [() => [say("Dạ vâng ạ.")]] }] },
  { key: "sa-cau-hoi-khac", title: "«Ok» trả lời câu hỏi KHÁC (không phải lời mời) ⇒ không thêm", shop: "food", channel: "WEB", turns: [{ say: INFO("0961006104"), ai: orderInfo("0961006104") }, { say: "giao giờ hành chính nhé", ai: [() => [say("Dạ mình nhận hàng giờ hành chính đúng không ạ?")]] }, { say: "Ok", ai: [() => [say("Dạ vâng ạ.")]] }] },
  { key: "sa-nhieu-mon", title: "Câu mời nhiều món chưa rõ ⇒ «Ok» không tự chọn món", shop: "food", channel: "WEB", turns: [{ say: INFO("0961006105"), ai: orderInfo("0961006105") }, { say: "còn món gì ngon em", ai: [() => [say("Dạ bên em còn chả mực giã tay 400.000 ₫ và mực khô câu 1.200.000 ₫, mình lấy món nào ạ?")]] }, { say: "Ok", ai: [() => [say("Dạ mình muốn lấy món nào ạ?")]] }] },
  {
    key: "sa-nv-xen",
    title: "Nhân viên nhắn xen giữa lời mời và «Ok» ⇒ không tự thêm",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: INFO("0961006106"), ai: orderInfo("0961006106") },
      ask,
      {
        say: "Ok",
        before: async (ctx: GoldenHookCtx) => {
          const db = await getDb();
          await db.update(schema.salesChatConversations).set({ lastStaffAt: new Date() }).where(eq(schema.salesChatConversations.id, ctx.conversationId));
        },
        ai: [() => [say("Dạ vâng ạ.")]],
      },
    ],
  },
  {
    key: "sa-gia-doi",
    title: "Giá đổi sau lời mời ⇒ ghi nhận + chuyển người, không thêm, không nói đã thêm",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: INFO("0961006107"), ai: orderInfo("0961006107") },
      ask,
      {
        say: "Ok",
        before: async (ctx: GoldenHookCtx) => {
          const db = await getDb();
          await db.update(schema.productVariants).set({ retailPrice: 450_000 }).where(eq(schema.productVariants.id, ctx.ids.get("CHA-MUC")!));
        },
        ai: [],
      },
    ],
  },
  { key: "sa-don-khoa", title: "Đơn chốt bằng lời đồng ý của khách (sửa là việc nhân viên) ⇒ «Ok» ⇒ chuyển người, không thêm", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961006108"), ai: [() => [tool("create_customer", { name: "Lan", phone: "0961006108", address: ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })], () => [say("Dạ đơn 1 hộp ruốc bông tôm 350.000 ₫ ạ.")]] },
    { say: "ok chốt em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok chốt em" })], () => [say("Dạ em chốt đơn cho mình rồi ạ.")]] },
    ask,
    { say: "Ok", ai: [] },
  ] },
  { key: "sa-ok-don-chinh", title: "«Ok» xác nhận đơn chính (câu đọc lại đơn, không phải lời mời) ⇒ chốt đơn chính, không thêm món", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961006109"), ai: [() => [tool("create_customer", { name: "Lan", phone: "0961006109", address: ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })], () => [say("Dạ đơn 1 hộp ruốc bông tôm 350.000 ₫, mình xác nhận giúp em nhé?")]] },
    { say: "Ok", ai: [() => [tool("confirm_order", { customer_confirmation: "Ok" })], () => [say("Dạ em chốt đơn cho mình rồi ạ.")]] },
  ] },
];

async function orderLines(conversationId: string, ids: ReadonlyMap<string, string>) {
  const db = await getDb();
  const [o] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId));
  if (!o) return { count: 0, lines: [] as string[] };
  const all = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId));
  const sku = new Map([...ids.entries()].map(([k, id]) => [id, k]));
  const lines = (await db.select({ v: schema.orderItems.variantId, q: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id))).map((l) => `${sku.get(String(l.v)) ?? l.v}×${l.q}`).sort();
  return { count: all.length, lines };
}

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-sa",
    beforeCase: async (c, ctx) => {
      const db = await getDb();
      const [has] = await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.reference, "SA-NAP")).limit(1);
      if (!has) {
        const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "SA-NAP", totalQuantity: 120, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
        await db.insert(schema.stockReceiptItems).values([{ receiptId: rc.id, variantId: ctx.ids.get("RUOC-TOM")!, quantity: 100, unitCost: 100_000 }, { receiptId: rc.id, variantId: ctx.ids.get("CHA-MUC")!, quantity: 20, unitCost: 200_000 }]);
      }
      await db.update(schema.productVariants).set({ retailPrice: 400_000 }).where(eq(schema.productVariants.id, ctx.ids.get("CHA-MUC")!));
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: false, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false });
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: !NO_AUTO.has(c.key) });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const { count, lines } = await orderLines(ctx.conversationId, ctx.ids);
      const all = t.turns.flatMap((x) => x.shown);
      const last = t.turns[t.turns.length - 1];
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      const st = (await getDb().then((db) => db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId))))[0]?.state as ChatState;
      assert.ok(!all.some((s) => /nhắn (?:giúp )?em\s*[«"]/.test(s)), `[${c.key}] bắt khách nhắn lại cú pháp: ${all.join(" | ")}`);
      assert.ok(count <= 1, `[${c.key}] không đơn thứ hai: ${count}`);
      if (c.key === "sa-vit-xiem" || c.key === "sa-like") {
        assert.deepEqual(lines, ["CHA-MUC×1", "RUOC-TOM×1"], `[${c.key}] đồng ý ⇒ thêm đúng món đã mời: ${results.slice(0, 600)}`);
        assert.equal(last.rounds.length, 0, `[${c.key}] máy chủ thêm, không gọi model`);
        assert.match(last.shown.join(" "), /Tổng đơn mới 750\.000 ₫/, `[${c.key}] báo tổng ERP sau khi ghi: ${last.shown.join(" | ")}`);
        assert.equal(st.directOffer, undefined, "lời mời đã dùng xong");
      }
      if (["sa-tu-choi", "sa-cau-hoi-khac", "sa-nhieu-mon", "sa-nv-xen", "sa-ok-don-chinh"].includes(c.key)) assert.deepEqual(lines, ["RUOC-TOM×1"], `[${c.key}] KHÔNG thêm món: ${lines.join(", ")} · ${results.slice(0, 400)}`);
      if (c.key === "sa-gia-doi" || c.key === "sa-don-khoa") {
        assert.deepEqual(lines, ["RUOC-TOM×1"], `[${c.key}] không thêm khi giá đổi / đơn khoá: ${lines.join(", ")}`);
        assert.equal(t.final.status, "HANDOFF", `[${c.key}] chuyển người: ${JSON.stringify(t.final).slice(0, 300)}`);
        assert.match(String(t.final.handoffReason ?? ""), /khách đồng ý thêm Chả mực giã tay/, `[${c.key}] lý do ghi nhận yêu cầu mua thêm`);
        assert.deepEqual(last.shown, [CLAIM_SAFE_TEXT.ORDER_EDIT], `[${c.key}] không nói đã thêm: ${last.shown.join(" | ")}`);
      }
      if (c.key === "sa-ok-don-chinh") assert.match(results, /Đã chốt đơn/, "«Ok» chốt đơn chính");
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
}

export async function testP0UpsellShortAccept(): Promise<void> {
  testThuan();
  testNguon();
  await testChatTurn();
  console.log("✓ P0 «Ok» với lời mời một món (ca «Vit Xiem»): ok / 👍 trả lời trực tiếp ⇒ máy chủ thêm + tổng ERP · từ chối · câu hỏi khác · nhiều món · nhân viên xen giữa · giá đổi / đơn khoá ⇒ người · «Ok» chốt đơn chính không thêm · không bắt nhắn lại cú pháp");
}

if (process.argv[1] && /p0-upsell-short-accept\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0UpsellShortAccept)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

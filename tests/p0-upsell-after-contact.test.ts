/**
 * P0 21/10/2026 (chủ shop, ca HSLC «Mai Le»): khách gửi đủ món + số lượng + SĐT + địa chỉ, máy chưa ghép được phường / xã ⇒ bot nhắn
 * «Dạ em đã ghi nhận đơn của mình, nhân viên sẽ xác nhận lại địa chỉ giúp mình ngay ạ.» rồi IM — không mời mua thêm (cửa sổ lời mời sau
 * chốt đóng vì «đơn chưa qua kiểm»). Một giờ sau nhân viên page tự gửi ảnh menu, khách thêm chả mực. Chủ shop BỎ câu đó: tổ chức bật
 * `upsellAfterContact` ⇒ câu ghi nhận ngắn rồi sang bước mời mua thêm (câu upsell của shop, nguyên văn + ảnh); đơn VẪN mang cờ
 * ADDRESS_UNRESOLVED (hàng «Cần người kiểm», tuyến ADDRESS_REVIEW, không vận đơn). Tối đa một lời mời mỗi lượt mua đếm theo SỰ KIỆN GỬI:
 * page đã gửi ảnh menu trong lượt ⇒ ERP không gửi, kể cả câu tự soạn.
 *
 * Bảy ý nghiệm thu của chủ shop: (1) đủ SĐT + địa chỉ ⇒ không còn câu cũ · (2) có câu upsell ⇒ đúng chữ + ảnh · (3) không có câu ⇒ không
 * bịa · (4) đồng ý ⇒ đúng món / tổng ERP · (5) từ chối / im ⇒ đơn chính vẫn đi · (6) địa chỉ chưa xác minh ⇒ không vận đơn · (7) page đã
 * gửi menu ⇒ ERP không gửi trùng. Thuần + chatTurn thật (`gd-food-uac`). Dữ liệu khách là dữ liệu dựng, không PII.
 *
 * 22/10/2026 (chủ shop, P0 HSLC #8037F35A — «xác minh địa chỉ độc lập với upsell»): câu ghi nhận thay «nhân viên sẽ xác nhận lại địa chỉ»
 * nay áp cho MỌI tổ chức, cờ TẮT cũng vậy; cờ `upsellAfterContact` chỉ còn quyết LỜI MỜI mua thêm khi địa chỉ đang chờ (ca `uac-co-tat`).
 *
 * 22/10/2026 (chủ shop — AGENTS 3.12b «địa chỉ không bao giờ hỏi lại; ánh xạ không ảnh hưởng chốt / upsell»): đơn chỉ còn chờ xác minh
 * địa chỉ là đơn ĐÃ CHỐT với khách — chữ chốt THƯỜNG của bot đi qua, lời mời sau chốt mở cho MỌI tổ chức (cờ `upsellAfterContact` không còn
 * tác dụng — ca `uac-co-tat` nay cũng mời), và chữ địa chỉ chưa đọc được tỉnh KHÔNG chặn tự chốt (ca `uac-thieu-tinh`). Cờ ADDRESS_UNRESOLVED
 * vẫn giữ vận đơn.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { CLAIM_SAFE_TEXT, claimVerdict, detectClaims, pendingAddressText } from "@/lib/sales-chatbot/claim-guard";
import { choosePostConfirmSource, OFFER_ALREADY_SENT_SKIPS } from "@/lib/sales-chatbot/next-best-action";
import { parseQuickReplySettings, QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { PAGE_MEDIA_ROUND_FALLBACK_MS, type ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { addressReviewOpenOf } from "@/lib/shipping/route";
import { UPSELL_DUP_WINDOW_HOURS, upsellScanVerdict } from "@/scripts/conv-money-trace";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

/** Biết tỉnh, KHÔNG ghép được phường / xã (cùng dáng địa chỉ của `qi-dia-chi-can-kiem`). */
const ADDR_WARD_UNKNOWN = "Số 5 ngõ 12 xóm Chùa, Hà Nội";
/** Không đọc được tỉnh — thật sự thiếu để giao. */
const ADDR_NO_PROVINCE = "Số 5 ngõ 12 xóm Chùa";
const MENU = "Dạ bên em còn chả mực giã tay {{giá:CHA-MUC}} ăn kèm rất hợp ạ.";
const TPL = "Dạ bên em còn chả mực giã tay 400.000 ₫ ăn kèm rất hợp ạ.";
const AUTO = /Bên em có thêm/;
/** Chữ CHỐT THƯỜNG của model ở các ca — đi qua nguyên văn (đơn chỉ chờ địa chỉ là đơn đã chốt với khách, 22/10/2026). */
const MODEL_OK = "Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.";
const BANNED = CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS;
const INFO = (phone: string, addr = ADDR_WARD_UNKNOWN) => `Cho chị 1 hộp ruốc bông tôm, Lan ${phone}, ${addr}`;

function testThuan() {
  // Cờ: chỉ `true` tường minh mới bật.
  assert.equal(parseQuickReplySettings(null).upsellAfterContact, false, "mặc định TẮT");
  assert.equal(parseQuickReplySettings({ upsellAfterContact: "true" }).upsellAfterContact, false, "chuỗi không bật");
  assert.equal(parseQuickReplySettings({ upsellAfterContact: true }).upsellAfterContact, true);

  // Câu: một chỗ chọn, câu mới không khẳng định «đã lên đơn» / không hứa nhân viên gọi lại.
  assert.equal(pendingAddressText(), CLAIM_SAFE_TEXT.ORDER_RECEIVED, "mọi tổ chức ⇒ câu ghi nhận (22/10/2026: xác minh độc lập với upsell)");
  assert.doesNotMatch(CLAIM_SAFE_TEXT.ORDER_RECEIVED, /nhân viên|xác nhận|địa chỉ/);
  assert.deepEqual(detectClaims(CLAIM_SAFE_TEXT.ORDER_RECEIVED), [], "câu ghi nhận không phải lời khẳng định đã chốt");
  const facts = { paymentVerified: false, orderConfirmed: false, orderCancelled: false, orderPending: "ADDRESS" as const };
  const v1 = claimVerdict(["ORDER_CONFIRMED"], facts);
  assert.ok(!v1.ok && v1.safeText === CLAIM_SAFE_TEXT.ORDER_RECEIVED && !v1.handoff, "hàng rào, đơn chỉ chờ địa chỉ ⇒ câu ghi nhận, không chuyển người");
  const v3 = claimVerdict(["ORDER_CONFIRMED"], { ...facts, orderPending: "CHECK" });
  assert.ok(!v3.ok && v3.safeText === CLAIM_SAFE_TEXT.ORDER_PENDING_CHECK, "CHỈ trường hợp địa chỉ đổi câu — đơn có vấn đề khác giữ câu kiểm");

  // Một lời mời mỗi lượt mua, đếm theo sự kiện gửi: page đã gửi ⇒ không câu tự soạn nào nữa.
  for (const r of OFFER_ALREADY_SENT_SKIPS) assert.deepEqual(choosePostConfirmSource({ template: { usable: false, reason: r }, autoEnabled: true }), { source: null, reason: r }, r);
  assert.deepEqual(choosePostConfirmSource({ template: { usable: false, reason: "TEMPLATE_UNAVAILABLE" }, autoEnabled: true }), { source: "AUTO_GENERATED", templateSkip: "TEMPLATE_UNAVAILABLE" }, "lý do khác vẫn đi đường tự soạn như cũ");

  // Quét Quality Supervisor (H · I) — hàm thuần của script.
  const conf = { valid: false, pending: "ADDRESS" };
  const row = { pco: { outcome: "ORDER_PROBLEM" }, confirmed: conf, cancel: null, declined: null, dispute: null, pageMedia: false };
  assert.deepEqual(upsellScanVerdict(row), { sent: false, skippedValid: true, duplicate: false }, "cửa sổ đóng chỉ vì địa chỉ ⇒ bỏ lỡ lời mời hợp lệ");
  assert.equal(upsellScanVerdict({ ...row, cancel: { at: "x" } }).skippedValid, false, "đang xin huỷ ⇒ không mời là đúng");
  assert.equal(upsellScanVerdict({ ...row, confirmed: { valid: false, pending: "CHECK" } }).skippedValid, false, "đơn có vấn đề khác ⇒ không mời là đúng");
  assert.equal(upsellScanVerdict({ ...row, dispute: { open: true } }).skippedValid, false);
  assert.equal(upsellScanVerdict({ ...row, pco: { outcome: "NOT_SENT", notSentReason: "GUARD_BLOCKED" } }).skippedValid, true);
  assert.equal(upsellScanVerdict({ ...row, pco: { outcome: "NOT_SENT", notSentReason: "HANDOFF" } }).skippedValid, false, "chuyển người ⇒ không mời là đúng");
  assert.deepEqual(upsellScanVerdict({ ...row, pco: { outcome: "OFFERED", sent: true }, pageMedia: true }), { sent: true, skippedValid: false, duplicate: true }, "ERP + page cùng mời");
  assert.equal(upsellScanVerdict({ ...row, pco: { outcome: "OFFERED", sent: true } }).duplicate, false);
  assert.equal(UPSELL_DUP_WINDOW_HOURS * 3_600_000, PAGE_MEDIA_ROUND_FALLBACK_MS, "cửa sổ của bộ quét = cửa sổ của engine");
  console.log("  ✓ thuần: cờ mặc định tắt · một chỗ chọn câu · hàng rào cờ bật ⇒ câu ghi nhận · page đã mời ⇒ không tự soạn · quét H/I");
}

function testNguon() {
  // Câu cũ chỉ còn ĐƯỢC CHỌN ở một chỗ (`pendingAddressText`) — không đường gửi nào gõ thẳng nó.
  for (const f of ["lib/sales-chatbot/tools.ts", "lib/sales-chatbot/engine.ts", "lib/sales-chatbot/followup.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /ORDER_PENDING_ADDRESS/, `${f} không gõ thẳng câu cũ`);
  const cg = readFileSync("lib/sales-chatbot/claim-guard.ts", "utf8");
  assert.equal(cg.match(/CLAIM_SAFE_TEXT\.ORDER_PENDING_ADDRESS/g)?.length ?? 0, 0, "không đường nào còn CHỌN câu cũ — hằng số chỉ còn để bộ đếm nhận ra nó");
  const tools = readFileSync("lib/sales-chatbot/tools.ts", "utf8");
  assert.match(tools, /notePostConfirmOffer\(state, ctx, [^\n]*, !pendingText, now\)/, "cửa sổ mời theo đơn hợp lệ — đơn chỉ chờ địa chỉ tính là hợp lệ (22/10/2026)");
  assert.doesNotMatch(tools, /\.upsellAfterContact|quietAddressReviewOn\(/, "cờ upsellAfterContact không còn đường nào đọc (A2, 22/10/2026)");
  assert.doesNotMatch(readFileSync("lib/sales-chatbot/engine.ts", "utf8"), /quietAddressReview/, "hàng rào không còn đọc cờ upsell — câu khi chờ địa chỉ không tuỳ cờ");
  console.log("  ✓ mã nguồn: không đường nào chọn câu cũ · công cụ chốt mở cửa sổ mời theo cờ · hàng rào không phụ thuộc cờ upsell");
}

type Mode = { template: boolean; flag: boolean; auto?: boolean };
const MODE_OF: Record<string, Mode> = {
  "uac-mai-le-replay": { template: true, flag: true },
  "uac-co-tat": { template: true, flag: false },
  "uac-khong-cau-mau": { template: false, flag: true },
  "uac-dong-y": { template: true, flag: true },
  "uac-tu-choi": { template: true, flag: true },
  "uac-page-da-gui-menu": { template: true, flag: true },
  "uac-page-gui-menu-tu-soan": { template: true, flag: true, auto: true },
  "uac-thieu-tinh": { template: true, flag: true },
};

async function seedMenu(ids: ReadonlyMap<string, string>, mode: Mode): Promise<string> {
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  const [row] = await db.select({ id: qr.id }).from(qr).where(eq(qr.title, "Menu món ngon")).limit(1);
  if (!row) {
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "UAC-NAP", totalQuantity: 120, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values([{ receiptId: rc.id, variantId: ids.get("RUOC-TOM")!, quantity: 100, unitCost: 100_000 }, { receiptId: rc.id, variantId: ids.get("CHA-MUC")!, quantity: 20, unitCost: 200_000 }]);
  }
  const id = row?.id ?? (await db.insert(qr).values({ title: "Menu món ngon", triggers: ["menu món ngon"], answer: MENU, active: true }).returning({ id: qr.id }))[0].id;
  if (!row) {
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    await db.insert(schema.salesChatQuickReplyImages).values({ quickReplyId: id, position: 0, contentType: "image/png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), data: png });
  }
  await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: mode.template ? id : null, autoLearn: false, autoActivate: false, autoUpsellOffer: mode.auto === true, upsellAfterContact: mode.flag });
  return id;
}

const orderInfo = (phone: string, addr = ADDR_WARD_UNKNOWN) => [
  () => [tool("create_customer", { name: "Lan", phone, address: addr })],
  ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
  () => [say("Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.")],
];

/** Page / nhân viên gửi ảnh menu TRONG lượt mua (dòng PAGE_REPLY có ảnh) — hội thoại thử được gắn page + luồng để engine tìm được dòng ấy. */
async function pageSentMenuImage(ctx: GoldenHookCtx): Promise<void> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const thread = `uac-${ctx.conversationId.slice(0, 8)}`;
  await db.update(c).set({ pageId: "pg-uac", threadId: thread }).where(eq(c.id, ctx.conversationId));
  await db.insert(schema.salesChatInbound).values({ pageId: "pg-uac", threadId: thread, messageId: `${thread}-menu`, text: "", imageUrls: ["https://example.invalid/menu.png"], status: "DONE", note: "PAGE_REPLY", senderKind: "VERIFIED_HUMAN", createdAt: new Date(Date.now() - 60_000) });
}

const mediaOf = new Map<string, { quickReplyId: string; imageIds: string[]; afterText?: string } | null>();
const keepMedia = (key: string) => ({ after: ({ media }: { media: { quickReplyId: string; imageIds: string[]; afterText?: string } | null }) => void mediaOf.set(key, media) });

const CASES: GoldenCase[] = [
  { key: "uac-mai-le-replay", title: "Dáng ca thật: đủ món + SĐT + địa chỉ chưa ghép xã ⇒ câu ghi nhận ngắn + câu upsell của shop (chữ + ảnh), KHÔNG «nhân viên sẽ xác nhận địa chỉ»; khách im ⇒ đơn chính vẫn đã chốt", shop: "food", channel: "WEB", turns: [
    { say: "Shop ơi còn ruốc bông tôm không", ai: [() => [say("Dạ bên em còn ruốc bông tôm ạ, mình lấy mấy hộp ạ?")]] },
    { say: INFO("0961004201"), ai: orderInfo("0961004201"), ...keepMedia("uac-mai-le-replay") },
  ] },
  { key: "uac-co-tat", title: "Tổ chức CHƯA bật cờ ⇒ câu ghi nhận (xác minh độc lập với upsell, 22/10/2026) nhưng KHÔNG mời mua thêm — cờ chỉ quyết lời mời", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961004202"), ai: orderInfo("0961004202") },
  ] },
  { key: "uac-khong-cau-mau", title: "Cờ bật, shop KHÔNG có câu upsell, tự soạn tắt ⇒ chỉ câu ghi nhận, KHÔNG bịa lời mời", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961004203"), ai: orderInfo("0961004203") },
  ] },
  { key: "uac-dong-y", title: "Khách gọi tên món được mời ⇒ đơn (vẫn chờ xác minh địa chỉ) được sửa đúng món + tổng ERP, câu sửa không «nhân viên xác nhận địa chỉ»", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961004204"), ai: orderInfo("0961004204") },
    { say: "thêm 1kg chả mực giã tay nữa nhé em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em thêm chả mực vào đơn rồi ạ.")]] },
  ] },
  { key: "uac-tu-choi", title: "Khách từ chối lời mời ⇒ giữ đơn chính, không mời lại", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961004205"), ai: orderInfo("0961004205") },
    { say: "thôi em, chị không lấy thêm đâu", ai: [() => [say("Dạ vâng ạ, em giao đơn ruốc cho mình nhé.")]] },
    { say: "ok em", ai: [() => [say("Dạ vâng ạ.")]] },
  ] },
  { key: "uac-page-da-gui-menu", title: "Page / nhân viên đã gửi ảnh menu trong lượt ⇒ ERP KHÔNG gửi câu upsell trùng", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961004206"), before: pageSentMenuImage, ai: orderInfo("0961004206") },
  ] },
  { key: "uac-page-gui-menu-tu-soan", title: "Page đã gửi ảnh menu, shop bật tự soạn ⇒ cũng KHÔNG tự soạn lời mời thứ hai", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961004207"), before: pageSentMenuImage, ai: orderInfo("0961004207") },
  ] },
  { key: "uac-thieu-tinh", title: "Chữ địa chỉ chưa đọc được tỉnh ⇒ VẪN tự chốt kèm cờ (A1, 22/10/2026), câu hỏi tỉnh của model bị chặn ở điểm gửi cuối", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961004208", ADDR_NO_PROVINCE), ai: [...orderInfo("0961004208", ADDR_NO_PROVINCE).slice(0, 2), () => [say("Dạ mình cho em xin thêm tỉnh / thành phố giao hàng ạ.")]] },
  ] },
];

async function stateOf(conversationId: string): Promise<ChatState> {
  const db = await getDb();
  const [c] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  return (c?.state ?? {}) as ChatState;
}

async function orderOf(conversationId: string, ids: ReadonlyMap<string, string>) {
  const db = await getDb();
  const [o] = await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId));
  if (!o) return { order: null, lines: [] as string[], shipments: 0 };
  const sku = new Map([...ids.entries()].map(([k, id]) => [id, k]));
  const lines = (await db.select({ v: schema.orderItems.variantId, q: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id))).map((l) => `${sku.get(String(l.v)) ?? l.v}×${l.q}`).sort();
  const shipments = (await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.orderId, o.id))).length;
  return { order: o, lines, shipments };
}

async function testChatTurn() {
  const seen = new Set<string>();
  let menuId = "";
  await runGoldenCases(CASES, {
    orgSuffix: "-uac",
    beforeCase: async (c, ctx) => {
      menuId = await seedMenu(ctx.ids, MODE_OF[c.key]);
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx: GoldenHookCtx, t) => {
      seen.add(c.key);
      const st = await stateOf(ctx.conversationId);
      const { order, lines, shipments } = await orderOf(ctx.conversationId, ctx.ids);
      const all = t.turns.flatMap((x) => x.shown);
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      const pco = st.postConfirmOffer;
      const info = t.turns[c.key === "uac-mai-le-replay" ? 1 : 0].shown;
      // (1) Câu cũ KHÔNG BAO GIỜ tới khách, ở bất kỳ lượt nào — cờ bật hay tắt (22/10/2026).
      assert.ok(!all.some((s) => s.includes(BANNED)), `[${c.key}] câu cũ tới khách: ${all.join(" | ")}`);
      assert.doesNotMatch(all.join("\n"), AUTO, `[${c.key}] bot tự soạn lời mời: ${all.join(" | ")}`);
      // (6) Địa chỉ chưa xác minh ⇒ đơn mang cờ ADDRESS_UNRESOLVED, không vận đơn.
      if (order) {
        assert.equal(order.stage, "CONFIRMED", `[${c.key}] đơn chính vẫn đi theo chính sách tự chốt`);
        assert.equal(order.shipCommune, "", `[${c.key}] xã / phường chưa ghép`);
        assert.equal(addressReviewOpenOf(order.raw), true, `[${c.key}] cờ ADDRESS_UNRESOLVED còn mở — hàng «Cần người kiểm» (việc xác minh nội bộ)`);
        assert.equal(shipments, 0, `[${c.key}] chưa xác minh địa chỉ ⇒ không vận đơn`);
        assert.equal(st.confirmed?.valid, false);
        assert.equal(st.confirmed?.pending, "ADDRESS");
        assert.ok(!st.handoff, `[${c.key}] không chuyển người`);
      }
      if (c.key === "uac-mai-le-replay") {
        assert.deepEqual(info, [MODEL_OK, TPL], `(1)+(2) câu chốt thường rồi ĐÚNG câu upsell của shop, tin riêng: ${info.join(" | ")} · ${JSON.stringify(t.turns.map((x) => x.shown))} · ${results.slice(0, 1500)} · ${JSON.stringify({ h: st.handoff, pco, c: st.confirmed })}`);
        assert.equal(pco?.outcome, "OFFERED");
        assert.equal(pco?.source, "SHOP_TEMPLATE");
        assert.equal(pco?.quickReplyId, menuId);
        const media = mediaOf.get(c.key);
        assert.equal(media?.quickReplyId, menuId, "ảnh menu của đúng câu upsell");
        assert.equal(media?.imageIds.length, 1);
        assert.equal(media?.afterText, TPL);
        assert.deepEqual(lines, ["RUOC-TOM×1"], "(5) khách im ⇒ đơn chính giữ nguyên, đã chốt");
      }
      if (c.key === "uac-co-tat") {
        assert.deepEqual(info, [MODEL_OK, TPL], `cờ tắt ⇒ VẪN câu chốt thường + lời mời (cờ không còn tác dụng, 22/10/2026): ${info.join(" | ")}`);
        assert.equal(pco?.outcome, "OFFERED");
      }
      if (c.key === "uac-khong-cau-mau") {
        assert.deepEqual(info, [MODEL_OK], `(3) không có câu upsell ⇒ chỉ câu chốt, không bịa lời mời: ${info.join(" | ")}`);
        assert.equal(pco?.outcome, "NO_TEMPLATE");
        assert.ok(!st.upsellSent);
      }
      if (c.key === "uac-dong-y") {
        assert.ok(t.turns[0].shown.includes(TPL), t.turns[0].shown.join(" | "));
        assert.deepEqual(lines, ["CHA-MUC×1", "RUOC-TOM×1"], `(4) đúng món: ${results.slice(0, 600)}`);
        assert.equal(pco?.accepted?.amount, 400_000, "(4) tiền thêm theo giá ERP");
        assert.match(results, /Tổng đơn mới 750\.000 ₫/, `(4) tổng ERP mới, không câu cũ: ${results.slice(0, 600)}`);
        assert.equal(order?.totalPriceAfterDiscount, 750_000, "(4) tổng đơn ERP");
      }
      if (c.key === "uac-tu-choi") {
        assert.equal(all.filter((s) => s === TPL).length, 1, `(5) đúng MỘT lời mời, không mời lại: ${all.join(" | ")}`);
        assert.deepEqual(lines, ["RUOC-TOM×1"], "(5) từ chối ⇒ đơn chính giữ nguyên");
      }
      if (c.key === "uac-page-da-gui-menu" || c.key === "uac-page-gui-menu-tu-soan") {
        assert.deepEqual(info, [MODEL_OK], `(7) page đã gửi menu ⇒ ERP không gửi lời mời nào: ${info.join(" | ")}`);
        assert.equal(pco?.outcome, "TEMPLATE_PAGE_SENT_MEDIA", JSON.stringify(pco));
        assert.ok(!st.upsellSent);
      }
      if (c.key === "uac-thieu-tinh") {
        // A1 (chủ shop 22/10/2026): đã có chữ địa chỉ ⇒ chốt kèm cờ (khối «if (order)» ở trên khẳng định CONFIRMED + cờ + 0 vận đơn); câu
        // hỏi tỉnh của model bị điểm gửi cuối bỏ ⇒ khách KHÔNG nhận câu hỏi địa chỉ nào.
        assert.ok(all.every((s) => !/tỉnh|thành phố|địa chỉ/i.test(s) || !s.includes("?")) && !all.some((s) => /xin thêm tỉnh/.test(s)), `không câu hỏi địa chỉ nào tới khách: ${all.join(" | ")}`);
        assert.doesNotMatch(results, /Địa chỉ chưa đủ để giao/, "đã có chữ địa chỉ ⇒ công cụ không bảo model hỏi phần thiếu");
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
}

export async function testP0UpsellAfterContact(): Promise<void> {
  testThuan();
  testNguon();
  await testChatTurn();
  console.log("✓ P0 mời mua thêm sau khi đủ thông tin giao (ca «Mai Le»): cờ theo tổ chức · câu ghi nhận thay «nhân viên sẽ xác nhận địa chỉ» · câu upsell của shop + ảnh · không câu ⇒ không bịa · đồng ý ⇒ đúng món + tổng ERP · từ chối / im ⇒ đơn chính đi · địa chỉ chưa xác minh ⇒ không vận đơn · page đã gửi menu ⇒ không gửi trùng");
}

if (process.argv[1] && /p0-upsell-after-contact\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0UpsellAfterContact)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

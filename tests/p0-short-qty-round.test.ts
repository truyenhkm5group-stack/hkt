/**
 * P0 21/10/2026 — AI SALES KHÔNG HIỂU CÂU CHỐT NGẮN, XỬ LÝ ĐỊA CHỈ KÉM (HSLC, ca «Ngọc Bích», đã che tên / SĐT / địa chỉ):
 *
 *  · 18/10 bot chốt đơn 1kg chả cá thu (cờ địa chỉ còn mở, chưa rời kho). 21/10 khách bấm quảng cáo lại, câu mẫu báo giá «1kg hay 2kg?»,
 *    khách «1kg thôi» ⇒ bot «anh/chị nói rõ hơn giúp em nhé» (hai lần), rồi địa chỉ mới «KCN …, cổng công ty …» bị coi là ĐỔI ĐIỂM GIAO của
 *    đơn 18/10 ⇒ «địa chỉ chưa chắc» ⇒ chuyển người; nhân viên lên đơn thứ hai cùng món cùng số lượng.
 *  · Truy vết (conv-money-trace run 39533383177): bộ đọc giỏ KHÔNG sai — model đã gọi `update_draft_order` 1kg («Sửa đơn đã chốt») +
 *    `confirm_order` («Đơn đã chốt từ trước») rồi im; mức sẵn sàng `CONFIRMED` ⇒ câu chung. Gốc là BỐI CẢNH: lời mua ngày hôm sau trên nền
 *    một đơn đã chốt chưa đi.
 *  · Bản sửa (máy chủ, không phải lời nhắc — round-check.ts): một câu «đặt thêm hay vẫn đơn đó» (ghi nhận đúng món + số lượng) ⇒ «đặt thêm» =
 *    lượt mua mới (giỏ đi theo, KHÔNG mang địa chỉ đơn cũ — AGENTS 3.12) · «vẫn đơn đó» = giữ đơn cũ · không rõ = người. Mảnh địa chỉ theo mốc
 *    địa danh (KCN / công ty / cổng) ⇒ hỏi đúng phần còn thiếu, không bịa xã, không chuyển người.
 * Dữ liệu giả. Mốc thời gian đi theo đồng hồ thật (AGENTS mục 50).
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addressQuestion, looksLikeStreetFragment, parseCustomerAddress } from "@/lib/address/customer-address";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { EMPTY_REPLY_TEXT, silenceFallbackText } from "@/lib/sales-chatbot/engine";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { askedQuantityChoice, choiceAmountText, DELIVERY_ASK_NEEDS_ADDRESS, purchaseAmountIntent, quantityOnlyAnswer, quantityWithDeliveryAsk, roundCheckAnswer, roundCheckStep } from "@/lib/sales-chatbot/round-check";
import { classifyDeliveryQuestion } from "@/lib/sales-chatbot/delivery-intent";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const KCN = "KCN Bắc Thăng Long, cổng công ty SANTOMAS";
const KCN_Q = "Dạ mình cho em xin phường / xã và tỉnh / thành phố của địa chỉ nhận hàng với ạ?";

function testThuan() {
  for (const t of ["1kg thôi", "2kg nhé", "nửa ký", "lấy một ký", "1,5kg", "thôi lấy 1kg", "Mua 1kg thôi"]) assert.ok(purchaseAmountIntent(t), `«${t}» là lời mua có số lượng`);
  for (const t of ["đổi thành 2kg", "thêm 1kg nữa", "1kg bao nhiêu em", "bớt 1kg", "giá bao nhiêu", "ok em"]) assert.ok(!purchaseAmountIntent(t), `«${t}» KHÔNG phải lời mua mới`);
  for (const t of ["đặt thêm đơn mới em nhé", "mua thêm 1 đơn nữa", "đơn mới", "lấy thêm", "cả hai đơn nhé"]) assert.equal(roundCheckAnswer(t), "NEW", `«${t}» = đặt thêm`);
  for (const t of ["đơn cũ em", "vẫn đơn đó", "không phải đơn mới", "đơn hôm trước nhé", "cũ"]) assert.equal(roundCheckAnswer(t), "SAME", `«${t}» = vẫn đơn đó`);
  for (const t of ["0912345678", "ok em", KCN]) assert.equal(roundCheckAnswer(t), null, `«${t}» không trả lời câu hỏi`);

  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const base = { confirmed: { orderId: "erp-75395ed7-x", simulated: false, total: 280_000, at: ago(60) }, phase: "AWAITING_SHIPMENT" as const, text: "1kg thôi", turn: 50, now, answersOffer: false, saidLine: "1kg Chả cá thu", money: (n: number) => `${n.toLocaleString("vi-VN")} ₫` };
  const ask = roundCheckStep(base);
  assert.equal(ask?.kind, "ASK");
  if (ask?.kind === "ASK") {
    assert.match(ask.text, /^Dạ em ghi nhận mình lấy 1kg Chả cá thu ạ\. Mình đang có đơn #[A-Z0-9]+ \(280\.000 ₫\) đặt ngày \d\d\/\d\d — lần này mình muốn đặt thêm một đơn mới, hay vẫn là đơn đó ạ\?$/);
    assert.doesNotMatch(ask.text, /chưa gửi|đã gửi|nói rõ hơn/, "không khẳng định trạng thái gửi (ERP không biết vận đơn ngoài ERP)");
    assert.deepEqual([ask.check.orderId, ask.check.askedTurn], ["erp-75395ed7-x", 50]);
  }
  assert.equal(roundCheckStep({ ...base, confirmed: { ...base.confirmed, at: now.toISOString() } }), null, "cùng ngày chốt ⇒ là sửa đơn vừa đặt, không hỏi");
  assert.deepEqual(roundCheckStep({ ...base, phase: "IN_TRANSIT" }), { kind: "NEW_ROUND" }, "đơn cũ đã rời kho ⇒ lượt mua mới, không hỏi");
  assert.deepEqual(roundCheckStep({ ...base, phase: "RECEIVED" }), { kind: "NEW_ROUND" });
  assert.equal(roundCheckStep({ ...base, answersOffer: true }), null, "trả lời lời mời mua thêm ⇒ việc của bộ lời mời");
  assert.equal(roundCheckStep({ ...base, prior: { orderId: "erp-75395ed7-x", askedTurn: 40, at: ago(1) } }), null, "đã hỏi cho đơn này ⇒ không hỏi lại");
  assert.equal(roundCheckStep({ ...base, text: "đổi thành 2kg" }), null);
  assert.equal(roundCheckStep({ ...base, confirmed: { ...base.confirmed, simulated: true } }), null);
  assert.equal(roundCheckStep({ ...base, phase: "COMPLAINT" }), null, "khiếu nại đi luồng khiếu nại");

  // P0 «Lan Nguyen»: câu trả lời số lượng ngắn — máy chủ quyết, không câu mẫu / AI. Số trần mượn đơn vị của ĐÚNG câu hỏi lựa chọn vừa hỏi.
  for (const t of ["1kg", "2kg", "2kg nhé", "nửa ký", "2kg thôi", "2kg chả cá thu nhé", "Ok 2kg em"]) assert.ok(quantityOnlyAnswer(t, ["Chả cá thu"]), `«${t}» là câu trả lời số lượng`);
  for (const t of ["2kg thôi?", "2kg giao Hà Nội nhé", "2kg bao nhiêu", "thêm 2kg", "đổi thành 2kg", "1kg hay 2kg?", "cho chị 2kg 0912345678"]) assert.ok(!quantityOnlyAnswer(t, ["Chả cá thu"]), `«${t}» không chỉ là số lượng`);
  const choice = "Dạ chả cá thu 280.000 ₫/kg ạ. Mình muốn mua 1kg hay 2kg ạ?";
  // Chỉ là CÂU TRẢ LỜI khi bot vừa hỏi chọn số lượng / quy cách — tin đầu khách tự nói là lượt chọn món (nơi luật #868 đặt câu mời).
  assert.deepEqual([choice, "Dạ chả cá thu có hộp 500g và hộp 1kg. Chị lấy loại nào ạ?", "Mình lấy mấy hộp ạ?", "Dạ shop còn chả mực ạ.", "Dạ mình cho em xin SĐT nhé?", null].map(askedQuantityChoice), [true, true, true, false, false, false]);
  assert.deepEqual(["lấy 2", "2", "1 thôi", "cho chị 2 nhé", "lấy 3", "2 hộp"].map((t) => choiceAmountText(t, choice)), ["2kg", "2kg", "1kg", "2kg", null, null]);
  assert.equal(choiceAmountText("lấy 2", "Dạ chả cá thu 280.000 ₫/kg ạ."), null, "câu trước không phải câu hỏi lựa chọn ⇒ không đoán đơn vị");
  assert.equal(choiceAmountText("lấy 2", "Mình lấy 2 hộp hay 2kg ạ?"), null, "số khớp hai đơn vị ⇒ không đoán");

  // Tin HAI Ý (ca «Xuân Đoàn»): đúng một câu số lượng + câu hỏi giao; câu thứ hai là chuyện khác ⇒ không phải dáng này.
  const isD = (x: string) => classifyDeliveryQuestion(x)?.intent === "DELIVERY_TIME";
  assert.deepEqual(quantityWithDeliveryAsk("Cho chị 2kg. Mấy ngày nhận được hàng.", ["Chả cá thu"], isD), { quantity: "Cho chị 2kg", delivery: "Mấy ngày nhận được hàng" });
  for (const t of ["Cho chị 2kg, giao Hà Nội nhé", "2kg nhé. Shop ở đâu vậy?", "Cho chị 2kg", "Lấy 2kg, gửi địa chỉ cũ"]) assert.equal(quantityWithDeliveryAsk(t, ["Chả cá thu"], isD), null, t);
  assert.doesNotMatch(DELIVERY_ASK_NEEDS_ADDRESS, /\d|hôm nay|ngày mai|mai /, "không mốc, không số ngày khi chưa biết nơi giao");

  // Địa chỉ theo mốc địa danh: là mảnh địa chỉ, KHÔNG bịa tỉnh / xã, một câu hỏi phần còn thiếu.
  assert.ok(looksLikeStreetFragment(KCN), "«KCN …, cổng công ty …» là nơi giao");
  const p = parseCustomerAddress(KCN);
  assert.deepEqual([p.province, p.ward], [null, null], "không tự gán tỉnh / xã cho mốc địa danh");
  assert.equal(addressQuestion(p), KCN_Q);

  // Lượt model im: câu hỏi lại theo đúng phần thiếu, không bao giờ «nói rõ hơn» khi giỏ đã có món khách nói.
  const cartSt = { cart: { selectedItems: [{ label: "Chả cá thu", match: "cha ca thu", productId: "p1", variantId: "v1", sku: "CC", quantity: 1000, unit: "g", sourceMessageId: 50, confidence: "HIGH", customerExplicit: true }] } } as unknown as ChatState;
  assert.match(silenceFallbackText(cartSt, "1kg thôi", 50, true), /số điện thoại/, "giỏ có món, chưa SĐT ⇒ xin SĐT");
  const withPhone = { ...cartSt, customer: { id: null, name: "A", phone: "0961000000", address: "", province: "", simulated: false } } as ChatState;
  assert.equal(silenceFallbackText(withPhone, KCN, 52, true), KCN_Q, "khách vừa gửi mảnh địa chỉ ⇒ hỏi đúng phần thiếu, không xin lại cả địa chỉ");
  assert.notEqual(silenceFallbackText(withPhone, "đặt thêm đơn mới em nhé", 51, true), EMPTY_REPLY_TEXT);
}

const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const NEW_ADDR = `${KCN}, Phường Hoàn Kiếm, Thành phố Hà Nội`;
const silent = [() => [say("")]];
const first = (phone: string) => ({ say: `Cho chị 1kg chả mực giã tay, Lan ${phone}, ${ADDR}`, ai: [() => [tool("create_customer", { name: "Lan", phone, address: ADDR })], ({ v }: { v: (s: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em lên đơn 1kg chả mực giã tay cho mình rồi ạ.")]] });
/** Đẩy đơn đã chốt + mốc chốt về `hours` giờ trước (ngày VN trước — ca thật cách 2,5 ngày). */
const age = (hours: number) => async (ctx: GoldenHookCtx) => {
  const db = await getDb();
  const at = new Date(Date.now() - hours * 3_600_000);
  await db.update(schema.orders).set({ insertedAt: at }).where(eq(schema.orders.salesConversationId, ctx.conversationId));
  const c = schema.salesChatConversations;
  const [row] = await db.select({ state: c.state }).from(c).where(eq(c.id, ctx.conversationId));
  const st = row.state as ChatState;
  if (st.confirmed) st.confirmed.at = at.toISOString();
  await db.update(c).set({ state: st as Record<string, unknown> }).where(eq(c.id, ctx.conversationId));
};
/** Ca thật: khách bấm quảng cáo lại, CÂU MẪU báo giá «1kg hay 2kg?» — gieo thẳng hai tin (không qua model). */
const seedQuote = async (ctx: GoldenHookCtx) => {
  const db = await getDb();
  const m = schema.salesChatMessages;
  const rows = await db.select({ seq: m.seq }).from(m).where(eq(m.conversationId, ctx.conversationId));
  const next = rows.length ? Math.max(...rows.map((r) => r.seq)) + 1 : 0;
  await db.insert(m).values([
    { conversationId: ctx.conversationId, seq: next, role: "user", content: [{ type: "text", text: "Chả mực giá bao nhiêu shop?" }] },
    { conversationId: ctx.conversationId, seq: next + 1, role: "assistant", content: [{ type: "text", text: "Dạ chả mực giã tay 400.000 ₫/kg ạ, mình lấy 1kg hay 2kg ạ?" }] },
  ]);
};
const reorder = (hours: number) => async (ctx: GoldenHookCtx) => {
  await age(hours)(ctx);
  await seedQuote(ctx);
};
const shipOld = async (ctx: GoldenHookCtx) => {
  const db = await getDb();
  const [o] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
  await db.insert(schema.shipments).values({ orderId: o.id, vtpOrderNumber: `RC-${o.id.slice(-6)}`, trackingCode: `RC-${o.id.slice(-6)}`, stage: "PICKED_UP" as never, codAmount: 400_000 });
};

const CASES: GoldenCase[] = [
  { key: "rc-ngoc-bich", title: "Phát lại ca «Ngọc Bích»: đơn cũ 2,5 ngày chưa đi ⇒ «1kg thôi» = một câu đơn mới/đơn cũ ⇒ «đặt thêm» ⇒ hỏi địa chỉ (không lấy địa chỉ cũ) ⇒ KCN ⇒ hỏi đúng phần thiếu ⇒ đủ ⇒ đơn MỚI, đơn cũ nguyên vẹn", shop: "food", channel: "FANPAGE", turns: [
    first("0961007201"),
    { say: "1kg thôi", before: reorder(60), ai: silent },
    { say: "đặt thêm đơn mới em nhé", ai: silent },
    // Lượt SAU câu trả lời: đơn cũ chưa giao vẫn đọc được qua pastOrders — lượt này vẫn là BÁN, model im ⇒ xin địa chỉ, không chuyển người.
    { say: "0961007201", ai: silent },
    { say: KCN, ai: [() => [tool("create_customer", { name: "Lan", phone: "0961007201", address: KCN })], () => [say(KCN_Q)]] },
    { say: "Phường Hoàn Kiếm, Hà Nội em nhé", ai: [() => [tool("create_customer", { name: "Lan", phone: "0961007201", address: NEW_ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em lên đơn 1kg chả mực giã tay giao về KCN cho mình rồi ạ.")]] },
  ] },
  { key: "rc-van-don-cu", title: "Khách trả lời «vẫn đơn đó» ⇒ giữ đơn cũ, không lên đơn thứ hai", shop: "food", channel: "FANPAGE", turns: [
    first("0961007202"),
    { say: "1kg thôi", before: reorder(60), ai: silent },
    { say: "vẫn đơn đó em", ai: [() => [say("Dạ vâng, em giữ đơn cũ cho mình ạ.")]] },
  ] },
  { key: "rc-khong-ro", title: "Sau câu hỏi khách chỉ gửi SĐT ⇒ người hỏi lại, bot im trên fanpage, không lên đơn thứ hai", shop: "food", channel: "FANPAGE", turns: [
    first("0961007203"),
    { say: "1kg thôi", before: reorder(60), ai: silent },
    { say: "0961007203", ai: silent },
  ] },
  { key: "rc-da-roi-kho", title: "Đơn cũ đã rời kho ⇒ «1kg thôi» là lượt mua mới ngay, không hỏi, không sửa đơn cũ", shop: "food", channel: "FANPAGE", turns: [
    first("0961007204"),
    { say: "1kg thôi", before: async (ctx) => { await shipOld(ctx); await reorder(60)(ctx); }, ai: silent },
  ] },
  { key: "rc-cung-ngay", title: "Cùng ngày chốt ⇒ «2kg nhé» là sửa đơn vừa đặt (luồng cũ), không hỏi đơn mới/đơn cũ", shop: "food", channel: "FANPAGE", turns: [
    first("0961007205"),
    { say: "2kg nhé", ai: [() => [say("Dạ mình muốn đổi đơn thành 2kg đúng không ạ?")]] },
  ] },
  { key: "rc-khach-moi", title: "Khách mới: câu báo giá «1kg hay 2kg?» ⇒ «1kg thôi» ghi giỏ ngay ⇒ máy chủ ghi nhận + xin SĐT, không «nói rõ hơn»", shop: "food", channel: "FANPAGE", turns: [
    { say: "1kg thôi", before: seedQuote, ai: silent },
  ] },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-rcq",
    beforeCase: async () => {
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const orders = await db.select({ id: schema.orders.id, addr: schema.orders.shipAddress }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      const lines = async (orderId: string) => (await db.select({ q: schema.orderItems.quantity, v: schema.orderItems.variantId }).from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId))).map((x) => [x.v === ctx.ids.get("CHA-MUC"), x.q]);
      const c0 = schema.salesChatConversations;
      const [row] = await db.select({ state: c0.state, status: c0.status, reason: c0.handoffReason }).from(c0).where(eq(c0.id, ctx.conversationId));
      const st = (row.state ?? {}) as ChatState;
      const all = t.turns.flatMap((x) => x.shown);
      assert.ok(!all.includes(EMPTY_REPLY_TEXT), `[${c.key}] không «nói rõ hơn»: ${all.join(" | ")}`);
      const ask = t.turns[1]?.shown ?? [];
      if (c.key !== "rc-cung-ngay" && c.key !== "rc-khach-moi" && c.key !== "rc-da-roi-kho") {
        assert.equal(t.turns[1].rounds.length, 0, `[${c.key}] câu hỏi do máy chủ quyết, không gọi model`);
        assert.equal(ask.length, 1);
        assert.match(ask[0], /^Dạ em ghi nhận mình lấy 1kg Chả mực giã tay ạ\. Mình đang có đơn #(?:<MÃ ĐƠN>|\S+) \(400\.000 ₫\) đặt ngày \d\d\/\d\d — lần này mình muốn đặt thêm một đơn mới, hay vẫn là đơn đó ạ\?$/);
      }
      if (c.key === "rc-ngoc-bich") {
        const [old, neu] = [...orders].sort((a, b) => (a.addr === ADDR ? -1 : b.addr === ADDR ? 1 : 0));
        assert.equal(orders.length, 2, "đúng HAI đơn: đơn cũ + đơn khách xác nhận đặt thêm");
        assert.equal(old.addr, ADDR, "đơn cũ không bị đổi địa chỉ");
        assert.deepEqual(await lines(old.id), [[true, 1]], "đơn cũ không bị sửa món");
        assert.match(neu.addr, /KCN Bắc Thăng Long/, "đơn mới giao về điểm khách vừa gửi");
        assert.deepEqual(await lines(neu.id), [[true, 1]], "đơn mới đúng 1 × chả mực");
        const askAddr = t.turns[2].shown.join(" ");
        assert.match(askAddr, /địa chỉ nhận hàng/, `đặt thêm ⇒ xin địa chỉ: ${askAddr}`);
        assert.doesNotMatch(askAddr, /Hai Bà Trưng|xác nhận giúp em/, "không tự lấy địa chỉ đơn cũ, không xin chốt với địa chỉ cũ");
        assert.equal(t.turns[3].status, "OPEN", "lượt sau câu trả lời vẫn là BÁN, không chuyển người");
        assert.match(t.turns[3].shown.join(" "), /địa chỉ nhận hàng/, `model im ⇒ xin địa chỉ: ${t.turns[3].shown.join(" | ")}`);
        assert.deepEqual(t.turns[4].shown, [KCN_Q], "mảnh địa chỉ KCN ⇒ đúng một câu hỏi phần thiếu");
        assert.notEqual(t.turns[4].status, "HANDOFF", "không chuyển người chỉ vì thiếu tỉnh / xã");
        assert.ok(!t.turns.slice(1).some((x) => x.rounds.some((r) => r.tools.some((y) => y.name === "update_draft_order"))), "không sửa đơn cũ");
        // Gốc ca thật: lời nhắc hậu mãi («khách ĐÃ CÓ ĐƠN… KHÔNG gọi create_draft_order») kéo model về sửa đơn cũ. Sau «đặt thêm», mọi vòng model
        // của lượt mới nhận lời nhắc BÁN, không phải lời nhắc hậu mãi.
        const salesRounds = t.turns.slice(2).flatMap((x) => x.rounds);
        assert.ok(salesRounds.length > 0 && salesRounds.every((r) => !t.prompts[r.prompt].includes("GIAI ĐOẠN KHÁCH:")), "lượt mua mới không mang lời nhắc hậu mãi của đơn cũ");
      }
      if (c.key === "rc-van-don-cu") {
        assert.equal(orders.length, 1, "vẫn đơn đó ⇒ không lên đơn thứ hai");
        assert.equal(st.roundCheck?.answer, "SAME");
        assert.ok(st.confirmed, "đơn cũ vẫn là đơn của lượt này");
      }
      if (c.key === "rc-khong-ro") {
        assert.equal(orders.length, 1);
        assert.equal(row.status, "HANDOFF");
        assert.match(row.reason ?? "", /^Cần người xử lý — khách có đơn #\S+ \(đặt \d\d\/\d\d\) chưa rời kho và vừa nhắn mua lại — chưa rõ đặt thêm hay vẫn đơn đó/);
        assert.deepEqual(t.turns[2].shown, [], "fanpage chuyển người ⇒ bot im");
      }
      if (c.key === "rc-da-roi-kho") {
        assert.ok(!ask.some((x) => /đặt thêm một đơn mới/.test(x)), "không hỏi khi đơn cũ đã rời kho");
        assert.equal(st.roundCheck?.answer, "NEW");
        assert.ok(!st.confirmed && (st.pastOrders ?? []).length === 1, "đơn cũ sang pastOrders, lượt mới bắt đầu");
        assert.equal(st.customer?.address ?? "", "", "lượt mới không mang địa chỉ đơn cũ");
        assert.equal(st.cart?.selectedItems[0]?.quantity, 1000, "giỏ giữ 1kg khách vừa nói");
        assert.equal(orders.length, 1);
      }
      if (c.key === "rc-cung-ngay") {
        assert.ok(t.turns[1].rounds.length > 0 && !t.turns[1].shown.some((x) => /đặt thêm một đơn mới/.test(x)), "cùng ngày ⇒ model xử lý như sửa đơn");
        assert.equal(st.roundCheck, undefined);
      }
      if (c.key === "rc-khach-moi") {
        assert.deepEqual(t.turns[0].shown, ["Dạ em ghi nhận mình lấy 1kg Chả mực giã tay ạ. Mình cho em xin số điện thoại nhận hàng nhé."], "giỏ đã có 1kg ⇒ ghi nhận + hỏi đúng phần thiếu");
        assert.equal(t.turns[0].rounds.length, 0, "câu trả lời số lượng rõ ràng ⇒ máy chủ quyết, không lượt AI");
        assert.equal(st.cart?.selectedItems.find((x) => x.customerExplicit)?.quantity, 1000);
        assert.equal(st.cart?.selectedItems.find((x) => x.customerExplicit)?.label, "Chả mực giã tay", "giỏ gắn đúng món vừa báo giá (mẫu mã + giá gắn ở bước công cụ — bindCommitment)");
      }
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
}

/** Câu mẫu báo giá như câu #1 của HSLC: khớp chữ «kg» ⇒ «2kg» cũng khớp (gốc ca «Lan Nguyen»). */
const QUOTE = "Dạ chả mực giã tay 400.000 ₫/kg ạ. Mình muốn mua 1kg hay 2kg ạ?";
const ASK_PRICE = "Chả mực giá bao nhiêu shop?";
const QTY_CASES: GoldenCase[] = [
  { key: "qty-2kg", title: "Ca «Lan Nguyen»: câu mẫu «1kg hay 2kg?» ⇒ «2kg» ⇒ máy chủ ghi nhận + xin SĐT, KHÔNG gửi lại câu báo giá, 0 lượt AI", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "2kg", ai: silent },
  ] },
  { key: "qty-lay-2", title: "«lấy 2» sau «1kg hay 2kg?» ⇒ 2kg", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "lấy 2", ai: silent },
  ] },
  { key: "qty-nua-ky", title: "«nửa ký» ⇒ ghi nhận đúng khối lượng", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "nửa ký nhé", ai: silent },
  ] },
  { key: "qty-cho-chi-2kg", title: "«Cho chị 2kg» sau «1kg hay 2kg?» ⇒ máy chủ ghi nhận + xin SĐT", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "Cho chị 2kg", ai: silent },
  ] },
  { key: "qty-hai-y", title: "Ca «Xuân Đoàn»: «Cho chị 2kg. Mấy ngày nhận được hàng?» ⇒ ghi giỏ + đáp CẢ câu hỏi giao (chưa có địa chỉ ⇒ xin địa chỉ, không số ngày) — không gửi lại câu báo giá", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "Cho chị 2kg. Mấy ngày nhận được hàng?", ai: silent },
  ] },
  { key: "qty-doi-so", title: "«2kg» rồi «à thôi 1kg nhé» ⇒ giỏ đổi thành 1kg, câu báo giá KHÔNG gửi lại (câu mẫu đã gửi trong lượt mua này)", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "2kg", ai: silent },
    { say: "à thôi 1kg nhé", ai: silent },
  ] },
  { key: "qty-hoi-gia", title: "«2kg giá bao nhiêu?» là HỎI giá, chưa mua ⇒ không ghi nhận như lời chốt", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "2kg giá bao nhiêu?", ai: [() => [say("Dạ 2kg chả mực giã tay 800.000 ₫ ạ.")]] },
  ] },
  { key: "qty-dia-chi-cu", title: "«Lấy 2kg, gửi địa chỉ cũ» ⇒ giỏ 2kg; không gửi lại câu báo giá; địa chỉ cũ chỉ là gợi ý (model / công cụ use_saved_address), máy chủ không tự điền", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "Lấy 2kg, gửi địa chỉ cũ", ai: [() => [say("Dạ mình cho em xin lại địa chỉ nhận hàng để em kiểm nhé.")]] },
  ] },
  { key: "qty-upsell", title: "Shop có câu upsell CHƯA gửi ⇒ bước xác định nhường model (luồng #868 mời lúc khách vừa chọn món) — câu báo giá vẫn KHÔNG gửi lại", shop: "food", channel: "FANPAGE", turns: [
    { say: ASK_PRICE, ai: silent },
    { say: "2kg", ai: [() => [say("Dạ mình cho em xin SĐT và địa chỉ nhận hàng nhé.")]] },
  ] },
  { key: "qty-tin-dau", title: "Tin ĐẦU khách tự nói «1kg chả mực nhé» (bot chưa hỏi gì) ⇒ không phải câu trả lời — luồng thường", shop: "food", channel: "FANPAGE", turns: [
    { say: "1kg chả mực nhé em", ai: [() => [say("Dạ mình cho em xin SĐT và địa chỉ nhận hàng nhé.")]] },
  ] },
];

async function testQuantityAnswers() {
  const seen = new Set<string>();
  await runGoldenCases(QTY_CASES, {
    orgSuffix: "-qty",
    beforeCase: async (c) => {
      const db = await getDb();
      const qr = schema.salesChatQuickReplies;
      const [row] = await db.select({ id: qr.id }).from(qr).where(eq(qr.title, "Giá chả mực")).limit(1);
      if (!row) await db.insert(qr).values({ title: "Giá chả mực", triggers: ["chả mực", "kg"], answer: QUOTE, active: true });
      let upsellReplyId: string | null = null;
      if (c.key === "qty-upsell") {
        const [u] = await db.select({ id: qr.id }).from(qr).where(eq(qr.title, "Món bán chạy")).limit(1);
        upsellReplyId = u?.id ?? (await db.insert(qr).values({ title: "Món bán chạy", triggers: ["món bán chạy"], answer: "Dạ bên em còn ruốc bông tôm ngon lắm ạ.", active: true }).returning({ id: qr.id }))[0].id;
      }
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId, autoLearn: false, autoActivate: false });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const [row] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const st = (row.state ?? {}) as ChatState;
      if (c.key === "qty-tin-dau") {
        assert.ok(!t.turns[0].shown.some((x) => x.startsWith("Dạ em ghi nhận mình lấy")), `tin đầu khách tự nói ⇒ không phải câu trả lời số lượng — luồng thường (câu mẫu / model): ${t.turns[0].shown.join(" | ")}`);
        return;
      }
      assert.deepEqual(t.turns[0].shown, [QUOTE], `[${c.key}] lượt đầu: câu mẫu báo giá`);
      if (c.key === "qty-upsell") {
        assert.ok(t.turns[1].rounds.length > 0, "câu upsell đang tới lượt ⇒ nhường model (#868)");
        assert.ok(!t.turns[1].shown.includes(QUOTE), "giỏ đã gắn món ⇒ hàng rào #868 chặn câu báo giá lặp");
        return;
      }
      const second = t.turns[1];
      const item = st.cart?.selectedItems.find((x) => x.customerExplicit);
      const orders = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      assert.ok(orders.length <= 1, `[${c.key}] không đơn trùng`);
      const allShown = t.turns.slice(1).flatMap((x) => x.shown);
      if (c.key !== "qty-hoi-gia") assert.ok(!allShown.includes(QUOTE), `[${c.key}] câu báo giá KHÔNG gửi lại: ${allShown.join(" | ")}`);
      if (c.key === "qty-cho-chi-2kg") assert.deepEqual([second.rounds.length, second.shown, item?.quantity], [0, ["Dạ em ghi nhận mình lấy 2kg Chả mực giã tay ạ. Mình cho em xin số điện thoại nhận hàng nhé."], 2000]);
      if (c.key === "qty-hai-y") {
        assert.equal(second.rounds.length, 0, "đủ ngữ cảnh ⇒ máy chủ quyết, không lượt AI");
        assert.deepEqual(second.shown, [`Dạ em ghi nhận mình lấy 2kg Chả mực giã tay ạ. ${DELIVERY_ASK_NEEDS_ADDRESS} Mình cho em xin số điện thoại nhận hàng nhé.`], "đáp CẢ HAI ý: ghi nhận số lượng + câu hỏi giao");
        assert.equal(item?.quantity, 2000);
      }
      if (c.key === "qty-doi-so") {
        assert.equal(item?.quantity, 1000, "đổi 2kg ⇒ 1kg");
        assert.ok(!t.turns[2].shown.some((x) => /1kg hay 2kg/.test(x)), "không hỏi lại số lượng");
      }
      if (c.key === "qty-hoi-gia") {
        assert.ok(!second.shown.some((x) => x.startsWith("Dạ em ghi nhận mình lấy")), "hỏi giá ⇒ không ghi nhận như lời chốt");
        assert.equal(orders.length, 0, "hỏi giá không lên đơn");
      }
      if (c.key === "qty-dia-chi-cu") {
        assert.equal(item?.quantity, 2000);
        assert.equal(orders.length, 0, "máy chủ không tự lên đơn bằng địa chỉ cũ");
      }
      if (c.key === "qty-2kg" || c.key === "qty-lay-2" || c.key === "qty-nua-ky") {
        assert.equal(second.rounds.length, 0, `[${c.key}] máy chủ quyết, không lượt AI: ${JSON.stringify(second.rounds)}`);
        assert.equal(second.shown.length, 1);
        assert.ok(!second.shown.includes(QUOTE), `[${c.key}] KHÔNG gửi lại câu báo giá`);
        assert.doesNotMatch(second.shown[0], /1kg hay 2kg|muốn mua \d/, `[${c.key}] KHÔNG hỏi lại số lượng`);
        assert.match(second.shown[0], /^Dạ em ghi nhận mình lấy .+ Chả mực giã tay ạ\. Mình cho em xin số điện thoại nhận hàng nhé\.$/, `[${c.key}] ${second.shown[0]}`);
        assert.equal(item?.label, "Chả mực giã tay", `[${c.key}] giỏ gắn đúng món vừa báo giá`);
        assert.equal(item?.quantity, c.key === "qty-nua-ky" ? 500 : 2000, `[${c.key}] đúng khối lượng`);
      }
    },
  });
  assert.deepEqual([...seen].sort(), QTY_CASES.map((c) => c.key).sort());
}

export async function testP0ShortQtyRound(): Promise<void> {
  testThuan();
  await testChatTurn();
  await testQuantityAnswers();
  console.log("✓ P0 câu chốt ngắn: «1kg thôi / nửa ký / 1,5kg / thôi lấy 1kg» ghi giỏ · lời mua mới trên đơn cũ chưa đi ⇒ MỘT câu đặt thêm / vẫn đơn đó (máy chủ) · đặt thêm ⇒ lượt mới không mang địa chỉ cũ · vẫn đơn đó ⇒ không đơn thứ hai · không rõ ⇒ người · đơn cũ đã rời kho ⇒ lượt mới · mốc địa danh KCN ⇒ hỏi đúng phần thiếu, không bịa xã · không «nói rõ hơn»");
}

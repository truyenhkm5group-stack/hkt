/**
 * P0 #855 — ca HSLC «ThuyNgo» (16/10/2026): khách «Ship chị 1 mực giã tay», bot báo 1kg chả cá thu + 1kg chả mực = 680.000 ₫.
 *
 * GỐC (đo bằng chính hàm của đường ghi): `amountsIn` chỉ đọc số CÓ đơn vị («1kg», «2 gói»), nên «1 mực giã tay» ra 0 số lượng ⇒ giỏ
 * có thẩm quyền ở `undefined` ⇒ `unrequestedProducts` trả `[]` («giỏ chưa có món khách nói ⇒ không đủ căn cứ để chặn») ⇒ công cụ
 * lên đơn nhận mọi món model đưa vào, kể cả món khách KHÔNG nói. Chữ khách là nguồn thẩm quyền: sửa ở máy chủ, không ở lời nhắc.
 *
 * Bài kiểm khoá:
 *  1. «1 mực giã tay» (số trần + tên khớp ĐÚNG MỘT món danh mục) ⇒ giỏ 1 × Chả mực giã tay, khách nói tường minh.
 *  2. Đơn đề nghị cá + mực ⇒ máy chủ từ chối «Chả cá thu» (cả khi khách không nói số — vế gọi tên trong chữ mua).
 *  3. Số trần không phải số lượng (số nhà, SĐT, «2 hôm trước») không đẻ món.
 *  4. Phủ nhận «kg có order chả cá thu» ⇒ bỏ cá, giữ mực; «2 kg, đặt luôn» KHÔNG phải phủ định.
 *  5. Hai SKU + sửa số lượng; tổng tiền đơn = báo giá máy chủ (golden qua `chatTurn` thật, không gửi tin thật).
 *  6. «Robot hả» / phản đối món lặp ≥ 2 lần ⇒ lý do chuyển người KHÔNG tự hết hạn (AI không quay lại sau cooldown).
 *
 * Không gọi mạng (luật 65), không ghim ngày (luật 50).
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createProductCore } from "@/lib/records/product-create";
import { aiHoldOf } from "@/lib/sales-chatbot/ai-hold-shared";
import {
  amountsIn,
  applyCustomerCartMessage,
  buyingText,
  hasEditCue,
  itemObjectionCue,
  lineBasisViolation,
  orderReadiness,
  type AskedLine,
  type CartCommitment,
} from "@/lib/sales-chatbot/cart-commitment";
import { classifyHandoffReason } from "@/lib/sales-chatbot/events-shared";
import { CUSTOMER_HANDOFF_REASON, customerDemandsHuman, customerHandoffVerdict, nextObjectionTally } from "@/lib/sales-chatbot/handoff-routing-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const CAT = ["Chả cá thu (1kg)", "Chả cá thu (2kg)", "Chả mực giã tay (1kg)", "Mực khô câu (500g)", "Nem hải sản tôm bề bề (Hộp 10 cái)", "Ruốc tôm (Hũ 100g)"];
const NOW = () => new Date();
const L = (productId: string, variantId: string, name: string, quantity: number, weightGrams: number | null): AskedLine => ({ productId, variantId, name, quantity, weightGrams });
const CA = L("p-ca", "c1", "Chả cá thu (1kg)", 1, 1000);
const MUC = L("p-muc", "m1", "Chả mực giã tay (1kg)", 1, 1000);
const names = (c: CartCommitment | undefined) => (c?.selectedItems ?? []).map((x) => [x.label, x.quantity, x.unit, x.customerExplicit]);

function testRootCause() {
  const t = "Ship chị 1 mực giã tay";
  const a = amountsIn(t, CAT);
  assert.equal(a.length, 1, `«${t}» phải đọc ra MỘT số lượng (trước bản vá: 0 ⇒ giỏ rỗng ⇒ hàng rào tắt)`);
  assert.equal(a[0].label, "cha muc gia tay");
  assert.equal(a[0].value, 1);
  const cart = applyCustomerCartMessage(undefined, t, 1, NOW(), { catalog: CAT });
  assert.deepEqual(names(cart), [["Chả mực giã tay", 1, "pack", true]], "giỏ = 1 chả mực, khách nói tường minh");
  const v = lineBasisViolation(cart, [CA, MUC], 1, buyingText([t]));
  assert.ok(v && /Chả cá thu/.test(v), `đơn cá + mực phải bị từ chối vì «Chả cá thu»: ${v}`);
  assert.equal(lineBasisViolation(cart, [MUC], 1, buyingText([t])), null, "đơn đúng 1 chả mực đi qua");
  assert.ok(lineBasisViolation(cart, [{ ...MUC, quantity: 2 }], 1, buyingText([t])), "bot tự tăng 2 chả mực bị chặn");

  // Không có số (máy không đọc được số lượng) nhưng khách GỌI TÊN đúng một món trong đơn đề nghị ⇒ món còn lại không có căn cứ.
  for (const said of ["Ship chị mực giã tay", "chị lấy chả mực nha"]) {
    const v2 = lineBasisViolation(undefined, [CA, MUC], 1, buyingText([said]));
    assert.ok(v2 && /Chả cá thu/.test(v2) && !/Chả mực/.test(v2), `«${said}»: chỉ cá bị từ chối: ${v2}`);
    assert.equal(lineBasisViolation(undefined, [MUC], 1, buyingText([said])), null);
  }
  // Khách không gọi tên món nào trong đơn ⇒ không đủ căn cứ để chặn (luật an toàn của tệp giữ nguyên).
  assert.equal(lineBasisViolation(undefined, [CA, MUC], 1, buyingText(["ok em lên đơn đi"])), null);
  // Câu hỏi giá / câu từ chối không phải chữ mua.
  assert.ok(lineBasisViolation(undefined, [CA, MUC], 1, buyingText(["chị lấy chả mực", "chả cá thu bao nhiêu em?"]))?.includes("Chả cá thu"));
}

function testBareNumberGuards() {
  // Số trần KHÔNG kèm tên món danh mục ⇒ không phải số lượng.
  for (const t of ["số 12 Khương Đình", "0912345678", "2 hôm trước chị mua chả mực rồi", "chị ở ngõ 3 Khương Đình", "giao 2 ngày nữa nha"]) {
    assert.deepEqual(amountsIn(t, CAT), [], `«${t}» không đẻ số lượng`);
  }
  // Tên mơ hồ («1 chả» khi có chả cá + chả mực) ⇒ không đoán món.
  assert.deepEqual(amountsIn("ship chị 1 chả nha", CAT), []);
  // Không danh mục ⇒ hành vi cũ (không đọc số trần).
  assert.deepEqual(amountsIn("Ship chị 1 mực giã tay"), []);
  // Đơn vị cũ không đổi.
  assert.deepEqual(amountsIn("Cho chị 2kg chả cá thu", CAT).map((x) => [x.value, x.unit, x.label]), [[2000, "g", "cha ca thu"]]);
  assert.deepEqual(amountsIn("thêm 1 hộp nem", CAT).map((x) => [x.value, x.unit]), [[1, "pack"]]);
  // «2 gói, thêm 1 ruốc tôm» trong MỘT câu ⇒ đặt cả hai (không đánh rơi «2 gói»).
  const both = applyCustomerCartMessage(undefined, "Cho chị 2 gói, thêm 1 ruốc tôm.", 1, NOW(), { catalog: CAT });
  assert.deepEqual(names(both), [["", 2, "pack", true], ["Ruốc tôm", 1, "pack", true]]);
  assert.deepEqual(amountsIn("2 chả cá thu với 1 mực giã tay", CAT).map((x) => [x.value, x.label]), [[2, "cha ca thu"], [1, "cha muc gia tay"]]);
}

function testDenyAndEdit() {
  // Ca thật: giỏ đã bị đổ thêm cá (bot đề xuất) + mực khách nói.
  const base: CartCommitment = {
    selectedItems: [
      { label: "Chả cá thu", match: "cha ca thu", productId: "p-ca", variantId: "c1", sku: null, quantity: 1000, unit: "g", sourceMessageId: null, confidence: "LOW", customerExplicit: false },
      { label: "Chả mực giã tay", match: "cha muc gia tay", productId: "p-muc", variantId: "m1", sku: null, quantity: 1, unit: "pack", sourceMessageId: 1, confidence: "HIGH", customerExplicit: true },
    ],
    turn: 1,
    at: NOW().toISOString(),
  };
  for (const t of ["Kg có order chả cá thu nha", "Không có order chả cá thu nha", "Ko order chả cá thu", "Không đặt chả cá thu"]) {
    const out = applyCustomerCartMessage(base, t, 2, NOW(), { catalog: CAT });
    assert.deepEqual(names(out), [["Chả mực giã tay", 1, "pack", true]], `«${t}» ⇒ bỏ cá, giữ mực`);
  }
  // «Chị order mực» chỉ nhắc lại — giỏ không đổi, không huỷ.
  const same = applyCustomerCartMessage(base, "Chị order mực", 2, NOW(), { catalog: CAT });
  assert.equal(same?.selectedItems.length, 2);
  // «2 kg» cạnh «đặt» KHÔNG phải phủ định.
  assert.equal(hasEditCue("Cho chị 2 kg, đặt luôn nhé"), false, "«2 kg đặt» không phải câu sửa");
  assert.equal(hasEditCue("Kg có order chả cá thu nha"), true);
  // Hai SKU + sửa số lượng.
  let cart = applyCustomerCartMessage(undefined, "Cho chị 1kg chả cá thu với 1 mực giã tay", 1, NOW(), { catalog: CAT });
  assert.deepEqual(names(cart), [["Chả cá thu", 1000, "g", true], ["Chả mực giã tay", 1, "pack", true]]);
  cart = applyCustomerCartMessage(cart, "chả mực lấy 2kg thôi", 2, NOW(), { catalog: CAT });
  assert.deepEqual(names(cart), [["Chả mực giã tay", 2000, "g", true]], "«chỉ / thôi» với giỏ 2 món ⇒ giữ đúng món đó, số mới");
  let two = applyCustomerCartMessage(undefined, "Cho chị 1kg chả cá thu với 1 mực giã tay", 1, NOW(), { catalog: CAT });
  two = applyCustomerCartMessage(two, "đổi chả cá thu thành 2kg", 2, NOW(), { catalog: CAT });
  assert.deepEqual(names(two), [["Chả cá thu", 2000, "g", true], ["Chả mực giã tay", 1, "pack", true]]);
  assert.equal(lineBasisViolation(two, [{ ...CA, quantity: 2 }, MUC], 2, ""), null, "đơn 2kg cá + 1 mực đúng ý khách");
}

function testHandoffSignals() {
  for (const t of ["Robot hả", "robot à", "Robot ha em", "máy à", "bot hả", "Đang nói chuyện với máy hả", "em là robot à", "cho chị gặp nhân viên", "chị muốn nói chuyện với người thật", "trả lời tự động à", "gọi chủ shop cho chị"]) {
    assert.equal(customerDemandsHuman(t), true, `«${t}» ⇒ đòi người`);
  }
  // Review #855: «người» trần, «người nhận / người nhà», «người thật» không đi với gặp / nói chuyện, hỏi HÀNG có robot / máy.
  for (const t of ["Chị order mực", "ship chị 1 mực giã tay", "máy xay thịt bao nhiêu em", "Địa chỉ cũ", "ok em", "người nhận là chị Thuỷ", "không gặp người nhận thì gửi bảo vệ giúp chị", "nhờ shipper gọi người nhà chị trước", "em chuyển cho người nhà chị nhé", "có ảnh người thật mặc không shop", "có bán robot không em", "bên em có máy không"]) {
    assert.equal(customerDemandsHuman(t), false, `«${t}» không phải đòi người`);
  }
  const labels = ["Chả cá thu", "Chả mực giã tay"];
  for (const t of ["Kg có order chả cá thu nha", "Sao kg coi ở trên", "Khách cũ mà hỏi gì", "sai rồi em", "chị đâu có đặt chả cá", "chị chưa đặt chả cá thu bao giờ", "chả mực chị nói rồi mà"]) {
    assert.equal(itemObjectionCue(t, labels), true, `«${t}» là phản đối`);
  }
  // Phủ nhận / «nói rồi» KHÔNG gọi tên món trong giỏ ⇒ không phải phản đối món.
  for (const t of ["Chị order mực", "Ship chị 1 mực giã tay", "cho chị 2 kg đặt luôn", "ok", "Địa chỉ coi lại", "chị chưa đặt bao giờ, ship HN mấy ngày?", "sao không đặt được trên web em", "chị không đặt cọc đâu", "như chị nói rồi, ship nhanh nha"]) {
    assert.equal(itemObjectionCue(t, labels), false, `«${t}» không phải phản đối món`);
  }
  assert.equal(itemObjectionCue("Kg có order chả cá thu nha", []), false, "giỏ trống ⇒ không có món để phản đối");

  // Ca ThuyNgo qua bộ đếm: lần 1 ⇒ AI sửa giỏ; lần 2 ⇒ chuyển người.
  const at = (m: number) => new Date(Date.now() - (60 - m) * 60_000);
  let tally = nextObjectionTally(undefined, { objectionNow: itemObjectionCue("Kg có order chả cá thu nha", labels), cycle: 0, now: at(1), resumedAt: null });
  assert.equal(tally?.n, 1);
  assert.equal(customerHandoffVerdict({ text: "Kg có order chả cá thu nha", objections: tally?.n ?? 0, objectionNow: true }), null, "một lần phản đối ⇒ AI sửa giỏ");
  tally = nextObjectionTally(tally, { objectionNow: false, cycle: 0, now: at(2), resumedAt: null });
  assert.equal(tally?.n, 1, "«Chị order mực» không đổi bộ đếm");
  tally = nextObjectionTally(tally, { objectionNow: itemObjectionCue("Sao kg coi ở trên", ["Chả mực giã tay"]), cycle: 0, now: at(3), resumedAt: null });
  assert.equal(customerHandoffVerdict({ text: "Sao kg coi ở trên", objections: tally?.n ?? 0, objectionNow: true })?.reason, CUSTOMER_HANDOFF_REASON.REPEATED_OBJECTION, "phản đối lần 2 ⇒ chuyển người");
  // Người trả lại cho AI SAU lần phản đối trước ⇒ đếm lại từ đầu; sang lượt mua khác ⇒ đếm lại.
  assert.equal(nextObjectionTally(tally, { objectionNow: true, cycle: 0, now: at(10), resumedAt: at(5) })?.n, 1, "sau khi trả lại cho AI ⇒ đếm từ 1");
  assert.equal(nextObjectionTally(tally, { objectionNow: true, cycle: 7, now: at(10), resumedAt: null })?.n, 1, "lượt mua mới ⇒ đếm từ 1");
  assert.equal(customerHandoffVerdict({ text: "ok em", objections: 3, objectionNow: false }), null, "tin không phản đối ⇒ không chuyển");
  const r = customerHandoffVerdict({ text: "Robot hả", objections: 0, objectionNow: false });
  assert.equal(r?.reason, CUSTOMER_HANDOFF_REASON.WANTS_HUMAN);
  assert.equal(r?.code, "WANTS_HUMAN");
  // Công tắc của chủ shop «chuyển khi khách muốn gặp người» TẮT ⇒ vế đòi người không chạy; phản đối lặp vẫn chuyển.
  assert.equal(customerHandoffVerdict({ text: "Robot hả", objections: 0, objectionNow: false, onCustomerRequest: false }), null);
  assert.equal(customerHandoffVerdict({ text: "Sao kg coi ở trên", objections: 2, objectionNow: true, onCustomerRequest: false })?.code, "REPEATED_OBJECTION");
  // Nhóm thống kê đúng (events-shared::classifyHandoffReason).
  assert.equal(classifyHandoffReason(CUSTOMER_HANDOFF_REASON.WANTS_HUMAN), "CUSTOMER_REQUEST");
  assert.equal(classifyHandoffReason(CUSTOMER_HANDOFF_REASON.REPEATED_OBJECTION), "PRODUCT_UNCLEAR");
  // Lý do chuyển người KHÔNG nằm trong tập tự hết hạn ⇒ AI không tự quay lại dù đã qua rất lâu (chỉ người trả lại).
  for (const reason of Object.values(CUSTOMER_HANDOFF_REASON)) {
    const longAgo = new Date(Date.now() - 7 * 24 * 3600_000);
    const hold = aiHoldOf({ status: "HANDOFF", handoffReason: reason, state: { handoff: { reason, at: longAgo.toISOString() } }, updatedAt: longAgo, humanCooldownUntil: null }, new Date());
    assert.equal(hold.state, "HUMAN_TAKEOVER", `«${reason}» ⇒ chờ người, không tự hết hạn`);
    assert.equal(hold.expired, null);
  }
}

function testReviewRound2() {
  // (1) Số trần phải khớp TRỌN dãy chữ ngay sau nó.
  const cat2 = [...CAT, "Chả trứng (500g)"];
  const t1 = "Ship chị 1 mực giã tay, 5 ngõ Huế, quận Hai Bà Trưng";
  assert.deepEqual(amountsIn(t1, cat2).map((a) => a.label), ["cha muc gia tay"], "không có chả trứng từ «Hai Bà Trưng»");
  assert.deepEqual(amountsIn("nhà chị 2 đứa nhỏ thích mực lắm", cat2), [], "«2 đứa nhỏ thích mực» không phải món");
  assert.deepEqual(amountsIn("cho chị 1 nem chua", cat2), [], "«nem chua» không phải nem hải sản");
  // Địa chỉ không phải số lượng: «230/20 Phan Huy Ích», «12 Lò Đúc».
  assert.deepEqual(amountsIn("lay 1 goi ruoc tom\n230/20 Phan Huy Ích, P An Hội Tây, TP.HCM", CAT).map((a) => a.label), ["ruoc tom"]);
  assert.deepEqual(amountsIn("giao số 12 Lò Đúc nha", CAT), []);
  assert.deepEqual(amountsIn("cho chị 2 hộp nem", CAT).map((a) => a.value), [2], "đơn vị thường vẫn đọc");
  // Khách gõ hoa đầu từ: dãy hoa KHỚP TRỌN tên danh mục ⇒ vẫn là số lượng.
  assert.deepEqual(amountsIn("Lấy 2 Gói Chả Mực", CAT).map((a) => [a.value, a.label]), [[2, "cha muc gia tay"]]);
  assert.deepEqual(amountsIn("Cho Chị 2 Hộp Nem", CAT).map((a) => [a.value, a.label]), [[2, "nem hai san tom be be"]]);
  assert.deepEqual(amountsIn("Ship Chị 1 Mực Giã Tay", CAT).map((a) => [a.value, a.label]), [[1, "cha muc gia tay"]]);
  // Số trần + dãy hoa + «, <đơn vị hành chính>» ⇒ ĐỊA CHỈ, kể cả khi trùng tên món.
  assert.deepEqual(amountsIn("12 Chả Cá, Hoàn Kiếm", CAT), [], "«12 Chả Cá, Hoàn Kiếm» không thành 12 món");
  assert.deepEqual(amountsIn("giao 5 Chả Cá, Phường Hoàn Kiếm nha", CAT), []);
  assert.deepEqual(amountsIn("Ship Chị 1 Mực Giã Tay, Thủy Ngô 0961000855", CAT).map((a) => a.value), [1], "dấu phẩy + tên người không phải địa chỉ");
  // (5) Giỏ đã có món; số đứng trước KHÔNG tên là chuyện kể ⇒ chỉ THÊM, món cũ giữ nguyên.
  const base = applyCustomerCartMessage(undefined, "cho chị 1kg chả mực giã tay", 1, NOW(), { catalog: CAT });
  const out = applyCustomerCartMessage(base, "hôm qua chị lấy 2 gói rồi, thêm 1 hộp nem nữa", 2, NOW(), { catalog: CAT });
  assert.deepEqual(names(out), [["Chả mực giã tay", 1000, "g", true], ["Nem hải sản tôm bề bề", 1, "pack", true]], "chả mực giữ nguyên 1kg, thêm 1 hộp nem");
  // (6) «1 chả cá thu 2kg» = 2kg, không hỏi lại.
  for (const [t, g] of [["cho chị 1 chả cá thu 2kg", 2000], ["lấy 2 chả mực giã tay 1kg nha", 2000]] as const) {
    const c = applyCustomerCartMessage(undefined, t, 1, NOW(), { catalog: CAT });
    assert.equal(c?.clarify ?? null, null, `«${t}» không hỏi lại`);
    assert.deepEqual(c?.selectedItems.map((x) => [x.quantity, x.unit]), [[g, "g"]], `«${t}» ⇒ ${g}g`);
  }
  // (7) Còn món KHÔNG tên ⇒ NEED_ITEMS kèm chỉ dẫn, không ORDER_READY trần.
  const mixed = applyCustomerCartMessage(undefined, "Cho chị 2 gói, thêm 1 ruốc tôm.", 1, NOW(), { catalog: CAT });
  const r = orderReadiness({ cart: mixed, customer: { phone: "0961000855", address: ADDR, province: "Thành phố Hà Nội" }, blocker: null, lastUserText: "", hesitating: false });
  assert.equal(r.level, "NEED_ITEMS");
  assert.match(r.missing ?? "", /không nêu tên món/);
}

// ─────────────── Golden qua chatTurn THẬT (model giả, PGlite, công cụ thật — không gửi tin thật) ───────────────

async function seedCct(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (ctx.ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const r = await createProductCore(admin, { name: "Chả cá thu", code: "CCT", unit: "gói", retailPrice: 280_000, cost: null, variants: [{ sku: "CCT-1KG", size: "1kg", color: "", retailPrice: 280_000, cost: null, selling: true }] });
  assert.ok(r.ok, JSON.stringify(r));
  const db = await getDb();
  const vs = await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id));
  for (const v of vs) (ctx.ids as Map<string, string>).set(v.sku, v.id);
}

async function orderOf(conversationId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  const state = (row.state ?? {}) as ChatState;
  const orderId = state.confirmed?.orderId ?? state.draft?.orderId ?? null;
  const items = orderId ? await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)) : [];
  const [o] = orderId ? await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)) : [];
  return { state, order: o ?? null, items };
}

const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const CFG = { sellWithoutStockCheck: true, shippingFee: 30_000 };

const GOLDEN: GoldenCase[] = [
  {
    key: "gc-855-chi-muc",
    title: "#855: «Ship chị 1 mực giã tay» ⇒ model cố lên cá + mực bị từ chối, đơn đúng 1 chả mực 400.000 ₫; «kg có order chả cá» không đổi đơn",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Ship chị 1 mực giã tay, ThuyNgo 0961000855, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "ThuyNgo", phone: "0961000855", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          () => [say("Dạ em lên 1kg chả mực giã tay cho chị ạ.")],
        ],
      },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ đơn mình chỉ có chả mực giã tay ạ.")]] },
    ],
  },
  {
    key: "gc-855-hai-sku-sua",
    title: "#855: hai SKU + sửa số lượng ⇒ đơn 2kg cá + 1 mực, tổng = báo giá máy chủ",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Cho chị 1kg chả cá thu với 1 mực giã tay, Lan 0961000856, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Lan", phone: "0961000856", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          () => [say("Dạ em lên đơn cho chị ạ.")],
        ],
      },
      {
        say: "đổi chả cá thu thành 2kg",
        ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 2 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em sửa thành 2kg chả cá thu và 1kg chả mực ạ.")]],
      },
    ],
  },
];

async function testGolden() {
  const seen = new Set<string>();
  await runGoldenCases(GOLDEN, {
    orgSuffix: "-p855",
    beforeCase: async (_c, ctx) => seedCct(ctx),
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const { state, order, items } = await orderOf(ctx.conversationId);
      assert.ok(order, `[${c.key}] có đơn`);
      const qty = (sku: string) => items.filter((i) => i.variantId === ctx.ids.get(sku)).reduce((s, i) => s + i.quantity, 0);
      assert.notEqual(t.final.status, "HANDOFF", `[${c.key}] không chuyển người`);
      if (c.key === "gc-855-chi-muc") {
        const r1 = JSON.stringify(t.turns[0].rounds.map((r) => r.results));
        assert.match(r1, /KHÔNG đưa «Chả cá thu» vào đơn/, `máy chủ từ chối cá: ${r1.slice(0, 500)}`);
        assert.equal(qty("CCT-1KG"), 0, "0 SKU tự thêm");
        assert.equal(qty("CHA-MUC"), 1, "đúng 1 chả mực");
        assert.equal(order.totalPriceAfterDiscount, 400_000, "tiền hàng = giá máy chủ 1 chả mực");
        assert.equal(state.quote?.subtotal, 400_000, "báo giá máy chủ khớp đơn");
        assert.deepEqual(state.cart?.selectedItems.filter((x) => x.customerExplicit).map((x) => x.label), ["Chả mực giã tay"]);
        return;
      }
      assert.equal(qty("CCT-1KG"), 2, "2kg chả cá thu");
      assert.equal(qty("CHA-MUC"), 1, "1 chả mực");
      assert.equal(order.totalPriceAfterDiscount, 2 * 280_000 + 400_000, "tổng = báo giá máy chủ");
      assert.equal(state.quote?.subtotal, order.totalPriceAfterDiscount);
    },
  });
  assert.deepEqual([...seen].sort(), GOLDEN.map((c) => c.key).sort());
}

/** Chuyển người theo CHỮ KHÁCH qua `chatTurn` thật trên kênh NHẮN TIN (FANPAGE — chuyển người thì bot im). */
const ASK = "Dạ mình lấy 1kg chả mực giã tay ạ, cho em xin SĐT và địa chỉ nhé.";
const ASK2 = "Dạ mình lấy 1kg chả cá thu và 1kg chả mực giã tay ạ, cho em xin SĐT và địa chỉ nhé.";
const HANDOFF_GOLDEN: GoldenCase[] = [
  {
    key: "gc-855-robot-ha",
    title: "#855: «Robot hả» ⇒ máy chủ chuyển người MỘT lần, không gọi model, không gửi tin; tin sau vẫn im",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      { say: "Ship chị 1 mực giã tay", ai: [() => [say(ASK)]] },
      { say: "Robot hả", ai: [] },
      { say: "alo", ai: [] },
    ],
  },
  {
    key: "gc-855-phan-doi-lap",
    title: "#855: phản đối món lần 1 (gọi tên món trong giỏ) ⇒ AI vẫn sửa; lần 2 ⇒ chuyển người, không thêm câu xin lỗi",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      { say: "Cho chị 1kg chả cá thu với 1 mực giã tay", ai: [() => [say(ASK2)]] },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ đơn mình chỉ có 1kg chả mực giã tay ạ.")]] },
      { say: "Sao kg coi ở trên", ai: [] },
    ],
  },
  {
    key: "gc-855-thuyngo-chuoi-that",
    title: "#855 chuỗi ThuyNgo: chỉ đặt mực (cá bị từ chối) → «Kg có order chả cá» → «Chị order mực» → «Sao kg coi ở trên» (phản đối 1) → «Khách cũ mà hỏi gì» (phản đối 2 ⇒ chuyển người)",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      {
        say: `Ship chị 1 mực giã tay, ThuyNgo 0961000857, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "ThuyNgo", phone: "0961000857", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          () => [say(ASK)],
        ],
      },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ đơn mình chỉ có 1kg chả mực giã tay ạ.")]] },
      { say: "Chị order mực", ai: [() => [say("Dạ em giữ 1kg chả mực giã tay cho chị ạ.")]] },
      { say: "Sao kg coi ở trên", ai: [() => [say("Dạ em đã ghi 1kg chả mực giã tay ạ.")]] },
      { say: "Khách cũ mà hỏi gì", ai: [] },
    ],
  },
  {
    key: "gc-855-robot-cong-tac-tat",
    title: "#855: chủ shop TẮT «chuyển khi khách muốn gặp người» ⇒ «Robot hả» vẫn do AI trả lời, không chuyển người",
    shop: "food",
    channel: "FANPAGE",
    config: { ...CFG, handoff: { onCustomerRequest: false, onComplaint: true, message: "Em đã chuyển cho nhân viên, anh/chị đợi một chút nhé.", notifyGroup: false } },
    turns: [{ say: "Robot hả", ai: [() => [say("Dạ em là trợ lý bán hàng của shop, chị cần em hỗ trợ gì ạ?")]] }],
  },
];

async function testHandoffGolden() {
  const seen = new Set<string>();
  await runGoldenCases(HANDOFF_GOLDEN, {
    orgSuffix: "-p855h",
    beforeCase: async (_c, ctx) => seedCct(ctx),
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      if (c.key === "gc-855-thuyngo-chuoi-that") {
        const r1 = JSON.stringify(t.turns[0].rounds.map((r) => r.results));
        assert.match(r1, /KHÔNG đưa «Chả cá thu» vào đơn/, "máy chủ từ chối cá ở tin đầu");
        assert.deepEqual(t.turns.slice(0, 4).map((x) => x.status), ["OPEN", "OPEN", "OPEN", "OPEN"], "4 tin đầu AI vẫn xử lý («kg có order chả cá» không phải phản đối món — giỏ không có cá)");
        assert.equal(t.turns[4].status, "HANDOFF", "«Khách cũ mà hỏi gì» = phản đối lần 2 ⇒ chuyển người");
        assert.equal(t.turns[4].rounds.length, 0, "không gọi model");
        assert.deepEqual(t.turns[4].shown, [], "không thêm câu xin lỗi");
        assert.equal(t.final.handoffReason, CUSTOMER_HANDOFF_REASON.REPEATED_OBJECTION);
        const { items, order } = await orderOf(ctx.conversationId);
        assert.equal(items.filter((i) => i.variantId === ctx.ids.get("CCT-1KG")).length, 0, "0 SKU tự thêm");
        assert.equal(order?.totalPriceAfterDiscount, 400_000, "đơn đúng 1 chả mực 400.000 ₫");
        return;
      }
      if (c.key === "gc-855-robot-cong-tac-tat") {
        assert.equal(t.final.status, "OPEN", "công tắc tắt ⇒ không chuyển người");
        assert.equal(t.turns[0].shown.length, 1, "AI trả lời");
        return;
      }
      assert.equal(t.turns[0].status, "OPEN", `[${c.key}] lượt đặt hàng AI trả lời`);
      assert.deepEqual(t.turns[0].shown, [c.key === "gc-855-robot-ha" ? ASK : ASK2]);
      const db = await getDb();
      const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      if (c.key === "gc-855-robot-ha") {
        assert.equal(t.turns[1].status, "HANDOFF", "«Robot hả» ⇒ chuyển người");
        assert.equal(t.turns[1].rounds.length, 0, "không gọi model");
        assert.deepEqual(t.turns[1].shown, [], "kênh nhắn tin: không gửi tin nào");
        assert.deepEqual(t.turns[2].shown, [], "tin sau vẫn im");
        assert.equal(t.turns[2].rounds.length, 0);
        assert.equal(t.final.handoffReason, CUSTOMER_HANDOFF_REASON.WANTS_HUMAN);
        assert.equal(row.handoffReason, CUSTOMER_HANDOFF_REASON.WANTS_HUMAN, "lý do không bị lượt sau đè");
        return;
      }
      assert.equal(t.turns[1].status, "OPEN", "phản đối lần 1 ⇒ AI vẫn xử lý");
      assert.equal(t.turns[1].shown.length, 1);
      assert.equal(t.turns[2].status, "HANDOFF", "phản đối lần 2 ⇒ chuyển người");
      assert.equal(t.turns[2].rounds.length, 0, "không gọi model");
      assert.deepEqual(t.turns[2].shown, [], "không thêm câu xin lỗi");
      assert.equal(t.final.handoffReason, CUSTOMER_HANDOFF_REASON.REPEATED_OBJECTION);
    },
  });
  assert.deepEqual([...seen].sort(), HANDOFF_GOLDEN.map((c) => c.key).sort());
}

export async function testP0855Cart() {
  testRootCause();
  testBareNumberGuards();
  testDenyAndEdit();
  testHandoffSignals();
  testReviewRound2();
  await testGolden();
  await testHandoffGolden();
  console.log("  ✓ P0 #855 (ThuyNgo): «1 mực giã tay» ⇒ giỏ 1 chả mực, đơn cá + mực bị máy chủ từ chối (0 SKU tự thêm, tiền = báo giá máy chủ); «kg có order chả cá» bỏ cá giữ mực; «2 kg đặt» không phải phủ định; «Robot hả» / phản đối lặp ⇒ chuyển người không tự hết hạn");
}

if (process.argv[1] && /p0-855-cart.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0855Cart)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

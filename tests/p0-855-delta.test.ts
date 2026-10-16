/**
 * P0 #855 — phần CÒN LẠI sau #860 (giỏ) và #861 (địa chỉ), hội thoại thật «ThuyNgo» (đã che tên / SĐT / địa chỉ):
 *
 *  · Khách «Ship chị 1 mực giã tay» mà THẤY 680.000 ₫ cho «1kg chả cá thu + 1kg chả mực» — calculate_cart không qua kiểm căn cứ, báo giá vừa
 *    tính được hàng rào số tiền coi là tổng hiện tại. Nay: giỏ có món khách chưa gọi tên ⇒ không tính, tổng vào sổ «đã từ chối», chữ bot
 *    mang tổng đó bị chặn + người.
 *  · Khách phủ nhận ĐÚNG món bot đưa ra («Kg có order chả cá thu nha») ⇒ người ngay lần đầu; món đã vào đơn nháp ⇒ cờ UPSELL_UNCONSENTED,
 *    tuyến giao giữ ORDER_REVIEW. Từ chối lời mời («không đặt thêm gì nữa», «không đặt cọc») KHÔNG phải (review độc lập PR #862).
 *  · Khối KHÁCH CŨ của lời nhắc: món đơn cũ là LỊCH SỬ; bỏ «trả lời tiếp về món ⇒ dùng địa chỉ cũ».
 *  · create_customer ghi địa chỉ cũ đè địa chỉ khách gõ MỚI HƠN ⇒ từ chối (cùng `deliveryAddressDecision` của #861).
 *  · Model gửi lại đúng câu xin lỗi / xin xác nhận vừa gửi ⇒ bỏ câu lặp, chỉ còn câu lặp ⇒ người.
 *  · Lượt mua mới xoá báo giá + sổ tổng bị từ chối của lượt mua trước.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { orderReviewOf, reviewCodes } from "@/lib/constants/order-review";
import { createProductCore } from "@/lib/records/product-create";
import { botProposedDenial, buyingText, deniedItemLabel, mentionText, unrequestedProducts, type AskedLine, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { CLAIM_SAFE_TEXT, guardClaims } from "@/lib/sales-chatbot/claim-guard";
import { CUSTOMER_HANDOFF_REASON, customerHandoffVerdict } from "@/lib/sales-chatbot/handoff-routing-shared";
import { classifyHandoffReason } from "@/lib/sales-chatbot/events-shared";
import { appendContextMessages } from "@/lib/sales-chatbot/engine";
import { returningCustomerPrompt, type ReturningCustomer } from "@/lib/sales-chatbot/returning";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { decideShippingRoute, orderReviewOpenOf, type RouteOrderInput } from "@/lib/shipping/route";
import { seedReturningThread } from "./sales-agent-golden/cases";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx, type GoldenTranscript } from "./sales-agent-golden/harness";

const CA = "Chả cá thu (1kg)";
const MUC = "Chả mực giã tay (1kg)";
const line = (productId: string, name: string, quantity = 1): AskedLine => ({ variantId: `v-${productId}`, productId, name, quantity, weightGrams: 1000 });
const MUC_CART: CartCommitment = { selectedItems: [{ label: "Chả mực giã tay", match: "cha muc gia tay", productId: "p-muc", variantId: "v", sku: null, quantity: 1000, unit: "g", sourceMessageId: 1, confidence: "HIGH", customerExplicit: true }], turn: 1, at: new Date().toISOString() };

// ═══ PHẦN THUẦN ═══

function testQuoteBasis() {
  // Câu phủ nhận không phải chữ mua, cũng không phải căn cứ tính giỏ; câu hỏi giá VẪN là căn cứ tính giá món đó.
  for (const t of ["Kg có order chả cá thu nha", "Không có order chả cá thu nha", "Ko order chả cá thu"]) {
    assert.equal(buyingText([t]), "", `«${t}» không phải chữ mua`);
    assert.equal(mentionText([t]), "", `«${t}» không phải căn cứ tính giỏ`);
  }
  assert.match(mentionText(["chả cá thu bao nhiêu em?"]), /chả cá thu/);
  assert.equal(buyingText(["chả cá thu bao nhiêu em?"]), "");
  // Báo giá (calculate_cart) đi cùng `unrequestedProducts` với chữ của `mentionText`: món đơn cũ khách không gọi tên ⇒ món lạ.
  const asked = [line("p-ca", CA), line("p-muc", MUC)];
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["Ship chị 1 mực giã tay"])), ["Chả cá thu"]);
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["Ship chị 1 mực giã tay", "Kg có order chả cá thu nha"])), ["Chả cá thu"], "phủ nhận không mở căn cứ");
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["chả cá thu với chả mực giã tay bao nhiêu em?"])), [], "khách hỏi giá cả hai ⇒ tính được");
  console.log("  ✓ #855 báo giá có căn cứ: phủ nhận không phải chữ mua / căn cứ tính giỏ · câu hỏi giá vẫn là căn cứ tính giá · món đơn cũ là món lạ");
}

function testClaim() {
  const facts = { paymentVerified: false, orderConfirmed: false, orderCancelled: false, allowedAmounts: new Set([0, 280_000, 400_000, 680_000]) };
  assert.equal(guardClaims("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ", facts).ok, true, "trước bản vá: 680k nằm trong tập tham chiếu nên lọt");
  const v = guardClaims("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ", { ...facts, rejected: new Set([680_000]) });
  assert.ok(!v.ok && v.claim === "PRICE_UNVERIFIED" && v.handoff && v.safeText === CLAIM_SAFE_TEXT.PRICE, JSON.stringify(v));
  assert.equal(guardClaims("Dạ tổng 400.000 ₫ ạ", { ...facts, rejected: new Set([680_000]) }).ok, true, "số khác không bị chặn");
  assert.equal(guardClaims("Dạ 680.000 ₫ ạ", { ...facts, rejected: new Set([680_000]), totals: { allowed: new Set([680_000]), current: { total: 680_000, shipping: null }, stale: false } }).ok, true, "khách thật sự đặt cả hai ⇒ tổng hợp lệ");
  assert.equal(guardClaims("Dạ chả cá thu 280.000 ₫ một kg ạ", { ...facts, rejected: new Set([280_000]), unitPrices: new Set([280_000]) }).ok, true, "giá một đơn vị vẫn nói được");
  console.log("  ✓ #855 tiền: tổng của giỏ máy chủ đã từ chối luôn bị chặn + người, kể cả khi chưa có báo giá để so");
}

function testDenial() {
  const offered = ["Dạ lần này em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?"];
  assert.deepEqual(botProposedDenial("Kg có order chả cá thu nha", undefined, offered, false), { what: "cha ca thu", inDraft: false });
  assert.equal(botProposedDenial("Kg có order chả cá thu nha", MUC_CART, [], true), null, "món chưa ai đưa ra ⇒ không phải mâu thuẫn");
  const both: CartCommitment = { ...MUC_CART, selectedItems: [...MUC_CART.selectedItems, { ...MUC_CART.selectedItems[0], label: "Chả cá thu", match: "cha ca thu", productId: "p-ca", customerExplicit: false }] };
  assert.deepEqual(botProposedDenial("Không có order chả cá thu nha", both, [], true), { what: "Chả cá thu", inDraft: true }, "món bot tự thêm vào đơn nháp ⇒ cờ đơn");
  // Món KHÁCH tự nói tường minh rồi phủ nhận ⇒ không phải «bot tự thêm» (bộ đếm phản đối của #860 lo, lần 2 mới chuyển người).
  const own: CartCommitment = { ...both, selectedItems: both.selectedItems.map((x) => ({ ...x, customerExplicit: true })) };
  assert.equal(botProposedDenial("Không có order chả cá thu nha", own, ["Dạ mình lấy 1kg chả cá thu và 1kg chả mực giã tay ạ"], true), null);
  // Review độc lập PR #862 (blocker): từ chối lời mời / câu thường có «không đặt / order» KHÔNG phải phủ nhận món.
  const summary = ["Tóm tắt: 1kg chả mực giã tay 400.000 ₫. Mình lấy thêm gì không ạ?"];
  for (const t of ["thôi không đặt thêm gì nữa em", "không order thêm đâu em", "k order thêm nha", "chị không đặt cọc đâu, ship COD nhé", "không đặt nhiều đâu, 1kg thôi", "không đặt trước được hả em", "sao k đặt được vậy em", "ko đặt ship nhanh nha"]) {
    assert.equal(deniedItemLabel(t), null, `«${t}» không phủ nhận món nào`);
    assert.equal(botProposedDenial(t, MUC_CART, summary, true), null, `«${t}» không chuyển người`);
    assert.equal(customerHandoffVerdict({ text: t, objections: 0, objectionNow: false, deniedBotItem: botProposedDenial(t, MUC_CART, summary, true) !== null }), null, `«${t}»`);
  }
  const v = customerHandoffVerdict({ text: "Kg có order chả cá thu nha", objections: 1, objectionNow: true, deniedBotItem: true });
  assert.equal(v?.code, "DENIED_BOT_ITEM", "phủ nhận món bot đưa ra ⇒ người ngay LẦN ĐẦU");
  assert.equal(classifyHandoffReason(CUSTOMER_HANDOFF_REASON.DENIED_BOT_ITEM), "PRODUCT_UNCLEAR");
  console.log("  ✓ #855 phủ nhận món bot đưa ra ⇒ người lần đầu (+ cờ khi món đã vào đơn nháp); «không đặt thêm / cọc / trước / được / nhiều / ship» KHÔNG phải");
}

function testShippingHold() {
  const base: RouteOrderInput = { isErp: true, stage: "CONFIRMED", province: "Thành phố Hà Nội", ward: "Phường Hoàn Kiếm", hasLiveShipment: false, weightGrams: 1000, confirmedAt: new Date(), updatedAt: new Date(), auto: null, addressReviewOpen: false, orderReviewOpen: false };
  const cfg = { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null, autoSince: null };
  for (const code of ["UPSELL_UNCONSENTED", "PRICE_DISPUTED", "PRICE_MISMATCH", "CUSTOMER_CANCELLED", "CANCEL_BLOCKED"]) {
    const raw = { review: { entries: [{ code, note: "x" }] } };
    assert.equal(orderReviewOpenOf(raw), true, code);
    const r = decideShippingRoute({ ...base, orderReviewOpen: orderReviewOpenOf(raw) }, cfg, new Set(), new Date());
    assert.ok(r.kind === "HOLD" && r.code === "ORDER_REVIEW", `${code}: ${JSON.stringify(r)}`);
  }
  assert.equal(orderReviewOpenOf({ review: { entries: [{ code: "ADDRESS_UNRESOLVED", note: "x" }] } }), false, "địa chỉ đi cờ ADDRESS_REVIEW của #861");
  assert.equal(orderReviewOpenOf({ review: null }), false, "người đã gỡ cờ");
  assert.equal(orderReviewOpenOf({}), false);
  assert.deepEqual(decideShippingRoute({ ...base, orderReviewOpen: true, hasLiveShipment: true }, cfg, new Set(), new Date()), { kind: "SHIPPED" }, "đã có vận đơn thì vẫn là đã đi");
  console.log("  ✓ #855 tuyến giao: cờ món chưa đồng ý / giá / khách huỷ ⇒ giữ ORDER_REVIEW (cùng bước xếp tuyến với ADDRESS_REVIEW của #861)");
}

function testReturningPrompt() {
  const r: ReturningCustomer = { repeat: true, trust: "FB_ID", customerId: "c", name: "Chị Thủy", phone: "0900000123", address: "Số 3 ngõ 5 Khương Đình", province: "Thành phố Hà Nội", orders: 2, lastOrderAt: new Date().toISOString(), lastItems: ["Chả cá thu (1kg) × 1"] };
  const p = returningCustomerPrompt(r, undefined);
  assert.match(p, /LỊCH SỬ — KHÔNG phải giỏ hiện tại/);
  assert.ok(!p.includes("trả lời tiếp về món"), "không còn đường «trả lời tiếp về món ⇒ dùng địa chỉ cũ»");
  assert.ok(!p.includes("lần này em gửi chị 1kg chả cá thu"), "ví dụ không mời món khác lần trước");
  assert.match(p, /MỚI NHẤT luôn thắng/);
  console.log("  ✓ #855 lời nhắc khách cũ: món đơn cũ là LỊCH SỬ, không dùng địa chỉ cũ chỉ vì khách trả lời về món");
}

// ═══ HỘI THOẠI VÀNG (chatTurn thật) ═══

const OLD_ADDR = "Số 3 ngõ 5 Khương Đình";
const NEW_ADDR = "12 Lê Văn Việt, phường Tăng Nhơn Phú, TP HCM";
const HN = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";

async function seedCa(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (ctx.ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const r = await createProductCore(admin, { name: "Chả cá thu", code: "CCT", unit: "gói", retailPrice: 280_000, cost: null, variants: [{ sku: "CCT-1KG", size: "1kg", color: "", retailPrice: 280_000, cost: null, selling: true }] });
  assert.ok(r.ok, JSON.stringify(r));
  const db = await getDb();
  const vs = await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id));
  for (const v of vs) (ctx.ids as Map<string, string>).set(v.sku, v.id);
}

const shownAll = (t: GoldenTranscript) => t.turns.flatMap((x) => x.shown).join("\n");
const resultsOf = (t: GoldenTranscript, turn: number) => JSON.stringify(t.turns[turn].rounds.map((r) => r.results));
const OLD_AT = () => new Date(Date.now() - 4 * 24 * 3_600_000).toISOString();

const CASES: GoldenCase[] = [
  {
    key: "p855d-bao-gia-mon-la",
    title: "ThuyNgo: «Ship chị 1 mực giã tay» — model tính giỏ thêm chả cá thu (đơn cũ) ⇒ máy chủ từ chối, câu «tổng 680.000 ₫» bị chặn + người",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855d-don-cu-1", threadId: "pg-vang_psid-p855d-1" }),
        say: "Ship chị 1 mực giã tay",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ, em gửi về địa chỉ cũ nhé?")]],
      },
    ],
  },
  {
    key: "p855d-tin-shop-khong-phai-khach",
    title: "Tin của SHOP nhắc chả cá thu KHÔNG phải lời khách: giỏ có chả cá bị từ chối, giỏ đúng 1kg chả mực 400.000 ₫",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => appendContextMessages(ctx.conversationId, [{ role: "assistant", text: "Chả cá thu 280k/kg, chả mực giã tay 400k/kg chị nhé" }]),
        say: "Ship chị 1 mực giã tay",
        ai: [
          ({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ results }) => [say(`Dạ 1kg chả mực giã tay ${String(results[0]?.subtotal_text)} ạ.`)],
        ],
      },
    ],
  },
  {
    key: "p855d-phu-nhan-lan-dau",
    title: "Bot mời «1kg chả cá thu + 1kg chả mực» → «Kg có order chả cá thu nha» ⇒ người NGAY lần đầu (không lượt AI) → «Robot hả» ⇒ bot im",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Ship chị 1 mực giã tay", ai: [() => [say("Dạ lần trước chị lấy chả cá thu, lần này em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?")]] },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ em xin lỗi ạ")]] },
      { say: "Robot hả", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
  {
    key: "p855d-phu-nhan-co-don-nhap",
    title: "«Như lần trước» ⇒ bot lên đơn 2 món của đơn cũ; khách phủ nhận món bot tự thêm ⇒ người + cờ UPSELL_UNCONSENTED, không tự chốt",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Ship chị như lần trước nhé, Ngọc 0977000888, ${HN}`,
        ai: [
          () => [tool("create_customer", { name: "Ngọc", phone: "0977000888", address: HN })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }, { variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 1 gói chả mực + 1 gói chả cá thu. Chị xác nhận giúp em nhé?")],
        ],
      },
      { say: "Không có order chả cá thu nha", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [tool("confirm_order", { customer_confirmation: "Không có order chả cá thu nha" })]] },
    ],
  },
  {
    key: "p855d-tu-choi-loi-moi",
    title: "Khách tự đổi số lượng rồi «thôi không đặt thêm gì nữa em» ⇒ KHÔNG chuyển người, không cờ (review PR #862)",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 1 gói chả mực giã tay, Hà 0977000901, ${HN}`,
        ai: [() => [tool("create_customer", { name: "Hà", phone: "0977000901", address: HN })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Tóm tắt: 1 gói chả mực. Mình lấy thêm gì không ạ?")]],
      },
      { say: "đổi 2 gói", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }] })], () => [say("Dạ em sửa 2 gói ạ.")]] },
      { say: "thôi không đặt thêm gì nữa em", ai: [() => [say("Dạ vâng ạ.")]] },
      { say: "chị không đặt cọc đâu, ship COD nhé", ai: [() => [say("Dạ shop giao COD ạ.")]] },
    ],
  },
  {
    key: "p855d-dia-chi-moi-thang-cu",
    title: "Khách cũ gõ địa chỉ MỚI ⇒ create_customer bằng địa chỉ cũ (Khương Đình) bị từ chối, ghi đúng chữ khách",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855d-don-cu-2", threadId: "pg-vang_psid-p855d-2" }),
        say: "Ship chị 1 chả mực giã tay",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ 1kg chả mực giã tay 400.000 ₫ ạ, em gửi về địa chỉ nào ạ?")]],
      },
      {
        say: `Giao về ${NEW_ADDR}, 0977000333`,
        ai: [
          () => [tool("create_customer", { name: "Thủy", phone: "0977000333", address: OLD_ADDR, province: "Hà Nội" })],
          () => [tool("create_customer", { name: "Thủy", phone: "0977000333", address: NEW_ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ results }) => [say(`Tóm tắt đơn: 1kg chả mực giã tay, tổng thu ${String(results[0]?.cod_total_text)}. Chị xác nhận giúp em nhé?`)],
        ],
      },
    ],
  },
  {
    key: "p855d-khong-lap-xin-loi",
    title: "Model gửi lại ĐÚNG câu xin lỗi + xin địa chỉ vừa gửi ⇒ câu lặp bị bỏ, chuyển người",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Ship chị 1 chả mực giã tay", ai: [() => [say("Dạ em xin lỗi, chị cho em xin địa chỉ nhận hàng ạ?")]] },
      { say: "chị gửi ở trên rồi", ai: [() => [say("Dạ em xin lỗi, chị cho em xin địa chỉ nhận hàng ạ?")]] },
    ],
  },
  {
    key: "p855d-luot-mua-moi-xoa-bao-gia",
    title: "Lượt mua mới (đơn chốt > 3 ngày) xoá báo giá + sổ tổng bị từ chối của lượt mua trước",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: async (ctx) => {
          const db = await getDb();
          const at = OLD_AT();
          const st: ChatState = { confirmed: { orderId: null, simulated: true, total: 400_000, at }, quote: { id: "q-cu", priceVersion: "pv", verified: true, subtotal: 680_000, total: 680_000, amounts: [680_000], reasons: [], at }, rejectedTotals: [680_000] };
          await db.update(schema.salesChatConversations).set({ state: st as Record<string, unknown> }).where(eq(schema.salesChatConversations.id, ctx.conversationId));
        },
        say: "chào shop",
        ai: [() => [say("Dạ em chào chị ạ.")]],
      },
    ],
  },
  {
    key: "p855d-khung-thu",
    title: "Khung THỬ (đường phát lại): phủ nhận món bot mời ⇒ chuyển người, không ghi khách / đơn thật",
    shop: "food",
    channel: "TEST",
    turns: [
      { say: "Ship chị 1 mực giã tay", ai: [() => [say("Dạ em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?")]] },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
];

async function testGolden() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-p855d",
    beforeCase: async (_c, ctx) => seedCa(ctx),
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const state = (row.state ?? {}) as ChatState;
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      assert.ok(orders.length <= 1, `[${c.key}] không đơn trùng`);
      assert.ok(!/680\.000/.test(shownAll(t)), `[${c.key}] khách không bao giờ thấy 680.000 ₫: ${shownAll(t)}`);
      switch (c.key) {
        case "p855d-bao-gia-mon-la":
          assert.match(resultsOf(t, 0), /KHÔNG tính giỏ có «Chả cá thu»/, resultsOf(t, 0));
          assert.ok(!state.quote || state.quote.subtotal !== 680_000, "báo giá 680k không được lưu");
          assert.ok(state.rejectedTotals?.includes(680_000), JSON.stringify(state.rejectedTotals));
          assert.equal(t.final.status, "HANDOFF", "câu tổng sai ⇒ người");
          assert.deepEqual(orders, []);
          return;
        case "p855d-tin-shop-khong-phai-khach":
          assert.match(JSON.stringify(t.turns[0].rounds[0].results), /KHÔNG tính giỏ có «Chả cá thu»/);
          assert.match(shownAll(t), /400\.000 ₫/);
          assert.equal(state.quote?.subtotal, 400_000);
          return;
        case "p855d-phu-nhan-lan-dau":
          assert.equal(t.turns[1].rounds.length, 0, "phủ nhận món ⇒ không lượt AI");
          assert.equal(t.turns[2].rounds.length, 0, "đã chuyển người ⇒ «Robot hả» không gọi model");
          assert.deepEqual(t.turns[2].shown, [], "không xin lỗi lặp");
          assert.equal(t.final.handoffReason, CUSTOMER_HANDOFF_REASON.DENIED_BOT_ITEM);
          return;
        case "p855d-phu-nhan-co-don-nhap":
          assert.equal(t.turns[1].rounds.length, 0);
          assert.equal(t.final.handoffReason, CUSTOMER_HANDOFF_REASON.DENIED_BOT_ITEM);
          assert.equal(t.final.confirmed, null, "không tự chốt");
          assert.equal(orders.length, 1);
          assert.notEqual(orders[0].stage, "CONFIRMED");
          assert.ok(reviewCodes(orderReviewOf(orders[0].raw)).includes("UPSELL_UNCONSENTED"), JSON.stringify(orders[0].raw));
          assert.equal(orderReviewOpenOf(orders[0].raw), true, "tuyến giao giữ ORDER_REVIEW khi đơn được xác nhận");
          return;
        case "p855d-tu-choi-loi-moi":
          assert.notEqual(t.final.status, "HANDOFF", `từ chối lời mời / tự đổi số lượng không phải lý do chuyển người: ${t.final.handoffReason}`);
          assert.ok(t.turns.every((x) => x.rounds.length > 0), "mọi lượt đều được AI trả lời");
          assert.equal(orders.length, 1);
          assert.equal(orderReviewOpenOf(orders[0].raw), false, "không cờ món chưa đồng ý");
          return;
        case "p855d-dia-chi-moi-thang-cu":
          assert.match(resultsOf(t, 1), /KHÁC địa chỉ khách vừa gõ/, resultsOf(t, 1).slice(0, 600));
          assert.ok(!/hỏi khách xác nhận dùng lại/.test(resultsOf(t, 1)), "khách đã gõ địa chỉ mới ⇒ không bảo model hỏi dùng lại địa chỉ cũ");
          assert.match(t.final.customer?.address ?? "", /Lê Văn Việt/);
          assert.equal(orders.length, 1);
          assert.match(orders[0].shipAddress ?? "", /Lê Văn Việt/);
          return;
        case "p855d-khong-lap-xin-loi":
          assert.equal(t.turns[1].shown.filter((x) => /xin lỗi/.test(x)).length, 0, JSON.stringify(t.turns[1].shown));
          assert.equal(t.final.status, "HANDOFF");
          assert.match(t.final.handoffReason ?? "", /lặp lại câu xin lỗi/);
          return;
        case "p855d-luot-mua-moi-xoa-bao-gia":
          assert.notEqual(state.quote?.id, "q-cu", "báo giá lượt mua trước đã xoá");
          assert.equal(state.rejectedTotals, undefined);
          assert.equal(state.pastOrders?.length, 1);
          return;
        case "p855d-khung-thu": {
          assert.equal(t.turns[1].rounds.length, 0);
          assert.equal(t.final.status, "HANDOFF");
          assert.equal(t.final.order, null, "khung THỬ không tạo đơn");
          const customers = await db.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.phone, "0977000999")));
          assert.deepEqual(customers, []);
          return;
        }
      }
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
  console.log(`  ✓ #855 hội thoại vàng (phần còn lại): ${CASES.length} hội thoại qua chatTurn thật — 680.000 ₫ không tới khách, tin shop không phải lời khách, phủ nhận món bot mời ⇒ người lần đầu (+ cờ đơn nháp), từ chối lời mời không chuyển người, địa chỉ khách gõ mới nhất thắng ở create_customer, không lặp xin lỗi, lượt mua mới xoá báo giá cũ, khung THỬ không ghi`);
}

export async function testP0855Delta() {
  testQuoteBasis();
  testClaim();
  testDenial();
  testShippingHold();
  testReturningPrompt();
  await testGolden();
}

if (process.argv[1] && /p0-855-delta.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0855Delta)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

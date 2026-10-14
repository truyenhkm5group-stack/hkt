/**
 * P0 14/10/2026 (HSLC) — TỔNG TIỀN TRONG CHỮ BOT PHẢI LÀ TỔNG MÁY CHỦ CỦA GIỎ HIỆN TẠI · LƯỢT IM KHÔNG ĐƯỢC «NÓI RÕ HƠN».
 *
 * Ca «Châu Dương» (#91F3641C): shop báo 1kg 280.000 ₫ · 2kg 540.000 ₫, khách lấy 1kg, bot báo «TỔNG 640.000 ₫ + miễn ship». Hàng rào số
 * tiền chỉ hỏi «số này có thuộc tập được phép không» — tập gồm cả giá THAM CHIẾU của mọi mẫu mã × 1…10 gói — và chữ model viết CÙNG
 * tin với create_draft_order được kiểm theo trạng thái TRƯỚC khi công cụ chạy. Ca «Viet Nguyen Thi» (#899250E3): câu upsell → lên đơn →
 * model trả rỗng ⇒ engine chèn «Dạ, anh/chị nói rõ hơn giúp em nhé» dù khách đã gửi đủ món + SĐT + địa chỉ.
 *
 *  1. THUẦN: số «tổng» đọc đúng; tập tổng hợp lệ = revision giỏ / nháp / chốt (cũ khi giỏ đổi sau báo giá); tổng sai ⇒ câu nói lại tổng
 *     máy chủ (không chuyển người); câu mẫu / nhắn lại có tổng sai ⇒ bị chặn; món mời chưa được đồng ý; câu khi lượt im theo mức sẵn
 *     sàng; tóm tắt đơn theo kết quả công cụ; tin vọng lại.
 *  2. chatTurn THẬT + công cụ thật + PGlite (tổ chức `gd-food-q640`): 1kg ⇒ 280.000 + ship cấu hình; 2kg ⇒ 540.000; chữ «tổng 640.000»
 *     viết cùng tin với lệnh lên đơn ⇒ khách nhận đúng tổng máy chủ; upsell chưa đồng ý ⇒ không vào đơn / tổng; sửa số lượng ⇒ giá + đơn
 *     cập nhật, tổng cũ bị thay; model im sau khi lên đơn ⇒ tóm tắt máy chủ, không «nói rõ hơn»; tin vọng lại / tin trùng ⇒ không tin
 *     bot, không đơn thứ hai.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createProductCore } from "@/lib/records/product-create";
import { unrequestedProducts, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { claimFactsLoader, claimVerdict, CLAIM_SAFE_TEXT, extractVndAmounts, guardClaims, serverTotalText, totalAllowedOf, totalClaimsIn, type ClaimFacts } from "@/lib/sales-chatbot/claim-guard";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { draftSummaryFromTool, EMPTY_REPLY_TEXT, isEchoOfShop, silenceFallbackText } from "@/lib/sales-chatbot/engine";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import type { QuoteSnapshot } from "@/lib/sales-chatbot/quote-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const T0 = new Date();
const iso = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const quote = (subtotal: number, total: number | null, at = iso(0)): QuoteSnapshot => ({ id: "q", priceVersion: "p", verified: true, subtotal, total, amounts: [subtotal, ...(total !== null ? [total] : [])], reasons: [], at });
const BASE: ClaimFacts = { paymentVerified: false, orderConfirmed: false, orderCancelled: false };
const REFERENCE = new Set([0, 280_000, 540_000, 560_000, 640_000, 30_000]);

function testTotals() {
  assert.deepEqual(totalClaimsIn("Dạ em lên đơn 1kg chả cá thu 280.000đ. Tổng 640.000đ, miễn phí ship ạ"), [640_000]);
  assert.deepEqual(totalClaimsIn("Tiền hàng 280k + ship 30k = tổng 310k"), [310_000]);
  assert.deepEqual(totalClaimsIn("Tổng: 280k + 30k = 310.000 ₫"), [310_000], "«=» ⇒ số sau dấu bằng cuối");
  assert.deepEqual(totalClaimsIn("Tổng tiền hàng 280.000đ, phí ship báo sau"), [], "tổng tiền hàng là tiền hàng");
  assert.deepEqual(totalClaimsIn("1kg 280k, 2kg 540k ạ"), [], "bảng giá không phải tổng");
  assert.deepEqual(totalClaimsIn("Mình thanh toán khi nhận hàng nhé"), []);
  assert.deepEqual(totalClaimsIn("COD 310.000 ₫ · tổng cộng 310k"), [310_000]);
  assert.deepEqual(totalClaimsIn("TỔNG THANH TOÁN: 1.080.000 ₫"), [1_080_000]);

  // Tập tổng hợp lệ = revision giỏ / nháp / chốt.
  assert.equal(totalAllowedOf({}), undefined, "chưa có giỏ ⇒ không xét tổng riêng");
  const t1 = totalAllowedOf({ quote: quote(280_000, 310_000) })!;
  assert.deepEqual([[...t1.allowed], t1.current, t1.stale], [[310_000], { total: 310_000, shipping: 30_000 }, false]);
  const cart = (at: string, relaxedTurn: number | null = null): CartCommitment => ({ selectedItems: [], turn: 3, at, relaxedTurn });
  const stale = totalAllowedOf({ quote: quote(280_000, 310_000, iso(0)), cart: cart(iso(60_000)) })!;
  assert.ok(stale.stale && stale.allowed.size === 0 && stale.current === null, "khách đổi giỏ SAU báo giá ⇒ báo giá cũ");
  assert.equal(totalAllowedOf({ quote: quote(280_000, 310_000, iso(0)), cart: cart(iso(60_000), 4) })!.stale, false, "lượt «nới» (máy chưa chắc khách sửa) không làm cũ báo giá");
  assert.equal(totalAllowedOf({ quote: quote(280_000, 310_000, iso(0)), cart: cart(iso(0)) })!.stale, false, "cùng mốc (giỏ gắn khi lên đơn) không cũ");
  const unknownShip = totalAllowedOf({ quote: quote(280_000, null) })!;
  assert.deepEqual([[...unknownShip.allowed], unknownShip.current], [[280_000], { total: 280_000, shipping: "UNKNOWN" }]);
  assert.equal(serverTotalText({ total: 280_000, shipping: 0 }), "Dạ tổng đơn của mình là 280.000 ₫ (miễn phí ship) ạ.");
  assert.equal(serverTotalText({ total: 280_000, shipping: "UNKNOWN" }), "Dạ tiền hàng của mình là 280.000 ₫, phí ship nhân viên báo sau ạ.");

  // Ca «Châu Dương»: 640.000 thuộc tập THAM CHIẾU nên hàng rào cũ cho qua; tổng của giỏ 1kg là 280.000 (miễn ship).
  const facts: ClaimFacts = { ...BASE, allowedAmounts: new Set([...REFERENCE, 280_000]), totals: totalAllowedOf({ quote: quote(280_000, 280_000) }) };
  const old = claimVerdict([], { ...BASE, allowedAmounts: facts.allowedAmounts }, extractVndAmounts("Tổng 640.000đ, miễn phí ship ạ"));
  assert.equal(old.ok, true, "TÁI HIỆN: chỉ kiểm tập số ⇒ 640.000 lọt (thuộc tập tham chiếu)");
  const v = guardClaims("Dạ em lên đơn 1kg chả cá thu 280.000đ. Tổng 640.000đ, miễn phí ship ạ", facts);
  assert.ok(!v.ok && v.claim === "PRICE_UNVERIFIED" && !v.handoff, JSON.stringify(v));
  assert.equal(!v.ok && v.safeText, "Dạ tổng đơn của mình là 280.000 ₫ (miễn phí ship) ạ.");
  assert.ok(guardClaims("Dạ đơn 1kg chả cá thu, tổng 280.000đ, miễn phí ship ạ", facts).ok, "tổng đúng ⇒ qua");
  assert.ok(guardClaims("Dạ 1kg 280k, 2kg 540k ạ", facts).ok, "bảng giá (không phải tổng) ⇒ qua");
  assert.ok(guardClaims("Dạ mình nhận giúp em nhé", facts).ok, "tin thường không bị chặn");
  // Câu mẫu / nhắn lại có số tổng cố định ≠ báo giá ⇒ chặn (cùng một hàm cho mọi đường gửi).
  const q = guardClaims("Combo hôm nay tổng chỉ 540k, free ship ạ", facts);
  assert.ok(!q.ok && q.safeText === "Dạ tổng đơn của mình là 280.000 ₫ (miễn phí ship) ạ.", "câu mẫu có tổng cố định ≠ báo giá ⇒ thay bằng tổng máy chủ");
  // Báo giá đã cũ (khách đổi số lượng) ⇒ không có tổng nào để nói ⇒ chặn + chuyển người.
  const s = guardClaims("Tổng 280.000đ ạ", { ...facts, totals: stale });
  assert.ok(!s.ok && s.handoff && s.safeText === CLAIM_SAFE_TEXT.PRICE);
  // Chưa có giỏ: số «tổng» xét như mọi số tiền (tập tham chiếu) — không chặn bảng giá trước khi khách chọn.
  assert.ok(guardClaims("Combo 2kg tổng 540k ạ", { ...BASE, allowedAmounts: REFERENCE }).ok);
}

function testPureFlow() {
  const L = (productId: string, variantId: string, name: string) => ({ productId, variantId, name, quantity: 1, weightGrams: 1000 });
  const cart: CartCommitment = { selectedItems: [{ label: "chả cá thu", match: "cha ca thu", productId: null, variantId: null, sku: null, quantity: 1000, unit: "g", sourceMessageId: 1, confidence: "HIGH", customerExplicit: true }], turn: 1, at: iso(0) };
  assert.deepEqual(unrequestedProducts(cart, [L("p-cct", "v1", "Chả cá thu (1kg)")]), []);
  assert.deepEqual(unrequestedProducts(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-muc", "v2", "Chả mực giã tay (1kg)")]), ["Chả mực giã tay"], "món mời chưa được khách nói ⇒ bị chỉ ra");
  assert.deepEqual(unrequestedProducts(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-muc", "v2", "Chả mực giã tay (1kg)")], ["v2"]), [], "món đã có sẵn trong đơn nháp trước ⇒ không chặn");
  assert.deepEqual(unrequestedProducts(undefined, [L("p-muc", "v2", "Chả mực")]), [], "giỏ chưa có món khách nói ⇒ không đủ căn cứ chặn");
  const unnamed: CartCommitment = { ...cart, selectedItems: [{ ...cart.selectedItems[0], match: "", label: "" }] };
  assert.deepEqual(unrequestedProducts(unnamed, [L("p-cct", "v1", "Chả cá thu (1kg)")]), [], "«cho chị 1kg» không tên khớp được món đó");

  // Câu khi lượt im: theo mức sẵn sàng.
  const customer = { id: null, name: "K", phone: "0961004962", address: "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội", province: "Thành phố Hà Nội", simulated: false };
  assert.equal(silenceFallbackText({}, "hi", 1, false), EMPTY_REPLY_TEXT, "chưa có gì để bám ⇒ câu chung");
  assert.equal(silenceFallbackText({ cart }, "cho chị 1kg chả cá thu", 1, false), "Dạ mình cho em xin số điện thoại nhận hàng nhé.");
  assert.equal(silenceFallbackText({ cart, customer: { ...customer, address: "", province: "" } }, "ok", 1, false), "Dạ mình cho em xin địa chỉ nhận hàng đầy đủ (số nhà, đường, phường / xã, quận / huyện, tỉnh / thành) nhé.");
  assert.match(silenceFallbackText({ cart, customer }, "ok", 1, false), /^Dạ em lên đơn 1kg chả cá thu cho mình nhé/);
  const draft = { orderId: "erp-x", lines: [{ variantId: "v1", quantity: 1 }], unitPrices: { v1: 280_000 }, recipient: { name: "K", phone: customer.phone, address: customer.address, province: customer.province }, note: "", simulated: false, quote: { id: "q", priceVersion: "p", subtotal: 280_000, total: 310_000 } };
  const withDraft = silenceFallbackText({ cart, customer, draft }, "ok", 2, false, 1);
  assert.ok(withDraft === "Dạ đơn của mình tổng 310.000 ₫ ạ. Mình xác nhận giúp em để em gửi hàng nhé." || withDraft === EMPTY_REPLY_TEXT || /^Dạ mình cho em xin/.test(withDraft), withDraft);

  const summary = draftSummaryFromTool(JSON.stringify({ lines: [{ name: "Chả cá thu (1kg)", quantity: 1, unit_price: 280000, line_total: 280000 }], cod_total: 310000, cod_total_text: "310.000 ₫", shipping_text: "30.000 ₫" }));
  assert.equal(summary, "Dạ em tóm tắt đơn của mình: Chả cá thu (1kg) × 1 = 280.000 ₫ · 30.000 ₫. Tổng 310.000 ₫. Mình xác nhận giúp em để em gửi hàng nhé.");
  assert.equal(draftSummaryFromTool(JSON.stringify({ say_to_customer: "Dạ em đã lên đơn ạ." })), "Dạ em đã lên đơn ạ.", "câu của công cụ thắng");
  assert.equal(draftSummaryFromTool("x"), null);
  assert.ok(isEchoOfShop("Các món bán chạy của shop ạ: chả mực, ruốc", ["[Shop đã nhắn] Các món bán chạy của shop ạ: chả mực, ruốc"]));
  assert.ok(!isEchoOfShop("ok", ["ok"]), "câu ngắn của khách không bao giờ là vọng lại");
}

async function testLoader() {
  // Bộ đọc căn cứ dùng cho MỌI đường gửi (lượt AI · câu mẫu · nhắn lại): mang tập tổng của revision hiện tại.
  const st: ChatState = { quote: quote(280_000, 310_000) };
  const f = await claimFactsLoader({ id: "00000000-0000-4000-8000-000000000640", orderId: null, pageId: null, threadId: null })(st);
  assert.deepEqual([...(f.totals?.allowed ?? [])], [310_000]);
}

// ═══ chatTurn THẬT ═══

const CFG: Partial<SalesChatbotConfig> = { volumeDiscount: { enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "PER_STEP" }, sellWithoutStockCheck: true, shippingFee: 30_000 };
const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const UPSELL_TEXT = "Dạ shop còn các món bán chạy: chả mực giã tay, ruốc bông tôm — mình lấy thêm món nào không ạ?";

async function seed(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (!ctx.ids.has("CCT-1KG")) {
    const admin = await ctx.admin();
    const r = await createProductCore(admin, { name: "Chả cá thu", code: "CCT", unit: "gói", retailPrice: 280_000, cost: null, variants: [{ sku: "CCT-1KG", size: "1kg", color: "", retailPrice: 280_000, cost: null, selling: true }, { sku: "CCT-2KG", size: "2kg", color: "", retailPrice: 540_000, cost: null, selling: true }] });
    assert.ok(r.ok, JSON.stringify(r));
    const db = await getDb();
    for (const v of await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id))) (ctx.ids as Map<string, string>).set(v.sku, v.id);
  }
}

async function seedUpsell(): Promise<void> {
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  const [row] = (await db.select({ id: qr.id }).from(qr).where(eq(qr.title, "Các món bán chạy")).limit(1)) ?? [];
  const id = row?.id ?? (await db.insert(qr).values({ title: "Các món bán chạy", triggers: ["món bán chạy"], answer: UPSELL_TEXT, active: true }).returning({ id: qr.id }))[0].id;
  await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: id, autoLearn: false, autoActivate: false });
}

const CASES: GoldenCase[] = [
  {
    key: "q640-chau-duong",
    title: "Ca «Châu Dương»: khách lấy 1kg; model viết «Tổng 640.000đ, miễn phí ship» CÙNG tin với create_draft_order ⇒ khách nhận đúng tổng máy chủ 310.000 ₫",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Chị lấy 1kg chả cá thu nhé, Dương 0961003106, ${ADDR}`,
        ai: [() => [tool("create_customer", { name: "Dương", phone: "0961003106", address: ADDR })], ({ v }) => [say("Dạ đơn của mình 1kg chả cá thu. Tổng 640.000đ, miễn phí ship ạ"), tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => []],
      },
    ],
  },
  {
    key: "q640-2kg",
    title: "2kg ⇒ 540.000 ₫ (gói 2kg = 2 × 1kg − giảm) + ship 30.000 ₫; tổng đúng 570.000 ₫ đi qua nguyên văn",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Cho chị 2kg chả cá thu, Hà 0961003107, ${ADDR}`,
        ai: [() => [tool("create_customer", { name: "Hà", phone: "0961003107", address: ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })], () => [say("Dạ đơn 2kg chả cá thu 540.000 ₫ + ship 30.000 ₫, tổng 570.000 ₫. Mình xác nhận giúp em nhé.")]],
      },
    ],
  },
  {
    key: "q640-viet-nguyen",
    title: "Ca «Viet Nguyen Thi»: đủ món + SĐT + địa chỉ ⇒ máy chủ đòi mời thêm món ⇒ câu upsell ⇒ model cố thêm chả mực (khách chưa đồng ý) bị từ chối ⇒ lên đơn 1kg ⇒ model im ⇒ tóm tắt máy chủ, KHÔNG «nói rõ hơn»; tin vọng lại / tin trùng không sinh tin; khách nhận lời ⇒ thêm món, tổng mới; đổi số lượng ⇒ tổng cũ bị thay",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `1kg chả cá thu, Việt 0961004962, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Việt", phone: "0961004962", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [tool("send_quick_reply", { code: "Q1" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [],
        ],
      },
      // Chữ của chính shop vọng lại như tin khách ⇒ không ghi, không gọi AI, không gửi.
      { say: UPSELL_TEXT, ai: [() => [say("KHÔNG ĐƯỢC GỌI MODEL")]] },
      { say: "lấy thêm 1kg chả mực nhé", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ đơn mới của mình tổng 710.000 ₫ ạ.")]] },
      // Cùng tin, giao lại trong 2 phút ⇒ không trả lời lần hai, không đơn thứ hai.
      { say: "lấy thêm 1kg chả mực nhé", ai: [() => [say("KHÔNG ĐƯỢC GỌI MODEL")]] },
      { say: "đổi chả cá thành 2kg nhé", ai: [({ v }) => [say("Dạ em sửa rồi ạ, tổng vẫn 710.000 ₫ nhé"), tool("update_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => []] },
    ],
  },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-q640",
    beforeCase: async (c, ctx) => {
      await seed(ctx);
      if (c.key === "q640-viet-nguyen") await seedUpsell();
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      assert.equal(orders.length, 1, `[${c.key}] đúng MỘT đơn`);
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orders[0].id));
      const all = t.turns.flatMap((x) => x.shown);
      assert.ok(!all.includes(EMPTY_REPLY_TEXT), `[${c.key}] không câu «nói rõ hơn»: ${JSON.stringify(all)}`);
      if (c.key === "q640-chau-duong") {
        assert.equal(Number(orders[0].totalPriceAfterDiscount), 280_000, "đơn 1kg = 280.000 ₫");
        assert.equal(Number(orders[0].shippingFee), 30_000, "ship theo cấu hình");
        assert.ok(!all.some((s) => s.includes("640")), `tổng 640.000 KHÔNG tới khách: ${JSON.stringify(all)}`);
        assert.deepEqual(t.turns[0].shown, ["Dạ tổng đơn của mình là 310.000 ₫ (đã gồm 30.000 ₫ phí ship) ạ."], JSON.stringify(t.turns[0].shown));
        assert.notEqual(t.final.status, "HANDOFF", "nói lại đúng tổng máy chủ — không chuyển người");
        return;
      }
      if (c.key === "q640-2kg") {
        assert.equal(Number(orders[0].totalPriceAfterDiscount), 540_000, "gói 2kg = 540.000 ₫");
        assert.deepEqual(t.turns[0].shown, ["Dạ đơn 2kg chả cá thu 540.000 ₫ + ship 30.000 ₫, tổng 570.000 ₫. Mình xác nhận giúp em nhé."], "tổng đúng đi qua nguyên văn");
        return;
      }
      // Ca «Viet Nguyen Thi».
      const r1 = JSON.stringify(t.turns[0].rounds.map((r) => r.results));
      assert.match(r1, /chưa mời thêm món|mời thêm món ĐÚNG MỘT LẦN/, "máy chủ đòi mời thêm món trước khi lên đơn");
      assert.match(r1, /KHÔNG thêm «Chả mực giã tay» vào đơn: khách CHƯA trả lời lời mời/, `món mời chưa đồng ý bị từ chối: ${r1.slice(0, 600)}`);
      assert.equal(t.turns[0].shown[0], UPSELL_TEXT, "khách nhận câu upsell");
      assert.match(t.turns[0].shown[1] ?? "", /^Dạ em tóm tắt đơn của mình: Chả cá thu.* × 1 = 280\.000 ₫.*Tổng 310\.000 ₫/, `model im sau khi lên đơn ⇒ tóm tắt máy chủ: ${JSON.stringify(t.turns[0].shown)}`);
      assert.equal(t.turns[0].shown.length, 2, JSON.stringify(t.turns[0].shown));
      assert.deepEqual(t.turns[1].shown, [], "tin vọng lại ⇒ không tin bot");
      assert.equal(t.turns[1].rounds.length, 0, "tin vọng lại ⇒ không gọi model");
      assert.deepEqual(t.turns[2].shown, ["Dạ đơn mới của mình tổng 710.000 ₫ ạ."], "khách nhận lời ⇒ thêm món, tổng máy chủ 280k + 400k + ship 30k");
      assert.deepEqual([t.turns[3].shown, t.turns[3].rounds.length], [[], 0], "tin trùng giao lại ⇒ không trả lời lần hai");
      assert.deepEqual(t.turns[4].shown, ["Dạ tổng đơn của mình là 970.000 ₫ (đã gồm 30.000 ₫ phí ship) ạ."], `đổi số lượng ⇒ tổng cũ 710.000 bị thay bằng tổng mới: ${JSON.stringify(t.turns[4].shown)}`);
      assert.equal(Number(orders[0].totalPriceAfterDiscount), 940_000, "đơn cập nhật: 540.000 + 400.000");
      assert.equal(items.length, 2);
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
}

export async function testSalesQuote640() {
  testTotals();
  testPureFlow();
  await testLoader();
  await testChatTurn();
  console.log("  ✓ tổng tiền = tổng máy chủ của giỏ hiện tại (ca «Châu Dương» 640.000 ₫ cho 1kg 280.000 ₫): số «tổng» đọc đúng, tập tham chiếu không còn cho tổng sai lọt, chữ viết cùng tin với lệnh lên đơn kiểm SAU công cụ, câu mẫu / nhắn lại cùng hàm; upsell chưa đồng ý không vào đơn; sửa số lượng ⇒ tổng mới; lượt im ⇒ tóm tắt / hỏi đúng phần thiếu, không «nói rõ hơn» (ca «Viet Nguyen Thi»); tin vọng lại / tin trùng không sinh tin, không đơn thứ hai");
}

if (process.argv[1] && /sales-quote-640\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testSalesQuote640)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

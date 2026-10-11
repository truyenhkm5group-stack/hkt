/**
 * BÁO GIÁ MÁY CHỦ + HÀNG RÀO SỐ TIỀN + «ĐÃ LÊN ĐƠN» CHỈ KHI ĐƠN QUA KIỂM (P0 authoritative-quote, chủ shop 11/10/2026).
 *
 * Sự cố HSLC 10–11/10/2026: «2kg chả cá thu» có HAI biểu diễn trong danh mục — gói 2kg (540.000 ₫, ca KimThu Le #71B31FE3) và 2 × gói
 * 1kg (560.000 ₫, ca Nguyễn Thanh Thủy) — khách nghe 540k rồi 560k; bot nói «Đã lên đơn cho mình rồi ạ» khi đơn còn «CẦN XÁC THỰC»
 * (#463DEBAE — địa chỉ chưa ghép xã / phường).
 *
 *  1. Thuần: bộ trích số tiền (không bắt nhầm khối lượng / SĐT / ngày); báo giá máy chủ (quy gói, giảm theo khối lượng, mã tất định,
 *     catalog mâu thuẫn ⇒ chưa xác thực — tái hiện đúng 540 / 560); luật chọn gói khi luật giảm tắt; tập số tham chiếu; bảng chân lý
 *     số tiền; đơn qua kiểm; lõi đơn chỉ nhận tiền giảm do máy chủ tính.
 *  2. Tổ chức THẬT (PGlite, kênh WEB — đơn ghi thật): 2kg có giảm ⇒ báo giá = tổng đơn, mã + phiên bản giá lưu vào đơn; bot nói 540k khi
 *     báo giá 560k ⇒ chặn + chuyển người (dáng ca thật: 540 rồi 560); câu mẫu / lời chào có giá lệch ⇒ chặn; giá chưa xác thực ⇒ không
 *     tạo đơn; đơn cần kiểm địa chỉ ⇒ «đã lên đơn» bị thay; tổng đơn ≠ báo giá ⇒ lõi không chốt.
 *
 * Không gọi mạng (luật 65): model giả của bộ hội thoại vàng. Không ghim ngày (luật 50).
 */
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { agentPriceProblems } from "@/lib/commerce/pricing";
import { createProductCore } from "@/lib/records/product-create";
import { createOrderAsAgent } from "@/lib/records/order-create";
import { CLAIM_HANDOFF_REASON, CLAIM_SAFE_TEXT, claimFactsLoader, claimVerdict, extractVndAmounts, guardClaims, guardOutgoing, orderValidityOf } from "@/lib/sales-chatbot/claim-guard";
import type { CatalogItem } from "@/lib/sales-chatbot/catalog";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY, parseSalesChatbotConfig, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { verifiedGreeting } from "@/lib/sales-chatbot/engine";
import { classifyHandoffReason } from "@/lib/sales-chatbot/events-shared";
import { buildQuote, catalogReferenceAmounts, computePriced, packChoiceMistake, pricingContextOf, referenceAmounts, type PricingConfig } from "@/lib/sales-chatbot/quote";
import { quoteFactOf, quoteSnapshotOf } from "@/lib/sales-chatbot/quote-shared";
import { renderQuickAnswer } from "@/lib/sales-chatbot/quick-replies";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { getSettingJson } from "@/lib/settings";
import { resolveRecipientPlace } from "@/lib/address/vn-address";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

// ═══ THUẦN ═══

const RULE_ON = { enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "PER_STEP" as const };
const cfgOf = (over: Partial<PricingConfig> = {}): PricingConfig => ({ volumeDiscount: RULE_ON, freeShipping: DEFAULT_SALES_CHATBOT_CONFIG.freeShipping, shippingFee: 30_000, wholesalePricing: false, ...over });
const item = (variantId: string, variant: string, price: number | null, extra: Partial<CatalogItem> = {}): CatalogItem => ({ variantId, productId: "p-cct", name: "Chả cá thu", sku: variantId.toUpperCase(), variant, price, fields: {}, ...extra });

function testExtract() {
  const cases: [string, number[]][] = [
    ["Dạ 2kg chả cá thu 540.000 ₫ ạ", [540_000]],
    ["1kg giá 280k - 2kg giảm 20K còn 540k", [280_000, 20_000, 540_000]],
    ["Tổng 1.080.000đ, ship 30.000 ₫", [1_080_000, 30_000]],
    ["Combo 1tr2 nha chị", [1_200_000]],
    ["Lô sỉ 1,5 triệu", [1_500_000]],
    ["Giá 300 nghìn ạ", [300_000]],
    ["560000đ", [560_000]],
    ["Miễn phí ship, phí 0đ", [0]],
    ["Chị lấy 2kg hay 0,5kg ạ? Gói 500g nhé", []],
    ["SĐT 0976.797.166 hoặc 0976797166", []],
    ["Giao ngày 11.10.2026 lúc 17h", []],
    ["x2 túi, 2 hộp", []],
    ["Em lấy 1tr 2 túi", [1_000_000]],
  ];
  for (const [text, want] of cases) assert.deepEqual(extractVndAmounts(text), want, `trích số tiền: «${text}»`);
}

function testQuotePure() {
  // HSLC: một sản phẩm, gói 1kg 280k + gói 2kg 540k; luật bật (gói 1kg, từ 2kg giảm 20k mỗi bậc).
  const ok = pricingContextOf([item("v1", "1kg", 280_000), item("v2", "2kg (4 túi 0,5kg)", 540_000)], cfgOf(), null);
  const viaPack = buildQuote(computePriced([{ variantId: "v2", quantity: 1 }], ok), ok);
  const viaUnits = buildQuote(computePriced([{ variantId: "v1", quantity: 2 }], ok), ok);
  assert.ok(viaPack.verified && viaUnits.verified, JSON.stringify(viaPack.unverifiedReasons));
  assert.deepEqual(viaPack.lines.map((l) => [l.variantId, l.quantity, l.unitPrice, l.discount, l.lineTotal]), [["v1", 2, 280_000, 20_000, 540_000]], "gói 2kg ⇒ 2 × 1kg − 20k");
  assert.equal(viaPack.subtotal, 540_000);
  assert.equal(viaPack.total, 570_000, "tổng = tiền hàng + ship 30k");
  assert.equal(viaPack.quoteId, viaUnits.quoteId, "CÙNG khối lượng, hai cách AI chọn ⇒ CÙNG một báo giá (mã tất định)");
  assert.match(viaPack.quoteId, /^q1-[0-9a-f]{16}$/);
  assert.match(viaPack.priceVersion, /^pv1-[0-9a-f]{12}$/);
  for (const n of [280_000, 540_000, 20_000, 30_000, 570_000]) assert.ok(viaPack.amounts.includes(n), `báo giá cho phép nói ${n}`);
  assert.ok(!viaPack.amounts.includes(560_000), "560k (2 × 280k chưa giảm) KHÔNG phải số của báo giá 2kg");
  // Đổi một con số giá ⇒ đổi phiên bản giá ⇒ đổi mã báo giá.
  const moved = pricingContextOf([item("v1", "1kg", 290_000), item("v2", "2kg", 560_000)], cfgOf(), null);
  const q2 = buildQuote(computePriced([{ variantId: "v1", quantity: 2 }], moved), moved);
  assert.ok(q2.verified && q2.priceVersion !== viaUnits.priceVersion && q2.quoteId !== viaUnits.quoteId, "giá đổi ⇒ phiên bản + mã đổi");

  // CATALOG MÂU THUẪN: gói 2kg 500k ≠ 2 × 280k − 20k ⇒ chưa xác thực, máy KHÔNG chọn hộ.
  const conflict = pricingContextOf([item("v1", "1kg", 280_000), item("v2", "2kg", 500_000)], cfgOf(), null);
  for (const lines of [[{ variantId: "v2", quantity: 1 }], [{ variantId: "v1", quantity: 2 }]]) {
    const q = buildQuote(computePriced(lines, conflict), conflict);
    assert.ok(!q.verified && q.unverifiedReasons.some((r) => r.code === "PACK_PRICE_CONFLICT") && q.amounts.length === 0, `mâu thuẫn gói ⇒ chưa xác thực: ${JSON.stringify(q.unverifiedReasons)}`);
  }
  assert.ok(buildQuote(computePriced([{ variantId: "v1", quantity: 1 }], conflict), conflict).verified, "1 gói 1kg không mơ hồ ⇒ vẫn bán được");

  // TÁI HIỆN 540 / 560 (KimThu Le #71B31FE3 = gói 2kg × 1 = 540k · Nguyễn Thanh Thủy = 2 × gói 1kg = 560k): đúng hai con số đó chỉ ra
  // khi luật giảm theo khối lượng KHÔNG chạy (luật bật thì gói 2kg mang khối lượng sẽ bị trừ 20k ⇒ 520k). Mỗi mẫu mã một giá, «2kg»
  // có hai biểu diễn — luật chọn gói (luật tắt) bắt AI lên 2 × 1kg khi có gói 2kg riêng.
  const hslcOff = pricingContextOf([item("v1", "", 280_000), item("v2", "Quy cách 2kg (4 túi 0,5kg)", 540_000)], cfgOf({ volumeDiscount: { ...RULE_ON, enabled: false } }), null);
  assert.equal(computePriced([{ variantId: "v2", quantity: 1 }], hslcOff).subtotal, 540_000, "gói 2kg = 540k");
  const offPair = computePriced([{ variantId: "v1", quantity: 2 }], hslcOff);
  assert.equal(offPair.subtotal, 560_000, "2 × gói 1kg = 560k — HAI giá cho «2kg»");
  assert.ok(buildQuote(offPair, hslcOff).unverifiedReasons.some((r) => r.code === "WEIGHT_UNKNOWN"), "mẫu mã 1kg thiếu khối lượng ⇒ không đối chiếu được với gói 2kg ⇒ chưa xác thực (luật tắt cũng vậy)");
  assert.ok(buildQuote(computePriced([{ variantId: "v2", quantity: 1 }], hslcOff), hslcOff).verified, "gói 2kg × 1 = giá chính nó ⇒ xác thực");
  // Mẫu mã 1kg KHÔNG mang khối lượng (SKU «CHA-CA-THU», tên không có «1kg») + luật BẬT ⇒ không nhận ra gói đơn vị: gói 2kg ra 520k,
  // 2 × «1kg» ra 560k — vẫn hai giá. Nay cả hai CHƯA XÁC THỰC cho tới khi chủ shop khai khối lượng.
  const hslc = pricingContextOf([item("v1", "", 280_000), item("v2", "Quy cách 2kg (4 túi 0,5kg)", 540_000)], cfgOf(), null);
  const pack = computePriced([{ variantId: "v2", quantity: 1 }], hslc);
  const units = computePriced([{ variantId: "v1", quantity: 2 }], hslc);
  assert.deepEqual([pack.subtotal, units.subtotal], [520_000, 560_000], "không nhận ra gói đơn vị ⇒ hai số tiền cho cùng 2kg");
  assert.ok(buildQuote(pack, hslc).unverifiedReasons.some((r) => r.code === "UNIT_PACK_UNKNOWN"), "gói 2kg không đối chiếu được ⇒ chưa xác thực");
  assert.ok(buildQuote(units, hslc).unverifiedReasons.some((r) => r.code === "WEIGHT_UNKNOWN"), "2 × mẫu mã thiếu khối lượng ⇒ chưa xác thực");
  assert.ok(buildQuote(computePriced([{ variantId: "v1", quantity: 1 }], hslc), hslc).verified, "1 gói, một giá ⇒ xác thực");

  // Giá thiếu ⇒ chưa xác thực; mẫu mã không có ⇒ chưa xác thực.
  const unpriced = pricingContextOf([item("v1", "1kg", null)], cfgOf(), null);
  assert.ok(buildQuote(computePriced([{ variantId: "v1", quantity: 1 }], unpriced), unpriced).unverifiedReasons.some((r) => r.code === "UNPRICED"));
  assert.ok(buildQuote(computePriced([{ variantId: "zz", quantity: 1 }], ok), ok).unverifiedReasons.some((r) => r.code === "MISSING_SKU"));

  // LUẬT TẮT: mỗi mẫu mã một giá; khách nói «2kg» mà AI lên 2 × 1kg (560k) trong khi có gói 2kg (540k) ⇒ câu sửa: dùng đúng gói.
  const off = pricingContextOf([item("v1", "1kg", 280_000), item("v2", "2kg", 540_000)], cfgOf({ volumeDiscount: { ...RULE_ON, enabled: false } }), null);
  const offUnits = computePriced([{ variantId: "v1", quantity: 2 }], off);
  assert.equal(offUnits.subtotal, 560_000);
  assert.match(packChoiceMistake(offUnits, off.cfg, "lấy 2kg chả cá thu") ?? "", /gói 2kg riêng.*variant_id v2/, "khối lượng có gói riêng ⇒ dùng đúng gói");
  assert.equal(packChoiceMistake(offUnits, off.cfg, "cho chị 2 túi 1kg nhé"), null, "khách nói rõ số túi ⇒ giữ");
  assert.equal(packChoiceMistake(computePriced([{ variantId: "v2", quantity: 1 }], off), off.cfg, "lấy 2kg"), null);
  assert.equal(packChoiceMistake(units, hslc.cfg, "lấy 2kg"), null, "luật bật ⇒ máy chủ tự quy gói, không hỏi model");

  // TẬP THAM CHIẾU: số máy chủ báo được cho giỏ một mẫu mã — 560k không có khi luật bật (2kg = 540k); catalog mâu thuẫn không góp số.
  const refOk = referenceAmounts(ok);
  for (const n of [280_000, 540_000, 20_000, 30_000]) assert.ok(refOk.has(n), `tham chiếu có ${n}`);
  assert.ok(!refOk.has(560_000), "luật bật: «2kg 560k» không phải giá máy chủ");
  const refConflict = referenceAmounts(conflict);
  assert.ok(refConflict.has(280_000) && !refConflict.has(500_000) && !refConflict.has(540_000), "gói mâu thuẫn ⇒ cả 500k lẫn 540k đều chưa xác thực");

  // Dữ kiện báo giá cho vòng đời.
  assert.deepEqual(quoteFactOf(undefined).state, "NONE");
  assert.equal(quoteFactOf(quoteSnapshotOf(viaPack, new Date())).state, "VERIFIED");
  assert.equal(quoteFactOf(quoteSnapshotOf(buildQuote(pack, hslc), new Date())).state, "QUOTED");
}

function testVerdictPure() {
  const facts = { paymentVerified: false, orderConfirmed: false, orderCancelled: false, allowedAmounts: new Set([0, 280_000, 560_000]) };
  const v = guardClaims("Dạ 2kg chả cá thu giảm còn 540k ạ", facts);
  assert.ok(!v.ok && v.claim === "PRICE_UNVERIFIED" && v.safeText === CLAIM_SAFE_TEXT.PRICE && v.handoff && v.amounts?.[0] === 540_000, JSON.stringify(v));
  assert.equal(classifyHandoffReason(CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED), "PRICE_STOCK_ANOMALY");
  assert.match(CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, /PRICE_UNVERIFIED/);
  assert.equal(guardClaims("Dạ 2kg chả cá thu 560.000 ₫ ạ", facts).ok, true, "số thuộc báo giá ⇒ qua");
  assert.equal(guardClaims("Dạ miễn phí ship, 0đ ạ", facts).ok, true);
  assert.equal(guardClaims("Dạ 2kg 540k", { ...facts, allowedAmounts: undefined }).ok, true, "người gọi chưa cấp tập số ⇒ không kiểm (tương thích ngược)");
  // Đơn có nhưng chưa qua kiểm ⇒ thay câu, KHÔNG chuyển người.
  const p = claimVerdict(["ORDER_CONFIRMED"], { ...facts, orderPending: "ADDRESS" });
  assert.ok(!p.ok && p.safeText === CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS && p.handoff === false, JSON.stringify(p));
  const c = claimVerdict(["ORDER_CONFIRMED"], { ...facts, orderPending: "CHECK" });
  assert.ok(!c.ok && c.safeText === CLAIM_SAFE_TEXT.ORDER_PENDING_CHECK && !c.handoff);
  const none = claimVerdict(["ORDER_CONFIRMED"], facts);
  assert.ok(!none.ok && none.safeText === CLAIM_SAFE_TEXT.ORDER && none.handoff, "không có đơn ⇒ như #789");

  // Đơn qua kiểm.
  const base = { id: "erp-1", raw: { origin: "ERP_MANUAL" }, phone: "0912345678", address: "9 Hai Bà Trưng", province: "Thành phố Hà Nội", ward: "Phường Hoàn Kiếm", itemsCount: 1, total: 540_000, shippingFee: 0 };
  assert.deepEqual(orderValidityOf(base), { valid: true, pending: null, reasons: [] });
  assert.equal(orderValidityOf({ ...base, ward: "" }).pending, "ADDRESS", "chưa có xã / phường");
  assert.equal(orderValidityOf({ ...base, raw: { review: { entries: [{ code: "ADDRESS_UNRESOLVED", note: "", quote: null, at: "", by: "bot" }] } } }).pending, "ADDRESS", "#463DEBAE: cờ địa chỉ chưa ghép");
  assert.equal(orderValidityOf({ ...base, raw: { quote: { total: 560_000 } } }).pending, "CHECK", "tổng đơn lệch báo giá đã lưu");
  assert.equal(orderValidityOf({ ...base, raw: { quote: { total: 540_000 } } }).valid, true);
  assert.equal(orderValidityOf({ ...base, id: "123456", ward: "" }).valid, true, "đơn đồng bộ nguồn = nhân viên tạo ở nguồn");

  // Lõi đơn: tiền giảm chỉ được khi máy chủ tính đúng số đó.
  const lines = [{ variantId: "v1", quantity: 2, unitPrice: 280_000, discount: 20_000 }];
  const unit = new Map([["0", 280_000]]);
  assert.match(agentPriceProblems(lines, unit, 0).map((e) => e.message).join(), /không được tự chiết khấu/);
  assert.deepEqual(agentPriceProblems(lines, unit, 0, new Map([["0", 20_000]])), []);
  assert.match(agentPriceProblems([{ ...lines[0], discount: 30_000 }], unit, 0, new Map([["0", 20_000]])).map((e) => e.message).join(), /đúng giảm theo khối lượng/);
}

// ═══ TỔ CHỨC THẬT ═══

const PHONE = "0912345678";
/** Địa chỉ CÓ xã / phường theo địa giới mới — đơn qua kiểm. */
const GOOD_ADDRESS = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
/** Địa chỉ không ghép được xã / phường — máy chốt kèm cờ «địa chỉ chưa ghép» (#463DEBAE). */
const BAD_ADDRESS = "Số 5 ngõ 12 xóm Chùa, Hà Nội";

/** Thêm sản phẩm «Chả cá thu» hai quy cách vào tổ chức thử và ghi id vào bảng SKU của bộ hội thoại vàng. */
async function seedCct(ctx: Omit<GoldenHookCtx, "conversationId">, price1: number, price2: number | null, prefix = "CCT"): Promise<void> {
  const admin = await ctx.admin();
  const variants = [{ sku: `${prefix}-1KG`, size: "1kg", color: "", retailPrice: price1, cost: null, selling: true }, ...(price2 === null ? [] : [{ sku: `${prefix}-2KG`, size: "2kg", color: "", retailPrice: price2, cost: null, selling: true }])];
  const r = await createProductCore(admin, { name: "Chả cá thu", code: prefix, unit: "gói", retailPrice: price1, cost: null, variants });
  assert.ok(r.ok, JSON.stringify(r));
  const db = await getDb();
  const vs = await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id));
  const ids = ctx.ids as Map<string, string>;
  for (const v of vs) ids.set(v.sku, v.id);
}

const ON: Partial<SalesChatbotConfig> = { volumeDiscount: RULE_ON, sellWithoutStockCheck: true, shippingFee: 30_000 };
const OFF: Partial<SalesChatbotConfig> = { sellWithoutStockCheck: true, shippingFee: 30_000 };
const ORDER_TEXT = "Dạ em lên đơn cho mình rồi ạ.";

const RULE_ON_CASES: GoldenCase[] = [
  {
    key: "qi-2kg-giam",
    title: "2kg có giảm theo khối lượng ⇒ báo giá = tổng đơn; mã báo giá + phiên bản giá lưu vào đơn",
    shop: "food",
    channel: "WEB",
    config: ON,
    turns: [
      {
        say: `lấy 2kg chả cá thu, Trần Thu ${PHONE}, ${GOOD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Trần Thu", phone: PHONE, address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 2kg chả cá thu 540.000 ₫ · ship 30.000 ₫ · tổng 570.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
        ],
      },
      { say: "ok giao đi em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok giao đi em" })], () => [say(ORDER_TEXT)]] },
    ],
  },
  {
    key: "qi-gia-chua-xac-thuc",
    title: "Gói 2kg trong danh mục lệch luật giảm ⇒ giá chưa xác thực ⇒ không tạo đơn, chuyển người",
    shop: "food",
    channel: "WEB",
    config: ON,
    turns: [
      {
        say: `lấy 2kg chả cá thu, Lê Mai 0987654321, ${GOOD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Lê Mai", phone: "0987654321", address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCX-2KG"), quantity: 1 }] })],
          () => [say("Dạ em kiểm lại giá chính xác và báo mình ngay ạ.")],
        ],
      },
    ],
  },
];

const RULE_OFF_CASES: GoldenCase[] = [
  {
    key: "qi-540-roi-560",
    title: "Dáng ca thật: bot định nói «2kg giảm còn 540k» (chữ trả lời tự động cũ) khi máy chủ chỉ có 2 × 280k = 560k ⇒ chặn + chuyển người",
    shop: "food",
    channel: "WEB",
    config: OFF,
    turns: [{ say: "2kg chả cá thu bao nhiêu em", ai: [() => [say("Dạ chả cá thu 1kg 280k, 2kg giảm còn 540k ạ. Chị lấy mấy kg ạ?")]] }],
  },
  {
    key: "qi-560-dung-bao-gia",
    title: "Bot đọc đúng báo giá 560k của calculate_cart ⇒ qua",
    shop: "food",
    channel: "WEB",
    config: OFF,
    turns: [
      {
        say: "2kg chả cá thu bao nhiêu em",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 2 }] })], () => [say("Dạ 2kg chả cá thu 560.000 ₫, ship 30.000 ₫, tổng 590.000 ₫ ạ.")]],
      },
    ],
  },
  {
    key: "qi-dia-chi-can-kiem",
    title: "Đơn chốt khi địa chỉ chưa ghép xã / phường ⇒ «đã lên đơn» bị thay bằng câu ghi nhận, KHÔNG chuyển người",
    shop: "food",
    channel: "WEB",
    config: OFF,
    turns: [
      {
        say: `lấy 1kg chả cá thu, Đỗ Nguyệt 0934567890, ${BAD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Đỗ Nguyệt", phone: "0934567890", address: BAD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 1kg chả cá thu 280.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
        ],
      },
      { say: "Oki em lên đơn cho chị luôn nhé", ai: [() => [tool("confirm_order", { customer_confirmation: "Oki em lên đơn cho chị luôn nhé" })], () => [say("Dạ em lên đơn cho mình rồi ạ, shop giao sớm cho mình nha ❤️")]] },
    ],
  },
];

async function orderOfConversation(conversationId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  const state = (row.state ?? {}) as ChatState;
  const orderId = state.confirmed?.orderId ?? state.draft?.orderId ?? null;
  const [o] = orderId ? await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)) : [];
  const items = orderId ? await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)) : [];
  return { row, state, order: o ?? null, items };
}

async function testRuleOn() {
  const seen = new Set<string>();
  await runGoldenCases(RULE_ON_CASES, {
    orgSuffix: "-qi1",
    beforeCase: async (c, ctx) => {
      if (c.key === "qi-2kg-giam") await seedCct(ctx, 280_000, 540_000);
      // Sản phẩm RIÊNG có gói 2kg 500k ≠ 2 × 280k − 20k (SKU khác để không đè sản phẩm của hội thoại trước).
      else await seedCct(ctx, 280_000, 500_000, "CCX");
    },
    afterCase: async (c, ctx, transcript) => {
      seen.add(c.key);
      const { row, state, order, items } = await orderOfConversation(ctx.conversationId);
      if (c.key === "qi-2kg-giam") {
        assert.ok(order, "có đơn ERP");
        assert.equal(order.stage, "CONFIRMED", `đơn chốt: ${JSON.stringify(transcript.turns.map((t) => t.shown))}`);
        assert.deepEqual(items.map((i) => [i.quantity, Number(i.unitPrice), Number(i.totalDiscount)]), [[2, 280_000, 20_000]], "2 × 1kg − 20k (lõi nhận tiền giảm do máy chủ tính)");
        assert.equal(order.totalPriceAfterDiscount, 540_000, "TỔNG ĐƠN = báo giá");
        const raw = order.raw as { quote?: { id: string; priceVersion: string; subtotal: number; total: number | null } };
        assert.ok(raw.quote, "đơn lưu báo giá");
        assert.equal(raw.quote.id, state.confirmed?.quoteId, "mã báo giá trên đơn = mã báo giá bot đã chốt");
        assert.equal(raw.quote.id, state.quote?.id);
        assert.match(raw.quote.priceVersion, /^pv1-/);
        assert.equal(raw.quote.total, order.totalPriceAfterDiscount + order.shippingFee, "tổng báo giá = tổng đơn + ship");
        assert.equal(raw.quote.total, 570_000);
        assert.ok(state.confirmed?.valid === true, "địa chỉ có xã / phường ⇒ đơn qua kiểm");
        assert.deepEqual(transcript.turns[0].shown, ["Tóm tắt: 2kg chả cá thu 540.000 ₫ · ship 30.000 ₫ · tổng 570.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?"], "số tiền của báo giá ⇒ qua hàng rào");
        assert.deepEqual(transcript.turns[1].shown, [ORDER_TEXT], "đơn tạo + qua kiểm ⇒ «đã lên đơn» được gửi");

        // LÕI ĐƠN — tổng đơn ≠ báo giá ⇒ không ghi; tiền giảm không có báo giá ⇒ không ghi; báo giá đúng ⇒ ghi + lưu.
        const v1 = ctx.ids.get("CCT-1KG")!;
        const payload = { customerId: order.customerId!, stage: "CONFIRMED" as const, lines: [{ variantId: v1, quantity: 2, unitPrice: 280_000, discount: 20_000 }], orderDiscount: 0, shippingFee: 30_000, note: "", channel: "Chatbot web", recipient: { name: "Trần Thu", phone: PHONE, address: GOOD_ADDRESS, province: "" } };
        const agent = { name: "Bài kiểm báo giá", source: "tests/sales-quote-integrity.test.ts" };
        const noQuote = await createOrderAsAgent(agent, payload, { pricing: "RETAIL" });
        assert.ok(!noQuote.ok && JSON.stringify(noQuote).includes("không được tự chiết khấu"), `không báo giá ⇒ máy không được mang tiền giảm: ${JSON.stringify(noQuote)}`);
        const wrong = await createOrderAsAgent(agent, payload, { pricing: "RETAIL", quote: { id: raw.quote.id, priceVersion: raw.quote.priceVersion, subtotal: 560_000, total: 590_000 } });
        assert.ok(!wrong.ok && JSON.stringify(wrong).includes("Tiền hàng của báo giá"), `báo giá khai 560k ≠ máy chủ 540k ⇒ lõi KHÔNG ghi: ${JSON.stringify(wrong)}`);
        const totalOff = await createOrderAsAgent(agent, payload, { pricing: "RETAIL", quote: { id: raw.quote.id, priceVersion: raw.quote.priceVersion, subtotal: 540_000, total: 560_000 } });
        assert.ok(!totalOff.ok && JSON.stringify(totalOff).includes("khác tổng đã báo khách"), `tổng đơn ≠ tổng đã báo ⇒ không ghi: ${JSON.stringify(totalOff)}`);
        const good = await createOrderAsAgent(agent, payload, { pricing: "RETAIL", quote: { id: raw.quote.id, priceVersion: raw.quote.priceVersion, subtotal: 540_000, total: 570_000 } });
        assert.ok(good.ok, JSON.stringify(good));
        const db = await getDb();
        const [g] = await db.select({ raw: schema.orders.raw, total: schema.orders.totalPriceAfterDiscount }).from(schema.orders).where(eq(schema.orders.id, good.id));
        assert.equal((g.raw as { quote?: { total: number } }).quote?.total, 570_000, "lõi lưu báo giá vào raw.quote");
        assert.equal(g.total, 540_000);

        // CÂU MẪU / LỜI CHÀO: chữ cố định điền giá thô của gói 2kg đúng (540k) ⇒ qua; số khác báo giá máy chủ ⇒ chặn.
        const cfg = parseSalesChatbotConfig(await getSettingJson<unknown>(SALES_CHATBOT_SETTING_KEY, null));
        const facts = claimFactsLoader({ id: row.id, orderId: row.orderId, pageId: row.pageId, threadId: row.threadId }, { reference: () => catalogReferenceAmounts(cfg) });
        const tpl = await renderQuickAnswer("Chả cá thu: 1kg {{giá:CCT-1KG}} · 2kg giảm còn {{giá:CCT-2KG}}", cfg);
        assert.equal(tpl, "Chả cá thu: 1kg 280.000 ₫ · 2kg giảm còn 540.000 ₫");
        assert.equal((await guardOutgoing(tpl!, () => facts({}))).ok, true, "câu mẫu khớp báo giá máy chủ ⇒ qua");
        const typed = await guardOutgoing("Chả cá thu 1kg 279k · 2kg 539k ạ", () => facts({}));
        assert.ok(!typed.ok && typed.claim === "PRICE_UNVERIFIED", "chữ trả lời tự động «279k / 539k» ⇒ chặn");
        assert.equal(await verifiedGreeting({ ...cfg, greeting: "Chào chị! 2kg chả cá thu giảm còn 540.000 ₫ ạ" }), "Chào chị! 2kg chả cá thu giảm còn 540.000 ₫ ạ", "lời chào có giá đúng ⇒ giữ");
        assert.equal(await verifiedGreeting({ ...cfg, greeting: "Chào chị! 2kg chả cá thu chỉ 520.000 ₫" }), DEFAULT_SALES_CHATBOT_CONFIG.greeting, "lời chào có giá lệch ⇒ lời chào mặc định không số");
        return;
      }
      // qi-gia-chua-xac-thuc
      assert.equal(order, null, "giá chưa xác thực ⇒ KHÔNG tạo đơn");
      assert.equal(state.draft, undefined);
      assert.equal(transcript.final.status, "HANDOFF", "chuyển người xác minh giá");
      assert.match(row.handoffReason ?? "", /PRICE_UNVERIFIED/);
      assert.equal(state.quote?.verified, false);
      assert.ok((state.quote?.reasons ?? []).some((r) => /gói 2kg trong danh mục 500\.000 ₫/.test(r)), JSON.stringify(state.quote));
      const db = await getDb();
      const anyOrder = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      assert.equal(anyOrder.length, 0);
    },
  });
  assert.deepEqual([...seen].sort(), RULE_ON_CASES.map((c) => c.key).sort());
}

async function testRuleOff() {
  const seen = new Set<string>();
  await runGoldenCases(RULE_OFF_CASES, {
    orgSuffix: "-qi2",
    beforeCase: async (c, ctx) => {
      if (!ctx.ids.has("CCT-1KG")) await seedCct(ctx, 280_000, null);
    },
    afterCase: async (c, ctx, transcript) => {
      seen.add(c.key);
      const { row, state, order } = await orderOfConversation(ctx.conversationId);
      if (c.key === "qi-540-roi-560") {
        assert.deepEqual(transcript.turns[0].shown, [CLAIM_SAFE_TEXT.PRICE], "540k KHÔNG tới khách — câu an toàn thay chỗ");
        assert.equal(transcript.final.status, "HANDOFF");
        assert.match(row.handoffReason ?? "", /PRICE_UNVERIFIED/, "lý do chuyển người PRICE_UNVERIFIED");
        assert.match(row.lastError ?? "", /540\.000/);
        return;
      }
      if (c.key === "qi-560-dung-bao-gia") {
        assert.deepEqual(transcript.turns[0].shown, ["Dạ 2kg chả cá thu 560.000 ₫, ship 30.000 ₫, tổng 590.000 ₫ ạ."], "số của báo giá ⇒ qua");
        assert.equal(transcript.final.status, "OPEN");
        assert.equal(state.quote?.verified, true);
        assert.equal(state.quote?.total, 590_000);
        return;
      }
      // qi-dia-chi-can-kiem
      assert.ok(order, "đơn VẪN được tạo để người sửa");
      assert.equal(order.stage, "CONFIRMED");
      assert.equal(order.shipCommune, "", "xã / phường chưa ghép");
      assert.equal(state.confirmed?.valid, false);
      assert.equal(state.confirmed?.pending, "ADDRESS");
      assert.deepEqual(transcript.turns[1].shown, [CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS], "«đã lên đơn» bị thay bằng câu ghi nhận + nhân viên xác nhận địa chỉ");
      assert.notEqual(transcript.final.status, "HANDOFF", "không chuyển người — đơn đã nằm trong hàng «Cần người kiểm»");
      const conv = { id: row.id, orderId: row.orderId, pageId: row.pageId, threadId: row.threadId };
      const f = await claimFactsLoader(conv)(state);
      assert.equal(f.orderConfirmed, false, "đơn CẦN XÁC THỰC không đủ cho «đã lên đơn»");
      assert.equal(f.orderPending, "ADDRESS");
      // Đơn chốt TRƯỚC bản này (state không có `valid`) ⇒ đọc CSDL: cờ «địa chỉ chưa ghép» vẫn chặn.
      const legacy: ChatState = { ...state, confirmed: { ...state.confirmed!, valid: undefined, pending: undefined } };
      const fl = await claimFactsLoader(conv)(legacy);
      assert.ok(!fl.orderConfirmed && fl.orderPending === "ADDRESS", JSON.stringify(fl));
      // Người sửa địa chỉ + gỡ cờ ⇒ đơn qua kiểm ⇒ câu «đã lên đơn» hợp lệ.
      const db = await getDb();
      await db.update(schema.orders).set({ shipCommune: "Phường Hoàn Kiếm", shipProvince: "Thành phố Hà Nội", raw: { ...(order.raw as Record<string, unknown>), review: null } }).where(and(eq(schema.orders.id, order.id)));
      assert.equal((await claimFactsLoader(conv)(legacy)).orderConfirmed, true);
      const stillOpen = await db.select({ id: schema.orders.id }).from(schema.orders).where(inArray(schema.orders.id, [order.id]));
      assert.equal(stillOpen.length, 1);
    },
  });
  assert.deepEqual([...seen].sort(), RULE_OFF_CASES.map((c) => c.key).sort());
}

export async function testSalesQuoteIntegrity() {
  testExtract();
  testQuotePure();
  testVerdictPure();
  // Tiền đề của hai hội thoại địa chỉ: địa chỉ «tốt» ghép được xã / phường, địa chỉ «xấu» thì không.
  assert.ok(resolveRecipientPlace({ address: GOOD_ADDRESS, province: "" }).ward, `địa chỉ tốt phải ghép được xã: ${JSON.stringify(resolveRecipientPlace({ address: GOOD_ADDRESS, province: "" }))}`);
  assert.equal(resolveRecipientPlace({ address: BAD_ADDRESS, province: "" }).ward, "", "địa chỉ xấu không ghép được xã");
  await testRuleOn();
  await testRuleOff();
  console.log("  ✓ báo giá máy chủ (quote.ts): một phép tính cho giỏ · đơn · lõi; 2kg = 2 × 1kg − giảm, cùng mã báo giá; catalog mâu thuẫn / thiếu khối lượng ⇒ chưa xác thực (tái hiện 540 / 560); số tiền trong chữ bot phải thuộc báo giá đã xác thực — 540k khi báo giá 560k bị chặn + PRICE_UNVERIFIED; câu mẫu / lời chào lệch giá bị chặn; giá chưa xác thực ⇒ không tạo đơn; đơn cần kiểm địa chỉ ⇒ «đã lên đơn» bị thay, không chuyển người; tổng đơn ≠ báo giá ⇒ lõi không ghi; mã + phiên bản giá lưu vào đơn");
}

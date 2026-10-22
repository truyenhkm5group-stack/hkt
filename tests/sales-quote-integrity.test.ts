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
import { CLAIM_HANDOFF_REASON, CLAIM_SAFE_TEXT, claimFactsLoader, claimVerdict, detectPriceDispute, extractVndAmounts, guardClaims, guardOutgoing, orderValidityOf } from "@/lib/sales-chatbot/claim-guard";
import type { CatalogItem } from "@/lib/sales-chatbot/catalog";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY, parseSalesChatbotConfig, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { priceDisputePrompt, verifiedGreeting } from "@/lib/sales-chatbot/engine";
import { classifyHandoffReason } from "@/lib/sales-chatbot/events-shared";
import { buildQuote, catalogReferenceAmounts, computePriced, packChoiceMistake, packingIssues, packingRequestOf, pricingContextOf, referenceAmounts, type PricingConfig } from "@/lib/sales-chatbot/quote";
import { quoteFactOf, quoteSnapshotOf } from "@/lib/sales-chatbot/quote-shared";
import { renderQuickAnswer } from "@/lib/sales-chatbot/quick-replies";
import { classifyOrderPrice } from "@/lib/sales-chatbot/price-mismatch";
import { applyMismatchFlags, parsePriceScanArgs, planMismatchFlags, scanBotOrders } from "../scripts/price-mismatch-scan";
import { orderReviewOf, withReviewResolved } from "@/lib/constants/order-review";
import { autoConfirmBlocker, autoConfirmText, type ChatState } from "@/lib/sales-chatbot/tools";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { getSettingJson, setSettingJson } from "@/lib/settings";
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

  // Luật TẮT: «2kg» có MỘT biểu diễn tham chiếu — gói 2kg 540k; 2 × 1kg = 560k không phải giá tham chiếu (ca Nguyễn Thanh Thủy #DC0444F2:
  // bot báo 540k rồi tóm tắt 560k).
  const refOff = referenceAmounts(off);
  assert.ok(refOff.has(280_000) && refOff.has(540_000) && !refOff.has(560_000), "luật tắt: 540k là giá «2kg», 560k không");

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
  // 22/10/2026 (chủ shop — xác minh địa chỉ độc lập với upsell): câu thay cho MỌI tổ chức là câu ghi nhận, không «nhân viên xác nhận địa chỉ».
  assert.ok(!p.ok && p.safeText === CLAIM_SAFE_TEXT.ORDER_RECEIVED && p.handoff === false, JSON.stringify(p));
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
      assert.deepEqual(transcript.turns[1].shown, [CLAIM_SAFE_TEXT.ORDER_RECEIVED], "«đã lên đơn» bị thay bằng câu ghi nhận (không «nhân viên xác nhận địa chỉ» — 22/10/2026)");
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

// ═══ KHÁCH PHẢN ĐỐI GIÁ · ĐỔI SỐ LƯỢNG · ĐÓNG GÓI RIÊNG (BỔ SUNG 11/10 (5), ca «Chị Hoàn») ═══

function testDisputePure() {
  const q = { amounts: [280_000, 560_000, 30_000, 590_000], subtotal: 560_000, total: 590_000 };
  assert.deepEqual(detectPriceDispute("2 ký giá 540đ chứ", q), { amounts: [540_000], phrase: true }, "«2 ký giá 540đ chứ» ⇒ phản đối, khách nói 540.000 ₫");
  assert.deepEqual(detectPriceDispute("Sao lại 560k vậy em, tưởng 540k", q)?.amounts, [540_000]);
  assert.deepEqual(detectPriceDispute("sao lại 560k", q), { amounts: [], phrase: true }, "phản đối đúng số đã báo, không nêu số khác ⇒ vẫn là phản đối");
  assert.deepEqual(detectPriceDispute("em tính sai rồi", q), { amounts: [], phrase: true });
  for (const ok of ["ok 560 nhé em", "giá bao nhiêu em", "ship bao nhiêu", "chị lấy 2kg", "chốt đơn nhé", "đúng rồi em"]) assert.equal(detectPriceDispute(ok, q), null, `không phải phản đối: «${ok}»`);
  assert.equal(detectPriceDispute("2 ký giá 540đ chứ", null), null, "chưa có báo giá ⇒ không xét");

  assert.ok(packingRequestOf("2kg đóng 2 gói riêng nhé em"));
  assert.ok(packingRequestOf("chia 2 túi giúp chị"));
  assert.ok(packingRequestOf("đóng riêng từng gói nha"));
  assert.equal(packingRequestOf("lấy 2kg chả cá thu"), null);
  // Tách gói có còn giá gói không: gói 2kg 540k vs 2 × 1kg 560k ⇒ quyết định của shop ⇒ vấn đề báo giá; luật bật và gói khớp ⇒ không.
  const off = pricingContextOf([item("v1", "1kg", 280_000), item("v2", "2kg", 540_000)], cfgOf({ volumeDiscount: { ...RULE_ON, enabled: false } }), null);
  assert.equal(packingIssues(computePriced([{ variantId: "v1", quantity: 2 }], off))[0]?.code, "PACK_PRICE_CONFLICT");
  assert.equal(packingIssues(computePriced([{ variantId: "v2", quantity: 1 }], off))[0]?.code, "PACK_PRICE_CONFLICT", "ca «Chị Hoàn» #B8E4E551: AI chọn gói 2kg mà khách đòi 2 gói riêng ⇒ vẫn là quyết định của shop (chưa có cấu hình «giá gói áp cả khi đóng tách»)");
  const on = pricingContextOf([item("v1", "1kg", 280_000), item("v2", "2kg", 540_000)], cfgOf(), null);
  assert.deepEqual(packingIssues(computePriced([{ variantId: "v2", quantity: 1 }], on), true), [], "luật bật: 2 × 1kg − 20k = gói 2kg ⇒ tách gói không đổi giá");
  assert.deepEqual(packingIssues(computePriced([{ variantId: "v1", quantity: 1 }], off)), [], "1 gói 1kg ⇒ không có gói nào để so");

  const snap = quoteSnapshotOf(buildQuote(computePriced([{ variantId: "v1", quantity: 2 }], on), on), new Date());
  assert.equal(quoteFactOf(snap, { at: "", amounts: [540_000], quoteId: snap.id, turn: 3, open: true }).state, "DISPUTED", "khung đơn không được hiện «ĐÃ XÁC NHẬN» khi giá tranh chấp");
  assert.equal(quoteFactOf(snap, { at: "", amounts: [540_000], quoteId: snap.id, turn: 3, open: false, requotedTurn: 3 }).state, "VERIFIED");
  assert.match(priceDisputePrompt({ at: "", amounts: [540_000], quoteId: "q", turn: 1, open: true }), /PRICE_DISPUTED.*540\.000/);
  assert.equal(priceDisputePrompt(undefined), "", "không tranh chấp ⇒ lời nhắc không đổi");
  assert.equal(classifyHandoffReason(CLAIM_HANDOFF_REASON.PRICE_DISPUTED), "PRICE_STOCK_ANOMALY");
}

const HOAN = { name: "Chị Hoàn", phone: "0961234567" };

/** Luật giảm TẮT, danh mục có gói 1kg 280k + gói 2kg 540k (hai SKU) — đúng dữ liệu hai ca 540 / 560. */
const PACK_CASES: GoldenCase[] = [
  {
    key: "qi-phan-doi-co-can-cu",
    title: "Khách phản đối «2 ký giá 540đ chứ» khi bot báo 2 × 1kg = 560k: 540k CÓ trong giá máy chủ (gói 2kg) ⇒ báo lại + xin xác nhận, không chốt cùng lượt; đơn mang cờ khách phản đối giá",
    shop: "food",
    channel: "WEB",
    config: OFF,
    turns: [
      {
        say: `lấy 1kg chả cá thu, ${HOAN.name} ${HOAN.phone}, ${GOOD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: HOAN.name, phone: HOAN.phone, address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 1kg chả cá thu 280.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
        ],
      },
      { say: "cho chị 2 túi 1kg", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 2 }] })], () => [say("Dạ 2 túi 1kg là 560.000 ₫ ạ, chị xác nhận giúp em nhé?")]] },
      {
        say: "2 ký giá 540đ chứ",
        ai: [
          () => [tool("confirm_order", { customer_confirmation: "2 ký giá 540đ chứ" })],
          ({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })],
          () => [say("Dạ gói 2kg là 540.000 ₫ ạ, chị xác nhận giúp em nhé?")],
        ],
      },
      { say: "ok em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok em" })], () => [say(ORDER_TEXT)]] },
    ],
  },
  {
    key: "qi-dong-goi-rieng",
    title: "Khách đòi 2kg đóng 2 gói riêng: gói 2kg 540k ≠ 2 × 1kg 560k — tách gói có giữ giá gói là quyết định của shop ⇒ chưa xác thực, không sửa đơn, chuyển người",
    shop: "food",
    channel: "WEB",
    config: OFF,
    turns: [
      {
        say: `lấy 1kg chả cá thu, Chị Lan 0967654321, ${GOOD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Chị Lan", phone: "0967654321", address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 1kg chả cá thu 280.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
        ],
      },
      { say: "chị lấy 2kg, đóng 2 gói riêng nhé", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 2 }] })], () => [say("Dạ em kiểm lại giá chính xác và báo mình ngay ạ.")]] },
    ],
  },
];

/** Luật TẮT, chỉ gói 1kg (không gói 2kg) — số khách nói không có trong giá máy chủ ⇒ chuyển người ngay; đổi số lượng ⇒ xin xác nhận tổng mới. */
const DISPUTE_UNKNOWN_CASES: GoldenCase[] = [
  {
    key: "qi-phan-doi-khong-can-cu",
    title: "Khách nói «2kg 500k chứ» — 500k không có trong giá máy chủ ⇒ chuyển nhân viên ngay (PRICE_DISPUTED), model không chạy",
    shop: "food",
    channel: "WEB",
    config: OFF,
    turns: [
      { say: "2kg chả cá thu bao nhiêu em", ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 2 }] })], () => [say("Dạ 2kg chả cá thu 560.000 ₫ ạ.")]] },
      { say: "2kg 500k chứ em", ai: [() => [say("Dạ vâng 500k ạ")]] },
    ],
  },
  {
    key: "qi-doi-so-luong",
    title: "Khách đổi 1kg ⇒ 2kg rồi đòi chốt luôn: báo giá cũ hết hiệu lực, máy chủ chặn chốt cùng lượt, bot báo tổng mới 560k",
    shop: "food",
    channel: "WEB",
    config: OFF,
    turns: [
      {
        say: `lấy 1kg chả cá thu, Anh Tú 0971234567, ${GOOD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Anh Tú", phone: "0971234567", address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 1kg chả cá thu 280.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
        ],
      },
      {
        say: "đổi thành 2kg giúp anh, chốt luôn",
        ai: [
          ({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 2 }] }), tool("confirm_order", { customer_confirmation: "chốt luôn" })],
          () => [say("Dạ 2kg chả cá thu 560.000 ₫, ship 30.000 ₫, tổng 590.000 ₫ ạ. Anh xác nhận giúp em nhé?")],
        ],
      },
    ],
  },
];

async function testDisputeCases() {
  const seen = new Set<string>();
  await runGoldenCases(PACK_CASES, {
    orgSuffix: "-qi3",
    beforeCase: async (c, ctx) => {
      if (!ctx.ids.has("CCT-1KG")) await seedCct(ctx, 280_000, 540_000);
    },
    afterCase: async (c, ctx, transcript) => {
      seen.add(c.key);
      const { row, state, order, items } = await orderOfConversation(ctx.conversationId);
      if (c.key === "qi-phan-doi-co-can-cu") {
        const t3 = transcript.turns[2];
        assert.ok(t3.rounds.some((r) => /phản đối giá/i.test(JSON.stringify(r.results))), `lượt khách phản đối: confirm_order bị chặn — ${JSON.stringify(t3.rounds.map((r) => r.results))}`);
        assert.deepEqual(t3.shown, ["Dạ gói 2kg là 540.000 ₫ ạ, chị xác nhận giúp em nhé?"], "báo lại đúng giá máy chủ (gói 2kg) + xin xác nhận");
        assert.notEqual(t3.status, "HANDOFF", "540k có căn cứ trong giá máy chủ ⇒ không cần chuyển người");
        assert.ok(order, "có đơn");
        assert.equal(order.stage, "CONFIRMED", "khách xác nhận lại ở tin SAU ⇒ chốt");
        assert.deepEqual(items.map((i) => [ctx.ids.get("CCT-2KG") === i.variantId, i.quantity, Number(i.unitPrice)]), [[true, 1, 540_000]], "đơn = gói 2kg 540k — đúng số khách đồng ý");
        assert.equal(order.totalPriceAfterDiscount, 540_000);
        const review = (order.raw as { review?: { entries: { code: string }[] } | null }).review;
        assert.ok(review?.entries.some((e) => e.code === "PRICE_DISPUTED"), "đơn mang cờ «khách phản đối giá» — người kiểm giá");
        assert.deepEqual(transcript.turns[3].shown, [CLAIM_SAFE_TEXT.ORDER_PENDING_CHECK], "đơn còn cờ phản đối giá ⇒ KHÔNG «đã lên đơn»");
        assert.equal(state.priceDispute?.open, false);
        assert.equal(quoteFactOf(state.quote, state.priceDispute).state, "VERIFIED");
        return;
      }
      // qi-dong-goi-rieng
      assert.equal(transcript.final.status, "HANDOFF", "chuyển người: shop quyết tách gói có giữ giá gói không");
      assert.match(row.handoffReason ?? "", /PRICE_UNVERIFIED/);
      assert.ok((state.quote?.reasons ?? []).some((r) => /đóng gói riêng/.test(r)), JSON.stringify(state.quote));
      assert.ok(order && items.length === 1 && items[0].quantity === 1, "đơn nháp KHÔNG bị sửa thành 560k khi giá chưa xác thực");
    },
  });
  await runGoldenCases(DISPUTE_UNKNOWN_CASES, {
    orgSuffix: "-qi4",
    beforeCase: async (c, ctx) => {
      if (!ctx.ids.has("CCT-1KG")) await seedCct(ctx, 280_000, null);
    },
    afterCase: async (c, ctx, transcript) => {
      seen.add(c.key);
      const { row, state, order } = await orderOfConversation(ctx.conversationId);
      if (c.key === "qi-phan-doi-khong-can-cu") {
        assert.deepEqual(transcript.turns[1].shown, [CLAIM_SAFE_TEXT.PRICE_DISPUTE]);
        assert.equal(transcript.turns[1].rounds.length, 0, "model không chạy — máy chủ chuyển người ngay");
        assert.equal(transcript.final.status, "HANDOFF");
        assert.match(row.handoffReason ?? "", /PRICE_DISPUTED/);
        assert.equal(state.priceDispute?.open, true);
        assert.equal(order, null, "đơn chưa tạo ⇒ không tạo");
        return;
      }
      // qi-doi-so-luong
      assert.ok(transcript.turns[1].rounds.some((r) => /tổng mới/i.test(JSON.stringify(r.results))), "chốt cùng lượt đổi số lượng bị chặn");
      assert.ok(order && order.stage !== "CONFIRMED", "chưa chốt");
      assert.equal(state.confirmed, undefined);
      assert.equal(order.totalPriceAfterDiscount, 560_000, "đơn nháp cập nhật NGAY theo báo giá mới");
      assert.notEqual(state.draft?.seenQuoteId, state.draft?.quote?.id, "báo giá cũ hết hiệu lực");
      assert.deepEqual(transcript.turns[1].shown, ["Dạ 2kg chả cá thu 560.000 ₫, ship 30.000 ₫, tổng 590.000 ₫ ạ. Anh xác nhận giúp em nhé?"]);
    },
  });
  assert.deepEqual([...seen].sort(), [...PACK_CASES, ...DISPUTE_UNKNOWN_CASES].map((c) => c.key).sort());
}

// ═══ TỰ CHỐT KHI ĐỦ ĐƠN (chủ shop ghi đè 11/10/2026, P0-A) ═══

function testAutoConfirmPure() {
  const draft = { orderId: null, lines: [{ variantId: "v1", quantity: 2 }], unitPrices: { v1: 280_000 }, recipient: { name: "Lệ", phone: "0981234567", address: "9 Hai Bà Trưng, Phường Hoàn Kiếm, Hà Nội", province: "" }, note: "", simulated: false, quote: { id: "q1-x", priceVersion: "pv1-x", subtotal: 540_000, total: 570_000 } };
  const st: ChatState = { customer: { id: "c", name: "Lệ", phone: "0981234567", address: draft.recipient.address, province: "", simulated: false }, draft };
  assert.equal(autoConfirmBlocker(st, { lastUserText: "Chị lấy 2kg, 0981234567, 9 Hai Bà Trưng Hoàn Kiếm Hà Nội", turn: 3 }), null, "đủ sáu điều kiện ⇒ tự chốt");
  assert.match(autoConfirmBlocker(st, { lastUserText: "để chị hỏi chồng đã nhé", turn: 3 }) ?? "", /chưa quyết mua/);
  assert.match(autoConfirmBlocker(st, { lastUserText: "chưa chốt đâu em", turn: 3 }) ?? "", /chưa quyết mua/);
  assert.match(autoConfirmBlocker({ ...st, draft: { ...draft, recipient: { ...draft.recipient, phone: "09812" } } }, { lastUserText: "ok", turn: 3 }) ?? "", /SĐT/);
  assert.match(autoConfirmBlocker({ ...st, draft: { ...draft, recipient: { ...draft.recipient, address: "nhà chị ở gần chợ" } } }, { lastUserText: "ok", turn: 3 }) ?? "", /Địa chỉ chưa đủ/);
  assert.match(autoConfirmBlocker({ ...st, priceDispute: { at: "", amounts: [540_000], quoteId: "q", turn: 3, open: true } }, { lastUserText: "ok", turn: 3 }) ?? "", /phản đối giá/);
  assert.match(autoConfirmBlocker({ ...st, upsellTurn: 3 }, { lastUserText: "ok", turn: 3 }) ?? "", /mời thêm món/);
  assert.equal(autoConfirmBlocker({ ...st, upsellTurn: 2 }, { lastUserText: "ok", turn: 3 }), null);
  assert.match(autoConfirmBlocker({ ...st, customer: undefined }, { lastUserText: "ok", turn: 3 }) ?? "", /SĐT \+ địa chỉ/);
  assert.equal(autoConfirmText([{ name: "Chả cá thu (1kg)", quantity: 2 }]), "Dạ em lên đơn 2 × Chả cá thu (1kg) cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.");
}

const LE_TEXT = "Dạ em lên đơn 2kg chả cá thu cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.";
const AUTO_CASES: GoldenCase[] = [
  {
    key: "qi-tu-chot-kieu-van-le",
    title: "Ca Kiều Văn Lệ: khách nói 2kg + SĐT + địa chỉ ⇒ máy chủ TỰ CHỐT ngay (không hỏi «lấy thêm gì không»), một câu ngắn",
    shop: "food",
    channel: "WEB",
    config: ON,
    turns: [
      {
        say: `Chị lấy 2kg chả cá thu, Kiều Văn Lệ 0981234567, ${GOOD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Kiều Văn Lệ", phone: "0981234567", address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })],
          () => [say(LE_TEXT)],
        ],
      },
    ],
  },
  {
    key: "qi-tu-chot-thieu-dia-chi",
    title: "Thiếu đúng địa chỉ ⇒ không lên đơn, công cụ chỉ báo trường địa chỉ",
    shop: "food",
    channel: "WEB",
    config: ON,
    turns: [
      {
        say: "Chị lấy 1kg chả cá thu, Lan 0961112223",
        ai: [() => [tool("create_customer", { name: "Lan", phone: "0961112223" })], () => [say("Dạ mình cho em xin địa chỉ giao hàng ạ.")]],
      },
    ],
  },
  {
    key: "qi-tu-chot-can-kiem",
    title: "Đủ đơn nhưng địa chỉ chưa ghép xã / phường ⇒ đơn tự chốt kèm cờ cần kiểm, câu ghi nhận — không «đã lên đơn», không bắt khách xác nhận, không chuyển người",
    shop: "food",
    channel: "WEB",
    config: ON,
    turns: [
      {
        say: `lấy 1kg chả cá thu, Hằng 0962223334, ${BAD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Hằng", phone: "0962223334", address: BAD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Dạ em lên đơn cho mình rồi ạ, shop giao sớm cho mình nha ❤️")],
        ],
      },
    ],
  },
  {
    key: "qi-tu-chot-hoan",
    title: "Khách cho đủ thông tin nhưng còn hoãn («để chị hỏi chồng đã») ⇒ chỉ lên nháp, không tự chốt",
    shop: "food",
    channel: "WEB",
    config: ON,
    turns: [
      {
        say: `1kg chả cá thu, Hà 0971112223, ${GOOD_ADDRESS}, để chị hỏi chồng đã nhé`,
        ai: [
          () => [tool("create_customer", { name: "Hà", phone: "0971112223", address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Dạ vâng, chị hỏi xong nhắn em nhé.")],
        ],
      },
    ],
  },
  {
    key: "qi-don-that-thang-state",
    title: "Đơn nháp được xác nhận NGOÀI lượt chốt của bot (công tắc / nhân viên) ⇒ tin mới của khách: state.confirmed lấy theo đơn thật, lời nhắc nói ĐÃ CHỐT, không xin xác nhận lại",
    shop: "food",
    channel: "WEB",
    config: ON,
    turns: [
      {
        say: `1kg chả cá thu, Minh 0972223334, ${GOOD_ADDRESS}, để chị suy nghĩ thêm`,
        ai: [
          () => [tool("create_customer", { name: "Minh", phone: "0972223334", address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Dạ vâng ạ.")],
        ],
      },
      {
        say: "ship mấy ngày em?",
        before: async ({ conversationId }) => {
          const db = await getDb();
          const [row] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
          const id = (row.state as ChatState).draft?.orderId;
          assert.ok(id, "có đơn nháp");
          await db.update(schema.orders).set({ stage: "CONFIRMED", lastUpdateStatusAt: new Date() }).where(eq(schema.orders.id, id));
        },
        ai: [() => [say("Dạ shop giao 1–2 ngày ạ.")]],
      },
    ],
  },
];

async function testAutoConfirmCases() {
  const seen = new Set<string>();
  await runGoldenCases(AUTO_CASES, {
    orgSuffix: "-qi5",
    beforeCase: async (c, ctx) => {
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
      if (!ctx.ids.has("CCT-1KG")) await seedCct(ctx, 280_000, 540_000);
    },
    afterCase: async (c, ctx, transcript) => {
      seen.add(c.key);
      const { state, order, items } = await orderOfConversation(ctx.conversationId);
      const results = JSON.stringify(transcript.turns.flatMap((t) => t.rounds.map((r) => r.results)));
      const shown = transcript.turns.flatMap((t) => t.shown);
      assert.ok(!shown.some((x) => /lấy thêm gì không|có chốt không|xác nhận giúp em|gửi đơn nhé/i.test(x)), `không câu xin xác nhận chung: ${JSON.stringify(shown)}`);
      if (c.key === "qi-tu-chot-kieu-van-le") {
        assert.ok(order, "có đơn");
        assert.equal(order.stage, "CONFIRMED", "đủ sáu điều kiện ⇒ đơn tự chốt ngay trong lượt");
        assert.equal(order.totalPriceAfterDiscount, 540_000, "tổng = báo giá máy chủ (2 × 1kg − 20k)");
        assert.deepEqual(items.map((i) => [i.quantity, Number(i.unitPrice), Number(i.totalDiscount)]), [[2, 280_000, 20_000]]);
        assert.ok(/"auto_confirmed":true/.test(results), results.slice(0, 400));
        assert.equal(state.confirmed?.valid, true);
        assert.equal(state.stage, "DONE");
        assert.deepEqual(transcript.turns[0].shown, [LE_TEXT], "một câu chốt ngắn — câu giữ lại được gửi SAU khi chốt thành công");
        assert.notEqual(transcript.final.status, "HANDOFF");
        return;
      }
      if (c.key === "qi-tu-chot-thieu-dia-chi") {
        assert.equal(order, null, "thiếu địa chỉ ⇒ chưa lên đơn");
        assert.ok(/"error"/.test(results) && /địa chỉ/.test(results), results.slice(0, 300));
        assert.deepEqual(transcript.turns[0].shown, ["Dạ mình cho em xin địa chỉ giao hàng ạ."]);
        return;
      }
      if (c.key === "qi-tu-chot-can-kiem") {
        assert.ok(order && order.stage === "CONFIRMED", "đơn VẪN được ghi (tự chốt) để vào hàng đợi nhân viên");
        const review = (order.raw as { review?: { entries: { code: string }[] } | null }).review;
        assert.ok(review?.entries.some((e) => e.code === "ADDRESS_UNRESOLVED"), "cờ cần kiểm địa chỉ");
        assert.equal(state.confirmed?.valid, false);
        assert.deepEqual(transcript.turns[0].shown, [CLAIM_SAFE_TEXT.ORDER_RECEIVED], "câu ghi nhận — KHÔNG «đã lên đơn», không «nhân viên xác nhận địa chỉ» (22/10/2026)");
        assert.notEqual(transcript.final.status, "HANDOFF", "không chuyển người — đơn nằm trong hàng «Cần người kiểm»");
        return;
      }
      if (c.key === "qi-don-that-thang-state") {
        assert.equal(state.confirmed?.orderId, order?.id, "state.confirmed dựng từ đơn thật");
        assert.equal(state.confirmed?.auto, true);
        assert.equal(state.stage, "DONE");
        const prompt2 = transcript.prompts[transcript.turns[1].rounds[0].prompt];
        assert.match(prompt2, /ĐƠN CỦA KHÁCH ĐÃ CHỐT/, "lời nhắc lượt sau nói đơn đã chốt");
        assert.match(prompt2, /KHÔNG hỏi khách xác nhận/);
        assert.ok(!/ĐƠN CỦA KHÁCH ĐÃ CHỐT/.test(transcript.prompts[transcript.turns[0].rounds[0].prompt]), "lượt chưa chốt không có dòng đó");
        assert.deepEqual(transcript.turns[1].shown, ["Dạ shop giao 1–2 ngày ạ."], "bot trả lời câu hỏi mới, không chuyển người");
        return;
      }
      // qi-tu-chot-hoan
      assert.ok(order && order.stage === "NEW", "khách còn hoãn ⇒ chỉ lên nháp");
      assert.equal(state.confirmed, undefined);
      assert.ok(/"auto_confirm":false/.test(results) && /chưa quyết mua/.test(results), results.slice(0, 400));
    },
  });
  assert.deepEqual([...seen].sort(), AUTO_CASES.map((c) => c.key).sort());
}

// ═══ GIÁ SỈ BẬT + GIẢM THEO KHỐI LƯỢNG BẬT (P0 11/10/2026, ca «Phạm Minh Ái») ═══
// Trước đây khối giảm khối lượng nằm trong `if (!books)`: tổ chức bật «báo giá sỉ» thì `books` luôn khác null ⇒ khách LẺ mất giảm,
// 2kg chả cá thu 560.000 thay vì 540.000, cộng 1kg chả mực 400.000 ⇒ 960.000 thay vì 940.000.

const mucItem = (variantId: string, price: number) => item(variantId, "1kg", price, { productId: "p-muc", name: "Chả mực" });
const book = (id: string, isDefault: boolean, tiers: { variantId: string; minQuantity: number; unitPrice: number }[]) => ({ id, name: id, isDefault, tiers });

function testWholesalePure() {
  const catalog = [item("v1", "1kg", 280_000), item("v2", "2kg", 540_000), mucItem("m1", 400_000)];
  // Bảng mặc định có bậc sỉ cho chả cá thu 1kg từ 10 túi — khách lẻ mua 2kg CHƯA tới bậc ⇒ giá lẻ ⇒ giảm khối lượng VẪN áp.
  const defaultBook = book("si-mac-dinh", true, [{ variantId: "v1", minQuantity: 10, unitPrice: 240_000 }]);
  const retailBuyer = pricingContextOf(catalog, cfgOf({ wholesalePricing: true }), { customerList: null, defaultList: defaultBook });
  const kg = (n: number, ctx = retailBuyer) => computePriced([{ variantId: "v1", quantity: n }], ctx).subtotal;
  assert.deepEqual([1, 2, 3, 4].map((n) => kg(n)), [280_000, 540_000, 820_000, 1_080_000], "khách lẻ, sỉ bật: 1/2/3/4kg theo PER_STEP 20.000 mỗi 2kg");
  const pack = computePriced([{ variantId: "v2", quantity: 1 }], retailBuyer);
  assert.equal(pack.subtotal, 540_000, "AI chọn gói 2kg ⇒ quy 2 × 1kg − 20.000 = 540.000");
  assert.deepEqual(pack.lines.map((l) => [l.variantId, l.quantity, l.unitPrice, l.discount, l.priceSource]), [["v1", 2, 280_000, 20_000, "RETAIL"]]);
  const ai = computePriced([{ variantId: "v2", quantity: 1 }, { variantId: "m1", quantity: 1 }], retailBuyer);
  assert.equal(ai.subtotal, 940_000, "ca Phạm Minh Ái: 2kg chả cá thu + 1kg chả mực = 940.000 (không phải 960.000)");
  assert.equal(buildQuote(ai, retailBuyer).verified, true);
  // Bảng mặc định KHÔNG có dòng nào cho sản phẩm — vẫn giá lẻ + giảm.
  const emptyBook = pricingContextOf(catalog, cfgOf({ wholesalePricing: true }), { customerList: null, defaultList: book("rong", true, []) });
  assert.equal(computePriced([{ variantId: "v2", quantity: 1 }, { variantId: "m1", quantity: 1 }], emptyBook).subtotal, 940_000);
  // Đủ bậc sỉ của bảng (10 túi) ⇒ giá bảng 240.000, KHÔNG cộng thêm giảm khối lượng.
  const bulk = computePriced([{ variantId: "v1", quantity: 10 }], retailBuyer);
  assert.deepEqual([bulk.subtotal, bulk.lines[0].discount, bulk.lines[0].priceSource], [2_400_000, 0, "DEFAULT_LIST"], "đủ bậc sỉ ⇒ theo bảng, không giảm hai lần");
  // Khách THUỘC NHÓM SỈ (bảng riêng: chả cá thu 1kg từ 1 túi 250.000) ⇒ giá bảng, không giảm khối lượng.
  const wholesaleBuyer = pricingContextOf(catalog, cfgOf({ wholesalePricing: true }), { customerList: book("si-rieng", false, [{ variantId: "v1", minQuantity: 1, unitPrice: 250_000 }]), defaultList: defaultBook });
  const ws = computePriced([{ variantId: "v1", quantity: 2 }], wholesaleBuyer);
  assert.deepEqual([ws.subtotal, ws.lines[0].discount, ws.lines[0].priceSource], [500_000, 0, "CUSTOMER_LIST"], "khách sỉ: 2 × 250.000 theo bảng, không cộng giảm khối lượng");
  // Khách sỉ mua món KHÔNG có trong bảng của mình (chả mực) ⇒ giá lẻ; 2kg chả mực ⇒ giảm khối lượng áp cho đúng sản phẩm đó.
  const wsMuc = computePriced([{ variantId: "v1", quantity: 2 }, { variantId: "m1", quantity: 2 }], wholesaleBuyer);
  assert.equal(wsMuc.subtotal, 500_000 + 780_000, "chả cá theo bảng · chả mực giá lẻ − 20.000");
  // Gói lớn CÓ dòng riêng trong bảng ⇒ giữ nguyên gói (giá bảng của chính gói đó), không quy sang gói đơn vị.
  const packBook = pricingContextOf(catalog, cfgOf({ wholesalePricing: true }), { customerList: book("goi", false, [{ variantId: "v2", minQuantity: 1, unitPrice: 520_000 }]), defaultList: null });
  assert.deepEqual(computePriced([{ variantId: "v2", quantity: 1 }], packBook).lines.map((l) => [l.variantId, l.unitPrice, l.discount]), [["v2", 520_000, 0]]);
  // Bộ quét đơn lệch (ops price-mismatch-scan) — CÙNG computePriced.
  const ok = classifyOrderPrice([{ variantId: "v1", quantity: 2, unitPrice: 280_000, discount: 20_000 }, { variantId: "m1", quantity: 1, unitPrice: 400_000, discount: 0 }], [retailBuyer]);
  assert.deepEqual([ok.kind, ok.actual, ok.expected], ["OK", 940_000, 940_000]);
  const bug = classifyOrderPrice([{ variantId: "v1", quantity: 2, unitPrice: 280_000, discount: 0 }, { variantId: "m1", quantity: 1, unitPrice: 400_000, discount: 0 }], [retailBuyer]);
  assert.deepEqual([bug.kind, bug.actual, bug.expected, bug.missingVolumeDiscount, bug.multiUnit], ["PRICE_MISMATCH", 960_000, 940_000, true, true], "đơn 960.000 của lỗi cũ ⇒ PRICE_MISMATCH + thiếu giảm khối lượng");
  const viaBook = classifyOrderPrice([{ variantId: "v1", quantity: 2, unitPrice: 250_000, discount: 0 }], [retailBuyer, wholesaleBuyer]);
  assert.equal(viaBook.kind, "OK", "đơn khách sỉ theo bảng riêng ⇒ khớp ngữ cảnh thứ hai");
  const changed = classifyOrderPrice([{ variantId: "v1", quantity: 1, unitPrice: 300_000, discount: 0 }], [retailBuyer]);
  assert.deepEqual([changed.kind, changed.missingVolumeDiscount], ["PRICE_MISMATCH", false], "giá danh mục đổi ≠ thiếu giảm khối lượng");
  assert.equal(classifyOrderPrice([{ variantId: "xoa", quantity: 1, unitPrice: 1, discount: 0 }], [retailBuyer]).kind, "UNPRICEABLE");
  const at = new Date("2026-10-11T12:00:00Z");
  assert.deepEqual(parsePriceScanArgs(["hslc", "--days=30"], at), { code: "hslc", days: 30, since: null, flag: false, apply: false });
  assert.ok("error" in parsePriceScanArgs(["hslc", "--days=99"], at));
  assert.ok("error" in parsePriceScanArgs([], at));
  assert.equal((parsePriceScanArgs(["hslc", "--since=2026-10-11T14:30:00+07:00"], at) as { since: Date }).since.toISOString(), "2026-10-11T07:30:00.000Z", "mốc deploy giờ VN");
  assert.ok("error" in parsePriceScanArgs(["hslc", "--since=2026-10-12"], at), "mốc ở tương lai");
  assert.ok("error" in parsePriceScanArgs(["hslc", "--since=2026-01-01"], at), "mốc cũ hơn 60 ngày");
  assert.ok("error" in parsePriceScanArgs(["hslc", "--since=hom-qua"], at));
  assert.ok("error" in parsePriceScanArgs(["hslc", "--apply"], at), "--apply chỉ đi cùng --flag");
  assert.ok("error" in parsePriceScanArgs(["hslc", "--fix"], at), "cờ lạ");
  assert.deepEqual(["flag", "apply"].map((k) => (parsePriceScanArgs(["hslc", "--flag", "--apply"], at) as Record<string, unknown>)[k]), [true, true]);
  // Chế độ giá lẻ (sỉ tắt) không đổi: 940.000.
  const retail = pricingContextOf(catalog, cfgOf(), null);
  assert.equal(computePriced([{ variantId: "v2", quantity: 1 }, { variantId: "m1", quantity: 1 }], retail).subtotal, 940_000);
}

/** Tổ chức thật: bật CẢ báo giá sỉ (bảng mặc định có bậc từ 10 túi) VÀ giảm theo khối lượng — khách lẻ. */
const WS: Partial<SalesChatbotConfig> = { ...ON, wholesalePricing: true };
const WHOLESALE_CASES: GoldenCase[] = [
  {
    key: "qi-pham-minh-ai",
    title: "Ca Phạm Minh Ái: sỉ bật + giảm khối lượng bật, khách lẻ 2kg chả cá thu + 1kg chả mực ⇒ báo giá = đơn = 940.000 (2kg = 540.000)",
    shop: "food",
    channel: "WEB",
    config: WS,
    turns: [
      {
        say: "2kg chả cá thu với 1kg chả mực bao nhiêu em",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }, { variant_id: v("CM-1KG"), quantity: 1 }] })], () => [say("Dạ 2kg chả cá thu 540.000 ₫ và 1kg chả mực 400.000 ₫, tiền hàng 940.000 ₫ ạ.")]],
      },
      {
        say: `lấy nhé, Phạm Minh Ái 0983334445, ${GOOD_ADDRESS}`,
        ai: [
          () => [tool("create_customer", { name: "Phạm Minh Ái", phone: "0983334445", address: GOOD_ADDRESS })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }, { variant_id: v("CM-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 2kg chả cá thu 540.000 ₫ + 1kg chả mực 400.000 ₫. Mình xác nhận giúp em nhé?")],
        ],
      },
    ],
  },
  {
    key: "qi-si-bat-3kg",
    title: "Sỉ bật + giảm bật, khách lẻ 3kg ⇒ 820.000 (PER_STEP: 20.000 mỗi 2kg)",
    shop: "food",
    channel: "WEB",
    config: WS,
    turns: [{ say: "3kg chả cá thu bao nhiêu", ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 3 }] })], () => [say("Dạ 3kg chả cá thu 820.000 ₫ ạ.")]] }],
  },
];

async function testWholesaleCases() {
  const seen = new Set<string>();
  await runGoldenCases(WHOLESALE_CASES, {
    orgSuffix: "-qi6",
    beforeCase: async (c, ctx) => {
      if (ctx.ids.has("CCT-1KG")) return;
      await seedCct(ctx, 280_000, 540_000);
      const admin = await ctx.admin();
      const r = await createProductCore(admin, { name: "Chả mực", code: "CM", unit: "gói", retailPrice: 400_000, cost: null, variants: [{ sku: "CM-1KG", size: "1kg", color: "", retailPrice: 400_000, cost: null, selling: true }] });
      assert.ok(r.ok, JSON.stringify(r));
      const db = await getDb();
      const [v] = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id));
      (ctx.ids as Map<string, string>).set("CM-1KG", v.id);
      // Bảng giá sỉ MẶC ĐỊNH: chả cá thu 1kg từ 10 túi 240.000 — khách lẻ 2–4kg chưa tới bậc.
      const [pl] = await db.insert(schema.priceLists).values({ name: "Sỉ", isDefault: true, active: true }).returning({ id: schema.priceLists.id });
      await db.insert(schema.priceListItems).values({ priceListId: pl.id, variantId: ctx.ids.get("CCT-1KG")!, minQuantity: 10, unitPrice: 240_000 });
    },
    afterCase: async (c, ctx, transcript) => {
      seen.add(c.key);
      const results = JSON.stringify(transcript.turns.flatMap((t) => t.rounds.map((r) => r.results)));
      if (c.key === "qi-si-bat-3kg") {
        assert.match(results, /"subtotal":820000/, results.slice(0, 500));
        assert.deepEqual(transcript.turns[0].shown, ["Dạ 3kg chả cá thu 820.000 ₫ ạ."], "820k thuộc báo giá ⇒ không bị chặn");
        return;
      }
      assert.match(JSON.stringify(transcript.turns[0].rounds.map((r) => r.results)), /"subtotal":940000/, "calculate_cart = 940.000");
      assert.deepEqual(transcript.turns[0].shown, ["Dạ 2kg chả cá thu 540.000 ₫ và 1kg chả mực 400.000 ₫, tiền hàng 940.000 ₫ ạ."], "chữ AI 540k / 940k khớp báo giá ⇒ tới khách");
      const { order, items, state } = await orderOfConversation(ctx.conversationId);
      assert.ok(order, "có đơn");
      assert.equal(order.totalPriceAfterDiscount, 940_000, "tổng đơn = 940.000");
      const cct = ctx.ids.get("CCT-1KG");
      const rows = items.map((i) => [i.variantId === cct ? "CCT-1KG" : "CM-1KG", i.quantity, Number(i.unitPrice), Number(i.totalDiscount)]).sort();
      assert.deepEqual(rows, [["CCT-1KG", 2, 280_000, 20_000], ["CM-1KG", 1, 400_000, 0]], "dòng đơn: 2 × 280.000 − 20.000 · 400.000");
      assert.equal(state.quote?.subtotal, 940_000);
      assert.equal(state.quote?.verified, true);
      assert.equal((order.raw as { quote?: { subtotal: number } }).quote?.subtotal, 940_000, "báo giá lưu vào đơn = 940.000");
      // ops price-mismatch-scan trên CSDL thật: đơn đúng ⇒ OK; giả lập đơn cũ (mất 20.000 giảm) ⇒ PRICE_MISMATCH + thiếu giảm.
      const db = await getDb();
      const mine = (await scanBotOrders(db, 1)).find((r) => r.id === order.id);
      assert.equal(mine?.verdict.kind, "OK", JSON.stringify(mine));
      await db.update(schema.orderItems).set({ totalDiscount: 0 }).where(eq(schema.orderItems.orderId, order.id));
      const old = (await scanBotOrders(db, 1)).find((r) => r.id === order.id);
      assert.deepEqual([old?.verdict.kind, old?.verdict.actual, old?.verdict.expected, old?.verdict.missingVolumeDiscount, old?.verdict.multiUnit], ["PRICE_MISMATCH", 960_000, 940_000, true, true]);
      // --since: chỉ đơn tạo SAU mốc ⇒ đơn này (tạo trước mốc) không được đếm — «mismatch MỚI».
      assert.equal((await scanBotOrders(db, 1, new Date(), new Date(Date.now() + 60_000))).some((r) => r.id === order.id), false, "--since sau đơn ⇒ không đếm");
      // --flag: chạy thử không ghi; --apply gắn cờ PRICE_MISMATCH + số đúng, KHÔNG đổi giá; chạy lại không gắn lại.
      const mineOf = (rows: Awaited<ReturnType<typeof scanBotOrders>>) => rows.filter((r) => r.id === order.id);
      const plan = planMismatchFlags(mineOf(await scanBotOrders(db, 1)));
      assert.deepEqual(plan.map((p) => p.action), ["FLAG"]);
      assert.match(plan[0].note, /960\.000.*940\.000.*chênh 20\.000.*thiếu giảm theo khối lượng/);
      assert.deepEqual(await applyMismatchFlags(plan, false), { flagged: [], failed: [] }, "chạy thử ⇒ không ghi");
      const rawOf = async () => (await db.select({ raw: schema.orders.raw, total: schema.orders.totalPriceAfterDiscount }).from(schema.orders).where(eq(schema.orders.id, order.id)))[0];
      assert.equal(orderReviewOf((await rawOf()).raw)?.entries.some((e) => e.code === "PRICE_MISMATCH") ?? false, false);
      assert.deepEqual(await applyMismatchFlags(plan, true), { flagged: [order.id], failed: [] });
      const after = await rawOf();
      const flag = orderReviewOf(after.raw)?.entries.find((e) => e.code === "PRICE_MISMATCH");
      assert.ok(flag && /940\.000/.test(flag.note), JSON.stringify(after.raw));
      assert.equal(after.total, order.totalPriceAfterDiscount, "gắn cờ KHÔNG đổi giá đơn");
      const again = planMismatchFlags(mineOf(await scanBotOrders(db, 1)));
      assert.deepEqual(again.map((p) => p.action), ["ALREADY_FLAGGED"]);
      assert.deepEqual(await applyMismatchFlags(again, true), { flagged: [], failed: [] }, "idempotent");
      // Người đã kiểm cờ (vết reviewLog) ⇒ không gắn lại.
      const resolved = withReviewResolved(after.raw as Record<string, unknown>, { action: "CONFIRMED", at: new Date().toISOString(), byUserId: null, byName: "Kiểm thử" });
      await db.update(schema.orders).set({ raw: resolved.raw }).where(eq(schema.orders.id, order.id));
      assert.deepEqual(planMismatchFlags(mineOf(await scanBotOrders(db, 1))).map((p) => p.action), ["ALREADY_REVIEWED"]);
      // Đơn đã qua giai đoạn gắn cờ ⇒ liệt kê riêng, không gắn.
      await db.update(schema.orders).set({ raw: after.raw, stage: "SHIPPED" }).where(eq(schema.orders.id, order.id));
      await db.update(schema.orders).set({ raw: { ...(after.raw as Record<string, unknown>), review: null } }).where(eq(schema.orders.id, order.id));
      assert.deepEqual(planMismatchFlags(mineOf(await scanBotOrders(db, 1))).map((p) => p.action), ["STAGE_LOCKED"]);
    },
  });
  assert.deepEqual([...seen].sort(), WHOLESALE_CASES.map((c) => c.key).sort());
}

export async function testSalesQuoteIntegrity() {
  testExtract();
  testQuotePure();
  testVerdictPure();
  testDisputePure();
  testWholesalePure();
  testAutoConfirmPure();
  // Tiền đề của hai hội thoại địa chỉ: địa chỉ «tốt» ghép được xã / phường, địa chỉ «xấu» thì không.
  assert.ok(resolveRecipientPlace({ address: GOOD_ADDRESS, province: "" }).ward, `địa chỉ tốt phải ghép được xã: ${JSON.stringify(resolveRecipientPlace({ address: GOOD_ADDRESS, province: "" }))}`);
  assert.equal(resolveRecipientPlace({ address: BAD_ADDRESS, province: "" }).ward, "", "địa chỉ xấu không ghép được xã");
  await testRuleOn();
  await testRuleOff();
  await testDisputeCases();
  await testAutoConfirmCases();
  await testWholesaleCases();
  console.log("  ✓ báo giá máy chủ (quote.ts): một phép tính cho giỏ · đơn · lõi; 2kg = 2 × 1kg − giảm, cùng mã báo giá; catalog mâu thuẫn / thiếu khối lượng ⇒ chưa xác thực (tái hiện 540 / 560); số tiền trong chữ bot phải thuộc báo giá đã xác thực — 540k khi báo giá 560k bị chặn + PRICE_UNVERIFIED; câu mẫu / lời chào lệch giá bị chặn; giá chưa xác thực ⇒ không tạo đơn; sỉ bật + khách lẻ ⇒ giảm khối lượng vẫn áp (Phạm Minh Ái 940.000), khách sỉ theo bảng không cộng giảm, bộ quét đơn lệch; khách phản đối giá ⇒ có căn cứ thì báo lại + xin xác nhận, không thì chuyển người (PRICE_DISPUTED), đơn mang cờ; đổi số lượng ⇒ xin xác nhận tổng mới; đóng gói riêng đổi giá ⇒ shop quyết; đơn cần kiểm địa chỉ ⇒ «đã lên đơn» bị thay, không chuyển người; tổng đơn ≠ báo giá ⇒ lõi không ghi; mã + phiên bản giá lưu vào đơn");
}

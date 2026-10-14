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
import { and, desc, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { createProductCore } from "@/lib/records/product-create";
import { applyCustomerCartMessage, bindCommitment, buyingText, commitmentViolation, invitedProductOf, lineBasisViolation, unrequestedProducts, type AskedLine, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { claimFactsLoader, claimVerdict, CLAIM_SAFE_TEXT, extractVndAmounts, guardClaims, serverTotalText, totalAllowedOf, totalClaimsIn, type ClaimFacts } from "@/lib/sales-chatbot/claim-guard";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { draftSummaryFromTool, EMPTY_REPLY_TEXT, isEchoOfShop, silenceFallbackText } from "@/lib/sales-chatbot/engine";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import type { QuoteSnapshot } from "@/lib/sales-chatbot/quote-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { orderReviewOf } from "@/lib/constants/order-review";
import { setSettingJson } from "@/lib/settings";
import { readFileSync } from "node:fs";
import { applyUpsellFlags, basisVerdictOf, parseUpsellScanArgs, planUpsellFlags, scanUpsellBasis } from "../scripts/upsell-basis-scan";
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
  assert.deepEqual([[...t1.allowed], t1.current, t1.stale], [[310_000, 280_000], { total: 310_000, shipping: 30_000 }, false]);
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
  const q = guardClaims("Đơn combo hôm nay của mình tổng chỉ 540k, free ship ạ", facts);
  assert.ok(!q.ok && q.safeText === "Dạ tổng đơn của mình là 280.000 ₫ (miễn phí ship) ạ.", "câu mẫu có tổng cố định ≠ báo giá ⇒ thay bằng tổng máy chủ");
  // Báo giá đã cũ (khách đổi số lượng) ⇒ không có tổng nào để nói ⇒ chặn + chuyển người.
  const s = guardClaims("Đơn của mình tổng 280.000đ ạ", { ...facts, totals: stale });
  assert.ok(!s.ok && s.handoff && s.safeText === CLAIM_SAFE_TEXT.PRICE);
  // Chưa có giỏ: số «tổng» xét như mọi số tiền (tập tham chiếu) — không chặn bảng giá trước khi khách chọn.
  assert.ok(guardClaims("Combo 2kg tổng 540k ạ", { ...BASE, allowedAmounts: REFERENCE }).ok);
}

function testPureFlow() {
  const L = (productId: string, variantId: string, name: string) => ({ productId, variantId, name, quantity: 1, weightGrams: 1000 });
  const cart: CartCommitment = { selectedItems: [{ label: "chả cá thu", match: "cha ca thu", productId: null, variantId: null, sku: null, quantity: 1000, unit: "g", sourceMessageId: 1, confidence: "HIGH", customerExplicit: true }], turn: 1, at: iso(0) };
  assert.deepEqual(unrequestedProducts(cart, [L("p-cct", "v1", "Chả cá thu (1kg)")]), []);
  assert.deepEqual(unrequestedProducts(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-muc", "v2", "Chả mực giã tay (1kg)")]), ["Chả mực giã tay"], "món mời chưa được khách nói ⇒ bị chỉ ra");
  assert.match(lineBasisViolation(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-nem", "v3", "Nem hải sản tôm bề bề (Hộp 10 cái)")]) ?? "", /KHÔNG đưa «Nem hải sản tôm bề bề» vào đơn: khách CHƯA nói lấy món này/, "ca «Châu Dương»: món upsell không có căn cứ");
  // Khách nói «lấy thêm 1 hộp nem» ⇒ giỏ có món đó (1 gói) ⇒ có căn cứ; bot tự đặt × 3 ⇒ chặn.
  const withNem: CartCommitment = { ...cart, selectedItems: [...cart.selectedItems, { label: "nem", match: "nem", productId: null, variantId: null, sku: null, quantity: 1, unit: "pack", sourceMessageId: 3, confidence: "HIGH", customerExplicit: true }] };
  const nem = (q: number) => ({ productId: "p-nem", variantId: "v3", name: "Nem hải sản tôm bề bề (Hộp 10 cái)", quantity: q, weightGrams: null });
  assert.equal(lineBasisViolation(withNem, [L("p-cct", "v1", "Chả cá thu (1kg)"), nem(1)]), null, "khách nói tên + số lượng ⇒ thêm đúng 1");
  assert.match(lineBasisViolation(withNem, [L("p-cct", "v1", "Chả cá thu (1kg)"), nem(3)]) ?? "", /KHÔNG tự tăng «nem» lên 3/, "bot không tự đặt × 3");
  assert.match(lineBasisViolation(cart, [{ ...L("p-cct", "v1", "Chả cá thu (1kg)"), quantity: 2 }]) ?? "", /KHÔNG tự tăng «chả cá thu» lên 2kg: khách nói 1kg/);
  // Khách GỌI TÊN món mà máy không đọc được số lượng («thêm 1 ruốc tôm») ⇒ có căn cứ; «chả cá» không gọi tên «Chả mực giã tay».
  assert.equal(lineBasisViolation(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-ruoc", "v4", "Ruốc bông tôm 100%")], null, "cho chị 1kg chả cá thu, thêm 1 ruốc tôm"), null);
  assert.ok(lineBasisViolation(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-muc", "v2", "Chả mực giã tay (1kg)")], null, "cho chị 1kg chả cá thu") !== null);
  assert.ok(lineBasisViolation(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-nem", "v3", "Nem hải sản tôm bề bề (Hộp 10 cái)")], null, "1kg chả cá thu\nok em") !== null, "«ok» không gọi tên món mời");
  assert.equal(lineBasisViolation({ ...cart, relaxedTurn: 5 }, [{ ...L("p-cct", "v1", "Chả cá thu (1kg)"), quantity: 2 }], 5), null, "lượt khách sửa mà máy chưa chắc ⇒ không chặn số lượng");
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

function testUpsellScanPure() {
  assert.deepEqual(parseUpsellScanArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", days: 7, flag: false, apply: false });
  assert.deepEqual(parseUpsellScanArgs(["hslc", "--days=7", "--flag", "--apply"]), { code: "hslc", days: 7, flag: true, apply: true });
  for (const bad of [[], ["hslc", "--apply"], ["hslc", "--days=31"], ["hslc", "--xoa"]]) assert.ok("error" in parseUpsellScanArgs(bad), bad.join(" "));
  const at = new Date();
  const asked = [
    { productId: "p-cct", variantId: "v1", name: "Chả cá thu (1kg)", quantity: 1, weightGrams: 1000 },
    { productId: "p-nem", variantId: "v3", name: "Nem hải sản tôm bề bề (Hộp 10 cái)", quantity: 3, weightGrams: null },
  ];
  const catalog = ["Chả cá thu", "Nem hải sản tôm bề bề"];
  const C = (text: string, seq: number) => ({ kind: "CUSTOMER" as const, text, seq, at });
  const W = (a: AskedLine[], seq: number) => ({ kind: "DRAFT_WRITE" as const, asked: a, seq, at });
  // Ca «Châu Dương» phát lại ĐÚNG đường máy chủ: lần ghi đầu 1kg (có căn cứ) ⇒ «ok» sau lời mời ⇒ lần ghi thêm nem × 3 ⇒ NO_BASIS.
  assert.equal(basisVerdictOf([C("Cho chị 1kg chả cá thu", 1), W([asked[0]], 2), { kind: "BOT", text: "Shop còn Nem hải sản tôm bề bề 120k ạ" }, C("ok em", 3), W(asked, 4)], catalog).kind, "NO_BASIS");
  // Khách nói «lấy thêm 3 hộp nem» ⇒ có căn cứ; món đã ở lần ghi trước không bị bắt lại.
  assert.equal(basisVerdictOf([C("Cho chị 1kg chả cá thu", 1), W([asked[0]], 2), C("lấy thêm 3 hộp nem nhé", 3), W(asked, 4)], catalog).kind, "OK");
  // Câu hỏi giá không phải căn cứ (cùng `buyingText` với máy chủ).
  assert.equal(basisVerdictOf([C("Cho chị 1kg chả cá thu", 1), W([asked[0]], 2), C("nem tôm bao nhiêu em?", 3), C("ok em", 4), W(asked, 5)], catalog).kind, "NO_BASIS");
  assert.equal(basisVerdictOf([C("shop ơi", 1), W(asked, 2)], catalog).kind, "UNKNOWN", "không có món khách nói ⇒ không kết luận");
  const src = readFileSync("scripts/upsell-basis-scan.ts", "utf8");
  assert.match(src, /if \(CHAY_THANG && !SE_GHI\) process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.ok(!/\(\?<[=!]/.test(src), "không nhìn-ngược");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- upsell-basis-scan\s+#/);
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bupsell-basis-scan\b/);
  assert.match(ops, /DOC_NANG="[^"]*\bupsell-basis-scan\b/);
  assert.match(ops, /\n\s+upsell-basis-scan\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/upsell-basis-scan\.ts ;;/);
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/upsell-basis-scan.ts":'));
}

// ═══ REVIEW ĐỘC LẬP 14/10 — mọi repro thành bài kiểm ═══

const CAT1 = ["Chả cá thu", "Chả mực giã tay", "Nem hải sản tôm bề bề", "Ruốc bông tôm 100%", "Combo ăn vặt 3 món"];
const CAT2 = [...CAT1, "Nem chua Thanh Hoá"];
const cct = (q = 1): AskedLine => ({ productId: "p-cct", variantId: "v-cct1", name: "Chả cá thu (1kg)", quantity: q, weightGrams: 1000 });
const nemL = (q = 1): AskedLine => ({ productId: "p-nem", variantId: "v-nem", name: "Nem hải sản tôm bề bề (Hộp 10 cái)", quantity: q, weightGrams: null });
const comboL = (q = 1): AskedLine => ({ productId: "p-combo", variantId: "v-combo", name: "Combo ăn vặt 3 món", quantity: q, weightGrams: null });
const catFor = (t: string, cat: string[]) => (/\d|nửa|một|hai|ba |bỏ|hủy|huỷ|bo |huy /i.test(t) ? cat : undefined);

/**
 * Đi đúng đường của engine: tin «Cho chị 1kg chả cá thu» + đơn nháp 1kg đã gắn; mỗi tin sau áp lên giỏ (kèm món vừa được mời từ chữ bot
 * trước nó); CHỮ MUA = `buyingText`; sản phẩm của đơn nháp hiện có là căn cứ sẵn.
 */
function review(msgs: string[], asked: AskedLine[], cat = CAT1, bot: Record<number, string> = {}) {
  const at = new Date();
  let cart = applyCustomerCartMessage(undefined, "Cho chị 1kg chả cá thu", 1, at, { catalog: cat });
  cart = bindCommitment(cart, [cct()], 1, at);
  msgs.forEach((m, i) => {
    const said = bot[i] ? [bot[i]] : [];
    cart = applyCustomerCartMessage(cart, m, i + 2, at, { catalog: catFor(m, cat), invited: invitedProductOf(said, cat, cart) });
  });
  const turn = msgs.length + 1;
  return { cart, basis: lineBasisViolation(cart, asked, turn, buyingText(["Cho chị 1kg chả cá thu", ...msgs]), new Set(["p-cct"])), lower: commitmentViolation(cart, asked, turn) };
}
const cctGrams = (c: CartCommitment | undefined) => c?.selectedItems.find((x) => /cha ca/.test(x.match))?.quantity;

function testReviewRepros() {
  // P0-1: món ĐÃ trong đơn nháp không bị coi là «không căn cứ».
  assert.equal(review(["[Khách gửi ảnh: hộp nhựa màu cam]", "lấy cái này nhé", "thêm 2 hộp nem tôm"], [cct(), nemL(2)]).basis, null, "P0-1a");
  assert.equal(review(["như lần trước nhé em", "thêm 1 hộp nem tôm"], [cct(), nemL(1)]).basis, null, "P0-1b");
  // P0-2: tên mơ hồ / đơn vị là tên món / món vừa được mời — số lượng không rơi về món sẵn có.
  const a = review(["lấy thêm 1 hộp nem đi em"], [cct()], CAT2);
  assert.equal(cctGrams(a.cart), 1000, "P0-2a «1 hộp nem» khi có hai loại nem ⇒ chả cá GIỮ 1kg");
  assert.equal(a.lower, null, "P0-2a đơn 1kg chả cá không bị coi là hạ số lượng");
  assert.equal(cctGrams(review(["lấy 3 hộp nem luôn"], [cct()], CAT2).cart), 1000, "P0-2b chả cá không thành × 3");
  const c = review(["thêm 1 combo nữa"], [cct(), comboL(1)]);
  assert.equal(cctGrams(c.cart), 1000, "P0-2c «1 combo» không cộng vào chả cá");
  assert.equal(c.basis, null, "P0-2c combo là món khách gọi bằng chính đơn vị");
  const invite = "Dạ shop còn Nem hải sản tôm bề bề hộp 10 cái 120.000 ₫, mình lấy thêm không ạ?";
  assert.equal(review(["ừ cho chị 1 hộp"], [cct(), nemL(1)], CAT1, { 0: invite }).basis, null, "P0-2d sau lời mời MỘT món ⇒ «1 hộp» là món đó");
  assert.match(review(["ừ cho chị 1 hộp"], [cct(), nemL(3)], CAT1, { 0: invite }).basis ?? "", /KHÔNG tự tăng/, "P0-2d bot không tự đặt × 3");
  assert.equal(cctGrams(review(["ừ cho chị 1 hộp"], [cct(), nemL(1)], CAT1, { 0: invite }).cart), 1000, "P0-2d chả cá giữ 1kg");
  assert.equal(review(["lấy thêm nem nhé", "1 hộp"], [cct(), nemL(1)], CAT1, { 1: "Dạ mình lấy mấy hộp nem hải sản tôm ạ?" }).basis, null, "P0-2e bot hỏi số lượng, khách «1 hộp» ⇒ thêm được");
  // P0-3: câu từ chối / hỏi giá KHÔNG phải căn cứ; gọi tên không số lượng ⇒ tối đa 1.
  assert.ok(review(["không lấy nem tôm đâu em"], [cct(), nemL(3)]).basis !== null, "P0-3a");
  assert.ok(review(["nem tôm bao nhiêu em?", "ok em"], [cct(), nemL(3)]).basis !== null, "P0-3b");
  assert.match(review(["lấy thêm nem tôm nhé"], [cct(), nemL(3)]).basis ?? "", /KHÔNG tự đặt 3 × «Nem hải sản tôm bề bề»/, "P0-3c gọi tên không số lượng ⇒ không tự đặt 3");
  assert.equal(review(["lấy thêm nem tôm nhé"], [cct(), nemL(1)]).basis, null, "P0-3c gọi tên ⇒ 1 được");
  assert.equal(buyingText(["không lấy nem tôm đâu em", "nem tôm bao nhiêu em?", "chả mực giã tay 1kg nhé", "chả bò 2 hộp"]), "chả mực giã tay 1kg nhé\nchả bò 2 hộp", "«giã» / «bò» không bị coi là hỏi giá / bỏ");
  // P1 (review vòng 2): hoãn · hỏi không dấu «?» · hỏi tồn ⇒ không phải lời mua; «lấy 1 hộp nem ạ» vẫn là lời mua.
  for (const t of ["nem tôm thì để lần sau nha", "nem tôm ngon ko em", "nem tôm hết rồi hả", "nem tôm để chị xem đã", "nem tôm còn hàng không"]) {
    assert.equal(buyingText([t]), "", `không phải lời mua: ${t}`);
    assert.ok(review([t, "ok"], [cct(), nemL(1)]).basis !== null, `nem × 1 không có căn cứ sau «${t}»`);
  }
  assert.equal(buyingText(["lấy thêm 1 hộp nem ạ"]), "lấy thêm 1 hộp nem ạ");
  // FAIL-2 (review vòng 2): sau lời mời MỘT món, số KHỐI LƯỢNG khi món chính tính theo khối lượng vẫn là của món chính.
  for (const t of ["cho chị 2kg nhé", "cho chị thêm 1kg"]) {
    const r = review([t], [cct(2)], CAT1, { 0: invite });
    assert.equal(cctGrams(r.cart), 2000, `«${t}» ⇒ chả cá 2kg, không phải nem`);
    assert.ok(!r.cart?.selectedItems.some((x) => /nem/.test(x.match)), `«${t}» không đẻ món nem`);
    assert.equal(r.basis, null, `«${t}» đơn chả cá 2kg có căn cứ`);
  }
  // Minor: «thêm 2 hộp nem» ngay sau lời mời ĐÚNG Nem hải sản, danh mục có hai loại nem ⇒ lời mời thắng sự mơ hồ.
  const invC2 = review(["thêm 2 hộp nem"], [cct(), nemL(2)], CAT2, { 0: invite });
  assert.equal(invC2.basis, null, "lời mời một món thắng tên mơ hồ");
  assert.equal(invC2.cart?.selectedItems.find((x) => /nem/.test(x.match))?.quantity, 2);

  // P1-4: chỉ số CHẮC CHẮN là tổng mới bị thay; câu giả định / phí ship / liệt kê đi đường kiểm số cũ.
  const draft = { orderId: "erp-x", lines: [{ variantId: "v1", quantity: 1 }], unitPrices: { v1: 280_000 }, recipient: { name: "K", phone: "0961000000", address: "x", province: "y" }, note: "", simulated: false, quote: { id: "qd", priceVersion: "p", subtotal: 280_000, total: 310_000 } };
  const totals = totalAllowedOf({ quote: quote(540_000, 570_000), draft })!;
  assert.deepEqual(totals.current, { total: 310_000, shipping: 30_000 }, "đơn nháp thắng báo giá phương án 2kg");
  const facts: ClaimFacts = { ...BASE, allowedAmounts: new Set([...REFERENCE, 400_000, 120_000, 310_000]), totals };
  for (const t of ["Dạ nếu chị lấy 2kg thì tổng 540k ạ", "Dạ chả cá thu 280k/kg, mình thanh toán khi nhận hàng (COD) ạ", "Dạ thanh toán 30k ship ạ, hàng 280k", "Dạ tổng cộng có 3 loại: chả cá 280k, chả mực 400k, nem 120k ạ", "Dạ em tổng hợp lại đơn: 1kg chả cá 280k, ship 30k, tổng cộng 310k. Chị xác nhận giúp em nhé"]) {
    assert.ok(guardClaims(t, facts).ok, `không thay nhầm: ${t}`);
  }
  for (const t of ["Dạ nếu chị lấy 2kg thì tổng 540k ạ", "Dạ chả cá thu 280k/kg… COD", "Dạ thanh toán 30k ship ạ, hàng 280k", "Dạ tổng cộng có 3 loại: chả cá 280k", "Thêm 1 hộp nem 120k thì tổng 430k ạ"]) assert.deepEqual(totalClaimsIn(t), [], `không phải số tổng: ${t}`);
  // Số cạnh chữ «tổng thanh toán»: tổng của báo giá máy chủ gần nhất ⇒ qua; không phải tổng nào của giỏ ⇒ CHẶN + người, KHÔNG chèn 310.000.
  const option = guardClaims("Dạ 2kg là 540k, tổng thanh toán 570k gồm ship ạ", { ...facts, allowedAmounts: new Set([...facts.allowedAmounts!, 570_000]) });
  assert.ok(option.ok, "570k là tổng của báo giá máy chủ gần nhất (phương án 2kg) ⇒ hợp lệ, không bị thay bằng tổng đơn");
  const option2 = guardClaims("Dạ 2kg là 540k, tổng thanh toán 590k gồm ship ạ", facts);
  assert.ok(!option2.ok && option2.safeText === CLAIM_SAFE_TEXT.PRICE && option2.handoff, "số cạnh «tổng thanh toán» không phải tổng nào của giỏ ⇒ chặn + người, không chèn 310.000");
  const notOrder = guardClaims("Dạ tổng 1kg chả cá là 280k ạ", facts);
  assert.ok(notOrder.ok, "câu không nói về đơn ⇒ không chèn tổng đơn");
  // Câu nói về ĐƠN mà tổng sai ⇒ nói lại đúng tổng đơn nháp.
  const wrong = guardClaims("Dạ đơn của mình tổng 640.000đ, miễn phí ship ạ", facts);
  assert.ok(!wrong.ok && wrong.safeText === "Dạ tổng đơn của mình là 310.000 ₫ (đã gồm 30.000 ₫ phí ship) ạ.", JSON.stringify(wrong));
  // FAIL-1 (review vòng 2): mọi câu đưa 640.000 cạnh chữ tổng / thanh toán / COD khi đơn nháp 280.000 ⇒ KHÔNG BAO GIỜ tới khách nguyên văn,
  // dù 640.000 có trong tập tham chiếu; câu không chắc ⇒ chặn + người (không chèn số); câu chắc là tổng ĐƠN ⇒ nói lại đúng tổng đơn nháp.
  const draft280 = { ...draft, quote: { id: "qd2", priceVersion: "p", subtotal: 280_000, total: 280_000 } };
  const f640: ClaimFacts = { ...BASE, allowedAmounts: new Set([...REFERENCE, 640_000]), totals: totalAllowedOf({ quote: quote(280_000, 280_000), draft: draft280 }) };
  for (const t of [
    "Dạ tổng 640k, miễn phí ship ạ",
    "Dạ tổng của mình 640k… Chị xác nhận giúp em nhé",
    "Dạ đơn của mình tổng 640k ạ, nếu chị cần thêm gì cứ nhắn em",
    "Dạ đơn của chị thì tổng 640k ạ",
    "Dạ đơn mình tổng là: 640.000 ₫ ạ",
    "Dạ đơn hàng tổng tiền phải thanh toán là 640.000đ",
    "Dạ thu hộ COD 640k cho đơn của mình ạ",
    "Dạ chị thanh toán 640k khi nhận đơn ạ",
    "Dạ em lên đơn 1kg chả cá thu 280.000đ. Tổng 640.000đ, miễn phí ship ạ",
  ]) {
    const v = guardClaims(t, f640);
    assert.ok(!v.ok, `640.000 không được tới khách: ${t}`);
    assert.ok(v.safeText === CLAIM_SAFE_TEXT.PRICE || v.safeText === "Dạ tổng đơn của mình là 280.000 ₫ (miễn phí ship) ạ." || v.claim === "ORDER_CONFIRMED", `chỉ câu an toàn hoặc đúng tổng đơn nháp: ${t} ⇒ ${v.safeText}`);
    assert.ok(!v.safeText.includes("640"), t);
  }
  for (const t of ["Dạ shop ship COD toàn quốc, chả cá thu 280k/kg ạ", "Dạ phí ship 30k, thanh toán khi nhận ạ", "Dạ tổng 1kg chả cá là 280k ạ", "Dạ chuyển khoản trước thì thanh toán 280k, free ship ạ"]) assert.ok(guardClaims(t, f640).ok, `câu đúng không bị chặn: ${t}`);
  const hypo = guardClaims("Thêm 1 hộp nem 120k thì tổng 430k ạ", facts);
  assert.ok(!hypo.ok && hypo.safeText === CLAIM_SAFE_TEXT.PRICE && hypo.handoff, "số lạ trong câu giả định ⇒ luật cũ (chặn + người), KHÔNG chèn một tổng tự tin");
}

async function testLoader() {
  // Bộ đọc căn cứ dùng cho MỌI đường gửi (lượt AI · câu mẫu · nhắn lại): mang tập tổng của revision hiện tại.
  const st: ChatState = { quote: quote(280_000, 310_000) };
  const f = await claimFactsLoader({ id: "00000000-0000-4000-8000-000000000640", orderId: null, pageId: null, threadId: null })(st);
  assert.deepEqual([...(f.totals?.allowed ?? [])], [310_000, 280_000], "tổng có ship + tiền hàng (không ship)");
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
    key: "q640-lap-im",
    title: "Khách nhắn lại ĐÚNG tin đã được trả lời, giỏ trống, model im ⇒ không câu «nói rõ hơn» NHƯNG gắn cờ cần người (không im lặng lẳng lặng)",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      { say: "shop ơi còn hàng không", ai: [() => [say("Dạ còn hàng ạ.")]] },
      { say: "shop ơi còn hàng không", ai: [() => []] },
    ],
  },
  {
    key: "q640-tu-chot",
    title: "Máy TỰ CHỐT (P0-A) không bao giờ chốt dòng hàng không có căn cứ: model tự thêm chả mực (khách chỉ nói 1kg chả cá) ⇒ từ chối, đơn tự chốt ĐÚNG 1kg chả cá",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Cho chị 1kg chả cá thu, Lan 0961003108, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Lan", phone: "0961003108", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [],
        ],
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
      // «ok» chung chung sau lời mời nhiều món KHÔNG phải đồng ý thêm món: model cố thêm chả mực × 3 ⇒ máy chủ từ chối, đơn vẫn 1kg.
      { say: "ok em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 3 }] })], () => [say("Dạ mình cần thêm món gì cứ nhắn em ạ.")]] },
      { say: "lấy thêm 1kg chả mực nhé", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ đơn mới của mình tổng 710.000 ₫ ạ.")]] },
      { say: "đổi chả cá thành 2kg nhé", ai: [({ v }) => [say("Dạ em sửa đơn rồi ạ, tổng vẫn 710.000 ₫ nhé"), tool("update_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => []] },
    ],
  },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-q640",
    beforeCase: async (c, ctx) => {
      await seed(ctx);
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: c.key === "q640-tu-chot" });
      if (c.key === "q640-viet-nguyen") await seedUpsell();
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      if (c.key === "q640-lap-im") {
        assert.equal(t.turns[1].shown.length, 1, `kênh web nhận đúng một câu chuyển người: ${JSON.stringify(t.turns[1].shown)}`);
        assert.ok(!t.turns[1].shown.includes(EMPTY_REPLY_TEXT), "không «nói rõ hơn»");
        assert.equal(t.final.status, "HANDOFF", "gắn cờ cần người");
        assert.match(t.final.handoffReason ?? "", /nhắn lại đúng tin đã được trả lời/);
        return;
      }
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
      if (c.key === "q640-tu-chot") {
        assert.match(JSON.stringify(t.turns[0].rounds.map((r) => r.results)), /KHÔNG đưa «Chả mực giã tay» vào đơn/, "dòng không căn cứ bị từ chối");
        assert.equal(orders[0].stage, "CONFIRMED", "tự chốt đúng đơn có căn cứ");
        assert.deepEqual([items.length, Number(orders[0].totalPriceAfterDiscount)], [1, 280_000], "chỉ 1kg chả cá");
        assert.equal(t.turns[0].shown.length, 1, `một câu chốt theo kết quả công cụ: ${JSON.stringify(t.turns[0].shown)}`);
        return;
      }
      if (c.key === "q640-2kg") {
        assert.equal(Number(orders[0].totalPriceAfterDiscount), 540_000, "gói 2kg = 540.000 ₫");
        // OPS upsell-basis-scan trên CSDL thật: đơn đúng ⇒ OK; chèn tay một dòng khách chưa nói (giả lập đơn cũ trước bản sửa) ⇒ NO_BASIS,
        // kế hoạch cờ chạy thử, --apply gắn UPSELL_UNCONSENTED qua lõi đơn, chạy lại không gắn lần hai.
        const scan0 = (await scanUpsellBasis(db, 1)).find((r) => r.id === orders[0].id);
        assert.equal(scan0?.verdict.kind, "OK", JSON.stringify(scan0?.verdict));
        const mm = schema.salesChatMessages;
        const [lastMsg] = await db.select({ seq: mm.seq }).from(mm).where(eq(mm.conversationId, ctx.conversationId)).orderBy(desc(mm.seq)).limit(1);
        const atOrder = orders[0].insertedAt ?? new Date();
        await db.insert(mm).values([
          { conversationId: ctx.conversationId, seq: lastMsg.seq + 1, role: "user", content: [{ type: "text", text: "ok em" }], createdAt: atOrder },
          { conversationId: ctx.conversationId, seq: lastMsg.seq + 2, role: "assistant", content: [{ type: "tool_use", id: "tu-extra", name: "update_draft_order", input: { items: [{ variant_id: ctx.ids.get("CCT-2KG"), quantity: 1 }, { variant_id: ctx.ids.get("CHA-MUC"), quantity: 3 }] } }], createdAt: atOrder },
          { conversationId: ctx.conversationId, seq: lastMsg.seq + 3, role: "user", content: [{ type: "tool_result", toolUseId: "tu-extra", content: "{}", isError: false }], createdAt: atOrder },
        ]);
        const scan1 = (await scanUpsellBasis(db, 1)).find((r) => r.id === orders[0].id)!;
        assert.equal(scan1.verdict.kind, "NO_BASIS", JSON.stringify(scan1.verdict));
        const plan = planUpsellFlags([scan1]);
        assert.equal(plan[0]?.action, "FLAG");
        const applied = await applyUpsellFlags(plan);
        assert.deepEqual(applied.flagged, [orders[0].id], JSON.stringify(applied));
        const [after] = await db.select().from(schema.orders).where(eq(schema.orders.id, orders[0].id));
        assert.ok(orderReviewOf(after.raw)?.entries.some((e) => e.code === "UPSELL_UNCONSENTED"), "cờ UPSELL_UNCONSENTED đã gắn");
        assert.equal(Number(after.totalPriceAfterDiscount), 540_000, "không đổi tiền đơn");
        assert.equal(planUpsellFlags((await scanUpsellBasis(db, 1)).filter((r) => r.id === orders[0].id))[0]?.action, "ALREADY_FLAGGED", "chạy lại không gắn lần hai");
        await db.delete(mm).where(and(eq(mm.conversationId, ctx.conversationId), gt(mm.seq, lastMsg.seq)));
        assert.deepEqual(t.turns[0].shown, ["Dạ đơn 2kg chả cá thu 540.000 ₫ + ship 30.000 ₫, tổng 570.000 ₫. Mình xác nhận giúp em nhé."], "tổng đúng đi qua nguyên văn");
        return;
      }
      // Ca «Viet Nguyen Thi».
      const r1 = JSON.stringify(t.turns[0].rounds.map((r) => r.results));
      assert.match(r1, /chưa mời thêm món|mời thêm món ĐÚNG MỘT LẦN/, "máy chủ đòi mời thêm món trước khi lên đơn");
      assert.match(r1, /KHÔNG đưa «Chả mực giã tay» vào đơn: khách CHƯA nói lấy món này/, `món mời chưa đồng ý bị từ chối: ${r1.slice(0, 600)}`);
      assert.equal(t.turns[0].shown[0], UPSELL_TEXT, "khách nhận câu upsell");
      assert.match(t.turns[0].shown[1] ?? "", /^Dạ em tóm tắt đơn của mình: Chả cá thu.* × 1 = 280\.000 ₫.*Tổng 310\.000 ₫/, `model im sau khi lên đơn ⇒ tóm tắt máy chủ: ${JSON.stringify(t.turns[0].shown)}`);
      assert.equal(t.turns[0].shown.length, 2, JSON.stringify(t.turns[0].shown));
      assert.deepEqual(t.turns[1].shown, [], "tin vọng lại ⇒ không tin bot");
      assert.equal(t.turns[1].rounds.length, 0, "tin vọng lại ⇒ không gọi model");
      assert.match(JSON.stringify(t.turns[2].rounds.map((r) => r.results)), /KHÔNG đưa «Chả mực giã tay» vào đơn/, "«ok» chung chung ⇒ món mời không vào đơn");
      assert.deepEqual(t.turns[2].shown, ["Dạ mình cần thêm món gì cứ nhắn em ạ."]);
      assert.deepEqual(t.turns[3].shown, ["Dạ đơn mới của mình tổng 710.000 ₫ ạ."], "khách nói tên + số lượng ⇒ thêm đúng 1kg, tổng máy chủ 280k + 400k + ship 30k");
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
  testUpsellScanPure();
  testReviewRepros();
  await testLoader();
  await testChatTurn();
  console.log("  ✓ tổng tiền = tổng máy chủ của giỏ hiện tại (ca «Châu Dương» 640.000 ₫ cho 1kg 280.000 ₫): số «tổng» đọc đúng, tập tham chiếu không còn cho tổng sai lọt, chữ viết cùng tin với lệnh lên đơn kiểm SAU công cụ, câu mẫu / nhắn lại cùng hàm; dòng hàng phải có căn cứ từ khách (món mời chưa đồng ý · số lượng tự tăng bị chặn, kể cả máy tự chốt) + ops upsell-basis-scan gắn cờ UPSELL_UNCONSENTED; sửa số lượng ⇒ tổng mới; lượt im ⇒ tóm tắt / hỏi đúng phần thiếu, không «nói rõ hơn» (ca «Viet Nguyen Thi»); tin vọng lại không sinh tin, không đơn thứ hai");
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

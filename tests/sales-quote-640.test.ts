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
import { amountsIn, applyCustomerCartMessage, bindCommitment, buyingText, commitmentViolation, invitedProductOf, lineBasisViolation, piecesOf, unrequestedProducts, type AskedLine, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { claimFactsLoader, claimVerdict, CLAIM_SAFE_TEXT, extractVndAmounts, guardClaims, namedAmountsOf, noteSeenTotals, serverTotalText, suspiciousTotalsOf, totalAllowedOf, totalClaimsIn, type ClaimFacts } from "@/lib/sales-chatbot/claim-guard";
import type { ReferenceBreakdown } from "@/lib/sales-chatbot/quote";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import type { AiProvider, AiResponse } from "@/lib/ai/provider";
import { chatTurn, draftSummaryFromTool, EMPTY_REPLY_TEXT, isEchoOfShop, setSalesChatProviderForTests, silenceFallbackText, visitorKeyOf } from "@/lib/sales-chatbot/engine";
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

  /*
    ═══ SỐ KHÔNG TÊN MIỄN THEO MÓN, KHÔNG MIỄN CẢ GIỎ (P0 15/10/2026, ca «Hoa Lê» 1kg → 10kg) ═══
    Trước bản vá: chỉ cần MỘT món trong giỏ không gắn được tên là hàm trả `null` cho CẢ giỏ, tức hàng rào số
    lượng tắt hẳn — một đơn nháp ghi 10kg chả cá trong khi khách nói 1kg đi lọt. ĐƠN VỊ quyết định số không
    tên ấy có thể là của món nào: «10 cái» không thể là kilogram chả cá.
  */
  const soTran = (q: number, unit: "g" | "pack") => ({ label: `${q}`, match: "", productId: null, variantId: null, sku: null, quantity: q, unit, sourceMessageId: 2, confidence: "MEDIUM" as const, customerExplicit: true });
  const caiKhongTen: CartCommitment = { ...cart, selectedItems: [...cart.selectedItems, soTran(10, "pack")] };
  assert.match(
    lineBasisViolation(caiKhongTen, [{ ...L("p-cct", "v1", "Chả cá thu (1kg)"), quantity: 10 }]) ?? "",
    /KHÔNG tự tăng «chả cá thu» lên 10kg: khách nói 1kg/,
    "«10 cái» không tên KHÔNG miễn hàng rào cho món bán theo kg — đây là đường đi của ca Hoa Lê",
  );
  // Nhưng vẫn KHÔNG chặn nhầm khách: số không tên CÙNG đơn vị với món thì có thể chính là số của món ấy.
  const hopKhongTen: CartCommitment = { ...cart, selectedItems: [...cart.selectedItems, { label: "nem", match: "nem", productId: null, variantId: null, sku: null, quantity: 1, unit: "pack", sourceMessageId: 3, confidence: "HIGH", customerExplicit: true }, soTran(2, "pack")] };
  assert.equal(lineBasisViolation(hopKhongTen, [L("p-cct", "v1", "Chả cá thu (1kg)"), nem(3)]), null, "«2 hộp» không tên cùng đơn vị với nem ⇒ vẫn miễn cho nem (không chắc thì không chặn khách)");
  // GIỎ NHIỀU SKU: số không tên hợp đơn vị với HAI món đã xác nhận ⇒ nó không chứng minh được gì cho riêng món
  // nào ⇒ KHÔNG miễn cho món nào cả. Bỏ hàng rào của hai món khách đã chốt chỉ vì một câu mơ hồ là sai hướng.
  const named = (label: string, match: string, q: number) => ({ label, match, productId: null, variantId: null, sku: null, quantity: q, unit: "pack" as const, sourceMessageId: 3, confidence: "HIGH" as const, customerExplicit: true });
  const nhieuSku: CartCommitment = { ...cart, selectedItems: [named("nem", "nem", 1), named("chả mực giã tay", "cha muc gia tay", 2), soTran(3, "pack")] };
  assert.match(
    lineBasisViolation(nhieuSku, [nem(5), { ...L("p-muc", "v2", "Chả mực giã tay (1kg)"), quantity: 2 }]) ?? "",
    /KHÔNG tự tăng «nem» lên 5/,
    "giỏ nhiều SKU: «3 hộp» không tên hợp cả nem lẫn chả mực ⇒ không miễn cho món nào",
  );
  // Quy cách gói đã biết ⇒ «2 hộp» có thể chính là món bán theo khối lượng ⇒ vẫn miễn.
  const coQuyCach: CartCommitment = { ...cart, selectedItems: [{ ...cart.selectedItems[0], packGrams: 500 }, soTran(2, "pack")] };
  assert.equal(lineBasisViolation(coQuyCach, [{ ...L("p-cct", "v1", "Chả cá thu (1kg)"), quantity: 2 }]), null, "quy đổi được qua quy cách gói ⇒ không chặn");
  // Khách GỌI TÊN món mà máy không đọc được số lượng («thêm 1 ruốc tôm») ⇒ có căn cứ; «chả cá» không gọi tên «Chả mực giã tay».
  assert.equal(lineBasisViolation(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-ruoc", "v4", "Ruốc bông tôm 100%")], null, "cho chị 1kg chả cá thu, thêm 1 ruốc tôm"), null);
  assert.ok(lineBasisViolation(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-muc", "v2", "Chả mực giã tay (1kg)")], null, "cho chị 1kg chả cá thu") !== null);
  assert.ok(lineBasisViolation(cart, [L("p-cct", "v1", "Chả cá thu (1kg)"), L("p-nem", "v3", "Nem hải sản tôm bề bề (Hộp 10 cái)")], null, "1kg chả cá thu\nok em") !== null, "«ok» không gọi tên món mời");
  // Review 15/10/2026 (ca «Hoa Lê»): lượt «nới» chỉ nới vế HẠ / BỎ — vế TĂNG vẫn chặn (trước đây lượt nới tắt cả hàng rào số lượng).
  assert.match(lineBasisViolation({ ...cart, relaxedTurn: 5 }, [{ ...L("p-cct", "v1", "Chả cá thu (1kg)"), quantity: 2 }], 5) ?? "", /KHÔNG tự tăng «chả cá thu» lên 2kg/, "lượt nới vẫn không cho TĂNG quá số khách nói");
  assert.equal(commitmentViolation({ ...cart, relaxedTurn: 5 }, [{ ...L("p-cct", "v1", "Chả cá thu (1kg)"), quantity: 0 }], 5), null, "lượt nới vẫn không chặn HẠ (khách có ý sửa)");
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
/** Đơn vị bán như engine đọc từ danh mục (`cartProducts`): chả cá / chả mực có mẫu mã kg ⇒ `g`; còn lại ⇒ `pack`. */
const UNITS: Record<string, "g" | "pack"> = { "Chả cá thu": "g", "Chả mực giã tay": "g" };
function review(msgs: string[], asked: AskedLine[], cat = CAT1, bot: Record<number, string> = {}, opts: { base?: string; baseDraft?: AskedLine[] } = {}) {
  const at = new Date();
  const base = opts.base ?? "Cho chị 1kg chả cá thu";
  const baseDraft = opts.baseDraft ?? [cct()];
  let cart = applyCustomerCartMessage(undefined, base, 1, at, { catalog: cat });
  cart = bindCommitment(cart, baseDraft, 1, at);
  msgs.forEach((m, i) => {
    const said = bot[i] ? [bot[i]] : [];
    const inv = invitedProductOf(said, cat, cart);
    cart = applyCustomerCartMessage(cart, m, i + 2, at, { catalog: catFor(m, cat), invited: inv ? { ...inv, unit: UNITS[inv.display] ?? "pack" } : null, products: cat });
  });
  const turn = msgs.length + 1;
  return { cart, basis: lineBasisViolation(cart, asked, turn, buyingText([base, ...msgs]), new Set(baseDraft.map((l) => l.productId ?? l.variantId))), lower: commitmentViolation(cart, asked, turn) };
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

// ═══ REVIEW VÒNG 3 — hàng rào tổng CẤU TRÚC (không phụ thuộc chữ «tổng» / «đơn» / nếu–thì) ═══

function testRound3() {
  const at = new Date().toISOString();
  // Danh mục giả: chả cá 1kg 280k (gói 2kg = 540k), nem 120k/hộp, chả mực 250k/hộp, một mẫu mã 160k (× 4 = 640k — tổng của giỏ KHÁC).
  const ship = 0;
  const mk = (price: number, packs: Record<number, number> = {}) => new Set(Array.from({ length: 10 }, (_, k) => packs[k + 1] ?? price * (k + 1)).flatMap((n) => [n, n + ship]));
  const bd: ReferenceBreakdown = {
    byVariant: new Map([["v-cct1", mk(280_000, { 2: 540_000 })], ["v-cct2", mk(540_000)], ["v-nem", mk(120_000)], ["v-muc", mk(250_000)], ["v-x", mk(160_000)]]),
    unit: new Set([280_000, 540_000, 120_000, 250_000, 160_000]),
    productOf: new Map([["v-cct1", "p-cct"], ["v-cct2", "p-cct"], ["v-nem", "p-nem"], ["v-muc", "p-muc"], ["v-x", "p-x"]]),
    nameOf: new Map([["v-cct1", "Chả cá thu"], ["v-cct2", "Chả cá thu"], ["v-nem", "Nem hải sản tôm bề bề"], ["v-muc", "Chả mực giã tay"], ["v-x", "Ruốc bông tôm 100%"]]),
    shippingFee: null,
    freeShipFrom: 500_000,
  };
  const st: ChatState = {
    quote: { id: "q", priceVersion: "p", verified: true, subtotal: 280_000, total: 280_000, amounts: [280_000], reasons: [], at },
    draft: { orderId: "erp-x", lines: [{ variantId: "v-cct1", quantity: 1 }], unitPrices: { "v-cct1": 280_000 }, recipient: { name: "K", phone: "0961000000", address: "x", province: "y" }, note: "", simulated: false, quote: { id: "q", priceVersion: "p", subtotal: 280_000, total: 280_000 } },
    seenTotals: [280_000, 520_000],
  };
  const totals = totalAllowedOf(st)!;
  const suspicious = suspiciousTotalsOf(st, totals, bd);
  assert.ok(suspicious.has(640_000), "640k (bội số mẫu mã ngoài giỏ) là tổng của giỏ khác");
  assert.ok(!suspicious.has(540_000) && !suspicious.has(560_000) && !suspicious.has(250_000) && !suspicious.has(120_000), "giá đơn vị / bội số của món trong giỏ không bị coi là tổng giỏ khác");
  const ref = new Set<number>([0, ...[...bd.byVariant.values()].flatMap((x) => [...x]), 30_000]);
  const facts: ClaimFacts = { ...BASE, allowedAmounts: ref, totals, suspicious, unitPrices: bd.unit, seen: new Set(st.seenTotals), namedAmounts: namedAmountsOf(bd), shipFee: null, freeShipFrom: 500_000 };
  for (const t of [
    "Dạ tổng đơn hàng của mình cả ship là 640k ạ",
    "Dạ tổng tiền cả hàng và ship: 640k ạ",
    "Dạ 640k là tổng đơn của mình ạ",
    "Dạ tổng 2 món là 640k ạ",
    "Dạ tổng cộng 1kg chả cá + 3 hộp nem là 640k ạ",
    "Dạ tổng: 280k + 360k = 640k ạ",
    "Dạ tổng 640k ship tận nhà ạ",
    "Dạ tổng 640k ship COD ạ",
    "Dạ em thêm 3 hộp nem cho mình rồi thì tổng 640k ạ",
    "Dạ nếu chị đồng ý thì tổng 640k ạ",
    "Dạ mình chuẩn bị 640k khi nhận hàng nhé",
    "Dạ khi shipper giao mình gửi 640k là được ạ",
    "Dạ tổng là 640.000 đồng ạ",
    "Dạ tổng 640 nghìn ạ",
    "Dạ tổng 640 ạ",
    "Dạ tất cả 640k ạ",
    "Dạ tính ra 640k ạ",
    "Dạ cộng lại 640k ạ",
    "Dạ thành tiền 640k ạ",
    "Dạ tổng 640k (miễn ship) ạ",
    "Dạ tổng giá trị đơn 640k ạ",
    "Dạ lần trước em báo 520k ạ",
  ]) {
    const v = guardClaims(t, facts);
    assert.ok(!v.ok, `phải chặn: ${t}`);
    assert.ok(!v.safeText.includes("640") && !v.safeText.includes("520"), `không chèn số sai: ${t}`);
    assert.ok(v.safeText === CLAIM_SAFE_TEXT.PRICE || v.safeText === "Dạ tổng đơn của mình là 280.000 ₫ (miễn phí ship) ạ.", `chỉ câu an toàn / đúng tổng đơn nháp: ${t} ⇒ ${v.safeText}`);
  }
  // Luật A (vòng 4): sau chữ COD không miễn giá đơn vị ⇒ hai câu này nay bị chặn; tách mệnh đề bằng dấu phẩy thì qua.
  for (const t of ["Dạ shop hỗ trợ COD toàn quốc chả mực 250k ạ", "Dạ bên em nhận COD nem tôm 120k một hộp ạ"]) assert.ok(!guardClaims(t, facts).ok, `luật A: ${t}`);
  for (const t of ["Dạ shop hỗ trợ COD toàn quốc, chả mực 250k ạ", "Dạ thanh toán 30k tiền ship ạ", "Dạ tổng 1kg chả cá 280k, 2kg là 540k ạ", "Dạ chị thanh toán qua STK 0123456789 nhé", "Dạ tổng 280k ạ, nem tôm thì 120k một hộp nếu chị cần"]) {
    assert.ok(guardClaims(t, facts).ok, `không chặn nhầm: ${t}`);
  }
  // Giả định thật: khách hỏi «2kg bao nhiêu», công cụ vừa tính ĐÚNG giỏ đó ⇒ số đó qua; số giả định khác ⇒ chặn.
  const hyp: ChatState = { ...st, quote: { id: "q2", priceVersion: "p", verified: true, subtotal: 540_000, total: 540_000, amounts: [540_000], reasons: [], at } };
  const hypTotals = totalAllowedOf(hyp)!;
  const hypFacts: ClaimFacts = { ...facts, totals: hypTotals, suspicious: suspiciousTotalsOf(hyp, hypTotals, bd) };
  assert.ok(guardClaims("Dạ nếu chị lấy 2kg thì tổng 540k ạ", hypFacts).ok, "giả định đúng báo giá máy chủ vừa tính ⇒ qua");
  assert.ok(!guardClaims("Dạ nếu chị lấy thêm 1 hộp nem thì tổng 400k ạ", hypFacts).ok, "giả định chưa tính ⇒ chặn");
  // noteSeenTotals: sổ tổng đã báo.
  assert.deepEqual(noteSeenTotals({ quote: quote(280_000, 310_000) }).seenTotals, [280_000, 310_000]);

  // P2 lời mời: đơn vị hợp CẢ món chính lẫn món được mời ⇒ hỏi lại, không gán.
  const invMuc = "Dạ shop còn Chả mực giã tay 250k/hộp 1kg, mình lấy thêm không ạ?";
  for (const t of ["ừ lấy 1kg", "cho chị 1kg nữa"]) {
    const r = review([t], [cct()], CAT1, { 0: invMuc });
    assert.equal(r.cart?.relaxedTurn, 2, `«${t}» sau lời mời chả mực ⇒ hỏi lại`);
    assert.equal(cctGrams(r.cart), 1000, `«${t}» không cộng vào chả cá`);
    assert.ok(!r.cart?.selectedItems.some((x) => /cha muc/.test(x.match)), `«${t}» không tự gán chả mực`);
  }
  const nem2 = review(["thêm 1 hộp nữa"], [nemL(2)], CAT1, { 0: "Dạ shop còn Ruốc bông tôm 100% hũ 250g, mình lấy thêm không ạ?" }, { base: "Cho chị 2 hộp nem tôm", baseDraft: [nemL(2)] });
  assert.equal(nem2.cart?.relaxedTurn, 2, "2 hộp nem + mời ruốc + «thêm 1 hộp nữa» ⇒ hỏi lại");
  // P2 buyingText.
  for (const t of ["nem tôm mắc quá", "nem tôm thì thôi", "ăn rồi, ngán", "chị ăn nem tôm rồi", "nem tôm loại nào ngon", "nem tôm chiên hay hấp em"]) assert.equal(buyingText([t]), "", `không phải lời mua: ${t}`);
  assert.equal(buyingText(["lấy nem tôm giao sau nha"]), "lấy nem tôm giao sau nha", "«giao sau» vẫn là lời mua");
  // P0 (trên main): câu từ chối món được mời KHÔNG huỷ cả giỏ.
  const refuse = review(["nem tôm chắc không cần đâu"], [cct(), nemL(1)], CAT1, { 0: invite3 });
  assert.equal(cctGrams(refuse.cart), 1000, "từ chối nem ⇒ giỏ vẫn 1kg chả cá");
  assert.ok(refuse.basis !== null, "nem × 1 vẫn không có căn cứ");
  const cancelAll = review(["thôi không lấy nữa"], [cct()], CAT1);
  assert.equal(cancelAll.cart?.selectedItems.length ?? 0, 0, "huỷ không gọi tên món ⇒ huỷ cả giỏ như cũ");
  const cancelMain = review(["thôi chả cá không lấy nữa"], [cct()], CAT1);
  assert.equal(cctGrams(cancelMain.cart), undefined, "gọi tên món chính ⇒ bỏ món đó như cũ");
}
// ═══ REVIEW VÒNG 4 — LUẬT A (sau cụm tổng / thanh toán chỉ tổng hiện tại) + LUẬT B (tổng đã báo không phải hiện tại luôn chặn) ═══

function testRound4() {
  const at = new Date().toISOString();
  // Dữ liệu review: chả cá 1kg 280k / 2kg 540k, nem 120k, chả mực 1kg 300k, ruốc 100k, ship 30k, miễn ship từ 500k.
  const ship = 30_000;
  const mk = (price: number, packs: Record<number, number> = {}) => new Set(Array.from({ length: 10 }, (_, k) => packs[k + 1] ?? price * (k + 1)).flatMap((n) => [n, n + ship]));
  const bd: ReferenceBreakdown = {
    byVariant: new Map([["v-cct1", mk(280_000, { 2: 540_000 })], ["v-cct2", mk(540_000)], ["v-nem", mk(120_000)], ["v-muc", mk(300_000)], ["v-ruoc", mk(100_000)]]),
    unit: new Set([280_000, 310_000, 540_000, 570_000, 120_000, 150_000, 300_000, 330_000, 100_000, 130_000]),
    productOf: new Map([["v-cct1", "p-cct"], ["v-cct2", "p-cct"], ["v-nem", "p-nem"], ["v-muc", "p-muc"], ["v-ruoc", "p-ruoc"]]),
    nameOf: new Map([["v-cct1", "Chả cá thu"], ["v-cct2", "Chả cá thu"], ["v-nem", "Nem hải sản tôm bề bề"], ["v-muc", "Chả mực giã tay"], ["v-ruoc", "Ruốc bông tôm 100%"]]),
    shippingFee: ship,
    freeShipFrom: 500_000,
  };
  const st: ChatState = {
    quote: { id: "qd", priceVersion: "p", verified: true, subtotal: 280_000, total: 310_000, amounts: [280_000, 310_000, 30_000], reasons: [], at },
    draft: { orderId: "erp-x", lines: [{ variantId: "v-cct1", quantity: 1 }], unitPrices: { "v-cct1": 280_000 }, recipient: { name: "K", phone: "0961000000", address: "x", province: "y" }, note: "", simulated: false, quote: { id: "qd", priceVersion: "p", subtotal: 280_000, total: 310_000 } },
    seenTotals: [540_000, 570_000, 280_000, 310_000],
  };
  const totals = totalAllowedOf(st)!;
  const ref = new Set<number>([0, ship, 500_000, ...[...bd.byVariant.values()].flatMap((x) => [...x])]);
  const facts: ClaimFacts = { ...BASE, allowedAmounts: ref, totals, suspicious: suspiciousTotalsOf(st, totals, bd), unitPrices: bd.unit, seen: new Set(st.seenTotals), namedAmounts: namedAmountsOf(bd), shipFee: ship, freeShipFrom: 500_000 };
  for (const t of [
    "Dạ tổng 540k ạ",
    "Dạ tổng 570k, mình xác nhận giúp em nhé",
    "Dạ tổng cộng 570k ạ",
    "Dạ thanh toán khi nhận 570k ạ",
    "Dạ COD 570k ạ",
    "Dạ tổng 300k ạ",
    "Dạ tổng 330k ạ",
    "Dạ mình chuẩn bị 570k khi nhận hàng nhé",
    "Dạ 2kg chả cá em gửi chị, mình chuẩn bị 540k nhé",
    "Dạ tổng 280k + ship 30k = 310k, à em nhầm 540k ạ",
    "Dạ thu hộ 830k ạ",
    "Dạ tổng 600k ạ",
    "Dạ chị chuẩn bị 600k nhé",
    "Dạ tổng 90k ship ạ",
    "Dạ nếu lấy 2kg thì 540k, tổng 570k ạ",
  ]) {
    const v = guardClaims(t, facts);
    assert.ok(!v.ok, `vòng 4 phải chặn: ${t}`);
    assert.ok(v.safeText === CLAIM_SAFE_TEXT.PRICE || v.safeText === "Dạ tổng đơn của mình là 310.000 ₫ (đã gồm 30.000 ₫ phí ship) ạ.", `không chèn số sai: ${t} ⇒ ${v.safeText}`);
  }
  for (const t of [
    "Dạ đơn của mình 1kg chả cá thu, tổng 310k ạ",
    "Dạ nem tôm 120k/hộp ạ",
    "Dạ nem tôm 120k một hộp, 2 hộp 240k ạ",
    "Dạ ruốc bông tôm 100k/hũ, 3 hũ 300k ạ",
    "Dạ đơn từ 500k được freeship ạ",
    "Dạ thêm 2 hộp nem chỉ 240k thôi ạ",
    "Dạ chả mực 300k/kg ạ",
    "Dạ shop hỗ trợ COD toàn quốc, chả mực 300k ạ",
    "Dạ phí ship 30k ạ",
  ]) assert.ok(guardClaims(t, facts).ok, `vòng 4 không chặn nhầm: ${t}`);
  // Báo giá phương án của LƯỢT TRƯỚC (đã có đơn nháp) không còn là tổng hiện tại; tính trong CHÍNH lượt này thì vẫn là.
  const old: ChatState = { ...st, quote: { id: "q2kg", priceVersion: "p", verified: true, subtotal: 540_000, total: 570_000, amounts: [540_000, 570_000], reasons: [], at: new Date(Date.now() - 600_000).toISOString() } };
  assert.ok(!totalAllowedOf(old, { turnAt: new Date(Date.now() - 60_000) })!.allowed.has(570_000), "báo giá phương án lượt trước ⇒ không hợp lệ");
  assert.ok(totalAllowedOf({ ...old, quote: { ...old.quote!, at: new Date().toISOString() } }, { turnAt: new Date(Date.now() - 60_000) })!.allowed.has(570_000), "tính trong lượt này ⇒ hợp lệ");

  // FAIL-2: «hủy đơn» / «không lấy nữa» / «nữa» ⇒ LUÔN huỷ cả đơn; chỉ câu không có các chữ đó mà gọi tên món ngoài giỏ mới là từ chối món.
  for (const t of ["thôi chị không lấy nữa, nem tôm cũng không", "thôi hủy đơn đi, chị mua nem tôm chỗ khác rồi", "thôi không lấy nữa", "hủy đơn giúp chị"]) {
    assert.equal(review([t], [cct()], CAT1, { 0: invite3 }).cart?.selectedItems.length ?? 0, 0, `huỷ cả đơn: ${t}`);
  }
  assert.equal(cctGrams(review(["nem tôm chắc không cần đâu"], [cct()], CAT1, { 0: invite3 }).cart), 1000, "từ chối riêng món mời ⇒ giữ chả cá");
}

const invite3 = "Dạ shop còn Nem hải sản tôm bề bề hộp 10 cái 120.000 ₫, mình lấy thêm không ạ?";

// ═══ CA «HOA LÊ» 15/10/2026 — «thêm 10 cái nem hải sản» thành chả cá 10kg + nem 1 hộp = 1.920.000 ₫ (đúng: 400.000 ₫) ═══

const HL_CAT1 = ["Chả cá thu", "Chả mực giã tay", "Nem hải sản tôm bề bề", "Ruốc bông tôm 100%"];
const HL_CAT2 = [...HL_CAT1, "Nem chua Thanh Hoá"];
const HL_CAT3 = ["Chả cá thu", "Chả mực giã tay", "Nem tôm bề bề", "Nem chua Thanh Hoá", "Ruốc bông tôm 100%"];
const hlCct = (q = 1, w: number | null = 1000): AskedLine => ({ productId: "p-cct", variantId: "v-cct1", name: "Chả cá thu (1kg)", quantity: q, weightGrams: w });
const hlNem = (q = 1): AskedLine => ({ productId: "p-nem", variantId: "v-nem", name: "Nem hải sản tôm bề bề (Hộp 10 cái)", quantity: q, weightGrams: null });
const hlNemT = (q = 1): AskedLine => ({ productId: "p-nem", variantId: "v-nem", name: "Nem tôm bề bề (Hộp 10 cái)", quantity: q, weightGrams: null });
const hlMuc = (q = 1): AskedLine => ({ productId: "p-muc", variantId: "v-muc", name: "Chả mực giã tay (Hộp 500g)", quantity: q, weightGrams: 500 });
const hlRuoc = (q = 1): AskedLine => ({ productId: "p-ruoc", variantId: "v-r", name: "Ruốc bông tôm 100%", quantity: q, weightGrams: null });
type HlStep = string | { bot: string } | { draft: AskedLine[] };

/** Đi đúng đường engine (giỏ · món vừa mời + đơn vị · gắn đơn nháp · chữ mua) rồi trả phán quyết cho từng đơn đề nghị. */
function hoaLe(steps: HlStep[], askedList: AskedLine[][], cat = HL_CAT1) {
  const at = new Date();
  let cart: CartCommitment | undefined;
  let bot: string[] = [];
  const cust: string[] = [];
  let turn = 0;
  let grounded = new Set<string>();
  for (const st of steps) {
    turn++;
    if (typeof st === "string") {
      const c = catFor(st, cat);
      const full = cart?.selectedItems.some((x) => x.customerExplicit) ? cat : undefined;
      const inv0 = invitedProductOf(bot, full ?? c, cart);
      const invited = inv0 && full ? { ...inv0, unit: (/^Chả/.test(inv0.display) ? "g" : "pack") as "g" | "pack" } : inv0;
      cart = applyCustomerCartMessage(cart, st, turn, at, { catalog: c, invited, ...(full ? { products: full } : {}) });
      cust.push(st);
      bot = [];
    } else if ("bot" in st) bot.push(st.bot);
    else {
      cart = bindCommitment(cart, st.draft, turn, at);
      grounded = new Set(st.draft.map((l) => l.productId ?? l.variantId));
    }
  }
  const verdicts = askedList.map((asked) => lineBasisViolation(cart, asked, turn, buyingText(cust), grounded) ?? commitmentViolation(cart, asked, turn));
  return { cart, verdicts, relaxed: cart?.relaxedTurn === turn };
}
const hlBase = "Cho chị 1kg chả cá thu";
const hlD = { draft: [hlCct()] };
const hlInv = { bot: "Dạ shop có thêm Nem hải sản tôm bề bề hộp 10 cái, mình lấy thêm không ạ?" };
const hlInvT = { bot: "Dạ shop có thêm Nem tôm bề bề hộp 10 cái, mình lấy thêm không ạ?" };

function testHoaLe() {
  // Tên gắn được (H1 H2 H4 H5 H6 H9 H10): «10 cái» là số CÁI ⇒ đơn đúng là chả cá 1kg + 1 hộp nem; chả cá 10kg / 11kg / nem × 10 bị chặn.
  const named: [string, HlStep[], string[], (q?: number) => AskedLine][] = [
    ["H1", [hlBase, hlD, "thêm 10 cái nem hải sản"], HL_CAT1, hlNem],
    ["H2", [hlBase, hlD, "thêm 10 cái nem hải sản"], HL_CAT2, hlNem],
    ["H4", [hlBase, hlD, hlInv, "thêm 10 cái nem"], HL_CAT1, hlNem],
    ["H5", [hlBase, hlD, hlInv, "thêm 10 cái nem"], HL_CAT2, hlNem],
    ["H6", [hlBase, hlD, hlInv, "lấy thêm 10 cái nhé"], HL_CAT1, hlNem],
    ["H9", ["cho chị 1kg chả cá thu với 10 cái nem hải sản"], HL_CAT2, hlNem],
  ];
  for (const [k, steps, cat, nemOf] of named) {
    const r = hoaLe(steps, [[hlCct(1), nemOf(1)], [hlCct(10), nemOf(1)], [hlCct(11), nemOf(1)], [hlCct(1), nemOf(10)]], cat);
    assert.equal(r.verdicts[0], null, `${k}: chả cá 1kg + 1 hộp nem (10 cái) phải QUA`);
    assert.match(r.verdicts[1] ?? "", /KHÔNG tự tăng «Chả cá thu» lên 10kg/, `${k}: chả cá 10kg bị chặn`);
    assert.ok(r.verdicts[2] !== null, `${k}: chả cá 11kg bị chặn`);
    assert.match(r.verdicts[3] ?? "", /KHÔNG tự tăng «Nem.*» lên 100 cái: khách nói 10 cái/, `${k}: nem × 10 hộp (100 cái) bị chặn`);
    assert.equal(r.cart?.selectedItems.find((x) => /cha ca/.test(x.match))?.quantity, 1000, `${k}: giỏ chả cá vẫn 1kg (không bao giờ +10kg)`);
  }
  // Tên KHÔNG gắn được / số không tên khác đơn vị (H3 H7 H8): HỎI LẠI, chả cá vẫn 1kg, không đơn nào có chả cá > 1kg qua.
  for (const [k, steps, cat, nemOf] of [
    ["H3", [hlBase, hlD, "thêm 10 cái nem hải sản"], HL_CAT3, hlNemT],
    ["H7", [hlBase, hlD, "thêm 10 cái nhé"], HL_CAT1, hlNem],
    ["H8", [hlBase, "thêm 10 cái nem"], HL_CAT2, hlNem],
  ] as [string, HlStep[], string[], (q?: number) => AskedLine][]) {
    const r = hoaLe(steps, [[hlCct(11)], [hlCct(10), nemOf(1)], [hlCct(1)]], cat);
    assert.ok(r.relaxed, `${k}: hỏi lại khách (lượt nới)`);
    assert.match(r.cart?.clarify ?? "", /hỏi lại|HỎI LẠI/, `${k}: có câu hỏi lại`);
    assert.equal(r.cart?.selectedItems.find((x) => /cha ca/.test(x.match))?.quantity, 1000, `${k}: chả cá vẫn 1kg`);
    assert.ok(r.verdicts[0] !== null && r.verdicts[1] !== null, `${k}: chả cá 11kg / 10kg bị chặn`);
    assert.equal(r.verdicts[2], null, `${k}: giữ nguyên đơn 1kg không bị chặn`);
  }
  // 1kg + 2 hộp nem.
  const a = hoaLe([hlBase, hlD, "thêm 2 hộp nem"], [[hlCct(1), hlNem(2)], [hlCct(2), hlNem(2)], [hlCct(1), hlNem(3)]]);
  assert.deepEqual(a.verdicts.map((v) => v === null), [true, false, false], "1kg + 2 hộp nem: đúng qua, tự tăng món nào cũng bị chặn");
  // Đổi MỘT món: nem 2 → 3 giữ chả cá; chả cá 1 → 2kg giữ nem.
  assert.deepEqual(hoaLe([hlBase, "thêm 2 hộp nem hải sản", { draft: [hlCct(), hlNem(2)] }, "nem lấy 3 hộp nhé"], [[hlCct(1), hlNem(3)], [hlCct(2), hlNem(3)]]).verdicts.map((v) => v === null), [true, false]);
  assert.deepEqual(hoaLe([hlBase, "thêm 2 hộp nem hải sản", { draft: [hlCct(), hlNem(2)] }, "chả cá đổi thành 2kg"], [[hlCct(2), hlNem(2)], [hlCct(2), hlNem(4)]]).verdicts.map((v) => v === null), [true, false]);
  // Từ chối upsell («thôi nem khỏi em» — lượt nới): chả cá 10kg vẫn bị chặn; giữ nguyên 1kg qua; nem vào đơn bị chặn.
  const refuse = hoaLe([hlBase, hlD, hlInv, "thôi nem khỏi em"], [[hlCct(1)], [hlCct(1), hlNem(1)], [hlCct(10)]]);
  assert.deepEqual(refuse.verdicts.map((v) => v === null), [true, false, false], "từ chối upsell");
  // Hỗn hợp đơn vị trong một tin.
  assert.deepEqual(hoaLe(["cho chị 1kg chả cá thu, 2 hộp nem hải sản, 1 hũ ruốc"], [[hlCct(1), hlNem(2), hlRuoc(1)], [hlCct(10), hlNem(2), hlRuoc(1)], [hlCct(1), hlNem(2), hlRuoc(3)]]).verdicts.map((v) => v === null), [true, false, false]);
  // Số không tên hợp HAI món cùng đơn vị ⇒ hỏi lại; không món nào được tự tăng.
  const two = hoaLe(["cho chị 2 hộp nem hải sản với 2 hộp chả mực", { draft: [hlNem(2), hlMuc(2)] }, "thêm 1 hộp"], [[hlNem(3), hlMuc(2)], [hlNem(2), hlMuc(3)], [hlNem(2), hlMuc(2)], [hlNem(5), hlMuc(2)]]);
  assert.ok(two.verdicts[3] !== null, "nem 2 → 5 khi khách nói thêm 1 hộp ⇒ chặn");
  assert.ok(two.relaxed);
  assert.deepEqual(two.verdicts.slice(0, 3).map((v) => v === null), [true, true, true], "«thêm 1 hộp» không tên: trần lượt nới = hiện có + 1 cho món cùng đơn vị (bot vẫn được hỏi lại vì giỏ nới)");
  // «hộp» / «cái» KHÔNG quy ra gram theo khối lượng mẫu mã; chỉ «gói / túi / bịch» mới quy (giữ #819 «bớt 1 gói»).
  const box = hoaLe([hlBase, hlD, "chả cá thêm 2 hộp"], [[hlCct(3)]]);
  assert.ok(box.relaxed, "«chả cá thêm 2 hộp» ⇒ hỏi lại, không tự quy 2 hộp = 2kg");
  const bag = hoaLe(["Cho chị 2kg chả cá thu", { draft: [hlCct(2)] }, "bớt 1 gói"], [[hlCct(1)]]);
  assert.equal(bag.cart?.selectedItems[0]?.quantity, 1000, "«bớt 1 gói» vẫn quy theo quy cách gói 1kg (#819)");
  // «chả cá thu 1kg lấy 2 hộp» = 2 hộp loại 1kg = 2kg (một lượng), đơn 2 × 1kg không bị coi là tự tăng; có dấu phẩy / có tên ⇒ hai lượng.
  assert.deepEqual(amountsIn("chả cá thu 1kg lấy 2 hộp").map((x) => [x.value, x.unit]), [[2000, "g"]]);
  assert.deepEqual(amountsIn("1kg chả cá, 2 hộp nem", HL_CAT1).map((x) => [x.value, x.unit]), [[1000, "g"], [2, "pack"]]);
  assert.equal(hoaLe(["chả cá thu 1kg lấy 2 hộp"], [[hlCct(2)]]).verdicts[0], null);
  // Lượt «nới» có số khách nói («lấy 2kg, đóng 2 gói riêng») ⇒ trần tăng là số đó: 2kg qua, 3kg bị chặn.
  const capped = hoaLe([hlBase, hlD, "chả cá lấy 2kg, đóng 2 gói riêng nhé"], [[hlCct(2)], [hlCct(3)]]);
  assert.ok(capped.relaxed);
  assert.deepEqual(capped.verdicts.map((v) => v === null), [true, false], "lượt nới: trần tăng = số khách nói trong tin");
  // Review dbd7ac98 (BLOCKER): gộp «1kg lấy 2 hộp» CHỈ khi sau «hộp» không còn chữ nào ngoài trợ từ — đọc chữ GỐC, không đọc kết quả gắn
  // danh mục; tên không có trong danh mục («xôi», «bánh tráng», «nemm», «nem hải sản» khi shop chỉ có «Nem tôm bề bề») ⇒ không gộp, hỏi lại.
  for (const t of ["chả cá thu 1kg lấy 2 hộp xôi", "chả cá 1kg lấy 2 hộp bánh tráng", "chả cá thu 1kg lấy 2 hộp nemm"]) {
    const am = amountsIn(t, HL_CAT1);
    assert.deepEqual(am.map((x) => [x.value, x.unit]), [[1000, "g"], [2, "pack"]], `không gộp: ${t}`);
    assert.ok(am[1].unbound, `tên ngoài danh mục: ${t}`);
    const r = hoaLe([t], [[hlCct(2)], [hlCct(1), hlNem(2)], [hlCct(1)]]);
    assert.ok(r.relaxed && /KHÔNG có trong danh mục/.test(r.cart?.clarify ?? ""), `hỏi lại món nào: ${t}`);
    assert.ok(!r.cart?.selectedItems.some((x) => !x.match && !x.productId), `không đẻ món «không tên» ghép được với bất kỳ sản phẩm nào: ${t}`);
    assert.deepEqual(r.verdicts.map((v) => v === null), [false, false, true], `chả cá 2kg / thêm nem bị chặn, giữ 1kg qua: ${t}`);
  }
  for (const t of ["chả cá thu 1kg lấy 2 hộp nhé", "chả cá thu 1kg lấy 2 hộp nha em", "chả cá thu 1kg lấy 2 hộp luôn"]) assert.deepEqual(amountsIn(t, HL_CAT1).map((x) => [x.value, x.unit]), [[2000, "g"]], `gộp khi chỉ còn trợ từ: ${t}`);
  const cat3 = hoaLe(["chả cá thu 1kg lấy 2 hộp nem hải sản"], [[hlCct(2)], [hlCct(1)]], HL_CAT3);
  assert.ok(cat3.relaxed, "CAT3: «nem hải sản» không có trong danh mục ⇒ hỏi lại");
  assert.equal(cat3.cart?.selectedItems.find((x) => /cha ca/.test(x.match))?.quantity, 1000, "CAT3: chả cá vẫn 1kg, không thành 2kg");
  assert.deepEqual(cat3.verdicts.map((v) => v === null), [false, true]);
  // Tên ngoài danh mục ⇒ LUÔN hỏi lại, kể cả cùng danh từ món với món VỪA MỜI (review c0b7eb96): không ghi món được mời thành lựa chọn khách.
  const h10 = hoaLe([hlBase, hlD, hlInvT, "thêm 10 cái nem hải sản"], [[hlCct(1), hlNemT(1)], [hlCct(1)]], HL_CAT3);
  assert.ok(h10.relaxed && !h10.cart?.selectedItems.some((x) => /nem/.test(x.match)), "H10: «nem hải sản» (không bán) sau lời mời Nem tôm ⇒ hỏi lại, không ghi Nem tôm");
  assert.deepEqual(h10.verdicts.map((v) => v === null), [false, true]);
  for (const [k, steps, cat, asked] of [
    ["nem rán", [hlBase, hlD, hlInvT, "thêm 2 hộp nem rán"], HL_CAT3, [hlCct(1), hlNemT(2)]],
    ["nem chua", [hlBase, hlD, hlInvT, "cho chị 2 hộp nem chua"], HL_CAT1, [hlCct(1), hlNem(2)]],
    ["chả lụa", ["cho chị 2 hộp nem hải sản", { draft: [hlNem(2)] }, { bot: "Dạ shop còn Chả mực giã tay 1kg, mình lấy thêm không ạ?" }, "thêm 1kg chả lụa"], HL_CAT1, [hlNem(2), hlMuc(2)]],
  ] as [string, HlStep[], string[], AskedLine[]][]) {
    const r = hoaLe(steps, [asked], cat);
    assert.ok(r.relaxed, `${k}: món không bán ⇒ hỏi lại`);
    assert.ok(r.verdicts[0] !== null, `${k}: món được mời KHÔNG được ghi thành lựa chọn của khách`);
  }
  // P1: quy cách «(Hộp)» không ghi số cái ⇒ CHƯA BIẾT (không mặc định 1): «10 cái» ⇒ hỏi lại, không đơn nào có nem qua.
  assert.equal(piecesOf("Nem hải sản tôm bề bề (Hộp)"), null);
  assert.equal(piecesOf("Combo ăn vặt (Set)"), null);
  const nemHop = (q = 1): AskedLine => ({ ...hlNem(q), name: "Nem hải sản tôm bề bề (Hộp)" });
  const unknownPieces = hoaLe([hlBase, hlD, "thêm 10 cái nem hải sản"], [[hlCct(1), nemHop(1)], [hlCct(1), nemHop(10)]]);
  assert.ok(unknownPieces.verdicts.every((v) => v !== null && /HỎI LẠI khách lấy mấy hộp/.test(v)), JSON.stringify(unknownPieces.verdicts));
  // Minor: trần lượt nới của câu «thêm N» = hiện có + N.
  const addCap = hoaLe(["cho chị 1kg chả cá thu, 2 hộp nem hải sản, 1 hũ ruốc", { draft: [hlCct(), hlNem(2), hlRuoc()] }, "thêm 2 hũ nữa"], [[hlCct(1), hlNem(2), hlRuoc(3)], [hlCct(3), hlNem(2), hlRuoc(1)], [hlCct(1), hlNem(2), hlRuoc(4)]]);
  assert.ok(addCap.relaxed);
  assert.deepEqual(addCap.verdicts.map((v) => v === null), [true, false, false], "«thêm 2 hũ»: ruốc 1 + 2 = 3 qua; 4 hoặc chả cá 3kg bị chặn");
  // «thêm 2 hộp nữa» không tên: MỘT phần tăng 2 cho cả nhóm cùng đơn vị — nem +2 HOẶC ruốc +2, không phải cả hai.
  const total = hoaLe(["cho chị 2 hộp nem hải sản, 1 hũ ruốc", { draft: [hlNem(2), hlRuoc()] }, "thêm 2 hộp nữa"], [[hlNem(4), hlRuoc(3)], [hlNem(4), hlRuoc(1)], [hlNem(3), hlRuoc(2)], [hlNem(2), hlRuoc(3)]]);
  assert.ok(total.relaxed);
  assert.deepEqual(total.verdicts.map((v) => v === null), [false, true, true, true], "trần là TỔNG phần tăng của nhóm cùng đơn vị");
  // Số cái theo quy cách mẫu mã.
  assert.equal(piecesOf("Nem hải sản tôm bề bề (Hộp 10 cái)"), 10);
  assert.equal(piecesOf("Áo thun (M)"), 1, "món bán theo cái: 1 cái = 1 đơn vị");
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
    // LUẬT CHỦ SHOP ĐỔI 16/10/2026 (#868): lời mời KHÔNG còn là điều kiện lên đơn — bản cũ của ca này mở đầu bằng «đủ món + SĐT + địa
    // chỉ ⇒ máy chủ đòi mời thêm món» (cổng 02/10/2026 đã gỡ). Câu upsell nay đi ở lúc được phép (khách vừa chọn món, CHƯA gửi thông tin
    // nhận hàng); mọi bảo vệ của ca giữ nguyên: món mời chưa đồng ý không vào đơn, model im ⇒ tóm tắt máy chủ, tin vọng lại không sinh tin,
    // «ok» chung chung không thêm món, khách nói tên + số lượng ⇒ thêm đúng món, đổi số lượng ⇒ tổng cũ bị thay.
    title: "Ca «Viet Nguyen Thi»: khách chọn 1kg ⇒ câu upsell (lúc được phép) ⇒ khách gửi SĐT + địa chỉ ⇒ model cố thêm chả mực (khách chưa đồng ý) bị từ chối ⇒ lên đơn 1kg ⇒ model im ⇒ tóm tắt máy chủ, KHÔNG «nói rõ hơn»; tin vọng lại / tin trùng không sinh tin; khách nhận lời ⇒ thêm món, tổng mới; đổi số lượng ⇒ tổng cũ bị thay",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      { say: "1kg chả cá thu nhé em", ai: [() => [tool("send_quick_reply", { code: "Q1" })], () => [say("Dạ mình cho em xin SĐT và địa chỉ nhận hàng nhé.")]] },
      // Chữ của chính shop vọng lại như tin khách ⇒ không ghi, không gọi AI, không gửi.
      { say: UPSELL_TEXT, ai: [() => [say("KHÔNG ĐƯỢC GỌI MODEL")]] },
      {
        say: `Việt 0961004962, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Việt", phone: "0961004962", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [],
        ],
      },
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
        // Đơn cũ trước bản sửa = đơn mà lượt update_draft_order (giả lập) GHI LẠI sau cùng: mốc tin = sau mọi tin của lượt thật, mốc sửa đơn
        // = ngay sau đó. (Trước pha 2 trùng đơn 24/10/2026, lượt gắn hội thoại SAU giao dịch luôn đẩy `updated_at` về cuối lượt nên mốc tin
        // = `inserted_at` vẫn lọt vào cửa sổ quét; nay khoá hội thoại ghi lúc chèn, không còn lượt ghi thứ hai ấy.)
        const atOrder = new Date();
        await db.update(schema.orders).set({ updatedAt: new Date(atOrder.getTime() + 1) }).where(eq(schema.orders.id, orders[0].id));
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
      // Ca «Viet Nguyen Thi» (chỉ số lượt dời một vì câu upsell nay ở lượt chọn món — #868, xem ghi chú ở kịch bản).
      const r1 = JSON.stringify(t.turns[2].rounds.map((r) => r.results));
      assert.doesNotMatch(JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results))), /chưa mời thêm món|mời thêm món ĐÚNG MỘT LẦN/, "không còn cổng «chưa mời thêm món» (#868)");
      assert.match(r1, /KHÔNG đưa «Chả mực giã tay» vào đơn: khách CHƯA nói lấy món này/, `món mời chưa đồng ý bị từ chối: ${r1.slice(0, 600)}`);
      assert.deepEqual(t.turns[0].shown, [UPSELL_TEXT, "Dạ mình cho em xin SĐT và địa chỉ nhận hàng nhé."], "khách nhận câu upsell lúc vừa chọn món");
      assert.match(t.turns[2].shown[0] ?? "", /^Dạ em tóm tắt đơn của mình: Chả cá thu.* × 1 = 280\.000 ₫.*Tổng 310\.000 ₫/, `model im sau khi lên đơn ⇒ tóm tắt máy chủ: ${JSON.stringify(t.turns[2].shown)}`);
      assert.equal(t.turns[2].shown.length, 1, JSON.stringify(t.turns[2].shown));
      assert.deepEqual(t.turns[1].shown, [], "tin vọng lại ⇒ không tin bot");
      assert.equal(t.turns[1].rounds.length, 0, "tin vọng lại ⇒ không gọi model");
      assert.match(JSON.stringify(t.turns[3].rounds.map((r) => r.results)), /KHÔNG đưa «Chả mực giã tay» vào đơn/, "«ok» chung chung ⇒ món mời không vào đơn");
      assert.deepEqual(t.turns[3].shown, ["Dạ mình cần thêm món gì cứ nhắn em ạ."]);
      assert.deepEqual(t.turns[4].shown, ["Dạ đơn mới của mình tổng 710.000 ₫ ạ."], "khách nói tên + số lượng ⇒ thêm đúng 1kg, tổng máy chủ 280k + 400k + ship 30k");
      assert.deepEqual(t.turns[5].shown, ["Dạ tổng đơn của mình là 970.000 ₫ (đã gồm 30.000 ₫ phí ship) ạ."], `đổi số lượng ⇒ tổng cũ 710.000 bị thay bằng tổng mới: ${JSON.stringify(t.turns[5].shown)}`);
      assert.equal(Number(orders[0].totalPriceAfterDiscount), 940_000, "đơn cập nhật: 540.000 + 400.000");
      assert.equal(items.length, 2);
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
}

// ═══ CA «HOA LÊ» qua chatTurn THẬT + giá kiểu HSLC: 1kg chả cá + 10 cái nem = 400.000 ₫ tiền hàng ═══

async function seedNem(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (ctx.ids.has("NEM-10")) return;
  const admin = await ctx.admin();
  const r = await createProductCore(admin, { name: "Nem hải sản tôm bề bề", code: "NEM", unit: "hộp", retailPrice: 120_000, cost: null, variants: [{ sku: "NEM-10", size: "Hộp 10 cái", color: "", retailPrice: 120_000, cost: null, selling: true }] });
  assert.ok(r.ok, JSON.stringify(r));
  const db = await getDb();
  for (const v of await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id))) (ctx.ids as Map<string, string>).set(v.sku, v.id);
}

const HL_OPEN = (name: string, phone: string) => ({
  say: `Cho chị 1kg chả cá thu, ${name} ${phone}, ${ADDR}`,
  ai: [() => [tool("create_customer", { name, phone, address: ADDR })], ({ v }: { v: (s: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [say("Dạ đơn của mình 1kg chả cá thu, tổng 310.000 ₫ ạ.")]],
});

const HL_CASES: GoldenCase[] = [
  {
    key: "q845-hoa-le",
    title: "Ca «Hoa Lê»: 1kg chả cá rồi «thêm 10 cái nem hải sản» ⇒ model cố ghi chả cá 10kg + nem 1 hộp bị chặn ⇒ đơn đúng 1kg + 1 hộp = 400.000 ₫ tiền hàng",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      HL_OPEN("Hoa", "0961008451"),
      {
        say: "thêm 10 cái nem hải sản",
        ai: [
          ({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 10 }, { variant_id: v("NEM-10"), quantity: 1 }] })],
          ({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("NEM-10"), quantity: 1 }] })],
          () => [say("Dạ đơn của mình tổng 430.000 ₫ ạ.")],
        ],
      },
    ],
  },
  {
    key: "q845-hai-hop",
    title: "1kg + «thêm 2 hộp nem hải sản» ⇒ 520.000 ₫; rồi CHỈ đổi chả cá lên 2kg ⇒ 540.000 + 240.000 = 780.000 ₫, nem giữ 2 hộp",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      HL_OPEN("Lan", "0961008452"),
      { say: "thêm 2 hộp nem hải sản", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("NEM-10"), quantity: 2 }] })], () => [say("Dạ em thêm 2 hộp nem cho mình ạ.")]] },
      { say: "chả cá đổi thành 2kg nhé", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }, { variant_id: v("NEM-10"), quantity: 4 }] })], ({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }, { variant_id: v("NEM-10"), quantity: 2 }] })], () => [say("Dạ em sửa chả cá lên 2kg ạ.")]] },
    ],
  },
  {
    key: "q845-tu-choi",
    title: "Từ chối upsell («thôi nem khỏi em» — lượt nới) ⇒ model cố tăng chả cá 10kg bị chặn, đơn giữ 1kg",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      HL_OPEN("Mai", "0961008453"),
      { say: "thôi nem khỏi em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 10 }] })], () => [say("Dạ vâng ạ, em giữ đơn cho mình nhé.")]] },
    ],
  },
  {
    key: "q845-hon-hop",
    title: "Hỗn hợp đơn vị trong MỘT tin: 1kg chả cá + 2 hộp nem ⇒ 520.000 ₫; model cố ghi nem × 3 bị chặn",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `cho chị 1kg chả cá thu, 2 hộp nem hải sản, Thu 0961008454, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Thu", phone: "0961008454", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("NEM-10"), quantity: 3 }] })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("NEM-10"), quantity: 2 }] })],
          () => [say("Dạ đơn của mình tổng 550.000 ₫ ạ.")],
        ],
      },
    ],
  },
];

async function testHoaLeChat() {
  const seen = new Set<string>();
  await runGoldenCases(HL_CASES, {
    orgSuffix: "-q845",
    beforeCase: async (_c, ctx) => {
      await seed(ctx);
      await seedNem(ctx);
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: false });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      assert.equal(orders.length, 1, `[${c.key}] đúng MỘT đơn (không đơn trùng)`);
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orders[0].id));
      const qty = (sku: string) => items.filter((i) => i.variantId === ctx.ids.get(sku)).reduce((n, i) => n + i.quantity, 0);
      const goods = Number(orders[0].totalPriceAfterDiscount);
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      if (c.key === "q845-hoa-le") {
        assert.match(results, /KHÔNG tự tăng «Chả cá thu» lên 10kg/, "chả cá 10kg bị máy chủ từ chối");
        assert.deepEqual([qty("CCT-1KG"), qty("NEM-10"), goods], [1, 1, 400_000], "1kg chả cá + 1 hộp nem (10 cái) = 400.000 ₫ tiền hàng");
        assert.equal(Number(orders[0].shippingFee), 30_000, "ship theo cấu hình");
        assert.deepEqual(t.turns[1].shown, ["Dạ đơn của mình tổng 430.000 ₫ ạ."]);
        // REVISION giỏ: một lượt CŨ chạy chậm không đè giỏ mà lượt MỚI HƠN đã ghi trong lúc nó chạy.
        const cv = schema.salesChatConversations;
        const newer = { selectedItems: [{ label: "Chả cá thu", match: "cha ca thu", productId: null, variantId: null, sku: null, quantity: 3000, unit: "g", sourceMessageId: 99, confidence: "HIGH", customerExplicit: true }], turn: 99, at: new Date(Date.now() + 3_600_000).toISOString() };
        const slow: AiProvider = {
          name: "slow-fake",
          model: "claude-sonnet-5",
          schemaDialect: "anthropic",
          async complete(): Promise<AiResponse> {
            // Trong lúc lượt này «chạy chậm», một lượt mới hơn ghi giỏ 3kg.
            const [row] = await db.select({ state: cv.state }).from(cv).where(eq(cv.id, ctx.conversationId));
            await db.update(cv).set({ state: { ...(row.state as Record<string, unknown>), cart: newer } }).where(eq(cv.id, ctx.conversationId));
            return { content: [say("Dạ em ghi nhận ạ.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          },
        };
        setSalesChatProviderForTests(() => slow);
        const res = await chatTurn(ctx.conversationId, "ok em", { channel: "WEB", visitorKey: visitorKeyOf(`hoi-thoai-vang-${c.key}-0123456789abcdef`) });
        assert.ok(res.ok, JSON.stringify(res));
        const [after] = await db.select({ state: cv.state }).from(cv).where(eq(cv.id, ctx.conversationId));
        assert.deepEqual((after.state as ChatState).cart?.selectedItems.map((x) => x.quantity), [3000], "giỏ MỚI HƠN (3kg) không bị lượt cũ đè");
        assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId))).length, 1, "lượt chậm không đẻ đơn thứ hai");
        // Lượt mới hơn XOÁ giỏ (không còn cart.at) ⇒ lượt cũ chạy chậm KHÔNG dựng lại giỏ (so bằng `cartRev`).
        const clearing: AiProvider = {
          ...slow,
          async complete(): Promise<AiResponse> {
            const [row] = await db.select({ state: cv.state }).from(cv).where(eq(cv.id, ctx.conversationId));
            const next: Record<string, unknown> = { ...(row.state as Record<string, unknown>), cartRev: new Date(Date.now() + 7_200_000).toISOString() };
            delete next.cart;
            await db.update(cv).set({ state: next }).where(eq(cv.id, ctx.conversationId));
            return { content: [say("Dạ vâng ạ.")], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
          },
        };
        setSalesChatProviderForTests(() => clearing);
        const res2 = await chatTurn(ctx.conversationId, "cho chị 1kg chả cá thu nhé", { channel: "WEB", visitorKey: visitorKeyOf(`hoi-thoai-vang-${c.key}-0123456789abcdef`) });
        assert.ok(res2.ok, JSON.stringify(res2));
        const [after2] = await db.select({ state: cv.state }).from(cv).where(eq(cv.id, ctx.conversationId));
        assert.equal((after2.state as ChatState).cart, undefined, "giỏ đã bị lượt mới hơn XOÁ không bị lượt cũ dựng lại");
        return;
      }
      if (c.key === "q845-hai-hop") {
        assert.match(results, /KHÔNG tự tăng «Nem/, "nem 4 hộp bị chặn khi khách chỉ đổi chả cá");
        assert.deepEqual([qty("CCT-1KG") * 1000 + qty("CCT-2KG") * 2000, qty("NEM-10"), goods], [2000, 2, 780_000], "đổi MỘT món: chả cá 2kg, nem giữ 2 hộp = 780.000 ₫");
        return;
      }
      if (c.key === "q845-tu-choi") {
        assert.match(results, /KHÔNG tự tăng «Chả cá thu» lên 10kg/);
        assert.deepEqual([qty("CCT-1KG"), qty("NEM-10"), goods], [1, 0, 280_000], "từ chối upsell ⇒ đơn giữ 1kg");
        return;
      }
      assert.match(results, /KHÔNG tự tăng «Nem.*» lên 3 gói/);
      assert.deepEqual([qty("CCT-1KG"), qty("NEM-10"), goods], [1, 2, 520_000], "hỗn hợp đơn vị: 1kg + 2 hộp = 520.000 ₫");
    },
  });
  assert.deepEqual([...seen].sort(), HL_CASES.map((c) => c.key).sort());
}

export async function testSalesQuote640() {
  testTotals();
  testPureFlow();
  testUpsellScanPure();
  testReviewRepros();
  testRound3();
  testRound4();
  testHoaLe();
  await testLoader();
  await testChatTurn();
  await testHoaLeChat();
  console.log("  ✓ tổng tiền = tổng máy chủ của giỏ hiện tại (ca «Châu Dương» 640.000 ₫ cho 1kg 280.000 ₫): số «tổng» đọc đúng, tập tham chiếu không còn cho tổng sai lọt, chữ viết cùng tin với lệnh lên đơn kiểm SAU công cụ, câu mẫu / nhắn lại cùng hàm; dòng hàng phải có căn cứ từ khách (món mời chưa đồng ý · số lượng tự tăng bị chặn, kể cả máy tự chốt) + ops upsell-basis-scan gắn cờ UPSELL_UNCONSENTED; sửa số lượng ⇒ tổng mới; lượt im ⇒ tóm tắt / hỏi đúng phần thiếu, không «nói rõ hơn» (ca «Viet Nguyen Thi»); tin vọng lại không sinh tin, không đơn thứ hai; ca «Hoa Lê» (10 cái nem ⇒ 1 hộp, 1kg chả cá + nem = 400.000 ₫, giỏ mới hơn không bị lượt chậm đè)");
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

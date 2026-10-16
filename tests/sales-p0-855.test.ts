/**
 * P0 #855 (16/10/2026, HSLC) — hai hội thoại thật (đã che tên / SĐT / địa chỉ):
 *
 *  · «ThuyNgo» (khách CŨ): «Ship chị 1 mực giã tay» ⇒ bot báo «1kg chả cá thu + 1kg chả mực» 680.000 ₫ (món của đơn cũ); khách «Kg có
 *    order chả cá thu nha», «Khách cũ mà hỏi gì», «Địa chỉ coi lại», «Robot hả» ⇒ bot xin lỗi rồi hỏi lại địa chỉ; đơn nháp giữ «Khương
 *    Đình» (địa chỉ cũ) sau khi khách đã gõ địa chỉ mới ở Thủ Đức.
 *  · «Lieu Dau»: «… thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An» ⇒ bot vẫn hỏi xã mới; đơn đã chốt mà địa chỉ báo thiếu.
 *
 * Phần THUẦN khoá từng luật máy chủ; phần HỘI THOẠI VÀNG phát lại qua `chatTurn` thật (model giả, tổ chức PGlite thật) và khẳng định
 * TRỰC TIẾP (không ảnh chụp): không món lạ, không tổng lệch đơn, địa chỉ mới thắng cũ, không hỏi lại phường đã nói, khách bực ⇒ người,
 * nhân viên tiếp quản ⇒ bot im, không đơn trùng / không giao sai, khung THỬ (đường phát lại) không ghi gì thật.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { customerStatedAddresses, oldWardSplit, parseCustomerAddress } from "@/lib/address/customer-address";
import { normalizeVnAddress } from "@/lib/address/vn-address";
import { orderReviewOf, reviewCodes } from "@/lib/constants/order-review";
import { createProductCore } from "@/lib/records/product-create";
import { addressProvenanceVerdict } from "@/lib/sales-chatbot/address-provenance";
import { buyingText, classifyCartMessage, DENIAL_RE, deniedItemLabel, lineBasisViolation, mentionText, namesProductLoosely, repeatsPreviousOrder, unrequestedProducts, type AskedLine, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { CLAIM_SAFE_TEXT, guardClaims } from "@/lib/sales-chatbot/claim-guard";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { appendContextMessages } from "@/lib/sales-chatbot/engine";
import { asksForHuman, CORRECTION_HANDOFF_AT, FRUSTRATION_HANDOFF_PREFIX, frustrationSignal, isComplaint, isCorrectionTurn } from "@/lib/sales-chatbot/frustration";
import { foldVi } from "@/lib/sales-chatbot/text";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { aiHoldOf } from "@/lib/sales-chatbot/ai-hold-shared";
import { decideShippingRoute } from "@/lib/shipping/route";
import { seedReturningThread } from "./sales-agent-golden/cases";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx, type GoldenTranscript } from "./sales-agent-golden/harness";

const CA = "Chả cá thu (1kg)";
const MUC = "Chả mực giã tay (1kg)";
const line = (productId: string, name: string, quantity = 1): AskedLine => ({ variantId: `v-${productId}`, productId, name, quantity, weightGrams: 1000 });

// ═══ PHẦN THUẦN ═══

function testBasis() {
  // «kg có order X» là PHỦ NHẬN, không phải lời mua — tên món trong đó không bao giờ là căn cứ.
  for (const t of ["Kg có order chả cá thu nha", "Không có order chả cá thu nha", "Ko order chả cá thu", "Không đặt chả cá thu"]) {
    assert.ok(DENIAL_RE.test(foldVi(t)), t);
    assert.equal(buyingText([t]), "", `«${t}» không phải chữ mua`);
    assert.equal(mentionText([t]), "", `«${t}» không phải căn cứ tính giỏ`);
  }
  assert.ok(!DENIAL_RE.test(foldVi("2 kg chả cá thu")), "kg đơn vị không phải phủ nhận");
  assert.ok(!DENIAL_RE.test(foldVi("chị có order chả cá thu")), "có order = lời đặt");
  // Câu hỏi giá VẪN là căn cứ tính giá món đó (giả định khách hỏi), dù không phải căn cứ lên đơn.
  assert.match(mentionText(["chả cá thu bao nhiêu em?"]), /chả cá thu/);
  assert.equal(buyingText(["chả cá thu bao nhiêu em?"]), "");

  // Khách gọi tên tắt, bỏ danh từ đầu: «mực giã tay» = Chả mực giã tay; «mực» đơn lẻ không đủ.
  assert.ok(namesProductLoosely(MUC, "Ship chị 1 mực giã tay"));
  assert.ok(!namesProductLoosely(CA, "Ship chị 1 mực giã tay"));
  assert.ok(!namesProductLoosely(MUC, "chị lấy mực nhé"), "một từ riêng không đủ nhận món");
  assert.ok(namesProductLoosely(CA, "cho chị chả cá"), "danh từ đầu + một từ (luật cũ) vẫn nhận");

  // GIỎ CHƯA CÓ SỐ LƯỢNG mà khách đã gọi tên một món ⇒ món khác (món đơn cũ) là món lạ.
  const asked = [line("p-ca", CA), line("p-muc", MUC)];
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["Ship chị 1 mực giã tay"])), ["Chả cá thu"], "ThuyNgo: chả cá không có căn cứ");
  assert.deepEqual(unrequestedProducts(undefined, [line("p-muc", MUC)], mentionText(["Ship chị 1 mực giã tay"])), [], "chỉ chả mực ⇒ qua");
  // Khách không gọi tên món nào ⇒ luật an toàn cũ (không đủ căn cứ để chặn).
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["ship chị nhé"])), []);
  // Khách TỰ xin lặp lại đơn cũ ⇒ món đơn cũ có căn cứ.
  assert.ok(repeatsPreviousOrder("lấy như lần trước nhé, thêm 1 mực giã tay"));
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["lấy như lần trước nhé, thêm 1 mực giã tay"])), []);
  // Tin của SHOP / nhân viên không phải lời khách: engine chỉ đưa tin KHÁCH vào `customerTexts` ⇒ chữ shop nhắc chả cá không thành căn cứ.
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["Ship chị 1 mực giã tay"]), new Set()), ["Chả cá thu"]);
  // Sai số lượng khi giỏ chưa có số máy đọc được: «1 mực giã tay» mà đơn 2 gói ⇒ chặn; khách gõ «2» ⇒ qua; SĐT không phải số lượng.
  assert.match(lineBasisViolation(undefined, [line("p-muc", MUC, 2)], 3, buyingText(["Ship chị 1 mực giã tay"])) ?? "", /KHÔNG tự đặt 2 × «Chả mực giã tay»/);
  assert.equal(lineBasisViolation(undefined, [line("p-muc", MUC, 2)], 3, buyingText(["cho chị 2 mực giã tay"])), null);
  assert.match(lineBasisViolation(undefined, [line("p-muc", MUC, 3)], 3, buyingText(["Ship chị mực giã tay 0977000333"])) ?? "", /KHÔNG tự đặt 3/);
  assert.equal(lineBasisViolation(undefined, [line("p-muc", MUC, 1)], 3, buyingText(["Ship chị 1 mực giã tay"])), null);
  // Lên đơn có món đơn cũ ⇒ cùng hàng rào với báo giá.
  assert.match(lineBasisViolation(undefined, asked, 3, buyingText(["Ship chị 1 mực giã tay"])) ?? "", /KHÔNG đưa «Chả cá thu» vào đơn/);
  // Khách phủ nhận món ⇒ REMOVE đúng món đó (không huỷ cả giỏ) — hai commit ứng viên giữ nguyên.
  assert.deepEqual([classifyCartMessage("Kg có order chả cá thu nha").kind, classifyCartMessage("Kg có order chả cá thu nha").label], ["REMOVE", "cha ca thu"]);
  console.log("  ✓ #855 căn cứ dòng hàng: phủ nhận «kg có order X» không phải lời mua · gọi tên tắt «mực giã tay» · giỏ trống mà khách gọi tên một món ⇒ món đơn cũ là món lạ · «như lần trước» mới mở món đơn cũ");
}

function testClaim() {
  // 680.000 ₫ = tổng của giỏ máy chủ đã TỪ CHỐI (món khách không chọn) ⇒ chặn + người, kể cả khi chưa có báo giá hợp lệ nào để so.
  const facts = { paymentVerified: false, orderConfirmed: false, orderCancelled: false, allowedAmounts: new Set([0, 280_000, 400_000, 680_000]) };
  assert.equal(guardClaims("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ", facts).ok, true, "trước bản vá: 680k nằm trong tập tham chiếu nên lọt");
  const v = guardClaims("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ", { ...facts, rejected: new Set([680_000]) });
  assert.ok(!v.ok && v.claim === "PRICE_UNVERIFIED" && v.handoff && v.safeText === CLAIM_SAFE_TEXT.PRICE, JSON.stringify(v));
  // Tổng của giỏ hiện tại / giá một đơn vị KHÔNG bị chặn dù trùng số đã từ chối.
  assert.equal(guardClaims("Dạ tổng 400.000 ₫ ạ", { ...facts, rejected: new Set([680_000]) }).ok, true);
  assert.equal(guardClaims("Dạ 680.000 ₫ ạ", { ...facts, rejected: new Set([680_000]), totals: { allowed: new Set([680_000]), current: { total: 680_000, shipping: null }, stale: false } }).ok, true, "khách thật sự đặt cả hai ⇒ tổng hợp lệ");
  console.log("  ✓ #855 tiền: tổng của giỏ máy chủ đã từ chối luôn bị chặn + người, kể cả khi chưa có báo giá để so");
}

function testFrustration() {
  const offered = ["Dạ lần này em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?"];
  const base = { before: undefined, after: undefined, hasOffer: true, corrections: 0, turn: 9 };
  // Phủ nhận ĐÚNG món bot đã đưa ra ⇒ mâu thuẫn đơn ⇒ người.
  const deny = frustrationSignal({ ...base, offeredTexts: offered, text: "Kg có order chả cá thu nha" });
  assert.equal(deny?.kind, "DENIED_BOT_ITEM");
  assert.match(deny?.reason ?? "", /KHÔNG tự chốt/);
  assert.equal(deny?.inDraft, false, "món chỉ nằm trong chữ đề nghị, chưa vào đơn nháp ⇒ không gắn cờ đơn");
  // Phủ nhận một món CHƯA ai đưa ra / chưa có đề nghị nào ⇒ chỉ là lời chọn món.
  assert.equal(frustrationSignal({ ...base, text: "Kg có order chả cá thu nha" }), null);
  assert.equal(frustrationSignal({ ...base, hasOffer: false, text: "Không đặt chả cá, lấy chả mực" }), null);
  // REVIEW PR #862 (blocker): từ chối lời mời thêm món / câu thường có «không đặt / order» KHÔNG phải phủ nhận món.
  const mucCart: CartCommitment = { selectedItems: [{ label: "Chả mực giã tay", match: "cha muc gia tay", productId: "p", variantId: "v", sku: null, quantity: 1000, unit: "g", sourceMessageId: 1, confidence: "HIGH", customerExplicit: true }], turn: 1, at: new Date().toISOString() };
  for (const t of ["thôi không đặt thêm gì nữa em", "không order thêm đâu em", "k order thêm nha", "chị không đặt cọc đâu, ship COD nhé", "không đặt nhiều đâu, 1kg thôi", "không đặt trước được hả em", "sao k đặt được vậy em", "ko đặt ship nhanh nha"]) {
    assert.equal(frustrationSignal({ ...base, before: mucCart, after: mucCart, hasDraft: true, offeredTexts: ["Tóm tắt: 1kg chả mực giã tay 400.000 ₫. Mình lấy thêm gì không ạ?"], text: t }), null, `«${t}» không chuyển người`);
    assert.equal(deniedItemLabel(t), null, `«${t}» không phủ nhận món nào`);
    assert.notEqual(classifyCartMessage(t).kind, "REMOVE", `«${t}» không bỏ món`);
  }
  // Món phủ nhận nằm trong đơn nháp (giỏ gắn mã) ⇒ cờ đơn.
  const both: CartCommitment = { ...mucCart, selectedItems: [...mucCart.selectedItems, { ...mucCart.selectedItems[0], label: "Chả cá thu", match: "cha ca thu", productId: "p2", customerExplicit: false }] };
  assert.equal(frustrationSignal({ ...base, before: both, after: both, hasDraft: true, text: "Không có order chả cá thu nha" })?.inDraft, true);
  for (const t of ["Robot hả", "Khách cũ mà hỏi gì", "Sao kg coi ở trên", "Địa chỉ coi lại", "trả lời như máy vậy", "hỏi hoài vậy", "xem lại giúp chị nha"]) assert.ok(isComplaint(t), `phàn nàn: ${t}`);
  for (const t of ["để chị xem lại nha", "bớt 1kg nhé em", "cho chị mấy gói", "ship cho chị trước 5h", "ok em", "em hỏi gì nữa không", "chị coi lại rồi"]) assert.ok(!isComplaint(t), `không phải phàn nàn: ${t}`);
  for (const t of ["cho chị gặp nhân viên", "nhân viên đâu", "có ai không", "cho minh gap nhan vien", "người thật trả lời giúp"]) assert.ok(asksForHuman(t), `xin người: ${t}`);
  for (const t of ["gọi cho người nhận trước khi giao nhé", "nhân viên giao hàng gọi chị nhé", "có ai nhận thay cũng được", "cho chị gặp nhân viên giao hàng", "ship hàng có nhân viên giao tận nhà không", "người nhận là chồng chị nhé"]) assert.ok(!asksForHuman(t), `không phải xin người: ${t}`);
  assert.equal(frustrationSignal({ ...base, text: "Robot hả" })?.kind, "COMPLAINT");
  assert.equal(frustrationSignal({ ...base, text: "cho chị gặp nhân viên" })?.kind, "ASKS_HUMAN");
  // REVIEW PR #862: khách TỰ đổi ý không đếm; chỉ lời nói BOT SAI mới đếm — lần thứ CORRECTION_HANDOFF_AT ⇒ người.
  const cart = (q: number): CartCommitment => ({ selectedItems: [{ label: "Chả cá thu", match: "cha ca thu", productId: "p", variantId: "v", sku: null, quantity: q, unit: "g", sourceMessageId: 1, confidence: "HIGH", customerExplicit: true }], turn: 1, at: new Date().toISOString() });
  for (const t of ["đổi 2kg", "à thôi 3kg", "thôi lấy 3kg", "đổi 1kg thôi", "bớt 1kg"]) {
    assert.equal(isCorrectionTurn({ text: t, hasOffer: true }), false, `«${t}» là khách tự đổi ý`);
    assert.equal(frustrationSignal({ ...base, before: cart(2000), after: cart(3000), text: t, corrections: CORRECTION_HANDOFF_AT - 1 }), null, `«${t}» không chuyển người`);
  }
  assert.ok(isCorrectionTurn({ text: "sai rồi em, chị lấy 1 gói thôi", hasOffer: true }));
  assert.ok(!isCorrectionTurn({ text: "sai rồi em", hasOffer: false }), "chưa có đề nghị nào thì không phải bot sai");
  assert.equal(frustrationSignal({ ...base, text: "sai rồi em, chị lấy 1 gói thôi", corrections: 0 }), null, "lần đầu nói bot sai ⇒ AI sửa");
  assert.equal(frustrationSignal({ ...base, text: "không phải, chị nói 1 gói mà", corrections: CORRECTION_HANDOFF_AT - 1 })?.kind, "REPEATED_CORRECTION");
  console.log("  ✓ #855 khách bực / đơn mâu thuẫn: phủ nhận ĐÚNG món bot đưa ra · xin người (không tính nhân viên giao hàng) · phàn nàn · nói bot sai lần thứ hai ⇒ người; từ chối lời mời «không đặt thêm» / «không đặt cọc» và khách tự đổi ý KHÔNG chuyển người");
}

function testAddress() {
  // «Lieu Dau»: thị trấn huyện lỵ đổi tên ngay trước 2025 ⇒ tên khách gõ trùng ĐÚNG MỘT xã mới có đất của huyện cũ ⇒ xã đó.
  for (const t of ["Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An", "xóm 3 TT Anh Sơn, huyện Anh Sơn, Nghệ An", "Tt Anh Sơn huyện Anh Sơn tỉnh Nghệ An"]) {
    const m = normalizeVnAddress(t);
    assert.ok(m.status === "MATCHED" && m.ward.name === "Xã Anh Sơn" && m.via === "LEGACY", `${t}: ${JSON.stringify(m)}`);
    assert.equal(parseCustomerAddress(t).confidence, "UNIQUE_FROM_OLD");
  }
  // REVIEW PR #862: huyện khách ghi MÂU THUẪN với thị trấn («thị trấn Anh Sơn, huyện Đô Lương») ⇒ không ghép, không hỏi khách quy đổi
  // (khách đã ghi xã cũ) ⇒ đơn đi với cờ cần kiểm địa chỉ.
  const conflict = normalizeVnAddress("thị trấn Anh Sơn, huyện Đô Lương, Nghệ An");
  assert.equal(conflict.status, "AMBIGUOUS", JSON.stringify(conflict));
  assert.ok(oldWardSplit(parseCustomerAddress("Khối 5, thị trấn Anh Sơn, huyện Đô Lương, Nghệ An")), "không hỏi khách quy đổi");
  // Căn cứ đọc từ DỮ LIỆU: xã mới giữ tên huyện có đất của chính huyện đó (huyện lỵ). Ghi huyện đúng / không ghi huyện ⇒ ghép.
  for (const t of ["thị trấn Anh Sơn, Nghệ An", "Khối 5, TT Anh Sơn, Anh Sơn, Nghệ An"]) assert.equal((normalizeVnAddress(t) as { ward?: { name: string } }).ward?.name, "Xã Anh Sơn", t);
  // Chỉ có tên huyện (không «thị trấn») ⇒ vẫn là chọn trong các xã của huyện — không đoán.
  assert.equal(normalizeVnAddress("Anh Sơn, Nghệ An").status, "AMBIGUOUS");
  // Phường cũ bị CHIA mà khách đã ghi đủ ⇒ quy đổi là việc của shop (không hỏi khách).
  assert.ok(oldWardSplit(parseCustomerAddress("SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội")));
  assert.ok(!oldWardSplit(parseCustomerAddress("230 Phan Huy Ích, Quận Gò Vấp, TP Hồ Chí Minh")), "chỉ quận cũ ⇒ phường là phần thiếu thật");

  // NGUỒN ĐỊA CHỈ: địa chỉ khách gõ MỚI HƠN thắng địa chỉ cũ / đã lưu.
  const asksOld = (t: string) => /dia chi cu|nhu cu/.test(foldVi(t));
  const newer = ["Ship chị 1 mực giã tay", "12 Lê Văn Việt, phường Tăng Nhơn Phú, TP HCM"];
  const v1 = addressProvenanceVerdict({ writing: "Số 3 ngõ 5 Khương Đình", province: "Hà Nội", customerTexts: newer, asksOld });
  assert.ok(!v1.ok && v1.kind === "NEWER_STATED" && /Lê Văn Việt/.test(v1.stated), JSON.stringify(v1));
  assert.ok(addressProvenanceVerdict({ writing: "12 Lê Văn Việt, Tăng Nhơn Phú, TP Hồ Chí Minh", customerTexts: newer, asksOld }).ok, "ghi đúng địa chỉ khách ⇒ qua");
  // Khách gõ mới RỒI lại xin địa chỉ cũ ⇒ mâu thuẫn, người quyết.
  const v2 = addressProvenanceVerdict({ writing: "Số 3 ngõ 5 Khương Đình", province: "Hà Nội", customerTexts: [...newer, "à thôi giao địa chỉ cũ nhé"], asksOld });
  assert.ok(!v2.ok && v2.kind === "CONFLICT", JSON.stringify(v2));
  // Dòng sắp ghi nằm trong một tin khách MỚI HƠN (bộ đọc chưa tự điền được) ⇒ đó là địa chỉ mới nhất.
  assert.ok(addressProvenanceVerdict({ writing: "kiot 7 chợ Hôm", customerTexts: [...newer, "à giao chị ra kiot 7 chợ Hôm nhé"], asksOld }).ok);
  // Không có địa chỉ khách gõ ⇒ không chặn (khách cũ dùng lại địa chỉ đã xác minh đi đường use_saved_address).
  assert.ok(addressProvenanceVerdict({ writing: "Số 3 ngõ 5 Khương Đình", province: "Hà Nội", customerTexts: ["Ship chị 1 mực giã tay", "giao địa chỉ cũ nhé"], asksOld }).ok);
  // SĐT dính đầu dòng địa chỉ không làm lệch số nhà.
  assert.ok(addressProvenanceVerdict({ writing: "Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An", customerTexts: ["0977000555 Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An"], asksOld }).ok);
  assert.equal(customerStatedAddresses(["0977000555 Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An"])[0]?.ward, "Xã Anh Sơn");

  // GIỮ ĐƠN KHỎI TUYẾN GIAO: ô xã trống ⇒ NO_WARD; lý do cần kiểm «món khách chưa đồng ý» ⇒ REVIEW_OPEN; ADDRESS_UNRESOLVED một mình không
  // chặn đơn đã có xã (nhân viên chọn xã xong là đi).
  const cfg = { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null, autoSince: null };
  const o = { isErp: true, stage: "CONFIRMED", province: "Tỉnh Nghệ An", ward: "", hasLiveShipment: false, weightGrams: 1000, confirmedAt: new Date(), updatedAt: new Date(), auto: null };
  const r1 = decideShippingRoute(o, cfg, new Set(), new Date());
  assert.ok(r1.kind === "HOLD" && r1.code === "NO_WARD");
  const r2 = decideShippingRoute({ ...o, ward: "Xã Anh Sơn", reviewCodes: ["UPSELL_UNCONSENTED"] }, cfg, new Set(), new Date());
  assert.ok(r2.kind === "HOLD" && r2.code === "REVIEW_OPEN", JSON.stringify(r2));
  const r3 = decideShippingRoute({ ...o, ward: "Xã Anh Sơn", reviewCodes: ["ADDRESS_UNRESOLVED"] }, cfg, new Set(), new Date());
  assert.ok(!(r3.kind === "HOLD" && r3.code === "REVIEW_OPEN"), JSON.stringify(r3));
  console.log("  ✓ #855 địa chỉ: «TT Anh Sơn, huyện Anh Sơn» ⇒ Xã Anh Sơn · phường cũ bị chia không hỏi khách · địa chỉ khách gõ mới hơn thắng địa chỉ cũ, mới rồi lại cũ ⇒ người · tuyến giao giữ NO_WARD / REVIEW_OPEN");
}

// ═══ HỘI THOẠI VÀNG (chatTurn thật) ═══

const OLD_ADDR = "Số 3 ngõ 5 Khương Đình";
const NEW_ADDR = "12 Lê Văn Việt, phường Tăng Nhơn Phú, TP HCM";
const HN = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";

/** Chả cá thu 1kg (280.000 ₫) — món của ĐƠN CŨ trong ca ThuyNgo; cửa hàng thử «food» chưa có. */
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

const CASES: GoldenCase[] = [
  {
    key: "p855-thuyngo-bao-gia-mon-la",
    title: "ThuyNgo lượt 1: «Ship chị 1 mực giã tay» — model tính giỏ thêm chả cá thu (đơn cũ) ⇒ máy chủ từ chối, câu «tổng 680.000 ₫» bị chặn + người",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855-don-cu-1", threadId: "pg-vang_psid-p855-1" }),
        say: "Ship chị 1 mực giã tay",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ, em gửi về địa chỉ cũ nhé?")]],
      },
    ],
  },
  {
    key: "p855-thuyngo-phu-nhan-mon",
    title: "ThuyNgo: báo giá đúng 1kg chả mực 400.000 ₫ → «Kg có order chả cá thu nha» ⇒ người ngay (không lượt AI) → «Robot hả» ⇒ bot im",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Ship chị 1 mực giã tay", ai: [() => [say("Dạ lần trước chị lấy chả cá thu, lần này em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?")]] },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ em xin lỗi ạ")]] },
      { say: "Robot hả", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
  {
    key: "p855-phu-nhan-mon-co-don-nhap",
    title: "Đơn nháp có món khách phủ nhận («không có order chả cá thu») ⇒ người + cờ CẦN NGƯỜI KIỂM «món khách chưa đồng ý» trên đơn, không tự chốt",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 1 gói chả mực giã tay và 1 gói chả cá thu, Ngọc 0977000888, ${HN}`,
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
    key: "p855-khong-lap-xin-loi",
    title: "Model gửi lại ĐÚNG câu xin lỗi + hỏi lại vừa gửi ⇒ câu lặp bị bỏ, chuyển người (không vòng xin lỗi)",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Ship chị 1 chả mực giã tay", ai: [() => [say("Dạ em xin lỗi, chị cho em xin địa chỉ nhận hàng ạ?")]] },
      { say: "chị gửi ở trên rồi", ai: [() => [say("Dạ em xin lỗi, chị cho em xin địa chỉ nhận hàng ạ?")]] },
    ],
  },
  {
    key: "p855-khach-cu-phan-nan-fanpage",
    title: "ThuyNgo trên fanpage: «Khách cũ mà hỏi gì» ⇒ người, bot im (không xin lỗi lặp, không hỏi lại địa chỉ)",
    shop: "food",
    channel: "FANPAGE",
    turns: [
      { say: "Ship chị 1 chả mực giã tay", ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ chị cho em xin địa chỉ nhận hàng ạ")]] },
      { say: "Khách cũ mà hỏi gì", ai: [() => [say("Dạ em xin lỗi chị, chị cho em xin lại địa chỉ ạ")]] },
      { say: "Sao kg coi ở trên", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
  {
    key: "p855-dia-chi-moi-thang-cu",
    title: "Khách cũ gõ địa chỉ MỚI (Thủ Đức) ở tin sau ⇒ create_customer bằng địa chỉ cũ (Khương Đình) bị từ chối; ghi đúng địa chỉ khách gõ; sửa đơn về địa chỉ cũ cũng bị từ chối",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855-don-cu-2", threadId: "pg-vang_psid-p855-2" }),
        say: "Ship chị 1 chả mực giã tay",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ 1kg chả mực giã tay 400.000 ₫ ạ, em gửi về địa chỉ nào ạ?")]],
      },
      {
        say: `Giao về ${NEW_ADDR}
0977000333`,
        ai: [
          () => [tool("create_customer", { name: "Thủy", phone: "0977000333", address: OLD_ADDR, province: "Hà Nội" })],
          () => [tool("create_customer", { name: "Thủy", phone: "0977000333", address: NEW_ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ results }) => [say(`Tóm tắt đơn: 1kg chả mực giã tay, tổng thu ${String(results[0]?.cod_total_text)}. Chị xác nhận giúp em nhé?`)],
        ],
      },
      { say: "ok em", ai: [() => [tool("update_draft_order", { address: `${OLD_ADDR}, Hà Nội` })], () => [say("Dạ vâng ạ.")]] },
    ],
  },
  {
    key: "p855-dia-chi-moi-roi-cu",
    title: "Khách gõ địa chỉ mới rồi lại «giao địa chỉ cũ» ⇒ máy chủ KHÔNG chọn hộ: chuyển người",
    shop: "food",
    channel: "WEB",
    turns: [
      { before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855-don-cu-3", threadId: "pg-vang_psid-p855-3" }), say: "lấy 1 chả mực giã tay", ai: [() => [say("Dạ chị gửi em địa chỉ nhận hàng ạ.")]] },
      { say: `Giao tới ${NEW_ADDR}, 0977000444`, ai: [() => [say("Dạ em ghi nhận ạ.")]] },
      { say: "à thôi giao địa chỉ cũ nhé", ai: [() => [tool("create_customer", { use_saved_address: true, customer_confirmation: "giao địa chỉ cũ nhé" })], () => [say("Dạ em cập nhật địa chỉ cũ rồi ạ.")]] },
    ],
  },
  {
    key: "p855-lieu-dau-thi-tran",
    title: "Lieu Dau: «Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An» ⇒ Xã Anh Sơn, không hỏi xã, chốt đơn có ô xã",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "Chị lấy 1 chả mực giã tay\nLiễu 0977000555\nKhối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An",
        ai: [
          () => [tool("create_customer", { name: "Liễu", phone: "0977000555", address: "Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ results }) => [say(`Tóm tắt đơn: 1kg chả mực giã tay, tổng thu ${String(results[0]?.cod_total_text)}. Chị xác nhận giúp em nhé?`)],
        ],
      },
      { say: "ok em chốt nhé", ai: [() => [tool("confirm_order", { customer_confirmation: "ok em chốt nhé" })], () => [say("Dạ em cảm ơn chị ạ.")]] },
    ],
  },
  {
    key: "p855-phuong-cu-bi-chia",
    title: "Phường cũ bị chia (Cổ Nhuế 2): không hỏi khách quy đổi — câu model tự hỏi bị bỏ; chốt kèm cờ địa chỉ, tuyến giao giữ NO_WARD",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "lấy 1 chả mực giã tay\nNguyệt 0977000666\nSN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội",
        ai: [
          () => [tool("create_customer", { name: "Nguyệt", phone: "0977000666", address: "SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          () => [say("Dạ phường Cổ Nhuế 2 cũ nay thuộc phường Thượng Cát hay phường Đông Ngạc theo địa giới mới ạ?")],
        ],
      },
      { say: "ok em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok em" })], () => [say("Dạ em cảm ơn chị ạ.")]] },
    ],
  },
  {
    key: "p855-chu-shop-noi-khong-phai-khach",
    title: "Tin của SHOP nhắc chả cá thu (page / nhân viên) KHÔNG phải lời khách đặt: giỏ có chả cá bị từ chối, giỏ đúng 1kg chả mực 400.000 ₫",
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
    key: "p855-sua-don-hai-lan",
    title: "Khách sửa đơn bot đề nghị lần thứ hai ⇒ người, không chốt, không đơn thứ hai",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 2 gói chả mực giã tay, Hà 0977000777, ${HN}`,
        ai: [() => [tool("create_customer", { name: "Hà", phone: "0977000777", address: HN })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }] })], () => [say("Tóm tắt: 2 gói chả mực. Chị xác nhận giúp em nhé?")]],
      },
      { say: "sai rồi em, chị lấy 1 gói thôi", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em sửa còn 1 gói ạ.")]] },
      { say: "không phải, chị nói 1 gói mà", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [tool("confirm_order", { customer_confirmation: "không phải, chị nói 1 gói mà" })]] },
    ],
  },
  {
    key: "p855-khach-tu-doi-y",
    title: "Khách TỰ đổi ý hai lần («đổi 2 gói» → «à thôi 3 gói») ⇒ mua bình thường, KHÔNG chuyển người; từ chối lời mời «không đặt thêm» ⇒ không chuyển người",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 1 gói chả mực giã tay, Hà 0977000901, ${HN}`,
        ai: [() => [tool("create_customer", { name: "Hà", phone: "0977000901", address: HN })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Tóm tắt: 1 gói chả mực. Mình lấy thêm gì không ạ?")]],
      },
      { say: "đổi 2 gói", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }] })], () => [say("Dạ em sửa 2 gói ạ.")]] },
      { say: "à thôi 3 gói", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 3 }] })], () => [say("Dạ em sửa 3 gói ạ.")]] },
      { say: "thôi không đặt thêm gì nữa em", ai: [() => [say("Dạ vâng ạ.")]] },
    ],
  },
  {
    key: "p855-nhan-vien-tiep-quan",
    title: "Nhân viên bấm TIẾP QUẢN ⇒ lượt khách sau không gọi model, bot không gửi gì",
    shop: "food",
    channel: "FANPAGE",
    turns: [
      { say: "chả mực giã tay bao nhiêu em", ai: [() => [tool("search_products", { query: "chả mực" })], () => [say("Dạ chả mực giã tay 400.000 ₫ một gói 1kg ạ.")]] },
      {
        before: async (ctx) => {
          const r = await setConversationControlCore(await ctx.admin(), ctx.conversationId, "HUMAN", "Nhân viên gọi lại khách");
          assert.ok(r.ok, JSON.stringify(r));
        },
        say: "Robot hả, sao không trả lời",
        ai: [() => [say("Dạ em đây ạ")]],
      },
    ],
  },
  {
    key: "p855-khung-thu-phat-lai",
    title: "Khung THỬ (đường phát lại): khách bực ⇒ chuyển người nhưng không ghi khách / đơn thật, không gửi gì ra ngoài",
    shop: "food",
    channel: "TEST",
    turns: [
      { say: "Ship chị 1 mực giã tay", ai: [() => [say("Dạ em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?")]] },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
];

async function ordersOf(conversationId: string) {
  const db = await getDb();
  return db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId));
}

async function stateOf(conversationId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  return { row, state: (row.state ?? {}) as ChatState };
}

async function testGolden() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-p855",
    beforeCase: async (_c, ctx) => seedCa(ctx),
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const { row, state } = await stateOf(ctx.conversationId);
      const orders = await ordersOf(ctx.conversationId);
      assert.ok(orders.length <= 1, `[${c.key}] không đơn trùng: ${orders.length}`);
      assert.ok(!/680\.000/.test(shownAll(t)), `[${c.key}] khách không bao giờ thấy 680.000 ₫: ${shownAll(t)}`);
      switch (c.key) {
        case "p855-thuyngo-bao-gia-mon-la": {
          assert.match(resultsOf(t, 0), /KHÔNG tính giỏ có «Chả cá thu»/, resultsOf(t, 0));
          assert.ok(!state.quote || state.quote.subtotal !== 680_000, "báo giá 680k không được lưu");
          assert.ok(state.rejectedTotals?.includes(680_000), JSON.stringify(state.rejectedTotals));
          assert.equal(t.final.status, "HANDOFF", "câu tổng sai ⇒ người");
          assert.deepEqual(orders, []);
          return;
        }
        case "p855-thuyngo-phu-nhan-mon": {
          assert.equal(t.turns[1].rounds.length, 0, "phủ nhận món ⇒ không lượt AI");
          assert.equal(t.turns[2].rounds.length, 0, "đã chuyển người ⇒ «Robot hả» không gọi model");
          assert.deepEqual(t.turns[2].shown, [], "không xin lỗi lặp");
          assert.ok(t.final.handoffReason?.startsWith(FRUSTRATION_HANDOFF_PREFIX), t.final.handoffReason ?? "");
          assert.match(t.final.handoffReason ?? "", /phủ nhận món/);
          // Không tự hết hạn: chờ nhân viên trả lại cho AI.
          assert.equal(aiHoldOf({ status: row.status, handoffReason: row.handoffReason, state: row.state, updatedAt: row.updatedAt, humanCooldownUntil: row.humanCooldownUntil }, new Date(Date.now() + 24 * 3_600_000)).state, "HUMAN_TAKEOVER");
          assert.equal(row.nextFollowupAt, null, "không follow-up tự động");
          assert.deepEqual(orders, []);
          return;
        }
        case "p855-phu-nhan-mon-co-don-nhap": {
          assert.equal(t.turns[1].rounds.length, 0, "phủ nhận món ⇒ không lượt AI");
          assert.equal(t.final.status, "HANDOFF");
          assert.equal(t.final.confirmed, null, "không tự chốt");
          assert.equal(orders.length, 1);
          assert.notEqual(orders[0].stage, "CONFIRMED");
          assert.ok(reviewCodes(orderReviewOf(orders[0].raw)).includes("UPSELL_UNCONSENTED"), JSON.stringify(orders[0].raw));
          return;
        }
        case "p855-khong-lap-xin-loi": {
          assert.equal(t.turns[1].shown.filter((x) => /xin lỗi/.test(x)).length, 0, `câu xin lỗi không gửi lần hai: ${JSON.stringify(t.turns[1].shown)}`);
          assert.equal(t.final.status, "HANDOFF");
          assert.match(t.final.handoffReason ?? "", /lặp lại câu xin lỗi/);
          return;
        }
        case "p855-khach-cu-phan-nan-fanpage": {
          assert.equal(t.turns[1].rounds.length, 0);
          assert.deepEqual(t.turns[1].shown, [], "fanpage chuyển người ⇒ bot im");
          assert.equal(t.turns[2].rounds.length, 0);
          assert.deepEqual(t.turns[2].shown, []);
          assert.match(t.final.handoffReason ?? "", /phàn nàn/);
          return;
        }
        case "p855-dia-chi-moi-thang-cu": {
          assert.match(resultsOf(t, 1), /KHÁC địa chỉ khách vừa gõ/);
          assert.ok(!/hỏi khách xác nhận dùng lại/.test(resultsOf(t, 1)), "khách đã gõ địa chỉ mới ⇒ không bảo model hỏi dùng lại địa chỉ cũ");
          assert.match(t.final.customer?.address ?? "", /Lê Văn Việt/);
          assert.equal(orders.length, 1);
          assert.match(orders[0].shipAddress ?? "", /Lê Văn Việt/, "đơn mang địa chỉ khách gõ mới nhất");
          assert.match(resultsOf(t, 2), /KHÁC địa chỉ khách vừa gõ/, "sửa đơn về địa chỉ cũ ⇒ từ chối");
          assert.deepEqual(t.final.draft?.lines.map((l) => [l.sku, l.quantity]), [["CHA-MUC", 1]], "không thêm SKU, đúng số lượng");
          return;
        }
        case "p855-dia-chi-moi-roi-cu": {
          assert.equal(t.turns[2].rounds.length, 1, "công cụ từ chối + chuyển người ⇒ không vòng model thêm");
          assert.equal(t.final.status, "HANDOFF");
          assert.match(t.final.handoffReason ?? "", /địa chỉ/);
          assert.ok(!state.customer || !/ngõ 5 Khương Đình|Số 8 ngõ 2/.test(state.customer.address), "không lặng lẽ dùng địa chỉ cũ");
          return;
        }
        case "p855-lieu-dau-thi-tran": {
          assert.ok(!/ask_customer":"Dạ/.test(resultsOf(t, 0)), `không hỏi xã: ${resultsOf(t, 0).slice(0, 400)}`);
          assert.match(resultsOf(t, 0), /Xã Anh Sơn/);
          assert.ok(!/phường \/ xã/.test(shownAll(t)), shownAll(t));
          assert.equal(orders.length, 1);
          assert.equal(orders[0].stage, "CONFIRMED");
          assert.equal(orders[0].shipCommune, "Xã Anh Sơn", "đơn có ô xã theo địa giới mới");
          assert.ok(!reviewCodes(orderReviewOf(orders[0].raw)).includes("ADDRESS_UNRESOLVED"));
          return;
        }
        case "p855-phuong-cu-bi-chia": {
          assert.ok(!/cũ nay thuộc/.test(shownAll(t)), `không bắt khách quy đổi: ${shownAll(t)}`);
          assert.equal(orders.length, 1);
          assert.equal(orders[0].stage, "CONFIRMED", "đơn đi tiếp, nhân viên chọn xã");
          assert.equal(orders[0].shipCommune ?? "", "", "không đoán xã");
          assert.ok(reviewCodes(orderReviewOf(orders[0].raw)).includes("ADDRESS_UNRESOLVED"), "cờ cần kiểm địa chỉ");
          const route = decideShippingRoute({ isErp: true, stage: orders[0].stage, province: orders[0].shipProvince ?? "", ward: orders[0].shipCommune ?? "", hasLiveShipment: false, weightGrams: 1000, confirmedAt: new Date(), updatedAt: new Date(), auto: null, reviewCodes: reviewCodes(orderReviewOf(orders[0].raw)) }, { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null, autoSince: null }, new Set(), new Date());
          assert.ok(route.kind === "HOLD" && route.code === "NO_WARD", "không giao khi chưa có xã");
          return;
        }
        case "p855-chu-shop-noi-khong-phai-khach": {
          const r = t.turns[0].rounds.map((x) => JSON.stringify(x.results));
          assert.match(r[0], /KHÔNG tính giỏ có «Chả cá thu»/, r[0]);
          assert.match(shownAll(t), /400\.000 ₫/);
          assert.equal(state.quote?.subtotal, 400_000);
          return;
        }
        case "p855-sua-don-hai-lan": {
          assert.equal(t.turns[2].rounds.length, 0, "lần sửa thứ hai ⇒ người, không lượt AI");
          assert.match(t.final.handoffReason ?? "", /nói bot sai 2 lần/);
          assert.equal(t.final.confirmed, null, "không tự chốt");
          assert.equal(orders.length, 1);
          assert.notEqual(orders[0].stage, "CONFIRMED");
          return;
        }
        case "p855-khach-tu-doi-y": {
          assert.notEqual(t.final.status, "HANDOFF", `khách tự đổi ý / từ chối lời mời không phải lý do chuyển người: ${t.final.handoffReason}`);
          assert.ok(t.turns.every((x) => x.rounds.length > 0), "mọi lượt đều được AI trả lời");
          assert.equal(orders.length, 1);
          assert.ok(!reviewCodes(orderReviewOf(orders[0].raw)).includes("UPSELL_UNCONSENTED"), "không gắn cờ món chưa đồng ý");
          assert.deepEqual(t.final.draft?.lines.map((l) => [l.sku, l.quantity]), [["CHA-MUC", 3]]);
          return;
        }
        case "p855-nhan-vien-tiep-quan": {
          assert.equal(t.turns[1].rounds.length, 0, "tiếp quản ⇒ không gọi model");
          assert.deepEqual(t.turns[1].shown, []);
          return;
        }
        case "p855-khung-thu-phat-lai": {
          assert.equal(t.turns[1].rounds.length, 0);
          assert.equal(t.final.status, "HANDOFF");
          assert.equal(t.final.order, null, "khung THỬ không tạo đơn");
          assert.deepEqual(orders, []);
          const db = await getDb();
          const customers = await db.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.phone, "0977000999")));
          assert.deepEqual(customers, []);
          return;
        }
      }
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
  console.log(`  ✓ #855 hội thoại vàng: ${CASES.length} hội thoại qua chatTurn thật — không món lạ / tổng lệch đơn (680.000 ₫ không tới khách), địa chỉ khách gõ mới nhất thắng địa chỉ cũ, mới rồi cũ ⇒ người, «TT Anh Sơn» ⇒ Xã Anh Sơn không hỏi, phường cũ bị chia không bắt khách quy đổi + NO_WARD, tin shop không phải lời khách, phủ nhận món / phàn nàn / sửa hai lần ⇒ người + bot im, tiếp quản ⇒ im, không đơn trùng, khung THỬ không ghi`);
}

export async function testSalesP0855() {
  testBasis();
  testClaim();
  testFrustration();
  testAddress();
  await testGolden();
}

if (process.argv[1] && /sales-p0-855.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testSalesP0855)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

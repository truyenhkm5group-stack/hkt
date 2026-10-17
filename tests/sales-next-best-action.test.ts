/**
 * P0 #868 (chủ shop 16/10/2026) — GIỮ upsell / cross-sell nhưng THÔNG MINH: lời mời là cơ hội, không bao giờ chặn / làm chậm một đơn hợp lệ.
 *
 * Ca gốc (HSLC, hội thoại 882e7e23…): khách đã chọn 2kg chả cá thu mà bot quảng cáo dài, hỏi lại «1kg hay 2kg», lặp menu rồi mới tóm
 * tắt — vì máy chủ TỪ CHỐI lên đơn khi chưa gửi câu mẫu upsell (`tools.ts`, cổng 02/10/2026) và lời nhắc B4 buộc gửi menu ngay sau
 * create_customer.
 *
 *  1. THUẦN (`next-best-action.ts`): phân loại câu (mời gói lớn · mời món kèm · hỏi lại quy cách · bảng giá · lời chào; «lấy thêm gì
 *     không» chung chung KHÔNG là lời mời); cửa sổ lời mời (một lần mỗi lượt mua, đóng khi khách gửi SĐT / địa chỉ, đơn đang lên, đã
 *     chốt, phàn nàn, từ chối, chuyển người, đơn lỗi / huỷ); từ chối lời mời; hàng rào từng câu (lý do giá thật, món đủ điều kiện,
 *     tư vấn khi khách tự hỏi, giọng không bao giờ làm rỗng tin); lý do giá theo gram (`volumeSaveFrom`).
 *  2. chatTurn THẬT + công cụ thật + PGlite (`gd-food-nba`): khách chọn 2kg ⇒ không «1kg hay 2kg», không bảng giá, một lời mời món kèm
 *     đủ điều kiện, đơn lên + tự chốt NGAY khi khách gửi SĐT / địa chỉ (câu mẫu menu lúc đó bị từ chối, không chặn đơn); khách từ chối ⇒
 *     không mời lại, khách tự hỏi món khác ⇒ trả lời bình thường; lời mời lúc khách gửi địa chỉ bị bỏ; mời 2kg chỉ khi danh mục có giảm
 *     thật theo kg; món kèm hết hàng / không do shop khai bổ trợ ⇒ không bao giờ tới khách.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { createProductCore } from "@/lib/records/product-create";
import type { CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { classifySentence, contactInfoIn, guardReply, namedIn, needsOfferFacts, offerDeclinedBy, offerWindow, splitSentences, type OfferFacts, type OfferWindow } from "@/lib/sales-chatbot/next-best-action";
import { volumeSaveFrom } from "@/lib/sales-chatbot/offer-facts";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const cart = (label: string, grams: number, explicit = true): CartCommitment => ({ selectedItems: [{ label, match: label.toLowerCase(), productId: null, variantId: null, sku: null, quantity: grams, unit: "g", sourceMessageId: 3, confidence: "HIGH", customerExplicit: explicit }], turn: 3, at: new Date(0).toISOString() });
const FACTS: OfferFacts = { catalogNames: ["Chả cá thu", "Chả mực giã tay", "Cá thu một nắng", "Mực khô câu", "Nước mắm cốt Cát Hải"], crossSell: ["Chả mực giã tay"], volume: [{ name: "Chả cá thu", saveFromGrams: 2000 }], menu: true, freeShip: false };
const OPEN: OfferWindow = { open: true };

function testClassify() {
  assert.equal(classifySentence("Dạ em chào chị ạ!"), "GREETING");
  assert.equal(classifySentence("Dạ em chào chị, chị cần tư vấn món gì ạ?"), null, "lời chào kèm câu hỏi không phải lời chào lặp");
  assert.equal(classifySentence("Chị lấy 1kg hay 2kg ạ?"), "SIZE_REASK");
  assert.equal(classifySentence("1kg 280.000đ, 2kg chỉ 540.000đ thôi ạ."), "PRICE_LIST");
  assert.equal(classifySentence("Lấy 2kg sẽ được giảm 20.000đ, tiết kiệm hơn ạ."), "UPSELL");
  assert.equal(classifySentence("Mình dùng thêm chả mực giã tay ăn kèm không ạ?"), "CROSS_SELL");
  assert.equal(classifySentence("Mình chọn thêm một món trong menu là được miễn ship ạ."), "CROSS_SELL");
  // KHÔNG phải lời mời: câu hỏi chung của bước chốt, câu xác nhận món khách vừa xin, tóm tắt đơn, câu lên đơn.
  for (const s of ["Mình lấy thêm gì không, không thì em giao luôn ạ?", "Dạ mình cần thêm món gì cứ nhắn em ạ.", "Dạ em thêm 1 hũ ruốc vào đơn rồi ạ.", "Dạ đơn 2kg chả cá thu 540.000 ₫ + ship 30.000 ₫, tổng 570.000 ₫.", "Dạ em lên đơn 2kg chả cá thu cho mình nhé."]) assert.equal(classifySentence(s), null, s);
  assert.deepEqual(splitSentences("Dạ 540.000đ ạ. Mình dùng thêm nhé?\nCho em xin SĐT.").join(""), "Dạ 540.000đ ạ. Mình dùng thêm nhé?\nCho em xin SĐT.", "cắt câu giữ nguyên chữ, «540.000đ» không bị cắt");
  assert.equal(needsOfferFacts("Dạ em chào chị. Chị lấy 1kg hay 2kg ạ?"), false, "lượt không có câu mời ⇒ khỏi đọc CSDL");
  assert.equal(needsOfferFacts("Mình dùng thêm chả mực ăn kèm không ạ?"), true);
  assert.deepEqual(namedIn("Chị lấy 2kg cá thu một nắng nhé", FACTS.catalogNames), ["Cá thu một nắng"], "«cá thu một nắng» không phải «Chả cá thu»");
}

function testWindow() {
  const st = (s: Partial<ChatState>) => s as ChatState;
  const w = (s: Partial<ChatState>, text = "cho chị 2kg chả cá thu", extra: { complaint?: boolean; orderError?: boolean; returningPending?: boolean } = {}) => offerWindow({ state: st(s), lastUserText: text, complaint: extra.complaint ?? false, ...extra });
  assert.deepEqual(w({}), { open: true }, "khách vừa chọn món, chưa gửi thông tin ⇒ mở");
  assert.deepEqual(w({}, "Hà 0961003107, 9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội"), { open: false, reason: "CONTACT_INFO" });
  assert.deepEqual(w({}, "Số 5 ngõ 12 Lê Lợi"), { open: false, reason: "CONTACT_INFO" }, "dòng địa chỉ không SĐT vẫn là thông tin nhận hàng");
  assert.deepEqual(w({ customer: { id: null, name: "Hà", phone: "0961003107", address: "x", province: "", simulated: true } }, "ok em"), { open: false, reason: "ORDERING" }, "đã có hồ sơ nhận hàng ⇒ đơn đang lên, không chen lời mời");
  assert.deepEqual(w({}, "ok em", { returningPending: true }), { open: false, reason: "ORDERING" }, "khách cũ xác nhận địa chỉ cũ = lượt lên đơn");
  assert.deepEqual(w({ upsellSent: true }), { open: false, reason: "ALREADY_OFFERED" }, "một lời mời mỗi lượt mua");
  assert.deepEqual(w({ upsellSent: true, upsellDeclinedTurn: 5 }), { open: false, reason: "DECLINED" });
  assert.deepEqual(w({ handoff: { reason: "x", at: "" } }), { open: false, reason: "HANDOFF" });
  assert.deepEqual(w({}, "x", { complaint: true }), { open: false, reason: "COMPLAINT" });
  assert.deepEqual(w({}, "x", { orderError: true }), { open: false, reason: "ORDER_PROBLEM" });
  assert.deepEqual(w({ cancelRequest: { orderIds: [], at: "", turn: 1, quote: null, reason: "x" } }), { open: false, reason: "ORDER_PROBLEM" });
  assert.deepEqual(w({ confirmed: { orderId: null, simulated: true, total: 1, at: "" } }), { open: false, reason: "CONFIRMED" });
  assert.equal(contactInfoIn("cho chị 2kg chả cá thu"), false);
  for (const t of ["không em", "thôi em", "2kg thôi", "không cần đâu", "để lần sau nhé"]) assert.equal(offerDeclinedBy(t), true, t);
  for (const t of ["ok lấy thêm 1 hũ", "lấy 1 hũ nhé", "ừ cho chị thêm nhé"]) assert.equal(offerDeclinedBy(t), false, t);
}

function testGuard() {
  const g = (text: string, o: Partial<Parameters<typeof guardReply>[1]> = {}) => guardReply(text, { window: OPEN, cart: cart("Chả cá thu", 2000), lastUserText: "cho chị 2kg chả cá thu", greetedBefore: true, facts: FACTS, ...o });
  // Ca gốc HSLC: khách đã chọn 2kg.
  const hslc = g("Dạ em chào chị ạ! Chị lấy 1kg hay 2kg ạ? 1kg 280.000đ, 2kg 540.000đ ạ. Mình dùng thêm chả mực giã tay ăn kèm không ạ? Cho em xin SĐT và địa chỉ nhận hàng nhé.");
  assert.equal(hslc.text, "Mình dùng thêm chả mực giã tay ăn kèm không ạ? Cho em xin SĐT và địa chỉ nhận hàng nhé.", hslc.text);
  assert.equal(hslc.offered, "CROSS_SELL");
  assert.deepEqual(hslc.dropped.map((d) => `${d.cls}:${d.reason}`), ["GREETING:STYLE", "SIZE_REASK:SIZE_CHOSEN", "PRICE_LIST:STYLE"]);
  // Không câu nào bị bỏ ⇒ chữ gốc nguyên văn.
  const plain = "Dạ em ghi nhận 2kg chả cá thu ạ.\nCho em xin SĐT nhé.";
  assert.equal(g(plain).text, plain);
  // Hai lời mời trong cùng tin ⇒ chỉ lời đầu đi.
  const two = g("Mình dùng thêm chả mực giã tay ăn kèm không ạ? Hay chị thử thêm chả mực giã tay nữa nhé?");
  assert.deepEqual([two.text, two.dropped.map((d) => d.reason)], ["Mình dùng thêm chả mực giã tay ăn kèm không ạ?", ["ALREADY_OFFERED"]]);
  // Món ngoài danh sách mời kèm (hết hàng / không do shop khai bổ trợ) ⇒ bỏ; mời chung chung không tên món ⇒ bỏ.
  assert.deepEqual(g("Mình dùng thêm nước mắm cốt Cát Hải chấm kèm không ạ? Cho em xin SĐT nhé.").text, "Cho em xin SĐT nhé.");
  assert.deepEqual(g("Mình thử thêm mực khô câu nhé?").dropped.map((d) => d.reason), ["NOT_ELIGIBLE"]);
  assert.deepEqual(g("Mình dùng thêm nước chấm ăn kèm không ạ?").dropped.map((d) => d.reason), ["NOT_ELIGIBLE"]);
  assert.equal(g("Mình xem menu chọn thêm món bên em nhé.").offered, "CROSS_SELL", "shop có menu ⇒ lời mời xem menu là của chính shop");
  // Mời gói lớn hơn: chỉ khi có lý do giá thật ở khối lượng LỚN hơn số đã chọn.
  const one = { cart: cart("Chả cá thu", 1000), lastUserText: "cho chị 1kg chả cá thu" };
  assert.equal(g("Chị lấy 2kg chả cá thu sẽ được giảm, tiết kiệm hơn ạ.", one).offered, "UPSELL", "1kg ⇒ mời 2kg có giảm thật");
  assert.deepEqual(g("Chị lấy 3kg chả cá thu cho tiết kiệm hơn ạ.").dropped.map((d) => d.reason), ["SIZE_CHOSEN"], "đã chọn 2kg (đã được giảm) ⇒ không mời gói khác");
  assert.deepEqual(g("Chị lấy 2kg cá thu một nắng cho tiết kiệm hơn ạ.", { cart: cart("Cá thu một nắng", 1000), lastUserText: "cho chị 1kg cá thu một nắng" }).dropped.map((d) => d.reason), ["NO_PRICE_REASON"], "không giảm theo kg ⇒ không mời");
  assert.deepEqual(g("Chị lấy 2kg chả cá thu sẽ được giảm ạ.", { ...one, facts: null }).dropped.map((d) => d.reason), ["NO_PRICE_REASON"], "không đọc được danh mục ⇒ không mời");
  // Cửa sổ đóng ⇒ mọi lời mời bị bỏ, câu khác vẫn đi.
  const addr = g("Dạ em ghi nhận đơn 1kg chả cá thu ạ. Mình dùng thêm chả mực giã tay không ạ?", { ...one, window: { open: false, reason: "CONTACT_INFO" } });
  assert.deepEqual([addr.text, addr.offered, addr.dropped.map((d) => d.reason)], ["Dạ em ghi nhận đơn 1kg chả cá thu ạ.", null, ["CONTACT_INFO"]]);
  // TƯ VẤN: khách tự hỏi món khác ⇒ câu về món đó đi, kể cả khi cửa sổ đóng (đã từ chối), và không bị đếm là lời mời.
  const asked = g("Dạ chả mực giã tay 1kg giá 400.000đ ạ, ăn kèm chả cá rất hợp ạ.", { ...one, lastUserText: "chả mực giã tay giá bao nhiêu em", window: { open: false, reason: "DECLINED" } });
  assert.deepEqual([asked.dropped, asked.offered], [[], null]);
  // Khách hỏi giá khi CHƯA chọn quy cách ⇒ câu về giảm theo gói là câu trả lời.
  assert.deepEqual(g("Dạ 1kg 280.000đ, lấy 2kg được giảm còn 540.000đ ạ.", { cart: undefined, lastUserText: "chả cá thu giá sao em", window: { open: false, reason: "ALREADY_OFFERED" } }).dropped, []);
  // GIỌNG không bao giờ làm rỗng tin: tin chỉ có lời chào vẫn đi.
  assert.equal(g("Dạ em chào chị ạ!").text, "Dạ em chào chị ạ!");
  assert.equal(g("Dạ em chào chị ạ!", { greetedBefore: false, cart: undefined }).dropped.length, 0, "lời chào ĐẦU không bị bỏ");
  // Miễn ship theo ngưỡng là lý do giá thật (shop bật).
  assert.equal(g("Mình chọn thêm một món trong menu là được miễn ship ạ.", { facts: { ...FACTS, menu: false, freeShip: true } }).offered, "CROSS_SELL");
  assert.deepEqual(g("Mình chọn thêm một món là được miễn ship ạ.", { facts: { ...FACTS, menu: false, freeShip: false } }).dropped.map((d) => d.reason), ["NOT_ELIGIBLE"]);
  // Lý do giá theo gram.
  assert.equal(volumeSaveFrom([{ grams: 1000, price: 280_000 }, { grams: 2000, price: 540_000 }], { enabled: false, unitGrams: 1000, minWeightGrams: 2000, amount: 0, mode: "ONCE" }), 2000);
  assert.equal(volumeSaveFrom([{ grams: 1000, price: 300_000 }, { grams: 2000, price: 600_000 }], { enabled: false, unitGrams: 1000, minWeightGrams: 2000, amount: 0, mode: "ONCE" }), null, "2kg = 2 × 1kg ⇒ không lợi hơn");
  assert.equal(volumeSaveFrom([{ grams: 1000, price: 300_000 }], { enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "ONCE" }), 2000, "giảm theo khối lượng shop khai");
  assert.equal(volumeSaveFrom([{ grams: 500, price: 150_000, addOnOnly: true }, { grams: 1000, price: 280_000 }], { enabled: false, unitGrams: 1000, minWeightGrams: 2000, amount: 0, mode: "ONCE" }), null, "mẫu mã chỉ bán kèm không phải gói bán riêng");
}

/**
 * Review PR #876: hàng rào chỉ được bỏ phần LỜI MỜI — không bao giờ bỏ câu trả lời đúng điều khách vừa hỏi, câu hỏi thông tin đơn cần
 * (SĐT / địa chỉ / quy cách món khách VỪA xin), câu xác nhận thay đổi khách đã xin. Làm ở mức VẾ câu. Mọi khẳng định là CHỮ ĐƯỢC GIỮ.
 */
function testReview876() {
  const ORD: OfferWindow = { open: false, reason: "ORDERING" };
  const g = (text: string, o: Partial<Parameters<typeof guardReply>[1]> = {}) => guardReply(text, { window: ORD, cart: cart("Chả cá thu", 1000), lastUserText: "cho chị 1kg chả cá thu", greetedBefore: true, facts: FACTS, ...o });
  const kept = (text: string, o: Partial<Parameters<typeof guardReply>[1]> = {}) => {
    const r = g(text, o);
    assert.deepEqual([r.text, r.dropped, r.offered], [text, [], null], `phải giữ nguyên: ${text} ⇒ ${r.text}`);
  };
  // B1 — quy cách đã chọn xét theo MÓN câu đang nói: giỏ chỉ có chả cá ⇒ hỏi quy cách chả mực khách vừa xin là câu đơn cần.
  kept("Dạ chả mực giã tay chị lấy 500g hay 1kg ạ?", { lastUserText: "lấy thêm chả mực nữa em" });
  kept("Dạ chả mực giã tay chị lấy 500g hay 1kg ạ?", { lastUserText: "lấy thêm chả mực nữa em", facts: null });
  // B1 — câu một hơi «xin SĐT và địa chỉ, chị có muốn lấy thêm …» ⇒ chỉ mất vế mời (cả khi cửa sổ mở, cả khi chưa đọc được danh mục).
  const ask = "Dạ em ghi nhận 1kg chả cá thu ạ. Chị cho em xin SĐT và địa chỉ, chị có muốn lấy thêm hũ ruốc cá không ạ?";
  for (const o of [{}, { window: OPEN }, { facts: null }]) {
    const r = g(ask, o);
    assert.equal(r.text, "Dạ em ghi nhận 1kg chả cá thu ạ. Chị cho em xin SĐT và địa chỉ.", JSON.stringify([o, r.text]));
    assert.equal(r.offered, null);
    assert.equal(r.dropped.length, 1, JSON.stringify(r.dropped));
  }
  // Vế đuôi của lời mời («…, ngon lắm ạ») đi theo lời mời; vế tổng tiền thì không.
  assert.equal(g("Mình xem thêm menu chả mực bên em nhé, ngon lắm ạ. Cho em xin SĐT nhé.").text, "Cho em xin SĐT nhé.");
  assert.equal(g("Mình dùng thêm chả mực giã tay không ạ, tổng đơn 280.000đ + ship 30.000đ ạ.").text, "Tổng đơn 280.000đ + ship 30.000đ ạ.");
  // B2 — khách vừa hỏi giá / quy cách ⇒ câu trả lời đi, kể cả khi đơn đang lên và đã chọn quy cách.
  kept("Dạ 2kg là 540.000đ, rẻ hơn 20.000đ so với mua lẻ ạ.", { lastUserText: "2kg bao nhiêu" });
  kept("Dạ 2kg là 540.000đ, rẻ hơn 20.000đ so với mua lẻ ạ.", { lastUserText: "2kg bao nhiêu", cart: cart("Chả cá thu", 2000) });
  kept("Dạ 2kg là 540.000đ, rẻ hơn 20.000đ so với mua lẻ ạ.", { lastUserText: "2kg bao nhiêu", facts: null });
  kept("Dạ chả mực giã tay có 2 loại: 500g 175.000đ, 1kg 340.000đ ạ.", { lastUserText: "chả mực có mấy loại em", cart: cart("Chả cá thu", 2000) });
  kept("Dạ chả cá thu 1kg 280.000đ, 2kg 540.000đ ạ.", { lastUserText: "giá sao em", cart: cart("Chả cá thu", 2000) });
  // Câu trả lời vẫn không được kèm lời mời: hỏi giá rồi mà bot rủ lên gói lớn hơn bằng câu hỏi ⇒ vẫn qua hàng rào.
  assert.deepEqual(g("Chị lấy luôn 3kg chả cá thu cho tiết kiệm hơn nhé?", { lastUserText: "2kg bao nhiêu", cart: cart("Chả cá thu", 2000) }).dropped.map((d) => d.reason), ["ORDERING"]);
  // B2 — bảng giá chỉ thừa khi là bảng giá của MÓN ĐÃ CHỌN; bảng giá món khác vẫn đi.
  kept("Dạ chả mực giã tay 500g 175.000đ, 1kg 340.000đ ạ.", { lastUserText: "ok em", cart: cart("Chả cá thu", 2000) });
  assert.equal(g("Dạ chả cá thu 1kg 280.000đ, 2kg 540.000đ ạ. Cho em xin SĐT nhé.", { lastUserText: "ok em", cart: cart("Chả cá thu", 2000) }).text, "Cho em xin SĐT nhé.");
  // Dòng tóm tắt đơn liệt kê các món trong giỏ kèm giá ⇒ tóm tắt, không phải bảng giá.
  const two: CartCommitment = { ...cart("Chả cá thu", 2000), selectedItems: [...cart("Chả cá thu", 2000).selectedItems, ...cart("Chả mực giã tay", 500).selectedItems] };
  kept("Dạ đơn của chị:\n- Chả cá thu 2kg = 540.000đ, chả mực 500g = 175.000đ\nCho em xin SĐT nhé.", { lastUserText: "ok em", cart: two });
  // B3 — «vào đơn» trong một câu HỎI / mời không phải câu xác nhận.
  assert.equal(classifySentence("Chị lấy thêm 1 hũ ruốc cá vào đơn cho đủ bữa nhé ạ?"), "CROSS_SELL");
  assert.equal(g("Dạ em ghi nhận 2kg chả cá thu ạ. Chị lấy thêm 1 hũ ruốc cá vào đơn cho đủ bữa nhé ạ?", { cart: cart("Chả cá thu", 2000), window: OPEN }).text, "Dạ em ghi nhận 2kg chả cá thu ạ.");
  for (const s of ["Dạ em thêm 1 hũ ruốc vào đơn rồi ạ.", "Dạ em đã thêm 1 hũ ruốc vào đơn rồi nhé."]) assert.equal(classifySentence(s), null, s);
  // B4 — xác nhận thay đổi: dạng đã xong, hay khách vừa xin đổi ⇒ giữ.
  for (const s of ["Dạ em đổi sang 2kg chả cá thu cho chị rồi ạ, tổng 540.000đ + ship 30.000đ.", "Dạ em đã nâng lên 3kg chả cá thu cho chị ạ.", "Dạ em chuyển sang giao địa chỉ mới 2kg chả cá cho chị rồi ạ."]) {
    assert.equal(classifySentence(s), null, s);
    kept(s, { lastUserText: "ok em" });
  }
  kept("Dạ em đổi sang 2kg chả cá thu cho chị nhé, tổng 540.000đ.", { lastUserText: "đổi sang 2kg giúp chị" });
  assert.equal(classifySentence("Chị đổi sang 2kg cho tiết kiệm hơn không ạ?"), "UPSELL", "dạng hỏi vẫn là lời mời");
  // Miễn trừ «đã xong» / «thay đổi khách xin» chỉ phủ ĐÚNG vế đó — vế mời đi ké trong cùng câu bị cắt, vế xác nhận ở lại.
  const ride: [string, string, string?][] = [
    ["Dạ em đã đổi sang 2kg rồi, chị lấy luôn 3kg cho rẻ hơn ạ.", "Dạ em đã đổi sang 2kg rồi."],
    ["Dạ em đã nâng lên 2kg chả cá thu cho chị rồi, mua thêm chả mực giã tay ăn kèm ạ.", "Dạ em đã nâng lên 2kg chả cá thu cho chị rồi."],
    ["Dạ em đổi sang 2kg cho chị nhé, chị lấy thêm chả mực giã tay ăn kèm ạ.", "Dạ em đổi sang 2kg cho chị nhé.", "đổi sang 2kg giúp chị"],
    ["Dạ em đổi sang 2kg chả cá thu, lấy luôn 3kg cho rẻ hơn ạ.", "Dạ em đổi sang 2kg chả cá thu.", "đổi sang 2kg giúp chị"],
    ["Em đã thêm vào đơn rồi, chị lấy thêm chả mực giã tay nữa nhé.", "Em đã thêm vào đơn rồi."],
    ["Em đã thêm 1 hũ ruốc vào đơn rồi, thêm 1 hũ nữa cho đủ bữa ạ.", "Em đã thêm 1 hũ ruốc vào đơn rồi."],
    ["Em đã thêm vào đơn rồi và chị mua thêm chả mực giã tay ăn kèm cho ngon ạ.", "Em đã thêm vào đơn rồi."],
  ];
  for (const [text, want, cust] of ride) {
    const r = g(text, cust ? { lastUserText: cust } : {});
    assert.deepEqual([r.text, r.offered, r.dropped.map((d) => d.reason)], [want, null, ["ORDERING"]], `${text} ⇒ ${r.text}`);
  }
  // Câu chốt chung «lấy thêm món nào nữa không» không gọi tên món ⇒ không phải lời mời, đi cả khi đơn đang lên.
  assert.equal(classifySentence("Mình lấy thêm món nào nữa không, không thì em giao luôn ạ?"), null);
  kept("Mình lấy thêm món nào nữa không, không thì em giao luôn ạ?", { lastUserText: "ok em" });
  // Danh mục không đọc được ⇒ lời mời không ai hỏi vẫn bị bỏ, câu hỏi / câu trả lời thì không.
  assert.deepEqual(g("Chị lấy 2kg chả cá thu sẽ được giảm ạ.", { window: OPEN, facts: null }).dropped.map((d) => d.reason), ["NO_PRICE_REASON"]);
  kept("Chị lấy 1kg hay 2kg ạ?", { facts: null, lastUserText: "ok em" });
  // needsOfferFacts: câu hỏi lại quy cách / bảng giá cần danh mục khi giỏ đã có món khách chọn (phải biết câu nói món nào).
  assert.equal(needsOfferFacts("Dạ chả mực giã tay chị lấy 500g hay 1kg ạ?", cart("Chả cá thu", 1000)), true);
  assert.equal(needsOfferFacts("Dạ chả mực giã tay chị lấy 500g hay 1kg ạ?"), false);
  // Lượt mua MỚI mở lại cửa sổ: hồ sơ nhận hàng của lượt mua trước (trước mốc chốt đơn cũ) không còn làm «đơn đang lên».
  const st = (s: Partial<ChatState>) => s as ChatState;
  const customer = (at?: string) => ({ id: null, name: "Hà", phone: "0961003107", address: "x", province: "", simulated: true, ...(at ? { at } : {}) });
  const past = [{ orderId: null, simulated: true, total: 1, at: "2026-10-05T00:00:00.000Z" }];
  const w = (s: Partial<ChatState>) => offerWindow({ state: st(s), lastUserText: "cho chị 1kg chả cá thu", complaint: false });
  assert.deepEqual(w({ customer: customer("2026-10-01T00:00:00.000Z"), pastOrders: past }), { open: true }, "hồ sơ của lượt mua trước ⇒ mở");
  assert.deepEqual(w({ customer: customer(), pastOrders: past }), { open: true }, "hồ sơ không mốc mà đã có lượt mua trước ⇒ của lượt cũ");
  assert.deepEqual(w({ customer: customer("2026-10-06T00:00:00.000Z"), pastOrders: past }), { open: false, reason: "ORDERING" }, "hồ sơ ghi trong lượt mua này ⇒ đơn đang lên");
  assert.deepEqual(w({ customer: customer("2026-10-01T00:00:00.000Z") }), { open: false, reason: "ORDERING" }, "chưa có lượt mua trước ⇒ như cũ");
}

// ═══ chatTurn THẬT ═══

const CFG: Partial<SalesChatbotConfig> = { shippingFee: 30_000, sellWithoutStockCheck: false };
const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const MENU = "Dạ bên em còn chả mực giã tay {{giá:CHA-MUC}}, nước mắm cốt Cát Hải {{giá:NM-500}} ăn kèm rất hợp ạ — mình xem ảnh menu chọn thêm nhé.";

async function seed(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (ctx.ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const db = await getDb();
  const products = [
    { name: "Chả cá thu", code: "CCT", variants: [["CCT-1KG", "1kg", 280_000], ["CCT-2KG", "2kg", 540_000]] },
    { name: "Cá thu một nắng", code: "CTMN", variants: [["CTMN-1KG", "1kg", 300_000], ["CTMN-2KG", "2kg", 600_000]] },
    { name: "Nước mắm cốt Cát Hải", code: "NM", variants: [["NM-500", "500ml", 120_000]] },
  ] as const;
  for (const p of products) {
    const r = await createProductCore(admin, { name: p.name, code: p.code, unit: "gói", retailPrice: p.variants[0][2], cost: null, variants: p.variants.map(([sku, size, price]) => ({ sku, size, color: "", retailPrice: price, cost: null, selling: true })) });
    assert.ok(r.ok, JSON.stringify(r));
    for (const v of await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id))) (ctx.ids as Map<string, string>).set(v.sku, v.id);
  }
  // Tồn: chả cá thu + cá thu một nắng có phiếu nhập; nước mắm CHƯA có phiếu nhập nào (tồn chưa biết ⇒ không mời kèm).
  const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-NBA", totalQuantity: 400, createdBy: "chu@gd-food-nba.local" }).returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values(["CCT-1KG", "CCT-2KG", "CTMN-1KG", "CTMN-2KG"].map((sku) => ({ receiptId: rc.id, variantId: ctx.ids.get(sku)!, quantity: 100, unitCost: 100_000 })));
}

async function seedMenu(on: boolean): Promise<void> {
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  const [row] = (await db.select({ id: qr.id }).from(qr).where(eq(qr.title, "Menu món ngon")).limit(1)) ?? [];
  const id = row?.id ?? (await db.insert(qr).values({ title: "Menu món ngon", triggers: ["menu món ngon"], answer: MENU, active: true }).returning({ id: qr.id }))[0].id;
  await db.update(qr).set({ active: on }).where(eq(qr.id, id));
  await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: on ? id : null, autoLearn: false, autoActivate: false });
}

const ASK_INFO = "Cho em xin SĐT và địa chỉ nhận hàng nhé.";

const CASES: GoldenCase[] = [
  {
    key: "nba-2kg-chot-ngay",
    title: "Ca HSLC 16/10: khách chọn 2kg ⇒ không «1kg hay 2kg», không bảng giá, đúng MỘT lời mời món kèm đủ điều kiện; khách gửi SĐT + địa chỉ ⇒ câu mẫu menu bị từ chối (không chặn) và đơn lên + tự chốt NGAY",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      { say: "Cho chị 2kg chả cá thu", ai: [() => [say(`Dạ em chào chị ạ! Chị lấy 1kg hay 2kg ạ? 1kg 280.000đ, 2kg 540.000đ ạ. Mình dùng thêm chả mực giã tay ăn kèm không ạ? ${ASK_INFO}`)]] },
      {
        say: `Hà 0961003107, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Hà", phone: "0961003107", address: ADDR })],
          () => [tool("send_quick_reply", { code: "Q1" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })],
          () => [say("Mình xem thêm menu chả mực bên em nhé, ngon lắm ạ.")],
        ],
      },
    ],
  },
  {
    key: "nba-tu-choi-roi-hoi-mon-khac",
    title: "1kg ⇒ một lời mời 2kg có giảm thật theo kg; khách từ chối ⇒ lời mời món kèm sau đó bị bỏ; khách TỰ hỏi chả mực ⇒ trả lời bình thường",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      { say: "Cho chị 1kg chả cá thu", ai: [() => [say(`Dạ 1kg chả cá thu ạ. Chị lấy 2kg chả cá thu sẽ được giá 540.000đ, tiết kiệm hơn ạ. ${ASK_INFO}`)]] },
      { say: "không em, 1kg thôi", ai: [() => [say("Dạ vâng ạ, em ghi 1kg chả cá thu cho mình. Mình dùng thêm chả mực giã tay ăn kèm không ạ?")]] },
      { say: "chả mực giã tay giá bao nhiêu em", ai: [() => [tool("search_products", { query: "chả mực giã tay" })], () => [say("Dạ chả mực giã tay 1kg giá 400.000đ ạ, ăn kèm chả cá rất hợp ạ.")]] },
    ],
  },
  {
    key: "nba-dia-chi-bo-loi-moi",
    title: "Khách gửi món + SĐT + địa chỉ trong một tin ⇒ đơn lên ngay, mọi lời mời viết kèm (gói lớn, món kèm) bị bỏ, phần ghi nhận vẫn tới khách",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Cho chị 1kg chả cá thu, Lan 0961003108, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Lan", phone: "0961003108", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Dạ em ghi nhận đơn 1kg chả cá thu ạ. Chị lấy 2kg chả cá thu sẽ được giá 540.000đ, tiết kiệm hơn ạ. Mình dùng thêm chả mực giã tay không ạ?")],
        ],
      },
    ],
  },
  {
    key: "nba-khong-co-ly-do-gia",
    title: "Cá thu một nắng 2kg = đúng 2 × 1kg ⇒ lời mời «lấy 2kg cho tiết kiệm» bị bỏ (không lý do giá thật)",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [{ say: "Cho chị 1kg cá thu một nắng", ai: [() => [say(`Dạ 1kg cá thu một nắng ạ. Chị lấy 2kg cá thu một nắng cho tiết kiệm hơn ạ. ${ASK_INFO}`)]] }],
  },
  {
    key: "nba-het-hang-khong-moi",
    title: "Món kèm chưa có tồn (nước mắm — có trong menu) và món không do shop khai bổ trợ (mực khô) ⇒ không bao giờ tới khách; tin chỉ có lời mời ⇒ hỏi đúng phần còn thiếu",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      { say: "Cho chị 1kg chả cá thu", ai: [() => [say("Dạ 1kg chả cá thu ạ. Mình dùng thêm nước mắm cốt Cát Hải chấm kèm không ạ? Cho em xin SĐT nhé.")]] },
      { say: "ok em", ai: [() => [say("Mình thử thêm mực khô câu ăn kèm nhé?")]] },
    ],
  },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-nba",
    beforeCase: async (c, ctx) => {
      await seed(ctx);
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: c.key === "nba-2kg-chot-ngay" });
      await seedMenu(c.key === "nba-2kg-chot-ngay" || c.key === "nba-tu-choi-roi-hoi-mon-khac" || c.key === "nba-het-hang-khong-moi");
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const [conv] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const st = (conv.state ?? {}) as ChatState;
      const all = t.turns.flatMap((x) => x.shown);
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      assert.doesNotMatch(results, /chưa mời thêm món|mời thêm món ĐÚNG MỘT LẦN/, `[${c.key}] không còn cổng «chưa mời thêm món»`);
      const drops = (st.offerDrops ?? []).map((d) => `${d.via}:${d.reason}`);
      // Dòng đơn theo SKU (mẫu mã gieo trong beforeCase không có trong bảng nhãn của ảnh chụp ⇒ đọc thẳng CSDL).
      const skuOf = new Map([...ctx.ids.entries()].map(([sku, id]) => [id, sku]));
      const orders = await db.select({ id: schema.orders.id, stage: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      const lines = orders.length ? (await db.select({ v: schema.orderItems.variantId, q: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, orders[0].id))).map((l) => `${skuOf.get(String(l.v)) ?? l.v}×${l.q}`) : [];
      if (c.key === "nba-2kg-chot-ngay") {
        assert.deepEqual(t.turns[0].shown, [`Mình dùng thêm chả mực giã tay ăn kèm không ạ? ${ASK_INFO}`], `không chào lại, không «1kg hay 2kg», không bảng giá: ${JSON.stringify(t.turns[0].shown)}`);
        assert.match(results, /Câu upsell đã gửi|KHÔNG mời thêm món lúc này/, "câu mẫu menu lúc khách gửi địa chỉ bị từ chối");
        assert.ok(!all.some((s) => /menu|1kg hay 2kg/i.test(s)), `không menu, không hỏi lại quy cách: ${JSON.stringify(all)}`);
        assert.equal(t.turns[1].shown.length, 1, JSON.stringify(t.turns[1].shown));
        assert.match(t.turns[1].shown[0], /Chả cá thu/, "câu chốt theo kết quả công cụ");
        assert.deepEqual([orders.length, orders[0]?.stage], [1, "CONFIRMED"], "đúng một đơn, tự chốt ngay — không đợi lời mời");
        assert.deepEqual(lines, ["CCT-2KG×1"], "giỏ đúng 2kg, không món tự thêm");
        assert.equal(st.upsellSent, true, "lời mời của lượt mua đã ghi (sổ sự kiện đếm upsell.offered)");
        assert.ok(drops.includes("TEXT:CONFIRMED") || drops.includes("TEXT:CONTACT_INFO"), JSON.stringify(drops));
        return;
      }
      if (c.key === "nba-tu-choi-roi-hoi-mon-khac") {
        assert.deepEqual(t.turns[0].shown, [`Dạ 1kg chả cá thu ạ. Chị lấy 2kg chả cá thu sẽ được giá 540.000đ, tiết kiệm hơn ạ. ${ASK_INFO}`], "mời 2kg MỘT lần, có lý do giá thật");
        assert.deepEqual(t.turns[1].shown, ["Dạ vâng ạ, em ghi 1kg chả cá thu cho mình."], `từ chối ⇒ không mời lại: ${JSON.stringify(t.turns[1].shown)}`);
        assert.deepEqual(t.turns[2].shown, ["Dạ chả mực giã tay 1kg giá 400.000đ ạ, ăn kèm chả cá rất hợp ạ."], "khách tự hỏi món khác ⇒ trả lời bình thường");
        assert.equal(typeof st.upsellDeclinedTurn, "number", "lượt từ chối đã ghi");
        assert.deepEqual(drops, ["TEXT:DECLINED"]);
        return;
      }
      if (c.key === "nba-dia-chi-bo-loi-moi") {
        assert.deepEqual(t.turns[0].shown, ["Dạ em ghi nhận đơn 1kg chả cá thu ạ."], JSON.stringify(t.turns[0].shown));
        assert.deepEqual([orders.length, lines], [1, ["CCT-1KG×1"]], "đơn lên ngay, đúng 1kg");
        assert.deepEqual(drops, ["TEXT:CONTACT_INFO", "TEXT:CONTACT_INFO"]);
        assert.equal(st.upsellSent, undefined, "không lời mời nào được đi");
        return;
      }
      if (c.key === "nba-khong-co-ly-do-gia") {
        assert.deepEqual(t.turns[0].shown, [`Dạ 1kg cá thu một nắng ạ. ${ASK_INFO}`], JSON.stringify(t.turns[0].shown));
        assert.deepEqual(drops, ["TEXT:NO_PRICE_REASON"]);
        return;
      }
      assert.deepEqual(t.turns[0].shown, ["Dạ 1kg chả cá thu ạ. Cho em xin SĐT nhé."], JSON.stringify(t.turns[0].shown));
      assert.deepEqual(t.turns[1].shown, ["Dạ mình cho em xin số điện thoại nhận hàng nhé."], `tin chỉ có lời mời bị bỏ ⇒ hỏi đúng phần thiếu: ${JSON.stringify(t.turns[1].shown)}`);
      assert.ok(!all.some((s) => /nước mắm|mực khô/i.test(s)), JSON.stringify(all));
      assert.deepEqual(drops, ["TEXT:NOT_ELIGIBLE", "TEXT:NOT_ELIGIBLE"]);
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
}

export async function testSalesNextBestAction() {
  testClassify();
  testWindow();
  testGuard();
  testReview876();
  await testChatTurn();
  console.log("  ✓ #868 lời mời mua thêm thông minh: không còn cổng «chưa mời thêm món», đơn hợp lệ lên ngay; một lời mời mỗi lượt mua, không mời lúc khách gửi SĐT / địa chỉ / đã từ chối / phàn nàn / đơn lỗi; khách đã chọn 2kg ⇒ không «1kg hay 2kg», không bảng giá; mời gói lớn chỉ khi giảm thật theo kg; món kèm phải còn bán · còn hàng · giá xác thực · shop khai bổ trợ; khách tự hỏi món khác ⇒ tư vấn bình thường");
}

if (process.argv[1] && /sales-next-best-action\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testSalesNextBestAction)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

/**
 * ═══════════ PHƯỜNG KHÁCH ĐÃ GHI RÕ KHÔNG ĐƯỢC HỎI LẠI (P0 chủ shop 15/10/2026) ═══════════
 *
 * Hai ca thật HSLC (bot bán hàng `lib/sales-chatbot/`):
 *  · «Tuyet Nguyen Thi» (15/10 10:46): «1kg chả cá thu + 1kg chả mực», «230/20 Phan Huy Ích, P An Hội Tây, TP.HCM» + SĐT đầy đủ. Phường
 *    An Hội Tây là phường MỚI (sau 01/07/2025) có thật trong danh mục — vậy mà bot bắt chọn giữa 6 phường của quận Gò Vấp cũ. Danh sách
 *    6 phường ĐÚNG là ứng viên của «chỉ có quận Gò Vấp cũ» ⇒ bộ đọc đã được đưa một dòng địa chỉ KHÔNG có «An Hội Tây»: công cụ chỉ đọc
 *    dòng MODEL chép lại, không đọc chữ khách.
 *  · «Lê Văn Dụ»: «khu đô thị Xa La, Phúc La cũ, Hà Đông, Hà Nội» — hỏi phường mới qua nhiều lượt: trí nhớ «đã hỏi» khoá theo ĐÚNG chuỗi
 *    địa chỉ, chuỗi đổi (model chép lại) là quên đã hỏi.
 *
 * Luật được khoá: phường viết rõ có trong danh mục MỚI của tỉnh ⇒ dùng, không hỏi · viết tắt P / P. / F / Phường / phuong / X. / Xã /
 * TT. mọi kiểu chữ · xã CŨ gộp trọn vào MỘT xã mới ⇒ dùng (giữ nguyên chữ khách) · mơ hồ ⇒ MỘT câu ngắn, không bao giờ danh sách 5–6
 * phường · phần đã hỏi ở lượt trước KHÔNG hỏi lại · không đoán phường khi không chắc.
 */
import assert from "node:assert/strict";
import { acceptCustomerWard, addressQuestion, canAutoFill, customerStatedAddresses, MAX_WARDS_NAMED_IN_QUESTION, parseCustomerAddress, sameDeliveryPlace, wardFromCustomerWords } from "@/lib/address/customer-address";
import { expandAbbreviations, foldVnText, normalizeVnAddress } from "@/lib/address/vn-address";
import { ADDRESS_KNOWN_TEXT, addressKnowledge, addressReaskVerdict, askedBefore, askMemoryFor, asksForFullAddress, asksForWard, wantsAddressChange } from "@/lib/sales-chatbot/address-memory";
import type { CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { silenceFallbackText } from "@/lib/sales-chatbot/engine";
import { addressCheckOf, executeTool, type ChatState } from "@/lib/sales-chatbot/tools";

const AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/tools.ts" };
const AN_HOI_TAY = "Phường An Hội Tây";
const HCM = "Thành phố Hồ Chí Minh";
/** Tin khách thật (đã thay SĐT): món + địa chỉ + SĐT trong MỘT tin, mỗi thứ một dòng. */
const TUYET_MSG = "1kg chả cá thu + 1kg chả mực\n230/20 Phan Huy Ích, P An Hội Tây, TP.HCM\n0901234567";
/** Dòng model chép vào công cụ: mất phường mới, thay bằng quận cũ — đúng thứ sinh ra danh sách 6 phường. */
const MODEL_LINE = "230/20 Phan Huy Ích, Gò Vấp, TP.HCM";
const GO_VAP_SIX = ["Phường An Hội Tây", "Phường An Hội Đông", "Phường An Nhơn", "Phường Gò Vấp", "Phường Hạnh Thông", "Phường Thông Tây Hội"];

export function testAddressWardExplicitPure() {
  // ① Ca «Tuyet Nguyen Thi» — mọi cách viết khách hay gõ ⇒ ĐÚNG phường mới, mức EXACT, không hỏi gì.
  for (const text of [
    "230/20 Phan Huy Ích, P An Hội Tây, TP.HCM",
    "230/20 Phan Huy Ích, P. An Hội Tây, TP.HCM",
    "230/20 Phan Huy Ích, P.An Hội Tây, Tp.Hcm",
    "230/20 Phan Huy Ích, phường An Hội Tây, TP Hồ Chí Minh",
    "230/20 phan huy ich, phuong an hoi tay, tp hcm",
    "230/20 phan huy ich p an hoi tay hcm",
    "230/20 PHAN HUY ÍCH, P. AN HỘI TÂY, TP.HCM",
    "230/20 Phan Huy Ích, F An Hội Tây, HCM",
    "230/20 Phan Huy Ích, P An Hội Tây, Gò Vấp, TP.HCM",
    // Không ghi tỉnh: «An Hội Tây» là tên DUY NHẤT cả nước; «phường An Hội» (Vĩnh Long) nằm trọn trong chữ đó, không phải khả năng thứ hai.
    "230/20 Phan Huy Ích, P An Hội Tây",
  ]) {
    const a = parseCustomerAddress(text);
    assert.deepEqual([a.confidence, a.province, a.ward, a.missing], ["EXACT", HCM, AN_HOI_TAY, []], `${text}: ${JSON.stringify(a)}`);
    assert.equal(addressQuestion(a), null, `${text}: đủ số nhà + đường + phường + tỉnh ⇒ không hỏi`);
  }

  // ② Ca «Lê Văn Dụ» — xã CŨ (Phúc La) gộp trọn vào MỘT phường mới (Hà Đông) theo danh mục ⇒ dùng, kể cả khi KHÔNG ghi quận cũ.
  for (const text of [
    "khu đô thị Xa La, Phúc La cũ, Hà Đông, Hà Nội",
    "KĐT Xa La, Phúc La cũ, Hà Đông, HN",
    "khu đô thị Xa La, Phúc La, Hà Nội",
    "Khu đô thị Xa La, phường Phúc La cũ, Hà Nội",
    "khu đô thị Xa La, P Phúc La, Q Hà Đông, Hà Nội",
  ]) {
    const a = parseCustomerAddress(text);
    assert.deepEqual([a.confidence, a.province, a.ward], ["UNIQUE_FROM_OLD", "Thành phố Hà Nội", "Phường Hà Đông"], `${text}: ${JSON.stringify(a)}`);
    assert.ok(canAutoFill(a));
    assert.equal(addressQuestion(a), null, text);
  }
  // Chỉ có quận cũ Hà Đông (12 phường mới) ⇒ KHÔNG đoán; MỘT câu ngắn xin đúng phần thiếu, không liệt kê tên nào.
  const xaLa = parseCustomerAddress("khu đô thị Xa La, Hà Đông, Hà Nội");
  assert.deepEqual([xaLa.confidence, xaLa.ward, xaLa.missing], ["NOT_FOUND", null, ["ward"]]);
  const xaLaAsk = addressQuestion(xaLa)!;
  assert.ok(/phường \/ xã/.test(xaLaAsk) && !/phường [A-ZĐ]/u.test(xaLaAsk) && (xaLaAsk.match(/\?/g) ?? []).length === 1, xaLaAsk);
  // Xã cũ + một quận cũ KHÁC quận của nó (mâu thuẫn) ⇒ không dùng xã cũ, không đoán.
  assert.notEqual(parseCustomerAddress("số 3, phường Phúc La, quận Thanh Xuân, Hà Nội").ward, "Phường Hà Đông");
  // Tên xã cũ nằm lẫn trong phần số nhà / đường KHÔNG được coi là xã («12 Lê Lợi» là tên đường).
  assert.equal(parseCustomerAddress("12 Lê Lợi, Hà Nội").ward, null);

  // ③ Tên mới / cũ khác + viết tắt X. / TT. / P. / Q.
  assert.equal(parseCustomerAddress("12 Nguyễn Trãi, P.Bến Thành, Q.1, TP.HCM").ward, "Phường Bến Thành", "P. dính liền tên mới");
  assert.equal(parseCustomerAddress("Số 9 Lý Thường Kiệt, Phường Cửa Nam, Hà Nội").ward, "Phường Cửa Nam");
  assert.equal(parseCustomerAddress("Ấp 1, X. Tân Thông Hội, Củ Chi, HCM").ward, "Xã Củ Chi", "X. + xã cũ + huyện cũ ⇒ xã mới");
  assert.equal(normalizeVnAddress("TT. Củ Chi, H. Củ Chi, TP.HCM").status, "MATCHED", "TT. + H. đọc được");
  assert.equal(parseCustomerAddress("12 Nguyễn Văn Nghi phường 5 quận Gò Vấp").ward, "Phường An Nhơn", "phường số cũ + quận cũ ⇒ phường mới");

  // ④ Mơ hồ thật: xã cũ bị CHIA làm hai ⇒ MỘT câu ngắn nêu đúng hai tên (≤ trần); quận cũ 6 phường ⇒ không bao giờ danh sách 6.
  const coNhue = parseCustomerAddress("số 5, Cổ Nhuế 2, Hà Nội");
  assert.deepEqual([coNhue.confidence, [...coNhue.candidates].sort()], ["AMBIGUOUS", ["Phường Thượng Cát", "Phường Đông Ngạc"]], JSON.stringify(coNhue));
  const coAsk = addressQuestion(coNhue)!;
  assert.ok(coAsk.includes("phường Thượng Cát") && coAsk.includes("phường Đông Ngạc") && (coAsk.match(/\?/g) ?? []).length === 1, coAsk);
  const gv = parseCustomerAddress(MODEL_LINE);
  assert.deepEqual([gv.confidence, [...gv.candidates].sort()], ["AMBIGUOUS", GO_VAP_SIX], "6 ứng viên vẫn nằm ở candidates cho người kiểm");
  const gvAsk = addressQuestion(gv)!;
  assert.ok(GO_VAP_SIX.every((w) => !gvAsk.includes(w.replace(/^Phường/, "phường"))), `không liệt kê 6 phường: ${gvAsk}`);
  assert.ok(MAX_WARDS_NAMED_IN_QUESTION < 5, "trần tên nêu trong câu hỏi luôn dưới 5");

  // ⑤ CHỮ CỦA CHÍNH KHÁCH thắng bản model chép: cùng tỉnh + cùng số nhà ⇒ phường khách ghi; khác số nhà / câu hỏi ⇒ không dùng.
  assert.equal(customerStatedAddresses([TUYET_MSG])[0]?.ward, AN_HOI_TAY, "tin nhiều dòng: dòng địa chỉ được tách khỏi món + SĐT");
  assert.deepEqual(wardFromCustomerWords(gv, MODEL_LINE, [TUYET_MSG]), { ward: AN_HOI_TAY, province: HCM, provinceCode: 79, confidence: "EXACT" });
  assert.deepEqual(wardFromCustomerWords(gv, MODEL_LINE, ["230/20 Phan Huy Ích", "P An Hội Tây, TP.HCM"])?.ward, AN_HOI_TAY, "địa chỉ gõ làm hai tin");
  assert.equal(wardFromCustomerWords(gv, MODEL_LINE, ["99 Phan Huy Ích, P An Hội Tây, TP.HCM"]), null, "khác số nhà ⇒ địa chỉ khác, không ghép");
  assert.equal(wardFromCustomerWords(gv, MODEL_LINE, ["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM có ship không?"]), null, "câu hỏi không phải lời khai địa chỉ");
  assert.equal(wardFromCustomerWords(gv, MODEL_LINE, ["230/20 Lê Lợi, Phường Cửa Nam, Hà Nội"]), null, "khác tỉnh ⇒ không ghép");
  assert.equal(wardFromCustomerWords(gv, MODEL_LINE, undefined), null);
  // Review độc lập PR #848 — không bao giờ ghép phường của MỘT ĐỊA CHỈ KHÁC:
  //  W2: cùng số nhà, KHÁC đường (khách đổi địa chỉ) ⇒ không mượn phường Bến Thành của địa chỉ cũ.
  const w2Line = "12 Nguyễn Văn Lượng, Gò Vấp, TP.HCM";
  assert.equal(wardFromCustomerWords(parseCustomerAddress(w2Line), w2Line, ["12 Lê Lợi, P Bến Thành, TP.HCM", "à chị đổi địa chỉ: 12 Nguyễn Văn Lượng, Gò Vấp, TPHCM nhé"]), null);
  const w2 = addressCheckOf({ address: "12 Nguyễn Văn Lượng, Gò Vấp", province: "TP.HCM" }, { customerTexts: ["12 Lê Lợi, P Bến Thành, TP.HCM", "à chị đổi địa chỉ: 12 Nguyễn Văn Lượng, Gò Vấp, TPHCM nhé"], turn: 5 }).view;
  assert.deepEqual([w2.status, w2.ward, Boolean(w2.ask_customer)], ["AMBIGUOUS", null, true], JSON.stringify(w2));
  //  W3: khách SỬA phường bằng câu không có đường ⇒ không gắn phường cũ, để bot hỏi.
  const w3Texts = ["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM", "à em nhầm, phường An Hội Đông nhé"];
  assert.equal(wardFromCustomerWords(gv, MODEL_LINE, w3Texts), null);
  assert.deepEqual(customerStatedAddresses(w3Texts), [], "lời sửa mới hơn ⇒ địa chỉ cũ không còn là lời khai");
  const w3 = addressCheckOf({ address: MODEL_LINE, province: "" }, { customerTexts: w3Texts, turn: 5 }).view;
  assert.deepEqual([w3.status, w3.ward, Boolean(w3.ask_customer)], ["AMBIGUOUS", null, true], JSON.stringify(w3));
  //  W4: sửa KÈM đường ⇒ địa chỉ mới thắng.
  assert.equal(wardFromCustomerWords(gv, MODEL_LINE, ["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM", "230/20 Phan Huy Ích, phường An Hội Đông, TP.HCM"])?.ward, "Phường An Hội Đông");
  //  W5: dòng công cụ KHÔNG có tỉnh + tin khách cũ ở tỉnh khác, cùng số nhà ⇒ không mượn tỉnh + phường.
  const w5 = addressCheckOf({ address: "12 Trần Phú", province: "" }, { customerTexts: ["12 Lê Lợi, phường Hạc Thành, Thanh Hóa"], turn: 5 }).view;
  assert.deepEqual([w5.status, w5.ward, w5.province], ["NOT_FOUND", null, null], JSON.stringify(w5));
  //  Dòng công cụ không tỉnh, cùng đường với tin khách MỚI NHẤT có địa chỉ ⇒ vẫn nhận; có tin địa chỉ mới hơn ⇒ không.
  const noProvLine = "230/20 Phan Huy Ích, Gò Vấp";
  assert.equal(wardFromCustomerWords(parseCustomerAddress(noProvLine), noProvLine, ["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM"])?.ward, AN_HOI_TAY);
  assert.equal(wardFromCustomerWords(parseCustomerAddress(noProvLine), noProvLine, ["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM", "à gửi về 5 Lê Lợi, phường Hạc Thành, Thanh Hóa"]), null);
  assert.equal(wardFromCustomerWords(parseCustomerAddress(TUYET_MSG.split("\n")[1]), TUYET_MSG.split("\n")[1], [TUYET_MSG]), null, "dòng công cụ đã tự điền ⇒ không cần chữ khách");
  // Kết quả cho bot: model chép mất phường mà khách đã ghi rõ ⇒ CUSTOMER_STATED, không câu hỏi.
  const stated = addressCheckOf({ address: MODEL_LINE, province: "" }, { customerTexts: [TUYET_MSG] }).view;
  assert.deepEqual([stated.status, stated.ward, stated.province, stated.ask_customer, stated.candidates], ["CUSTOMER_STATED", AN_HOI_TAY, HCM, null, []], JSON.stringify(stated));
  // Không có chữ khách ⇒ như cũ (mơ hồ, có câu hỏi ngắn).
  assert.equal(addressCheckOf({ address: MODEL_LINE, province: "" }).view.status, "AMBIGUOUS");

  // ⑥ HỎI MỘT LẦN: phần đã hỏi ở lượt trước ⇒ không đưa câu hỏi nữa, kể cả khi chuỗi địa chỉ đổi (model chép lại).
  const asked = { key: `${MODEL_LINE}||`, turn: 3, parts: { ward: 3 } };
  assert.equal(askedBefore(asked, ["ward"], 3), false, "cùng lượt ⇒ khách chưa thấy câu hỏi");
  assert.equal(askedBefore(asked, ["ward"], 4), true);
  const later = addressCheckOf({ address: `${MODEL_LINE} (gần chợ)`, province: "" }, { asked, turn: 4 }).view;
  assert.deepEqual([later.status, later.ask_customer], ["AMBIGUOUS", null], JSON.stringify(later));
  assert.match(later.note, /KHÔNG hỏi lại/);
  // Trí nhớ dòng cũ (trước 15/10, chưa có `parts`) ⇒ suy phần đã hỏi từ chính địa chỉ của câu hỏi.
  assert.equal(askedBefore({ key: `${MODEL_LINE}||`, turn: 3 }, ["ward"], 4), true);
  assert.equal(askedBefore(undefined, ["ward"], 4), false);

  // ⑦ HÀNG RÀO CHỮ GỬI KHÁCH: bot tự hỏi lại phường khi máy chủ đã biết (từ chữ khách) ⇒ bỏ câu hỏi, giữ phần còn lại.
  const sixList = "Dạ địa chỉ mình nay thuộc phường Gò Vấp, phường An Nhơn, phường An Hội Đông, phường An Hội Tây, phường Hạnh Thông hay phường Thông Tây Hội theo địa giới mới ạ? Mình xác nhận giúp em nhé.";
  const knownFromText = addressKnowledge({}, [TUYET_MSG]);
  assert.deepEqual([knownFromText.ward, knownFromText.province, knownFromText.street], [AN_HOI_TAY, true, true]);
  const v = addressReaskVerdict(sixList, knownFromText, 2);
  assert.ok(v && v.rest === "Mình xác nhận giúp em nhé." && /đã bỏ câu hỏi/.test(v.note), JSON.stringify(v));
  assert.deepEqual(addressReaskVerdict("Dạ mình ở phường nào ạ?", knownFromText, 2), { rest: "", note: v!.note }, "cả tin là câu hỏi ⇒ rest rỗng, nơi gọi gửi câu ghi nhận");
  assert.ok(ADDRESS_KNOWN_TEXT.length > 0);
  // Câu TÓM TẮT có tên phường (không hỏi) đi qua nguyên vẹn.
  assert.equal(addressReaskVerdict("Dạ em giao tới 230/20 Phan Huy Ích, phường An Hội Tây, TP.HCM nhé. Mình xác nhận giúp em ạ?", knownFromText, 2), null);
  // Khách đã lưu với dòng model chép + chữ khách ⇒ vẫn biết phường.
  assert.equal(addressKnowledge({ customer: { id: null, name: "Tuyết", phone: "0901234567", address: MODEL_LINE, province: "", simulated: true } }, [TUYET_MSG]).ward, AN_HOI_TAY);
  // Chưa biết phường + chưa hỏi lần nào ⇒ câu hỏi ĐẦU TIÊN đi qua (không chặn quá tay).
  const unknown = addressKnowledge({ customer: { id: null, name: "K", phone: "0901234567", address: MODEL_LINE, province: "", simulated: true } }, []);
  assert.equal(unknown.ward, null);
  assert.equal(addressReaskVerdict("Dạ mình cho em xin tên phường / xã mới của địa chỉ với ạ?", unknown, 4), null, "lần hỏi đầu");
  // Đã hỏi ở lượt 3 ⇒ lượt 4 hỏi lại bị bỏ (đơn đi tiếp với cờ cần kiểm).
  const askedK = addressKnowledge({ customer: { id: null, name: "K", phone: "0901234567", address: MODEL_LINE, province: "", simulated: true }, addressAsk: asked }, []);
  assert.ok(addressReaskVerdict("Dạ mình cho em xin tên phường / xã mới của địa chỉ với ạ?", askedK, 4), "đã hỏi ở lượt trước ⇒ không hỏi lại");
  assert.ok(asksForWard("Dạ phường Cổ Nhuế 2 cũ nay thuộc phường Thượng Cát hay phường Đông Ngạc theo địa giới mới ạ?"));
  assert.ok(!asksForWard("Dạ em giao về phường An Hội Tây cho mình nhé."));
  // Câu KỂ «xác nhận … phường» không phải câu hỏi — hàng rào không bỏ câu tóm tắt.
  assert.ok(!asksForWard("Em xác nhận phường An Hội Tây cho mình nhé."));
  assert.equal(addressReaskVerdict("Em xác nhận phường An Hội Tây cho mình nhé. Tổng 280.000 ₫ ạ.", knownFromText, 2), null);
  // REVIEW PR #848 LẦN 2 — khách xin ĐỔI địa chỉ ⇒ câu xin địa chỉ MỚI của bot không được bỏ (nếu bỏ, bot xác nhận địa chỉ CŨ).
  assert.equal(wantsAddressChange("à chị muốn đổi địa chỉ giao nhé"), true);
  assert.equal(wantsAddressChange("ok em"), false);
  const tuyetDraft = { customer: { id: null, name: "Tuyết", phone: "0901234567", address: MODEL_LINE, province: "", simulated: true } };
  assert.equal(addressReaskVerdict("Dạ chị gửi em xin địa chỉ mới ạ?", addressKnowledge(tuyetDraft, [TUYET_MSG, "à chị muốn đổi địa chỉ giao nhé"]), 3), null);
  assert.equal(addressReaskVerdict("Dạ chị gửi lại địa chỉ giúp em ạ?", addressKnowledge(tuyetDraft, [TUYET_MSG, "à chị muốn đổi địa chỉ giao nhé"]), 3), null);
  assert.equal(asksForFullAddress("Dạ chị gửi em xin địa chỉ mới ạ?"), false, "câu xin địa chỉ MỚI không phải câu hỏi lại");
  assert.equal(asksForFullAddress("Em đã nhận địa chỉ của mình rồi ạ."), false, "câu kể không phải câu hỏi");
  assert.equal(asksForFullAddress("Dạ chị gửi lại địa chỉ giúp em ạ?"), true);
  // REVIEW LẦN 3 — «giao về nhà mẹ chị», «giao tới công ty» cũng là xin đổi nơi giao; câu bot xin địa chỉ nơi đó không bị bỏ.
  assert.equal(wantsAddressChange("giao về nhà mẹ chị nhé"), true);
  assert.equal(wantsAddressChange("chị muốn giao tới công ty"), true);
  assert.equal(addressReaskVerdict("Dạ chị cho em xin địa chỉ nhà mẹ ạ?", addressKnowledge(tuyetDraft, [TUYET_MSG, "giao về nhà mẹ chị nhé"]), 3), null);
  // REVIEW LẦN 4 — tin khách mới nhất không mang địa chỉ / không phải lời đồng ý ⇒ câu xin địa chỉ (người nhận khác) KHÔNG bị bỏ.
  for (const said of ["à em ơi gửi cho mẹ chị dưới quê nhé", "gửi cho bạn chị nhé", "ship về quê chị ở Nghệ An nhé", "chị không ở đó nữa rồi em", "à đơn này người nhận khác nha em"]) {
    assert.equal(addressReaskVerdict("Dạ chị cho em xin địa chỉ của người nhận ạ?", addressKnowledge(tuyetDraft, [TUYET_MSG, said]), 3), null, said);
    assert.equal(addressReaskVerdict("Dạ mẹ chị ở phường nào ạ?", addressKnowledge(tuyetDraft, [TUYET_MSG, said]), 3), null, said);
  }
  // ... còn ngay sau tin địa chỉ hoặc «ok em» thì câu hỏi lại vẫn bị bỏ.
  assert.ok(addressReaskVerdict("Dạ chị gửi lại địa chỉ giúp em ạ?", addressKnowledge(tuyetDraft, [TUYET_MSG]), 3));
  assert.ok(addressReaskVerdict("Dạ chị gửi lại địa chỉ giúp em ạ?", addressKnowledge(tuyetDraft, [TUYET_MSG, "ok em"]), 3));
  assert.equal(asksForFullAddress("Dạ chị cho em xin địa chỉ công ty ạ?"), false);
  assert.equal(expandAbbreviations(foldVnText("Lầu F An Phú")), "lau f an phu");
  // «Lô F / Tòa P …» là tên lô / toà, không bung thành «phường».
  assert.equal(expandAbbreviations(foldVnText("Lô F An Phú, Quận 2")), "lo f an phu quan 2");
  assert.equal(expandAbbreviations(foldVnText("230/20 Phan Huy Ích, F An Hội Tây")), "230 20 phan huy ich phuong an hoi tay");
  assert.ok(asksForWard("Mình xác nhận giúp em phường An Hội Tây đúng không ạ"), "câu hỏi xác nhận (kết bằng «không ạ») vẫn là câu hỏi");
  // W3 ở hàng rào: khách vừa sửa phường ⇒ KHÔNG bỏ câu hỏi / xác nhận phường của bot — kể cả khi đơn nháp đang giữ phường cũ.
  const w3k = addressKnowledge({}, w3Texts);
  assert.equal(w3k.ward, null);
  assert.equal(addressReaskVerdict("Dạ mình ở phường nào ạ?", w3k, 6), null, "lời sửa mới ⇒ bot được hỏi");
  const draftOld: ChatState = { draft: { orderId: null, lines: [], unitPrices: {}, recipient: { name: "T", phone: "0901234567", address: MODEL_LINE, province: "", ward: AN_HOI_TAY }, note: "", simulated: true } };
  const corrected = addressKnowledge(draftOld, w3Texts);
  assert.deepEqual([corrected.ward, corrected.corrected], [null, true]);
  assert.equal(addressReaskVerdict("Dạ mình đổi sang phường An Hội Đông đúng không ạ?", { ...corrected, wardAskedAt: 1 }, 6), null, "đã hỏi trước đó nhưng khách đang sửa ⇒ vẫn cho hỏi");

  // a5 (re-review PR #848): khách SỬA bằng phường SỐ CŨ không kèm quận («P15», «F15», «phường 15 cũ») — bộ đọc không ra phường nào
  // chắc chắn, nhưng đó vẫn là lời sửa ⇒ bỏ cách đọc cũ, ô xã trống, bot được hỏi lại (hướng an toàn).
  for (const fix of ["à em nhầm P15 nhé", "nhầm rồi em, F15 nha", "à không phải An Hội Tây, phường 15 cũ", "à em nhầm, phường 15 Gò Vấp nhé"]) {
    const texts = ["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM", fix];
    const vw = addressCheckOf({ address: "230/20 Phan Huy Ích, Gò Vấp", province: "TP.HCM" }, { customerTexts: texts, turn: 5 }).view;
    assert.ok(vw.status !== "CUSTOMER_STATED" && vw.ward === null && Boolean(vw.ask_customer), `${fix}: ${JSON.stringify(vw)}`);
    const ask = "Dạ phường 15 cũ nay là phường nào theo tên mới ạ?";
    assert.equal(addressReaskVerdict(ask, addressKnowledge({}, texts), 5), null, `${fix}: không có trạng thái ⇒ không bỏ câu hỏi`);
    const kept: ChatState = { draft: { orderId: null, lines: [], unitPrices: {}, recipient: { name: "T", phone: "0901234567", address: "230/20 Phan Huy Ích, Gò Vấp", province: "TP.HCM", ward: AN_HOI_TAY }, note: "", simulated: true } };
    assert.equal(addressReaskVerdict(ask, { ...addressKnowledge(kept, texts), wardAskedAt: 1 }, 5), null, `${fix}: đơn nháp còn giữ phường cũ, đã hỏi trước ⇒ vẫn không bỏ câu hỏi`);
  }
  // Lời nhắc lại ĐÚNG phường đang giữ / câu không nói gì về phường KHÔNG phải lời sửa.
  assert.equal(addressCheckOf({ address: MODEL_LINE, province: "" }, { customerTexts: [TUYET_MSG, "phường An Hội Tây em nhé", "ok em giao giúp chị"] }).view.status, "CUSTOMER_STATED");

  // X6: «12 Trần Phú, Hà Đông, Hà Nội» — «Trần Phú» đứng ngay sau số nhà là TÊN ĐƯỜNG, không phải «Xã Trần Phú» (cũng là tên một xã
  // mới của Hà Nội). Có tiền tố loại thì vẫn là xã.
  assert.notEqual(parseCustomerAddress("12 Trần Phú, Hà Đông, Hà Nội").ward, "Xã Trần Phú");
  assert.equal(parseCustomerAddress("12 Trần Phú, Hà Đông, Hà Nội").confidence, "NOT_FOUND");
  assert.equal(parseCustomerAddress("thôn 3, xã Trần Phú, Hà Nội").ward, "Xã Trần Phú");
  const x6 = addressCheckOf({ address: "12 Trần Phú", province: "" }, { customerTexts: ["12 Trần Phú, phường Hạc Thành, Thanh Hóa", "ok em", "12 Trần Phú, Hà Đông, Hà Nội nha"], turn: 5 }).view;
  assert.ok(x6.ward !== "Xã Trần Phú" && x6.ward !== "Phường Hạc Thành", JSON.stringify(x6));
  // X8: dòng công cụ nhắc quận cũ Gò Vấp; phường trong tin khách (Bến Thành — quận 1 cũ) không có đất ở Gò Vấp ⇒ không ghép, hỏi.
  const x8 = addressCheckOf({ address: "12 Lê Lợi nối dài, Gò Vấp", province: "TP.HCM" }, { customerTexts: ["12 Lê Lợi, P Bến Thành, TP.HCM"], turn: 5 }).view;
  assert.deepEqual([x8.status, x8.ward, Boolean(x8.ask_customer)], ["AMBIGUOUS", null, true], JSON.stringify(x8));

  // ⑧ Câu khi lượt im: đã có dòng địa chỉ mà chỉ thiếu TỈNH ⇒ hỏi đúng tỉnh, không xin lại cả địa chỉ.
  const cart: CartCommitment = { selectedItems: [{ label: "chả cá thu", match: "cha ca thu", productId: null, variantId: null, sku: null, quantity: 1000, unit: "g", sourceMessageId: 1, confidence: "HIGH", customerExplicit: true }], turn: 1, at: new Date().toISOString() };
  const noProv = { id: null, name: "K", phone: "0961004962", address: "Số 5 ngõ 3 TB", province: "", simulated: false };
  assert.equal(silenceFallbackText({ cart, customer: noProv }, "ok", 1, false), "Dạ mình cho em xin tỉnh / thành phố của địa chỉ nhận hàng nhé.");
  console.log("✓ Phường khách ghi rõ: P / P. / F / phường / không dấu / IN HOA ⇒ An Hội Tây · Phúc La cũ ⇒ Hà Đông · chữ khách thắng bản model chép · mơ hồ ⇒ một câu ngắn, không danh sách 6 · đã hỏi ⇒ không hỏi lại · hàng rào chữ gửi khách");
}

/** Công cụ bot (khung THỬ — không ghi gì): ca «Tuyet Nguyen Thi» từ đầu tới cổng chốt, và «không hỏi lại ở lượt sau». */
export async function testAddressWardExplicitTools() {
  const ctx = (state: ChatState, last: string, turn: number, customerTexts: string[] = []) => ({ conversationId: "conv-ward", channel: "TEST" as const, config: parseSalesChatbotConfig(null), state, lastUserText: last, agent: AGENT, turn, customerTexts });
  const clone = (s: ChatState): ChatState => JSON.parse(JSON.stringify(s)) as ChatState;

  // Model chép dòng địa chỉ mất phường mới ⇒ create_customer vẫn trả CUSTOMER_STATED (đọc chữ khách), không câu hỏi nào, không ghi trí nhớ hỏi.
  const cc = await executeTool("create_customer", { name: "Tuyết", phone: "0901234567", address: MODEL_LINE }, ctx({}, TUYET_MSG, 2, [TUYET_MSG]));
  assert.ok(!cc.isError, cc.content);
  const view = (JSON.parse(cc.content) as { address_check: { status: string; ward: string | null; ask_customer: string | null } }).address_check;
  assert.deepEqual([view.status, view.ward, view.ask_customer], ["CUSTOMER_STATED", AN_HOI_TAY, null], JSON.stringify(view));
  assert.equal(cc.state.addressAsk, undefined, "không có câu hỏi ⇒ không có gì để nhớ");

  // Cổng chốt: dòng của đơn nháp mất phường nhưng chữ khách có ⇒ KHÔNG chặn vì «địa chỉ chưa chuẩn hoá».
  const recipient = { name: "Tuyết", phone: "0901234567", address: MODEL_LINE, province: "" };
  const base: ChatState = {
    customer: { id: null, name: "Tuyết", phone: "0901234567", address: MODEL_LINE, province: "", simulated: true },
    draft: { orderId: null, lines: [{ variantId: "ward-test-var", quantity: 1 }], unitPrices: { "ward-test-var": 280_000 }, recipient, note: "", simulated: true, shownTurn: 2, firstShownTurn: 2 },
  };
  const gate = await executeTool("confirm_order", { customer_confirmation: "ok em" }, ctx(clone(base), "ok em", 3, [TUYET_MSG, "ok em"])).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(!/địa chỉ chưa chuẩn hoá/.test(gate.summary), `chữ khách có phường ⇒ không hỏi lại: ${gate.summary}`);

  // KHÔNG HỎI LẠI Ở LƯỢT SAU: không có chữ khách, địa chỉ mơ hồ ⇒ lượt 3 hỏi MỘT lần (câu ngắn, không danh sách 6) ...
  const ask = await executeTool("confirm_order", { customer_confirmation: "ok em" }, ctx(clone(base), "ok em", 3));
  assert.ok(ask.isError && /địa chỉ chưa chuẩn hoá/.test(ask.summary), ask.summary);
  assert.ok(GO_VAP_SIX.every((w) => !ask.content.includes(w.replace(/^Phường/, "phường"))), `câu hỏi không liệt kê 6 phường: ${ask.content}`);
  assert.equal(ask.state.addressAsk?.parts?.ward, 3);
  // ... lượt 4 model chép lại địa chỉ KHÁC chuỗi (khách thêm «gần chợ») ⇒ không hỏi lại, đơn đi tiếp (cờ cần kiểm của lõi đơn).
  const moved: ChatState = { ...clone(ask.state), draft: { ...clone(ask.state).draft!, recipient: { ...recipient, address: `${MODEL_LINE} gần chợ` } } };
  const again = await executeTool("confirm_order", { customer_confirmation: "ok em" }, ctx(moved, "ok em", 4)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(!/địa chỉ chưa chuẩn hoá/.test(again.summary), `đã hỏi phường ở lượt 3 ⇒ lượt 4 không hỏi lại dù chuỗi địa chỉ đổi: ${again.summary}`);
  // create_customer ở lượt sau cũng không đưa câu hỏi phường nữa.
  const cc2 = await executeTool("create_customer", { name: "Tuyết", phone: "0901234567", address: `${MODEL_LINE} gần chợ` }, ctx(clone(ask.state), "giao giúp chị nhé", 4));
  const v2 = (JSON.parse(cc2.content) as { address_check: { ask_customer: string | null; note: string } }).address_check;
  assert.deepEqual([v2.ask_customer, /KHÔNG hỏi lại/.test(v2.note)], [null, true], JSON.stringify(v2));
  // Lời trả lời phường ở tin TRƯỚC rồi «ok em» KHÔNG được nhận (review PR #848 lần 4: lời trả lời không gắn được với câu hỏi của đúng
  // nơi giao — «phường X» cho địa chỉ cũ rồi «giao chỗ làm, Viettel Tower» từng vào đơn mới). Đơn đi với ô xã trống + cờ cần kiểm.
  const prior = await executeTool("update_draft_order", { ward: "Phường An Hội Tây" }, ctx(clone(ask.state), "ok em", 4, ["phường An Hội Tây em nhé", "ok em"])).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(prior.isError && /chưa xác nhận/.test(prior.summary), `tên phường chỉ ở tin trước ⇒ không nhận: ${prior.summary}`);
  const viettel = ["230/20 Phan Huy Ích, Gò Vấp", "phường An Hội Tây em nhé", "lần này giao chỗ làm chị nhé, Viettel Tower"];
  const tower = await executeTool("update_draft_order", { address: "Viettel Tower, TP.HCM", ward: AN_HOI_TAY }, ctx(clone(ask.state), viettel[2], 5, viettel)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(tower.isError && /chưa xác nhận/.test(tower.summary), `nơi giao mới, phường trả lời cho nơi cũ ⇒ từ chối: ${tower.summary}`);
  // Model tự chọn phường khách CHƯA từng nói ⇒ vẫn từ chối (không đoán thay khách).
  const guess = await executeTool("update_draft_order", { ward: "Phường Hạnh Thông" }, ctx(clone(ask.state), "ok em", 4, ["ok em"]));
  assert.ok(guess.isError && /chưa xác nhận/.test(guess.summary), guess.summary);
  // REVIEW PR #848 LẦN 2 — phường của địa chỉ CŨ không được ghi vào đơn của địa chỉ MỚI: tin 1 có «P An Hội Tây», tin 2 khách đổi sang
  // một địa chỉ khác; model gửi ward = An Hội Tây kèm địa chỉ mới ⇒ TỪ CHỐI (trước đây nối mọi tin khách lại nên lọt, không cờ nào bật).
  const NEW_ADDR = "15 Nguyễn Oanh, Gò Vấp, TP.HCM";
  const switchTexts = ["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM", "à chị đổi, giao về 15 Nguyễn Oanh, Gò Vấp nha"];
  const switched = await executeTool("update_draft_order", { address: NEW_ADDR, ward: AN_HOI_TAY }, ctx(clone(base), switchTexts[1], 5, switchTexts)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(switched.isError && /chưa xác nhận/.test(switched.summary), `địa chỉ mới, phường của địa chỉ cũ ⇒ từ chối: ${switched.summary}`);
  // Địa chỉ mới KHÔNG CÓ SỐ sau lời trả lời phường của địa chỉ cũ ⇒ không nhận.
  const noNumber = ["230/20 Phan Huy Ích, Gò Vấp", "phường An Hội Tây em nhé", "à giao về chỗ khác nhé, công ty chị ở Quang Trung Gò Vấp"];
  const noNumberRun = await executeTool("update_draft_order", { address: "Công ty, Quang Trung, Gò Vấp, TP.HCM", ward: AN_HOI_TAY }, ctx(clone(ask.state), noNumber[2], 5, noNumber)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(noNumberRun.isError && /chưa xác nhận/.test(noNumberRun.summary), `địa chỉ mới không số ⇒ từ chối phường cũ: ${noNumberRun.summary}`);
  // Câu PHỦ ĐỊNH / nêu HAI phường ở tin cuối không phải lời khai một phường.
  const hcmA = parseCustomerAddress(MODEL_LINE);
  assert.equal(acceptCustomerWard(hcmA, AN_HOI_TAY, "phường An Hội Tây hoặc An Hội Đông gì đó em").ok, false);
  assert.equal(acceptCustomerWard(hcmA, AN_HOI_TAY, "An Hội Tây hoặc Hạnh Thông").ok, false);
  assert.equal(acceptCustomerWard(hcmA, AN_HOI_TAY, "phường An Hội Tây em nhé").ok, true);
  const negLast = await executeTool("update_draft_order", { ward: AN_HOI_TAY }, ctx(clone(ask.state), "không phải An Hội Tây đâu em, phường An Hội Đông", 5, ["không phải An Hội Tây đâu em, phường An Hội Đông"])).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(negLast.isError && /chưa xác nhận/.test(negLast.summary), `phủ định ở tin cuối ⇒ từ chối: ${negLast.summary}`);
  // Địa chỉ đầy đủ ở tin trước, model chép CÙNG địa chỉ (mất phường) rồi gửi ward ⇒ nhận qua đường cùng đường + cùng số nhà.
  const sameAddr = await executeTool("update_draft_order", { address: MODEL_LINE, ward: AN_HOI_TAY }, ctx(clone(base), "ok em", 5, [TUYET_MSG, "ok em"])).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(!/chưa xác nhận/.test(sameAddr.summary), `cùng địa chỉ khách đã ghi phường ⇒ nhận: ${sameAddr.summary}`);
  // Lời sửa phường dạng CÂU HỎI («ủa mà chị ở An Hội Đông mà em?») bỏ cách đọc cũ: không CUSTOMER_STATED An Hội Tây nữa.
  const qFix = [TUYET_MSG, "ủa mà chị ở An Hội Đông mà em?", "đúng rồi em"];
  assert.notEqual(addressCheckOf({ address: MODEL_LINE, province: "", ward: "" }, { customerTexts: qFix }).view.ward, AN_HOI_TAY);
  // REVIEW LẦN 5 — cùng tên đường nhưng KHÔNG có số nhà (hoặc khác số) là nơi giao khác: không mượn phường của địa chỉ cũ.
  for (const [said, line] of [
    ["à lần này giao lên công ty chị trên đường Phan Huy Ích nhé, gần ngã tư", "Công ty, Phan Huy Ích, Gò Vấp, TP.HCM"],
    ["giao giúp chị ra chợ Phan Huy Ích, chị bán ở đó", "Chợ Phan Huy Ích, Gò Vấp, TP.HCM"],
    ["giao cho em gái chị hẻm 230 Phan Huy Ích nha, nhà khác", "Hẻm 230 Phan Huy Ích, Gò Vấp, TP.HCM"],
    ["giao về số 50 Phan Huy Ích", "Phan Huy Ích, Gò Vấp, TP.HCM"],
  ] as const) {
    const view = addressCheckOf({ address: line, province: "", ward: "" }, { customerTexts: [TUYET_MSG, said] }).view;
    assert.notEqual(view.ward, AN_HOI_TAY, `${said}: ${JSON.stringify(view)}`);
  }
  // Trí nhớ «đã hỏi phường» chỉ áp cho CÙNG nơi giao: đổi hẳn địa chỉ ⇒ bắt đầu lại; chép lại khác chữ ⇒ giữ.
  assert.equal(sameDeliveryPlace(MODEL_LINE, `${MODEL_LINE} gần chợ`), true);
  assert.equal(sameDeliveryPlace(MODEL_LINE, NEW_ADDR), false);
  assert.ok(askMemoryFor(ask.state.addressAsk, `${MODEL_LINE} gần chợ`));
  assert.equal(askMemoryFor(ask.state.addressAsk, NEW_ADDR), undefined);
  const elsewhere: ChatState = { ...clone(ask.state), draft: { ...clone(ask.state).draft!, recipient: { ...recipient, address: "99 Quang Trung, Gò Vấp, TP.HCM" } } };
  const fresh = await executeTool("confirm_order", { customer_confirmation: "ok em" }, ctx(elsewhere, "ok em", 10)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(/địa chỉ chưa chuẩn hoá/.test(fresh.summary), `địa chỉ khác hẳn, mơ hồ ⇒ được hỏi phường một lần: ${fresh.summary}`);
  console.log("✓ Công cụ bot: chữ khách có phường ⇒ create_customer không hỏi, cổng chốt không chặn · hỏi đúng một lần (không danh sách 6) · lượt sau không hỏi lại dù địa chỉ chép khác · model không tự chọn phường");
}

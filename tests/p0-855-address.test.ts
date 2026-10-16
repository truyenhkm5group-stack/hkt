/**
 * ═══════════ #855 — ĐỊA CHỈ CŨ / MỚI, ĐỊA GIỚI CŨ, KHÔNG HỎI LẠI (P0-A chủ shop 16/10/2026) ═══════════
 *
 * Hai ca thật (HSLC, dữ liệu đã thay — không SĐT / số nhà thật):
 *  · Ca B «Lieu Dau»: khách ghi đủ tổ dân phố + thị trấn + huyện + tỉnh theo địa giới CŨ ⇒ bot vẫn hỏi «tên phường / xã (theo địa giới
 *    mới)». ROOT CAUSE: (1) `streetLooksReal` không nhận «TDP / KP / khóm…» ⇒ địa chỉ cũ ghép được vẫn không thành «khách đã ghi rõ»;
 *    (2) thị trấn cũ bị chia / tên cũ không có trong danh mục ⇒ `addressReaskVerdict` để câu hỏi phường ĐẦU TIÊN đi qua — khách bị bắt
 *    tra tên phường mới.
 *  · Ca C «ThuyNgo»: «Địa chỉ cũ» ⇒ bot chỉ có «Khương Đình», hỏi lại liên tục; rồi khách gửi địa chỉ MỚI ở Thủ Đức mà đơn nháp vẫn
 *    giữ Khương Đình. ROOT CAUSE: (1) `addressConfidence` nhận một dòng chỉ có tên phường là «địa chỉ đã xác minh»; (2) lời nhắc 360
 *    bảo bot «CHỈ xin địa chỉ» ở MỌI lượt còn lời «địa chỉ cũ» trong 3 tin gần nhất; (3) `reuseIntentOf` giữ REUSE kể cả khi tin mới
 *    hơn là một địa chỉ giao mới ⇒ lời nhắc tiếp tục bảo dùng địa chỉ cũ; (4) `addressKnowledge` đọc đơn nháp TRƯỚC tin khách mới hơn.
 *
 * Luật khoá ở đây: địa chỉ khách vừa gõ THẮNG địa chỉ cũ / đơn nháp · «như cũ» chỉ dùng địa chỉ ĐẦY ĐỦ đã xác minh · không có ⇒ cần
 * người, không hỏi lặp · không bịa phần nào của địa chỉ · địa giới cũ giữ nguyên văn, không map được ⇒ không hỏi phường mới, cờ cần kiểm ·
 * không hỏi lại SĐT / tên / địa chỉ / phường đã có, không hỏi cùng một trường lần 2. Hội thoại vàng chạy trên HAI tổ chức thử (không
 * hard-code HSLC) và KHÔNG gửi tin thật.
 */
import assert from "node:assert/strict";
import { addressGapOf, addressQuestion, customerStatedAddresses, hasStreetDetail, legacyAddressUnmapped, looksLikeDeliveryAddress, parseCustomerAddress } from "@/lib/address/customer-address";
import { ADDRESS_HANDOFF_REASON, ADDRESS_KNOWN_TEXT, ADDRESS_REASK_NOTE, ADDRESS_STAFF_TEXT, addressKnowledge, addressReaskVerdict, asksForName, asksForPhone, deliveryAddressDecision, reuseIntentOf as reuseFromMemory } from "@/lib/sales-chatbot/address-memory";
import { addressConfidence, assembleCustomer360, customer360Prompt, reuseIntentOf, type OrderFact } from "@/lib/sales-chatbot/customer-360";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { runGoldenCases, say, type GoldenCase } from "./sales-agent-golden/harness";

/** Ca B — địa giới CŨ, thị trấn cũ bị chia làm ba xã mới (danh mục không quy được về MỘT xã). */
const OLD_SPLIT = "Tổ dân phố 5, thị trấn Đông Anh, huyện Đông Anh, Hà Nội";
/** Ca B — địa giới CŨ, tên cũ không có trong danh mục (chỉ đọc ra huyện cũ). */
const OLD_UNKNOWN = "tổ dân phố Quyết Tiến, thị trấn Chũ, huyện Lục Ngạn, tỉnh Bắc Giang";
/** Ca B — địa giới CŨ ghép được MỘT xã mới, viết tắt «TDP». */
const OLD_MAPPED = "TDP 3, thị trấn Phùng, huyện Đan Phượng, TP Hà Nội";
/** Ca C — địa chỉ mới (đã thay) ở Thủ Đức. */
const NEW_THU_DUC = "12 Võ Văn Ngân, Linh Chiểu, Thủ Đức, TP.HCM";
/** P0-A2 ca «ThivanNguyen» (đã thay số nhà): phường Đại Kim CŨ bị chia cho bốn phường mới. */
const DAI_KIM = "Số 25 khu Bắc Linh Đàm, phường Đại Kim (cũ), Hoàng Mai, Hà Nội";
/** P0-A2 ca «Lieu Dau»: khối + thị trấn + huyện Anh Sơn, Nghệ An (tên thị trấn cũ không có trong danh mục). */
const ANH_SON = "Khối 3, thị trấn Anh Sơn, huyện Anh Sơn, tỉnh Nghệ An";
const WARD_NEW_ASK = "Dạ mình cho em xin tên phường / xã (theo địa giới mới) của địa chỉ nhận hàng với ạ?";
const FULL_ASK = "Dạ chị cho em xin lại địa chỉ nhận hàng chi tiết ạ?";

const draftWith = (address: string, province = "", extra: Partial<{ name: string; phone: string; ward: string }> = {}): ChatState => ({
  draft: { orderId: null, lines: [], unitPrices: {}, recipient: { name: extra.name ?? "", phone: extra.phone ?? "", address, province, ward: extra.ward }, note: "", simulated: true },
});

export function testP0855AddressPure() {
  // ① BỘ ĐỌC — địa giới cũ: giữ nguyên văn, KHÔNG chọn xã, chỉ để cờ cho người kiểm.
  const split = legacyAddressUnmapped(OLD_SPLIT)!;
  assert.ok(split, "thị trấn cũ bị chia + đủ tổ / thị trấn / huyện / tỉnh ⇒ địa chỉ cũ chưa ghép");
  assert.equal(split.raw, OLD_SPLIT, "nguyên văn khách gõ");
  assert.equal(split.province, "Thành phố Hà Nội");
  assert.equal(split.candidates.length, 3, "ứng viên chỉ cho người kiểm đọc");
  assert.ok(legacyAddressUnmapped(OLD_UNKNOWN), "tên cũ không có trong danh mục vẫn là địa chỉ cũ đủ — không phải địa chỉ vô hiệu");
  assert.equal(legacyAddressUnmapped(OLD_MAPPED), null, "ghép được xã mới ⇒ không phải «chưa ghép»");
  assert.equal(parseCustomerAddress(OLD_MAPPED).ward, "Xã Đan Phượng");
  assert.equal(customerStatedAddresses([OLD_MAPPED])[0]?.ward, "Xã Đan Phượng", "«TDP 3» là phần đường thật ⇒ khách đã ghi rõ");
  for (const partial of ["Khương Đình", "Khương Đình, Thanh Xuân, Hà Nội", "230/20 Phan Huy Ích, Gò Vấp, TP.HCM", "à em nhầm, phường 15 Gò Vấp nhé"]) {
    assert.equal(legacyAddressUnmapped(partial), null, `${partial}: không đủ địa giới cũ hai cấp + phần đường ⇒ không phải ca này`);
  }
  assert.equal(hasStreetDetail("Khương Đình"), false, "một tên phường không phải địa chỉ đầy đủ");
  assert.equal(hasStreetDetail("Số 8 ngõ 2, Phường Cầu Giấy, Hà Nội"), true);
  assert.equal(looksLikeDeliveryAddress(NEW_THU_DUC), true);
  assert.equal(looksLikeDeliveryAddress("Địa chỉ cũ"), false);
  assert.equal(looksLikeDeliveryAddress(`${NEW_THU_DUC} có ship không?`), false, "câu hỏi không phải lời khai địa chỉ");

  // ② CA B Ở HÀNG RÀO — câu hỏi phường mới (kể cả lần ĐẦU) bị bỏ khi khách đã cho địa chỉ cũ đủ; không chuyển người, cờ cần kiểm.
  for (const [label, state, texts] of [
    ["chỉ có tin khách", {}, [`chị lấy 1kg nhé\n${OLD_SPLIT}\n0901234567`]],
    ["đơn nháp mang dòng cũ", draftWith(OLD_SPLIT), [OLD_SPLIT]],
    ["tên cũ không có trong danh mục", {}, [OLD_UNKNOWN]],
    ["khách đồng ý sau đó", draftWith(OLD_SPLIT), [OLD_SPLIT, "ok em"]],
  ] as const) {
    const k = addressKnowledge(state as ChatState, texts);
    assert.equal(k.legacyUnmapped, true, `${label}: ${JSON.stringify(k)}`);
    assert.equal(k.ward, null, `${label}: không tự chọn xã`);
    const v = addressReaskVerdict(`Dạ em ghi nhận ạ. ${WARD_NEW_ASK}`, k, 2);
    assert.ok(v && v.note.startsWith(ADDRESS_REASK_NOTE.LEGACY_UNMAPPED) && v.rest === "Dạ em ghi nhận ạ." && !v.handoff, `${label}: ${JSON.stringify(v)}`);
    // Câu chọn giữa các phường «có thể là» (câu bộ đọc soạn) cũng bị bỏ — không bắt khách tra bản đồ.
    const pick = addressQuestion(parseCustomerAddress(OLD_SPLIT));
    if (pick) assert.ok(addressReaskVerdict(pick, k, 2), `${label}: câu chọn phường mới cũng bị bỏ`);
    assert.ok(addressReaskVerdict(FULL_ASK, k, 2), `${label}: xin lại cả địa chỉ cũng bị bỏ`);
  }
  // Địa chỉ cũ GHÉP được ⇒ phường đã biết ⇒ bỏ câu hỏi phường.
  const mapped = addressKnowledge({}, [OLD_MAPPED]);
  assert.deepEqual([mapped.ward, addressReaskVerdict(WARD_NEW_ASK, mapped, 2)?.note], ["Xã Đan Phượng", ADDRESS_REASK_NOTE.WARD_KNOWN]);
  // Khách đổi địa chỉ / sửa phường ⇒ hàng rào đứng ngoài (không chặn nhầm).
  assert.equal(addressReaskVerdict(WARD_NEW_ASK, addressKnowledge(draftWith(OLD_SPLIT), [OLD_SPLIT, "à chị đổi địa chỉ nhé"]), 3), null);
  // Địa chỉ chỉ có quận cũ (không có cấp xã cũ) ⇒ câu hỏi phường ĐẦU TIÊN vẫn đi qua (luồng #848 giữ nguyên).
  assert.equal(addressReaskVerdict(WARD_NEW_ASK, addressKnowledge({}, ["230/20 Phan Huy Ích, Gò Vấp, TP.HCM"]), 2), null);

  // ③ CA C — CUSTOMER 360: một tên phường không bao giờ là «địa chỉ cũ đã xác minh».
  const fact = (o: Partial<OrderFact>): OrderFact => ({ orderId: "o", source: "ERP", at: "2026-01-10T03:00:00.000Z", stage: "SHIPPED", outcome: null, link: "THREAD", customerId: null, name: "Chị Thử", phone: "0900000111", address: "Số 8 ngõ 2", ward: "Phường Cầu Giấy", province: "Thành phố Hà Nội", items: [], paid: false, currentCycle: false, ...o });
  assert.equal(addressConfidence(fact({ address: "Khương Đình", ward: "Phường Khương Đình", province: "Thành phố Hà Nội" })), null, "chỉ tên vùng ⇒ không đề xuất");
  assert.equal(addressConfidence(fact({ address: "Khương Đình", ward: "Phường Khương Đình", outcome: "DELIVERED", stage: "DELIVERED" })), null, "giao thành công cũng không biến tên vùng thành địa chỉ đầy đủ");
  assert.equal(addressConfidence(fact({})), "CONFIRMED_NORMALIZED");
  const c360 = assembleCustomer360({ conversationId: "c", state: {} as ChatState, threadBound: true, facts: [fact({ address: "Khương Đình", ward: "Phường Khương Đình" })], phoneCustomerIds: [] });
  assert.deepEqual([c360.suggestion, c360.noAddressReason], ["NONE", "ONLY_UNVERIFIED"]);
  const nonePrompt = customer360Prompt(c360, reuseIntentOf(["Địa chỉ cũ"]));
  assert.ok(/MỘT LẦN DUY NHẤT/.test(nonePrompt) && /handoff_to_human/.test(nonePrompt) && !nonePrompt.includes("Khương Đình"), nonePrompt);

  // ④ Ý ĐỊNH — địa chỉ MỚI sau «như cũ» thắng; địa chỉ gõ khi khách không nhắc địa chỉ cũ không đổi gì (lời nhắc khác giữ nguyên).
  assert.equal(reuseIntentOf, reuseFromMemory, "một luật đọc ý định, hai nơi dùng");
  assert.equal(reuseIntentOf(["Địa chỉ coi lại", "Địa chỉ cũ"]).address, "REUSE");
  assert.equal(reuseIntentOf(["Địa chỉ cũ", NEW_THU_DUC]).address, "NEW");
  assert.equal(reuseIntentOf(["Địa chỉ cũ", `giao giúp chị về\n${NEW_THU_DUC}`]).address, "NEW");
  assert.equal(reuseIntentOf([NEW_THU_DUC]).address, null);
  assert.equal(reuseIntentOf([NEW_THU_DUC, "thôi vẫn địa chỉ cũ"]).address, "REUSE", "«như cũ» MỚI hơn địa chỉ gõ ⇒ dùng lại");
  const newPrompt = customer360Prompt(c360, reuseIntentOf(["Địa chỉ cũ", NEW_THU_DUC]));
  assert.ok(/VỪA GỬI MỘT ĐỊA CHỈ GIAO MỚI/.test(newPrompt) && /THẮNG/.test(newPrompt) && /KHÔNG tự thêm phường/.test(newPrompt), newPrompt);

  // ⑤ PROVENANCE — quyết định địa chỉ giao.
  const khuong = { customer: { id: null, name: "Thủy", phone: "0900000111", address: "Khương Đình", province: "", simulated: true } } as ChatState;
  const d1 = deliveryAddressDecision(khuong, ["Địa chỉ coi lại", "Địa chỉ cũ"]);
  assert.deepEqual([d1.status, d1.use], ["NEEDS_HUMAN", null], "«địa chỉ cũ» + chỉ có tên vùng ⇒ cần người, không dùng gì");
  const verified = { customer: { id: null, name: "Thủy", phone: "0900000111", address: "Số 8 ngõ 2, Phường Cầu Giấy", province: "Thành phố Hà Nội", simulated: true, savedAddress: true } } as ChatState;
  const d2 = deliveryAddressDecision(verified, ["vẫn địa chỉ cũ nhé"]);
  assert.deepEqual([d2.status, d2.use?.source], ["REUSE_VERIFIED", "VERIFIED_HISTORY"]);
  assert.equal(deliveryAddressDecision({}, ["như cũ nhé"], { address: "Số 8 ngõ 2", province: "Thành phố Hà Nội" }).status, "REUSE_VERIFIED", "địa chỉ đơn cũ đã xác minh từ Customer 360");
  assert.equal(deliveryAddressDecision({}, ["như cũ nhé"], { address: "Khương Đình", province: "Thành phố Hà Nội" }).status, "NEEDS_HUMAN", "đơn cũ chỉ có tên vùng ⇒ cần người");
  const d3 = deliveryAddressDecision(draftWith("Khương Đình"), ["Địa chỉ cũ", NEW_THU_DUC]);
  assert.deepEqual([d3.status, d3.use?.raw, d3.previous?.raw], ["CHANGE_PENDING_VERIFICATION", NEW_THU_DUC, "Khương Đình"], "địa chỉ mới thắng, bản cũ giữ để người đối chiếu");
  assert.equal(deliveryAddressDecision(verified, ["vẫn địa chỉ cũ nhé", NEW_THU_DUC]).status, "CHANGE_PENDING_VERIFICATION", "đổi sang địa chỉ mới sau «như cũ» ⇒ mới thắng");
  assert.equal(deliveryAddressDecision(draftWith(NEW_THU_DUC), [NEW_THU_DUC]).status, "NEW_EXPLICIT");

  // ⑥ CA C Ở HÀNG RÀO.
  //  · Lần đầu «địa chỉ cũ» chưa có địa chỉ xác minh ⇒ câu «em chưa tìm thấy…, gửi giúp em địa chỉ» đi qua MỘT lần (lời nhắc 360).
  assert.equal(addressReaskVerdict(FULL_ASK, addressKnowledge(khuong, ["Địa chỉ cũ"]), 2), null);
  //  · Khách nhắc lại / phàn nàn ⇒ bỏ câu hỏi, câu nhân viên thay chỗ, lý do chuyển người.
  for (const texts of [["Địa chỉ cũ", "địa chỉ cũ mà em"], ["Địa chỉ cũ", "Robot hả"], ["Địa chỉ cũ", "Khách cũ mà hỏi gì"], ["Sao kg coi ở trên"]]) {
    const v = addressReaskVerdict(FULL_ASK, addressKnowledge(khuong, texts), 3);
    assert.ok(v && v.handoff && v.rest.endsWith(ADDRESS_STAFF_TEXT) && !/ngõ|số nhà/.test(v.rest), `${JSON.stringify(texts)}: ${JSON.stringify(v)}`);
  }
  assert.equal(addressReaskVerdict(FULL_ASK, addressKnowledge(khuong, ["Địa chỉ cũ", "địa chỉ cũ mà em"]), 3)?.handoff, ADDRESS_HANDOFF_REASON.REUSE_UNVERIFIED);
  //  · «Như cũ» với địa chỉ xác minh đã điền ⇒ xin lại địa chỉ là hỏi lặp.
  assert.equal(addressReaskVerdict(FULL_ASK, addressKnowledge(verified, ["vẫn địa chỉ cũ nhé"]), 2)?.note, ADDRESS_REASK_NOTE.FULL_KNOWN);
  //  · Địa chỉ MỚI sau «như cũ», đơn nháp còn Khương Đình ⇒ điều đã biết là địa chỉ MỚI: không hỏi phường / địa chỉ của nó, ghi lệch.
  const kNew = addressKnowledge(draftWith("Khương Đình"), ["Địa chỉ cũ", NEW_THU_DUC]);
  assert.deepEqual([kNew.ward, kNew.draftMismatch], ["Phường Thủ Đức", true], JSON.stringify(kNew));
  const vNew = addressReaskVerdict("Dạ địa chỉ mình thuộc phường nào ạ?", kNew, 4);
  assert.ok(vNew && vNew.note.startsWith(ADDRESS_REASK_NOTE.WARD_KNOWN) && /KHÁC đơn nháp/.test(vNew.note), JSON.stringify(vNew));
  assert.ok(addressReaskVerdict(FULL_ASK, kNew, 4), "không xin lại địa chỉ vừa gửi");
  //  · Không bịa: hàng rào không bao giờ thêm phường / số nhà vào chữ gửi khách.
  assert.ok(!/Thủ Đức|Khương Đình|Võ Văn Ngân/.test(vNew.rest + ADDRESS_KNOWN_TEXT + ADDRESS_STAFF_TEXT));

  // ⑦ SĐT / TÊN ĐÃ CÓ + HỎI CÙNG MỘT TRƯỜNG LẦN 2.
  const withContact = draftWith(NEW_THU_DUC, "", { name: "Thủy", phone: "0900000111" });
  const kc = addressKnowledge(withContact, [NEW_THU_DUC]);
  assert.equal(addressReaskVerdict("Dạ chị cho em xin số điện thoại ạ?", kc, 2)?.note, ADDRESS_REASK_NOTE.PHONE_KNOWN);
  assert.equal(addressReaskVerdict("Dạ chị cho em xin họ tên người nhận ạ?", kc, 2)?.note, ADDRESS_REASK_NOTE.NAME_KNOWN);
  assert.equal(addressReaskVerdict("Dạ vẫn số đuôi 0111 phải không ạ?", kc, 2), null, "câu xác nhận đuôi số không phải câu xin lại");
  assert.equal(addressReaskVerdict("Dạ chị gửi em số mới ạ?", addressKnowledge(withContact, [NEW_THU_DUC, "chị dùng số khác nhé"]), 2), null, "khách đổi số ⇒ được xin số mới");
  assert.equal(addressReaskVerdict("Dạ chị cho em xin số điện thoại ạ?", addressKnowledge({}, ["0912 345 678", "1kg chả mực"]), 2)?.note, ADDRESS_REASK_NOTE.PHONE_KNOWN, "SĐT khách đã gõ trong hội thoại");
  assert.ok(asksForPhone("Mình cho em xin SĐT nhé?") && !asksForPhone("Dạ vẫn số đuôi 0111 ạ?") && asksForName("Cho em xin tên người nhận ạ?") && !asksForName("Cho em xin tên phường ạ?"));
  const empty = addressKnowledge({}, ["1kg chả mực nhé"]);
  assert.equal(addressReaskVerdict(FULL_ASK, empty, 2), null, "lần hỏi đầu đi qua");
  const twice = addressReaskVerdict(FULL_ASK, empty, 3, { botTexts: ["Dạ mình cho em xin địa chỉ nhận hàng ạ?"] });
  assert.ok(twice && twice.note.startsWith(ADDRESS_REASK_NOTE.REPEAT_ASK) && twice.handoff === ADDRESS_HANDOFF_REASON.REPEAT_ASK && twice.rest === ADDRESS_STAFF_TEXT, JSON.stringify(twice));
  assert.equal(addressReaskVerdict("Dạ chị cho em xin số điện thoại ạ?", empty, 3, { botTexts: ["Dạ chị cho em xin số điện thoại nhé?"] })?.note, ADDRESS_REASK_NOTE.REPEAT_ASK);
  assert.equal(addressReaskVerdict("Dạ mình ở phường nào ạ?", empty, 3, { botTexts: ["Dạ mình ở phường nào ạ?"] })?.note, ADDRESS_REASK_NOTE.WARD_ASKED, "phường đã hỏi ⇒ không hỏi lần 2, đơn đi với cờ cần kiểm");

  // ⑧ P0-A2 — bảng ca thật (dữ liệu giả): 0 câu bắt khách tự chuyển địa giới, 0 địa chỉ suy đoán, 0 hỏi lặp.
  //  · «ThivanNguyen»: Đại Kim cũ ⇒ bốn ứng viên THẬT trong danh mục, không chọn bừa; câu «Đại Kim cũ nay là phường nào theo tên mới» của
  //    bộ đọc bị hàng rào bỏ; chỗ trống là CHƯA GHÉP ĐƯỢC DANH MỤC (việc nhân viên), không phải «khách chưa cung cấp».
  const dk = parseCustomerAddress(DAI_KIM);
  assert.deepEqual([dk.confidence, dk.ward, [...dk.candidates].sort()], ["AMBIGUOUS", null, ["Phường Hoàng Liệt", "Phường Khương Đình", "Phường Thanh Liệt", "Phường Định Công"].sort()]);
  assert.equal(addressGapOf(DAI_KIM).gap, "CATALOG_UNMATCHED");
  assert.equal(legacyAddressUnmapped(DAI_KIM)?.raw, DAI_KIM, "giữ nguyên văn");
  const dkAsk = addressQuestion(dk)!;
  assert.match(dkAsk, /theo tên mới/, "câu bộ đọc soạn cho công cụ — chính câu đã tới khách trong ca thật");
  for (const state of [{}, draftWith(DAI_KIM, "", { name: "Khách Thử", phone: "0900000222" })] as ChatState[]) {
    const k = addressKnowledge(state, [`${DAI_KIM}\n0900000222`]);
    const v = addressReaskVerdict(dkAsk, k, 2);
    assert.ok(v && v.note === ADDRESS_REASK_NOTE.LEGACY_UNMAPPED && v.rest === "" && !v.handoff, JSON.stringify(v));
    assert.ok(addressReaskVerdict("Dạ chị cho em xin số điện thoại ạ?", k, 2), "SĐT đã có trong tin ⇒ không xin lại");
  }
  //  · «Lieu Dau» (Anh Sơn, Nghệ An): «Khối 3» là phần đường thật; thị trấn cũ không có trong danh mục ⇒ cần nhân viên, không hỏi khách.
  assert.equal(addressGapOf(ANH_SON).gap, "CATALOG_UNMATCHED");
  assert.ok(addressReaskVerdict(addressQuestion(parseCustomerAddress(ANH_SON))!, addressKnowledge({}, [ANH_SON]), 2));
  assert.equal(addressGapOf("xóm 5, xã Tường Sơn, huyện Anh Sơn, Nghệ An").gap, "COMPLETE", "xã cũ gộp trọn ⇒ tự ghép, không hỏi");
  //  · «Tuyet Nguyen Thi» (An Hội Tây mới) · «Lê Văn Dụ» (Xa La, Phúc La cũ ⇒ Hà Đông): phường đã biết ⇒ không hỏi.
  for (const [text, ward] of [["230/20 Phan Huy Ích, P An Hội Tây, TP.HCM", "Phường An Hội Tây"], ["khu đô thị Xa La, Phúc La cũ, Hà Đông, Hà Nội", "Phường Hà Đông"]] as const) {
    const k = addressKnowledge({}, [text]);
    assert.equal(k.ward, ward, text);
    assert.equal(addressReaskVerdict(WARD_NEW_ASK, k, 2)?.note, ADDRESS_REASK_NOTE.WARD_KNOWN, text);
    assert.equal(addressGapOf(text).gap, "COMPLETE", text);
  }
  //  · «Khách chưa cung cấp» khác «chưa ghép danh mục»: chỉ có tên đường ⇒ được hỏi đúng phần thiếu, MỘT lần.
  assert.deepEqual(addressGapOf("12 Lê Lợi").gap, "NOT_PROVIDED");
  assert.equal(addressReaskVerdict(WARD_NEW_ASK, addressKnowledge({}, ["12 Lê Lợi"]), 2), null, "lần đầu, phần thật sự thiếu ⇒ được hỏi");
  //  · Khách cũ, địa chỉ đã xác minh, đồng ý dùng lại ⇒ dùng; đổi địa chỉ SAU KHI ĐẶT (đơn nháp đã có) ⇒ địa chỉ mới thắng, đơn cần người.
  const ordered = { ...draftWith("Số 8 ngõ 2, Phường Cầu Giấy", "Thành phố Hà Nội", { name: "Khách Thử", phone: "0900000111" }) } as ChatState;
  const moved = deliveryAddressDecision(ordered, ["ok chốt em", `à chị chuyển nhà rồi, giao về ${NEW_THU_DUC} nhé`]);
  assert.deepEqual([moved.status, moved.previous?.raw], ["CHANGE_PENDING_VERIFICATION", "Số 8 ngõ 2, Phường Cầu Giấy"]);
}

const GOLDEN: GoldenCase[] = [
  {
    key: "p855-dia-gioi-cu",
    title: "Ca B: địa chỉ cũ đủ (tổ dân phố / thị trấn / huyện / tỉnh) ⇒ câu hỏi phường mới của AI bị bỏ",
    shop: "food",
    channel: "WEB",
    turns: [{ say: `Ship chị 1 chả mực giã tay\n${OLD_SPLIT}\n0901234567`, ai: [() => [say(WARD_NEW_ASK)]] }],
  },
  {
    key: "p855-dai-kim-cu",
    title: "P0-A2 ThivanNguyen: Đại Kim cũ (bốn ứng viên) ⇒ câu «nay là phường nào theo tên mới» của AI bị bỏ, không hỏi khách",
    shop: "fashion",
    channel: "WEB",
    turns: [{ say: `${DAI_KIM}\n0900000222`, ai: [() => [say("Dạ phường Đại Kim cũ nay là phường / xã nào theo tên mới ạ? Mình cho em xin tên phường / xã mới để shop giao đúng nha.")]] }],
  },
  {
    key: "p855-nhu-cu-roi-dia-chi-moi",
    title: "Ca C: «địa chỉ cũ» không có địa chỉ xác minh ⇒ hỏi một lần; nhắc lại ⇒ nhân viên; gửi địa chỉ mới ⇒ không hỏi phường của nó",
    shop: "fashion",
    channel: "WEB",
    turns: [
      { say: "Địa chỉ cũ", ai: [() => [say("Dạ em chưa tìm thấy địa chỉ cũ của mình trên hệ thống ạ. Chị gửi lại giúp em địa chỉ nhận hàng nhé?")]] },
      { say: "Khách cũ mà hỏi gì, địa chỉ cũ đó", ai: [() => [say(FULL_ASK)]] },
      { say: NEW_THU_DUC, ai: [() => [say("Dạ em ghi nhận ạ. Địa chỉ mình thuộc phường nào theo địa giới mới ạ?")]] },
    ],
  },
];

export async function testP0855AddressGolden() {
  const seen = new Set<string>();
  await runGoldenCases(GOLDEN, {
    orgSuffix: "-p855",
    afterCase: async (c, _ctx, t) => {
      seen.add(c.key);
      const shown = t.turns.map((x) => x.shown.join(" | "));
      if (c.key === "p855-dai-kim-cu") {
        assert.ok(!/tên mới|địa giới mới|Định Công|Hoàng Liệt/.test(shown[0]) && shown[0] === ADDRESS_KNOWN_TEXT, `không bắt khách chuyển địa giới, không gợi ý ứng viên: ${shown[0]}`);
        return;
      }
      if (c.key === "p855-dia-gioi-cu") {
        assert.ok(!/địa giới mới|phường \/ xã/.test(shown[0]), `không hỏi phường mới: ${shown[0]}`);
        assert.equal(shown[0], ADDRESS_KNOWN_TEXT);
        return;
      }
      assert.ok(/gửi lại giúp em địa chỉ/.test(shown[0]), `lần đầu: hỏi MỘT lần — ${shown[0]}`);
      assert.ok(shown[1].includes(ADDRESS_STAFF_TEXT) && !/xin lại địa chỉ/.test(shown[1]), `nhắc lại «địa chỉ cũ» ⇒ không hỏi lặp: ${shown[1]}`);
      assert.ok(!/phường nào/.test(shown[2]) && shown[2].includes("Dạ em ghi nhận ạ."), `địa chỉ mới ⇒ không hỏi phường của nó: ${shown[2]}`);
      const p2 = t.prompts[t.turns[2].rounds[0]?.prompt ?? -1] ?? "";
      assert.ok(/VỪA GỬI MỘT ĐỊA CHỈ GIAO MỚI/.test(p2), "lời nhắc lượt 3: địa chỉ mới thắng địa chỉ cũ");
    },
  });
  assert.deepEqual([...seen].sort(), GOLDEN.map((c) => c.key).sort(), "chạy đủ các hội thoại vàng trên hai tổ chức thử");
  console.log("  ✓ #855 địa chỉ: địa giới cũ đủ ⇒ không hỏi phường mới (cờ cần kiểm), «như cũ» chỉ dùng địa chỉ đầy đủ đã xác minh, không có ⇒ người (không hỏi lặp), địa chỉ mới sau «như cũ» thắng, không hỏi lại SĐT / tên / địa chỉ / phường, không hỏi cùng trường lần 2");
}

/** Điểm vào cho `sync-fixtures.test.ts`: phần thuần + hội thoại vàng. */
export async function testP0855Address() {
  testP0855AddressPure();
  await testP0855AddressGolden();
}

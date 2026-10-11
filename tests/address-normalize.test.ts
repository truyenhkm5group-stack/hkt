/**
 * ═══════════ ĐỊA CHỈ KHÁCH GÕ TỰ DO ⇒ MỨC TIN CẬY + CÂU HỎI KHÁCH (P0 address-normalize, 11/10/2026) ═══════════
 *
 * Hai ca thật production:
 *  · «SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội» (đơn #463DEBAE) — phường CŨ bị CHIA khi sáp nhập 01/07/2025
 *    ⇒ AMBIGUOUS (Thượng Cát / Đông Ngạc), hỏi khách, KHÔNG tự điền; trước đây kết quả này rơi mất và bot không hỏi gì.
 *  · «1094/3 Lê Đức Thọ P13 GV» (khách TP HCM) — «GV» = quận Gò Vấp cũ; danh mục trước sáp nhập KHÔNG có phường 13 Gò Vấp
 *    (đã gộp 01/01/2025) ⇒ biết tỉnh (quận Gò Vấp chỉ có ở TP HCM), xã mơ hồ trong 6 phường mới có đất Gò Vấp ⇒ hỏi khách.
 *  · Luật: chỉ EXACT / UNIQUE_FROM_OLD được tự điền; viết tắt mơ hồ không sinh ra tỉnh; xã chỉ ghi khi KHÁCH vừa nói tên đó.
 */
import assert from "node:assert/strict";
import data from "@/lib/address/vn-admin-2025.json";
import { acceptCustomerWard, addressQuestion, canAutoFill, parseCustomerAddress, streetPart } from "@/lib/address/customer-address";
import { HCM_DISTRICT_ABBREVIATIONS, foldVnText } from "@/lib/address/vn-address";
import { addressCheckOf, executeTool, type ChatState } from "@/lib/sales-chatbot/tools";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";

const AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/tools.ts" };
const CO_NHUE = "SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội";
const GO_VAP = "1094/3 Lê Đức Thọ P13 GV";

export function testAddressNormalizePure() {
  // ① Ca thật Cổ Nhuế — có dấu và viết thường không dấu ra CÙNG kết quả.
  for (const text of [CO_NHUE, "sn 242 duong co nhue, phuong co nhue 2, bac tu liem, ha noi", "SN 242 DUONG CO NHUE P CO NHUE 2 BAC TU LIEM HN"]) {
    const a = parseCustomerAddress(text);
    assert.equal(a.confidence, "AMBIGUOUS", `${text}: ${JSON.stringify(a)}`);
    assert.equal(a.province, "Thành phố Hà Nội");
    assert.equal(a.ward, null, "mơ hồ ⇒ KHÔNG điền xã");
    assert.deepEqual([...a.candidates].sort(), ["Phường Thượng Cát", "Phường Đông Ngạc"], "ứng viên là đúng hai phường mới có đất của Cổ Nhuế 2 cũ");
    assert.deepEqual(a.legacy, { ward: "Phường Cổ Nhuế 2", district: "Quận Bắc Từ Liêm" });
    assert.deepEqual(a.missing, ["ward"]);
    assert.equal(canAutoFill(a), false);
  }
  const co = parseCustomerAddress(CO_NHUE);
  assert.equal(co.street, "SN 242 đường cổ Nhuế");
  assert.equal(co.houseNumber, "242");
  const q = addressQuestion(co)!;
  assert.ok(q.includes("phường Cổ Nhuế 2 cũ") && q.includes("phường Thượng Cát") && q.includes("phường Đông Ngạc") && q.includes(" hay "), q);
  // Cổ Nhuế 1 cũ chia ba ⇒ ba ứng viên, không phải hai.
  assert.equal(parseCustomerAddress("số 5 ngõ 12 cổ nhuế p cổ nhuế 1 q bắc từ liêm hn").candidates.length, 3);

  // ② «875/4B trần hưng đạo f1q5» — f1q5 dính liền, không tỉnh ⇒ phường 1 quận 5 cũ chỉ có ở TP HCM, gộp trọn vào Chợ Quán.
  const f1 = parseCustomerAddress("875/4B trần hưng đạo f1q5");
  assert.deepEqual([f1.confidence, f1.province, f1.ward, f1.street, f1.houseNumber], ["UNIQUE_FROM_OLD", "Thành phố Hồ Chí Minh", "Phường Chợ Quán", "875/4B trần hưng đạo", "875/4B"]);
  assert.equal(canAutoFill(f1), true);
  assert.equal(addressQuestion(f1), null);
  assert.equal(parseCustomerAddress("12 Lê Lợi, P. Bến Nghé, Q.1, TP.HCM").ward, "Phường Sài Gòn", "P. / Q. / TP.HCM");

  // ③ Ca thật «P13 GV»: biết tỉnh, xã mơ hồ trong 6 phường mới có đất Gò Vấp; phường 13 không có trong danh mục cũ ⇒ nói rõ.
  for (const text of [GO_VAP, `${GO_VAP}, TP.HCM`, "1094/3 le duc tho p13 gv"]) {
    const g = parseCustomerAddress(text);
    assert.equal(g.confidence, "AMBIGUOUS", `${text}: ${JSON.stringify(g)}`);
    assert.equal(g.province, "Thành phố Hồ Chí Minh");
    assert.equal(g.ward, null);
    assert.deepEqual([...g.candidates].sort(), ["Phường An Hội Tây", "Phường An Hội Đông", "Phường An Nhơn", "Phường Gò Vấp", "Phường Hạnh Thông", "Phường Thông Tây Hội"]);
    assert.match(g.reason, /phuong 13/, "nói rõ danh mục cũ không có phường khách ghi");
    assert.ok(/^1094\/3 l/i.test(g.street) && !/p13|gv/i.test(g.street), `phần đường dừng trước phường / quận: ${g.street}`);
  }
  assert.ok(addressQuestion(parseCustomerAddress(GO_VAP))!.includes("phường Hạnh Thông"));
  // Phường số CÓ trong danh mục cũ ⇒ quy được: P5 Gò Vấp ⇒ An Nhơn.
  assert.equal(parseCustomerAddress("12 Nguyễn Văn Nghi P5 GV").ward, "Phường An Nhơn");
  assert.equal(parseCustomerAddress("12 Phan Xích Long p2 q.pn hcm").ward, "Phường Cầu Kiệu", "q.pn");
  // Viết tắt đứng trơ trọi, không tỉnh, không phường ⇒ KHÔNG sinh tỉnh.
  const tb = parseCustomerAddress("Số 5 ngõ 3 TB");
  assert.deepEqual([tb.confidence, tb.province, tb.missing], ["NOT_FOUND", null, ["province", "ward"]]);
  assert.equal(parseCustomerAddress("Số 5 ngõ 3 BT").province, null, "«BT» mơ hồ (Bình Thạnh / Bình Tân) — không có trong bảng");
  // Bảng viết tắt: mỗi đích là một quận / thành phố CŨ có thật của TP HCM.
  const hcm = (data as unknown as { provinces: [number, string, string[], [number, string, [string, string][]][]][] }).provinces.find((p) => p[0] === 79)!;
  const oldDistricts = new Set(hcm[3].flatMap((w) => w[2].map((l) => foldVnText(l[0]))));
  for (const [abbr, target] of Object.entries(HCM_DISTRICT_ABBREVIATIONS)) assert.ok(oldDistricts.has(target), `viết tắt «${abbr}» ⇒ «${target}» phải có trong danh mục cũ TP HCM`);
  assert.ok(!("bt" in HCM_DISTRICT_ABBREVIATIONS) && !("tp" in HCM_DISTRICT_ABBREVIATIONS) && !("cc" in HCM_DISTRICT_ABBREVIATIONS));

  // ④ Tỉnh gộp: tỉnh cũ Bình Dương ⇒ TP HCM; phường Phú Cường (TP Thủ Dầu Một cũ) gộp trọn vào Phường Thủ Dầu Một.
  const bd = parseCustomerAddress("14 Lý Thái Tổ, phường Phú Cường, TP Thủ Dầu Một, Bình Dương");
  assert.deepEqual([bd.confidence, bd.province, bd.ward], ["UNIQUE_FROM_OLD", "Thành phố Hồ Chí Minh", "Phường Thủ Dầu Một"]);
  // Tên MỚI có loại ⇒ EXACT.
  const exact = parseCustomerAddress("123 Nguyễn Đình Chiểu, Phường Bàn Cờ, TP Hồ Chí Minh");
  assert.deepEqual([exact.confidence, exact.ward, exact.street], ["EXACT", "Phường Bàn Cờ", "123 Nguyễn Đình Chiểu"]);
  // Thiếu số nhà / đường ⇒ hỏi phần thiếu dù xã đã chắc.
  const noStreet = parseCustomerAddress("Phường Bàn Cờ, HCM");
  assert.deepEqual([noStreet.confidence, noStreet.missing], ["EXACT", ["street"]]);
  assert.match(addressQuestion(noStreet)!, /số nhà/);

  // ⑤ Không tồn tại ⇒ NOT_FOUND, không tự điền, câu hỏi KHÔNG gợi ý tên nào.
  const none = parseCustomerAddress("Thôn 3 xã Không Tồn Tại, Hà Nội");
  assert.deepEqual([none.confidence, none.province, none.ward, none.candidates], ["NOT_FOUND", "Thành phố Hà Nội", null, []]);
  assert.equal(canAutoFill(none), false);
  assert.match(addressQuestion(none)!, /phường \/ xã/);
  const nothing = parseCustomerAddress("abc xyz");
  assert.deepEqual([nothing.confidence, nothing.province, nothing.missing], ["NOT_FOUND", null, ["province", "ward"]]);
  // Tỉnh khách ghi riêng thắng; xã đọc được thuộc tỉnh khác ⇒ không dùng.
  const clash = parseCustomerAddress("123 Nguyễn Đình Chiểu, Phường Bàn Cờ", "Hà Nội");
  assert.deepEqual([clash.province, clash.ward, clash.confidence], ["Thành phố Hà Nội", null, "NOT_FOUND"]);

  // ⑥ Xã khách xác nhận: phải có trong danh mục tỉnh VÀ khách vừa nói đúng tên đó.
  assert.deepEqual(acceptCustomerWard(co, "Phường Đông Ngạc", "Đông Ngạc em ạ"), { ok: true, ward: "Phường Đông Ngạc" });
  assert.deepEqual(acceptCustomerWard(co, "đông ngạc", "dong ngac nhe em"), { ok: true, ward: "Phường Đông Ngạc" }, "không dấu");
  assert.equal(acceptCustomerWard(co, "Phường Đông Ngạc", "ok em").ok, false, "khách chưa nói ⇒ không ghi (model không chọn hộ)");
  assert.equal(acceptCustomerWard(co, "Phường Bàn Cờ", "bàn cờ").ok, false, "xã không thuộc tỉnh ⇒ từ chối");
  assert.equal(acceptCustomerWard(nothing, "Phường Đông Ngạc", "đông ngạc").ok, false, "chưa biết tỉnh ⇒ không ghi xã");

  // Phần đường: dừng ở đơn vị hành chính đầu tiên.
  assert.equal(streetPart("12 Hàng Bạc, Hoàn Kiếm, Hà Nội"), "12 Hàng Bạc");
  assert.equal(streetPart("số 5 ngõ 12 cổ nhuế hn"), "số 5 ngõ 12 cổ nhuế");

  // Kết quả cho bot: xã khách đã xác nhận ⇒ không hỏi lại; mơ hồ ⇒ ask_customer + không có số nhà trong kết quả.
  const view = addressCheckOf({ address: CO_NHUE, province: "" }).view;
  assert.equal(view.status, "AMBIGUOUS");
  assert.ok(view.ask_customer?.includes("phường Đông Ngạc") && !JSON.stringify(view).includes("242"), JSON.stringify(view));
  const confirmed = addressCheckOf({ address: CO_NHUE, province: "", ward: "Phường Đông Ngạc" }).view;
  assert.deepEqual([confirmed.status, confirmed.ward, confirmed.ask_customer], ["CUSTOMER_CONFIRMED", "Phường Đông Ngạc", null]);
  console.log("✓ Địa chỉ tự do: Cổ Nhuế 2 cũ ⇒ hỏi Thượng Cát / Đông Ngạc · f1q5 · P13 GV ⇒ HCM + 6 ứng viên · tỉnh gộp · không tồn tại ⇒ NOT_FOUND · xã chỉ ghi khi khách nói");
}

/** Cổng ở công cụ bot (khung thử TEST — không ghi gì): chốt đơn địa chỉ mơ hồ ⇒ hỏi khách trước; xã chỉ nhận khi khách nói. */
export async function testAddressNormalizeTools() {
  const recipient = { name: "Đỗ Minh Nguyệt", phone: "0912000111", address: CO_NHUE, province: "" };
  const base: ChatState = {
    customer: { id: null, name: recipient.name, phone: recipient.phone, address: CO_NHUE, province: "", simulated: true },
    draft: { orderId: null, lines: [{ variantId: "addr-test-var", quantity: 1 }], unitPrices: { "addr-test-var": 280_000 }, recipient, note: "", simulated: true, shownTurn: 4, firstShownTurn: 4 },
  };
  const ctx = (state: ChatState, last: string, turn: number) => ({ conversationId: "conv-addr", channel: "TEST" as const, config: parseSalesChatbotConfig(null), state, lastUserText: last, agent: AGENT, turn });
  const clone = (s: ChatState): ChatState => JSON.parse(JSON.stringify(s)) as ChatState;

  // Khách «Oki! Em lên đơn cho chị luôn nhé» khi chưa ai hỏi phường ⇒ CHƯA chốt, trả đúng câu hỏi.
  const gate = await executeTool("confirm_order", { customer_confirmation: "Oki! Em lên đơn cho chị luôn nhé" }, ctx(clone(base), "Oki! Em lên đơn cho chị luôn nhé", 5));
  assert.ok(gate.isError && /địa chỉ chưa chuẩn hoá/.test(gate.summary), JSON.stringify(gate));
  assert.ok(!gate.state.confirmed, "chưa chốt");
  assert.ok(gate.content.includes("phường Thượng Cát") && gate.content.includes("phường Đông Ngạc"), gate.content);
  assert.equal(gate.state.addressAsk?.turn, 5);

  // Cùng lượt gọi lại ⇒ vẫn chặn (khách chưa thấy câu hỏi).
  const again = await executeTool("confirm_order", { customer_confirmation: "Oki! Em lên đơn cho chị luôn nhé" }, ctx(clone(gate.state), "Oki! Em lên đơn cho chị luôn nhé", 5));
  assert.ok(again.isError && /địa chỉ chưa chuẩn hoá/.test(again.summary));

  // Lượt SAU khách vẫn đồng ý ⇒ cổng địa chỉ cho qua (luật chủ shop 08/10: chốt + cờ cần người kiểm, ô xã trống).
  const later = await executeTool("confirm_order", { customer_confirmation: "ok em" }, ctx(clone(gate.state), "ok em", 6)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(!/địa chỉ chưa chuẩn hoá/.test(later.summary), `đã hỏi ở lượt trước ⇒ không chặn lần nữa: ${later.summary}`);

  // Model tự điền xã khi khách chưa nói ⇒ từ chối, đơn nháp giữ nguyên.
  const guess = await executeTool("update_draft_order", { ward: "Phường Đông Ngạc" }, ctx(clone(gate.state), "ok em", 6));
  assert.ok(guess.isError && /chưa xác nhận/.test(guess.summary), JSON.stringify(guess));
  assert.equal(guess.state.draft?.recipient.ward, undefined);
  // Xã không có trong danh mục ⇒ từ chối.
  const bogus = await executeTool("update_draft_order", { ward: "Phường Cổ Nhuế 2" }, ctx(clone(gate.state), "phường Cổ Nhuế 2 em ơi", 6));
  assert.ok(bogus.isError && /không có trong danh mục/.test(bogus.content), bogus.content);
  console.log("✓ Công cụ bot: địa chỉ mơ hồ ⇒ hỏi khách trước khi chốt · lượt sau mới chốt (cờ cần kiểm) · xã chỉ nhận khi khách nói và có trong danh mục");
}

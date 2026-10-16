/**
 * ═══════════ ĐỊA CHỈ KHÁCH GÕ TỰ DO ⇒ MỨC TIN CẬY + CÂU HỎI KHÁCH (P0 address-normalize, 11/10/2026) ═══════════
 *
 * Hai ca thật production:
 *  · «SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội» (đơn #463DEBAE) — phường CŨ bị CHIA khi sáp nhập 01/07/2025
 *    ⇒ AMBIGUOUS (Thượng Cát / Đông Ngạc), hỏi khách, KHÔNG tự điền; trước đây kết quả này rơi mất và bot không hỏi gì.
 *  · «1094/3 Lê Đức Thọ P13 GV» (ca KimThu Le) — khách KHÔNG ghi tỉnh, KHÔNG ghi tên quận: «GV» là hai chữ cái. Bung «GV» ⇒
 *    quận Gò Vấp rồi suy TP HCM là hai bước đoán chồng nhau ⇒ vẫn CHƯA BIẾT TỈNH (cùng kết luận với
 *    `tests/sales-integrity-audit.test.ts` — MISSING_PROVINCE); cách đọc đó chỉ đi kèm (`provinceHint`) để câu hỏi khách hỏi ĐÚNG
 *    tỉnh. Khách ghi thêm «TP.HCM» ⇒ biết tỉnh; danh mục trước sáp nhập KHÔNG có phường 13 Gò Vấp (đã gộp 01/01/2025) ⇒ xã mơ hồ
 *    trong 6 phường mới có đất Gò Vấp ⇒ hỏi xã.
 *  · Luật: chỉ EXACT / UNIQUE_FROM_OLD được tự điền; viết tắt tên quận không bao giờ là căn cứ DUY NHẤT của tỉnh; xã chỉ ghi khi
 *    KHÁCH vừa nói tên đó.
 */
import assert from "node:assert/strict";
import data from "@/lib/address/vn-admin-2025.json";
import { acceptCustomerWard, addressQuestion, canAutoFill, parseCustomerAddress, streetPart } from "@/lib/address/customer-address";
import { HCM_DISTRICT_ABBREVIATIONS, foldVnText } from "@/lib/address/vn-address";
import { addressCheckOf, autoConfirmBlocker, executeTool, type ChatState } from "@/lib/sales-chatbot/tools";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";

const AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/tools.ts" };
const CO_NHUE = "SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội";
/** Chỉ quận CŨ, không phường — phường là phần khách CHƯA nói (6 phường mới có đất của Gò Vấp cũ). */
const GV_DISTRICT = "230 Phan Huy Ích, Quận Gò Vấp, TP Hồ Chí Minh";
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

  // ② «875/4B trần hưng đạo f1q5» — f1q5 dính liền nhưng KHÔNG ghi tỉnh: căn cứ duy nhất của TP HCM là viết tắt ⇒ chưa biết tỉnh,
  //    không tự điền, hỏi tỉnh (gợi ý quận 5 cũ ⇒ Chợ Quán đi kèm). Ghi «TP.HCM» ⇒ phường 1 quận 5 cũ gộp trọn vào Chợ Quán.
  const f1 = parseCustomerAddress("875/4B trần hưng đạo f1q5");
  assert.deepEqual([f1.confidence, f1.province, f1.ward, f1.street, f1.houseNumber, f1.missing], ["NOT_FOUND", null, null, "875/4B trần hưng đạo", "875/4B", ["province", "ward"]], JSON.stringify(f1));
  assert.deepEqual(f1.provinceHint, { province: "Thành phố Hồ Chí Minh", district: "Quận 5", abbreviation: "f1q5", wardCandidates: ["Phường Chợ Quán"] });
  assert.equal(canAutoFill(f1), false);
  assert.ok(addressQuestion(f1)!.includes("«f1q5»") && addressQuestion(f1)!.includes("quận 5"), addressQuestion(f1)!);
  const f1Hcm = parseCustomerAddress("875/4B trần hưng đạo f1q5, TP.HCM");
  assert.deepEqual([f1Hcm.confidence, f1Hcm.province, f1Hcm.ward], ["UNIQUE_FROM_OLD", "Thành phố Hồ Chí Minh", "Phường Chợ Quán"]);
  assert.equal(addressQuestion(f1Hcm), null);
  // Viết tắt LOẠI («q1», «tp») không ghi tỉnh ⇒ tên quận đọc ra chỉ là gợi ý, không phải căn cứ ghi tỉnh (review Tech Lead #802).
  const q1 = parseCustomerAddress("12 Lê Lợi q1");
  assert.deepEqual([q1.confidence, q1.province, q1.ward, q1.missing, q1.provinceHint?.province, q1.provinceHint?.district, q1.provinceHint?.abbreviation], ["NOT_FOUND", null, null, ["province", "ward"], "Thành phố Hồ Chí Minh", "Quận 1", null], JSON.stringify(q1));
  assert.match(addressQuestion(q1)!, /quận 1 cũ ở Thành phố Hồ Chí Minh phải không/);
  const vinh = parseCustomerAddress("Số 5 tp Vinh");
  assert.deepEqual([vinh.confidence, vinh.province, vinh.missing, vinh.provinceHint?.province], ["NOT_FOUND", null, ["province", "ward"], "Tỉnh Nghệ An"], JSON.stringify(vinh));
  // Gõ NGUYÊN CHỮ tên quận có loại chỉ một tỉnh có ⇒ suy tỉnh được (căn cứ là chữ khách gõ).
  assert.deepEqual([parseCustomerAddress("12 Lê Lợi quận 1").province, parseCustomerAddress("12 Lê Lợi quận 1").provinceHint], ["Thành phố Hồ Chí Minh", null]);
  assert.equal(parseCustomerAddress("12 Lê Lợi, P. Bến Nghé, Q.1, TP.HCM").ward, "Phường Sài Gòn", "P. / Q. / TP.HCM");

  // ③ Ca thật «P13 GV» KHÔNG ghi tỉnh: thiếu TỈNH là phần thiếu chính (tên quận chỉ là hai chữ cái) ⇒ không tự điền tỉnh lẫn xã,
  //    câu hỏi khách hỏi xác nhận TỈNH; cách đọc «quận Gò Vấp ⇒ 6 phường mới» đi kèm ở `provinceHint`, không vào `province`.
  const SIX = ["Phường An Hội Tây", "Phường An Hội Đông", "Phường An Nhơn", "Phường Gò Vấp", "Phường Hạnh Thông", "Phường Thông Tây Hội"];
  for (const text of [GO_VAP, "1094/3 le duc tho p13 gv"]) {
    const g = parseCustomerAddress(text);
    assert.deepEqual([g.confidence, g.province, g.provinceCode, g.ward, g.candidates], ["NOT_FOUND", null, null, null, []], `${text}: ${JSON.stringify(g)}`);
    assert.deepEqual(g.missing, ["province", "ward"], "thiếu tỉnh VÀ xã — tỉnh đứng trước");
    assert.equal(canAutoFill(g), false);
    assert.deepEqual(g.provinceHint && { ...g.provinceHint, wardCandidates: [...g.provinceHint.wardCandidates].sort() }, { province: "Thành phố Hồ Chí Minh", district: "Quận Gò Vấp", abbreviation: "GV", wardCandidates: SIX });
    assert.match(g.reason, /chưa ghi tỉnh/);
    const ask = addressQuestion(g)!;
    assert.ok(ask.includes("«GV»") && ask.includes("quận Gò Vấp") && ask.includes("Thành phố Hồ Chí Minh") && /tỉnh \/ thành phố/.test(ask), ask);
    assert.ok(!ask.includes("phường Hạnh Thông"), "chưa biết tỉnh ⇒ chưa đưa danh sách xã cho khách chọn");
    assert.ok(/^1094\/3 l/i.test(g.street) && !/p13|gv/i.test(g.street), `phần đường dừng trước phường / quận: ${g.street}`);
    assert.equal(acceptCustomerWard(g, "Phường Hạnh Thông", "hạnh thông em").ok, false, "chưa biết tỉnh ⇒ không ghi xã");
  }
  // Khách ghi tỉnh ⇒ biết tỉnh, xã mơ hồ trong 6 phường mới có đất Gò Vấp; phường 13 không có trong danh mục cũ ⇒ nói rõ, hỏi XÃ.
  const gHcm = parseCustomerAddress(`${GO_VAP}, TP.HCM`);
  assert.deepEqual([gHcm.confidence, gHcm.province, gHcm.ward, gHcm.provinceHint, gHcm.missing], ["AMBIGUOUS", "Thành phố Hồ Chí Minh", null, null, ["ward"]], JSON.stringify(gHcm));
  assert.deepEqual([...gHcm.candidates].sort(), SIX);
  assert.match(gHcm.reason, /phuong 13/, "nói rõ danh mục cũ không có phường khách ghi");
  // Đổi đặc tả theo chủ shop (P0 15/10/2026, ca «Tuyet Nguyen Thi»): KHÔNG bao giờ bắt khách chọn trong danh sách 5–6 phường — 6 ứng
  // viên vẫn nằm ở `candidates` cho người kiểm, câu hỏi khách chỉ xin ĐÚNG phần thiếu (tên phường / xã mới), không liệt kê tên nào.
  const askSix = addressQuestion(gHcm)!;
  assert.ok(!SIX.some((w) => askSix.includes(w.replace(/^Phường/, "phường"))) && /phường \/ xã/.test(askSix), askSix);
  // Phường số CÓ trong danh mục cũ ⇒ quy được KHI biết tỉnh: P5 Gò Vấp ⇒ An Nhơn. Không ghi tỉnh ⇒ vẫn hỏi tỉnh, An Nhơn chỉ là gợi ý.
  assert.equal(parseCustomerAddress("12 Nguyễn Văn Nghi P5 GV, HCM").ward, "Phường An Nhơn");
  const p5 = parseCustomerAddress("12 Nguyễn Văn Nghi P5 GV");
  assert.deepEqual([p5.confidence, p5.province, p5.ward, p5.provinceHint?.wardCandidates], ["NOT_FOUND", null, null, ["Phường An Nhơn"]], JSON.stringify(p5));
  // Tên quận khách VIẾT RA (không phải viết tắt) chỉ có ở một tỉnh ⇒ suy tỉnh được (căn cứ là chữ khách gõ, không phải hai chữ cái).
  assert.deepEqual([parseCustomerAddress("12 Nguyễn Văn Nghi phường 5 quận Gò Vấp").ward, parseCustomerAddress("12 Nguyễn Văn Nghi phường 5 quận Gò Vấp").provinceHint], ["Phường An Nhơn", null]);
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
  // ĐỔI LUẬT CHỦ SHOP (P0 16/10/2026, #855 — thay luật 11/10 «hỏi khách» của đơn #463DEBAE): khách ĐÃ ghi đủ phường cũ + quận cũ mà
  // phường cũ bị CHIA ⇒ KHÔNG bắt khách tự quy đổi địa giới — không ask_customer, ứng viên vẫn nằm trong kết quả cho nhân viên chọn.
  const view = addressCheckOf({ address: CO_NHUE, province: "" }).view;
  assert.equal(view.status, "AMBIGUOUS");
  assert.equal(view.ask_customer, null, JSON.stringify(view));
  assert.ok(view.candidates.includes("Phường Đông Ngạc") && /việc của SHOP/.test(view.note) && !JSON.stringify(view).includes("242"), JSON.stringify(view));
  // Chỉ có quận cũ (khách CHƯA nói phường) ⇒ phường là phần THIẾU thật ⇒ vẫn hỏi đúng một câu chung.
  assert.match(addressCheckOf({ address: GV_DISTRICT, province: "" }).view.ask_customer ?? "", /tên phường \/ xã \(theo địa giới mới\)/);
  const confirmed = addressCheckOf({ address: CO_NHUE, province: "", ward: "Phường Đông Ngạc" }).view;
  assert.deepEqual([confirmed.status, confirmed.ward, confirmed.ask_customer], ["CUSTOMER_CONFIRMED", "Phường Đông Ngạc", null]);
  console.log("✓ Địa chỉ tự do: Cổ Nhuế 2 cũ ⇒ KHÔNG hỏi khách quy đổi, ứng viên Thượng Cát / Đông Ngạc cho nhân viên · f1q5 · P13 GV không tỉnh ⇒ hỏi TỈNH (gợi ý Gò Vấp) · có tỉnh ⇒ 6 ứng viên · tỉnh gộp · không tồn tại ⇒ NOT_FOUND · xã chỉ ghi khi khách nói");
}

/** Cổng ở công cụ bot (khung thử TEST — không ghi gì): chốt đơn địa chỉ mơ hồ ⇒ hỏi khách trước; xã chỉ nhận khi khách nói. */
export async function testAddressNormalizeTools() {
  // Cổng hỏi địa chỉ dựng trên địa chỉ CHỈ CÓ QUẬN CŨ (phường là phần thiếu thật). Phường cũ bị chia (Cổ Nhuế 2) KHÔNG còn hỏi khách —
  // ĐỔI LUẬT CHỦ SHOP 16/10/2026 (#855), khẳng định ngay dưới.
  const recipient = { name: "Đỗ Minh Nguyệt", phone: "0912000111", address: GV_DISTRICT, province: "" };
  const base: ChatState = {
    customer: { id: null, name: recipient.name, phone: recipient.phone, address: GV_DISTRICT, province: "", simulated: true },
    draft: { orderId: null, lines: [{ variantId: "addr-test-var", quantity: 1 }], unitPrices: { "addr-test-var": 280_000 }, recipient, note: "", simulated: true, shownTurn: 4, firstShownTurn: 4 },
  };
  const ctx = (state: ChatState, last: string, turn: number) => ({ conversationId: "conv-addr", channel: "TEST" as const, config: parseSalesChatbotConfig(null), state, lastUserText: last, agent: AGENT, turn });
  const clone = (s: ChatState): ChatState => JSON.parse(JSON.stringify(s)) as ChatState;

  // Phường CŨ bị chia (Cổ Nhuế 2 — khách đã ghi đủ phường + quận cũ): cổng địa chỉ KHÔNG hỏi khách quy đổi (#855) — chốt đi tiếp, đơn mang cờ
  // cần kiểm địa chỉ, tuyến giao giữ NO_WARD tới khi nhân viên chọn phường.
  const coNhue: ChatState = { ...clone(base), customer: { ...clone(base).customer!, address: CO_NHUE }, draft: { ...clone(base).draft!, recipient: { ...recipient, address: CO_NHUE } } };
  const split = await executeTool("confirm_order", { customer_confirmation: "Oki! Em lên đơn cho chị luôn nhé" }, ctx(coNhue, "Oki! Em lên đơn cho chị luôn nhé", 5)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(!/địa chỉ chưa chuẩn hoá/.test(split.summary) && !/cũ nay thuộc/.test(split.content), `phường cũ bị chia ⇒ không hỏi khách: ${split.summary}`);

  // Khách «Oki! Em lên đơn cho chị luôn nhé» khi chưa ai hỏi phường ⇒ CHƯA chốt, trả đúng câu hỏi.
  const gate = await executeTool("confirm_order", { customer_confirmation: "Oki! Em lên đơn cho chị luôn nhé" }, ctx(clone(base), "Oki! Em lên đơn cho chị luôn nhé", 5));
  assert.ok(gate.isError && /địa chỉ chưa chuẩn hoá/.test(gate.summary), JSON.stringify(gate));
  assert.ok(!gate.state.confirmed, "chưa chốt");
  assert.ok(gate.content.includes("tên phường / xã (theo địa giới mới)"), gate.content);
  assert.equal(gate.state.addressAsk?.turn, 5);

  // Cùng lượt gọi lại ⇒ vẫn chặn (khách chưa thấy câu hỏi).
  const again = await executeTool("confirm_order", { customer_confirmation: "Oki! Em lên đơn cho chị luôn nhé" }, ctx(clone(gate.state), "Oki! Em lên đơn cho chị luôn nhé", 5));
  assert.ok(again.isError && /địa chỉ chưa chuẩn hoá/.test(again.summary));

  // Lượt SAU khách vẫn đồng ý ⇒ cổng địa chỉ cho qua (luật chủ shop 08/10: chốt + cờ cần người kiểm, ô xã trống).
  const later = await executeTool("confirm_order", { customer_confirmation: "ok em" }, ctx(clone(gate.state), "ok em", 6)).catch((e: unknown) => ({ isError: true, summary: `ném: ${String(e)}`, content: "", state: {} as ChatState }));
  assert.ok(!/địa chỉ chưa chuẩn hoá/.test(later.summary), `đã hỏi ở lượt trước ⇒ không chặn lần nữa: ${later.summary}`);

  // Model tự điền xã khi khách chưa nói ⇒ từ chối, đơn nháp giữ nguyên.
  const guess = await executeTool("update_draft_order", { ward: "Phường An Nhơn" }, ctx(clone(gate.state), "ok em", 6));
  assert.ok(guess.isError && /chưa xác nhận/.test(guess.summary), JSON.stringify(guess));
  assert.equal(guess.state.draft?.recipient.ward, undefined);
  // Xã không có trong danh mục ⇒ từ chối.
  const bogus = await executeTool("update_draft_order", { ward: "Phường Cổ Nhuế 2" }, ctx(clone(gate.state), "phường Cổ Nhuế 2 em ơi", 6));
  assert.ok(bogus.isError && /không có trong danh mục/.test(bogus.content), bogus.content);

  // Tự chốt của máy chủ (P0-A, main): biết tỉnh mà xã mơ hồ KHÔNG chặn — đơn tự chốt kèm cờ cần kiểm (tests/sales-quote-integrity
  // «qi-tu-chot-can-kiem»). Chưa biết tỉnh («P13 GV» không ghi tỉnh) thì CÓ chặn: cổng «thiếu tỉnh» không bị viết tắt vượt qua.
  const ac: ChatState = { ...clone(base), draft: { ...clone(base).draft!, quote: { id: "q-addr", priceVersion: "pv-addr", subtotal: 280_000, total: 280_000 } } };
  assert.equal(autoConfirmBlocker(ac, { lastUserText: "ok em", turn: 5 }), null, "xã mơ hồ, biết tỉnh ⇒ tự chốt kèm cờ (luật P0-A)");
  const acGv: ChatState = { ...ac, draft: { ...ac.draft!, recipient: { ...recipient, address: GO_VAP } } };
  assert.match(autoConfirmBlocker(acGv, { lastUserText: "ok em", turn: 5 }) ?? "", /tỉnh \/ thành/, "«P13 GV» không tỉnh ⇒ chưa tự chốt");
  // Viết tắt loại / dính liền không ghi tỉnh cũng KHÔNG vượt cổng thiếu tỉnh của tự chốt (review Tech Lead #802: «12 Lê Lợi q1»).
  for (const address of ["12 Lê Lợi q1", "Số 5 tp Vinh", "875/4B trần hưng đạo f1q5"]) {
    const st: ChatState = { ...ac, draft: { ...ac.draft!, recipient: { ...recipient, address } } };
    assert.match(autoConfirmBlocker(st, { lastUserText: "ok em", turn: 5 }) ?? "", /tỉnh \/ thành/, `${address}: chưa biết tỉnh ⇒ chưa tự chốt`);
  }
  assert.equal(autoConfirmBlocker({ ...ac, draft: { ...ac.draft!, recipient: { ...recipient, address: "12 Lê Lợi, Quận 1" } } }, { lastUserText: "ok em", turn: 5 }), null, "gõ nguyên «Quận 1» ⇒ biết tỉnh");

  // Ca KimThu Le «P13 GV» không ghi tỉnh: cổng chốt hỏi TỈNH (xác nhận cách đọc «GV» = quận Gò Vấp, TP HCM), không đưa danh sách phường.
  const gvRecipient = { ...recipient, address: GO_VAP };
  const gv: ChatState = { ...clone(base), customer: { ...clone(base).customer!, address: GO_VAP }, draft: { ...clone(base).draft!, recipient: gvRecipient } };
  assert.deepEqual([addressCheckOf(gvRecipient).view.status, addressCheckOf(gvRecipient).view.province, addressCheckOf(gvRecipient).view.missing], ["NOT_FOUND", null, ["province", "ward"]]);
  const gvGate = await executeTool("confirm_order", { customer_confirmation: "ok em" }, ctx(gv, "ok em", 5));
  assert.ok(gvGate.isError && gvGate.content.includes("TỈNH") && gvGate.content.includes("«GV»") && gvGate.content.includes("quận Gò Vấp") && !gvGate.content.includes("phường Hạnh Thông"), gvGate.content);
  assert.ok(!gvGate.state.confirmed);
  const gvWard = await executeTool("update_draft_order", { ward: "Phường Hạnh Thông" }, ctx(clone(gvGate.state), "phường Hạnh Thông em", 6));
  assert.ok(gvWard.isError && /tỉnh \/ thành/.test(gvWard.content), `chưa biết tỉnh ⇒ không nhận xã: ${gvWard.content}`);
  console.log("✓ Công cụ bot: địa chỉ mơ hồ ⇒ hỏi khách trước khi chốt · lượt sau mới chốt (cờ cần kiểm) · xã chỉ nhận khi khách nói và có trong danh mục · tự chốt cùng cổng · «P13 GV» không tỉnh ⇒ hỏi TỈNH");
}

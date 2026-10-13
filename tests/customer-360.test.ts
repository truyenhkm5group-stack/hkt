/**
 * CUSTOMER 360 — NHẬN DIỆN KHÁCH CŨ & DÙNG LẠI LỊCH SỬ ĐƠN (11/10/2026, ca «Nga Ho Thien»).
 *
 * Phần thuần: luật «địa chỉ đã xác minh» (đơn hoàn / huỷ / chưa xác nhận / chưa chuẩn hoá KHÔNG BAO GIỜ được đề xuất), nối khách
 * mạnh → yếu (đơn của chính hội thoại > mã Facebook > SĐT), SĐT trùng nhiều người ⇒ không chọn, khách cũ / mới / CHƯA BIẾT, ý định
 * «vẫn địa chỉ cũ» · «đổi số» · «gửi chỗ khác», khối lời nhắc TRA LỊCH SỬ (một · nhiều · không có · đã thanh toán), thước đo.
 * Phần PGlite (đồng hồ thật — AGENTS.md mục 50): chạy `chatTurn` thật với model giả trên tổ chức thử, gieo đơn cũ mang mã hội thoại
 * Pancake, kiểm lời nhắc + kết quả máy chủ + tổ chức khác không lọt. Dữ liệu GIẢ (kho PUBLIC).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  addressConfidence,
  assembleCustomer360,
  botContactFacts,
  customer360Prompt,
  historyAddressWithoutConsent,
  loadCustomer360,
  measureReturningMetrics,
  NO_REUSE_INTENT,
  phonesInText,
  preferReturning,
  returningFrom360,
  returningMetrics,
  returningMetricsSentence,
  reuseIntentOf,
  RETURNING_MIN_SAMPLE,
  savedAddressChoice,
  savedAddressPhone,
  type OrderFact,
  type ReturningConversationFact,
} from "@/lib/sales-chatbot/customer-360";
import { pancakeRecentOrderOf, parsePancakeThreadProfile, returningCustomerPrompt, type ReturningCustomer } from "@/lib/sales-chatbot/returning";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { keyPaths, looksLikeAddress, maskProbeKey, monthOf, parseProbeArgs } from "../scripts/customer-360-probe";
import { GOLDEN_CASES, RETURNING_THREAD, seedReturningThread } from "./sales-agent-golden/cases";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenTranscript } from "./sales-agent-golden/harness";

const A1 = { address: "Số 1 ngõ 1", ward: "Phường Cầu Giấy", province: "Thành phố Hà Nội" };
const A2 = { address: "Số 99 phố Huế", ward: "Phường Hoàn Kiếm", province: "Thành phố Hà Nội" };

const F = (o: Partial<OrderFact> & { orderId: string }): OrderFact => ({
  source: "ERP",
  at: "2026-01-10T03:00:00.000Z",
  stage: "SHIPPED",
  outcome: null,
  link: "THREAD",
  customerId: null,
  name: "Chị Thử",
  phone: "0900000111",
  ...A1,
  items: [],
  paid: false,
  currentCycle: false,
  ...o,
});
const S = (x: Record<string, unknown> = {}) => x as ChatState;
const build = (facts: OrderFact[], state: ChatState = S(), extra: { threadBound?: boolean; phoneCustomerIds?: string[] } = {}) =>
  assembleCustomer360({ conversationId: "hoi-thoai-thu", state, threadBound: extra.threadBound ?? true, facts, phoneCustomerIds: extra.phoneCustomerIds ?? [] });
const REUSE = reuseIntentOf(["Vẫn địa chỉ cũ"]);

function testAddressRule() {
  const c = (o: Partial<OrderFact>) => addressConfidence(F({ orderId: "x", ...o }));
  assert.equal(c({ outcome: "DELIVERED", stage: "DELIVERED" }), "DELIVERED", "đơn ERP giao thành công theo ORDER_OUTCOME");
  assert.equal(c({ outcome: "RETURNED" }), null, "đơn HOÀN ⇒ địa chỉ không bao giờ là «đã xác minh»");
  assert.equal(c({ outcome: "RETURNED_BY_RULE" }), null, "hoàn theo luật tiền cũng là hoàn");
  assert.equal(c({ outcome: "CANCELLED" }), null, "đơn huỷ");
  assert.equal(c({ stage: "RETURNED" }), null, "khâu hoàn (chưa có kết quả)");
  assert.equal(c({ stage: "CANCELLED" }), null);
  assert.equal(c({ stage: "NEW" }), null, "đơn nháp / chưa xác nhận");
  assert.equal(c({ stage: "WAITING" }), null);
  assert.equal(c({}), "CONFIRMED_NORMALIZED", "đã xác nhận + có xã + tỉnh");
  assert.equal(c({ ward: "", province: "", address: "12 Hàng Bạc, phường Hoàn Kiếm, Hà Nội" }), "CONFIRMED_NORMALIZED", "dòng địa chỉ chuẩn hoá ra MỘT đáp án");
  assert.equal(c({ ward: "", province: "", address: "1094/3 Lê Đức Thọ P13 GV" }), null, "địa chỉ chưa ghép được tỉnh / xã ⇒ không đề xuất");
  assert.equal(c({ address: "  " }), null);
  assert.equal(c({ source: "PANCAKE", stage: "DELIVERED", outcome: null }), "CONFIRMED_NORMALIZED", "trạng thái Pancake KHÔNG BAO GIỜ là bằng chứng giao (AGENTS 3.2)");
  assert.equal(c({ stage: "DELIVERED", outcome: "RETURNED" }), null, "khâu «Đã nhận» mà ORDER_OUTCOME nói HOÀN ⇒ ORDER_OUTCOME thắng");
  assert.equal(c({ stage: "DELIVERED", outcome: "RETURNED_BY_RULE" }), null, "giao 50K–100K = không thành công ⇒ không đề xuất");
  assert.equal(c({ stage: "DELIVERED", outcome: "UNKNOWN" }), "CONFIRMED_NORMALIZED", "ORDER_OUTCOME chưa biết ⇒ không nâng lên «đã giao thành công»");
  assert.equal(c({ stage: "DELIVERED", outcome: "IN_TRANSIT" }), "CONFIRMED_NORMALIZED");
}

function testAssemble() {
  const one = build([F({ orderId: "o1", items: ["Chả cá thu (1kg) × 2"] })]);
  assert.equal(one.suggestion, "ONE");
  assert.equal(one.identity.match, "THREAD");
  assert.equal(one.buyer, "REPEAT");
  assert.equal(one.masked, false);
  assert.deepEqual(one.history, { orders: 1, delivered: 0, returned: 0, cancelled: 0, open: 1 });
  assert.deepEqual(one.topProducts, [{ name: "Chả cá thu (1kg)", count: 1 }]);

  const many = build([F({ orderId: "o1", at: "2026-01-01T00:00:00.000Z" }), F({ orderId: "o2", at: "2026-02-01T00:00:00.000Z", ...A2 })]);
  assert.equal(many.suggestion, "MANY");
  assert.deepEqual(many.addresses.map((a) => a.orderId), ["o2", "o1"], "mới nhất trước");
  assert.equal(build([F({ orderId: "o1" }), F({ orderId: "o2", at: "2026-02-01T00:00:00.000Z" })]).suggestion, "ONE", "cùng địa chỉ + SĐT ⇒ gộp");

  const returned = build([F({ orderId: "r1", stage: "RETURNED", outcome: "RETURNED" })]);
  assert.equal(returned.suggestion, "NONE");
  assert.equal(returned.noAddressReason, "ONLY_UNVERIFIED");
  assert.equal(returned.buyer, "REPEAT", "khách cũ có đơn hoàn VẪN là khách cũ — chỉ địa chỉ không được dùng");
  assert.equal(returned.history?.returned, 1);
  const mixed = build([F({ orderId: "ok", at: "2026-01-01T00:00:00.000Z", outcome: "DELIVERED", stage: "DELIVERED" }), F({ orderId: "hoan", at: "2026-03-01T00:00:00.000Z", outcome: "RETURNED", ...A2 })]);
  assert.deepEqual(mixed.addresses.map((a) => [a.orderId, a.confidence]), [["ok", "DELIVERED"]], "đơn hoàn MỚI hơn không đè địa chỉ đã giao thành công");

  const phone = build([F({ orderId: "p1", link: "PHONE", customerId: "c1" })], S(), { threadBound: false });
  assert.equal(phone.masked, true, "nối qua SĐT ⇒ che địa chỉ");
  assert.equal(phone.suggestion, "ONE");
  const amb = build([F({ orderId: "p1", link: "PHONE", customerId: "c1" }), F({ orderId: "p2", link: "PHONE", customerId: "c2", ...A2 })], S(), { threadBound: false });
  assert.equal(amb.suggestion, "AMBIGUOUS", "SĐT trùng hai người, hai địa chỉ ⇒ không chọn bừa");
  assert.deepEqual(amb.addresses, [], "và không liệt kê địa chỉ của người khác");
  assert.equal(amb.buyer, "UNKNOWN");
  assert.equal(amb.identity.match, "AMBIGUOUS");
  assert.equal(build([F({ orderId: "p1", link: "PHONE", customerId: "c1" }), F({ orderId: "p2", link: "PHONE", customerId: "c2" })]).suggestion, "ONE", "hai hồ sơ cùng MỘT địa chỉ ⇒ không mơ hồ");
  const threadWins = build([F({ orderId: "t1" }), F({ orderId: "p1", link: "PHONE", customerId: "c9", ...A2 }), F({ orderId: "p2", link: "PHONE", customerId: "c8", address: "Số 3 ngõ 3" })]);
  assert.deepEqual([threadWins.suggestion, threadWins.identity.match, threadWins.addresses[0].orderId], ["ONE", "THREAD", "t1"], "đơn của chính hội thoại thắng SĐT");

  const cur = build([F({ orderId: "nhap", currentCycle: true })]);
  assert.equal(cur.suggestion, "NONE", "đơn của lượt đang mua không phải «lần trước»");
  assert.equal(cur.buyer, "UNKNOWN");
  const noOrders = { fetchedAt: "", phones: [], fbIds: [], prior: [] };
  assert.equal(build([], S({ returning: { ...noOrders, recentOrders: [] } })).buyer, "NEW", "Pancake NÓI không có đơn ⇒ khách mới");
  assert.equal(build([], S({ returning: noOrders })).buyer, "UNKNOWN", "Pancake chưa nói ⇒ CHƯA BIẾT, không phải khách mới (8.5)");
  assert.equal(build([], S()).buyer, "UNKNOWN");
  assert.equal(build([F({ orderId: "pk", source: "PANCAKE", at: null })]).suggestion, "NONE", "đơn Pancake không mốc ⇒ không biết có phải «lần trước»");
  const pkBack = build([F({ orderId: "ok" }), F({ orderId: "pk-hoan", source: "PANCAKE", stage: "RETURNED", ...A2 }), F({ orderId: "pk-huy", source: "PANCAKE", stage: "CANCELLED", address: "Số 5 ngõ huỷ" })]);
  assert.deepEqual(pkBack.history, { orders: 3, delivered: 0, returned: 1, cancelled: 1, open: 1 }, "đơn Pancake khâu hoàn / huỷ không đếm là đang mở");
  assert.equal(returningFrom360(pkBack)?.orders, 1, "«Đã mua N đơn» chỉ đếm đơn không huỷ / hoàn");

  const paidState = S({ draft: { orderId: "d1", lines: [], unitPrices: {}, recipient: { name: "", phone: "", address: "", province: "" }, note: "", simulated: false }, customer: { id: null, name: "Chị Thử", phone: "0900000111", address: "Số 1 ngõ 1", province: "", simulated: false } });
  const paid = build([F({ orderId: "d1", currentCycle: true, paid: true })], paidState);
  assert.deepEqual(paid.currentOrder, { orderId: "d1", paid: true, hasContact: true });
  assert.equal(paid.contactKnown, true);
  assert.equal(build([F({ orderId: "o1", phone: "0900000222" })], paidState).previousPhones.join(), "0900000222", "SĐT trước khác SĐT hiện tại");
}

function testIntent() {
  const cases: [string[], string | null, string | null][] = [
    [["Cho 0.5 kh nhé", "Vẫn địa chỉ cũ"], "REUSE", null],
    [["van dia chi cu nha"], "REUSE", null],
    [["như lần trước nhé"], "REUSE", null],
    [["địa chỉ ở trên em"], "REUSE", null],
    [["vẫn số cũ"], null, "REUSE"],
    [["gửi địa chỉ khác nhé"], "DECLINE", null],
    [["Vẫn địa chỉ cũ", "à thôi gửi chỗ khác"], "DECLINE", null],
    [["gửi chỗ khác", "thôi vẫn địa chỉ cũ"], "REUSE", null],
    [["vẫn địa chỉ cũ nhưng số mới 0912345678"], "REUSE", "DECLINE"],
    [["Cho 0.5 kh nhé"], null, null],
    [["chả cá thu bao nhiêu"], null, null],
  ];
  for (const [texts, address, phone] of cases) assert.deepEqual(reuseIntentOf(texts), { address, phone }, JSON.stringify(texts));
}

function testPrompt() {
  assert.equal(customer360Prompt(build([F({ orderId: "o1" })]), NO_REUSE_INTENT), "", "không nói gì về thông tin cũ ⇒ không có khối (lời nhắc giữ nguyên)");
  const one = customer360Prompt(build([F({ orderId: "o1" })]), REUSE);
  assert.ok(/TRA LỊCH SỬ/.test(one) && /KHÔNG xin lại địa chỉ/.test(one) && /như đơn trước được không ạ/.test(one) && one.includes("Số 1 ngõ 1") && /đuôi 0111/.test(one), one);
  assert.ok(/CHỈ là GỢI Ý/.test(one) && /use_saved_address = true/.test(one), "chỉ gợi ý — ghi vào đơn SAU khi khách xác nhận (3.12)");
  assert.ok(/chỉ bán kèm ⇒ nói chính sách \+ phương án hợp lệ/.test(one) && /mời thêm món KHÔNG thay nhu cầu chính/.test(one), "0,5kg: trả lời số lượng trước, upsell không thay nhu cầu chính");
  const masked = customer360Prompt(build([F({ orderId: "p1", link: "PHONE", customerId: "c1" })], S(), { threadBound: false }), REUSE);
  assert.ok(/ĐÃ CHE/.test(masked) && !masked.includes("Số 1 ngõ 1") && masked.includes("Phường Cầu Giấy"), masked);
  const many = customer360Prompt(build([F({ orderId: "o1" }), F({ orderId: "o2", ...A2 })]), REUSE);
  assert.ok(/1\) «/.test(many) && /2\) «/.test(many) && /saved_address_choice/.test(many) && /KHÔNG xin lại từ đầu/.test(many), many);
  const none = customer360Prompt(build([F({ orderId: "r1", outcome: "RETURNED" })], S({ returning: { fetchedAt: "", phones: ["0900000999"], fbIds: [], prior: [] } })), REUSE);
  assert.ok(/CHƯA tìm thấy địa chỉ cũ/.test(none) && /đơn hoàn/.test(none) && /đuôi 0999/.test(none) && /không xin số mới/.test(none) && !none.includes("Số 1 ngõ 1"), none);
  assert.ok(/KHÔNG nói như thể khách chưa từng mua/.test(none));
  assert.ok(/CHỈ xin địa chỉ nhận \+ SĐT/.test(customer360Prompt(build([]), REUSE)), "không có SĐT nào ⇒ xin cả hai, chỉ phần thiếu");
  const amb = customer360Prompt(build([F({ orderId: "p1", link: "PHONE", customerId: "c1" }), F({ orderId: "p2", link: "PHONE", customerId: "c2", ...A2 })], S(), { threadBound: false }), REUSE);
  assert.ok(/KHÔNG chọn hộ/.test(amb) && !amb.includes("Cầu Giấy") && !amb.includes("Hoàn Kiếm"), amb);
  const decline = customer360Prompt(build([F({ orderId: "o1" })]), reuseIntentOf(["không, gửi địa chỉ khác nhé"]));
  assert.ok(/KHÔNG dùng lại địa chỉ cũ/.test(decline) && !decline.includes("Số 1 ngõ 1"), decline);
  const newPhone = customer360Prompt(build([F({ orderId: "o1" })]), reuseIntentOf(["vẫn địa chỉ cũ nhưng số mới 0912345678"]));
  assert.ok(/ĐỔI SĐT/.test(newPhone) && /phone = SĐT mới/.test(newPhone), newPhone);
  const newPhoneMasked = customer360Prompt(build([F({ orderId: "p1", link: "PHONE", customerId: "c1" })], S(), { threadBound: false }), reuseIntentOf(["vẫn địa chỉ cũ nhưng số mới 0912345678"]));
  assert.ok(/không dùng được/.test(newPhoneMasked), "nối bằng SĐT mà đổi số ⇒ mất căn cứ dùng địa chỉ che");
  const paidState = S({ confirmed: { orderId: "d1", simulated: false, total: 1, at: "" }, customer: { id: null, name: "Chị Thử", phone: "0900000111", address: "Số 1 ngõ 1", province: "", simulated: false } });
  const paid = customer360Prompt(build([F({ orderId: "d1", currentCycle: true, paid: true })], paidState), NO_REUSE_INTENT);
  assert.ok(/ĐÃ THANH TOÁN/.test(paid) && /KHÔNG hỏi lại/.test(paid), "đã thanh toán ⇒ không hỏi lại thông tin");
  assert.equal(customer360Prompt(build([F({ orderId: "o1" })], S({ customer: paidState.customer })), REUSE), "", "lượt này đã có thông tin nhận ⇒ «như cũ» lần nữa không làm bot hỏi lại");
  assert.ok(/CHƯA tra được/.test(customer360Prompt(null, REUSE)) && /KHÔNG khẳng định khách chưa từng mua/.test(customer360Prompt(null, REUSE)));
  assert.ok(/shop có SĐT đuôi 0111/.test(customer360Prompt(build([F({ orderId: "o1" })]), reuseIntentOf(["vẫn số cũ nhé"]))));
}

function testBridges() {
  const one = build([F({ orderId: "o1" })]);
  const r = returningFrom360(one);
  assert.ok(r && r.trust === "THREAD" && r.address === "Số 1 ngõ 1, Phường Cầu Giấy" && r.province === "Thành phố Hà Nội" && r.phone === "0900000111" && r.repeat === true, JSON.stringify(r));
  assert.equal(returningFrom360(build([F({ orderId: "p1", link: "PHONE" })], S(), { threadBound: false }))?.trust, "PHONE", "nối SĐT giữ mức PHONE (che + savedAddress)");
  const many = build([F({ orderId: "o1", at: "2026-01-01T00:00:00.000Z" }), F({ orderId: "o2", at: "2026-02-01T00:00:00.000Z", ...A2 })]);
  assert.equal(returningFrom360(many), null, "nhiều địa chỉ ⇒ không tự chọn");
  assert.equal(savedAddressChoice(many, 2)?.address, "Số 1 ngõ 1, Phường Cầu Giấy");
  assert.equal(savedAddressChoice(many, 3), null);
  assert.equal(savedAddressChoice(many, "2"), null);
  assert.equal(savedAddressChoice(one, 1), null, "chỉ dùng khi danh sách NHIỀU địa chỉ");
  const base = (trust: ReturningCustomer["trust"]): ReturningCustomer => ({ trust, customerId: null, name: "x", phone: "0900000333", address: "khác", province: "", orders: 1, lastOrderAt: null, lastItems: [] });
  assert.equal(preferReturning(base("PHONE"), one)?.trust, "THREAD", "đơn của chính hội thoại thắng hồ sơ khớp SĐT");
  assert.equal(preferReturning(base("THREAD"), one)?.address, "khác", "khách vừa khai trong hội thoại thắng");
  assert.equal(preferReturning(base("FB_ID"), one)?.trust, "FB_ID");
  assert.equal(preferReturning(null, one)?.trust, "THREAD");
  assert.equal(preferReturning(null, null), null);
}

function testPhoneChange() {
  assert.deepEqual(phonesInText("2 hộp 500g, 0912345678"), ["0912345678"], "chỉ cụm SĐT, không gộp chữ số rời rạc");
  assert.ok(!phonesInText("2 hộp 500g, 0912345678").includes("0091234567"));
  assert.deepEqual(phonesInText("số mới +84 912 345 678 nhé"), ["0912345678"]);
  assert.ok(phonesInText("nhà số 12 0912.345.678").includes("0912345678"), "số nhà đứng sát không làm hỏng cụm SĐT");
  const thread = { trust: "THREAD" as const, phone: "0900000123" };
  assert.deepEqual(savedAddressPhone(thread, undefined, "vẫn địa chỉ cũ"), { phone: "0900000123" }, "không có số mới ⇒ số cũ");
  assert.deepEqual(savedAddressPhone(thread, "+84 900 000 123", "vẫn địa chỉ cũ"), { phone: "0900000123" }, "trùng số cũ (khác cách viết) ⇒ số cũ");
  assert.deepEqual(savedAddressPhone(thread, "0912345678", "số mới +84 912 345 678 nhé"), { phone: "0912345678" }, "khách gõ +84 …, model gõ 0… ⇒ khớp");
  assert.deepEqual(savedAddressPhone(thread, "0912 345 678", "vẫn địa chỉ cũ nhưng số mới 0912345678"), { phone: "0912345678" });
  assert.ok("error" in savedAddressPhone(thread, "0091234567", "2 hộp 500g, 0912345678"), "số cắt ngang ⇒ không khớp ⇒ hỏi lại");
  assert.ok("error" in savedAddressPhone(thread, "0987654321", "vẫn địa chỉ cũ nhé"), "số không có trong câu khách ⇒ hỏi lại, KHÔNG lùi về số cũ");
  assert.ok("error" in savedAddressPhone(thread, "12345", "số 12345"), "số không hợp lệ ⇒ hỏi lại");
  assert.ok("error" in savedAddressPhone({ trust: "PHONE", phone: "0900000123" }, "0912345678", "số mới 0912345678"), "nối bằng SĐT mà đổi số ⇒ không dùng địa chỉ che, hỏi lại");
}

function testHistoryPrompt() {
  // Hồ sơ dựng từ ĐƠN CŨ ⇒ khối KHÁCH CŨ của main chỉ GỢI Ý, đường ghi là use_saved_address + lời xác nhận (AGENTS 3.12).
  const fromHistory = returningFrom360(build([F({ orderId: "o1" })]));
  assert.ok(fromHistory?.fromHistory === true);
  const hist = returningCustomerPrompt(fromHistory, undefined);
  assert.ok(/CHỈ GỢI Ý/.test(hist) && /use_saved_address = true/.test(hist) && /KHÔNG tự gõ địa chỉ này/.test(hist), hist);
  assert.ok(!hist.includes("hoặc trả lời tiếp về món ⇒ create_customer bằng ĐÚNG thông tin trên"), "hồ sơ từ lịch sử không còn đường «trả lời tiếp về món ⇒ create_customer»");
  const typedHere: ReturningCustomer = { ...fromHistory!, fromHistory: undefined };
  assert.ok(returningCustomerPrompt(typedHere, undefined).includes("hoặc trả lời tiếp về món ⇒ create_customer bằng ĐÚNG thông tin trên"), "hồ sơ khách tự khai giữ nguyên hành vi main");
  assert.equal(historyAddressWithoutConsent(fromHistory, "Số 1 ngõ 1, Phường Cầu Giấy", "cho chị 1 gói"), true, "gõ lại địa chỉ đơn cũ khi khách chưa xác nhận ⇒ chặn");
  assert.equal(historyAddressWithoutConsent(fromHistory, "Số 1 ngõ 1", "giao về Số 1 ngõ 1 nhé"), false, "khách tự gõ địa chỉ ⇒ được");
  assert.equal(historyAddressWithoutConsent(fromHistory, "Số 77 phố Mới", "cho chị 1 gói"), false, "địa chỉ khác ⇒ không liên quan");
  assert.equal(historyAddressWithoutConsent(typedHere, "Số 1 ngõ 1, Phường Cầu Giấy", "cho chị 1 gói"), false, "không phải hồ sơ từ lịch sử ⇒ không chặn");
}

function testMetrics() {
  assert.deepEqual(botContactFacts(["Dạ chị cho em xin địa chỉ nhận hàng ạ"]), { askedContact: 1, offeredOldFirst: false });
  assert.deepEqual(botContactFacts(["Dạ em gửi về địa chỉ cũ như lần trước nhé", "Chị cho em xin SĐT ạ"]), { askedContact: 1, offeredOldFirst: true });
  assert.deepEqual(botContactFacts(["Dạ chả cá thu 280.000 ₫ ạ"]), { askedContact: 0, offeredOldFirst: false });
  const f = (priorOrder: boolean | null, askedContact = 0, offeredOldFirst = false, converted = false): ReturningConversationFact => ({ priorOrder, askedContact, offeredOldFirst, converted });
  const small = returningMetrics([f(true, 1), f(true), f(null), f(false, 2)]);
  assert.deepEqual([small.returning, small.unknown, small.recognized, small.recognitionRate, small.reAskedCustomers, small.reAskedMessages], [2, 1, 1, null, 1, 1], "mẫu < 10 ⇒ tỷ lệ null; khách mới bị hỏi không tính là khách cũ bị hỏi lại");
  const big = returningMetrics([...Array.from({ length: 6 }, () => f(true, 1, false, true)), ...Array.from({ length: 4 }, () => f(true, 0, true))]);
  assert.equal(RETURNING_MIN_SAMPLE, 10);
  assert.deepEqual([big.recognitionRate, big.repeatConversion, big.reAskedCustomers], [0.4, 0.6, 6]);
  assert.match(returningMetricsSentence(big), /40% .* mua lại 6 = 60% .* bị hỏi lại SĐT\/địa chỉ 6/);
  assert.match(returningMetricsSentence(small), /— \(mẫu < 10\)/);
}

function testPancakeParse() {
  const pos = { id: "990001", status: 3, inserted_at: "2025-03-10T02:00:00", shipping_address: { full_name: "Chị Bé", phone_number: "+84900000222", address: "Số 9 ngõ 9", province_name: "Thành phố Hà Nội", commune_name: "Phường Cầu Giấy" }, prepaid: 0, transfer_money: 280000, items: [] };
  const o = pancakeRecentOrderOf(pos);
  assert.ok(o && o.id === "990001" && o.phone === "0900000222" && o.at === "2025-03-10T02:00:00.000Z" && o.ward === "Phường Cầu Giấy" && o.address === "Số 9 ngõ 9" && o.declaredPrepaid === true, JSON.stringify(o));
  assert.ok(!("paid" in (o ?? {})), "đơn Pancake không mang cờ «đã thanh toán» — trả trước khai trên POS không phải tiền thật (lifecycle.ts)");
  assert.equal(pancakeRecentOrderOf({ id: "1" })?.at, null, "Pancake không gửi mốc ⇒ null, không lấy «bây giờ»");
  assert.equal(pancakeRecentOrderOf("x"), null);
  const now = new Date();
  const known = parsePancakeThreadProfile([{ messages: [], recent_orders: [pos, "rác"] }], "pg", now, now);
  assert.ok(known.recentOrders?.length === 1 && known.recentOrdersUnparsed === 1, JSON.stringify(known));
  const unknown = parsePancakeThreadProfile([{ messages: [] }], "pg", now, now);
  assert.ok(!("recentOrders" in unknown), "không có khoá ⇒ CHƯA BIẾT (khác [])");
}

function testProbePure() {
  assert.deepEqual(parseProbeArgs(["hslc", "--conv=45c36073-1030-4a3a-84d6-46818314a0b2", "--days=7"]), { code: "hslc", conv: "45c36073-1030-4a3a-84d6-46818314a0b2", days: 7 });
  assert.deepEqual(parseProbeArgs(["hslc"]), { code: "hslc", conv: null, days: 30 });
  assert.ok("error" in parseProbeArgs(["hslc", "--conv=0900000123"]), "chỉ nhận mã hội thoại dạng uuid");
  assert.ok("error" in parseProbeArgs(["hslc", "--days=90"]));
  assert.ok("error" in parseProbeArgs([]));
  assert.equal(maskProbeKey("1234567"), "<mã>");
  assert.deepEqual(keyPaths({ a: { b: 1 }, "1234567": 2, arr: [{ c: 1 }] }, "", 2), ["<mã>", "a", "a.b", "arr", "arr[].c"]);
  assert.equal(monthOf("2025-03-10T02:00:00Z"), "2025-03");
  assert.equal(monthOf(null), "—");
  assert.ok(looksLikeAddress("so 8 ngo 2 phuong cau giay") && !looksLikeAddress("cho 0 5 kg nhe"));
}

function testSourceScan() {
  const probe = readFileSync("scripts/customer-360-probe.ts", "utf8");
  assert.ok(probe.indexOf('process.env.ERP_READ_ONLY = "1"') > 0 && probe.indexOf('process.env.ERP_READ_ONLY = "1"') < probe.indexOf('from "@/db"'), "đặt chỉ-đọc TRƯỚC khi nạp @/db");
  assert.ok(probe.includes("getDbForInspection") && probe.includes("show default_transaction_read_only"), "hỏi lại Postgres phiên chỉ đọc");
  assert.ok(!/\.(insert|update|delete)\(/.test(probe), "không một câu ghi");
  assert.ok(!/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(probe), "Pancake chỉ GET");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- customer-360-probe\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bcustomer-360-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bcustomer-360-probe\b/, "làn ĐỌC nặng");
  assert.match(ops, /customer-360-probe\)\n[\s\S]*?scripts\/customer-360-probe\.ts ;;/, "nhánh chạy");
  const engine = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.ok(engine.includes("loadCustomer360(") && engine.includes("customer360Prompt(c360, reuse)") && engine.includes("customer360: c360") && engine.includes("preferReturning(baseReturning, c360)"), "engine nối Customer 360 ở đúng ba chỗ");
  assert.ok(engine.includes('postSale ? "" : customer360Prompt(c360, reuse)'), "giai đoạn hậu mãi (#821) không có khối TRA LỊCH SỬ");
  const tools = readFileSync("lib/sales-chatbot/tools.ts", "utf8");
  const cc = tools.slice(tools.indexOf('case "create_customer": {'));
  const gate = cc.indexOf("if (state.confirmed && !state.confirmed.auto)");
  assert.ok(gate > 0 && gate < cc.indexOf("savedAddressChoice(") && gate < cc.indexOf("savedAddressPhone(") && gate < cc.indexOf("historyAddressWithoutConsent("), "chặn sửa đơn đã chốt (#821) đứng TRƯỚC mọi nhánh Customer 360 của create_customer");
  const lib = readFileSync("lib/sales-chatbot/customer-360.ts", "utf8");
  assert.ok(!/getPlatformDb|withOrganization|getDbForInspection/.test(lib), "Customer 360 chỉ đọc CSDL của tổ chức NGỮ CẢNH (hoặc CSDL ops truyền vào) — không mở tổ chức khác");
}

// ═══════════ PGlite: chatTurn thật, model giả ═══════════

const firstPrompt = (t: GoldenTranscript, turn = 0) => t.prompts[t.turns[turn].rounds[0]?.prompt ?? -1] ?? "";

const INTEGRATION: GoldenCase[] = [
  {
    key: "c360-nhieu-dia-chi",
    title: "nhiều địa chỉ cũ ⇒ cho chọn; khách chọn số 2 ⇒ máy chủ điền đúng địa chỉ số 2",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: async (ctx) => {
          await seedReturningThread(ctx, { orderId: "c360-a1", threadId: "pg-vang_nhieu", at: new Date(Date.now() - 2 * 3_600_000) });
          await seedReturningThread(ctx, { orderId: "c360-a2", threadId: "pg-vang_nhieu", address: "Số 99 phố Huế", at: new Date(Date.now() - 3_600_000) });
        },
        say: "vẫn địa chỉ cũ nha",
        ai: [() => [say("Dạ chị chọn địa chỉ số 1 hay số 2 ạ?")]],
      },
      { say: "địa chỉ số 2 nhé", ai: [() => [tool("create_customer", { use_saved_address: true, saved_address_choice: 2, customer_confirmation: "địa chỉ số 2 nhé" })], () => [say("Dạ em ghi nhận ạ.")]] },
    ],
  },
  {
    key: "c360-don-hoan",
    title: "đơn cũ duy nhất là đơn HOÀN ⇒ không đề xuất địa chỉ đó, nói chưa tìm thấy",
    shop: "food",
    channel: "WEB",
    turns: [{ before: (ctx) => seedReturningThread(ctx, { orderId: "c360-hoan", threadId: "pg-vang_hoan", stage: "RETURNED", address: "Số 7 ngõ hoàn" }), say: "vẫn địa chỉ cũ nhé", ai: [() => [say("Dạ em chưa tìm thấy địa chỉ cũ ạ.")]] }],
  },
  {
    key: "c360-tu-choi",
    title: "khách không dùng lại địa chỉ cũ ⇒ xin địa chỉ mới",
    shop: "food",
    channel: "WEB",
    turns: [{ before: (ctx) => seedReturningThread(ctx, { orderId: "c360-tc", threadId: "pg-vang_tc" }), say: "không, gửi địa chỉ khác nhé", ai: [() => [say("Dạ chị gửi em địa chỉ mới ạ.")]] }],
  },
  {
    key: "c360-nua-kg",
    title: "0,5kg chỉ bán kèm + vẫn địa chỉ cũ ⇒ máy chủ chặn giỏ chỉ có món bán kèm, lời nhắc: chính sách trước, địa chỉ đề xuất xác nhận",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: async (ctx) => {
          await seedReturningThread(ctx, { orderId: "c360-nk", threadId: "pg-vang_nk" });
          await (await getDb()).update(schema.productVariants).set({ addOnOnly: true }).where(eq(schema.productVariants.id, ctx.ids.get("MUC-KHO")!));
        },
        say: "Cho 0.5kg muc kho nhé\nVẫn địa chỉ cũ",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("MUC-KHO"), quantity: 1 }] })], () => [say("Dạ mực khô 500g là món bán kèm ạ.")]],
      },
    ],
  },
  {
    key: "c360-doi-so",
    title: "khách giữ địa chỉ cũ nhưng ĐỔI SĐT ⇒ máy chủ điền địa chỉ đơn cũ + SĐT MỚI có nguyên trong câu khách",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { orderId: "c360-ds", threadId: "pg-vang_ds" }),
        say: "vẫn địa chỉ cũ nhưng số mới 0912345678 nhé",
        ai: [() => [tool("create_customer", { use_saved_address: true, phone: "0912345678", customer_confirmation: "vẫn địa chỉ cũ nhưng số mới 0912345678 nhé" })], () => [say("Dạ em ghi nhận số mới ạ.")]],
      },
    ],
  },
  {
    key: "c360-so-bia",
    title: "model tự chế SĐT không có trong câu khách ⇒ máy chủ từ chối (hỏi lại), KHÔNG lặng lẽ dùng SĐT của đơn cũ",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { orderId: "c360-sb", threadId: "pg-vang_sb" }),
        say: "vẫn địa chỉ cũ nhé em",
        ai: [() => [tool("create_customer", { use_saved_address: true, phone: "0987654321", customer_confirmation: "vẫn địa chỉ cũ nhé em" })], () => [say("Dạ em ghi nhận ạ.")]],
      },
    ],
  },
  {
    key: "c360-chi-goi-y",
    title: "địa chỉ cũ CHỈ là gợi ý (AGENTS 3.12): khách chưa xác nhận ⇒ máy chủ từ chối điền, hồ sơ nhận hàng vẫn trống",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { orderId: "c360-gy", threadId: "pg-vang_gy" }),
        say: "cho chị 1 gói chả mực, vẫn địa chỉ cũ",
        ai: [() => [tool("create_customer", { use_saved_address: true, customer_confirmation: "đúng rồi em" })], () => [say("Dạ em gửi về địa chỉ cũ như đơn trước được không ạ?")]],
      },
    ],
  },
  {
    key: "c360-go-lai-dia-chi",
    title: "model gõ lại địa chỉ ĐƠN CŨ vào create_customer mà khách chưa xác nhận ⇒ máy chủ chặn (AGENTS 3.12)",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { orderId: "c360-gl", threadId: "pg-vang_gl" }),
        say: "cho chị 1 gói chả mực",
        ai: [() => [tool("create_customer", { name: "Chị Vàng", phone: RETURNING_THREAD.phone, address: `${RETURNING_THREAD.address}, ${RETURNING_THREAD.ward}`, province: RETURNING_THREAD.province })], () => [say("Dạ em gửi về địa chỉ cũ như đơn trước được không ạ?")]],
      },
    ],
  },
  { key: "c360-do-don", title: "đo trên tổ chức thử + nạp hồ sơ trực tiếp", shop: "food", channel: "WEB", turns: [{ say: "chào shop", ai: [() => [say("Dạ em chào chị ạ.")]] }] },
  {
    key: "c360-to-chuc-khac",
    title: "tổ chức KHÁC có cùng mã hội thoại + SĐT ⇒ không thấy gì của tổ chức kia",
    shop: "fashion",
    channel: "WEB",
    turns: [
      {
        before: async ({ conversationId }) => {
          const db = await getDb();
          await db.update(schema.salesChatConversations).set({ pageId: RETURNING_THREAD.pageId, threadId: RETURNING_THREAD.threadId, state: { returning: { fetchedAt: new Date().toISOString(), phones: [RETURNING_THREAD.phone], fbIds: [], prior: [] } } }).where(eq(schema.salesChatConversations.id, conversationId));
        },
        say: "vẫn địa chỉ cũ nhé",
        ai: [() => [say("Dạ em chưa tìm thấy địa chỉ cũ ạ.")]],
      },
    ],
  },
];

async function loaderChecks(conversationId: string) {
  const db = await getDb();
  const o = schema.orders;
  const base = { stage: "SHIPPED" as const, shipFullName: "Chị Số", shipCommune: "Phường Cầu Giấy", shipProvince: "Thành phố Hà Nội" };
  // Lịch sử chỉ ở Pancake (ERP chưa có đơn) ⇒ nối qua đơn Pancake của chính hội thoại.
  const pk = await loadCustomer360({ conversationId: "c360-pk", pageId: "pg-x", threadId: "pg-x_1", state: S({ returning: { fetchedAt: "", phones: [], fbIds: [], prior: [], recentOrders: [{ id: "pk-1", at: new Date(Date.now() - 30 * 86_400_000).toISOString(), stage: "SHIPPED", name: "Chị Pancake", phone: "0900000666", address: "Số 5 ngõ 5", province: "Thành phố Hà Nội", ward: "Phường Cầu Giấy", paid: false, items: [] }] } }) });
  assert.ok(pk.suggestion === "ONE" && pk.identity.match === "THREAD" && pk.buyer === "REPEAT" && pk.addresses[0].confidence === "CONFIRMED_NORMALIZED" && pk.lastOrder?.source === "PANCAKE", JSON.stringify(pk));
  // SĐT Pancake ghi nhận (recent_phone_numbers) ⇒ đơn ERP ghi SĐT đó ⇒ mức PHONE, che.
  await db.insert(o).values({ id: "c360-ph1", insertedAt: new Date(Date.now() - 86_400_000), shipPhone: "0900000444", shipAddress: "Số 4 ngõ 4", ...base });
  const ph = await loadCustomer360({ conversationId: "c360-ph", pageId: null, threadId: null, state: S({ returning: { fetchedAt: "", phones: ["+84 900 000 444"], fbIds: [], prior: [] } }) });
  assert.ok(ph.identity.match === "PHONE" && ph.masked && ph.suggestion === "ONE", JSON.stringify(ph.identity));
  assert.ok(!customer360Prompt(ph, REUSE).includes("Số 4 ngõ 4"), "mức PHONE ⇒ địa chỉ che trong lời nhắc");
  // SĐT trùng hai hồ sơ, hai địa chỉ ⇒ không chọn bừa.
  const [c1] = await db.insert(schema.customers).values({ name: "Người Một", phone: "0900000555" }).returning({ id: schema.customers.id });
  const [c2] = await db.insert(schema.customers).values({ name: "Người Hai", phones: ["0900000555"] }).returning({ id: schema.customers.id });
  await db.insert(o).values({ id: "c360-am1", insertedAt: new Date(Date.now() - 86_400_000), customerId: c1.id, shipPhone: "0900000555", shipAddress: "Số 1 nhà Một", ...base });
  await db.insert(o).values({ id: "c360-am2", insertedAt: new Date(Date.now() - 2 * 86_400_000), customerId: c2.id, shipPhone: "0900000556", shipAddress: "Số 2 nhà Hai", ...base });
  const am = await loadCustomer360({ conversationId: "c360-am", pageId: null, threadId: null, state: S({ returning: { fetchedAt: "", phones: ["0900000555"], fbIds: [], prior: [] } }) });
  assert.equal(am.suggestion, "AMBIGUOUS", JSON.stringify(am.addresses));
  const amText = customer360Prompt(am, REUSE);
  assert.ok(!amText.includes("nhà Một") && !amText.includes("nhà Hai") && /KHÔNG chọn hộ/.test(amText), amText);
  // TIỀN theo chiều `payment` của lifecycle.ts (#801): số chuyển khoản KHAI trên đơn KHÔNG phải tiền thật ⇒ chưa «đã thanh toán»;
  // chỉ chứng từ thu CONFIRMED phủ đủ số phải thu mới làm bot thôi hỏi.
  await db.insert(o).values({ ...base, id: "erp-c360-paid", insertedAt: new Date(), stage: "CONFIRMED", salesConversationId: "c360-conv-paid", transferMoney: 280_000, totalPriceAfterDiscount: 280_000, shippingFee: 0, shipPhone: "0900000777", shipAddress: "Số 6 ngõ 6", shipFullName: "Chị Trả" });
  const paidState = S({ confirmed: { orderId: "erp-c360-paid", simulated: false, total: 280_000, at: new Date().toISOString() }, customer: { id: null, name: "Chị Trả", phone: "0900000777", address: "Số 6 ngõ 6", province: "", simulated: false } });
  const declared = await loadCustomer360({ conversationId: "c360-conv-paid", pageId: null, threadId: null, state: paidState });
  assert.ok(declared.currentOrder?.paid === false && !/ĐÃ THANH TOÁN/.test(customer360Prompt(declared, NO_REUSE_INTENT)), `chuyển khoản khai trên đơn ≠ tiền thật: ${JSON.stringify(declared.currentOrder)}`);
  await db.insert(schema.orderPayments).values({ orderId: "erp-c360-paid", kind: "RECEIPT", method: "BANK_TRANSFER", amount: 100_000, paidAt: new Date() });
  const partial = await loadCustomer360({ conversationId: "c360-conv-paid", pageId: null, threadId: null, state: paidState });
  assert.equal(partial.currentOrder?.paid, false, "thu một phần ⇒ chưa «đã thanh toán»");
  await db.insert(schema.orderPayments).values({ orderId: "erp-c360-paid", kind: "RECEIPT", method: "BANK_TRANSFER", amount: 180_000, paidAt: new Date() });
  const paid = await loadCustomer360({ conversationId: "c360-conv-paid", pageId: null, threadId: null, state: paidState });
  assert.ok(paid.currentOrder?.paid === true && /ĐÃ THANH TOÁN/.test(customer360Prompt(paid, reuseIntentOf(["cho chị thêm 1 gói nữa"]))), JSON.stringify(paid.currentOrder));
  // ĐƠN HOÀN theo ORDER_OUTCOME (không theo khâu Pancake): khâu «Đã nhận» + vận đơn giao thành công nhưng thực thu 30.000 ₫ (< ngưỡng
  // hoàn) ⇒ HOÀN ⇒ địa chỉ không được đề xuất, khách VẪN là khách cũ.
  await db.insert(o).values({ ...base, id: "c360-out-hoan", insertedAt: new Date(Date.now() - 5 * 86_400_000), stage: "DELIVERED", salesConversationId: "c360-conv-out", shipPhone: "0900000888", shipAddress: "Số 30 ngõ hoàn" });
  await db.insert(schema.shipments).values({ id: "c360-s-hoan", orderId: "c360-out-hoan", carrier: "Viettel Post", vtpOrderNumber: "C360HOAN01", stage: "DELIVERED", codAmount: 280_000, codCollected: 30_000 });
  const outHoan = await loadCustomer360({ conversationId: "c360-conv-out", pageId: null, threadId: null, state: S() });
  assert.ok(outHoan.suggestion === "NONE" && outHoan.noAddressReason === "ONLY_UNVERIFIED" && outHoan.buyer === "REPEAT" && outHoan.history?.returned === 1, `ORDER_OUTCOME hoàn thắng khâu «Đã nhận»: ${JSON.stringify([outHoan.history, outHoan.lastOrder])}`);
  assert.ok(!customer360Prompt(outHoan, REUSE).includes("Số 30 ngõ hoàn"), "đơn hoàn ⇒ địa chỉ không đọc ra");
  // Khâu «Đã nhận» mà KHÔNG có vận đơn ⇒ ORDER_OUTCOME không nói giao thành công ⇒ chỉ «đã xác nhận + chuẩn hoá», không «đã giao».
  await db.insert(o).values({ ...base, id: "c360-out-st", insertedAt: new Date(Date.now() - 5 * 86_400_000), stage: "DELIVERED", salesConversationId: "c360-conv-st", shipPhone: "0900000889", shipAddress: "Số 31 ngõ nhận" });
  const outSt = await loadCustomer360({ conversationId: "c360-conv-st", pageId: null, threadId: null, state: S() });
  assert.ok(outSt.suggestion === "ONE" && outSt.addresses[0].confidence === "CONFIRMED_NORMALIZED" && outSt.history?.delivered === 0, `khâu «Đã nhận» không phải giao thành công: ${JSON.stringify([outSt.addresses, outSt.history])}`);
  // ĐƠN ERP CÙNG MÃ VỚI recent_orders PANCAKE (đồng bộ nhưng conversation_id rỗng): ERP nói HOÀN theo ORDER_OUTCOME, Pancake còn ghi
  // «Đã gửi» ⇒ dòng ERP đè bản Pancake ⇒ KHÔNG đề xuất địa chỉ.
  await db.insert(o).values({ ...base, id: "c360-pk-hoan", insertedAt: new Date(Date.now() - 6 * 86_400_000), stage: "DELIVERED", shipPhone: "0900000991", shipAddress: "Số 40 ngõ Pancake" });
  await db.insert(schema.shipments).values({ id: "c360-s-pkh", orderId: "c360-pk-hoan", carrier: "Viettel Post", vtpOrderNumber: "C360PKH01", stage: "DELIVERED", codAmount: 280_000, codCollected: 30_000 });
  await db.insert(o).values({ ...base, id: "c360-pk-xoa", insertedAt: new Date(Date.now() - 7 * 86_400_000), stage: "DELETED", shipPhone: "0900000992", shipAddress: "Số 41 ngõ xoá" });
  const pkOrder = (id: string, address: string) => ({ id, at: new Date(Date.now() - 6 * 86_400_000).toISOString(), stage: "SHIPPED", name: "Chị Pancake", phone: "", address, province: "Thành phố Hà Nội", ward: "Phường Cầu Giấy", declaredPrepaid: false, items: [] });
  const shadow = await loadCustomer360({ conversationId: "c360-pk-shadow", pageId: "pg-y", threadId: "pg-y_1", state: S({ returning: { fetchedAt: "", phones: [], fbIds: [], prior: [], recentOrders: [pkOrder("c360-pk-hoan", "Số 40 ngõ Pancake"), pkOrder("c360-pk-xoa", "Số 41 ngõ xoá")] } }) });
  assert.ok(shadow.suggestion === "NONE" && shadow.lastOrder?.source === "ERP" && shadow.history?.orders === 1 && shadow.history.returned === 1, `ERP (ORDER_OUTCOME hoàn) đè bản Pancake, đơn ERP đã xoá bỏ luôn: ${JSON.stringify([shadow.history, shadow.lastOrder, shadow.addresses])}`);
  const shadowText = customer360Prompt(shadow, REUSE);
  assert.ok(!shadowText.includes("Số 40 ngõ Pancake") && !shadowText.includes("Số 41 ngõ xoá"), shadowText);
  // Mốc `before` (phép đo): đơn tạo SAU lúc mở hội thoại là của lượt này.
  const later = await loadCustomer360({ conversationId: "c360-ph", pageId: null, threadId: null, state: S({ returning: { fetchedAt: "", phones: ["0900000444"], fbIds: [], prior: [] } }) }, { before: new Date(Date.now() - 2 * 86_400_000) });
  assert.equal(later.suggestion, "NONE", "đơn sau mốc mở hội thoại không phải «lần trước»");
  // Thước đo trên tổ chức thử: hội thoại «nhiều địa chỉ» có đơn mang mốc TRƯỚC lúc mở hội thoại ⇒ khách cũ, bot không xin lại ⇒ nhận ra.
  // Mẫu < 10 ⇒ tỷ lệ null (không in phần trăm của một nắm ca).
  const m = await measureReturningMetrics({ since: new Date(Date.now() - 86_400_000), until: new Date(Date.now() + 60_000) });
  assert.ok(m.metrics.conversations >= 1 && m.metrics.returning >= 1 && m.metrics.recognized >= 1 && m.metrics.recognitionRate === null, JSON.stringify(m));
  void conversationId;
}

async function testIntegration() {
  const seen = new Set<string>();
  const golden = GOLDEN_CASES.find((c) => c.key === "khach-cu-van-dia-chi-cu");
  assert.ok(golden, "có hội thoại vàng «vẫn địa chỉ cũ»");
  await runGoldenCases([golden, ...INTEGRATION], {
    orgSuffix: "-c360",
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const p0 = firstPrompt(t);
      if (c.key === "khach-cu-van-dia-chi-cu") {
        assert.ok(/TRA LỊCH SỬ/.test(p0) && /Shop CÓ đúng MỘT địa chỉ cũ/.test(p0) && p0.includes("Số 8 ngõ 2") && /KHÔNG xin lại địa chỉ/.test(p0), "lượt «vẫn địa chỉ cũ»: lời nhắc mang địa chỉ cũ của chính hội thoại + dặn không xin lại");
        assert.ok(p0.includes("KHÁCH CŨ — dữ liệu shop đã có"), "khách nối qua mã hội thoại Pancake được nhận là khách cũ");
        assert.ok(t.final.customer?.address.startsWith("Số 8 ngõ 2") && t.final.customer.phone === RETURNING_THREAD.phone, `khách đồng ý ⇒ máy chủ điền địa chỉ + SĐT của đơn cũ: ${JSON.stringify(t.final.customer)}`);
        assert.ok(t.final.draft && t.final.draft.lines.length === 1, "lên được đơn nháp, không xin lại thông tin");
        return;
      }
      if (c.key === "c360-nhieu-dia-chi") {
        assert.ok(/1\) «Số 99 phố Huế/.test(p0) && /2\) «Số 8 ngõ 2/.test(p0), p0.slice(-1500));
        assert.ok(t.final.customer?.address.startsWith("Số 8 ngõ 2"), `chọn số 2 ⇒ địa chỉ số 2: ${JSON.stringify(t.final.customer)}`);
        return;
      }
      if (c.key === "c360-don-hoan") {
        assert.ok(/CHƯA tìm thấy địa chỉ cũ/.test(p0) && !p0.includes("Số 7 ngõ hoàn"), "đơn hoàn: không đề xuất, không đọc địa chỉ ra");
        return;
      }
      if (c.key === "c360-tu-choi") {
        assert.ok(/KHÔNG dùng lại địa chỉ cũ ⇒ xin địa chỉ MỚI/.test(p0), "khách từ chối ⇒ xin mới");
        return;
      }
      if (c.key === "c360-nua-kg") {
        const cart = t.turns[0].rounds[0].results[0] as { error?: string } | undefined;
        assert.ok(cart?.error && /CHỈ BÁN KÈM/.test(cart.error), `máy chủ chặn giỏ chỉ có món bán kèm: ${JSON.stringify(cart)}`);
        assert.ok(/TRA LỊCH SỬ/.test(p0) && /chỉ bán kèm ⇒ nói chính sách/.test(p0) && /mời thêm món KHÔNG thay nhu cầu chính/.test(p0), "lời nhắc: chính sách số lượng trước, upsell không thay nhu cầu chính, địa chỉ đề xuất");
        await (await getDb()).update(schema.productVariants).set({ addOnOnly: false }).where(eq(schema.productVariants.id, ctx.ids.get("MUC-KHO")!));
        return;
      }
      if (c.key === "c360-doi-so") {
        assert.ok(/ĐỔI SĐT/.test(p0) && /phone = SĐT mới/.test(p0), "lời nhắc: giữ địa chỉ cũ, dùng SĐT mới");
        assert.ok(t.final.customer?.address.startsWith("Số 8 ngõ 2") && t.final.customer.phone === "0912345678", `đổi số ⇒ địa chỉ cũ + SĐT mới: ${JSON.stringify(t.final.customer)}`);
        return;
      }
      if (c.key === "c360-so-bia") {
        const res = t.turns[0].rounds[0].results[0] as { error?: string } | undefined;
        assert.ok(res?.error && /không có trong câu cuối/.test(res.error), `số không có trong câu khách ⇒ từ chối: ${JSON.stringify(res)}`);
        assert.ok(!t.final.customer, `không lùi về số cũ: ${JSON.stringify(t.final.customer)}`);
        return;
      }
      if (c.key === "c360-chi-goi-y") {
        assert.ok(/CHỈ là GỢI Ý/.test(p0) && p0.includes("Số 8 ngõ 2"), "lời nhắc đề xuất địa chỉ cũ dưới dạng gợi ý");
        const res = t.turns[0].rounds[0].results[0] as { error?: string } | undefined;
        assert.ok(res?.error && /nguyên văn lời khách xác nhận/.test(res.error), `lời xác nhận không có trong câu khách ⇒ từ chối: ${JSON.stringify(res)}`);
        assert.ok(!t.final.customer, `không tự điền địa chỉ cũ vào hồ sơ nhận hàng: ${JSON.stringify(t.final.customer)}`);
        return;
      }
      if (c.key === "c360-go-lai-dia-chi") {
        assert.ok(p0.includes("KHÁCH CŨ — dữ liệu shop đã có") && /CHỈ GỢI Ý/.test(p0) && !p0.includes("hoặc trả lời tiếp về món ⇒ create_customer bằng ĐÚNG thông tin trên"), "khối KHÁCH CŨ từ lịch sử chỉ gợi ý");
        const res = t.turns[0].rounds[0].results[0] as { error?: string } | undefined;
        assert.ok(res?.error && /ĐƠN CŨ/.test(res.error), `gõ lại địa chỉ đơn cũ ⇒ chặn: ${JSON.stringify(res)}`);
        assert.ok(!t.final.customer, `không ghi địa chỉ cũ khi khách chưa xác nhận: ${JSON.stringify(t.final.customer)}`);
        return;
      }
      if (c.key === "c360-do-don") {
        await loaderChecks(ctx.conversationId);
        return;
      }
      // c360-to-chuc-khac (tổ chức thời trang, chạy SAU tổ chức thực phẩm — đơn cùng mã hội thoại + SĐT vẫn nằm ở tổ chức kia).
      assert.ok(/CHƯA tìm thấy địa chỉ cũ/.test(p0) && !p0.includes("Số 8 ngõ 2") && !p0.includes("KHÁCH CŨ — dữ liệu shop đã có"), "tổ chức khác: không một dữ kiện nào lọt sang");
      const db = await getDb();
      const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const c360 = await loadCustomer360({ conversationId: row.id, pageId: row.pageId, threadId: row.threadId, state: (row.state ?? {}) as ChatState });
      assert.equal(c360.identity.match, "NONE");
    },
  });
  assert.deepEqual([...seen].sort(), ["khach-cu-van-dia-chi-cu", ...INTEGRATION.map((c) => c.key)].sort(), "chạy đủ mọi ca");
}

export async function testCustomer360() {
  testAddressRule();
  testAssemble();
  testIntent();
  testPrompt();
  testBridges();
  testPhoneChange();
  testHistoryPrompt();
  testMetrics();
  testPancakeParse();
  testProbePure();
  testSourceScan();
  await testIntegration();
  console.log(
    "  ✓ Customer 360: địa chỉ đã xác minh (giao thành công / đã xác nhận + chuẩn hoá; hoàn · huỷ · nháp · chưa ghép KHÔNG đề xuất), nối khách qua đơn của chính hội thoại > mã FB > SĐT (che), SĐT trùng nhiều người ⇒ không chọn, khách mới chỉ khi Pancake nói, «vẫn địa chỉ cũ» ⇒ đề xuất xác nhận / cho chọn / nói chưa tìm thấy + chỉ xin phần thiếu, đổi SĐT, từ chối dùng lại, đã thanh toán ⇒ không hỏi lại, 0,5kg chính sách trước, tổ chức khác không lọt, ba thước đo + ops chỉ đọc khai đủ bốn chỗ",
  );
}

/**
 * GIỎ CÓ THẨM QUYỀN — SỐ LƯỢNG KHÁCH NÓI TƯỜNG MINH LÀ «DÍNH» (P0 12/10/2026, ca production HSLC).
 *
 * Ca thật: khách «Cho chị 2kg chả cá thu / ĐT 0368571285 / F4/22A …» rồi «Ngon chị mới lấy nha em» ⇒ AI «Mình lấy 1kg ăn thử trước
 * nhé…» — tự hạ số lượng đã chốt. Bài kiểm khoá bốn tầng của `lib/sales-chatbot/cart-commitment.ts`:
 *  1. Thuần: bảng ca «câu sửa tường minh» vs «câu mơ hồ» (có / không dấu); áp tin lên giỏ; kiểm cứng hạ / bỏ món; câu bot hạ số lượng
 *     bị thay; mức sẵn sàng + khối lời nhắc; «không lấy thêm» / «để lần sau» sau lời mời thêm món không còn là «hoãn».
 *  2. Ma trận hồi quy G qua `chatTurn` THẬT (model giả của bộ hội thoại vàng, tổ chức PGlite thật, công cụ thật): 1) 2kg → «ok» ⇒ 2kg;
 *     2) 2kg → «ngon chị mới lấy nha em» ⇒ 2kg (model cố hạ 1kg bị từ chối, câu «1kg ăn thử» bị thay); 3) 2kg → «không lấy thêm đâu» ⇒
 *     2kg; 4) 2kg → «đổi 1kg thôi» ⇒ 1kg; 5) 2kg chả cá + 1kg chả mực → «thế thôi» ⇒ giữ hai dòng; 6) món + số lượng + SĐT + địa chỉ
 *     trong MỘT tin ⇒ ORDER_READY, đơn tạo + tự chốt, giá máy chủ 2kg = 540.000 ₫.
 *
 * Không gọi mạng (luật 65), không ghim ngày (luật 50).
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createProductCore } from "@/lib/records/product-create";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import {
  amountsIn,
  applyCustomerCartMessage,
  bindCommitment,
  cartCommitmentPrompt,
  cartHoldVerdict,
  classifyCartMessage,
  commitmentViolation,
  declinesAddOnOnly,
  holdCartText,
  orderReadiness,
  type AskedLine,
  type CartCommitment,
  type CartIntentKind,
} from "@/lib/sales-chatbot/cart-commitment";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { autoConfirmBlocker, customerHesitates, type ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const NOW = () => new Date();

// ═══ THUẦN ═══

function testClassify() {
  // [câu khách, loại] — có dấu và không dấu. Mặc định BẢO THỦ: câu mơ hồ KHÔNG đổi giỏ.
  const table: [string, CartIntentKind][] = [
    // Mơ hồ — giữ nguyên (yêu cầu C của chủ shop)
    ["Ngon chị mới lấy nha em", "AMBIGUOUS"],
    ["ngon chi moi lay nha em", "AMBIGUOUS"],
    ["ok em", "AMBIGUOUS"],
    ["Ok", "AMBIGUOUS"],
    ["ừ", "AMBIGUOUS"],
    ["được", "AMBIGUOUS"],
    ["dc e", "AMBIGUOUS"],
    ["để lần sau", "AMBIGUOUS"],
    ["de lan sau nhe", "AMBIGUOUS"],
    ["không cần thêm", "AMBIGUOUS"],
    ["không lấy thêm đâu", "AMBIGUOUS"],
    ["khong lay them dau", "AMBIGUOUS"],
    ["không lấy gì nữa", "AMBIGUOUS"],
    ["thế nhé", "AMBIGUOUS"],
    ["thế thôi", "AMBIGUOUS"],
    ["ship giúp chị", "AMBIGUOUS"],
    ["chị lấy vậy thôi", "AMBIGUOUS"],
    ["chi lay vay thoi", "AMBIGUOUS"],
    // Hỏi — không đổi giỏ
    ["1kg bao nhiêu tiền em?", "QUESTION"],
    ["2kg chả cá thu 540k đúng không em", "QUESTION"],
    ["nếu lấy 3kg thì giảm bao nhiêu", "QUESTION"],
    ["neu lay 3kg thi sao", "QUESTION"],
    ["muc kho cau con 5 goi ko", "QUESTION"],
    ["tinh tien 3 goi cha ca", "QUESTION"],
    ["quan an minh can lay si 50kg cha muc moi tuan, gia si sao", "QUESTION"],
    ["dang co khuyen mai gi ko, lay 2 goi cha muc het bao nhieu", "ORDER"],
    // Nói số lượng khẳng định
    ["Cho chị 2kg chả cá thu", "ORDER"],
    ["Cho chị 2kg chả cá thu\nĐT 0368571285\nF4/22A ấp 4, xã Bà Điểm, Hóc Môn, TP Hồ Chí Minh", "ORDER"],
    ["cho chi 2kg cha ca thu", "ORDER"],
    ["2kg chả cá + 1kg chả mực", "ORDER"],
    ["lấy 2 ký chả cá thu nhé", "ORDER"],
    ["lấy hai ký", "ORDER"],
    ["chị lấy 2kg thì bao nhiêu?", "QUESTION"],
    ["lấy 2kg chả cá thu bao nhiêu em", "ORDER"],
    // Sửa tường minh
    ["đổi còn 1kg", "SET"],
    ["doi con 1kg", "SET"],
    ["đổi 1kg thôi", "SET"],
    ["lấy 1kg thôi", "SET"],
    ["lay 1kg thoi", "SET"],
    ["thôi lấy 3kg", "SET"],
    ["không phải 2kg, 1kg thôi", "SET"],
    ["chỉ lấy 1kg", "SET"],
    ["bớt 1kg", "REDUCE"],
    ["bot 1kg nhe", "REDUCE"],
    ["lấy thêm 1kg chả mực", "ADD"],
    ["thêm 1kg nữa", "ADD"],
    ["không lấy chả cá nữa", "REMOVE"],
    ["khong lay cha ca nua", "REMOVE"],
    ["bỏ chả mực đi", "REMOVE"],
    ["thôi không lấy nữa", "CANCEL"],
    ["k lấy nữa e", "CANCEL"],
  ];
  for (const [text, kind] of table) assert.equal(classifyCartMessage(text).kind, kind, `«${text}» ⇒ ${kind} (được ${classifyCartMessage(text).kind})`);
  // Đọc số lượng: khối lượng (gram) + số gói; không bắt SĐT / địa chỉ / tiền.
  assert.deepEqual(amountsIn("Cho chị 2kg chả cá thu / ĐT 0368571285 / F4/22A").map((a) => [a.value, a.unit, a.label]), [[2000, "g", "cha ca thu"]]);
  assert.deepEqual(amountsIn("2kg chả cá + 1kg chả mực").map((a) => [a.value, a.label]), [[2000, "cha ca"], [1000, "cha muc"]]);
  assert.deepEqual(amountsIn("nửa ký ruốc, 1 ký rưỡi chả, 500g tôm, 2 hộp").map((a) => [a.value, a.unit]), [[500, "g"], [1500, "g"], [500, "g"], [2, "pack"]]);
  assert.deepEqual(amountsIn("chả cá thu 2kg nhé").map((a) => a.label), ["cha ca thu"], "tên món đứng TRƯỚC số lượng");
  assert.deepEqual(amountsIn("cho chị 2 túi 1kg").map((a) => [a.value, a.unit, a.label]), [[2000, "g", ""]], "«2 túi 1kg» = 2kg (ca Chị Hoàn)");
  assert.deepEqual(qty(cartOf("lấy 1kg chả cá thu", "cho chị 2 túi 1kg", "2 ký giá 540đ chứ")), [["chả cá thu", 2000, "g", true]]);
  assert.deepEqual(amountsIn("giá 540k, ship 30.000đ, SĐT 0976 797 166"), []);
}

const cartOf = (...msgs: string[]): CartCommitment | undefined => {
  let c: CartCommitment | undefined;
  msgs.forEach((m, i) => {
    c = applyCustomerCartMessage(c, m, i + 1, NOW());
  });
  return c;
};
const qty = (c: CartCommitment | undefined) => (c?.selectedItems ?? []).map((x) => [x.label, x.quantity, x.unit, x.customerExplicit]);

function testApply() {
  // Ma trận G ở mức hàm thuần.
  assert.deepEqual(qty(cartOf("Cho chị 2kg", "ok")), [["", 2000, "g", true]], "G1: «ok» giữ 2kg");
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "ngon chị mới lấy nha em")), [["chả cá thu", 2000, "g", true]], "G2");
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "không lấy thêm đâu")), [["chả cá thu", 2000, "g", true]], "G3");
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "đổi 1kg thôi")), [["chả cá thu", 1000, "g", true]], "G4");
  assert.deepEqual(qty(cartOf("2kg chả cá + 1kg chả mực", "thế thôi")), [["chả cá", 2000, "g", true], ["chả mực", 1000, "g", true]], "G5");
  // Câu mơ hồ ⇒ ĐÚNG đối tượng cũ (engine không ghi gì).
  const c1 = cartOf("Cho chị 2kg chả cá thu");
  for (const m of ["ok", "ừ", "được", "để lần sau", "không cần thêm", "thế nhé", "ship giúp chị", "chị lấy vậy thôi", "1kg bao nhiêu em?"]) assert.equal(applyCustomerCartMessage(c1, m, 9, NOW()), c1, `«${m}» không đổi giỏ`);
  // Sửa tường minh.
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "thôi lấy 3kg")), [["chả cá thu", 3000, "g", true]]);
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "bớt 1kg")), [["chả cá thu", 1000, "g", true]]);
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "thêm 1kg nữa")), [["chả cá thu", 3000, "g", true]]);
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "lấy thêm 1kg chả mực")), [["chả cá thu", 2000, "g", true], ["chả mực", 1000, "g", true]]);
  assert.deepEqual(qty(cartOf("2kg chả cá + 1kg chả mực", "không lấy chả cá nữa")), [["chả mực", 1000, "g", true]]);
  assert.deepEqual(qty(cartOf("2kg chả cá + 1kg chả mực", "đổi chả mực còn 2kg")), [["chả cá", 2000, "g", true], ["chả mực", 2000, "g", true]]);
  assert.deepEqual(qty(cartOf("Cho chị 2kg chả cá thu", "thôi không lấy nữa")), [], "huỷ cả đơn ⇒ giỏ rỗng");
  // Hai món mà câu sửa không nêu tên ⇒ KHÔNG đổi, hỏi lại.
  const two = cartOf("2kg chả cá + 1kg chả mực", "đổi còn 1kg");
  assert.deepEqual(qty(two), [["chả cá", 2000, "g", true], ["chả mực", 1000, "g", true]], "không rõ món ⇒ giữ nguyên");
  assert.match(two?.clarify ?? "", /chưa rõ món nào/);
  // Số lượng kèm câu hỏi giá: thêm món MỚI được, sửa món đã có thì không.
  assert.equal(classifyCartMessage("lấy 2kg chả cá thu bao nhiêu em").tentative, true);
  assert.deepEqual(qty(cartOf("lấy 2kg chả cá thu bao nhiêu em")), [["chả cá thu", 2000, "g", true]]);
  const c3 = cartOf("Cho chị 3kg chả cá thu");
  assert.equal(applyCustomerCartMessage(c3, "lấy 2kg bao nhiêu em", 2, NOW()), c3, "câu hỏi không hạ 3kg");
  assert.deepEqual(qty(cartOf("Cho chị 2kg", "2kg chả cá thu nhé")), [["chả cá thu", 2000, "g", true]], "món chưa rõ tên được đặt tên, không thành món thứ hai");
  // Tin nguồn = lượt khách nói.
  assert.equal(cartOf("Cho chị 2kg chả cá thu", "ok", "đổi 1kg thôi")?.selectedItems[0].sourceMessageId, 3);
}

const L = (productId: string, variantId: string, name: string, quantity: number, weightGrams: number | null): AskedLine => ({ productId, variantId, name, quantity, weightGrams });

function testViolation() {
  const c = cartOf("Cho chị 2kg chả cá thu");
  // 2kg = gói 2kg × 1 = 2 × gói 1kg — cùng sản phẩm, cùng khối lượng ⇒ được.
  assert.equal(commitmentViolation(c, [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000)]), null);
  assert.equal(commitmentViolation(c, [L("p-cct", "v1", "Chả cá thu (1kg)", 2, 1000)]), null);
  // Hạ xuống 1kg ⇒ từ chối, câu lỗi nói đúng số khách nói.
  const v = commitmentViolation(c, [L("p-cct", "v1", "Chả cá thu (1kg)", 1, 1000)]);
  assert.match(v ?? "", /hạ «chả cá thu» từ 2kg xuống 1kg/);
  assert.match(v ?? "", /tin #1/);
  // Tăng / thêm món khác (mời thêm món) ⇒ được.
  assert.equal(commitmentViolation(c, [L("p-cct", "v1", "Chả cá thu (1kg)", 3, 1000)]), null);
  assert.equal(commitmentViolation(c, [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000), L("p-muc", "m1", "Chả mực (1kg)", 1, 1000)]), null);
  // Đổi sang món KHÁC (bỏ chả cá) ⇒ từ chối khi đã gắn sản phẩm.
  const bound = bindCommitment(c, [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000)], 1, NOW());
  assert.equal(bound?.selectedItems[0].productId, "p-cct");
  assert.match(commitmentViolation(bound, [L("p-muc", "m1", "Chả mực (1kg)", 2, 1000)]) ?? "", /bỏ «chả cá thu»/);
  // Sau câu sửa tường minh của khách ⇒ đơn 1kg được.
  const fixed = applyCustomerCartMessage(bound, "đổi 1kg thôi", 2, NOW());
  assert.equal(commitmentViolation(fixed, [L("p-cct", "v1", "Chả cá thu (1kg)", 1, 1000)]), null);
  // Giỏ chưa có tên món («Cho chị 2kg») + đơn một sản phẩm ⇒ vẫn gắn / kiểm được.
  const noName = cartOf("Cho chị 2kg");
  assert.match(commitmentViolation(noName, [L("p-cct", "v1", "Chả cá thu (1kg)", 1, 1000)]) ?? "", /xuống 1kg/);
  // Không đo được (mẫu mã thiếu khối lượng) ⇒ không đoán, không chặn.
  assert.equal(commitmentViolation(c, [L("p-cct", "vx", "Chả cá thu", 1, null)]), null);
  // Hai món, đơn bỏ một dòng ⇒ từ chối.
  const two = bindCommitment(cartOf("2kg chả cá + 1kg chả mực"), [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000), L("p-muc", "m1", "Chả mực giã tay (1kg)", 1, 1000)], 1, NOW());
  assert.deepEqual(two?.selectedItems.map((x) => x.productId), ["p-cct", "p-muc"]);
  assert.match(commitmentViolation(two, [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000)]) ?? "", /bỏ «chả mực»/);
  // Món bot đề xuất (khách nhận lời mời bằng «ok») ⇒ ghi customerExplicit = false, KHÔNG dính.
  const up = bindCommitment(bound, [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000), L("p-muc", "m1", "Chả mực (1kg)", 1, 1000)], 3, NOW());
  assert.deepEqual(up?.selectedItems.map((x) => [x.productId, x.customerExplicit, x.quantity]), [["p-cct", true, 2000], ["p-muc", false, 1000]]);
  assert.equal(commitmentViolation(up, [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000)]), null, "bỏ món bot đề xuất ⇒ được");
}

function testHoldText() {
  const c = bindCommitment(cartOf("Cho chị 2kg chả cá thu"), [L("p-cct", "v2", "Chả cá thu (2kg)", 1, 2000)], 1, NOW());
  // Câu thật của ca production.
  const h = cartHoldVerdict("Mình lấy 1kg ăn thử trước nhé, ngon thì lần sau lấy thêm ạ", c);
  assert.equal(h?.reason, "TRIAL");
  assert.equal(h?.safeText, "Dạ, em giữ đơn 2kg chả cá thu như mình đã chọn nhé.");
  assert.equal(holdCartText(c!), "Dạ, em giữ đơn 2kg chả cá thu như mình đã chọn nhé.");
  assert.equal(cartHoldVerdict("Dạ mình lấy 1kg trước cũng được ạ", c)?.reason, "DOWNSELL");
  assert.equal(cartHoldVerdict("Chị lấy mấy kg ạ?", c)?.reason, "REASK");
  assert.equal(cartHoldVerdict("Chị lấy 1kg hay 2kg ạ?", c)?.reason, "REASK");
  // Qua: nói lại đúng số, giải thích quy gói, mời THÊM món, trả lời đúng câu khách hỏi về 1kg.
  for (const ok of ["Dạ 2kg chả cá thu 540.000 ₫ ạ.", "Dạ 2kg là 2 gói 1kg, tổng 540.000 ₫ ạ.", "Mình lấy thêm 0,5kg chả mực không ạ?", "Mình lấy thêm 0,5kg chả mực ăn thử không ạ?", "Dạ em lên đơn 2kg chả cá thu cho mình rồi ạ."]) assert.equal(cartHoldVerdict(ok, c), null, ok);
  assert.equal(cartHoldVerdict("Dạ 1kg 280.000 ₫ ạ.", c, "1kg thì bao nhiêu em?"), null, "khách hỏi 1kg ⇒ bot trả lời, không phải hạ số lượng");
  assert.equal(cartHoldVerdict("Mình lấy 1kg ăn thử trước nhé", undefined), null, "giỏ chưa có số khách nói ⇒ không chặn");
  // Đơn giá theo đơn vị không phải đề nghị lấy ít hơn (ai-provider-failover: «Cho chị 2 gói» → «chả mực 400.000đ một gói»).
  assert.equal(cartHoldVerdict("Dạ chả mực 400.000đ một gói ạ.", cartOf("Cho chị 2 gói")), null);
  assert.equal(cartHoldVerdict("Dạ 1kg 280.000 ₫, 2kg 540.000 ₫ ạ.", c), null);
  assert.equal(cartHoldVerdict("Dạ chả cá 280k/1kg ạ, mình lấy 1kg trước nhé?", c)?.reason, "DOWNSELL", "đơn giá kèm lời đề nghị lấy ít hơn vẫn bị bắt");
}

function testReadinessAndPrompt() {
  const one = cartOf("Cho chị 2kg chả cá thu\nĐT 0368571285\nF4/22A ấp 4, xã Bà Điểm, Hóc Môn, TP Hồ Chí Minh");
  const text = "Cho chị 2kg chả cá thu\nĐT 0368571285\nF4/22A ấp 4, xã Bà Điểm, Hóc Môn, TP Hồ Chí Minh";
  assert.deepEqual(orderReadiness({ cart: one, blocker: null, lastUserText: text, hesitating: false }), { level: "ORDER_READY", missing: null }, "G6: một tin đủ món + số lượng + SĐT + địa chỉ ⇒ ORDER_READY");
  assert.equal(orderReadiness({ cart: cartOf("Cho chị 2kg chả cá thu, ĐT 0368571285"), blocker: null, lastUserText: "Cho chị 2kg chả cá thu, ĐT 0368571285", hesitating: false }).level, "NEED_ADDRESS", "thiếu địa chỉ ⇒ chỉ hỏi địa chỉ");
  assert.equal(orderReadiness({ cart: cartOf("Cho chị 2kg chả cá thu"), blocker: null, lastUserText: "Cho chị 2kg chả cá thu", hesitating: false }).level, "NEED_PHONE");
  assert.equal(orderReadiness({ cart: undefined, blocker: null, lastUserText: "chả cá bao nhiêu", hesitating: false }).level, "BROWSING");
  // Có đơn nháp ⇒ đúng điều kiện P0-A.
  const draft = { lines: [{ variantId: "v1", quantity: 2 }], recipient: { phone: "0368571285", address: "F4/22A ấp 4, xã Bà Điểm, Hóc Môn, TP Hồ Chí Minh", province: "" }, quote: { subtotal: 540_000, total: 570_000 } };
  assert.equal(orderReadiness({ cart: one, draft, blocker: null, lastUserText: "ok", hesitating: false }).level, "ORDER_READY");
  assert.equal(orderReadiness({ cart: one, draft, blocker: "Địa chỉ chưa đủ để giao (chưa đọc được tỉnh / thành) — hỏi khách đúng phần còn thiếu", lastUserText: "ok", hesitating: false }).level, "NEED_ADDRESS");
  assert.equal(orderReadiness({ cart: one, draft, confirmed: {}, blocker: null, lastUserText: "ok", hesitating: false }).level, "CONFIRMED");
  const p = cartCommitmentPrompt({ cart: one, customer: { phone: "0368571285", address: draft.recipient.address, province: "" }, draft }, { level: "ORDER_READY", missing: null }, { autoConfirm: true });
  assert.match(p, /ĐƠN HIỆN TẠI — TRẠNG THÁI THẨM QUYỀN/);
  assert.match(p, /2kg chả cá thu — khách nói TƯỜNG MINH ở tin #1, CỐ ĐỊNH/);
  assert.match(p, /540\.000 ₫ \(giá MÁY CHỦ/);
  assert.match(p, /SĐT: đã có \(…285\)/, "SĐT chỉ ba số cuối");
  assert.ok(!p.includes("0368571285"));
  assert.match(p, /ORDER_READY — đủ để chốt ⇒ gọi update_draft_order/);
  assert.match(p, /KHÔNG gợi ý gói ăn thử/);
  assert.equal(cartCommitmentPrompt({}, { level: "BROWSING", missing: null }), "", "chưa có số khách nói ⇒ lời nhắc không đổi");
}

function testHesitation() {
  // «không lấy thêm» = đủ rồi (giữ đơn) — trước đây biểu thức hoãn bắt nhầm «không lấy» và chặn tự chốt.
  for (const t of ["không lấy thêm đâu", "khong lay them dau", "không lấy gì nữa", "ko lấy thêm", "thôi không lấy thêm"]) assert.equal(customerHesitates(t), false, t);
  for (const t of ["để chị hỏi chồng đã", "chưa chốt đâu em", "không lấy đâu", "thôi không mua", "để lần sau"]) assert.equal(customerHesitates(t), true, t);
  assert.equal(declinesAddOnOnly("để lần sau nhé em"), true);
  assert.equal(declinesAddOnOnly("không cần thêm"), true);
  assert.equal(declinesAddOnOnly("để chị suy nghĩ, lần sau nhé"), false, "hoãn thật ⇒ không phải chỉ từ chối lời mời");
  // Sau lời mời thêm món + giỏ có số khách nói ⇒ «để lần sau» KHÔNG chặn tự chốt; không có lời mời ⇒ vẫn là hoãn.
  const recipient = { name: "Lệ", phone: "0981234567", address: "9 Hai Bà Trưng, Phường Hoàn Kiếm, Hà Nội", province: "" };
  const st: ChatState = { customer: { id: "c", name: "Lệ", phone: recipient.phone, address: recipient.address, province: "", simulated: false }, draft: { orderId: null, lines: [{ variantId: "v1", quantity: 2 }], unitPrices: { v1: 280_000 }, recipient, note: "", simulated: false, quote: { id: "q", priceVersion: "p", subtotal: 540_000, total: 570_000 } }, cart: cartOf("Chị lấy 2kg chả cá thu") };
  assert.equal(autoConfirmBlocker({ ...st, upsellSent: true, upsellTurn: 1 }, { lastUserText: "để lần sau em", turn: 2 }), null);
  assert.match(autoConfirmBlocker(st, { lastUserText: "để lần sau em", turn: 2 }) ?? "", /chưa quyết mua/);
  assert.equal(autoConfirmBlocker(st, { lastUserText: "không lấy thêm đâu", turn: 2 }), null);
}

// ═══ MA TRẬN G QUA chatTurn THẬT ═══

const RULE_ON = { enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "PER_STEP" as const };
const CFG: Partial<SalesChatbotConfig> = { volumeDiscount: RULE_ON, sellWithoutStockCheck: true, shippingFee: 30_000 };
const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const HOLD = "Dạ, em giữ đơn 2kg chả cá thu như mình đã chọn nhé.";
const SUMMARY = "Tóm tắt: 2kg chả cá thu 540.000 ₫ · ship 30.000 ₫ · tổng 570.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?";

/** Lượt mở đầu chung: món + 2kg + SĐT + địa chỉ ⇒ lưu khách + đơn nháp 2kg (gói 2kg × 1). */
const opening = (name: string, phone: string, say1 = `Cho chị 2kg chả cá thu, ${name} ${phone}, ${ADDR}`) => ({
  say: say1,
  ai: [() => [tool("create_customer", { name, phone, address: ADDR })], ({ v }: { v: (s: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })], () => [say(SUMMARY)]],
});

const MATRIX: GoldenCase[] = [
  {
    key: "gc-g1-ok",
    title: "G1: «Cho chị 2kg» → «ok» ⇒ giữ 2kg (model cố hạ 1kg bị từ chối, rồi chốt đúng 2kg)",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      opening("Ngọc", "0961000001"),
      { say: "ok", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [tool("confirm_order", { customer_confirmation: "ok" })], () => [say("Dạ em lên đơn cho mình rồi ạ.")]] },
    ],
  },
  {
    key: "gc-g2-ngon-moi-lay",
    title: "G2 (ca production): «Cho chị 2kg» → «Ngon chị mới lấy nha em» ⇒ 2kg: model gọi update_draft_order hạ 1kg ⇒ máy chủ từ chối; câu «1kg ăn thử» ⇒ thay bằng câu giữ đơn",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      opening("Hồng", "0961000002"),
      { say: "Ngon chị mới lấy nha em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [say("Mình lấy 1kg ăn thử trước nhé, ngon thì lần sau lấy thêm ạ")]] },
    ],
  },
  {
    key: "gc-g3-khong-lay-them",
    title: "G3: «Cho chị 2kg» → «không lấy thêm đâu» ⇒ 2kg",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      opening("Lan", "0961000003"),
      { say: "không lấy thêm đâu", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [tool("confirm_order", { customer_confirmation: "không lấy thêm đâu" })], () => [say("Dạ em lên đơn cho mình rồi ạ.")]] },
    ],
  },
  {
    key: "gc-g4-doi-1kg",
    title: "G4: «Cho chị 2kg» → «đổi 1kg thôi» ⇒ 1kg (câu sửa tường minh ⇒ máy chủ nhận)",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      opening("Mai", "0961000004"),
      { say: "đổi 1kg thôi", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [say("Dạ em sửa còn 1kg chả cá thu 280.000 ₫ ạ.")]] },
    ],
  },
  {
    key: "gc-g5-hai-dong",
    title: "G5: «2kg chả cá + 1kg chả mực» → «thế thôi» ⇒ giữ nguyên hai dòng (model cố bỏ chả mực bị từ chối)",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `2kg chả cá + 1kg chả mực, Thu 0961000005, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Thu", phone: "0961000005", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          () => [say("Tóm tắt: 2kg chả cá thu 540.000 ₫ + 1kg chả mực 400.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
        ],
      },
      { say: "thế thôi", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })], () => [say("Dạ vâng ạ.")]] },
    ],
  },
];

const READY: GoldenCase[] = [
  {
    key: "gc-g6-mot-tin",
    title: "G6: món + số lượng + SĐT + địa chỉ trong MỘT tin ⇒ ORDER_READY ngay: đơn tạo + tự chốt, giá máy chủ 2kg = 540.000 ₫",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Cho chị 2kg chả cá thu\nĐT 0368571285\n${ADDR}`,
        ai: [
          () => [tool("create_customer", { phone: "0368571285", address: ADDR, name: "Khách" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 2 }] })],
          () => [say("Dạ em lên đơn 2kg chả cá thu cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.")],
        ],
      },
    ],
  },
  {
    key: "gc-g6-tu-chot-roi-ha",
    title: "Đơn đã tự chốt 2kg, khách «Ngon chị mới lấy nha em» ⇒ model cố sửa đơn đã chốt xuống 1kg ⇒ từ chối, đơn vẫn 2kg",
    shop: "food",
    channel: "WEB",
    config: CFG,
    turns: [
      {
        say: `Cho chị 2kg chả cá thu, Thảo 0961000007, ${ADDR}`,
        ai: [() => [tool("create_customer", { name: "Thảo", phone: "0961000007", address: ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-2KG"), quantity: 1 }] })], () => [say("Dạ em lên đơn 2kg chả cá thu cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.")]],
      },
      { say: "Ngon chị mới lấy nha em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [say("Dạ chị yên tâm, hàng chuẩn ạ.")]] },
    ],
  },
];

async function seedCct(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (ctx.ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const r = await createProductCore(admin, { name: "Chả cá thu", code: "CCT", unit: "gói", retailPrice: 280_000, cost: null, variants: [{ sku: "CCT-1KG", size: "1kg", color: "", retailPrice: 280_000, cost: null, selling: true }, { sku: "CCT-2KG", size: "2kg", color: "", retailPrice: 540_000, cost: null, selling: true }] });
  assert.ok(r.ok, JSON.stringify(r));
  const db = await getDb();
  const vs = await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id));
  for (const v of vs) (ctx.ids as Map<string, string>).set(v.sku, v.id);
}

async function orderOf(conversationId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  const state = (row.state ?? {}) as ChatState;
  const orderId = state.confirmed?.orderId ?? state.draft?.orderId ?? null;
  const [o] = orderId ? await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)) : [];
  const items = orderId ? await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)) : [];
  return { state, order: o ?? null, items };
}

/** Tổng khối lượng (gram) theo SKU gốc của sản phẩm trên ĐƠN THẬT. */
const gramsOf = (items: readonly { variantId: string | null; quantity: number }[], ids: ReadonlyMap<string, string>) => {
  const sum = (skus: [string, number][]) => items.reduce((t, i) => t + (skus.find(([sku]) => ids.get(sku) === i.variantId)?.[1] ?? 0) * i.quantity, 0);
  return { cct: sum([["CCT-1KG", 1000], ["CCT-2KG", 2000]]), muc: sum([["CHA-MUC", 1000]]) };
};

async function testMatrix() {
  const seen = new Set<string>();
  await runGoldenCases(MATRIX, {
    orgSuffix: "-cc1",
    beforeCase: async (_c, ctx) => seedCct(ctx),
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const { state, order, items } = await orderOf(ctx.conversationId);
      assert.ok(order, `[${c.key}] có đơn`);
      const g = gramsOf(items, ctx.ids);
      const r2 = JSON.stringify(t.turns[1].rounds.map((r) => r.results));
      // Lời nhắc lượt 2 mang trạng thái thẩm quyền.
      const prompt2 = t.prompts[t.turns[1].rounds[0].prompt];
      assert.match(prompt2, /ĐƠN HIỆN TẠI — TRẠNG THÁI THẨM QUYỀN/, `[${c.key}] lời nhắc có khối ĐƠN HIỆN TẠI`);
      if (c.key === "gc-g4-doi-1kg") {
        assert.equal(g.cct, 1000, "G4: khách sửa tường minh ⇒ đơn 1kg");
        assert.equal(order.totalPriceAfterDiscount, 280_000);
        assert.ok(!/hạ số lượng|KHÔNG được hạ/.test(r2), r2.slice(0, 300));
        assert.deepEqual(state.cart?.selectedItems.map((x) => [x.quantity, x.customerExplicit]), [[1000, true]]);
        assert.match(prompt2, /1kg chả cá thu — khách nói TƯỜNG MINH ở tin #/);
        return;
      }
      assert.match(r2, /KHÔNG được (?:hạ|bỏ)/, `[${c.key}] máy chủ từ chối hạ / bỏ: ${r2.slice(0, 400)}`);
      if (c.key === "gc-g5-hai-dong") {
        assert.deepEqual(g, { cct: 2000, muc: 1000 }, "G5: giữ nguyên hai dòng");
        assert.match(r2, /bỏ «chả mực»/);
        return;
      }
      assert.equal(g.cct, 2000, `[${c.key}] giữ 2kg`);
      assert.equal(order.totalPriceAfterDiscount, 540_000, `[${c.key}] giá máy chủ 2kg = 540.000 ₫`);
      assert.match(prompt2, /2kg chả cá thu — khách nói TƯỜNG MINH ở tin #/);
      assert.match(prompt2, /KHÔNG đề xuất ít hơn, KHÔNG gợi ý gói ăn thử/);
      if (c.key === "gc-g2-ngon-moi-lay") {
        assert.deepEqual(t.turns[1].shown, [HOLD], "câu «1kg ăn thử» KHÔNG tới khách — câu giữ đơn thay chỗ");
        assert.notEqual(t.final.status, "HANDOFF", "giữ đơn không phải chuyển người");
        return;
      }
      // G1 / G3: sau lần hạ bị từ chối, chốt ĐÚNG đơn 2kg.
      assert.equal(order.stage, "CONFIRMED", `[${c.key}] chốt đúng đơn 2kg`);
    },
  });
  assert.deepEqual([...seen].sort(), MATRIX.map((c) => c.key).sort());
}

async function testReady() {
  const seen = new Set<string>();
  await runGoldenCases(READY, {
    orgSuffix: "-cc2",
    beforeCase: async (_c, ctx) => {
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
      await seedCct(ctx);
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const { state, order, items } = await orderOf(ctx.conversationId);
      assert.ok(order, "có đơn");
      assert.equal(gramsOf(items, ctx.ids).cct, 2000);
      assert.equal(order.totalPriceAfterDiscount, 540_000, "giá máy chủ 2kg = 540.000 ₫ (2 × 1kg − 20.000)");
      assert.equal(order.stage, "CONFIRMED", "tự chốt theo P0-A");
      if (c.key === "gc-g6-mot-tin") {
        const p1 = t.prompts[t.turns[0].rounds[0].prompt];
        assert.match(p1, /Mức sẵn sàng: ORDER_READY — đủ món \+ số lượng \+ SĐT \+ địa chỉ ⇒ create_customer rồi create_draft_order NGAY/, "một tin ⇒ ORDER_READY ngay ở lời nhắc lượt đầu");
        assert.equal(state.stage, "DONE");
        assert.equal(t.turns[0].rounds.length, 3, "không vòng hỏi thêm nào");
        return;
      }
      const r2 = JSON.stringify(t.turns[1].rounds.map((r) => r.results));
      assert.match(r2, /KHÔNG được hạ «chả cá thu» từ 2kg xuống 1kg/, r2.slice(0, 400));
      assert.equal(state.confirmed?.total, 570_000, "đơn đã chốt giữ nguyên tổng (540.000 ₫ + ship 30.000 ₫)");
    },
  });
  assert.deepEqual([...seen].sort(), READY.map((c) => c.key).sort());
}

export async function testSalesCartCommitment() {
  testClassify();
  testApply();
  testViolation();
  testHoldText();
  testReadinessAndPrompt();
  testHesitation();
  await testMatrix();
  await testReady();
  console.log("  ✓ giỏ có thẩm quyền (cart-commitment.ts): số lượng khách nói tường minh DÍNH — câu mơ hồ («ok», «ngon chị mới lấy nha em», «không lấy thêm», «để lần sau», «thế thôi») không đổi giỏ, chỉ câu sửa tường minh mới đổi; công cụ ghi đơn hạ / bỏ món khách đã chốt ⇒ máy chủ từ chối; câu bot «1kg ăn thử» ⇒ câu giữ đơn; lời nhắc mang ĐƠN HIỆN TẠI + mức sẵn sàng; ma trận G1–G6 qua chatTurn thật (2kg = 540.000 ₫, một tin đủ ⇒ tự chốt)");
}

if (process.argv[1] && /sales-cart-commitment.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testSalesCartCommitment)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

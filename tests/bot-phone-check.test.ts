/**
 * P0 HSLC 30/10/2026 — hội thoại «Tài Tâm»: khách gõ «094655545» (9 chữ số, thiếu một), bot lưu khách, lên đơn và đơn tự «Đã xác
 * nhận» với ô SĐT tô OK. Luật cũ chỉ đòi 8–15 chữ số. Bài này khoá:
 *  · THUẦN `orderPhoneProblem`: số dáng Việt Nam (0 / 84) phải đúng `phoneWellFormed`; số nước ngoài giữ 8–15 chữ số;
 *  · `manualOrderGaps` (công tắc «đơn đủ thông tin = đã xác nhận», nút «Xác nhận đơn») và ô SĐT của panel đơn cùng một luật;
 *  · công cụ bot: `create_customer` từ chối SĐT sai và KHÔNG lưu khách; `create_draft_order` từ chối khi SĐT người nhận (kể cả SĐT
 *    khách đã lưu trước bản vá) sai hình dạng.
 */
import assert from "node:assert/strict";
import { manualOrderGaps, orderPhoneProblem } from "@/lib/constants/manual-orders";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { orderVerification, type ConversationOrderSummary } from "@/lib/sales-chatbot/order-verification-shared";
import { executeTool, type ChatState } from "@/lib/sales-chatbot/tools";

const AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/tools.ts" };
const MSG = "Mua 1kí 280k 094655545 tài tâm đổ huy liêu thanh châu phủ lý hà nam";

export function testBotPhoneCheckPure() {
  assert.equal(orderPhoneProblem("0946555451"), null, "10 số bắt đầu 0 ⇒ được");
  assert.equal(orderPhoneProblem("094 655 5451"), null, "khoảng trắng không tính");
  assert.equal(orderPhoneProblem("+84946555451"), null, "+84 + 9 số ⇒ được");
  assert.equal(orderPhoneProblem("+1 415 555 0100"), null, "số nước ngoài giữ luật 8–15 chữ số");
  assert.match(orderPhoneProblem("094655545") ?? "", /9 chữ số/, "ca «Tài Tâm»: 9 số ⇒ sai, câu báo nêu số chữ số");
  assert.match(orderPhoneProblem("09465554511") ?? "", /11 chữ số/, "thừa một số ⇒ sai");
  assert.equal(orderPhoneProblem(""), "Chưa có SĐT");

  const recipient = { phone: "094655545", address: "Đổ Huy Liêu, Thanh Châu, Phủ Lý, Hà Nam", province: "Tỉnh Ninh Bình", ward: "Phường Phủ Lý" };
  assert.deepEqual(manualOrderGaps(recipient, 1), ["SĐT"], "đơn SĐT 9 số KHÔNG đủ thông tin ⇒ không tự «Đã xác nhận»");
  assert.deepEqual(manualOrderGaps({ ...recipient, phone: "0946555451" }, 1), [], "sửa đủ 10 số ⇒ đủ thông tin");

  const summary: ConversationOrderSummary = {
    orderId: "erp-x",
    shortCode: "X",
    stage: "NEW",
    stageLabel: "Mới",
    manual: true,
    byBot: true,
    insertedAt: "2026-10-30T02:12:00.000Z",
    hasShipment: false,
    recipient: { name: "Tài Tâm", phone: "094655545", address: recipient.address, province: recipient.province, district: "", ward: recipient.ward },
    lines: [{ sku: "CHA-CA-THU", productName: "Chả cá thu", variation: "1kg", quantity: 1, unitPrice: 280_000, discount: 0, lineTotal: 280_000, isBonus: false, variantId: "v1", variantKnown: true, variantRemoved: false }],
    itemsCount: 1,
    money: { goods: 280_000, discount: 0, shipping: 0, shippingNote: null, total: 280_000 },
    review: [],
    reconfirms: [],
    otherActive: 0,
  };
  const v = orderVerification(summary);
  assert.equal(v.fields.phone.state, "THIẾU", "panel đơn: ô SĐT 9 số không được tô OK");
  assert.match(v.fields.phone.reason ?? "", /9 chữ số/);
  assert.notEqual(v.state, "ĐỦ THÔNG TIN");
}

export async function testBotPhoneCheckTools() {
  const ctx = (state: ChatState, last: string, turn: number) => ({ conversationId: "conv-phone", channel: "TEST" as const, config: parseSalesChatbotConfig(null), state, lastUserText: last, agent: AGENT, turn, customerTexts: [last] });

  const cc = await executeTool("create_customer", { name: "Tài Tâm", phone: "094655545", address: "Đổ Huy Liêu, Thanh Châu, Phủ Lý, Hà Nam" }, ctx({}, MSG, 2));
  assert.equal(cc.isError, true, `SĐT 9 số ⇒ create_customer phải lỗi (nhận: ${cc.summary})`);
  assert.match(cc.content, /hỏi lại khách/, "lời dặn model: hỏi lại khách, không tự thêm / bớt chữ số");
  assert.equal(cc.state.customer, undefined, "KHÔNG lưu khách với SĐT sai");

  // SĐT khách đã lưu TRƯỚC bản vá (hội thoại đang dở) ⇒ lên đơn vẫn bị chặn.
  const legacy: ChatState = { customer: { id: null, name: "Tài Tâm", phone: "094655545", address: "Đổ Huy Liêu, Thanh Châu, Phủ Lý, Hà Nam", province: "", simulated: true } };
  const draft = await executeTool("create_draft_order", { items: [{ variant_id: "v1", quantity: 1 }] }, ctx(legacy, "ok em", 3));
  assert.equal(draft.isError, true, `SĐT người nhận 9 số ⇒ không lên đơn (nhận: ${draft.summary})`);
  assert.match(draft.summary, /SĐT/);
  assert.equal(draft.state.draft, undefined, "không có đơn nháp nào được tạo");
}

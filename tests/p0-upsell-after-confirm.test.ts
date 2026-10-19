/**
 * P0 19/10/2026 — BOT BỎ LỠ LỜI MỜI MUA THÊM KHI CHỐT ĐƠN (HSLC, ca «Trung Dinh», đã che tên / SĐT / địa chỉ):
 *
 *  · Khách chọn 1kg chả cá thu, gửi SĐT + địa chỉ ⇒ đơn tự chốt 280.000 ₫, bot cảm ơn, không mời gì. Truy vết production: KHÔNG có lời
 *    mời nào được tạo ra (sổ sự kiện 0 lời mời, máy chủ 0 lần bỏ) — lượt duy nhất cửa sổ còn mở (khách chọn 1kg, chưa gửi thông tin) bị
 *    hàng rào «không hỏi lại thông tin nhận hàng» chặn câu và chuyển người; lượt sau khách gửi SĐT + địa chỉ ⇒ `offerWindow` đóng
 *    (CONTACT_INFO · ORDERING · CONFIRMED) và lời nhắc B4 chỉ cho mời TRƯỚC khi có thông tin nhận hàng.
 *  · Bản sửa (mở rộng lõi #868, không làm lại): SAU khi đơn chốt thành công, máy chủ quyết MỘT lời mời (`postConfirmOfferWindow` +
 *    `crossSellOffers` — món bổ trợ shop khai, giá đã xác thực, còn hàng) và engine gắn câu vào cuối TIN XÁC NHẬN, sau mọi hàng rào.
 *
 * Ca: chốt nhanh đủ thông tin ⇒ mời · «ok» không phải đồng ý mua thêm · khách gọi tên món ⇒ thêm vào đơn đã tự chốt · đã từ chối /
 * đã được mời ⇒ không mời lại · đơn chốt bằng lời đồng ý ⇒ mời được, sửa đơn là việc của người · vận đơn đã chạy ⇒ không sửa, chuyển
 * người · món kèm hết hàng ⇒ không mời · khiếu nại / đơn chưa qua kiểm ⇒ không mời (thuần).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";
import { stockFor } from "@/lib/sales-chatbot/catalog";
import { confirmedAddIssue, isShortYes, pickPostConfirmOffer, postConfirmOfferText, postConfirmOfferWindow } from "@/lib/sales-chatbot/next-best-action";
import { SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

function testThuan() {
  const base = { upsellSent: undefined, upsellDeclinedTurn: undefined, handoff: undefined, confirmed: undefined, declined: undefined, cancelRequest: undefined, priceDispute: undefined, customer: undefined, draft: undefined, pastOrders: undefined } as unknown as ChatState;
  assert.deepEqual(postConfirmOfferWindow({ state: base, complaint: false, orderValid: true }), { open: true });
  assert.deepEqual(postConfirmOfferWindow({ state: base, complaint: true, orderValid: true }), { open: false, reason: "COMPLAINT" });
  assert.deepEqual(postConfirmOfferWindow({ state: base, complaint: false, orderValid: false }), { open: false, reason: "ORDER_PROBLEM" }, "đơn chưa qua kiểm ⇒ không mời");
  assert.deepEqual(postConfirmOfferWindow({ state: { ...base, upsellSent: true }, complaint: false, orderValid: true }), { open: false, reason: "ALREADY_OFFERED" });
  assert.deepEqual(postConfirmOfferWindow({ state: { ...base, upsellDeclinedTurn: 3 }, complaint: false, orderValid: true }), { open: false, reason: "DECLINED" });
  assert.deepEqual(postConfirmOfferWindow({ state: { ...base, cancelRequest: { at: "x" } } as unknown as ChatState, complaint: false, orderValid: true }), { open: false, reason: "ORDER_PROBLEM" }, "đang xin huỷ ⇒ không mời");
  assert.deepEqual(postConfirmOfferWindow({ state: { ...base, handoff: { reason: "x", at: "x" } }, complaint: false, orderValid: true }), { open: false, reason: "HANDOFF" });
  const offers = [
    { name: "Chả cá thu", productId: "p1", variantId: "v1", variant: "0,5kg", price: 140_000 },
    { name: "Chả mực giã tay", productId: "p2", variantId: "v2", variant: "Size: 0,5kg", price: 200_000 },
  ];
  assert.equal(pickPostConfirmOffer(["p1"], offers)?.name, "Chả mực giã tay", "không mời lại món đơn đã có (so theo sản phẩm)");
  assert.equal(pickPostConfirmOffer(["p1", "p2"], offers), null, "hết món bổ trợ ⇒ không mời");
  assert.equal(pickPostConfirmOffer(["p9"], []), null, "không có món kèm đủ điều kiện (hết hàng / giá chưa xác thực đã bị lọc ở offer-facts) ⇒ không mời");
  const line = postConfirmOfferText(offers[1], formatVND);
  assert.match(line, /^Bên em có thêm Chả mực giã tay \(0,5kg\) giá 200\.000 ₫ .*nhắn em «thêm chả mực giã tay 0,5kg»/, "câu gợi ý mang quy cách đã mời (NB1)");
  // NB3: không mời món CÙNG HỌ với món khách vừa mua.
  const fam = [{ name: "Chả cá hấp", productId: "p3", variantId: "v3", variant: "1kg", price: 300_000 }, ...offers];
  assert.equal(pickPostConfirmOffer(["p1"], fam, ["Chả cá thu (Size: 1kg)"])?.name, "Chả mực giã tay", "mua chả cá thu ⇒ không mời chả cá hấp");
  // Review vòng 2: thêm món vào đơn đã chốt — chữ MUA phải gọi tên món; câu hỏi giá / câu từ chối không phải; tên bỏ chữ đầu vẫn nhận;
  // món vừa mời phải đúng mẫu mã đã mời (khối lượng khách nói phải khớp).
  const mucNew = [{ productId: "p2", variantId: "v2", name: "Chả mực giã tay (Size: 0,5kg)", quantity: 1, weightGrams: 500 }];
  const offerRef = { productId: "p2", variantId: "v2", name: "Chả mực giã tay", variant: "Size: 0,5kg", price: 200_000, sent: true };
  assert.equal(confirmedAddIssue(mucNew, offerRef, "chả mực giã tay bao nhiêu em")?.kind, "UNNAMED", "câu hỏi giá không phải lời mua");
  assert.equal(confirmedAddIssue(mucNew, offerRef, "chả mực giã tay thì thôi em")?.kind, "UNNAMED", "câu từ chối không phải lời mua");
  assert.equal(confirmedAddIssue(mucNew, offerRef, "thêm mực giã tay nhé em"), null, "tên bỏ chữ đầu vẫn là gọi tên");
  assert.equal(confirmedAddIssue(mucNew, offerRef, "thêm chả mực giã tay 0,5kg"), null);
  const okAdd = confirmedAddIssue(mucNew, offerRef, "ok thêm giúp chị");
  assert.equal(okAdd?.kind, "UNNAMED");
  assert.equal(okAdd?.ask, "Mình muốn thêm Chả mực giã tay (0,5kg) vào đơn đúng không ạ?", "có ý thêm mà chưa gọi tên ⇒ hỏi ĐÚNG một câu, không im lặng");
  const muc1kg = [{ productId: "p2", variantId: "v2-1kg", name: "Chả mực giã tay (Size: 1kg)", quantity: 1, weightGrams: 1000 }];
  assert.equal(confirmedAddIssue(muc1kg, offerRef, "thêm chả mực giã tay 0,5kg")?.kind, "WRONG_VARIANT", "mời 0,5kg mà chọn mẫu mã 1kg ⇒ không");
  assert.equal(confirmedAddIssue(muc1kg, offerRef, "thêm chả mực giã tay nhé")?.kind, "WRONG_VARIANT", "không nói khối lượng ⇒ đúng mẫu mã đã mời");
  assert.equal(confirmedAddIssue(muc1kg, offerRef, "thêm 1kg chả mực giã tay"), null, "khách nói rõ 1kg ⇒ mẫu mã 1kg được");
  // Vòng 3: câu hỏi xác nhận có ĐƯỜNG cho «có». Đã hỏi ở tin khách seq 10 ⇒ tin khách kế tiếp (prevTurn 10) đồng ý = đúng mẫu mã đã mời.
  const asked = { ...offerRef, askedTurn: 10 };
  const CAT = ["Chả cá thu", "Chả mực giã tay", "Nem hải sản tôm bề bề", "Ruốc bông tôm 100%"];
  for (const yes of ["ừ", "ừ đúng rồi", "vâng thêm giúp chị", "được em", "đúng rồi em", "có"]) {
    assert.equal(confirmedAddIssue(mucNew, asked, yes, { prevTurn: 10, catalogNames: CAT }), null, `«${yes}» trả lời câu hỏi xác nhận ⇒ thêm đúng món đã mời`);
  }
  const later = confirmedAddIssue(mucNew, asked, "ừ", { prevTurn: 14, catalogNames: CAT });
  assert.equal(later?.kind, "UNNAMED", "đồng ý KHÔNG ở tin kế tiếp ⇒ không tính");
  assert.equal(later?.ask, null, "đã hỏi một lần ⇒ không bao giờ hỏi lại");
  assert.equal(confirmedAddIssue(muc1kg, asked, "đúng rồi em", { prevTurn: 10, catalogNames: CAT })?.kind, "WRONG_VARIANT", "đồng ý = ĐÚNG mẫu mã đã mời, không mẫu mã khác");
  assert.equal(confirmedAddIssue(mucNew, offerRef, "không lấy chả mực đâu", { catalogNames: CAT })?.ask, null, "đang từ chối ⇒ không hỏi (mời lại sau từ chối)");
  assert.equal(confirmedAddIssue(mucNew, offerRef, "thêm chả cá thu nhé", { catalogNames: CAT })?.ask, null, "gọi tên món KHÁC ⇒ không hỏi về món được mời");
  assert.equal(confirmedAddIssue(mucNew, { ...asked }, "thêm chả cá thu nhé", { prevTurn: 10, catalogNames: CAT })?.kind, "UNNAMED", "trả lời bằng tên món khác ⇒ không phải đồng ý món được mời");
  // Vòng 4: «có» = CẢ tin thuộc danh sách đóng; phủ định trên chữ có dấu ⇒ không; câu nói chuyện khác chứa «ok» / «có» / «đúng» ⇒ không.
  for (const yes of ["ừ", "ừ đúng rồi", "vâng thêm giúp chị", "được em", "đúng rồi em", "có", "ok em", "dạ vâng ạ", "lấy luôn nhé", "thêm giúp chị nhé", "Đúng rồi!", "oke"]) assert.ok(isShortYes(yes), `«${yes}» là đồng ý`);
  const NOT_YES = [
    "đừng thêm nhé em", "không đúng đâu em", "đừng em", "không có nhu cầu", "không em, ok em gửi địa chỉ khác nhé", "chị chỉ lấy ruốc thôi, ok em", "ok em gửi địa chỉ khác nhé",
    "ok ship nhanh giúp chị", "ok cảm ơn em", "có gì chị báo sau", "có ai ở nhà đâu em", "có chồng chị ăn", "được rồi, giao sáng mai nhé", "đúng 3h chiều giao nha",
    "thôi em", "khỏi em", "chưa em", "nhầm rồi", "sai rồi em", "hủy nhé", "bỏ đi em", "ko", "k em", "", "em ơi",
  ];
  for (const no of NOT_YES) {
    assert.ok(!isShortYes(no), `«${no}» KHÔNG phải đồng ý`);
    assert.notEqual(confirmedAddIssue(mucNew, asked, no, { prevTurn: 10, catalogNames: CAT }), null, `«${no}» không được thêm món vào đơn đã chốt`);
  }
  assert.equal(confirmedAddIssue(mucNew, asked, "đúng rồi em", { prevTurn: 10, catalogNames: CAT, staffBetween: true })?.kind, "UNNAMED", "nhân viên nhắn xen giữa ⇒ «có» không phải trả lời câu hỏi của bot");
  // B3 + NB4 khoá mức mã nguồn: đồng hồ khách AI nhận chữ ĐÃ GHÉP; giá mời theo bảng giá của khách.
  const eng = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.match(eng, /const i = aiTexts\.lastIndexOf\(appended\.before\);\s*if \(i >= 0\) aiTexts\[i\] = appended\.after;/, "aiTexts thay bằng chữ đã ghép câu mời");
  const tools = readFileSync("lib/sales-chatbot/tools.ts", "utf8");
  assert.match(tools, /booksForChat\(ctx\.config, verifiedCustomerId\(state\)\)\s*\.then\(\(books\) => loadOfferFacts\(ctx\.config, upsellId, books\)\)/, "giá mời theo bảng giá của khách");
}

// ═══ chatTurn THẬT + PGlite (`gd-food-pco`) ═══

const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const MENU = "Dạ bên em còn chả mực giã tay {{giá:CHA-MUC}} ăn kèm rất hợp ạ.";
const INFO = (phone: string) => `Cho chị 1 hộp ruốc bông tôm, Lan ${phone}, ${ADDR}`;

/**
 * Đồ dùng chung của các ca (một tổ chức thử `gd-food-pco`): câu mẫu UPSELL + tồn nạp MỘT lần ở ca đầu; cấu hình bot riêng của ca (`config`)
 * được harness trả về mặc định sau mỗi ca; công tắc tự chốt đặt lại ở mọi `beforeCase`. Ca «hết hàng» đưa tồn chả mực về 0 — nên đứng cuối.
 */
async function seedMenu(ids: ReadonlyMap<string, string>): Promise<void> {
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  const [row] = await db.select({ id: qr.id }).from(qr).where(eq(qr.title, "Menu món ngon")).limit(1);
  // Mỗi ca đặt một hộp ruốc + vài ca thêm chả mực — nạp đủ tồn một lần để không ca nào trượt vì «không đủ hàng».
  if (!row) {
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PCO-NAP", totalQuantity: 120, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values([{ receiptId: rc.id, variantId: ids.get("RUOC-TOM")!, quantity: 100, unitCost: 100_000 }, { receiptId: rc.id, variantId: ids.get("CHA-MUC")!, quantity: 20, unitCost: 200_000 }]);
  }
  const id = row?.id ?? (await db.insert(qr).values({ title: "Menu món ngon", triggers: ["menu món ngon"], answer: MENU, active: true }).returning({ id: qr.id }))[0].id;
  await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: id, autoLearn: false, autoActivate: false });
}

const orderInfo = (phone: string) => [
  () => [tool("create_customer", { name: "Lan", phone, address: ADDR })],
  ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
  () => [say("Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.")],
];

const CASES: GoldenCase[] = [
  { key: "pco-chot-nhanh-ok", title: "Chốt nhanh đủ thông tin ⇒ MỘT câu mời gộp vào tin xác nhận; «ok» không phải đồng ý mua thêm", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961003201"), ai: orderInfo("0961003201") },
    { say: "ok em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ vâng ạ.")]] },
  ] },
  { key: "pco-nhan-loi-moi", title: "Khách gọi tên đúng món được mời ⇒ đơn đã tự chốt được sửa thêm món, đo được tiền thêm", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961003202"), ai: orderInfo("0961003202") },
    { say: "thêm 1kg chả mực giã tay nữa nhé em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em thêm chả mực vào đơn rồi ạ.")]] },
  ] },
  { key: "pco-gio-khong-ten-ok", title: "(review B1) Giỏ KHÔNG gọi tên món nào, khách «ok em» sau lời mời ⇒ KHÔNG thêm món vào đơn đã chốt", shop: "food", channel: "WEB", turns: [
    { say: "chị lấy cái này nhé", ai: [() => [say("Dạ chị lấy 1 hộp ruốc bông tôm nhé, cho em xin SĐT + địa chỉ ạ.")]] },
    { say: `Lan 0961003208, ${ADDR}`, ai: orderInfo("0961003208") },
    { say: "ok em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ vâng ạ.")]] },
  ] },
  { key: "pco-tao-don-moi", title: "(review B2) Khách nhận lời mời, model gọi create_draft_order ⇒ được chỉ sang update_draft_order (không nói đã chuyển người) ⇒ thêm đúng món, báo tổng mới", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961003209"), ai: orderInfo("0961003209") },
    { say: "thêm chả mực giã tay nhé em", ai: [({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], ({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em thêm chả mực vào đơn rồi ạ.")]] },
  ] },
  { key: "pco-hoi-gia-mon-moi", title: "(review vòng 2) Sau lời mời, khách HỎI GIÁ món được mời ⇒ không thêm vào đơn đã chốt", shop: "food", channel: "WEB", turns: [
    { say: "chị lấy cái này nhé", ai: [() => [say("Dạ chị lấy 1 hộp ruốc bông tôm nhé, cho em xin SĐT + địa chỉ ạ.")]] },
    { say: `Lan 0961003210, ${ADDR}`, ai: orderInfo("0961003210") },
    { say: "chả mực giã tay bao nhiêu em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ chả mực giã tay 400.000 ₫/kg ạ.")]] },
  ] },
  { key: "pco-hoi-xac-nhan-dong-y", title: "(review vòng 3) «ok thêm giúp chị» ⇒ hỏi MỘT câu xác nhận ⇒ «đúng rồi em» ⇒ thêm đúng mẫu mã đã mời + tổng mới", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961003212"), ai: orderInfo("0961003212") },
    { say: "ok thêm giúp chị", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Mình muốn thêm Chả mực giã tay (1kg) vào đơn đúng không ạ?")]] },
    { say: "đúng rồi em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em thêm vào đơn rồi ạ.")]] },
  ] },
  { key: "pco-hoi-xac-nhan-tu-choi", title: "(review vòng 3) Đã hỏi xác nhận, khách «thôi em» ⇒ không thêm; «ok» sau đó ⇒ không thêm, KHÔNG hỏi lại", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961003213"), ai: orderInfo("0961003213") },
    { say: "ok thêm giúp chị", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Mình muốn thêm Chả mực giã tay (1kg) vào đơn đúng không ạ?")]] },
    { say: "thôi em", ai: [() => [say("Dạ vâng ạ.")]] },
    { say: "ok", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ vâng ạ.")]] },
  ] },
  { key: "pco-hoi-xac-nhan-dung-them", title: "(review vòng 4) Hỏi xác nhận ⇒ «đừng thêm nhé em» (bỏ dấu = «dung them») ⇒ KHÔNG thêm", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961003214"), ai: orderInfo("0961003214") },
    { say: "ok thêm giúp chị", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Mình muốn thêm Chả mực giã tay (1kg) vào đơn đúng không ạ?")]] },
    { say: "đừng thêm nhé em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ vâng ạ.")]] },
  ] },
  { key: "pco-hoi-xac-nhan-nv-xen", title: "(review vòng 4) Hỏi xác nhận ⇒ nhân viên nhắn xen giữa ⇒ «đúng rồi em» KHÔNG tính là trả lời câu hỏi của bot", shop: "food", channel: "WEB", turns: [
    { say: INFO("0961003215"), ai: orderInfo("0961003215") },
    { say: "ok thêm giúp chị", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Mình muốn thêm Chả mực giã tay (1kg) vào đơn đúng không ạ?")]] },
    {
      say: "đúng rồi em",
      before: async (ctx) => {
        const db = await getDb();
        const m = schema.salesChatMessages;
        const rows = await db.select({ seq: m.seq }).from(m).where(eq(m.conversationId, ctx.conversationId));
        await db.insert(m).values({ conversationId: ctx.conversationId, seq: Math.max(...rows.map((r) => r.seq)) + 1, role: "assistant", content: [{ type: "text", text: `${SHOP_SAID} Chị ơi đơn mình giao sáng mai được không ạ?` }] });
      },
      ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ vâng ạ.")]],
    },
  ] },
  { key: "pco-ship-bao-sau", title: "(review vòng 2) Shop chưa khai phí ship ⇒ «Tổng đơn mới» không in phí ship CHƯA BIẾT thành 0", shop: "food", channel: "WEB", config: { shippingFee: null }, turns: [
    { say: INFO("0961003211"), ai: orderInfo("0961003211") },
    { say: "thêm 1kg chả mực giã tay nữa nhé em", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em thêm chả mực vào đơn rồi ạ.")]] },
  ] },
  { key: "pco-da-moi-truoc", title: "Đã được mời trước khi chốt trong lượt mua ⇒ không mời lại sau chốt", shop: "food", channel: "WEB", config: {}, turns: [
    { say: "Cho chị 1 hộp ruốc bông tôm", ai: [() => [say("Dạ 1 hộp ruốc bông tôm ạ. Mình dùng thêm chả mực giã tay ăn kèm không ạ?")]] },
    { say: `Lan 0961003203, ${ADDR}`, ai: orderInfo("0961003203") },
  ] },
  { key: "pco-van-don-chay", title: "Khách nhận lời mời nhưng đơn đã có vận đơn ở hãng ⇒ lõi không sửa, chuyển người, không hứa đã thêm", shop: "food", channel: "WEB", config: {}, turns: [
    { say: INFO("0961003204"), ai: orderInfo("0961003204") },
    {
      say: "thêm 1kg chả mực giã tay nữa nhé em",
      before: async (ctx) => {
        const db = await getDb();
        const [o] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
        await db.insert(schema.shipments).values({ orderId: o.id, vtpOrderNumber: `PCO-${o.id.slice(-6)}`, trackingCode: `PCO-${o.id.slice(-6)}`, stage: "PICKED_UP" as never, codAmount: 350_000 });
      },
      ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em báo nhân viên hỗ trợ mình ạ.")]],
    },
  ] },
  { key: "pco-khong-tu-chot", title: "Đơn chốt bằng LỜI ĐỒNG Ý của khách ⇒ vẫn mời sau chốt; thêm món vào đơn đã chốt là việc của nhân viên", shop: "food", channel: "WEB", config: {}, turns: [
    { say: INFO("0961003205"), ai: [() => [tool("create_customer", { name: "Lan", phone: "0961003205", address: ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })], () => [say("Dạ đơn 1 hộp ruốc bông tôm 350.000 ₫, mình xác nhận giúp em nhé.")]] },
    { say: "ok chốt em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok chốt em" })], () => [say("Dạ em chốt đơn cho mình rồi ạ.")]] },
  ] },
  { key: "pco-don-co-mon-kem", title: "Đơn đã có đúng món kèm ⇒ không mời lại chính món đó (so theo sản phẩm, không theo nhãn dòng)", shop: "food", channel: "WEB", config: {}, turns: [
    { say: `Cho chị 1kg chả mực giã tay, Lan 0961003207, ${ADDR}`, ai: [() => [tool("create_customer", { name: "Lan", phone: "0961003207", address: ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em lên đơn cho mình rồi ạ.")]] },
  ] },
  { key: "pco-het-hang", title: "Món kèm hết hàng ⇒ không mời (không mời sai SKU, không mời cả menu)", shop: "food", channel: "WEB", config: {}, turns: [
    {
      say: INFO("0961003206"),
      before: async (ctx) => {
        const db = await getDb();
        // Đưa tồn KHẢ DỤNG về đúng 0 (đọc sổ kho — các ca trước đã thêm chả mực vào đơn), không âm: tồn âm là sổ sai, ca khác.
        const vid = ctx.ids.get("CHA-MUC")!;
        const avail = (await stockFor([vid])).get(vid)?.available ?? 0;
        const [rc] = await db.insert(schema.stockReceipts).values({ kind: "ADJUSTMENT", receivedAt: new Date(), reference: "PCO-HET", totalQuantity: -avail, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
        await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: vid, quantity: -avail, unitCost: 0 });
      },
      ai: orderInfo("0961003206"),
    },
  ] },
];

async function stateOf(conversationId: string): Promise<ChatState> {
  const db = await getDb();
  const [c] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  return (c?.state ?? {}) as ChatState;
}

async function orderLines(conversationId: string, ids: ReadonlyMap<string, string>): Promise<string[]> {
  const db = await getDb();
  const [o] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId));
  if (!o) return [];
  const sku = new Map([...ids.entries()].map(([k, id]) => [id, k]));
  return (await db.select({ v: schema.orderItems.variantId, q: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id))).map((l) => `${sku.get(String(l.v)) ?? l.v}×${l.q}`).sort();
}

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-pco",
    beforeCase: async (c, ctx) => {
      await seedMenu(ctx.ids);
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: c.key !== "pco-khong-tu-chot" });
    },
    afterCase: async (c, ctx: GoldenHookCtx, t) => {
      seen.add(c.key);
      const st = await stateOf(ctx.conversationId);
      const lines = await orderLines(ctx.conversationId, ctx.ids);
      const first = t.turns[0].shown.join("\n");
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      const OFFER = /Bên em có thêm Chả mực giã tay \(1kg\) giá 400\.000 ₫/;
      if (c.key === "pco-chot-nhanh-ok") {
        assert.match(first, OFFER, `tin xác nhận mang ĐÚNG một câu mời: ${first}`);
        assert.equal(t.turns[0].shown.filter((s) => OFFER.test(s)).length, 1, "một câu, gộp vào tin xác nhận — không tin riêng");
        assert.equal(st.upsellSent, true);
        assert.equal(st.postConfirmOffer?.outcome, "OFFERED");
        assert.deepEqual(lines, ["RUOC-TOM×1"], `«ok» KHÔNG thêm món được mời: ${lines.join(", ")} · ${results}`);
        assert.equal(st.postConfirmOffer?.accepted, undefined);
        assert.doesNotMatch(t.turns[1].shown.join("\n"), OFFER, "không nhắc lại lời mời");
      }
      if (c.key === "pco-nhan-loi-moi") {
        assert.deepEqual(lines, ["CHA-MUC×1", "RUOC-TOM×1"], results);
        assert.equal(st.postConfirmOffer?.accepted?.amount, 400_000);
        assert.match(results, /Tổng đơn mới 750\.000 ₫/, "câu xác nhận sửa đơn báo TỔNG MỚI (NB6)");
      }
      if (c.key === "pco-hoi-gia-mon-moi") {
        assert.deepEqual(lines, ["RUOC-TOM×1"], `câu hỏi giá KHÔNG thêm món: ${lines.join(", ")}`);
        assert.equal(st.postConfirmOffer?.accepted, undefined);
      }
      if (c.key === "pco-hoi-xac-nhan-dong-y") {
        const r1 = JSON.stringify(t.turns[1].rounds.map((r) => r.results));
        assert.match(r1, /Hỏi khách ĐÚNG MỘT câu: «Mình muốn thêm Chả mực giã tay \(1kg\) vào đơn đúng không ạ\?»/, r1);
        assert.deepEqual(lines, ["CHA-MUC×1", "RUOC-TOM×1"], `«đúng rồi em» sau câu hỏi xác nhận ⇒ thêm: ${results}`);
        assert.equal(st.postConfirmOffer?.accepted?.amount, 400_000);
        assert.match(JSON.stringify(t.turns[2].rounds.map((r) => r.results)), /Tổng đơn mới/);
      }
      if (c.key === "pco-hoi-xac-nhan-tu-choi") {
        assert.deepEqual(lines, ["RUOC-TOM×1"], results);
        const r3 = JSON.stringify(t.turns[3].rounds.map((r) => r.results));
        assert.match(r3, /khách chưa gọi tên món/, r3);
        assert.doesNotMatch(r3, /Hỏi khách ĐÚNG MỘT câu/, "đã hỏi một lần ⇒ không hỏi lại");
        assert.equal(st.postConfirmOffer?.accepted, undefined);
      }
      if (c.key === "pco-hoi-xac-nhan-dung-them" || c.key === "pco-hoi-xac-nhan-nv-xen") {
        assert.deepEqual(lines, ["RUOC-TOM×1"], `[${c.key}] KHÔNG thêm món: ${lines.join(", ")} · ${results.slice(0, 600)}`);
        assert.equal(st.postConfirmOffer?.accepted, undefined);
      }
      if (c.key === "pco-ship-bao-sau") {
        assert.deepEqual(lines, ["CHA-MUC×1", "RUOC-TOM×1"], results);
        assert.match(results, /Tổng đơn mới 750\.000 ₫ \+ phí ship \(báo sau\)/, `phí ship chưa biết không in thành 0: ${results.slice(0, 400)}`);
      }
      if (c.key === "pco-gio-khong-ten-ok") {
        assert.match(first + t.turns[1].shown.join("\n"), OFFER, "đơn chốt có lời mời");
        assert.deepEqual(lines, ["RUOC-TOM×1"], `«ok» với giỏ không tên món KHÔNG thêm món: ${lines.join(", ")} · ${results}`);
        assert.equal(st.postConfirmOffer?.accepted, undefined);
        assert.match(results, /khách chưa gọi tên món/);
      }
      if (c.key === "pco-tao-don-moi") {
        assert.match(results, /Đơn đã tự chốt/, results);
        assert.doesNotMatch(results, /máy chủ đã chuyển nhân viên/, "không nói đã chuyển người khi không chuyển");
        assert.deepEqual(lines, ["CHA-MUC×1", "RUOC-TOM×1"], results);
        assert.ok(!st.handoff, "không chuyển người");
        assert.equal(st.postConfirmOffer?.accepted?.amount, 400_000);
      }
      if (c.key === "pco-da-moi-truoc") {
        assert.doesNotMatch(t.turns.flatMap((x) => x.shown).join("\n"), OFFER, "đã mời trong lượt mua ⇒ không mời lại");
        assert.equal(st.postConfirmOffer?.outcome, "ALREADY_OFFERED");
      }
      if (c.key === "pco-van-don-chay") {
        assert.deepEqual(lines, ["RUOC-TOM×1"], "đơn có vận đơn đang chạy ⇒ không sửa");
        assert.ok(st.handoff, "chuyển nhân viên xử lý theo quy trình");
      }
      if (c.key === "pco-khong-tu-chot") {
        assert.match(t.turns[1].shown.join("\n"), OFFER, t.turns[1].shown.join("\n"));
        assert.equal(st.postConfirmOffer?.outcome, "OFFERED");
      }
      if (c.key === "pco-don-co-mon-kem") {
        assert.doesNotMatch(first, /Bên em có thêm/, first);
        assert.equal(st.postConfirmOffer?.outcome, "NO_CANDIDATE");
      }
      if (c.key === "pco-het-hang") {
        assert.doesNotMatch(first, /Bên em có thêm/, first);
        assert.equal(st.postConfirmOffer?.outcome, "NO_CANDIDATE");
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
}

export async function testP0UpsellAfterConfirm(): Promise<void> {
  testThuan();
  await testChatTurn();
  console.log("✓ P0 lời mời sau chốt (19/10/2026): một câu gộp vào tin xác nhận · «ok» không thêm món · gọi tên món ⇒ thêm vào đơn tự chốt · đã mời / từ chối / hết hàng / vận đơn đã chạy / đơn đồng ý");
}

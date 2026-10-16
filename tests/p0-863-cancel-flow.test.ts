/**
 * P0 #863 — ca HSLC 16/10/2026 12:48–13:27 (hội thoại 54cf199f…, KHÔNG chép dữ liệu khách): khách 1kg chả cá thu + «Lấy thêm 1/2 kg chả
 * mực» ⇒ đơn nháp 2kg chả mực + 1kg cá = 1.060.000 ₫; nhân viên page «Tổng 480k miễn ship» lúc 12:52–12:53; bot vẫn «chốt đơn tổng
 * 1.060.000đ» lúc 12:54; khách «Vậy anh ko mua nhé, hủy đơn» ⇒ bot giữ đơn bằng câu chung; «Ko mua» ⇒ đơn vẫn «CẦN XÁC THỰC».
 *
 * Bài kiểm khoá (dữ liệu ẩn danh, model giả, PGlite thật — không gửi tin thật, không gọi mạng — luật 65; không ghim ngày — luật 50):
 *  1. Chuỗi #863 qua `chatTurn` thật: «1/2 kg» = 500g (#864) + câu nhắc lại cả giỏ «…, 1kg chả cá thu thôi» ⇒ giỏ 1kg cá + 500g mực; đơn bot
 *     cố lên 2kg mực bị từ chối; đơn đúng 480.000 ₫ tiền hàng.
 *  2. Phía page nhắn (nguồn CHƯA RÕ — Pancake không gắn tài khoản) SAU lúc lượt bắt đầu ⇒ `botMaySend` = không gửi; tiếng vọng của chính bot
 *     và tin tự động của page không chặn.
 *  3. Khách huỷ ngay sau lỗi số lượng ⇒ máy chủ xin lỗi CỤ THỂ (2kg ≠ 500g) + ĐƠN ĐÃ SỬA theo báo giá máy chủ (480.000 ₫), một lượt giữ đơn,
 *     không gọi model; đơn mang cờ «khách huỷ» + «món / số lượng chưa đồng ý», chưa huỷ.
 *  4. Khách từ chối lần nữa ⇒ huỷ qua vòng đời đơn, «đã huỷ» chỉ sau khi CSDL ghi; lịch nhắc dọn; không câu giữ đơn thứ hai.
 *  5. Đơn đã thu tiền / đã giao ĐVVC ⇒ chuyển người, không câu «đã huỷ», đơn không đổi trạng thái.
 *  6. Nhân viên báo tổng khác đơn nháp ⇒ máy chủ chuyển người, không gọi model, đơn mang cờ.
 *  7. Đơn nháp lệch giỏ khách nói sau khi thấy đơn ⇒ `confirm_order` từ chối.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { customerCancelPlan } from "@/lib/constants/order-cancel";
import { orderReviewOf } from "@/lib/constants/order-review";
import { createProductCore } from "@/lib/records/product-create";
import { cartDraftDiff, applyCustomerCartMessage, classifyCartMessage, negatedCancel, type AskedLine } from "@/lib/sales-chatbot/cart-commitment";
import { botErrorFromReview, cartQuoteLines, explicitCancel, recoveryText, staffTotalConflict, type CatalogLite } from "@/lib/sales-chatbot/cancel-recovery";
import { botSendVerdict, type SendSnapshot } from "@/lib/sales-chatbot/conversation-control-shared";
import { botMaySend, captureSendSnapshot } from "@/lib/sales-chatbot/conversation-control";
import { appendContextMessages } from "@/lib/sales-chatbot/engine";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx, type GoldenTranscript } from "./sales-agent-golden/harness";

const CAT = ["Chả cá thu (1kg)", "Chả mực giã tay (1kg)", "Chả mực giã tay (500g)", "Ruốc bông tôm 100% (250g)", "Mực khô câu (500g)"];
const PRODUCTS = ["Chả cá thu", "Chả mực giã tay", "Ruốc bông tôm 100%", "Mực khô câu"];
const items = (c: ReturnType<typeof applyCustomerCartMessage>) => (c?.selectedItems ?? []).map((x) => [x.label, x.quantity, x.unit, x.customerExplicit]);

// ─────────────────────────── 1. THUẦN ───────────────────────────

function testPure() {
  // Câu huỷ rõ ràng — một bộ nhận diện với giỏ có thẩm quyền.
  for (const t of ["Vậy anh ko mua nhé, hủy đơn", "Ko mua", "không mua nữa", "thôi khỏi", "hủy đơn", "thoi huy di em"]) assert.equal(explicitCancel(t), true, `«${t}» là huỷ`);
  for (const t of ["huỷ được không?", "không lấy thêm đâu", "ok em", "lấy 1kg thôi", "để mai chị lấy"]) assert.equal(explicitCancel(t), false, `«${t}» không phải huỷ`);
  // Review #869 (FAIL-1): câu PHỦ ĐỊNH việc huỷ = khách GIỮ đơn — không bao giờ là câu huỷ, không xoá giỏ.
  for (const t of ["không hủy đâu em", "đừng hủy nha em", "khoan đã, chưa hủy nhé", "ko huỷ nhé", "không cần hủy đâu", "đâu có hủy đơn", "chưa huỷ đơn nha", "Đừng huỷ đơn của chị"]) {
    assert.equal(explicitCancel(t), false, `«${t}» là KHÔNG huỷ`);
    assert.equal(negatedCancel(t), true, `«${t}» là phủ định huỷ`);
    assert.notEqual(classifyCartMessage(t).kind, "CANCEL", `«${t}» không xoá giỏ`);
  }
  assert.equal(negatedCancel("hủy đơn"), false);
  assert.equal(negatedCancel("thôi không lấy nữa"), false, "«không lấy nữa» vẫn là huỷ");
  for (const t of ["thôi khỏi hủy", "ko cần hủy đâu", "không phải hủy đâu", "không hủy nữa em ơi lấy như cũ"]) {
    assert.equal(negatedCancel(t), true, `«${t}» là phủ định huỷ`);
    assert.equal(explicitCancel(t), false, `«${t}» không phải huỷ`);
  }
  assert.equal(explicitCancel("thôi khỏi"), true, "«thôi khỏi» trơn vẫn là huỷ");
  // Re-review #869: «không» TRẢ LỜI câu giữ đơn rồi một câu huỷ (mệnh đề khác) ⇒ HUỶ — phủ định chỉ tính trong CÙNG mệnh đề với «hủy».
  for (const t of ["không, hủy đơn đi", "Không. Hủy đơn đi em", "k, huỷ đi", "không không, hủy giùm chị", "chưa, hủy đơn giúp chị", "ko lấy nữa, hủy đi", "không cần giữ, hủy luôn", "ko đâu em, hủy đi", "không nha, hủy đơn", "đừng giữ, hủy đi em", "hủy đi, không lấy nữa"]) {
    assert.equal(negatedCancel(t), false, `«${t}» không phải phủ định huỷ`);
    assert.equal(explicitCancel(t), true, `«${t}» là HUỶ`);
  }

  // Chuỗi chữ khách của #863 ⇒ giỏ 1kg cá + 500g mực (câu nhắc lại cả giỏ không cộng lần hai, không bỏ rơi vế mực).
  const P = { catalog: CAT, products: PRODUCTS };
  let c = applyCustomerCartMessage(undefined, "Cho anh 1kg chả cá thu", 1, new Date(), P);
  c = applyCustomerCartMessage(c, "Lấy thêm 1/2 kg chả mực", 3, new Date(), P);
  assert.deepEqual(items(c), [["Chả cá thu", 1000, "g", true], ["Chả mực giã tay", 500, "g", true]], "«1/2 kg» = 500g (#864)");
  c = applyCustomerCartMessage(c, "Lấy thêm 1/2 kg chả mực, 1kg chả cá thu thôi", 5, new Date(), P);
  assert.deepEqual(items(c), [["Chả cá thu", 1000, "g", true], ["Chả mực giã tay", 500, "g", true]], "nhắc lại «thêm 1/2 kg» món đang có ⇒ giỏ giữ nguyên (KHÔNG thành 1kg mực), hỏi lại");
  assert.equal(c?.relaxedTurn, 5);
  let d = applyCustomerCartMessage(undefined, "Lấy 1kg chả cá thu với 2kg chả mực", 1, new Date(), P);
  d = applyCustomerCartMessage(d, "Lấy 1/2 kg chả mực, 1kg chả cá thu thôi", 3, new Date(), P);
  assert.deepEqual(items(d), [["Chả cá thu", 1000, "g", true], ["Chả mực giã tay", 500, "g", true]], "sửa cả giỏ bằng một câu ⇒ cả hai món đúng số khách nói");
  // Review #869 (FAIL-2): món ĐANG CÓ mang «thêm» / «nữa» trong câu nhắc lại ⇒ không đặt lại số (đặt lại là hạ món khách đang thêm) — giỏ giữ
  // nguyên + hỏi lại. Món MỚI mang «thêm» (ca #863: giỏ chỉ có cá) vẫn đặt đúng.
  const CAT2 = [...CAT, "Nem hải sản tôm bề bề (Hộp 10 cái)"];
  const P2 = { catalog: CAT2, products: [...PRODUCTS, "Nem hải sản tôm bề bề"] };
  const nem = applyCustomerCartMessage(undefined, "cho chị 2 hộp nem hải sản", 1, new Date(), P2);
  const nem2 = applyCustomerCartMessage(nem, "thêm 1 hộp nem, 1 hũ ruốc nữa thôi nhé", 3, new Date(), P2);
  assert.deepEqual(items(nem2), items(nem), "2 hộp nem KHÔNG bị hạ xuống 1");
  assert.equal(nem2?.relaxedTurn, 3, "không chắc ⇒ hỏi lại, không chặn");
  const ca1 = applyCustomerCartMessage(undefined, "cho chị 1kg chả cá thu", 1, new Date(), P);
  const ca2 = applyCustomerCartMessage(ca1, "cho chị thêm 1kg chả cá với 1kg chả mực thôi", 3, new Date(), P);
  assert.deepEqual(items(ca2), items(ca1), "cá đang có mang «thêm» ⇒ không đặt lại");
  assert.equal(ca2?.relaxedTurn, 3);
  const r0 = applyCustomerCartMessage(ca1, "Lấy thêm 1/2 kg chả mực, 1kg chả cá thu thôi", 3, new Date(), P);
  assert.deepEqual(items(r0), [["Chả cá thu", 1000, "g", true], ["Chả mực giã tay", 500, "g", true]], "ca #863: giỏ chỉ có cá ⇒ 1kg cá + 500g mực");
  // Một món + «thôi» vẫn đi đường cũ (chọn lại MỘT món).
  const one = applyCustomerCartMessage(d, "chỉ lấy 1kg chả cá thu thôi", 5, new Date(), P);
  assert.deepEqual(items(one), [["Chả cá thu", 1000, "g", true]]);

  // Đơn nháp lệch giỏ: 2kg mực ≠ 500g.
  const asked: AskedLine[] = [
    { variantId: "ca1", productId: "p-ca", name: "Chả cá thu (1kg)", quantity: 1, weightGrams: 1000 },
    { variantId: "muc1", productId: "p-muc", name: "Chả mực giã tay (1kg)", quantity: 2, weightGrams: 1000 },
  ];
  const diff = cartDraftDiff(c, asked);
  assert.deepEqual(diff.map((x) => [x.label, x.want, x.got]), [["Chả mực giã tay", "500g", "2kg"]]);
  assert.deepEqual(cartDraftDiff(c, asked, { since: 5 }), [], "`since` = chỉ món khách nói SAU lượt đó");
  assert.deepEqual(cartDraftDiff(c, [asked[0], { ...asked[1], variantId: "muc5", quantity: 1, weightGrams: 500 }]), [], "đơn đúng giỏ ⇒ không lệch");

  // Giỏ ⇒ dòng hàng để máy chủ báo giá: mẫu mã ĐÚNG khối lượng (kể cả mẫu mã chỉ bán kèm khi giỏ có món chính).
  const catalog: CatalogLite[] = [
    { variantId: "ca1", productId: "p-ca", name: "Chả cá thu", price: 280_000, weightGrams: 1000 },
    { variantId: "muc1", productId: "p-muc", name: "Chả mực giã tay", price: 400_000, weightGrams: 1000 },
    { variantId: "muc5", productId: "p-muc", name: "Chả mực giã tay", price: 200_000, weightGrams: 500, addOnOnly: true },
  ];
  assert.deepEqual(cartQuoteLines(c, catalog), [{ variantId: "ca1", quantity: 1 }, { variantId: "muc5", quantity: 1 }]);
  const two = applyCustomerCartMessage(undefined, "lấy 2kg chả mực", 1, new Date(), P);
  assert.deepEqual(cartQuoteLines(two, catalog), [{ variantId: "muc1", quantity: 2 }], "không có gói 2kg ⇒ 2 × gói lớn nhất chia hết");
  assert.equal(cartQuoteLines(applyCustomerCartMessage(undefined, "lấy 300g chả mực", 1, new Date(), P), catalog), null, "không ghép chắc ⇒ null (không đoán)");
  assert.equal(cartQuoteLines(undefined, catalog), null);

  // Câu xin lỗi: gọi tên lỗi + số máy chủ + ĐÚNG MỘT đề nghị; không câu chung «đổi món hay điều chỉnh».
  const text = recoveryText("QUANTITY", diff, { items: "1kg Chả cá thu + 500g Chả mực giã tay", subtotal: 480_000, total: 480_000, shipFree: true });
  assert.match(text, /xin lỗi/);
  assert.match(text, /2kg Chả mực giã tay trong khi mình đặt 500g/);
  assert.match(text, /480\.000/);
  assert.ok(!/đổi món|điều chỉnh gì/.test(text), "không giữ đơn bằng câu chung");
  assert.equal((text.match(/nhắn em «ok»/g) ?? []).length, 1, "một lời đề nghị");
  assert.equal(botErrorFromReview(["CUSTOMER_CANCELLED"]), null);
  assert.equal(botErrorFromReview(["UPSELL_UNCONSENTED"]), "UNCONSENTED");
  assert.equal(botErrorFromReview(["PRICE_MISMATCH"]), "PRICE");

  // Nhân viên báo tổng khác đơn nháp.
  assert.equal(staffTotalConflict(["Tổng 480k miễn ship", "1kg chả cá và 0,5 mực"], [1_060_000]), 480_000);
  assert.equal(staffTotalConflict(["Tổng 480k miễn ship"], [480_000]), null, "khớp tổng máy chủ ⇒ không lệch");
  assert.equal(staffTotalConflict(["1kg chả cá 280k nha"], [1_060_000]), null, "đơn giá không phải tổng");
  // Review #869 (P1): phí ship / COD / đơn giá / đơn cũ / tổng chưa gồm ship KHÔNG phải tổng đơn hiện tại.
  for (const t of ["ship COD toàn quốc chị nhé, phí ship 30k", "cod 30k ạ", "dạ thanh toán khi nhận, tổng chưa gồm ship 30k", "chả mực giá 400k, tổng đơn cũ của chị 1.060k", "chả mực 400k/kg, chả cá 280k/kg ạ", "dạ hết hàng chả mực rồi ạ", "hết 2 hộp nem rồi chị ơi"]) {
    assert.equal(staffTotalConflict([t], [1_060_000, 1_030_000]), null, `«${t}» không phải tổng đơn`);
  }
  assert.equal(staffTotalConflict(["tất cả 480k ạ"], [1_060_000]), 480_000);
  assert.equal(staffTotalConflict(["thu hộ 480k nha chị"], [1_060_000]), 480_000);

  // Cổng gửi: phía page nhắn / nhường người mới SAU lúc lượt bắt đầu ⇒ không gửi.
  const t0 = new Date(Date.now() - 60_000);
  const t1 = new Date(Date.now() - 30_000);
  const open: SendSnapshot = { status: "OPEN", state: {}, lastStaffAt: null, pageSideAt: t0, humanCooldownUntil: null };
  assert.deepEqual(botSendVerdict(open, open), { ok: true });
  assert.equal(botSendVerdict(open, { ...open, pageSideAt: t1 }).ok, false, "tin phía page mới ⇒ không gửi");
  assert.equal(botSendVerdict({ ...open, pageSideAt: null }, { ...open, pageSideAt: t1 }).ok, false, "tin phía page ĐẦU TIÊN cũng tính");
  assert.equal(botSendVerdict(open, { ...open, humanCooldownUntil: t1 }).ok, false, "nhường người vừa đặt ⇒ không gửi");
  assert.deepEqual(botSendVerdict({ status: "OPEN", state: {}, lastStaffAt: null }, { status: "OPEN", state: {}, lastStaffAt: null }), { ok: true }, "kênh không có tin phía page ⇒ như cũ");

  // Vòng đời huỷ: đã thu tiền ⇒ người; đã giao ĐVVC ⇒ người (luật cũ giữ nguyên).
  const base = { manual: true, stage: "NEW", attempts: [], manualIssues: 0 };
  assert.deepEqual(customerCancelPlan(base), { kind: "CANCEL_NOW" });
  assert.deepEqual(customerCancelPlan({ ...base, paid: 480_000 }), { kind: "NEEDS_HUMAN", code: "PAID_ORDER" });
  assert.deepEqual(customerCancelPlan({ ...base, stage: "SHIPPED" }), { kind: "NEEDS_HUMAN", code: "FINAL_STAGE" });

}

// ─────────────────────────── 2. GOLDEN QUA chatTurn THẬT ───────────────────────────

const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const CFG = { sellWithoutStockCheck: true, shippingFee: 30_000 };

/** Cửa hàng thử: Chả cá thu 1kg 280.000 ₫ + gói 500g (chỉ bán kèm) 200.000 ₫ cho «Chả mực giã tay» có sẵn (1kg 400.000 ₫). */
async function seed(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (ctx.ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const r = await createProductCore(admin, { name: "Chả cá thu", code: "CCT", unit: "gói", retailPrice: 280_000, cost: null, variants: [{ sku: "CCT-1KG", size: "1kg", color: "", retailPrice: 280_000, cost: null, selling: true }] });
  assert.ok(r.ok, JSON.stringify(r));
  const db = await getDb();
  const v = schema.productVariants;
  const [cct] = await db.select({ id: v.id }).from(v).where(eq(v.productId, r.id));
  (ctx.ids as Map<string, string>).set("CCT-1KG", cct.id);
  const [muc] = await db.select().from(v).where(eq(v.id, ctx.ids.get("CHA-MUC")!));
  const { createdAt: _c, updatedAt: _u, ...rest } = muc;
  void _c;
  void _u;
  await db.insert(v).values({ ...rest, id: `${muc.id}-500g`, sku: "CHA-MUC-500", size: "500g", detail: "", retailPrice: 200_000, addOnOnly: true });
  (ctx.ids as Map<string, string>).set("CHA-MUC-500", `${muc.id}-500g`);
}

async function convRow(conversationId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  return { row, state: (row.state ?? {}) as ChatState };
}

async function orderOf(conversationId: string) {
  const { state, row } = await convRow(conversationId);
  const orderId = state.confirmed?.orderId ?? state.draft?.orderId ?? row.orderId ?? row.draftOrderId ?? null;
  const db = await getDb();
  const [o] = orderId ? await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)) : [];
  const its = orderId ? await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)) : [];
  return { state, orderId, order: o ?? null, items: its };
}

/** Lượt khách đã có đơn nháp 1kg cá + 2kg mực (đúng ý khách LÚC ĐÓ) — đơn bot sẽ «sai» khi khách đổi ý mà đơn không đổi. */
const draftTurn = (phone: string): GoldenCase["turns"][number] => ({
  say: `Lấy 1kg chả cá thu với 2kg chả mực, Nhân ${phone}, ${ADDR}`,
  ai: [
    () => [tool("create_customer", { name: "Nhân", phone, address: ADDR })],
    ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 2 }] })],
    () => [say("Dạ mình xem giúp em tóm tắt đơn nhé.")],
  ],
});
/** Khách đổi ý cả giỏ; model (lỗi) cố chốt đơn cũ ⇒ máy chủ từ chối; model nói một câu không có số tiền. */
const changeTurn: GoldenCase["turns"][number] = {
  say: "Lấy 1/2 kg chả mực, 1kg chả cá thu thôi",
  ai: [() => [tool("confirm_order", { customer_confirmation: "1kg chả cá thu thôi" })], () => [say("Dạ em kiểm lại đơn cho mình ạ.")]],
};
const CANCEL_1 = "Vậy anh ko mua nhé, hủy đơn";
const CANCEL_2 = "Ko mua";

let sendGuardChecked = false;

const CASES: GoldenCase[] = [
  {
    key: "gc-863-chuoi-that",
    title: "#863 chuỗi thật: 1kg cá → «Lấy thêm 1/2 kg chả mực» → nhắc lại cả giỏ → model cố lên 2kg mực bị từ chối → đơn đúng 480.000 ₫ tiền hàng",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      { say: "Cho anh 1kg chả cá thu", ai: [() => [say("Dạ mình lấy 1kg chả cá thu ạ.")]] },
      { say: "Lấy thêm 1/2 kg chả mực", ai: [() => [say("Dạ em ghi thêm chả mực cho mình ạ.")]] },
      { say: "Lấy thêm 1/2 kg chả mực, 1kg chả cá thu thôi", ai: [() => [say("Dạ mình cho em xin SĐT và địa chỉ nhận hàng nhé.")]] },
      {
        say: `Nhân 0961000863, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Nhân", phone: "0961000863", address: ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 2 }] })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC-500"), quantity: 1 }] })],
          () => [say("Dạ em lên đơn 1kg chả cá thu và 500g chả mực cho mình ạ.")],
        ],
      },
    ],
  },
  {
    key: "gc-863-huy-sau-loi-bot",
    title: "#863: đơn lệch giỏ ⇒ chốt bị từ chối · «hủy đơn» ⇒ máy chủ xin lỗi cụ thể + đơn đã sửa 480.000 ₫ (một lượt giữ đơn) · «Ko mua» ⇒ huỷ qua vòng đời đơn",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      draftTurn("0961000864"),
      changeTurn,
      {
        say: CANCEL_1,
        ai: [],
        // Cổng gửi (ảnh chụp ĐẦU LƯỢT như fanpage.ts chụp ngay trước chatTurn): tin phía page tới SAU ảnh chụp, nguồn CHƯA RÕ ⇒ câu đã
        // soạn không được gửi; tiếng vọng của chính bot và tin tự động của page không chặn.
        before: async ({ conversationId }) => {
          const db = await getDb();
          const t = schema.salesChatInbound;
          await db.update(schema.salesChatConversations).set({ pageId: "pg-863", threadId: "th-863" }).where(eq(schema.salesChatConversations.id, conversationId));
          const snap = await captureSendSnapshot(conversationId);
          assert.deepEqual(await botMaySend(conversationId, snap), { ok: true }, "chưa có tin phía page ⇒ gửi được");
          await db.insert(t).values({ pageId: "pg-863", threadId: "th-863", messageId: "bot-863-1", text: "Dạ em kiểm lại đơn cho mình ạ.", status: "DONE", note: "BOT_SENT" });
          await db.insert(t).values({ pageId: "pg-863", threadId: "th-863", messageId: "echo-863-1", text: "Dạ em kiểm lại đơn cho mình ạ.", status: "DONE", note: "PAGE_REPLY", senderKind: "UNKNOWN" });
          await db.insert(t).values({ pageId: "pg-863", threadId: "th-863", messageId: "auto-863-1", text: "Cảm ơn bạn đã nhắn tin cho page!", status: "DONE", note: "PAGE_REPLY", senderKind: "PANCAKE_AUTOMATION" });
          assert.deepEqual(await botMaySend(conversationId, snap), { ok: true }, "tiếng vọng bot / tin tự động không chặn");
          // Nhân viên gõ ngoài ERP, Pancake không gắn tài khoản ⇒ nguồn CHƯA RÕ ⇒ câu bot soạn từ trước KHÔNG gửi.
          await db.insert(t).values({ pageId: "pg-863", threadId: "th-863", messageId: "staff-863-1", text: "Tổng 480k miễn ship", status: "DONE", note: "PAGE_REPLY", senderKind: "UNKNOWN" });
          const v = await botMaySend(conversationId, snap);
          assert.equal(v.ok, false, "tin phía page tới sau lúc lượt bắt đầu ⇒ bot không gửi");
          // Nhân viên đã xác minh (cột nguồn vắng — tin gửi từ hộp thư ERP) cũng chặn.
          const snap2 = await captureSendSnapshot(conversationId);
          await db.insert(t).values({ pageId: "pg-863", threadId: "th-863", messageId: "staff-out:863:0", text: "1kg chả cá và 0,5 mực", status: "DONE", note: "PAGE_REPLY" });
          assert.equal((await botMaySend(conversationId, snap2)).ok, false, "tin nhân viên từ hộp thư ERP chặn");
          sendGuardChecked = true;
          // Dọn để lượt chạy như ca thật (engine không đọc bảng này).
          await db.delete(t).where(and(eq(t.pageId, "pg-863"), eq(t.threadId, "th-863")));
        },
      },
      { say: CANCEL_2, ai: [] },
    ],
  },
  {
    key: "gc-863-khong-huy-sau-cuu",
    title: "Review #869: sau lượt giữ đơn của máy chủ, khách «không hủy đâu em» ⇒ KHÔNG huỷ (kể cả model gọi CANCEL), không câu «đã huỷ»",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      draftTurn("0961000868"),
      changeTurn,
      { say: CANCEL_1, ai: [] },
      {
        say: "không hủy đâu em",
        ai: [() => [tool("cancel_order", { decision: "CANCEL", customer_words: "không hủy đâu em" })], () => [say("Dạ vâng, em giữ đơn cho mình ạ.")]],
      },
    ],
  },
  {
    key: "gc-863-khong-huy-di",
    title: "Re-review #869: sau lượt giữ đơn, khách «Không, hủy đi» (trả lời «không» rồi huỷ) ⇒ đơn ĐƯỢC huỷ qua vòng đời, «đã huỷ» sau khi ghi",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [draftTurn("0961000870"), changeTurn, { say: CANCEL_1, ai: [] }, { say: "Không, hủy đi", ai: [] }],
  },
  {
    key: "gc-863-dung-huy-lan-dau",
    title: "Review #869: «đừng hủy nha em» sau lỗi bot ⇒ không phải câu huỷ: không xin lỗi / đề nghị huỷ, không mở yêu cầu huỷ",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [draftTurn("0961000869"), changeTurn, { say: "đừng hủy nha em", ai: [() => [say("Dạ vâng, em giữ đơn cho mình ạ.")]] }],
  },
  {
    key: "gc-863-da-thu-tien",
    title: "#863: đơn đã có chứng từ thu tiền ⇒ khách huỷ lần hai vẫn KHÔNG tự huỷ — chuyển người, không câu «đã huỷ»",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      draftTurn("0961000865"),
      {
        say: "hủy đơn",
        ai: [() => [tool("cancel_order", { decision: "CANCEL", customer_words: "hủy đơn" })], () => [say("Dạ mình cho em hỏi lý do được không ạ?")]],
        before: async ({ conversationId }) => {
          const { orderId } = await orderOf(conversationId);
          assert.ok(orderId);
          await (await getDb()).insert(schema.orderPayments).values({ orderId, kind: "RECEIPT", method: "BANK_TRANSFER", amount: 100_000, paidAt: new Date(), status: "CONFIRMED" });
        },
      },
      { say: CANCEL_2, ai: [] },
    ],
  },
  {
    key: "gc-863-da-giao",
    title: "#863: đơn đã giao ĐVVC mà khách huỷ sau lỗi của bot ⇒ chuyển người, không đề nghị, không huỷ",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      draftTurn("0961000866"),
      changeTurn,
      {
        say: CANCEL_1,
        ai: [],
        before: async ({ conversationId }) => {
          const { orderId } = await orderOf(conversationId);
          await (await getDb()).update(schema.orders).set({ stage: "SHIPPED" }).where(eq(schema.orders.id, orderId!));
        },
      },
    ],
  },
  {
    key: "gc-863-nhan-vien-bao-tong-khac",
    title: "#863: nhân viên page báo «Tổng 480k miễn ship» khác đơn nháp ⇒ máy chủ chuyển người, không gọi model, đơn mang cờ",
    shop: "food",
    channel: "FANPAGE",
    config: CFG,
    turns: [
      draftTurn("0961000867"),
      {
        say: "ok em",
        ai: [],
        before: async ({ conversationId }) => appendContextMessages(conversationId, [{ role: "assistant", text: "Tổng 480k miễn ship" }, { role: "assistant", text: "1kg chả cá và 0,5 mực" }]),
      },
    ],
  },
];

async function testGolden() {
  const seen = new Set<string>();
  const checks: Record<string, (t: GoldenTranscript, ctx: GoldenHookCtx) => Promise<void>> = {
    "gc-863-chuoi-that": async (t, ctx) => {
      const { order, items: its, state } = await orderOf(ctx.conversationId);
      assert.ok(order, "có đơn");
      const qty = (sku: string) => its.filter((i) => i.variantId === ctx.ids.get(sku)).reduce((s, i) => s + i.quantity, 0);
      assert.equal(qty("CHA-MUC"), 0, "0 gói 1kg chả mực (khách chưa từng đặt 2kg)");
      assert.equal(qty("CHA-MUC-500"), 1, "đúng 500g chả mực");
      assert.equal(qty("CCT-1KG"), 1, "1kg chả cá thu");
      assert.equal(order.totalPriceAfterDiscount, 480_000, "tiền hàng = 280.000 + 200.000 theo báo giá máy chủ");
      assert.deepEqual(state.cart?.selectedItems.filter((x) => x.customerExplicit).map((x) => [x.label, x.quantity]), [["Chả cá thu", 1000], ["Chả mực giã tay", 500]]);
      const r = JSON.stringify(t.turns[3].rounds.map((x) => x.results));
      assert.match(r, /error/, "lần lên 2kg mực bị máy chủ từ chối");
    },
    "gc-863-huy-sau-loi-bot": async (t, ctx) => {
      // Lượt đổi ý: chốt đơn cũ bị từ chối.
      assert.match(JSON.stringify(t.turns[1].rounds.map((x) => x.results)), /"error":"(?:KHÔNG tự tăng «Chả mực giã tay» lên 2kg|Đơn nháp KHÁC lượng khách vừa nói)/, "confirm_order từ chối đơn lệch giỏ");
      // Huỷ lần đầu: máy chủ, không model; xin lỗi cụ thể + đơn đã sửa.
      const r1 = t.turns[2];
      assert.equal(r1.rounds.length, 0, "không gọi model");
      assert.equal(r1.shown.length, 1, `một câu: ${JSON.stringify(r1.shown)}`);
      assert.match(r1.shown[0], /xin lỗi/);
      assert.match(r1.shown[0], /2kg Chả mực giã tay trong khi mình đặt 500g/, "gọi tên đúng lỗi số lượng");
      assert.match(r1.shown[0], /1kg Chả cá thu \+ 500g Chả mực giã tay/, "đơn đúng như khách đặt");
      assert.match(r1.shown[0], /480\.000/, "số tiền từ báo giá máy chủ của giỏ khách nói");
      assert.ok(!/1\.060\.000|đổi món|điều chỉnh gì/.test(r1.shown[0]), "không tổng cũ, không câu giữ đơn chung");
      assert.equal(r1.status, "OPEN");
      // Huỷ lần hai: huỷ thật qua vòng đời đơn, rồi mới nói «đã huỷ».
      const r2 = t.turns[3];
      assert.equal(r2.rounds.length, 0, "không gọi model, không lượt giữ đơn thứ hai");
      assert.equal(r2.shown.length, 1);
      assert.match(r2.shown[0], /đã huỷ đơn #<MÃ ĐƠN>/);
      const { order, state, row } = await (async () => ({ ...(await orderOf(ctx.conversationId)), row: (await convRow(ctx.conversationId)).row }))();
      assert.equal(order?.stage, "CANCELLED", "đơn «Đã huỷ» trong CSDL");
      assert.ok(state.declined, "khách đã từ chối ⇒ không còn kịch bản nhắc");
      assert.equal(state.cancelRequest, undefined);
      assert.equal(row.nextFollowupAt, null, "lịch nhắc đã dọn");
      assert.ok(sendGuardChecked, "đã kiểm cổng gửi");
    },
    "gc-863-khong-huy-sau-cuu": async (t, ctx) => {
      assert.match(t.turns[2].shown[0] ?? "", /xin lỗi/, "lượt huỷ đầu: máy chủ giữ đơn");
      const r = t.turns[3];
      assert.ok(r.rounds.length > 0, "câu phủ định huỷ KHÔNG đi đường huỷ của máy chủ — model trả lời");
      assert.match(JSON.stringify(r.rounds.map((x) => x.results)), /khách nói KHÔNG huỷ|KHÔNG \/ CHƯA huỷ/, "cancel_order CANCEL bị từ chối");
      assert.ok(!r.shown.some((x) => /đã huỷ/.test(x)), `không câu «đã huỷ»: ${JSON.stringify(r.shown)}`);
      const { order } = await orderOf(ctx.conversationId);
      assert.notEqual(order?.stage, "CANCELLED", "đơn KHÔNG bị huỷ");
    },
    "gc-863-khong-huy-di": async (t, ctx) => {
      assert.match(t.turns[2].shown[0] ?? "", /xin lỗi/, "lượt huỷ đầu: máy chủ giữ đơn");
      const r = t.turns[3];
      assert.equal(r.rounds.length, 0, "huỷ lần hai do máy chủ quyết");
      assert.match(r.shown[0] ?? "", /đã huỷ đơn #<MÃ ĐƠN>/);
      const { order } = await orderOf(ctx.conversationId);
      assert.equal(order?.stage, "CANCELLED", "đơn ĐÃ huỷ trong CSDL");
    },
    "gc-863-dung-huy-lan-dau": async (t, ctx) => {
      const r = t.turns[2];
      assert.ok(r.rounds.length > 0, "không phải nhánh huỷ của máy chủ");
      assert.ok(!r.shown.some((x) => /xin lỗi|huỷ đơn giúp/.test(x)), `không xin lỗi / đề nghị huỷ: ${JSON.stringify(r.shown)}`);
      const { order, state } = await orderOf(ctx.conversationId);
      assert.notEqual(order?.stage, "CANCELLED");
      assert.equal(state.cancelRequest, undefined, "không mở yêu cầu huỷ");
      assert.ok(!orderReviewOf(order?.raw)?.entries.some((e) => e.code === "CUSTOMER_CANCELLED"), "không cờ «khách huỷ»");
    },
    "gc-863-da-thu-tien": async (t, ctx) => {
      assert.equal(t.turns[2].rounds.length, 0, "huỷ lần hai do máy chủ quyết");
      assert.deepEqual(t.turns[2].shown, [], "kênh nhắn tin chuyển người ⇒ bot im, không câu «đã huỷ»");
      assert.equal(t.final.status, "HANDOFF");
      const { order } = await orderOf(ctx.conversationId);
      assert.notEqual(order?.stage, "CANCELLED", "đơn đã thu tiền không tự huỷ");
      const cancellation = (order?.raw as Record<string, unknown> | null)?.cancellation as { status?: string; exception?: { code?: string } } | undefined;
      assert.equal(cancellation?.exception?.code, "PAID_ORDER", "lý do vào hàng ngoại lệ: đã thu tiền");
    },
    "gc-863-da-giao": async (t, ctx) => {
      assert.equal(t.turns[2].rounds.length, 0);
      assert.deepEqual(t.turns[2].shown, [], "không đề nghị, không khẳng định gì");
      assert.equal(t.final.status, "HANDOFF");
      const { order } = await orderOf(ctx.conversationId);
      assert.equal(order?.stage, "SHIPPED", "đơn không đổi trạng thái");
      assert.ok((order?.raw as Record<string, unknown> | null)?.cancellation, "yêu cầu huỷ vẫn được ghi lên đơn (raw.cancellation)");
    },
    "gc-863-nhan-vien-bao-tong-khac": async (t, ctx) => {
      assert.equal(t.turns[1].rounds.length, 0, "không gọi model");
      assert.deepEqual(t.turns[1].shown, [], "bot không nói lại tổng đơn nháp");
      assert.equal(t.final.status, "HANDOFF");
      assert.match(t.final.handoffReason ?? "", /Nhân viên báo tổng 480\.000/);
      const { order } = await orderOf(ctx.conversationId);
      assert.ok(orderReviewOf(order?.raw)?.entries.some((e) => e.code === "UPSELL_UNCONSENTED"), "đơn mang cờ món / số lượng chưa đồng ý");
    },
  };
  await runGoldenCases(CASES, {
    orgSuffix: "-p863",
    beforeCase: async (_c, ctx) => seed(ctx),
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      await checks[c.key](t, ctx);
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
}

export async function testP0863CancelFlow() {
  testPure();
  await testGolden();
  console.log("  ✓ P0 #863: «1/2 kg» + nhắc lại cả giỏ ⇒ đơn đúng 480.000 ₫ · tin phía page tới giữa lượt ⇒ bot không gửi · huỷ sau lỗi bot ⇒ xin lỗi cụ thể + đơn đã sửa (một lượt giữ đơn) · huỷ lần hai ⇒ huỷ qua vòng đời, «đã huỷ» sau khi ghi · đã thu tiền / đã giao ⇒ chuyển người · nhân viên báo tổng khác ⇒ chuyển người");
}

if (process.argv[1] && /p0-863-cancel-flow.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0863CancelFlow)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

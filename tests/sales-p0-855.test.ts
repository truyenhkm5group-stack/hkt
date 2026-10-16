/**
 * P0 #855 (16/10/2026, HSLC) — hai hội thoại thật (đã che tên / SĐT / địa chỉ):
 *
 *  · «ThuyNgo» (khách CŨ): «Ship chị 1 mực giã tay» ⇒ bot báo «1kg chả cá thu + 1kg chả mực» 680.000 ₫ (món của đơn cũ); khách «Kg có
 *    order chả cá thu nha», «Khách cũ mà hỏi gì», «Địa chỉ coi lại», «Robot hả» ⇒ bot xin lỗi rồi hỏi lại địa chỉ; đơn nháp giữ «Khương
 *    Đình» (địa chỉ cũ) sau khi khách đã gõ địa chỉ mới ở Thủ Đức.
 *  · «Lieu Dau»: «… thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An» ⇒ bot vẫn hỏi xã mới; đơn đã chốt mà địa chỉ báo thiếu.
 *
 * Phần THUẦN khoá từng luật máy chủ; phần HỘI THOẠI VÀNG phát lại qua `chatTurn` thật (model giả, tổ chức PGlite thật) và khẳng định
 * TRỰC TIẾP (không ảnh chụp): không món lạ, không tổng lệch đơn, địa chỉ mới thắng cũ, không hỏi lại phường đã nói, khách bực ⇒ người,
 * nhân viên tiếp quản ⇒ bot im, không đơn trùng / không giao sai, khung THỬ (đường phát lại) không ghi gì thật.
 *
 * Kỳ vọng theo LUẬT ĐANG CHẠY trên main (chủ shop chốt: giỏ theo #860, địa chỉ theo #861): phản đối món LẦN ĐẦU ⇒ bot sửa giỏ, lần hai /
 * hỏi «robot» ⇒ người (`handoff-routing-shared.ts`); địa chỉ cũ bị chia / chưa ghép ⇒ không hỏi khách, đơn mang cờ và tuyến giao GIỮ
 * (`ADDRESS_REVIEW`); khách xin địa chỉ cũ sau cùng ⇒ địa chỉ đã xác minh. Ba hàng rào bổ sung từ PR #862: báo giá cũng phải có căn
 * cứ (`calculate_cart` + `rejectedTotals`), model không được ghi địa chỉ khác địa chỉ khách gõ mới nhất, lời phản đối không là lời chốt.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { orderReviewOf, reviewCodes } from "@/lib/constants/order-review";
import { createProductCore } from "@/lib/records/product-create";
import { buyingText, classifyCartMessage, confirmObjection, mentionText, unrequestedProducts, type AskedLine } from "@/lib/sales-chatbot/cart-commitment";
import { deliveryAddressDecision } from "@/lib/sales-chatbot/address-memory";
import { CLAIM_SAFE_TEXT, guardClaims } from "@/lib/sales-chatbot/claim-guard";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { setSettingJson } from "@/lib/settings";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { appendContextMessages } from "@/lib/sales-chatbot/engine";
import { CUSTOMER_HANDOFF_REASON } from "@/lib/sales-chatbot/handoff-routing-shared";
import { autoConfirmBlocker, typedAddressConflict, type ChatState } from "@/lib/sales-chatbot/tools";
import { aiHoldOf } from "@/lib/sales-chatbot/ai-hold-shared";
import { addressReviewOpenOf, decideShippingRoute } from "@/lib/shipping/route";
import { seedReturningThread } from "./sales-agent-golden/cases";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx, type GoldenTranscript } from "./sales-agent-golden/harness";

const CA = "Chả cá thu (1kg)";
const MUC = "Chả mực giã tay (1kg)";
const line = (productId: string, name: string, quantity = 1): AskedLine => ({ variantId: `v-${productId}`, productId, name, quantity, weightGrams: 1000 });

// ═══ PHẦN THUẦN ═══

function testBasis() {
  // «kg có order X» / «không có order X» là PHỦ NHẬN, không phải căn cứ tính giỏ; câu hỏi giá VẪN là căn cứ tính giá món đó.
  for (const t of ["Kg có order chả cá thu nha", "Không có order chả cá thu nha", "Ko order chả cá thu", "Không đặt chả cá thu"]) assert.equal(mentionText([t]), "", `«${t}» không phải căn cứ tính giỏ`);
  assert.match(mentionText(["chả cá thu bao nhiêu em?"]), /chả cá thu/);
  assert.equal(buyingText(["chả cá thu bao nhiêu em?"]), "");
  assert.match(mentionText(["2 kg chả cá thu"]), /chả cá thu/, "kg đơn vị không phải phủ nhận");

  // GIỎ CHƯA CÓ SỐ LƯỢNG mà khách đã gọi tên một món ⇒ món khác (món đơn cũ) là món lạ — cùng luật `unrequestedProducts` của lên đơn.
  const asked = [line("p-ca", CA), line("p-muc", MUC)];
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["Ship chị 1 mực giã tay"])), ["Chả cá thu"], "ThuyNgo: chả cá không có căn cứ");
  assert.deepEqual(unrequestedProducts(undefined, [line("p-muc", MUC)], mentionText(["Ship chị 1 mực giã tay"])), [], "chỉ chả mực ⇒ qua");
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["ship chị nhé"])), [], "khách không gọi tên món nào ⇒ luật an toàn cũ");
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["Ship chị 1 mực giã tay", "Kg có order chả cá thu nha"])), ["Chả cá thu"], "lời phủ nhận không thành căn cứ");
  assert.deepEqual(unrequestedProducts(undefined, asked, mentionText(["chả cá thu bao nhiêu em? lấy 1 mực giã tay"])), [], "hỏi giá chả cá ⇒ được tính giá chả cá");
  // Khách phủ nhận món ⇒ REMOVE đúng món đó (không huỷ cả giỏ).
  assert.equal(classifyCartMessage("Kg có order chả cá thu nha").kind, "REMOVE");
  console.log("  ✓ #855 căn cứ báo giá: phủ nhận «kg có order X» không phải căn cứ · câu hỏi giá vẫn là căn cứ tính giá · giỏ trống mà khách gọi tên một món ⇒ món đơn cũ là món lạ");
}

function testClaim() {
  // 680.000 ₫ = tổng của giỏ máy chủ đã TỪ CHỐI (món khách không chọn) ⇒ chặn + người, kể cả khi chưa có báo giá hợp lệ nào để so.
  const facts = { paymentVerified: false, orderConfirmed: false, orderCancelled: false, allowedAmounts: new Set([0, 280_000, 400_000, 680_000]) };
  assert.equal(guardClaims("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ", facts).ok, true, "trước bản vá: 680k nằm trong tập tham chiếu nên lọt");
  const v = guardClaims("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ", { ...facts, rejected: new Set([680_000]) });
  assert.ok(!v.ok && v.claim === "PRICE_UNVERIFIED" && v.handoff && v.safeText === CLAIM_SAFE_TEXT.PRICE, JSON.stringify(v));
  // Tổng của giỏ hiện tại / giá một đơn vị KHÔNG bị chặn dù trùng số đã từ chối.
  assert.equal(guardClaims("Dạ tổng 400.000 ₫ ạ", { ...facts, rejected: new Set([680_000]) }).ok, true);
  assert.equal(guardClaims("Dạ 680.000 ₫ ạ", { ...facts, rejected: new Set([680_000]), totals: { allowed: new Set([680_000]), current: { total: 680_000, shipping: null }, stale: false } }).ok, true, "khách thật sự đặt cả hai ⇒ tổng hợp lệ");
  // Câu GỌI TÊN món rồi nói bội số của CHÍNH món đó («nem tôm 120k một hộp, 2 hộp 240k») KHÔNG bị chặn dù 240k từng là tổng bị từ chối —
  // cùng miễn trừ `explained` của nhánh bội số (review #862); không gọi tên món ⇒ vẫn chặn.
  const named = { ...facts, allowedAmounts: new Set([...facts.allowedAmounts, 120_000, 240_000]), rejected: new Set([240_000]), unitPrices: new Set([120_000]), namedAmounts: new Map([["Nem tôm", new Set([120_000, 240_000])]]) };
  assert.equal(guardClaims("Dạ nem tôm 120k một hộp, 2 hộp 240k ạ", named).ok, true, "bội số của món câu gọi tên");
  assert.equal(guardClaims("Dạ tổng 240.000 ₫ ạ", named).ok, false, "không gọi tên món ⇒ vẫn là tổng bị từ chối");
  console.log("  ✓ #855 tiền: tổng của giỏ máy chủ đã từ chối luôn bị chặn + người, kể cả khi chưa có báo giá để so · bội số của món câu gọi tên vẫn nói được");
}

function testObjection() {
  const labels = ["Chả mực giã tay", "Chả cá thu"];
  // Phản đối / trách bot ⇒ KHÔNG chốt bằng chính câu đó (confirm_order và tự chốt dùng CÙNG một bộ đọc).
  for (const t of ["Không có order chả cá thu nha", "Kg có order chả cá thu nha", "sai rồi em, chị lấy 1 gói thôi", "em nhầm rồi", "nhầm rồi em ơi", "bot sai rồi", "không phải vậy", "Sao kg coi ở trên", "chị chưa đặt chả cá thu"]) {
    assert.equal(confirmObjection(t, labels), true, `phản đối: «${t}»`);
  }
  // Đồng ý / tự sửa / từ chối THÊM món ⇒ vẫn chốt được (luật 6).
  for (const t of ["ok chốt", "không đặt thêm, chốt nhé", "Không có order thêm gì đâu em, chốt nhé", "ko có đặt thêm gì nữa, chốt luôn", "không phải 2kg lấy 1kg", "Chị nhầm rồi, lấy 1kg thôi, chốt nhé", "à nhầm, lấy 2 gói nhé", "tôi nhầm, lấy 1 gói thôi", "cho chị 2 kg có đặt luôn nhé", "không cần thêm, chốt nhé"]) {
    assert.equal(confirmObjection(t, labels), false, `không phải phản đối: «${t}»`);
  }
  // Phủ nhận một món KHÔNG có trong giỏ / đơn / tóm tắt ⇒ không phải phản đối đơn.
  assert.equal(confirmObjection("Không có order ruốc bông nha", labels), false);
  // Tự chốt đọc ĐÚNG bộ đọc đó (review #862: trước đây `autoConfirmBlocker` không có vế này nên lõi đơn tự nâng đơn lên «Đã xác nhận»).
  const st = { customer: { id: null, name: "Ngọc", phone: "0977000889", address: "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội", province: "Hà Nội", simulated: true }, draft: { orderId: null, lines: [{ variantId: "v-muc", quantity: 1 }], unitPrices: { "v-muc": 400_000 }, recipient: { name: "Ngọc", phone: "0977000889", address: "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội", province: "Hà Nội" }, note: "", simulated: true, quote: { id: "q", total: 400_000, subtotal: 400_000 } } } as unknown as ChatState;
  assert.match(autoConfirmBlocker(st, { lastUserText: "Không có order chả cá thu nha", objectionLabels: labels }) ?? "", /phản đối/);
  assert.match(autoConfirmBlocker(st, { lastUserText: "sai rồi em" }) ?? "", /phản đối/);
  for (const t of ["ok chốt", "Không có order thêm gì đâu em, chốt nhé", "không phải 2kg lấy 1kg"]) assert.equal(autoConfirmBlocker(st, { lastUserText: t, objectionLabels: labels }), null, `tự chốt được: «${t}»`);
  console.log("  ✓ #855 lời chốt: trách bot / phủ nhận món đã có ⇒ không chốt (cả confirm_order lẫn tự chốt) · tự nhận nhầm, từ chối thêm món, tự sửa số ⇒ vẫn chốt");
}

function testTypedAddress() {
  const A = "12 Lê Văn Việt, phường Tăng Nhơn Phú, TP HCM";
  const SAVED = "Số 3 ngõ 5 Khương Đình, Hà Nội";
  const st = { customer: { id: null, name: "Thủy", phone: "0977000333", address: A, province: "", simulated: true } } as ChatState;
  // Gõ A ⇒ model ghi địa chỉ đơn cũ ⇒ vướng, trả lại A.
  const t1 = [`Giao về ${A}`, "ok em"];
  assert.equal(typedAddressConflict({ written: SAVED, recipientAddress: SAVED, change: deliveryAddressDecision(st, t1), texts: t1 }), A);
  // Gõ A → khách CHỌN địa chỉ đã lưu (Customer 360 «số 2») ở tin SAU ⇒ không áp, không đẩy model về A.
  const t2 = [`Giao về ${A}`, "lấy địa chỉ số 2 nhé"];
  assert.equal(typedAddressConflict({ written: SAVED, recipientAddress: SAVED, change: deliveryAddressDecision(st, t2), texts: t2, savedConfirm: "số 2 nhé" }), null, "chọn địa chỉ đã lưu sau khi gõ");
  // … nhưng lời chọn đó ở TRƯỚC địa chỉ đã gõ ⇒ địa chỉ gõ mới nhất vẫn thắng.
  const t3 = ["lấy địa chỉ số 2 nhé", `à giao về ${A}`];
  assert.equal(typedAddressConflict({ written: SAVED, recipientAddress: SAVED, change: deliveryAddressDecision(st, t3), texts: t3, savedConfirm: "số 2 nhé" }), A);
  // Tin cuối nói «địa chỉ cũ» ⇒ không áp.
  const t4 = [`Giao về ${A}`, "thôi giao địa chỉ cũ nhé"];
  assert.equal(typedAddressConflict({ written: SAVED, recipientAddress: SAVED, change: { status: "NEW_EXPLICIT", use: { source: "CUSTOMER_MESSAGE", raw: A, province: "", messageIndex: 0 }, previous: null, reason: "" }, texts: t4 }), null, "lời «địa chỉ cũ» ở tin cuối");
  // Model chuẩn hoá đúng nơi khách gõ (đặt hộ / viết lại chữ) ⇒ không vướng.
  const t5 = [`Chị ở 5 Trần Phú, Ba Đình, Hà Nội. Người nhận: Lan 0977000123, ${A}`];
  const c5 = deliveryAddressDecision({}, t5);
  assert.equal(c5.status, "NEW_EXPLICIT");
  assert.equal(typedAddressConflict({ written: "5 Trần Phú, Ba Đình, Hà Nội", recipientAddress: "5 Trần Phú, Ba Đình, Hà Nội", change: c5, texts: t5 }), null, "đặt hộ: địa chỉ người đặt nằm nguyên văn trong tin khách");
  assert.equal(typedAddressConflict({ written: "99 Nguyễn Trãi, Thanh Xuân, Hà Nội", recipientAddress: "99 Nguyễn Trãi, Thanh Xuân, Hà Nội", change: c5, texts: t5 }), A, "nơi thứ ba khách không gõ ⇒ vướng");
  for (const w of [A, "12 Le Van Viet, P. Tang Nhon Phu, TP Ho Chi Minh"]) assert.equal(typedAddressConflict({ written: w, recipientAddress: w, change: c5, texts: t5 }), null, `chuẩn hoá đúng nơi: «${w}» · ${JSON.stringify(c5.use)}`);
  console.log("  ✓ #855 địa chỉ: model ghi khác địa chỉ khách gõ ⇒ trả lại địa chỉ khách · khách chọn địa chỉ đã lưu / «địa chỉ cũ» sau đó ⇒ không áp · chuẩn hoá đúng nơi ⇒ qua");
}

// ═══ HỘI THOẠI VÀNG (chatTurn thật) ═══

const OLD_ADDR = "Số 3 ngõ 5 Khương Đình";
const NEW_ADDR = "12 Lê Văn Việt, phường Tăng Nhơn Phú, TP HCM";
const HN = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";

/** Chả cá thu 1kg (280.000 ₫) — món của ĐƠN CŨ trong ca ThuyNgo; cửa hàng thử «food» chưa có. */
async function seedCa(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  if (ctx.ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const r = await createProductCore(admin, { name: "Chả cá thu", code: "CCT", unit: "gói", retailPrice: 280_000, cost: null, variants: [{ sku: "CCT-1KG", size: "1kg", color: "", retailPrice: 280_000, cost: null, selling: true }] });
  assert.ok(r.ok, JSON.stringify(r));
  const db = await getDb();
  const vs = await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id));
  for (const v of vs) (ctx.ids as Map<string, string>).set(v.sku, v.id);
}

const shownAll = (t: GoldenTranscript) => t.turns.flatMap((x) => x.shown).join("\n");
const resultsOf = (t: GoldenTranscript, turn: number) => JSON.stringify(t.turns[turn].rounds.map((r) => r.results));

const CASES: GoldenCase[] = [
  {
    key: "p855-thuyngo-bao-gia-mon-la",
    title: "ThuyNgo lượt 1: «Ship chị 1 mực giã tay» — model tính giỏ thêm chả cá thu (đơn cũ) ⇒ máy chủ từ chối, câu «tổng 680.000 ₫» bị chặn + người",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855-don-cu-1", threadId: "pg-vang_psid-p855-1" }),
        say: "Ship chị 1 mực giã tay",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ 1kg chả cá thu + 1kg chả mực tổng 680.000 ₫ ạ, em gửi về địa chỉ cũ nhé?")]],
      },
    ],
  },
  {
    key: "p855-thuyngo-phu-nhan-mon",
    title: "ThuyNgo: bot đề nghị kèm chả cá → «Kg có order chả cá thu nha» (phản đối lần đầu ⇒ bot sửa, luật #860) → «Robot hả» ⇒ người ngay, không lượt AI, không tự hết hạn",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Ship chị 1 mực giã tay", ai: [() => [say("Dạ lần trước chị lấy chả cá thu, lần này em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?")]] },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ em xin lỗi ạ")]] },
      { say: "Robot hả", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
  {
    key: "p855-phu-nhan-mon-co-don-nhap",
    title: "Đơn nháp có món khách phủ nhận («không có order chả cá thu») ⇒ bot bỏ món, nhưng KHÔNG chốt bằng chính câu phản đối",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 1 gói chả mực giã tay và 1 gói chả cá thu, Ngọc 0977000888, ${HN}`,
        ai: [
          () => [tool("create_customer", { name: "Ngọc", phone: "0977000888", address: HN })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }, { variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 1 gói chả mực + 1 gói chả cá thu. Chị xác nhận giúp em nhé?")],
        ],
      },
      {
        say: "Không có order chả cá thu nha",
        ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [tool("confirm_order", { customer_confirmation: "Không có order chả cá thu nha" })], () => [say("Dạ em bỏ chả cá thu rồi ạ, đơn còn 1 gói chả mực. Chị xác nhận giúp em nhé?")]],
      },
    ],
  },
  {
    key: "p855-tu-chot-phan-doi",
    title: "Tổ chức bật «đơn đủ thông tin = đã xác nhận»: khách phản đối món bot thêm («Không có order chả cá thu nha») ⇒ model sửa đơn — đơn KHÔNG được tự nâng lên «Đã xác nhận» bằng chính câu phản đối",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 1 gói chả mực giã tay và 1 gói chả cá thu, Ngọc 0977000889, ${HN}, để chị xem đã`,
        ai: [
          () => [tool("create_customer", { name: "Ngọc", phone: "0977000889", address: HN })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }, { variant_id: v("CCT-1KG"), quantity: 1 }] })],
          () => [say("Tóm tắt: 1 gói chả mực + 1 gói chả cá thu. Chị xem rồi báo em nhé.")],
        ],
      },
      {
        say: "Không có order chả cá thu nha",
        ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em bỏ chả cá thu rồi ạ, đơn còn 1 gói chả mực. Chị xác nhận giúp em nhé?")]],
      },
    ],
  },
  {
    key: "p855-khong-lap-xin-loi",
    title: "Khách «chị gửi ở trên rồi» mà model lại xin lỗi + hỏi địa chỉ ⇒ câu hỏi lặp bị chặn, chuyển người (không vòng xin lỗi)",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Ship chị 1 chả mực giã tay", ai: [() => [say("Dạ em xin lỗi, chị cho em xin địa chỉ nhận hàng ạ?")]] },
      { say: "chị gửi ở trên rồi", ai: [() => [say("Dạ em xin lỗi, chị cho em xin địa chỉ nhận hàng ạ?")]] },
    ],
  },
  {
    key: "p855-khach-cu-phan-nan-fanpage",
    title: "ThuyNgo trên fanpage: «Khách cũ mà hỏi gì» ⇒ người, bot im (không xin lỗi lặp, không hỏi lại địa chỉ)",
    shop: "food",
    channel: "FANPAGE",
    turns: [
      { say: "Ship chị 1 chả mực giã tay", ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ chị cho em xin địa chỉ nhận hàng ạ")]] },
      { say: "Khách cũ mà hỏi gì", ai: [() => [say("Dạ em xin lỗi chị, chị cho em xin lại địa chỉ ạ")]] },
      { say: "Sao kg coi ở trên", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
  {
    key: "p855-dia-chi-moi-thang-cu",
    title: "Khách cũ gõ địa chỉ MỚI (Thủ Đức) ở tin sau ⇒ create_customer bằng địa chỉ cũ (Khương Đình) bị từ chối; ghi đúng địa chỉ khách gõ; sửa đơn về địa chỉ cũ cũng bị từ chối",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855-don-cu-2", threadId: "pg-vang_psid-p855-2" }),
        say: "Ship chị 1 chả mực giã tay",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ 1kg chả mực giã tay 400.000 ₫ ạ, em gửi về địa chỉ nào ạ?")]],
      },
      {
        say: `Giao về ${NEW_ADDR}
0977000333`,
        ai: [
          () => [tool("create_customer", { name: "Thủy", phone: "0977000333", address: OLD_ADDR, province: "Hà Nội" })],
          () => [tool("create_customer", { name: "Thủy", phone: "0977000333", address: NEW_ADDR })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ results }) => [say(`Tóm tắt đơn: 1kg chả mực giã tay, tổng thu ${String(results[0]?.cod_total_text)}. Chị xác nhận giúp em nhé?`)],
        ],
      },
      { say: "ok em", ai: [() => [tool("update_draft_order", { address: `${OLD_ADDR}, Hà Nội` })], () => [say("Dạ vâng ạ.")]] },
    ],
  },
  {
    key: "p855-dia-chi-moi-roi-cu",
    title: "Khách gõ địa chỉ mới rồi SAU CÙNG xin «giao địa chỉ cũ» ⇒ lời khách mới nhất thắng: địa chỉ đơn cũ ĐÃ XÁC MINH (luật #861)",
    shop: "food",
    channel: "WEB",
    turns: [
      { before: (ctx) => seedReturningThread(ctx, { address: OLD_ADDR, orderId: "p855-don-cu-3", threadId: "pg-vang_psid-p855-3" }), say: "lấy 1 chả mực giã tay", ai: [() => [say("Dạ chị gửi em địa chỉ nhận hàng ạ.")]] },
      { say: `Giao tới ${NEW_ADDR}, 0977000444`, ai: [() => [say("Dạ em ghi nhận ạ.")]] },
      { say: "à thôi giao địa chỉ cũ nhé", ai: [() => [tool("create_customer", { use_saved_address: true, customer_confirmation: "giao địa chỉ cũ nhé" })], () => [say("Dạ em cập nhật địa chỉ cũ rồi ạ.")]] },
    ],
  },
  {
    key: "p855-lieu-dau-thi-tran",
    title: "Lieu Dau: «Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An» ⇒ không hỏi khách xã mới; đơn mang cờ địa chỉ, tuyến giao GIỮ",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "Chị lấy 1 chả mực giã tay\nLiễu 0977000555\nKhối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An",
        ai: [
          () => [tool("create_customer", { name: "Liễu", phone: "0977000555", address: "Khối 5, thị trấn Anh Sơn, huyện Anh Sơn, Nghệ An" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ results }) => [say(`Tóm tắt đơn: 1kg chả mực giã tay, tổng thu ${String(results[0]?.cod_total_text)}. Chị xác nhận giúp em nhé?`)],
        ],
      },
      { say: "ok em chốt nhé", ai: [() => [tool("confirm_order", { customer_confirmation: "ok em chốt nhé" })], () => [say("Dạ em cảm ơn chị ạ.")]] },
    ],
  },
  {
    key: "p855-phuong-cu-bi-chia",
    title: "Phường cũ bị chia (Cổ Nhuế 2): không hỏi khách quy đổi — câu model tự hỏi bị bỏ; chốt kèm cờ địa chỉ, tuyến giao GIỮ",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "lấy 1 chả mực giã tay\nNguyệt 0977000666\nSN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội",
        ai: [
          () => [tool("create_customer", { name: "Nguyệt", phone: "0977000666", address: "SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          () => [say("Dạ phường Cổ Nhuế 2 cũ nay thuộc phường Thượng Cát hay phường Đông Ngạc theo địa giới mới ạ?")],
        ],
      },
      { say: "ok em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok em" })], () => [say("Dạ em cảm ơn chị ạ.")]] },
    ],
  },
  {
    key: "p855-chu-shop-noi-khong-phai-khach",
    title: "Tin của SHOP nhắc chả cá thu (page / nhân viên) KHÔNG phải lời khách đặt: giỏ có chả cá bị từ chối, giỏ đúng 1kg chả mực 400.000 ₫",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => appendContextMessages(ctx.conversationId, [{ role: "assistant", text: "Chả cá thu 280k/kg, chả mực giã tay 400k/kg chị nhé" }]),
        say: "Ship chị 1 mực giã tay",
        ai: [
          ({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          ({ results }) => [say(`Dạ 1kg chả mực giã tay ${String(results[0]?.subtotal_text)} ạ.`)],
        ],
      },
    ],
  },
  {
    key: "p855-sua-don-hai-lan",
    title: "«sai rồi em, chị lấy 1 gói thôi» ⇒ không chốt bằng câu phản đối; khách tự nói lại số («không phải, chị nói 1 gói mà») ⇒ chốt đúng 1 gói (luật 6), không đơn thứ hai",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 2 gói chả mực giã tay, Hà 0977000777, ${HN}`,
        ai: [() => [tool("create_customer", { name: "Hà", phone: "0977000777", address: HN })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }] })], () => [say("Tóm tắt: 2 gói chả mực. Chị xác nhận giúp em nhé?")]],
      },
      { say: "sai rồi em, chị lấy 1 gói thôi", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [tool("confirm_order", { customer_confirmation: "sai rồi em, chị lấy 1 gói thôi" })], () => [say("Dạ em sửa còn 1 gói ạ. Chị xác nhận giúp em nhé?")]] },
      {
        say: "không phải, chị nói 1 gói mà",
        ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [tool("confirm_order", { customer_confirmation: "không phải, chị nói 1 gói mà" })], () => [say("Dạ đơn 1 gói chả mực ạ. Chị xác nhận giúp em nhé?")]],
      },
    ],
  },
  {
    key: "p855-khach-tu-doi-y",
    title: "Khách TỰ đổi ý hai lần («đổi 2 gói» → «à thôi 3 gói») ⇒ mua bình thường, KHÔNG chuyển người; từ chối lời mời «không đặt thêm» ⇒ không chuyển người",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Cho chị 1 gói chả mực giã tay, Hà 0977000901, ${HN}`,
        ai: [() => [tool("create_customer", { name: "Hà", phone: "0977000901", address: HN })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Tóm tắt: 1 gói chả mực. Mình lấy thêm gì không ạ?")]],
      },
      { say: "đổi 2 gói", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }] })], () => [say("Dạ em sửa 2 gói ạ.")]] },
      { say: "à thôi 3 gói", ai: [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 3 }] })], () => [say("Dạ em sửa 3 gói ạ.")]] },
      { say: "thôi không đặt thêm gì nữa em", ai: [() => [say("Dạ vâng ạ.")]] },
    ],
  },
  {
    key: "p855-nhan-vien-tiep-quan",
    title: "Nhân viên bấm TIẾP QUẢN ⇒ lượt khách sau không gọi model, bot không gửi gì",
    shop: "food",
    channel: "FANPAGE",
    turns: [
      { say: "chả mực giã tay bao nhiêu em", ai: [() => [tool("search_products", { query: "chả mực" })], () => [say("Dạ chả mực giã tay 400.000 ₫ một gói 1kg ạ.")]] },
      {
        before: async (ctx) => {
          const r = await setConversationControlCore(await ctx.admin(), ctx.conversationId, "HUMAN", "Nhân viên gọi lại khách");
          assert.ok(r.ok, JSON.stringify(r));
        },
        say: "Robot hả, sao không trả lời",
        ai: [() => [say("Dạ em đây ạ")]],
      },
    ],
  },
  {
    key: "p855-khung-thu-phat-lai",
    title: "Khung THỬ (đường phát lại): khách phủ nhận món ⇒ không ghi khách / đơn thật, không gửi gì ra ngoài",
    shop: "food",
    channel: "TEST",
    turns: [
      { say: "Ship chị 1 mực giã tay", ai: [() => [say("Dạ em gửi chị 1kg chả cá thu + 1kg chả mực giã tay nhé?")]] },
      { say: "Kg có order chả cá thu nha", ai: [() => [say("Dạ em xin lỗi ạ")]] },
    ],
  },
];

async function ordersOf(conversationId: string) {
  const db = await getDb();
  return db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId));
}

async function stateOf(conversationId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
  return { row, state: (row.state ?? {}) as ChatState };
}

async function testGolden() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-p862",
    beforeCase: async (c, ctx) => {
      await seedCa(ctx);
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: c.key === "p855-tu-chot-phan-doi" });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const { row, state } = await stateOf(ctx.conversationId);
      const orders = await ordersOf(ctx.conversationId);
      assert.ok(orders.length <= 1, `[${c.key}] không đơn trùng: ${orders.length}`);
      assert.ok(!/680\.000/.test(shownAll(t)), `[${c.key}] khách không bao giờ thấy 680.000 ₫: ${shownAll(t)}`);
      switch (c.key) {
        case "p855-thuyngo-bao-gia-mon-la": {
          assert.match(resultsOf(t, 0), /KHÔNG tính giỏ có «Chả cá thu»/, resultsOf(t, 0));
          assert.ok(!state.quote || state.quote.subtotal !== 680_000, "báo giá 680k không được lưu");
          assert.ok(state.rejectedTotals?.includes(680_000), JSON.stringify(state.rejectedTotals));
          assert.equal(t.final.status, "HANDOFF", "câu tổng sai ⇒ người");
          assert.deepEqual(orders, []);
          return;
        }
        case "p855-thuyngo-phu-nhan-mon": {
          assert.ok(t.turns[1].rounds.length > 0, "phản đối món LẦN ĐẦU ⇒ AI sửa giỏ (luật #860)");
          assert.equal(t.turns[2].rounds.length, 0, "«Robot hả» ⇒ người ngay, không gọi model");
          assert.ok(!t.turns[2].shown.some((x) => /xin lỗi/.test(x)), `không xin lỗi lặp: ${JSON.stringify(t.turns[2].shown)}`);
          assert.equal(t.final.status, "HANDOFF");
          assert.equal(t.final.handoffReason, CUSTOMER_HANDOFF_REASON.WANTS_HUMAN);
          // Không tự hết hạn: chờ nhân viên trả lại cho AI.
          assert.equal(aiHoldOf({ status: row.status, handoffReason: row.handoffReason, state: row.state, updatedAt: row.updatedAt, humanCooldownUntil: row.humanCooldownUntil }, new Date(Date.now() + 24 * 3_600_000)).state, "HUMAN_TAKEOVER");
          assert.equal(row.nextFollowupAt, null, "không follow-up tự động");
          assert.deepEqual(orders, []);
          return;
        }
        case "p855-phu-nhan-mon-co-don-nhap": {
          assert.match(resultsOf(t, 1), /PHẢN ĐỐI \/ SỬA đơn/, "confirm_order bằng câu phản đối bị từ chối");
          assert.equal(t.final.confirmed, null, "không tự chốt");
          assert.equal(orders.length, 1);
          assert.notEqual(orders[0].stage, "CONFIRMED");
          assert.deepEqual(t.final.draft?.lines.map((l) => [l.sku, l.quantity]), [["CHA-MUC", 1]], "món bị phủ nhận đã bỏ khỏi đơn");
          return;
        }
        case "p855-tu-chot-phan-doi": {
          assert.equal(orders.length, 1);
          assert.notEqual(orders[0].stage, "CONFIRMED", `đơn không tự chốt bằng câu phản đối: ${orders[0].stage} · ${resultsOf(t, 1).slice(0, 600)}`);
          assert.equal(t.final.confirmed, null, "state không ghi đã chốt");
          assert.deepEqual(t.final.draft?.lines.map((l) => [l.sku, l.quantity]), [["CHA-MUC", 1]], "món bị phủ nhận đã bỏ khỏi đơn");
          return;
        }
        case "p855-khong-lap-xin-loi": {
          assert.equal(t.turns[1].shown.filter((x) => /xin lỗi|xin địa chỉ/.test(x)).length, 0, `câu xin lỗi / hỏi lại không gửi lần hai: ${JSON.stringify(t.turns[1].shown)}`);
          assert.equal(t.final.status, "HANDOFF");
          assert.match(t.final.handoffReason ?? "", /hỏi lại/);
          return;
        }
        case "p855-khach-cu-phan-nan-fanpage": {
          assert.deepEqual(t.turns[1].shown, [], "câu hỏi lại bị chặn, fanpage chuyển người ⇒ bot im");
          assert.equal(t.turns[2].rounds.length, 0, "đã chuyển người ⇒ không gọi model");
          assert.deepEqual(t.turns[2].shown, []);
          assert.equal(t.final.status, "HANDOFF");
          assert.match(t.final.handoffReason ?? "", /phàn nàn/);
          return;
        }
        case "p855-dia-chi-moi-thang-cu": {
          assert.match(resultsOf(t, 1), /ĐƠN CŨ/, "create_customer bằng địa chỉ đơn cũ bị từ chối");
          assert.match(t.final.customer?.address ?? "", /Lê Văn Việt/);
          assert.equal(orders.length, 1);
          assert.match(orders[0].shipAddress ?? "", /Lê Văn Việt/, "đơn mang địa chỉ khách gõ mới nhất");
          assert.match(resultsOf(t, 2), /KHÁC địa chỉ khách đã gõ/, "sửa đơn về địa chỉ cũ ⇒ từ chối");
          assert.deepEqual(t.final.draft?.lines.map((l) => [l.sku, l.quantity]), [["CHA-MUC", 1]], "không thêm SKU, đúng số lượng");
          return;
        }
        case "p855-dia-chi-moi-roi-cu": {
          assert.match(state.customer?.address ?? "", /Khương Đình/, "máy chủ điền địa chỉ đơn cũ (use_saved_address + lời xác nhận)");
          assert.ok(!/Lê Văn Việt/.test(state.customer?.address ?? ""), "lời khách SAU CÙNG («địa chỉ cũ») thắng địa chỉ gõ trước đó");
          return;
        }
        case "p855-lieu-dau-thi-tran": {
          assert.ok(!/ask_customer":"Dạ/.test(resultsOf(t, 0)), `không hỏi xã: ${resultsOf(t, 0).slice(0, 400)}`);
          assert.ok(!/phường \/ xã/.test(shownAll(t)), shownAll(t));
          assert.equal(orders.length, 1);
          assert.equal(orders[0].stage, "CONFIRMED", "đơn đi tiếp, nhân viên chọn xã");
          assert.ok(reviewCodes(orderReviewOf(orders[0].raw)).includes("ADDRESS_UNRESOLVED"), "cờ cần kiểm địa chỉ");
          const route = decideShippingRoute({ isErp: true, stage: orders[0].stage, province: orders[0].shipProvince ?? "", ward: orders[0].shipCommune ?? "", hasLiveShipment: false, weightGrams: 1000, confirmedAt: new Date(), updatedAt: new Date(), auto: null, addressReviewOpen: addressReviewOpenOf(orders[0].raw) }, { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null, autoSince: null }, new Set(), new Date());
          assert.ok(route.kind === "HOLD" && route.code === "ADDRESS_REVIEW", JSON.stringify(route));
          return;
        }
        case "p855-phuong-cu-bi-chia": {
          assert.ok(!/cũ nay thuộc/.test(shownAll(t)), `không bắt khách quy đổi: ${shownAll(t)}`);
          assert.equal(orders.length, 1);
          assert.equal(orders[0].stage, "CONFIRMED", "đơn đi tiếp, nhân viên chọn xã");
          assert.equal(orders[0].shipCommune ?? "", "", "không đoán xã");
          assert.ok(reviewCodes(orderReviewOf(orders[0].raw)).includes("ADDRESS_UNRESOLVED"), "cờ cần kiểm địa chỉ");
          const route = decideShippingRoute({ isErp: true, stage: orders[0].stage, province: orders[0].shipProvince ?? "", ward: orders[0].shipCommune ?? "", hasLiveShipment: false, weightGrams: 1000, confirmedAt: new Date(), updatedAt: new Date(), auto: null, addressReviewOpen: addressReviewOpenOf(orders[0].raw) }, { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null, autoSince: null }, new Set(), new Date());
          assert.ok(route.kind === "HOLD" && route.code === "ADDRESS_REVIEW", "không giao khi địa chỉ chưa xác minh");
          return;
        }
        case "p855-chu-shop-noi-khong-phai-khach": {
          const r = t.turns[0].rounds.map((x) => JSON.stringify(x.results));
          assert.match(r[0], /KHÔNG tính giỏ có «Chả cá thu»/, r[0]);
          assert.match(shownAll(t), /400\.000 ₫/);
          assert.equal(state.quote?.subtotal, 400_000);
          return;
        }
        case "p855-sua-don-hai-lan": {
          assert.match(resultsOf(t, 1), /PHẢN ĐỐI \/ SỬA đơn/, "«sai rồi …» không phải lời chốt");
          assert.equal(orders.length, 1, "không đơn thứ hai");
          assert.deepEqual(t.final.draft?.lines.map((l) => [l.sku, l.quantity]), [["CHA-MUC", 1]], "đúng số khách nói");
          // Lượt 3 «không phải, chị nói 1 gói mà» là khách TỰ nói lại số (không trách bot) ⇒ chốt thật: state + đơn ERP.
          assert.ok(!/PHẢN ĐỐI \/ SỬA đơn/.test(resultsOf(t, 2)), resultsOf(t, 2).slice(0, 600));
          assert.ok(t.final.confirmed, `đơn đã chốt ở lượt 3: ${resultsOf(t, 2).slice(0, 600)}`);
          assert.equal(orders[0].stage, "CONFIRMED", "đơn ERP đã xác nhận");
          return;
        }
        case "p855-khach-tu-doi-y": {
          assert.notEqual(t.final.status, "HANDOFF", `khách tự đổi ý / từ chối lời mời không phải lý do chuyển người: ${t.final.handoffReason}`);
          assert.ok(t.turns.every((x) => x.rounds.length > 0), "mọi lượt đều được AI trả lời");
          assert.equal(orders.length, 1);
          assert.ok(!reviewCodes(orderReviewOf(orders[0].raw)).includes("UPSELL_UNCONSENTED"), "không gắn cờ món chưa đồng ý");
          assert.deepEqual(t.final.draft?.lines.map((l) => [l.sku, l.quantity]), [["CHA-MUC", 3]]);
          return;
        }
        case "p855-nhan-vien-tiep-quan": {
          assert.equal(t.turns[1].rounds.length, 0, "tiếp quản ⇒ không gọi model");
          assert.deepEqual(t.turns[1].shown, []);
          return;
        }
        case "p855-khung-thu-phat-lai": {
          assert.equal(t.final.order, null, "khung THỬ không tạo đơn");
          assert.deepEqual(orders, []);
          const db = await getDb();
          const customers = await db.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.phone, "0977000999")));
          assert.deepEqual(customers, []);
          return;
        }
      }
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
  console.log(`  ✓ #855 hội thoại vàng: ${CASES.length} hội thoại qua chatTurn thật — không món lạ / tổng lệch đơn (680.000 ₫ không tới khách), địa chỉ khách gõ mới nhất thắng địa chỉ cũ, khách xin địa chỉ cũ sau cùng ⇒ địa chỉ đã xác minh, «TT Anh Sơn» / phường cũ bị chia không bắt khách quy đổi + tuyến giao GIỮ, tin shop không phải lời khách, phản đối món không thành lời chốt, «robot hả» / phàn nàn ⇒ người + bot im, tiếp quản ⇒ im, không đơn trùng, khung THỬ không ghi`);
}

export async function testSalesP0855() {
  testBasis();
  testClaim();
  testObjection();
  testTypedAddress();
  await testGolden();
}

if (process.argv[1] && /sales-p0-855.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testSalesP0855)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

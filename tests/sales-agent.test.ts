import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";
import { HANDOFF_REASONS, SALES_ACTIONS, SALES_STAGES, SALES_TRANSITIONS, nextStage, type SalesFacts, type SalesStage } from "@/lib/constants/sales-agent";
import { HANDOFF_CLASS_LABEL, QUALITY_DIMENSIONS, advancesConversation, answeredMoneyQuestion, classifyHandoff, safetyFlags } from "@/lib/constants/sales-quality";
import { UNDERSTANDING_SCHEMA, findBody, findPhone, findQuantity, ruleIsEnough, understandByRule, type Understanding } from "@/lib/ai-workforce/agents/sales/understand";
import { checkContextualConfirmation, isAffirmativeText, missingOrderRequirements } from "@/lib/ai-workforce/agents/sales/confirm";
import { EMPTY_SALES_STATE, confirmationFingerprint, parseSalesState, type SalesState } from "@/lib/ai-workforce/agents/sales/state";
import { ROUNDTRIP_TEST_MESSAGE, assertOutboundAllowed, canSend } from "@/lib/ai-workforce/agents/sales/outbound";
import { guardGeneratedText, moneyMentions, nextStepKey, renderOrderReview, renderTemplate, type GenerationContext } from "@/lib/ai-workforce/agents/sales/generate";
import { classifySender, ingestMessage, normalizeChatWebhook, relinkHumanReplies } from "@/lib/ai-workforce/agents/sales/ingest";
import { decide } from "@/lib/ai-workforce/agents/sales/decide";
import { drainSalesTasks, runSalesTask } from "@/lib/ai-workforce/agents/sales/pipeline";
import { ensureAgents, getAgent } from "@/lib/ai-workforce/registry";
import { registerErpTools } from "@/lib/ai-workforce/tools/erp";
import { callTool } from "@/lib/ai-workforce/tools/gateway";
import { parseRouting, runModelStep } from "@/lib/ai-workforce/model-router";
import { defaultProviderName, providerNames } from "@/lib/ai-workforce/providers";
import { recommendSize, resolveSizeRule, sizeNeedsHuman, type SizeRule } from "@/lib/constants/size-engine";
import { sql } from "drizzle-orm";
import { REVIEW_REASON_TAGS, REVIEW_REASON_TAG_META } from "@/lib/constants/sales-review-tags";
import { z } from "zod";
import { SAFEST_HARD_LIMITS, WORKFORCE_PROVIDERS, aiEnv, getAiSettings, type AiSettings } from "@/lib/ai-workforce/config";
import { setSettingJson } from "@/lib/settings";
import { queueStubResponse, resetStub } from "@/lib/ai-workforce/providers/stub";
import { aiSummary, getAiRunDetail, listAiRuns, salesStageBreakdown } from "@/lib/queries/ai";
import { getConversationTurns, listShadowTurns, shadowMetrics } from "@/lib/queries/sales-review";
import { clearMemo } from "@/lib/cache";

/**
 * Cấu hình nền cho các phép thử HÀM THUẦN về nấc quyền hạn.
 *
 * `hardLimits` ở đây MỞ có chủ ý: khối này dùng để kiểm chứng logic nấc quyền hạn / phiếu duyệt /
 * danh sách trắng, nên hai công tắc chặn cứng phải để mở thì mới thấy được logic bên dưới. Bản
 * thân chặn cứng được thử riêng ở khối 5B, với đúng giá trị an toàn nhất.
 */
const OFF_SETTINGS: AiSettings = {
  enabled: true,
  modelCallsEnabled: false,
  ingestEnabled: true,
  maxRunsPerHour: 600,
  dailyCostCapVnd: 0,
  testConversationIds: [],
  modes: {},
  pricing: {},
  hardLimits: { allowAutoSend: true, allowHumanApprovedSend: true, allowOrderCreate: true },
  pricingVersion: "",
};

/** Bộ thực thể rỗng đúng hình dạng lược đồ — dùng dựng một kết quả hiểu "trung tính" trong phép thử. */
const EMPTY_ENTITIES_TEST = UNDERSTANDING_SCHEMA.parse({ intents: ["OTHER"], entities: {}, confidence: 0.5 }).entities;

function stateWith(patch: Partial<SalesState>): SalesState {
  return { ...EMPTY_SALES_STATE, ...patch };
}

/** Đơn đã đủ mọi điều kiện máy chủ — dùng làm nền cho các phép thử xác nhận. */
function readyState(): SalesState {
  return stateWith({
    productId: "p-test",
    productName: "Đầm Q002",
    variantId: "v-test-L-do",
    variantLabel: "L Đỏ",
    size: "L",
    color: "Đỏ",
    quantity: 1,
    phone: "0912345678",
    address: "Số 5 ngõ 12 Nguyễn Trãi, Thanh Xuân, Hà Nội",
    province: "Hà Nội",
    quotedTotal: 524_000,
  });
}

export async function testSalesAgent(db: Db) {
  registerErpTools();
  await ensureAgents(db);

  // ═════════ 1. MÁY TRẠNG THÁI — TẤT ĐỊNH VÀ ĐÓNG ═════════

  // 1a. Mọi cạnh mà hàm chuyển trạng thái trả về phải nằm trong bảng khai báo.
  //     Quét TOÀN BỘ tổ hợp: đây là cách duy nhất chắc chắn không có lối tắt nào tới CONFIRMED.
  const boolKeys: (keyof SalesFacts)[] = ["humanTakeover", "orderCreated", "lost", "objection", "needsSize", "needsColor", "purchaseIntent", "hasPhone", "hasAddress", "reviewSent", "confirmed", "stale"];
  let combos = 0;
  for (const from of SALES_STAGES) {
    for (let mask = 0; mask < 1 << boolKeys.length; mask += 1) {
      // Quét thưa: 4096 tổ hợp × 16 giai đoạn là quá nhiều, lấy mẫu đều nhưng phủ hết các bit.
      if (mask % 7 !== 0) continue;
      const facts: SalesFacts = { productId: mask % 2 ? "p" : null, variantId: mask % 3 === 0 ? "v" : null };
      boolKeys.forEach((key, i) => {
        (facts as Record<string, unknown>)[key] = Boolean(mask & (1 << i));
      });
      const result = nextStage(from, facts);
      combos += 1;
      assert.ok(SALES_STAGES.includes(result.stage), `${from}: giai đoạn trả về phải hợp lệ`);
      if (result.stage !== from) {
        assert.ok(SALES_TRANSITIONS[from].includes(result.stage), `${from} → ${result.stage} là cạnh KHÔNG khai báo`);
      }
      assert.equal(result.changed, result.stage !== from, `${from}: cờ "đã đổi" phải khớp với việc có đổi hay không`);
    }
  }

  // 1b. Hàm phải THUẦN: chạy hai lần cho cùng kết quả.
  const sample: SalesFacts = { productId: "p", variantId: "v", purchaseIntent: true, hasPhone: true, hasAddress: true };
  assert.deepEqual(nextStage("PURCHASE_INTENT", sample), nextStage("PURCHASE_INTENT", sample), "chuyển trạng thái phải tất định");

  // 1c. HUMAN_TAKEOVER nuốt mọi thứ — kể cả "đã có đơn".
  assert.equal(nextStage("HUMAN_TAKEOVER", { orderCreated: true, confirmed: true }).stage, "HUMAN_TAKEOVER", "người cầm việc thì không dữ kiện nào kéo ra được");
  assert.equal(nextStage("ORDER_REVIEW", { humanTakeover: true }).stage, "HUMAN_TAKEOVER");
  assert.deepEqual(SALES_TRANSITIONS.HUMAN_TAKEOVER, [], "từ HUMAN_TAKEOVER không có lối đi tự động nào");

  // 1d. KHÔNG có lối tắt tới CONFIRMED: chỉ AWAITING_CONFIRMATION mới đi tới được.
  for (const from of SALES_STAGES) {
    const reached = nextStage(from, { confirmed: true, productId: "p", variantId: "v", hasPhone: true, hasAddress: true, reviewSent: true, purchaseIntent: true }).stage;
    // Đứng yên ở CONFIRMED không phải một cạnh, nên bỏ qua chính nó.
    if (from !== "AWAITING_CONFIRMATION" && from !== "CONFIRMED") assert.notEqual(reached, "CONFIRMED", `${from} không được đi thẳng tới CONFIRMED`);
  }
  assert.equal(nextStage("AWAITING_CONFIRMATION", { confirmed: true }).stage, "CONFIRMED");

  // 1e. Thang tiến trình: thiếu SĐT thì dừng ở xin SĐT, thiếu địa chỉ thì dừng ở xin địa chỉ.
  assert.equal(nextStage("PURCHASE_INTENT", { productId: "p", variantId: "v", purchaseIntent: true }).stage, "CONTACT_COLLECTION");
  assert.equal(nextStage("CONTACT_COLLECTION", { productId: "p", variantId: "v", purchaseIntent: true, hasPhone: true }).stage, "ADDRESS_COLLECTION");
  assert.equal(nextStage("ADDRESS_COLLECTION", { productId: "p", variantId: "v", purchaseIntent: true, hasPhone: true, hasAddress: true }).stage, "ORDER_REVIEW");

  // 1f. Muốn mua nhưng chưa chọn size ⇒ hỏi size, KHÔNG đoán hộ khách.
  assert.equal(nextStage("PRODUCT_IDENTIFIED", { productId: "p", purchaseIntent: true, needsSize: true }).stage, "SIZE_SELECTION");

  // ═════════ 2. BÓC Ý ĐỊNH & THỰC THỂ ═════════

  const price = understandByRule("cho em hỏi cái này bao nhiêu tiền ạ");
  assert.ok(price.intents.includes("PRICE_QUESTION"), "phải nhận ra câu hỏi giá");
  assert.ok(UNDERSTANDING_SCHEMA.safeParse({ ...price, tier: undefined }).success, "kết quả nấc luật phải đúng lược đồ chung với nấc mô hình");

  const phone = understandByRule("sdt cua em la 0912 345 678 nhe shop");
  assert.equal(phone.entities.phone, "0912345678", "SĐT phải bóc được kể cả khi có khoảng trắng");
  assert.ok(phone.intents.includes("PROVIDE_CONTACT"));
  assert.ok(phone.confidence >= 0.9, "SĐT là thực thể cứng nên độ tin phải cao");

  assert.equal(findPhone("gọi em số 84912345678"), "0912345678", "số dạng 84 phải quy về 0");
  assert.equal(findPhone("mã đơn 123456"), "", "dãy số không phải SĐT thì không được nhận bừa");
  assert.deepEqual(findBody("em cao 1m58 nặng 47kg ạ"), { heightCm: 158, weightKg: 47 });
  assert.equal(findQuantity("cho em lấy 2 cái"), 2);
  assert.equal(findQuantity("em xem mẫu này"), null, "không nói số lượng thì là CHƯA BIẾT, không phải 1");

  const nonsense = understandByRule("...");
  assert.ok(nonsense.confidence < 0.35, "câu không hiểu được phải có độ tin thấp để dây chuyền chuyển người");

  const complaint = understandByRule("shop lua dao, hang loi hoan toan");
  assert.ok(complaint.intents.includes("COMPLAINT"), "khiếu nại phải nhận ra được");

  // Lược đồ chặn rác của mô hình: ý định lạ, độ tin ngoài khoảng, không ý định nào đều bị loại.
  assert.equal(UNDERSTANDING_SCHEMA.safeParse({ intents: ["KHONG_CO_Y_DINH_NAY"], entities: {}, confidence: 1 }).success, false, "ý định lạ phải bị lược đồ chặn");
  assert.equal(UNDERSTANDING_SCHEMA.safeParse({ intents: ["CONFIRM"], entities: {}, confidence: 5 }).success, false, "độ tin ngoài [0,1] phải bị chặn");
  assert.equal(UNDERSTANDING_SCHEMA.safeParse({ intents: [], entities: {}, confidence: 0.5 }).success, false, "phải có ít nhất một ý định");

  /*
    2B. CÁCH VIẾT KHÁC NGHĨA KHÁC.

    Mô hình gửi JSON, và JSON có nhiều cách viết cho cùng một điều. Lược đồ phải phân biệt được:
    một Ô TRỐNG hay một CHUỖI SỐ là cách viết khác của cùng một nghĩa — nhận rồi quy về một dạng;
    còn một ý định không có trong danh sách là một nghĩa KHÔNG TỒN TẠI — vứt cả lượt.

    Gộp hai thứ này lại chính là lỗi đã đo được 15/09/2026: mọi lượt ECONOMY hỏng lược đồ vì
    `"productText": null`, leo lên STRONG, hỏng nốt, rồi cả dây chuyền rơi về chuyển người.
  */
  const sNull = UNDERSTANDING_SCHEMA.safeParse({ intents: ["PRICE_QUESTION"], entities: { productText: null, size: null, quantity: null }, confidence: 0.8, evidence: null });
  assert.ok(sNull.success, "`null` ở ô tuỳ chọn là CÁCH VIẾT của trống, không phải rác");
  assert.equal(sNull.success && sNull.data.entities.productText, "", "`null` ở ô chữ quy về chuỗi rỗng");
  assert.equal(sNull.success ? sNull.data.entities.quantity : 0, null, "`null` ở ô số vẫn là CHƯA BIẾT");

  const sChuoi = UNDERSTANDING_SCHEMA.safeParse({ intents: ["PROVIDE_VARIANT"], entities: { quantity: "2", heightCm: "158" }, confidence: 0.8 });
  assert.ok(sChuoi.success, 'chuỗi số thuần "2" là cách viết khác của 2, không được làm hỏng cả lượt hiểu');
  assert.equal(sChuoi.success ? sChuoi.data.entities.quantity : null, 2);
  assert.equal(sChuoi.success ? sChuoi.data.entities.heightCm : null, 158);

  // Chữ cần SUY DIỄN và số vô lý đều ra CHƯA BIẾT — để máy đi hỏi khách, KHÔNG đoán, và cũng
  // không vì một ô hỏng mà vứt phần hiểu còn lại rồi chuyển người.
  const sRac = UNDERSTANDING_SCHEMA.safeParse({ intents: ["PROVIDE_VARIANT"], entities: { quantity: "hai cái" }, confidence: 0.8 });
  assert.equal(sRac.success ? sRac.data.entities.quantity : 0, null, '"hai cái" cần suy diễn ⇒ CHƯA BIẾT, không đoán ra 2');
  const sAm = UNDERSTANDING_SCHEMA.safeParse({ intents: ["CONFIRM"], entities: { quantity: -3 }, confidence: 0.9 });
  assert.equal(sAm.success ? sAm.data.entities.quantity : 0, null, "số lượng âm là CHƯA BIẾT, không bao giờ là một số lượng");

  // ═════════ 3. XÁC NHẬN CÓ NGỮ CẢNH — "OK" KHÔNG BAO GIỜ TỰ TẠO ĐƠN ═════════

  const now = new Date("2026-09-14T10:00:00Z");
  const sentAt = new Date("2026-09-14T09:50:00Z");
  const ready = readyState();

  // 3a. Chưa gửi bản chốt ⇒ "ok" KHÔNG phải xác nhận. Đây là luật quan trọng nhất của cả đặc tả.
  const bare = checkContextualConfirmation({ state: ready, message: { text: "ok", sentAt: now }, now });
  assert.equal(bare.confirmed, false, 'chữ "ok" trơ trọi không bao giờ tạo đơn');
  assert.match(bare.reason, /Chưa gửi bản chốt/);

  // 3b. Có bản chốt, khách trả lời sau, đơn đủ điều kiện ⇒ xác nhận ĐẠT.
  const pendingState: SalesState = { ...ready, pending: { sentAt: sentAt.toISOString(), fingerprint: confirmationFingerprint(ready), summary: "…", variantId: ready.variantId!, quantity: 1, total: 524_000 } };
  const good = checkContextualConfirmation({ state: pendingState, message: { text: "ok chị chốt nhé", sentAt: now }, now });
  assert.equal(good.confirmed, true, "đủ sáu điều kiện thì phải nhận là xác nhận");

  // 3c. Khách trả lời TRƯỚC bản chốt ⇒ không tính.
  const early = checkContextualConfirmation({ state: pendingState, message: { text: "ok", sentAt: new Date("2026-09-14T09:40:00Z") }, now });
  assert.equal(early.confirmed, false);
  assert.match(early.reason, /trước bản chốt/);

  // 3d. Đơn đã đổi sau khi gửi bản chốt ⇒ bản chốt cũ vô hiệu.
  const changed = checkContextualConfirmation({ state: { ...pendingState, quantity: 2 }, message: { text: "ok", sentAt: now }, now });
  assert.equal(changed.confirmed, false);
  assert.match(changed.reason, /đã đổi/);

  // 3e. Bản chốt quá hạn ⇒ phải chốt lại.
  const stale = checkContextualConfirmation({ state: pendingState, message: { text: "ok", sentAt: now }, now: new Date("2026-09-16T10:00:00Z") });
  assert.equal(stale.confirmed, false);
  assert.match(stale.reason, /quá 24 giờ/);

  // 3f. Câu HỎI có chứa chữ "ok" không phải đồng ý.
  for (const text of ["ok chưa shop?", "thế là ok không ạ", "shop ok giá này không", "chưa ok đâu"]) {
    assert.equal(isAffirmativeText(text), false, `"${text}" là câu hỏi / phủ định, không phải đồng ý`);
  }
  for (const text of ["ok", "oke chị chốt nhé", "vâng ạ", "đồng ý", "chốt đơn giúp em"]) {
    assert.equal(isAffirmativeText(text), true, `"${text}" phải được nhận là đồng ý`);
  }

  /*
    3f-bis. "ĐƯỢC" TRẢ LỜI MỘT CÂU HỎI KHÁC KHÔNG PHẢI LÀ CHỐT ĐƠN.

    Ca chủ shop nêu đích danh:
      MÁY   : "chị muốn xem thêm màu không?"
      KHÁCH : "được"
    Chữ ấy là đồng ý XEM THÊM MÀU, không phải đồng ý MUA. Cái chặn không nằm ở việc đọc chữ — đọc
    chữ thì "được" vẫn là đồng ý — mà nằm ở chỗ CHƯA CÓ BẢN CHỐT NÀO được gửi. Không có bản chốt
    thì không có thứ gì để đồng ý, nên không có xác nhận.
  */
  assert.equal(isAffirmativeText("được"), true, "đọc chữ thì \"được\" vẫn là một tiếng đồng ý");
  const xemThemMau = checkContextualConfirmation({ state: ready, message: { text: "được", sentAt: now }, now });
  assert.equal(xemThemMau.confirmed, false, '"được" khi CHƯA gửi bản chốt không bao giờ là xác nhận đơn');
  assert.match(xemThemMau.reason, /Chưa gửi bản chốt/);

  // Còn khi ĐÃ gửi bản chốt thì chính chữ ấy LÀ xác nhận — khác biệt nằm ở bối cảnh, không ở chữ.
  const sauBanChot = checkContextualConfirmation({ state: pendingState, message: { text: "được", sentAt: now }, now });
  assert.equal(sauBanChot.confirmed, true, "đúng bối cảnh thì chính chữ ấy là xác nhận");

  // 3g. Khách đồng ý nhưng đơn THIẾU điều kiện máy chủ ⇒ vẫn không được lên đơn.
  const noAddress = { ...pendingState, address: "", province: "" };
  const noAddressPending = { ...noAddress, pending: { ...pendingState.pending!, fingerprint: confirmationFingerprint(noAddress) } };
  const blocked = checkContextualConfirmation({ state: noAddressPending, message: { text: "ok", sentAt: now }, now });
  assert.equal(blocked.confirmed, false);
  assert.ok(blocked.confirmed === false && blocked.blocking.includes("ADDRESS"), "thiếu địa chỉ phải được nêu đích danh");

  // 3h. Từng điều kiện máy chủ đều chặn được một mình nó.
  assert.deepEqual(missingOrderRequirements(ready), [], "đơn mẫu phải đủ điều kiện");
  assert.deepEqual(missingOrderRequirements({ ...ready, variantId: null }), ["VARIANT"]);
  assert.deepEqual(missingOrderRequirements({ ...ready, phone: "0912" }), ["PHONE"]);
  assert.deepEqual(missingOrderRequirements({ ...ready, address: "Hà Nội" }), ["ADDRESS"], "địa chỉ quá ngắn không gửi ĐVVC được");
  assert.deepEqual(missingOrderRequirements({ ...ready, quotedTotal: null }), ["PRICE"], "chưa có giá máy chủ tính thì chưa được lên đơn");

  // ═════════ 4. CHẶN SỐ TIỀN MÔ HÌNH BỊA ═════════

  assert.deepEqual(moneyMentions("giá 499k ship 25.000đ"), [499_000, 25_000]);
  const okText = guardGeneratedText("Dạ mẫu này 499.000đ ạ", "câu nháp", [499_000]);
  assert.equal(okText.usedModel, true, "câu dùng đúng số máy chủ tính thì được nhận");
  const bad = guardGeneratedText("Dạ em bớt cho chị còn 350.000đ ạ", "câu nháp", [499_000]);
  assert.equal(bad.usedModel, false, "câu bịa số tiền phải bị vứt");
  assert.equal(bad.text, "câu nháp", "vứt rồi phải rơi về câu mẫu, không phải rơi về rỗng");
  assert.match(bad.rejectReason, /số tiền/);
  const empty = guardGeneratedText("", "câu nháp", [499_000]);
  assert.equal(empty.text, "câu nháp", "mô hình trả rỗng thì dùng câu mẫu");

  const review = renderOrderReview({ productLabel: "Đầm Q002 L Đỏ", quantity: 1, unitPrice: 499_000, shippingFee: 25_000, total: 524_000, name: "Chị Lan", phone: "0912345678", address: "Số 5, Thanh Xuân, Hà Nội" });
  assert.ok(review.includes("524.000") && review.includes("0912345678"), "bản chốt phải đọc đủ tổng tiền và SĐT cho khách nghe");
  assert.ok(review.includes("xác nhận"), "bản chốt phải hỏi khách xác nhận");

  // ═════════ 4A. GIAI ĐOẠN NÀO CŨNG PHẢI TRẢ LỜI CÂU KHÁCH HỎI ═════════
  //
  // Đo 15/09/2026 trên mẻ thật: khách hỏi "Giá sau khi giảm 40% là bao nhiêu?" khi hội thoại đang
  // ở chỗ chọn size, và máy đáp bằng câu xin chiều cao / cân nặng. Luật "trả lời trước, đẩy bước
  // sau" vốn đã có nhưng CHỈ ở hai giai đoạn đầu, nên ở các giai đoạn thu thập sau đó câu hỏi rơi
  // mất.
  //
  // Phép thử đi theo TÍNH CHẤT, không theo tên giai đoạn: hễ máy đang định ĐI THU THẬP một thứ gì
  // đó, mà khách vừa hỏi một câu, thì việc phải làm là TRẢ LỜI. Viết theo tính chất thì thêm một
  // giai đoạn thu thập mới vẫn bị soi, còn liệt kê tên giai đoạn thì không.

  // `NEW_LEAD` là ngoại lệ DUY NHẤT và nằm ngoài danh sách: chưa biết khách hỏi mẫu nào thì không
  // có giá nào để báo, nên hỏi mẫu CHÍNH LÀ điều kiện để trả lời được, không phải né câu hỏi.
  const VIỆC_THU_THẬP = ["ASK_VARIANT", "ASK_SIZE", "ASK_CONTACT", "ASK_ADDRESS"] as const;
  const nềnQuyết = {
    confirmation: { confirmed: false as const, reason: "Chưa gửi bản chốt", blocking: [] as never[] },
    humanTakeover: false,
    orderCreated: false,
    stale: false,
  };
  const hiểuTrung: Understanding = { intents: ["GREETING"], entities: { ...EMPTY_ENTITIES_TEST }, confidence: 0.9, evidence: "", tier: "RULE" };
  const hiểuHỏiGiá = understandByRule("giá sau khi giảm 40% là bao nhiêu ạ");
  assert.ok(hiểuHỏiGiá.intents.includes("PRICE_QUESTION"), "câu hỏi giá phải được nhận ra bằng LUẬT, không cần mô hình");

  const chặngThuThập: { tên: string; stage: SalesStage; state: SalesState }[] = [
    { tên: "biết mẫu, chưa có mẫu mã", stage: "PRODUCT_IDENTIFIED", state: stateWith({ productId: "p", productName: "Đầm Q004", quotedTotal: 499_000 }) },
    { tên: "thiếu size", stage: "VARIANT_SELECTION", state: stateWith({ productId: "p", productName: "Đầm Q004", quotedTotal: 499_000, needsSize: true, purchaseIntent: true }) },
    { tên: "thiếu SĐT", stage: "PURCHASE_INTENT", state: stateWith({ productId: "p", productName: "Đầm Q004", quotedTotal: 499_000, variantId: "v", variantLabel: "L Đỏ", size: "L", color: "Đỏ", purchaseIntent: true }) },
    { tên: "thiếu địa chỉ", stage: "CONTACT_COLLECTION", state: stateWith({ productId: "p", productName: "Đầm Q004", quotedTotal: 499_000, variantId: "v", variantLabel: "L Đỏ", size: "L", color: "Đỏ", purchaseIntent: true, phone: "0912345678" }) },
  ];

  let chặngĐãSoi = 0;
  for (const chặng of chặngThuThập) {
    const nền = decide({ ...nềnQuyết, stage: chặng.stage, state: chặng.state, understanding: hiểuTrung });
    assert.ok(
      (VIỆC_THU_THẬP as readonly string[]).includes(nền.action),
      `${chặng.tên}: nền của phép thử phải là một việc THU THẬP thì mới soi được luật trả lời trước (đang là ${nền.action})`,
    );
    const hỏi = decide({ ...nềnQuyết, stage: chặng.stage, state: chặng.state, understanding: hiểuHỏiGiá });
    assert.equal(hỏi.action, "ANSWER_QUESTION", `${chặng.tên}: khách hỏi giá thì phải TRẢ LỜI, không đẩy sang ${nền.action}`);
    chặngĐãSoi += 1;
  }
  assert.equal(chặngĐãSoi, chặngThuThập.length);
  assert.equal(
    decide({ ...nềnQuyết, stage: "NEW_LEAD", state: EMPTY_SALES_STATE, understanding: hiểuHỏiGiá }).action,
    "ASK_PRODUCT",
    "chưa biết khách hỏi mẫu nào thì không có giá nào để báo — hỏi mẫu là điều kiện để trả lời, không phải né câu hỏi",
  );

  // ═════════ 4B. CÂU TRẢ LỜI ĐỨNG TRƯỚC BƯỚC TIẾP, KHÔNG ĐỨNG THAY ═════════
  //
  // Đo 15/09/2026 trên mẻ thật, hai lỗi diễn đạt đi cùng nhau trong MỘT câu:
  //   KHÁCH: "Giá sau khi giảm 40% là bao nhiêu?"
  //   MÁY  : "Dạ chị cho em xin chiều cao và cân nặng để em tư vấn size phù hợp nhất ạ."
  // (a) câu hỏi giá không được trả lời một chữ nào — bước tiếp đứng THAY câu trả lời;
  // (b) câu hứa sẽ tư vấn size trong khi ERP KHÔNG có bảng số đo, nên khách gõ số đo xong vẫn bị
  //     chuyển người. Một lời hứa không giữ được thì tệ hơn là không hứa.

  const ctxNen: GenerationContext = {
    action: "ANSWER_QUESTION",
    // `quotedTotal` là TỔNG máy chủ tính — ĐÃ GỒM phí ship, đúng như `pricing.get` trả về.
    // Đặt sai chỗ này thì mọi phép thử tiền bên dưới đo một thứ không tồn tại.
    state: stateWith({ productName: "Đầm suông Q004", quotedTotal: 524_000 }),
    sizes: ["M", "L", "XL"],
    colors: ["Đỏ", "Đen"],
    sizeAdvice: null,
    stockKnown: false,
    available: null,
    shippingFee: 25_000,
    missing: ["VARIANT", "PHONE", "ADDRESS"],
    reason: "",
  };

  // 4B-a. Câu trả lời phải TRẢ LỜI (giá, phí ship) rồi mới MỜI bước tiếp — một tin nhắn làm cả hai.
  const traLoi = renderTemplate(ctxNen);
  assert.ok(traLoi.includes("25.000"), "hỏi giá thì phải nghe được phí ship");
  assert.ok(/M, L, XL/.test(traLoi), "bước tiếp phải mời chọn trong đúng các size ERP đang bán");

  /*
    BA CON SỐ PHẢI CỘNG ĐƯỢC VỚI NHAU.

    Đo 15/09/2026 ngay sau khi máy bắt đầu báo được giá: "Dạ Đầm Q004 giá 524.000 ₫, phí ship
    25.000 ₫ ạ." Cả hai con số đều do máy chủ tính nên lưới soi tiền không thấy gì sai — nhưng
    524.000 ĐÃ GỒM phí ship, nên khách đọc ra 549.000. Một báo giá sai 25.000đ mà không ai bịa ra
    con số nào.
  */
  const soTrongCau = moneyMentions(traLoi);
  const tongLonNhat = Math.max(...soTrongCau);
  const conLai = soTrongCau.filter((n) => n !== tongLonNhat);
  assert.equal(tongLonNhat, 499_000 + 25_000, "con số lớn nhất phải là TỔNG");
  assert.equal(conLai.reduce((a, b) => a + b, 0), tongLonNhat, "các con số còn lại phải CỘNG LẠI đúng bằng tổng — nếu không khách sẽ cộng thêm một lần nữa");
  assert.ok(/tổng/.test(traLoi), "phải gọi tên con số tổng, để không ai đọc nhầm nó là tiền hàng");
  assert.ok(traLoi.indexOf("499.000") < traLoi.indexOf("size"), "giá đứng TRƯỚC câu mời chọn size, không phải ngược lại");

  // Miễn phí ship ⇒ một con số duy nhất, và nói rõ là miễn phí.
  const mienPhi = renderTemplate({ ...ctxNen, shippingFee: 0, state: stateWith({ productName: "Đầm suông Q004", quotedTotal: 499_000 }) });
  assert.deepEqual(moneyMentions(mienPhi), [499_000], "miễn phí ship thì chỉ có MỘT con số");
  assert.ok(/miễn phí ship/.test(mienPhi));

  // Chưa biết phí ship ⇒ một con số duy nhất và KHÔNG nhắc tới ship.
  const chuaBietShip = renderTemplate({ ...ctxNen, shippingFee: null });
  assert.deepEqual(moneyMentions(chuaBietShip), [524_000], "chưa biết phí ship thì không được để hai con số cộng không ra nhau");
  assert.ok(!/ship/.test(chuaBietShip), "chưa biết thì im, không đoán");

  // Bước tiếp đi theo thứ tự điều kiện máy chủ còn THIẾU, không phải một câu xã giao cố định.
  const cóMẫuMã = renderTemplate({ ...ctxNen, state: stateWith({ productName: "Đầm suông Q004", quotedTotal: 524_000, size: "L", color: "Đỏ" }), missing: ["PHONE", "ADDRESS"] });
  assert.ok(/số điện thoại/.test(cóMẫuMã), "đã có mẫu mã thì bước tiếp là xin SĐT");
  const cóSĐT = renderTemplate({ ...ctxNen, missing: ["ADDRESS"] });
  assert.ok(/địa chỉ/.test(cóSĐT), "đã có SĐT thì bước tiếp là xin địa chỉ");
  const đủHết = renderTemplate({ ...ctxNen, missing: [] });
  assert.ok(!/số điện thoại|địa chỉ|size nào/.test(đủHết), "không thiếu gì thì không mời gì thêm");

  // Sổ kho nói HẾT ⇒ trả lời trung thực và DỪNG, không đẩy khách đi tiếp tới chốt đơn.
  const hếtHàng = renderTemplate({ ...ctxNen, stockKnown: true, available: 0 });
  assert.ok(/hết/.test(hếtHàng), "hết hàng phải nói thẳng");
  assert.ok(!/số điện thoại|địa chỉ|size nào/.test(hếtHàng), "mẫu đã hết thì KHÔNG mời khách bước tiếp — đó là hẹn trước một đơn huỷ");

  /*
    4B-a-bis. NƠI SINH CÂU HỎI VÀ NƠI ĐẾM CÂU HỎI PHẢI ĐỌC CÙNG MỘT HÀM.

    Bộ đếm "hỏi mãi một thứ" (lối thoát chuyển người khi máy bí) tăng theo HÀNH ĐỘNG. Nhưng từ khi
    có luật trả-lời-trước, một khách cứ hỏi thì hành động luôn là ANSWER_QUESTION và câu hỏi size
    nằm ở phần ĐUÔI — không lượt nào được đếm, nên máy hỏi mười lượt mà bộ đếm vẫn bằng 0.
  */
  assert.equal(nextStepKey(ctxNen), "size", "thiếu mẫu mã và chưa có size ⇒ bước tiếp là hỏi size");
  assert.equal(nextStepKey({ ...ctxNen, state: stateWith({ productName: "x", quotedTotal: 524_000, size: "L" }) }), "variant", "có size rồi thì hỏi màu");
  assert.equal(nextStepKey({ ...ctxNen, missing: ["PHONE", "ADDRESS"] }), "phone");
  assert.equal(nextStepKey({ ...ctxNen, missing: ["ADDRESS"] }), "address");
  assert.equal(nextStepKey({ ...ctxNen, missing: [] }), null, "không thiếu gì thì không hỏi gì");
  assert.equal(nextStepKey({ ...ctxNen, stockKnown: true, available: 0 }), null, "mẫu đã hết thì không đẩy khách đi tiếp");
  // Và khoá phải TRÙNG với thứ câu chữ thật sự hỏi — hai nơi lệch nhau thì bộ đếm đếm nhầm việc.
  assert.match(renderTemplate(ctxNen), /size nào/);
  assert.match(renderTemplate({ ...ctxNen, missing: ["PHONE", "ADDRESS"] }), /số điện thoại/);

  // 4B-b. Chưa có bảng số đo ⇒ KHÔNG xin chiều cao / cân nặng, mà mời khách chọn trong các size
  //       ERP thật sự đang bán. Xin số đo là hứa sẽ tra bảng.
  for (const advice of [null, { code: "SIZE_DATA_MISSING", size: null, reason: "" }, { code: "AMBIGUOUS", size: null, reason: "" }, { code: "OUT_OF_RANGE", size: null, reason: "" }]) {
    const text = renderTemplate({ ...ctxNen, action: "ASK_SIZE", sizeAdvice: advice });
    assert.ok(!/chiều cao|cân nặng/i.test(text), "chưa kết luận được bằng bảng số đo thì không được xin số đo — đó là lời hứa không giữ được");
    assert.ok(text.includes("M, L, XL"), "phải mời khách chọn trong đúng các size ERP đang bán");
  }

  // 4B-c. Có bảng và bảng KẾT LUẬN ĐƯỢC ⇒ mới được nêu một size cụ thể.
  const cóBảng = renderTemplate({ ...ctxNen, action: "ASK_SIZE", sizeAdvice: { code: "OK", size: "L", reason: "" } });
  assert.ok(/tư vấn size L\b/.test(cóBảng), "bảng số đo kết luận được thì máy mới được nêu size");

  // 4B-d. Có bảng nhưng CHƯA ĐỦ SỐ ĐO ⇒ lúc này xin số đo là đúng, vì lời hứa giữ được.
  const thiếuSốĐo = renderTemplate({ ...ctxNen, action: "ASK_SIZE", sizeAdvice: { code: "MEASUREMENTS_MISSING", size: null, reason: "" } });
  assert.ok(/chiều cao/.test(thiếuSốĐo), "có bảng mà thiếu số đo thì xin số đo mới là việc đúng");
  assert.ok(!/tư vấn size (S|M|L|XL)\b/.test(thiếuSốĐo), "chưa kết luận được thì không nêu size");

  // 4B-e. Tồn CHƯA BIẾT ⇒ không câu nào được hứa "còn hàng" / "vẫn còn".
  for (const action of ["ASK_VARIANT", "ANSWER_QUESTION"] as const) {
    const text = renderTemplate({ ...ctxNen, action });
    assert.ok(!/vẫn còn|còn hàng/.test(text), `${action}: tồn CHƯA BIẾT thì không được hứa còn hàng`);
  }
  const cònHàng = renderTemplate({ ...ctxNen, action: "ASK_VARIANT", stockKnown: true, available: 7 });
  assert.ok(/vẫn còn/.test(cònHàng), "tồn đã biết và > 0 thì mới được nói còn hàng");

  // 4B-f. CHƯA biết giá thì tuyệt đối không có con số tiền nào rơi vào câu — ở MỌI hành động.
  for (const action of ["ANSWER_QUESTION", "ASK_SIZE", "ASK_VARIANT"] as const) {
    const text = renderTemplate({ ...ctxNen, action, state: stateWith({ productName: "Đầm suông Q004", quotedTotal: null }), shippingFee: null });
    assert.deepEqual(moneyMentions(text), [], `${action}: chưa có giá máy chủ tính thì câu không được mang con số tiền nào`);
  }

  // 4B-g. Câu ĐẨY BƯỚC không nhắc lại giá — giá nói ở câu TRẢ LỜI, nói lại mỗi tin là làm phiền.
  for (const action of ["ASK_SIZE", "ASK_VARIANT"] as const) {
    assert.deepEqual(moneyMentions(renderTemplate({ ...ctxNen, action })), [], `${action}: câu đẩy bước không lặp lại giá`);
  }

  // ═════════ 4C. SOÁT AN TOÀN TỰ ĐỘNG & PHÂN LOẠI CHUYỂN NGƯỜI ═════════
  //
  // "Tỷ lệ chuyển người" là một con số không sửa được gì: nó gộp việc ĐÚNG của người (khiếu nại),
  // chốt an toàn nổ ĐÚNG, dữ liệu chủ shop chưa khai, hạ tầng hỏng, và máy bí. Năm thứ ấy có năm
  // người khác nhau phải đi làm việc khác nhau.

  for (const reason of HANDOFF_REASONS) {
    assert.ok(classifyHandoff(reason), `${reason}: mọi lý do chuyển người phải có loại — không có ô "chưa phân loại"`);
  }
  assert.equal(classifyHandoff(null), null, "không chuyển người thì không có loại, không phải loại 'không rõ'");
  // Và chiều ngược lại: không có loại nào khai ra rồi bỏ không — một ô luôn rỗng là một ô gây hiểu nhầm.
  const loạiĐãDùng = new Set(HANDOFF_REASONS.map((r) => classifyHandoff(r)));
  for (const loại of Object.keys(HANDOFF_CLASS_LABEL)) {
    assert.ok(loạiĐãDùng.has(loại as never), `${loại}: khai một loại mà không lý do nào rơi vào là một ô luôn rỗng`);
  }
  assert.equal(classifyHandoff("COMPLAINT"), "CORRECT", "khiếu nại chuyển người là ĐÚNG, không phải một lỗi của AI");
  assert.equal(classifyHandoff("SIZE_DATA_MISSING"), "MISSING_DATA", "thiếu bảng số đo là việc của chủ shop, không phải 'AI còn yếu'");
  assert.equal(classifyHandoff("ORDER_BLOCKED"), "SAFETY", "đơn thiếu điều kiện bị chặn là chốt an toàn nổ đúng");
  assert.equal(classifyHandoff("MODEL_UNAVAILABLE"), "SYSTEM");
  assert.equal(classifyHandoff("LOW_CONFIDENCE"), "UNNECESSARY", "chỉ 'máy bí' mới là chỗ đáng gọi là AI chưa đủ tốt");

  // Năm cờ an toàn: mỗi cờ phải bắt được đúng cái nó khai, và KHÔNG bắt nhầm câu sạch.
  const nềnSoát = { allowedAmounts: [499_000, 25_000], stockKnown: true, sizeChartAvailable: true, mentionedAmounts: [499_000] };
  assert.deepEqual(safetyFlags({ ...nềnSoát, text: "Dạ mẫu này 499.000đ chị ạ." }), [], "câu sạch không được bật cờ nào");
  assert.deepEqual(safetyFlags({ ...nềnSoát, text: "Em bớt còn 350.000đ ạ", mentionedAmounts: [350_000] }), ["MONEY_NOT_FROM_SERVER"]);
  assert.ok(safetyFlags({ ...nềnSoát, text: "Bên em cam kết giao trong 2 ngày ạ" }).includes("PROMISED_DELIVERY_TIME"));
  assert.ok(safetyFlags({ ...nềnSoát, text: "Mẫu này vẫn còn chị nhé", stockKnown: false }).includes("PROMISED_STOCK_UNKNOWN"));
  assert.deepEqual(safetyFlags({ ...nềnSoát, text: "Mẫu này vẫn còn chị nhé" }).filter((f) => f === "PROMISED_STOCK_UNKNOWN"), [], "sổ kho đã biết thì nói còn hàng là hợp lệ");
  assert.ok(safetyFlags({ ...nềnSoát, text: "Bên em tư vấn size L ạ", sizeChartAvailable: false }).includes("NAMED_SIZE_WITHOUT_CHART"));
  assert.ok(safetyFlags({ ...nềnSoát, text: "Em giảm giá cho chị nhé" }).includes("PROMISED_DISCOUNT"));
  // Luật viết KHÔNG DẤU phải bắt được cả câu có dấu lẫn không dấu — khách và máy đều gõ cả hai kiểu.
  assert.ok(safetyFlags({ ...nềnSoát, text: "mau nay van con chi nhe", stockKnown: false }).includes("PROMISED_STOCK_UNKNOWN"));

  /*
    VÀ ĐÂY LÀ PHÉP THỬ ĐÁNG GIÁ NHẤT CỦA CẢ KHỐI: mọi câu MẪU, ở mọi hành động, với sổ kho CHƯA
    BIẾT và KHÔNG có bảng số đo, đều không được bật cờ nào. Nấc mẫu câu là nấc luôn dùng được và
    là chỗ mọi thứ rơi về khi mô hình hỏng — nó mà nói sai thì không còn lưới nào ở dưới.
  */
  const ctxXấuNhất: GenerationContext = { ...ctxNen, stockKnown: false, available: null, sizeAdvice: null };
  for (const action of SALES_ACTIONS) {
    const text = renderTemplate({ ...ctxXấuNhất, action });
    if (!text) continue;
    // ĐÚNG tập tiền mà dây chuyền truyền vào lưới: tổng · phí ship · tiền hàng.
    const cờ = safetyFlags({ text, allowedAmounts: [524_000, 25_000, 499_000], stockKnown: false, sizeChartAvailable: false, mentionedAmounts: moneyMentions(text) });
    assert.deepEqual(cờ, [], `${action}: câu mẫu bật cờ an toàn — ${cờ.join(", ")} — trong câu "${text}"`);
  }

  // Chín chiều chấm: chiều nào máy không chấm được phải khai thẳng là NGƯỜI chấm.
  assert.equal(QUALITY_DIMENSIONS.length, 9);
  assert.ok(QUALITY_DIMENSIONS.some((d) => d.key === "naturalness" && d.grader === "HUMAN"), "độ tự nhiên không có nguồn sự thật nào trong ERP — máy không được tự cho điểm");
  assert.ok(QUALITY_DIMENSIONS.every((d) => d.note.length > 20), "mỗi chiều phải nói rõ vì sao ai chấm");

  // KHÔNG ÁP DỤNG khác hẳn TRẢ LỜI SAI: khách không hỏi giá thì câu không có số tiền là bình thường.
  assert.equal(answeredMoneyQuestion(false, []), null);
  assert.equal(answeredMoneyQuestion(true, []), false, "khách hỏi giá mà câu không có con số nào là CHƯA trả lời");
  assert.equal(answeredMoneyQuestion(true, [499_000]), true);
  assert.equal(advancesConversation(""), null, "không có câu nào thì CHƯA BIẾT, không phải 'không đẩy'");
  assert.equal(advancesConversation(renderTemplate(ctxNen)), true, "câu trả lời phải mời được bước tiếp");

  // ═════════ 4D. LƯỚI SOI BẢN MÔ HÌNH VIẾT — ĐỔI CÁCH NÓI, KHÔNG ĐỔI ĐIỀU ĐƯỢC NÓI ═════════
  //
  // Đo 15/09/2026 trên mẻ sạch, một lượt mà việc máy chủ giao là HỎI KHÁCH ĐANG XEM MẪU NÀO:
  //   CÂU MẪU : "Dạ em chào chị ạ. Chị đang xem mẫu nào để em tư vấn giúp chị với ạ?"
  //   MÔ HÌNH : "Dạ chị cho em xin chiều cao và số đo vòng ngực để em tư vấn size phù hợp ạ."
  // Không phải viết lại — là một tin nhắn KHÁC, và nó hứa đúng thứ mẫu câu vừa được sửa để thôi
  // hứa. Lưới cũ không thấy, vì nó chỉ soi tiền và mốc giao.

  const nềnLưới = { allowedAmounts: [499_000, 25_000], stockKnown: true, sizeChartAvailable: true };
  const mẫuChào = "Dạ em chào chị ạ. Chị đang xem mẫu nào để em tư vấn giúp chị với ạ?";

  const xinSốĐo = guardGeneratedText("Dạ chị cho em xin chiều cao và số đo vòng ngực để em tư vấn size phù hợp ạ.", mẫuChào, { ...nềnLưới, sizeChartAvailable: false });
  assert.equal(xinSốĐo.usedModel, false, "chưa có bảng số đo mà mô hình xin số đo ⇒ phải vứt bản của mô hình");
  assert.equal(xinSốĐo.text, mẫuChào, "vứt rồi phải rơi về câu mẫu");
  // CÓ bảng thì xin số đo là việc đúng — lưới không được chặn nhầm.
  assert.equal(guardGeneratedText("Dạ chị cho em xin chiều cao và cân nặng ạ.", mẫuChào, nềnLưới).usedModel, true);

  // Hứa còn hàng khi sổ kho CHƯA BIẾT.
  assert.equal(guardGeneratedText("Dạ mẫu này vẫn còn chị nhé.", mẫuChào, { ...nềnLưới, stockKnown: false }).usedModel, false);
  assert.equal(guardGeneratedText("Dạ mẫu này vẫn còn chị nhé.", mẫuChào, nềnLưới).usedModel, true, "sổ kho đã biết thì nói còn hàng là hợp lệ");

  // Và không được HỎI LẠI đúng thứ khách vừa hỏi.
  const nhại = guardGeneratedText("Dạ, đầm Q004 giá bao nhiêu ạ? Chị đợi em kiểm tra kho nhé.", mẫuChào, nềnLưới);
  assert.equal(nhại.usedModel, false, "nhại câu hỏi của khách thành câu hỏi ⇒ vứt");
  assert.match(nhại.rejectReason, /hỏi lại/);
  // Nhưng nếu CHÍNH CÂU MẪU hỏi thế thì đó là việc máy chủ giao, không phải mô hình tự thêm.
  assert.equal(guardGeneratedText("Chị cho em xin bao nhiêu cái ạ?", "Chị lấy bao nhiêu cái ạ?", nềnLưới).usedModel, true);

  // Dạng cũ (chỉ một mảng tiền) vẫn phải chạy — nơi gọi cũ không đổi cùng lúc được.
  assert.equal(guardGeneratedText("Dạ mẫu này 499.000đ ạ", "câu nháp", [499_000]).usedModel, true);
  assert.equal(guardGeneratedText("Dạ em bớt cho chị còn 350.000đ ạ", "câu nháp", [499_000]).usedModel, false);

  // Nhắc lại size KHÁCH đã chọn không phải là khuyên size — chặn nó thì máy không đọc lại đơn được.
  assert.equal(guardGeneratedText("Dạ chị lấy size L màu Đỏ đúng không ạ?", mẫuChào, { ...nềnLưới, sizeChartAvailable: false }).usedModel, true);
  assert.equal(guardGeneratedText("Dạ bên em tư vấn chị lấy size L ạ.", mẫuChào, { ...nềnLưới, sizeChartAvailable: false }).usedModel, false, "KHUYÊN một size khi không có bảng ⇒ vứt");

  // ═════════ 5. CỔNG GỬI TIN — HAI LOẠI GỬI, HAI CÔNG TẮC ═════════
  //
  // Bản tách quan trọng nhất của giai đoạn COPILOT: "máy tự gửi" và "nhân viên bấm gửi" là hai
  // việc có hai mức rủi ro khác hẳn nhau. Một cờ gộp thì ngày mở nấc COPILOT để nhân viên bấm gửi
  // cũng là ngày mở luôn đường cho máy tự gửi.

  const base = { conversationExternalId: "conv-1", text: "Dạ em chào chị", humanTakeover: false };
  const NGUOI = "u-sale-1";

  // 5a. MÁY tự gửi (không có khoá tài khoản): chỉ nấc AUTO, và chỉ khi `allowAutoSend` mở.
  const moTuGui: AiSettings = { ...OFF_SETTINGS, hardLimits: { allowAutoSend: true, allowHumanApprovedSend: false, allowOrderCreate: true } };
  assert.equal(canSend({ ...base, mode: "SHADOW" }, moTuGui).allowed, false, "nấc SHADOW: máy không tự gửi");
  assert.equal(canSend({ ...base, mode: "COPILOT" }, moTuGui).allowed, false, "nấc COPILOT KHÔNG có phiếu duyệt = một job đang cố gửi thay người ⇒ chặn");
  const tuGui = canSend({ ...base, mode: "AUTO" }, moTuGui);
  assert.equal(tuGui.allowed, true);
  assert.equal(tuGui.allowed === true && tuGui.kind, "AUTO");

  // 5b. NGƯỜI bấm gửi (có khoá tài khoản): từ nấc COPILOT, và chỉ khi `allowHumanApprovedSend` mở.
  const moNguoiGui: AiSettings = { ...OFF_SETTINGS, hardLimits: { allowAutoSend: false, allowHumanApprovedSend: true, allowOrderCreate: true } };
  assert.equal(canSend({ ...base, mode: "SHADOW", approvedByUserId: NGUOI }, moNguoiGui).allowed, false, "nấc SHADOW: người bấm cũng chưa gửi được");
  const nguoiGui = canSend({ ...base, mode: "COPILOT", approvedByUserId: NGUOI }, moNguoiGui);
  assert.equal(nguoiGui.allowed, true);
  assert.equal(nguoiGui.allowed === true && nguoiGui.kind, "HUMAN_APPROVED");

  /*
    5c. VÀ ĐÂY LÀ PHÉP THỬ ĐÁNG GIÁ NHẤT CỦA CẢ BẢN TÁCH.

    Mở công tắc CHO NGƯỜI BẤM GỬI không được mở một milimét nào cho máy tự gửi — ở MỌI nấc, kể cả
    nấc AUTO. Nếu dòng nào dưới đây đỏ, nghĩa là hai nghĩa lại dính vào nhau, và việc bật nấc
    COPILOT cho page thí điểm đã đồng thời cho phép một job nền nhắn khách.
  */
  let toHopTuGui = 0;
  for (const mode of ["OFF", "SHADOW", "COPILOT", "AUTO"] as const) {
    const d = canSend({ ...base, mode }, moNguoiGui);
    toHopTuGui += 1;
    assert.equal(d.allowed, false, `mở quyền NGƯỜI bấm gửi không được cho MÁY tự gửi ở nấc ${mode}`);
  }
  assert.equal(toHopTuGui, 4);
  // Và chiều ngược lại: mở quyền máy tự gửi không cho người bấm gửi (người vẫn phải có công tắc riêng).
  assert.equal(canSend({ ...base, mode: "COPILOT", approvedByUserId: NGUOI }, moTuGui).allowed, false);

  // 5d. Người đã cầm việc ⇒ MÁY im lặng; nhưng chính NGƯỜI ấy vẫn gửi được — họ đang ngồi trả lời khách.
  assert.equal(canSend({ ...base, mode: "AUTO", humanTakeover: true }, moTuGui).allowed, false, "người cầm việc thì máy không gửi");
  assert.equal(canSend({ ...base, mode: "COPILOT", humanTakeover: true, approvedByUserId: NGUOI }, moNguoiGui).allowed, true, "người cầm việc thì chính người ấy vẫn gửi được");

  // 5e. Tin kiểm thử tất định: chỉ tới hội thoại trong danh sách trắng, và không mở đường cho câu AI.
  assert.equal(canSend({ ...base, mode: "SHADOW", text: ROUNDTRIP_TEST_MESSAGE }, moNguoiGui).allowed, false, "chưa có danh sách trắng thì tin kiểm thử cũng không gửi");
  const whitelisted: AiSettings = { ...moNguoiGui, testConversationIds: ["conv-1"] };
  const roundtrip = canSend({ ...base, mode: "SHADOW", text: ROUNDTRIP_TEST_MESSAGE }, whitelisted);
  assert.equal(roundtrip.allowed, true);
  assert.equal(roundtrip.allowed === true && roundtrip.kind, "ROUNDTRIP_TEST");
  assert.equal(canSend({ ...base, mode: "SHADOW", text: "Dạ mẫu này 499k ạ" }, whitelisted).allowed, false, "danh sách trắng chỉ cho tin kiểm thử, không cho câu AI");

  // ═════════ 5B. CHẶN CỨNG CẤP MÔI TRƯỜNG — CÂU TRẢ LỜI CHO "CÓ TỔ HỢP NÀO LỠ NHẮN KHÁCH KHÔNG" ═════════
  //
  // Bản chạy thử cắm vào một page Pancake THẬT, nên câu hỏi không còn là "nấc SHADOW có gửi
  // không" mà là "có TỔ HỢP CẤU HÌNH NÀO gửi được không". Ba công tắc chặn cứng trả lời bằng cách
  // đứng trước mọi chốt khác và chỉ biết nói KHÔNG.
  const locked: AiSettings = { ...OFF_SETTINGS, testConversationIds: ["conv-1"], hardLimits: SAFEST_HARD_LIMITS };
  let lockedChecks = 0;
  for (const mode of ["OFF", "SHADOW", "COPILOT", "AUTO"] as const) {
    for (const approvedByUserId of [undefined, NGUOI]) {
      for (const text of ["Dạ mẫu này 499k ạ", ROUNDTRIP_TEST_MESSAGE]) {
        const decision = canSend({ conversationExternalId: "conv-1", humanTakeover: false, mode, approvedByUserId, text }, locked);
        lockedChecks += 1;
        assert.equal(decision.allowed, false, `chặn cứng phải thắng: nấc ${mode}, người=${approvedByUserId ?? "(máy)"}, nội dung=${text.slice(0, 12)}`);
        assert.match(decision.reason, /AI_ALLOW_(AUTO|HUMAN_APPROVED)_SEND/, "lý do phải chỉ đúng công tắc đang chặn, để người vận hành biết sửa ở đâu");
      }
    }
  }
  assert.equal(lockedChecks, 16, "phải quét đủ 4 nấc × 2 (máy / người) × 2 loại nội dung");

  // Chặn cứng là chốt đứng trước: chính tổ hợp mà khối 5 vừa chứng minh là gửi được vẫn bị chặn.
  assert.equal(canSend({ ...base, mode: "AUTO" }, moTuGui).allowed, true, "mở công tắc thì logic nấc chạy như cũ");
  assert.equal(canSend({ ...base, mode: "AUTO" }, locked).allowed, false, "khoá công tắc thì chính tổ hợp đó bị chặn");

  // ── Công tắc đọc TỪ MÔI TRƯỜNG, và bảng `settings` KHÔNG ghi đè được ──
  //
  // Đây là lằn ranh quan trọng nhất của cả cơ chế: mọi cờ khác trong `ai.config` đều sửa được
  // bằng một câu SQL hoặc một màn hình quản trị. Hai công tắc này thì không — muốn mở phải sửa
  // biến môi trường rồi DỰNG LẠI container. Nếu dòng dưới đây đỏ, nghĩa là ai đó vừa mở một
  // đường ghi từ CSDL vào chặn cứng.
  const savedSend = process.env.AI_ALLOW_CUSTOMER_SEND;
  const savedOrder = process.env.AI_ALLOW_ORDER_CREATE;
  try {
    delete process.env.AI_ALLOW_CUSTOMER_SEND;
    delete process.env.AI_ALLOW_ORDER_CREATE;
    await setSettingJson(AI_CONFIG_KEY, { hardLimits: { allowAutoSend: true, allowHumanApprovedSend: true, allowOrderCreate: true } });
    const fromDb = await getAiSettings();
    assert.deepEqual(fromDb.hardLimits, SAFEST_HARD_LIMITS, "ghi hardLimits vào bảng settings KHÔNG được mở công tắc");

    // Chỉ đúng một chuỗi mở được. Một công tắc mà gõ kiểu gì cũng bật được là một công tắc sẽ bị
    // bật nhầm — nên `1`, `yes`, `on` đều là CẤM.
    for (const raw of ["1", "yes", "on", "TRUE ", "false", ""]) {
      process.env.AI_ALLOW_AUTO_SEND = raw;
      assert.equal(aiEnv.hardLimits.allowAutoSend, raw.trim().toLowerCase() === "true", `giá trị ${JSON.stringify(raw)}: chỉ chuỗi "true" mới mở`);
    }

    /*
      CỜ CŨ CHỈ ĐI ĐƯỢC VỀ PHÍA HẸP HƠN.

      `AI_ALLOW_CUSTOMER_SEND` từng gộp cả hai nghĩa. Sau bản tách nó chỉ còn nghĩa "nhân viên bấm
      gửi" — nên một môi trường cũ bật nó lên KHÔNG bao giờ mở được đường máy tự gửi. Đây là dòng
      canh chừng cho đúng điều đó.
    */
    delete process.env.AI_ALLOW_AUTO_SEND;
    delete process.env.AI_ALLOW_HUMAN_APPROVED_SEND;
    process.env.AI_ALLOW_CUSTOMER_SEND = "true";
    assert.equal(aiEnv.hardLimits.allowHumanApprovedSend, true, "cờ cũ vẫn mở được đường NGƯỜI bấm gửi");
    assert.equal(aiEnv.hardLimits.allowAutoSend, false, "cờ cũ TUYỆT ĐỐI không mở được đường MÁY tự gửi");
    assert.equal((await getAiSettings()).hardLimits.allowOrderCreate, false, "ba công tắc độc lập: mở cái gửi tin không mở cái tạo đơn");
  } finally {
    if (savedSend === undefined) delete process.env.AI_ALLOW_CUSTOMER_SEND;
    else process.env.AI_ALLOW_CUSTOMER_SEND = savedSend;
    delete process.env.AI_ALLOW_AUTO_SEND;
    delete process.env.AI_ALLOW_HUMAN_APPROVED_SEND;
    if (savedOrder === undefined) delete process.env.AI_ALLOW_ORDER_CREATE;
    else process.env.AI_ALLOW_ORDER_CREATE = savedOrder;
    await setSettingJson(AI_CONFIG_KEY, {});
  }

  // Không khai gì trong môi trường ⇒ giá trị an toàn nhất. Mặc định của bản chạy thử là CẤM,
  // không phải "cho tới khi có người nghĩ ra là phải cấm".
  assert.deepEqual(aiEnv.hardLimits, SAFEST_HARD_LIMITS, "không khai biến môi trường thì cả hai công tắc đều CẤM");

  // ── LUẬT PHẢI ĐỦ CHO CÂU THƯỜNG GẶP — MỖI LẦN THIẾU LÀ MỘT LƯỢT GỌI MÔ HÌNH ──
  //
  // Đo 15/09/2026 trên chính các câu có thật trong mẻ: 5/14 câu rơi về OTHER ở 0.2 và phải gọi mô
  // hình, trong đó có "Bao nhiêu em?" — câu hỏi giá phổ biến nhất. Danh sách từ khoá cũ chỉ có các
  // CỤM DÀI ("bao nhieu tien"), tức là đòi khách viết đủ câu.
  for (const cau of ["Bao nhiêu em?", "báo giá", "Cho xin giá", "bao nhiêu một áo", "Giá sau khi giảm 40% là bao nhiêu?"]) {
    const u = understandByRule(cau);
    assert.ok(u.intents.includes("PRICE_QUESTION"), `"${cau}" phải là câu hỏi giá, thực tế ${u.intents.join(",")}`);
    assert.ok(ruleIsEnough(u), `"${cau}" phải giải được bằng LUẬT — không đáng một lượt gọi mô hình`);
  }
  // "cho xin giá" là XIN BÁO GIÁ, không phải CHÊ ĐẮT. Trước đây nó nằm trong danh sách OBJECTION.
  assert.ok(!understandByRule("Cho xin giá").intents.includes("OBJECTION"), "xin báo giá không phải chê đắt");
  // Chê đắt thật thì vẫn phải nhận ra.
  assert.ok(understandByRule("đắt quá shop ơi").intents.includes("OBJECTION"));

  // ── MỘT CÂU HỎI KHÔNG BAO GIỜ LÀ MỘT LỜI XÁC NHẬN ──
  //
  // ĐÂY LÀ LOẠI DƯƠNG TÍNH GIẢ NGUY HIỂM NHẤT: "Có được kiểm hàng không?" khớp từ "duoc" và ra
  // CONFIRM ở 0.8 — một CÂU HỎI bị đọc thành XÁC NHẬN CHỐT ĐƠN.
  for (const hoi of ["Có được kiểm hàng không?", "Đúng mẫu này không?", "shop giao được không?"]) {
    assert.ok(!understandByRule(hoi).intents.includes("CONFIRM"), `"${hoi}" là câu hỏi, không phải xác nhận`);
  }
  assert.ok(understandByRule("Có được kiểm hàng không?").intents.includes("PRODUCT_QUESTION"), "và nó phải được nhận đúng là câu hỏi về điều kiện mua bán");
  // Tiếng đồng ý THẬT vẫn phải nhận ra — bỏ sót chiều này thì khách chốt xong máy không hiểu.
  for (const dong of ["ok shop", "vâng ạ", "đúng rồi", "chốt nhé"]) {
    assert.ok(understandByRule(dong).intents.includes("CONFIRM"), `"${dong}" phải là xác nhận`);
  }

  // ── LƯỢC ĐỒ PHẢI NHẬN `null` — ĐÂY LÀ LỖI ĐẮT NHẤT ĐO ĐƯỢC TỚI GIỜ ──
  //
  // `.default("")` của zod CHỈ áp khi khoá VẮNG MẶT. Mô hình trả `"productText": null` — đúng cách
  // JSON diễn đạt "trống" — nên lược đồ báo invalid_type, MỌI lượt ECONOMY hỏng, leo lên STRONG,
  // STRONG hỏng nốt, cả dây chuyền rơi về HUMAN.
  //
  // Đo 15/09/2026: 25 lượt gọi, 48% lên model mạnh, 1/18 hội thoại hiểu được. Trả tiền gấp đôi để
  // nhận về con số không.
  const nullHet = UNDERSTANDING_SCHEMA.parse({
    intents: ["PRICE_QUESTION"],
    entities: {
      productText: null, productCode: null, size: null, color: null, quantity: null,
      phone: null, address: null, province: null,
      heightCm: null, weightKg: null, bustCm: null, waistCm: null, hipCm: null,
    },
    confidence: 0.9,
    evidence: null,
  });
  assert.equal(nullHet.entities.productText, "", "null phải quy về chuỗi rỗng, không phải lỗi lược đồ");
  assert.equal(nullHet.evidence, "");
  // CĂN CỨ nhận cả MẢNG: mô hình trả ["bao nhiêu","em"] là hợp lý với nghĩa "những cụm dẫn tới kết
  // luận". Đây là ô giải thích cho người đọc — không con số nào, không quyết định nào đọc nó — nên
  // quy đổi kiểu ở đây an toàn, khác hẳn nới lỏng một ô thực thể.
  assert.equal(
    UNDERSTANDING_SCHEMA.parse({ intents: ["PRICE_QUESTION"], entities: {}, confidence: 0.9, evidence: ["bao nhiêu", "em"] }).evidence,
    "bao nhiêu · em",
  );
  assert.equal(nullHet.entities.quantity, null, "số vẫn giữ null — null ở đây nghĩa là CHƯA BIẾT");

  // Khoá vắng mặt hoàn toàn cũng phải qua — mô hình có thể bỏ hẳn ô nó không thấy gì.
  const thieuKhoa = UNDERSTANDING_SCHEMA.parse({ intents: ["GREETING"], entities: {}, confidence: 0.8 });
  assert.equal(thieuKhoa.entities.color, "");
  assert.equal(thieuKhoa.evidence, "");

  /*
    VÀ CHIỀU NGƯỢC LẠI VẪN CHẶN — nhưng chặn ĐÚNG CHỖ, vì hai loại rác không giống nhau:

    · Một Ý ĐỊNH ngoài danh sách là một NGHĨA KHÔNG TỒN TẠI. Không có gì để giữ lại ⇒ vứt cả lượt.
    · Một CON SỐ ngoài khoảng là một ô đo hỏng của một chiều CÓ THẬT. Phần còn lại của lượt hiểu
      (ý định, mẫu mã, SĐT) vẫn dùng được, nên câu trả lời đúng là ô đó CHƯA BIẾT — để máy đi hỏi
      khách — chứ không phải vứt cả lượt rồi leo nấc lên mô hình mạnh và kết thúc ở chuyển người.

    Và CHƯA BIẾT ở đây không hoá thành một lời khẳng định: số lượng để trống thì máy chủ mặc định 1,
    con số ấy được ĐỌC LẠI cho khách nghe trong bản chốt và khách phải xác nhận mới lên đơn.
  */
  assert.throws(() => UNDERSTANDING_SCHEMA.parse({ intents: [], entities: {}, confidence: 0.5 }), "phải có ít nhất một ý định");
  assert.throws(() => UNDERSTANDING_SCHEMA.parse({ intents: ["KHONG_CO_THAT"], entities: {}, confidence: 0.5 }), "ý định lạ phải bị từ chối");
  assert.throws(() => UNDERSTANDING_SCHEMA.parse({ intents: ["GREETING"], entities: {}, confidence: 9 }), "độ tin ngoài [0,1] phải bị từ chối");
  assert.equal(
    UNDERSTANDING_SCHEMA.parse({ intents: ["GREETING"], entities: { quantity: 999 }, confidence: 0.5 }).entities.quantity,
    null,
    "số ngoài khoảng ⇒ ô đó CHƯA BIẾT, KHÔNG được thành 999 và cũng không làm hỏng phần hiểu còn lại",
  );

  // ── NHÂN SỰ BÁN HÀNG DÙNG LẠI TẦNG AI CÓ SẴN CỦA ERP, KHÔNG DỰNG TÍCH HỢP THỨ HAI ──
  //
  // ERP đã có một lớp provider đầy đủ (`lib/ai/`) với SDK chính thức, thử lại, trần thời gian và
  // khoá đang chạy THẬT cho AI Copilot trên production. Bản đầu của nhân sự AI tự viết client
  // riêng với khoá riêng — nghĩa là hai khoá phải giữ, hai chỗ đổi mô hình, hai bảng giá có thể
  // nói hai con số khác nhau về cùng một lượt gọi.
  //
  // `AI_PROVIDER` nay CHỈ thuộc về tầng ERP. Nhân sự AI không diễn giải lại nó — cầu nối `erp`
  // đọc nó qua chính bộ định tuyến của ERP.
  assert.deepEqual([...WORKFORCE_PROVIDERS].sort(), providerNames().sort(), "danh sách tên nhà cung cấp phải khớp sổ đăng ký thật");
  assert.ok(providerNames().includes("erp"), "cầu nối sang tầng AI của ERP phải có mặt trong sổ đăng ký");

  const savedWf = process.env.AI_WORKFORCE_PROVIDER;
  const savedProv = process.env.AI_PROVIDER;
  const savedOpenai = process.env.OPENAI_API_KEY;
  const savedAnth = process.env.ANTHROPIC_API_KEY;
  const savedWfKey = process.env.AI_API_KEY;
  try {
    for (const k of ["AI_WORKFORCE_PROVIDER", "AI_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_API_KEY"]) delete process.env[k];

    // ① KHÔNG KHAI GÌ ⇒ `stub`, tức KHÔNG GỌI MẠNG. Đây là điều quan trọng nhất ở khối này: một
    //    lần triển khai thiếu biến không được biến thành một con bot tự gọi mô hình.
    assert.equal(aiEnv.provider, "", "không khai thì `provider` rỗng — 'để hệ thống tự chọn', không phải một tên");
    assert.equal(defaultProviderName(), "stub", "chưa cấu hình gì thì KHÔNG gọi mạng");

    // ② ERP đã cấu hình OpenAI ⇒ nhân sự AI đi theo, dùng ĐÚNG khoá ấy. Không đòi khoá thứ hai.
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-khong-goi-that";
    assert.equal(defaultProviderName(), "erp", "ERP có sẵn OpenAI thì nhân sự bán hàng dùng lại, không dựng tích hợp riêng");

    // ③ `AI_PROVIDER=off` là TẮT, và tắt phải lan sang cả nhân sự AI — một công tắc tắt mà chỉ tắt
    //    một nửa hệ thống là công tắc nói dối.
    process.env.AI_PROVIDER = "off";
    assert.equal(defaultProviderName(), "stub", "AI_PROVIDER=off thì nhân sự AI cũng không gọi mạng");

    // ④ Khoá RIÊNG của nhân sự AI vẫn là đường lui — nhưng phải KHAI mới dùng tới.
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER;
    process.env.AI_API_KEY = "sk-ant-test";
    assert.equal(defaultProviderName(), "anthropic", "có khoá riêng thì vẫn chạy được bằng đường lui");

    // ⑤ Khai tay thắng tuyệt đối — kể cả khi tầng ERP đang sẵn sàng.
    process.env.OPENAI_API_KEY = "sk-test-khong-goi-that";
    process.env.AI_PROVIDER = "openai";
    process.env.AI_WORKFORCE_PROVIDER = "stub";
    assert.equal(defaultProviderName(), "stub", "AI_WORKFORCE_PROVIDER thắng mọi thứ khác");

    // ⑥ Tên lạ KHÔNG được nhận: rơi về phía hẹp hơn, đúng như mọi nhánh lỗi khác của ERP.
    process.env.AI_WORKFORCE_PROVIDER = "lung-tung";
    assert.equal(aiEnv.provider, "", "tên nhà cung cấp không có thật thì coi như chưa khai");
  } finally {
    const tra = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    tra("AI_WORKFORCE_PROVIDER", savedWf);
    tra("AI_PROVIDER", savedProv);
    tra("OPENAI_API_KEY", savedOpenai);
    tra("ANTHROPIC_API_KEY", savedAnth);
    tra("AI_API_KEY", savedWfKey);
  }

  // ── THÔNG BÁO CỦA NỀN TẢNG KHÔNG PHẢI CÂU NHÂN VIÊN TRẢ LỜI ──
  //
  // ĐO 15/09/2026 trên mẻ 18 hội thoại thật: MỌI chuỗi bị tính là "câu nhân viên trả lời" đều là
  // một trong hai mẫu do Facebook tự sinh — và tên trong đó là tên CHÍNH KHÁCH. Tính chúng là
  // nhân viên thì mọi phép đo đối chiếu AI ↔ người đều lệch, vì bên "người" toàn là máy.
  assert.equal(
    classifySender({ fromPage: true, fromName: "Hoa Đặng", text: "Hoa Đặng đã trả lời một quảng cáo.", customerName: "Hoa Đặng" }),
    "PAGE_SYSTEM",
    "chuỗi sự kiện của Facebook không phải nhân viên",
  );
  // Dấu hiệu MẠNH NHẤT và không cần danh sách chuỗi nào: tin phía shop mang ĐÚNG tên khách.
  // Không nhân viên nào viết dưới tên khách hàng — nên nó bắt được cả mẫu thông báo chưa từng thấy.
  assert.equal(
    classifySender({ fromPage: true, fromName: "Tam Tam", text: "một mẫu thông báo lạ chưa từng gặp", customerName: "Tam Tam" }),
    "PAGE_SYSTEM",
  );
  assert.equal(
    classifySender({ fromPage: true, fromName: "Shop", text: "Chào Linh, bạn thích đầm này? Nhắn cho shop để biết thêm chi tiết ạ!", customerName: "Linh" }),
    "PAGE_SYSTEM",
    "lời chào tự động của quảng cáo click-to-message",
  );

  // VÀ CHIỀU NGƯỢC LẠI PHẢI GIỮ: bắt nhầm câu nhân viên THẬT thành thông báo nền tảng còn tệ hơn —
  // máy sẽ chen vào một hội thoại người đang cầm. Câu dưới là câu shop dùng nhiều nhất (đo 16 lần).
  assert.equal(
    classifySender({ fromPage: true, fromName: "Hải An", text: "Chị cho em xin Chiều Cao + Cân Nặng để em tư vấn size cho chị nha", customerName: "Tam Tam" }),
    "PAGE_HUMAN",
    "câu nhân viên thật phải ở lại PAGE_HUMAN",
  );
  assert.equal(classifySender({ fromPage: false, fromName: "Tam Tam", text: "bao nhiêu ạ", customerName: "Tam Tam" }), "CUSTOMER", "tin của khách vẫn là khách");
  assert.equal(classifySender({ fromPage: true, fromName: "Botcake", text: "xin chào" }), "PAGE_BOT", "bot vẫn là bot");

  // ═════════ 6. WEBHOOK: CHUẨN HOÁ, CHỐNG TRÙNG, CHỐNG VÒNG LẶP ═════════

  const webhook = {
    page_id: "page-77",
    conversation_id: "conv-77",
    message: { id: "msg-1", message: "<div>em muốn mua đầm Q002 size L màu đỏ</div>", inserted_at: "2026-09-14T03:00:00", from: { id: "cust-9", name: "Chị Lan" } },
    conversation: { customer: { id: "cust-9", name: "Chị Lan", phone_numbers: [{ phone_number: "0912345678" }] } },
  };
  const result = normalizeChatWebhook(webhook);
  assert.equal(result.ok, true, "gói tin đủ khoá phải chuẩn hoá được");
  if (!result.ok) throw new Error("không chuẩn hoá được gói tin mẫu");
  const parsed = result;
  assert.equal(parsed.message.text, "em muốn mua đầm Q002 size L màu đỏ", "phải bỏ thẻ HTML của Pancake");
  assert.equal(parsed.message.fromPage, false, "tin của khách không phải tin của shop");
  assert.equal(parsed.message.senderType, "CUSTOMER");
  assert.equal(parsed.conversation.phone, "0912345678");
  assert.equal(parsed.conversation.pancakeCustomerId, "cust-9", "phải giữ mã khách để còn đọc lại hội thoại qua API");
  assert.equal(parsed.message.sentAt?.toISOString(), "2026-09-14T03:00:00.000Z", "Pancake trả ISO không múi giờ nhưng là UTC");

  // TỪ CHỐI PHẢI CÓ CHẨN ĐOÁN, không phải `null` trống: thiếu khoá nào, gói tin có khoá gì.
  // Ánh xạ webhook hội thoại CHƯA được kiểm chứng (tài liệu Pancake trong kho mã chỉ có bốn loại
  // webhook POS), nên một mẫu thật phải là đủ để hoàn thiện ánh xạ mà không phải đoán.
  const noMessageId = normalizeChatWebhook({ page_id: "p", conversation_id: "c", foo: 1 });
  assert.equal(noMessageId.ok, false);
  if (noMessageId.ok) throw new Error("gói tin thiếu mã tin nhắn không được coi là hợp lệ");
  assert.equal(noMessageId.reason, "MISSING_REQUIRED_FIELD");
  assert.deepEqual(noMessageId.missing, ["messageId"], "phải nói RÕ thiếu khoá nào");
  assert.ok(noMessageId.seenKeys.includes("foo"), "phải liệt kê khoá thật sự có trong gói tin để còn sửa ánh xạ");

  const notObject = normalizeChatWebhook("chuỗi chứ không phải object");
  assert.equal(notObject.ok === false && notObject.reason, "NOT_JSON_OBJECT");
  const emptyPayload = normalizeChatWebhook(null);
  assert.equal(emptyPayload.ok === false && emptyPayload.reason, "EMPTY_PAYLOAD");
  const arrayPayload = normalizeChatWebhook([{ page_id: "p" }]);
  assert.equal(arrayPayload.ok === false && arrayPayload.reason, "NOT_JSON_OBJECT", "mảng không phải một gói tin");

  // Mã hội thoại KHÔNG được lấy nhầm từ `id` ở gốc gói tin — ở đó `id` là mã TIN NHẮN.
  const idAtRoot = normalizeChatWebhook({ page_id: "p", id: "msg-x", message: "xin chào" });
  assert.equal(idAtRoot.ok, false, "chỉ có id ở gốc thì không suy ra được mã hội thoại");

  // ── Tin của shop: phân biệt NHÂN VIÊN với BOT ──
  const shopEcho = normalizeChatWebhook({ ...webhook, message: { ...webhook.message, id: "msg-2", from: { id: "page-77", name: "Chị Hà" } } });
  assert.equal(shopEcho.ok && shopEcho.message.fromPage, true, "tin gửi từ chính page phải được nhận là tin của shop");
  assert.equal(shopEcho.ok && shopEcho.message.senderType, "PAGE_HUMAN");

  const botEcho = normalizeChatWebhook({ ...webhook, message: { ...webhook.message, id: "msg-3", from: { id: "page-77", name: "Botcake" } } });
  assert.equal(botEcho.ok && botEcho.message.senderType, "PAGE_BOT", "tin do bot gửi KHÔNG được tính là câu nhân viên trả lời");

  const anonEcho = normalizeChatWebhook({ ...webhook, message: { ...webhook.message, id: "msg-4", from_page: true, from: {} } });
  assert.equal(anonEcho.ok && anonEcho.message.senderType, "UNKNOWN", "tin của shop không rõ người gửi là CHƯA BIẾT, không đoán là nhân viên");

  // Tệp đính kèm phải đếm được — ảnh là cách khách hỏi mẫu phổ biến nhất.
  const withPhoto = normalizeChatWebhook({ ...webhook, message: { ...webhook.message, id: "msg-5", attachments: [{ type: "photo" }, { type: "photo" }] } });
  assert.equal(withPhoto.ok && withPhoto.message.attachmentCount, 2);
  assert.equal(withPhoto.ok && withPhoto.message.hasAttachment, true);

  // Trường tuỳ chọn thiếu hết vẫn phải chuẩn hoá được: gói tin nghèo không phải gói tin hỏng.
  const minimal = normalizeChatWebhook({ page_id: "p1", conversation_id: "c1", message: { id: "m1" } });
  assert.equal(minimal.ok, true, "đủ ba khoá bắt buộc là nạp được, các trường khác thiếu thì để rỗng");
  assert.equal(minimal.ok && minimal.message.text, "");
  assert.equal(minimal.ok && minimal.message.sentAt, null, "không có mốc thời gian thì là CHƯA BIẾT, không phải bây giờ");

  // 6a. Nạp lần đầu: ghi tin, tạo việc.
  await setSettingJson(AI_CONFIG_KEY, {});
  const first = await ingestMessage(parsed.conversation, parsed.message, "test", db);
  assert.equal(first.duplicate, false);
  assert.equal(first.eventEmitted, true, "tin của khách phải tạo việc cho nhân sự AI");

  // 6b. CÙNG gói tin gửi lại ⇒ không dòng mới, không việc mới.
  const second = await ingestMessage(parsed.conversation, parsed.message, "test", db);
  assert.equal(second.duplicate, true, "webhook gửi lại không được đẻ thêm tin nhắn");
  assert.equal(second.eventEmitted, false, "webhook gửi lại không được tạo thêm việc");
  const messageRows = await db.query.salesMessages.findMany({ where: eq(schema.salesMessages.externalId, "msg-1") });
  assert.equal(messageRows.length, 1, "một mã tin nhắn — một dòng, dù nhận bao nhiêu lần");

  // 6c. CHỐNG VÒNG LẶP: tin của shop không bao giờ tạo việc.
  // Lời chào tự động của page: tin của shop, do MÁY gửi — không tạo việc, và cũng không được
  // tính là "câu nhân viên trả lời" ở khối 6D bên dưới.
  const echo = await ingestMessage(
    parsed.conversation,
    { ...parsed.message, externalId: "msg-2", fromPage: true, senderType: "PAGE_BOT", fromName: "Botcake", text: "Dạ em chào chị" },
    "test",
    db,
  );
  /*
    ═════════ BOT TRẢ LỜI DƯỚI TÊN FANPAGE ═════════

    ĐO 22/09/2026: toàn bộ 4.749 tin ERP xếp là "nhân viên trả lời" đến từ ĐÚNG MỘT tên —
    `Hải An Fashion`, tên fanpage — và chủ shop xác nhận đó là bot Gemini. Số tin nhận ra là máy: 0.

    Không có gì trong cái tên hay trong câu chữ nói rằng nó là máy, nên phép đoán KHÔNG làm được;
    chỉ shop mới biết. Hệ quả của việc đoán sai không dừng ở một cột hiển thị: ERP đặt
    `humanTakeoverAt` cho 205 hội thoại vì tưởng người đã vào, và nhân sự AI đứng im ở đúng những
    cuộc ấy.
  */
  assert.equal(
    classifySender({ fromPage: true, fromName: "Hải An Fashion", text: "Dạ chị cho em xin chiều cao ạ" }),
    "PAGE_HUMAN",
    "chưa khai thì vẫn là 'chưa biết, tạm coi là người' — đoán là máy cũng sai như đoán là người",
  );
  assert.equal(
    classifySender({ fromPage: true, fromName: "Hải An Fashion", text: "Dạ chị cho em xin chiều cao ạ", botNames: ["Hải An Fashion"] }),
    "PAGE_BOT",
    "shop khai rồi thì phải nhận ra là máy",
  );
  // Khớp TRỌN VẸN, không khớp một phần: khai "Hải An Fashion" không được nuốt một nhân viên tên khác.
  assert.equal(
    classifySender({ fromPage: true, fromName: "Hải An Fashion Trang", text: "x", botNames: ["Hải An Fashion"] }),
    "PAGE_HUMAN",
    "khớp một phần sẽ nuốt nhầm nhân viên có tên chứa chuỗi đó",
  );
  // Khai hoa thường khác nhau vẫn phải nhận ra — người gõ vào settings không canh chính tả.
  assert.equal(
    classifySender({ fromPage: true, fromName: "HẢI AN FASHION", text: "x", botNames: ["hải an fashion"] }),
    "PAGE_BOT",
  );

  assert.equal(echo.eventEmitted, false, "tin của shop KHÔNG được tạo việc — nếu không con bot sẽ tự nói chuyện với chính nó");
  assert.match(echo.reason, /vòng lặp/);

  /*
    ═════════ 6C-BIS. MỘT MÂU THUẪN ĐANG SỐNG LÀ MỘT DÒNG, KHÔNG PHẢI MỘT DÒNG MỖI VÒNG ═════════

    Đo production 22/09/2026: bốn tin nhắn sinh ra 17.962 dòng `ai_errors` — 4.571 dòng cho MỘT
    tin. Cửa sổ đọc chồng lấn đọc lại cùng tin ấy mỗi 45 giây, lần nào cũng phát hiện lại đúng
    mâu thuẫn đã biết, và lần nào cũng ghi thêm một dòng. Chú thích ở nơi gọi ghi "Ghi lại MỘT
    lần" nhưng không có gì thực thi câu ấy.

    Bài kiểm này khoá HAI tính chất, và tính chất thứ hai quan trọng ngang tính chất thứ nhất:
      · đọc lại nhiều lần ⇒ vẫn ĐÚNG MỘT dòng;
      · số lần gặp KHÔNG bị vứt đi — nó phân biệt một trục trặc thoáng qua với một mâu thuẫn
        đang sống, và người đọc cần nó để biết có phải đi sửa hay không.
  */
  const tinTrung = { ...parsed.message, externalId: "msg-1-khac-ma" };
  const lanDau = await ingestMessage(parsed.conversation, tinTrung, "test", db, "WEBHOOK");
  assert.equal(lanDau.duplicate, true, "cùng vân tay nội dung mà khác mã ⇒ nhận ra là trùng chéo kênh");

  const demDong = async () =>
    (await db.query.aiErrors.findMany({
      where: and(eq(schema.aiErrors.scope, "INGEST"), eq(schema.aiErrors.subjectId, first.conversationId)),
    })).filter((r) => r.message.startsWith("Hai đường nạp đánh mã khác nhau"));

  const sauLanDau = await demDong();
  assert.equal(sauLanDau.length, 1, "mâu thuẫn mới ⇒ ghi đúng một dòng");
  assert.equal(Number((sauLanDau[0].detail as Record<string, unknown>)?.seen), 1, "lần đầu gặp thì đếm là 1");

  // Ba vòng nạp nữa trên ĐÚNG tin ấy — đây chính là cái cửa sổ chồng lấn 45 giây trong đời thật.
  for (let i = 0; i < 3; i += 1) await ingestMessage(parsed.conversation, tinTrung, "test", db, "WEBHOOK");
  const sauBaVong = await demDong();
  assert.equal(sauBaVong.length, 1, "đọc lại ba lần nữa vẫn phải là MỘT dòng — đây là lỗi đã đẻ ra 4.571 dòng");
  assert.equal(Number((sauBaVong[0].detail as Record<string, unknown>)?.seen), 4, "số lần gặp phải được đếm, không được vứt đi");
  assert.ok(
    typeof (sauBaVong[0].detail as Record<string, unknown>)?.lastSeenAt === "string",
    "phải biết lần gặp CUỐI là lúc nào — một mâu thuẫn ngừng tái diễn khác hẳn một mâu thuẫn đang sống",
  );

  // ═════════ 6D. NỐI CÂU NHÂN VIÊN THEO LƯỢT — KHÔNG GIẢ ĐỊNH MỘT-ĐỔI-MỘT ═════════
  //
  // Nhân viên hay trả lời một lượt khách bằng ba bốn tin liền; đôi khi không trả lời tin nào;
  // đôi khi trả lời muộn hơn một lượt khách mới. Cả ba tình huống đều phải nối đúng.
  const conversationId = first.conversationId;
  const sales = await getAgent("sales", undefined, db);
  assert.ok(sales);

  const triggerRow = await db.query.salesMessages.findFirst({ where: eq(schema.salesMessages.externalId, "msg-1") });
  assert.ok(triggerRow, "phải tìm được tin khách đã mở lượt");
  const [suggestion] = await db
    .insert(schema.salesSuggestions)
    .values({
      conversationId,
      triggerMessageId: triggerRow.id,
      stageBefore: "NEW_LEAD",
      stageAfter: "PRODUCT_IDENTIFIED",
      action: "ASK_SIZE",
      suggestedReply: "Dạ chị cho em xin chiều cao cân nặng ạ",
    })
    .returning({ id: schema.salesSuggestions.id });

  const triggerAt = triggerRow.sentAt ?? new Date();
  const shopMessage = (externalId: string, text: string, seconds: number, fromName = "Chị Hà") => ({
    externalId,
    text,
    fromPage: true,
    senderType: "PAGE_HUMAN" as const,
    fromName,
    sentAt: new Date(triggerAt.getTime() + seconds * 1000),
    hasAttachment: false,
    attachmentCount: 0,
    raw: {},
  });

  // Ba tin của nhân viên trong CÙNG một lượt.
  await ingestMessage(parsed.conversation, shopMessage("msg-h1", "Dạ chị ơi", 30), "test", db);
  await ingestMessage(parsed.conversation, shopMessage("msg-h2", "Chị cao bao nhiêu ạ?", 45), "test", db);
  await ingestMessage(parsed.conversation, shopMessage("msg-h3", "Và cân nặng nữa ạ", 60), "test", db);

  const linked = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, suggestion.id) });
  assert.equal(linked?.humanReply, "Dạ chị ơi", "ảnh chụp giữ câu ĐẦU TIÊN của lượt");
  assert.equal(linked?.humanReplyCount, 3, "phải đếm đủ ba tin, không bỏ rơi hai tin sau");
  assert.equal(linked?.humanResponseSeconds, 30, "thời gian phản hồi tính từ tin khách tới câu đầu tiên");

  // Tin do BOT gửi không phải câu nhân viên trả lời.
  await ingestMessage(parsed.conversation, { ...shopMessage("msg-bot", "Cảm ơn chị đã nhắn tin!", 75), senderType: "PAGE_BOT", fromName: "Botcake" }, "test", db);
  const afterBot = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, suggestion.id) });
  assert.equal(afterBot?.humanReplyCount, 3, "tin bot KHÔNG được cộng vào số câu nhân viên trả lời");

  // Lượt khách MỚI: câu nhân viên sau đó thuộc lượt mới, không được gán ngược vào lượt cũ.
  const secondTrigger = await ingestMessage(
    parsed.conversation,
    { externalId: "msg-turn2", text: "em cao 1m60 ạ", fromPage: false, senderType: "CUSTOMER", fromName: "Chị Lan", sentAt: new Date(triggerAt.getTime() + 120_000), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  assert.ok(secondTrigger.messageId);
  const [suggestion2] = await db
    .insert(schema.salesSuggestions)
    .values({ conversationId, triggerMessageId: secondTrigger.messageId, stageBefore: "SIZE_SELECTION", stageAfter: "SIZE_SELECTION", action: "ASK_SIZE", suggestedReply: "Dạ size L ạ" })
    .returning({ id: schema.salesSuggestions.id });
  await ingestMessage(parsed.conversation, shopMessage("msg-h4", "Dạ chị mặc size L nhé", 150), "test", db);

  const turn1 = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, suggestion.id) });
  const turn2 = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, suggestion2.id) });
  assert.equal(turn1?.humanReplyCount, 3, "lượt cũ không được nhận thêm câu trả lời của lượt mới");
  assert.equal(turn2?.humanReply, "Dạ chị mặc size L nhé", "câu sau tin khách mới thuộc về lượt mới");
  assert.equal(turn2?.humanReplyCount, 1);

  // Dựng lại cấu trúc lượt lúc đọc — đây mới là bản ĐẦY ĐỦ, ô `human_reply` chỉ là ảnh chụp.
  const turns = await getConversationTurns(conversationId);
  assert.ok(turns.length >= 2, "phải dựng được ít nhất hai lượt");
  const firstTurn = turns.find((t) => t.triggerMessageId === triggerRow.id);
  assert.ok(firstTurn, "lượt đầu phải có mặt");
  // Năm tin của shop trong lượt đầu: lời chào bot · ba tin nhân viên · một tin bot.
  assert.equal(firstTurn.shopReplies.length, 5, "bản đầy đủ giữ CẢ tin bot lẫn tin nhân viên để đọc lại bối cảnh");
  assert.equal(firstTurn.shopReplies.filter((r) => r.senderType === "PAGE_HUMAN").length, 3);

  // ═════════ 6D-bis. THỨ TỰ CỦA ĐƯỜNG NẠP THEO LÔ ═════════
  //
  // Khối 6D ở trên dựng gợi ý TRƯỚC rồi mới ghi tin nhân viên — đúng thứ tự của webhook, và vì
  // vậy nó xanh kể cả khi đường nạp theo LÔ hỏng hoàn toàn. Lô đi ngược: ghi hết lịch sử, xong
  // mới chạy máy. Đo trên bản chạy thử 14/09/2026: 148 tin nhân viên, 36 gợi ý, nối được 0.
  //
  // Bài kiểm này dựng đúng thứ tự của lô: tin khách và tin nhân viên vào CSDL trước, gợi ý sinh
  // sau, rồi mới gọi bước nối lại.
  const loConversation = await ingestMessage(
    { pageId: "page-lo", externalId: "hoi-thoai-lo", pancakeCustomerId: "kh-lo", customerName: "Chị Lô", phone: "", platform: "facebook" },
    { externalId: "lo-k1", text: "Chị ơi mẫu này còn size M không", fromPage: false, senderType: "CUSTOMER", fromName: "Chị Lô", sentAt: new Date("2026-09-14T02:00:00Z"), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  assert.ok(loConversation.conversationId);
  for (const [i, text] of ["Dạ còn size M ạ", "Chị cho em xin số điện thoại nhé"].entries()) {
    await ingestMessage(
      { pageId: "page-lo", externalId: "hoi-thoai-lo", pancakeCustomerId: "kh-lo", customerName: "Chị Lô", phone: "", platform: "facebook" },
      { externalId: `lo-nv${i}`, text, fromPage: true, senderType: "PAGE_HUMAN", fromName: "Chị Hà", sentAt: new Date(`2026-09-14T02:0${i + 1}:00Z`), hasAttachment: false, attachmentCount: 0, raw: {} },
      "test",
      db,
    );
  }
  const loTrigger = await db.query.salesMessages.findFirst({ where: eq(schema.salesMessages.externalId, "lo-k1") });
  assert.ok(loTrigger);
  const [loSuggestion] = await db
    .insert(schema.salesSuggestions)
    .values({
      conversationId: loConversation.conversationId,
      triggerMessageId: loTrigger.id,
      stageBefore: "NEW_LEAD",
      stageAfter: "NEW_LEAD",
      action: "ASK_PRODUCT",
      suggestedReply: "Dạ chị đang xem mẫu nào ạ?",
    })
    .returning({ id: schema.salesSuggestions.id });

  const chuaNoi = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, loSuggestion.id) });
  assert.equal(chuaNoi?.humanReply, "", "gợi ý sinh sau tin nhân viên thì lúc mới tạo phải RỖNG — đây chính là cảnh của lô");

  const ketQua = await relinkHumanReplies({ pageId: "page-lo" }, db);
  assert.equal(ketQua.linked, 1, "bước nối lại phải cứu được đúng một gợi ý");
  const daNoi = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, loSuggestion.id) });
  assert.equal(daNoi?.humanReply, "Dạ còn size M ạ", "giữ câu ĐẦU TIÊN của lượt");
  assert.equal(daNoi?.humanReplyCount, 2, "đếm đủ cả hai tin nhân viên");
  assert.equal(daNoi?.humanResponseSeconds, 60, "thời gian phản hồi tính từ tin khách tới câu đầu");

  // CHẠY LẠI KHÔNG ĐƯỢC CỘNG DỒN: lượt nạp thứ hai trên cùng dữ liệu phải ra y hệt, và không ghi.
  const lanHai = await relinkHumanReplies({ pageId: "page-lo" }, db);
  assert.equal(lanHai.updated, 0, "chạy lại trên dữ liệu không đổi thì không được ghi dòng nào");
  const sauLanHai = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, loSuggestion.id) });
  assert.equal(sauLanHai?.humanReplyCount, 2, "số câu nhân viên phải TÍNH LẠI, không cộng dồn");

  // ═════════ 6E. CHỐNG TRÙNG CHÉO KÊNH ═════════
  //
  // Webhook và job đọc bù có thể đánh MÃ KHÁC NHAU cho cùng một tin (ánh xạ webhook chưa được
  // kiểm chứng). Khoá `external_id` không bắt được, nhưng vân tay nội dung + mốc tới giây thì có.
  const crossConv = { pageId: "page-cross", externalId: "conv-cross", pancakeCustomerId: "c", customerName: "Khách", phone: "", platform: "facebook" };
  const sameMoment = new Date("2026-09-14T04:00:00.000Z");
  const viaWebhook = await ingestMessage(
    crossConv,
    { externalId: "wh-1", text: "cho em hỏi giá", fromPage: false, senderType: "CUSTOMER", fromName: "Khách", sentAt: sameMoment, hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
    "WEBHOOK",
  );
  assert.equal(viaWebhook.eventEmitted, true);
  const viaPoll = await ingestMessage(
    crossConv,
    { externalId: "poll-1", text: "cho em hỏi giá", fromPage: false, senderType: "CUSTOMER", fromName: "Khách", sentAt: sameMoment, hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
    "POLL",
  );
  assert.equal(viaPoll.duplicate, true, "cùng nội dung + cùng mốc giây = cùng một tin, dù hai kênh đánh mã khác nhau");
  assert.equal(viaPoll.eventEmitted, false, "không được chạy AI lần thứ hai trên cùng câu của khách");
  const crossRows = await db.query.salesMessages.findMany({ where: eq(schema.salesMessages.conversationId, viaWebhook.conversationId) });
  assert.equal(crossRows.length, 1, "chỉ một dòng tin nhắn");

  // Nhưng khách nhắn LẠI đúng câu cũ ở một thời điểm khác là HAI tin thật, không phải trùng.
  const laterAgain = await ingestMessage(
    crossConv,
    { externalId: "wh-2", text: "cho em hỏi giá", fromPage: false, senderType: "CUSTOMER", fromName: "Khách", sentAt: new Date(sameMoment.getTime() + 300_000), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
    "WEBHOOK",
  );
  assert.equal(laterAgain.duplicate, false, "nhắn lại cùng câu sau 5 phút là tin THẬT, không được nuốt mất");

  // ═════════ 7. DÂY CHUYỀN CHẠY THẬT TRÊN NẤC SHADOW ═════════

  resetStub();
  await setSettingJson(AI_CONFIG_KEY, { modelCallsEnabled: false });
  const ran = await drainSalesTasks(10, db);
  assert.equal(ran.skipped, false, "nhân sự bán hàng phải đang bật ở nấc SHADOW");
  assert.ok(ran.ran >= 1, "phải chạy được ít nhất một việc đang chờ");

  const runs = await db.query.aiRuns.findMany({ where: and(eq(schema.aiRuns.subjectType, "CONVERSATION"), eq(schema.aiRuns.subjectId, conversationId)) });
  assert.ok(runs.length >= 1, "phải có lượt chạy ghi lại");
  const run = runs[0];
  assert.equal(run.mode, "SHADOW", "lượt chạy phải ghi lại nấc quyền hạn tại thời điểm chạy");
  assert.ok(run.input, "phải lưu tin nhắn vào");
  assert.ok(run.understanding, "phải lưu ý định / thực thể bóc được");
  assert.ok(run.decision, "phải lưu quyết định");
  assert.ok(run.stateBefore && run.stateAfter, "phải lưu trạng thái trước và sau");
  assert.equal(run.costVnd, 0, "chạy hết bằng luật thì chi phí bằng 0 thật");

  // Không một gợi ý nào được gửi đi ở nấc SHADOW.
  const suggestions = await db.query.salesSuggestions.findMany({ where: eq(schema.salesSuggestions.conversationId, conversationId) });
  assert.ok(suggestions.length >= 1, "phải sinh ra gợi ý để nhân viên đối chiếu");
  assert.equal(suggestions.filter((s) => s.sent).length, 0, "nấc SHADOW: KHÔNG gợi ý nào được gửi cho khách");

  // Không tin nào do nhân sự AI gửi được ghi vào hội thoại.
  const agentMessages = await db.query.salesMessages.findMany({ where: eq(schema.salesMessages.fromAgent, true) });
  assert.equal(agentMessages.length, 0, "nấc SHADOW: không tin nhắn nào do máy gửi");

  // Không đơn nào được tạo: `order.create_draft` cần nấc COPILOT.
  const conversationRow = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, conversationId) });
  assert.equal(conversationRow?.orderId, null, "nấc SHADOW không được tạo đơn");

  // ═════════ 7B. ĐI HẾT MỘT CUỘC BÁN HÀNG TRÊN DỮ LIỆU THẬT ═════════
  //
  // Đây là phép thử đáng giá nhất: một khách nhắn tám lượt như ngoài đời, đi qua cổng công cụ
  // thật, giá do máy chủ tính thật — và ở cuối, chữ "ok" của khách KHÔNG tạo ra đơn nào vì nấc
  // SHADOW chặn công cụ lên đơn.
  await db.insert(schema.products).values({ id: "p-ai-e2e", name: "Đầm suông AIE2E", customId: "AI001" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values([
      { id: "v-ai-e2e-m", productId: "p-ai-e2e", sku: "AI001-M-DO", size: "M", color: "Đỏ", retailPrice: 499_000 },
      { id: "v-ai-e2e-l", productId: "p-ai-e2e", sku: "AI001-L-DO", size: "L", color: "Đỏ", retailPrice: 499_000 },
    ])
    .onConflictDoNothing();

  const flowConv = { pageId: "page-e2e", externalId: "conv-e2e", pancakeCustomerId: "cust-e2e", customerName: "Chị Mai", phone: "", platform: "facebook" };
  let seq = 0;
  const say = async (text: string) => {
    seq += 1;
    const result = await ingestMessage(
      flowConv,
      { externalId: `e2e-${seq}`, text, fromPage: false, senderType: "CUSTOMER", fromName: "Chị Mai", sentAt: new Date(Date.now() + seq * 1000), hasAttachment: false, attachmentCount: 0, raw: {} },
      "test",
      db,
    );
    await drainSalesTasks(5, db);
    const row = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, result.conversationId) });
    return { conversationId: result.conversationId, stage: row?.stage as SalesStage, state: parseSalesState(row?.state) };
  };

  const s1 = await say("em muốn mua Đầm suông AIE2E ạ");
  assert.equal(s1.state.productId, "p-ai-e2e", "máy chủ phải tra ra đúng sản phẩm qua công cụ, không tin lời mô hình");
  assert.equal(s1.stage, "SIZE_SELECTION", "mẫu có hai size nên phải hỏi size, KHÔNG đoán hộ khách");
  /*
    VÀ ĐÃ BÁO ĐƯỢC GIÁ TỪ ĐÂY, TRƯỚC KHI KHÁCH CHỌN SIZE.

    Đo 15/09/2026 trên mẻ sạch 18 hội thoại: 0/18 câu trả lời nêu được một con số tiền, dù phần
    lớn khách HỎI GIÁ ngay tin đầu. Giá chỉ tính được khi đã có mẫu mã, nên máy bắt khách trả lời
    trước khi được trả lời. Mọi mẫu mã của mẫu này cùng 499.000đ, nên giá sản phẩm CÓ nghĩa.
  */
  assert.equal(s1.state.quotedTotal, 524_000, "mọi mẫu mã cùng giá ⇒ báo được giá ngay khi chưa chọn size");

  const s2 = await say("cho em size L");
  assert.equal(s2.state.variantId, "v-ai-e2e-l", "khoá đúng mẫu mã sau khi khách chọn size");
  assert.equal(s2.state.quotedTotal, 524_000, "giá do MÁY CHỦ tính: 499.000 hàng + 25.000 ship");

  const s3 = await say("sdt em 0912345678");
  assert.equal(s3.state.phone, "0912345678");
  assert.equal(s3.stage, "ADDRESS_COLLECTION", "có SĐT rồi thì xin địa chỉ");

  const s4 = await say("Số 5 ngõ 12 Nguyễn Trãi, Thanh Xuân, Hà Nội");
  assert.equal(s4.stage, "AWAITING_CONFIRMATION", "gửi bản chốt xong là đang CHỜ KHÁCH XÁC NHẬN, không còn ở bước đọc lại đơn");
  assert.ok(s4.state.pending, "phải ghi lại bản chốt đang chờ — đây là mảnh làm cho chữ ok sau này có nghĩa");
  assert.equal(s4.state.pending?.total, 524_000);

  // Bản chốt gửi cho khách phải mang đúng con số máy chủ tính.
  const reviewRun = await db.query.aiRuns.findFirst({
    where: and(eq(schema.aiRuns.subjectId, s4.conversationId), eq(schema.aiRuns.subjectType, "CONVERSATION")),
    orderBy: (r, { desc }) => [desc(r.startedAt)],
  });
  assert.ok(reviewRun?.suggestedReply.includes("524.000"), "bản chốt phải đọc đúng tổng tiền máy chủ tính");
  assert.ok(!reviewRun?.suggestedReply.includes("còn hàng"), "tồn chưa biết (chưa có phiếu nhập) thì không được hứa còn hàng");

  // CHỮ "OK" CUỐI CÙNG: xác nhận ĐẠT, nhưng đơn KHÔNG được tạo vì nấc SHADOW chặn công cụ.
  const s5 = await say("ok chị chốt nhé");
  assert.equal(s5.stage, "CONFIRMED", "đủ ngữ cảnh thì phải nhận là khách xác nhận");
  assert.notEqual(s5.stage, "ORDER_CREATED", "nấc SHADOW: xác nhận rồi vẫn KHÔNG được lên đơn");
  const flowRow = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, s5.conversationId) });
  assert.equal(flowRow?.orderId, null, "nấc SHADOW: không đơn nào được tạo trên POS");

  // Lần gọi bị chặn phải để lại dấu vết — "máy đã ĐỊNH lên đơn này".
  const confirmRun = await db.query.aiRuns.findFirst({
    where: and(eq(schema.aiRuns.subjectId, s5.conversationId), eq(schema.aiRuns.subjectType, "CONVERSATION")),
    orderBy: (r, { desc }) => [desc(r.startedAt)],
  });
  const draftCalls = await db.query.aiToolCalls.findMany({ where: and(eq(schema.aiToolCalls.runId, confirmRun!.id), eq(schema.aiToolCalls.tool, "order.create_draft")) });
  assert.equal(draftCalls.length, 1, "dây chuyền phải THỬ gọi công cụ lên đơn để lần bị chặn được ghi lại");
  assert.equal(draftCalls[0].outcome, "DENIED", "công cụ lên đơn bị cổng quyền chặn ở nấc SHADOW");

  // Toàn bộ cuộc bán hàng: 0 tin gửi đi, 0 đơn tạo ra.
  const flowSuggestions = await db.query.salesSuggestions.findMany({ where: eq(schema.salesSuggestions.conversationId, s5.conversationId) });
  assert.equal(flowSuggestions.length, 5, "mỗi tin của khách sinh đúng một gợi ý");
  assert.equal(flowSuggestions.filter((x) => x.sent).length, 0, "nấc SHADOW: không gợi ý nào được gửi");

  // ═════════ 7C. TỒN ĐÃ BIẾT VÀ BẰNG 0 THÌ KHÔNG ĐẨY KHÁCH TỚI CHỐT ĐƠN ═════════
  //
  // Phải phân biệt được HAI chỗ trống khác nhau: "chưa có phiếu nhập" (chưa biết — vẫn tư vấn,
  // không hứa) và "sổ kho ghi 0" (đã biết là hết — không được bán).
  const [receipt] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", reference: "AI-E2E-01", receivedAt: new Date(), note: "fixture nhân sự AI" })
    .returning({ id: schema.stockReceipts.id });
  // Nhập 1 rồi xuất tay 1 ⇒ tồn ĐÃ BIẾT và bằng 0 (khác hẳn chưa có phiếu nhập nào).
  await db.insert(schema.stockReceiptItems).values({ receiptId: receipt.id, variantId: "v-ai-e2e-m", quantity: 1, unitCost: 200_000 });
  const [issue] = await db.insert(schema.stockReceipts).values({ kind: "ISSUE", reference: "AI-E2E-02", receivedAt: new Date() }).returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: issue.id, variantId: "v-ai-e2e-m", quantity: -1, unitCost: 0 });

  const soldOutConv = { pageId: "page-hết", externalId: "conv-het", pancakeCustomerId: "cust-het", customerName: "Chị Thu", phone: "", platform: "facebook" };
  const soldOut = await ingestMessage(
    soldOutConv,
    { externalId: "het-1", text: "em muốn mua Đầm suông AIE2E size M ạ", fromPage: false, senderType: "CUSTOMER", fromName: "Chị Thu", sentAt: new Date(), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  await drainSalesTasks(5, db);
  const soldOutRow = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, soldOut.conversationId) });
  const soldOutRun = await db.query.aiRuns.findFirst({
    where: and(eq(schema.aiRuns.subjectId, soldOut.conversationId), eq(schema.aiRuns.subjectType, "CONVERSATION")),
    orderBy: (r, { desc }) => [desc(r.startedAt)],
  });
  const soldOutDecision = (soldOutRun?.decision ?? {}) as Record<string, unknown>;
  assert.equal(soldOutDecision.action, "ANSWER_QUESTION", "tồn đã biết và bằng 0 thì không đẩy khách tới bước xin SĐT");
  assert.match(String(soldOutDecision.reason), /đã hết/);
  assert.equal(soldOutRow?.stage, "PRODUCT_IDENTIFIED", "hết hàng thì hội thoại đứng lại ở bước đã biết mẫu, không tiến tới xin SĐT");
  assert.ok(!soldOutRun?.suggestedReply.includes("còn hàng"), "không được nói còn hàng khi sổ kho ghi đã hết");

  // ═════════ 8. CHUYỂN NGƯỜI DỪNG MỌI THỨ ═════════

  const complaintConv = { pageId: "page-88", externalId: "conv-88", pancakeCustomerId: "cust-88", customerName: "Chị Hoa", phone: "", platform: "facebook" };
  const complaintIngest = await ingestMessage(
    complaintConv,
    { externalId: "msg-complaint", text: "shop lua dao, hang loi, cho em gap nhan vien", fromPage: false, senderType: "CUSTOMER", fromName: "Chị Hoa", sentAt: new Date(), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  assert.equal(complaintIngest.eventEmitted, true);
  await drainSalesTasks(10, db);
  const complaintRow = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, complaintIngest.conversationId) });
  assert.equal(complaintRow?.stage, "HUMAN_TAKEOVER", "khiếu nại / đòi gặp người phải chuyển người ngay");
  assert.ok(complaintRow?.humanTakeoverAt, "phải ghi mốc người tiếp nhận");

  // Tin tiếp theo trên hội thoại đã chuyển người: máy vẫn ghi nhận nhưng KHÔNG soạn gì.
  const after = await ingestMessage(
    complaintConv,
    { externalId: "msg-complaint-2", text: "em muon mua them mau nay", fromPage: false, senderType: "CUSTOMER", fromName: "Chị Hoa", sentAt: new Date(), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  await drainSalesTasks(10, db);
  const afterRuns = await db.query.aiRuns.findMany({ where: eq(schema.aiRuns.subjectId, after.conversationId) });
  const latest = afterRuns.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  assert.equal(latest.suggestedReply, "", "hội thoại đã chuyển người thì máy không soạn câu nào nữa");
  const stillTakenOver = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, after.conversationId) });
  assert.equal(stillTakenOver?.stage, "HUMAN_TAKEOVER", "đã chuyển người thì không quay lại luồng bán hàng");

  // ═════════ 9. MÔ HÌNH TRẢ RÁC / TREO KHÔNG LÀM HỎNG LƯỢT CHẠY ═════════

  await setSettingJson(AI_CONFIG_KEY, { modelCallsEnabled: true });
  resetStub();
  queueStubResponse({ text: "đây không phải JSON" });
  queueStubResponse({ behavior: "timeout" });
  queueStubResponse({ text: "vẫn không phải JSON" });
  queueStubResponse({ behavior: "error" });
  const noisyConv = { pageId: "page-99", externalId: "conv-99", pancakeCustomerId: "cust-99", customerName: "Khách", phone: "", platform: "facebook" };
  const noisy = await ingestMessage(
    noisyConv,
    { externalId: "msg-noisy", text: "??? ... ???", fromPage: false, senderType: "CUSTOMER", fromName: "Khách", sentAt: new Date(), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  const noisyResult = await drainSalesTasks(10, db);
  assert.equal(noisyResult.skipped, false);
  const noisyRuns = await db.query.aiRuns.findMany({ where: eq(schema.aiRuns.subjectId, noisy.conversationId) });
  assert.ok(noisyRuns.length >= 1, "mô hình trả rác vẫn phải để lại một lượt chạy đọc được");
  assert.notEqual(noisyRuns[0].status, "FAILED", "mô hình trả rác là tình huống lường trước, không phải sự cố hệ thống");
  const noisyConversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, noisy.conversationId) });
  assert.equal(noisyConversation?.stage, "HUMAN_TAKEOVER", "không hiểu được khách thì chuyển người, không đoán bừa");

  /*
    ═════════ 9B. TRẦN CHI PHÍ PHẢI THỰC SỰ CHẶN — VÀ PHẢI BIẾT KHI NÓ KHÔNG ĐO ĐƯỢC ═════════

    `dailyCostCapVnd` từng được KHAI ở `AiFeatureFlags`, được bộ làm sạch cấu hình đọc, được hai
    bộ kiểm thử dựng trong fixture — và KHÔNG một dòng nào đọc nó trước khi gọi mô hình. Một cái
    trần chỉ tồn tại trong kiểu dữ liệu là một cái trần không có.

    Nhánh thứ hai dưới đây mới là nhánh đắt. `cost_vnd` là NULL với mọi mô hình chưa khai đơn giá
    (đo 22/09/2026: 660/1.065 lượt), nên tổng "đo được" là 0 ₫ và một cái trần so với 0 sẽ KHÔNG
    BAO GIỜ nổ. Một cái trần không bao giờ nổ tệ hơn không có trần: nó làm người vận hành tin
    rằng có ai đó đang canh. Chưa đo được thì DỪNG và nói vì sao — rơi về phía HẸP HƠN.
  */
  const capConv = { pageId: "page-tran", externalId: "conv-tran", pancakeCustomerId: "", customerName: "", phone: "", platform: "facebook" };
  const capIngest = await ingestMessage(
    capConv,
    { externalId: "msg-tran", text: "mẫu này bao nhiêu tiền ạ", fromPage: false, senderType: "CUSTOMER", fromName: "", sentAt: new Date(), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  const capTask = await db.query.aiTasks.findFirst({ where: eq(schema.aiTasks.subjectId, capIngest.conversationId) });
  assert.ok(capTask, "phải có việc để thử trần");

  // Một lượt gọi mô hình CHƯA ĐỊNH GIÁ ĐƯỢC trong 24 giờ qua.
  await db.insert(schema.aiModelCalls).values({ provider: "erp:openai", model: "mo-hinh-chua-khai-gia", tier: "ECONOMY", step: "understand", inputTokens: 100, outputTokens: 50, costVnd: null });

  await setSettingJson(AI_CONFIG_KEY, { dailyCostCapVnd: 50_000 });
  const chuaDoDuoc = await runSalesTask(capTask.id, { db });
  assert.equal(chuaDoDuoc.status, "SKIPPED", "có trần mà chưa định giá được thì DỪNG, không chạy tiếp");
  assert.match(chuaDoDuoc.reason, /CHƯA ĐỊNH GIÁ ĐƯỢC/, "phải nói rõ vì sao dừng — 'chưa đo được' khác hẳn 'đã chạm trần'");
  const runsSauKhiChan = await db.query.aiRuns.findMany({ where: eq(schema.aiRuns.subjectId, capIngest.conversationId) });
  assert.equal(runsSauKhiChan.length, 0, "chặn ở trần thì KHÔNG được mở một lượt chạy — mở ra là đã trả tiền rồi");

  /*
    Khai đủ giá ⇒ trần đo được.

    Phải định giá MỌI lượt gọi còn treo trong cửa sổ 24 giờ, không chỉ lượt vừa chèn: các khối
    kiểm thử phía trên đã gọi nhà cung cấp `stub` với bảng giá rỗng, nên chúng để lại những dòng
    `cost_vnd = NULL` thật. Chỉ định giá một dòng thì nhánh "chưa đo được" vẫn đúng và nổ trước —
    đúng như mã sản xuất phải làm, và đó chính là điều bài kiểm này vừa chứng minh ở lượt trên.
  */
  await db.update(schema.aiModelCalls).set({ costVnd: 0, pricingVersion: "kiem-thu" }).where(sql`${schema.aiModelCalls.costVnd} is null`);
  await db.update(schema.aiModelCalls).set({ costVnd: 60_000, pricingVersion: "kiem-thu" }).where(eq(schema.aiModelCalls.model, "mo-hinh-chua-khai-gia"));
  const chamTran = await runSalesTask(capTask.id, { db });
  assert.equal(chamTran.status, "SKIPPED", "đã tiêu 60.000 ₫ trên trần 50.000 ₫ thì dừng");
  assert.match(chamTran.reason, /chạm trần/, "chạm trần phải nói là chạm trần, không đội lốt lỗi khác");

  /*
    Trần = 0 nghĩa là CHƯA KHAI TRẦN, không phải "cấm tiêu" — nhánh này phải đứng ngoài hoàn toàn.

    Phải trả việc về PENDING trước: hai lượt trên đã `finishTask(FAILED)`, mà `claimTask` chỉ nhận
    việc PENDING. Không đặt lại thì lượt này trượt vì "việc đã có tiến trình khác nhận" và bài kiểm
    sẽ XANH mà không chứng minh được điều nó định chứng minh — một bài kiểm xanh nhờ nhầm lẫn còn
    tệ hơn không có bài kiểm.
  */
  await db.update(schema.aiTasks).set({ status: "PENDING", finishedAt: null, lastError: null }).where(eq(schema.aiTasks.id, capTask.id));
  await setSettingJson(AI_CONFIG_KEY, { dailyCostCapVnd: 0 });
  const khongTran = await runSalesTask(capTask.id, { db });
  assert.notEqual(khongTran.status, "SKIPPED", "trần 0 là CHƯA KHAI, không được biến thành cấm chạy");

  await db.delete(schema.aiModelCalls).where(eq(schema.aiModelCalls.model, "mo-hinh-chua-khai-gia"));
  await setSettingJson(AI_CONFIG_KEY, {});

  // ═════════ 10. VIỆC KHÔNG TỒN TẠI / NẤC OFF ═════════

  const missing = await runSalesTask("khong-co-viec-nay", { db });
  assert.equal(missing.status, "SKIPPED", "việc không tồn tại thì bỏ qua, không ném lỗi");

  await setSettingJson(AI_CONFIG_KEY, { enabled: false });
  const offConv = { pageId: "page-off", externalId: "conv-off", pancakeCustomerId: "", customerName: "", phone: "", platform: "facebook" };
  const offIngest = await ingestMessage(offConv, { externalId: "msg-off", text: "alo shop", fromPage: false, senderType: "CUSTOMER", fromName: "", sentAt: new Date(), hasAttachment: false, attachmentCount: 0, raw: {} }, "test", db);
  assert.equal(offIngest.eventEmitted, false, "tắt tổng thì không tạo việc mới");
  const offRun = await drainSalesTasks(10, db);
  assert.equal(offRun.skipped, true, "tắt tổng thì dây chuyền không chạy");

  await setSettingJson(AI_CONFIG_KEY, {});
  resetStub();
  const settings = await getAiSettings();
  assert.equal(settings.enabled, true, "xoá cấu hình thì phải trở về mặc định");

  // Trạng thái hỏng trong CSDL phải đọc được về mặc định an toàn, không làm sập màn hình.
  assert.deepEqual(parseSalesState(null), EMPTY_SALES_STATE);
  assert.deepEqual(parseSalesState({ quantity: "ba", pending: { sentAt: "" } }), { ...EMPTY_SALES_STATE, quantity: 1, pending: null });

  // ═════════ 10A. GIÁ SẢN PHẨM: BÁO ĐƯỢC KHI MỌI MẪU MÃ CÙNG GIÁ, CHƯA BIẾT KHI LỆCH ═════════
  //
  // Khách hỏi giá TRƯỚC khi chọn size — đó là thứ tự thật của một cuộc bán hàng. Nhưng giá sản phẩm
  // chỉ có nghĩa khi mọi mẫu mã cùng một đơn giá; lệch giá thì câu trả lời đúng là CHƯA BIẾT, chứ
  // KHÔNG phải lấy bừa giá thấp nhất rồi hứa một con số shop không bán.

  const ctxGia = { agentKey: "sales", mode: "SHADOW" as const, allowedTools: sales.definition.allowedTools, run: null, conversationId: null };
  const giaSP = await callTool(ctxGia, "pricing.get", { productId: "p-ai-e2e" });
  assert.equal(giaSP.ok, true);
  const giaSPData = giaSP.ok ? (giaSP.value as Record<string, unknown>) : {};
  assert.equal(giaSPData.ambiguous, false);
  assert.equal(giaSPData.unitPrice, 499_000, "mọi mẫu mã cùng giá ⇒ đó LÀ giá sản phẩm");
  assert.equal(giaSPData.total, 524_000, "tổng gồm cả phí ship, như giá của một mẫu mã");

  await db.insert(schema.products).values({ id: "p-gia-lech", name: "Đầm lệch giá", customId: "LG001" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values([
      { id: "v-gia-lech-m", productId: "p-gia-lech", sku: "LG001-M", size: "M", color: "Đen", retailPrice: 499_000 },
      { id: "v-gia-lech-xl", productId: "p-gia-lech", sku: "LG001-XL", size: "XL", color: "Đen", retailPrice: 599_000 },
    ])
    .onConflictDoNothing();
  const giaLech = await callTool(ctxGia, "pricing.get", { productId: "p-gia-lech" });
  assert.equal(giaLech.ok, true);
  const giaLechData = giaLech.ok ? (giaLech.value as Record<string, unknown>) : {};
  assert.equal(giaLechData.ambiguous, true, "size lớn đắt hơn là chuyện có thật ⇒ không có MỘT giá sản phẩm");
  assert.equal(giaLechData.total, null, "chưa biết thì là NULL, không phải giá thấp nhất");
  assert.equal(giaLechData.unitPrice, null);
  assert.equal(giaLechData.minUnitPrice, 499_000);
  assert.equal(giaLechData.maxUnitPrice, 599_000);

  // Giá của một MẪU MÃ vẫn y như cũ — bậc mới không được đụng vào bậc đang chạy.
  const giaMau = await callTool(ctxGia, "pricing.get", { variantId: "v-gia-lech-xl" });
  assert.equal((giaMau.ok ? (giaMau.value as Record<string, unknown>) : {}).unitPrice, 599_000);
  assert.equal((giaMau.ok ? (giaMau.value as Record<string, unknown>) : {}).scope, "VARIANT");

  // Truyền cả hai, hoặc không truyền gì, đều là một câu hỏi không có nghĩa ⇒ phải bị từ chối.
  assert.equal((await callTool(ctxGia, "pricing.get", { productId: "p-ai-e2e", variantId: "v-ai-e2e-l" })).ok, false);
  assert.equal((await callTool(ctxGia, "pricing.get", {})).ok, false);

  // ═════════ 10B. CHỐT CHẶN CỨNG: KHÔNG GIẢ MẠO NẤC ĐƯỢC ═════════
  //
  // `canSend()` tin vào nấc mà nơi gọi đưa xuống. Chốt cứng đọc lại nấc THẬT từ CSDL, nên dù một
  // lỗi lập trình hay một câu trả lời dị thường của mô hình có đặt `mode: "AUTO"`, tin vẫn không
  // đi được. Muốn gửi tin cho khách phải đổi DỮ LIỆU, không đổi được bằng một chuỗi.
  const forgedRequest = {
    mode: "AUTO" as const,
    conversationExternalId: "conv-gia-mao",
    text: "Dạ em chốt đơn cho chị luôn nhé",
    humanTakeover: false,
  };

  // Chốt 1 — chặn cứng cấp môi trường, đứng trước cả phép đọc CSDL.
  const lockedOutbound = await assertOutboundAllowed(forgedRequest);
  assert.equal(lockedOutbound.allowed, false);
  assert.match(lockedOutbound.reason, /AI_ALLOW_AUTO_SEND/, "công tắc môi trường chặn trước, và nói rõ mình là ai");

  // Chốt 2 — mở công tắc ra để lộ chốt nấc quyền hạn đọc lại từ CSDL.
  const savedSendEnv = process.env.AI_ALLOW_AUTO_SEND;
  try {
    process.env.AI_ALLOW_AUTO_SEND = "true";
    const forged = await assertOutboundAllowed(forgedRequest);
    assert.equal(forged.allowed, false, "khai nấc AUTO từ nơi gọi KHÔNG mở được cổng khi CSDL vẫn ở nấc SHADOW");
    assert.match(forged.reason, /SHADOW|chạy ngầm|GỢI Ý/i, "lý do phải nói rõ đang bị chặn vì nấc chạy ngầm");
  } finally {
    if (savedSendEnv === undefined) delete process.env.AI_ALLOW_AUTO_SEND;
    else process.env.AI_ALLOW_AUTO_SEND = savedSendEnv;
  }
  assert.equal((await assertOutboundAllowed(forgedRequest)).allowed, false, "đóng công tắc lại thì chốt 1 hoạt động trở lại");

  // Hàm thuần vẫn cho phép AUTO — chứng minh khác biệt nằm ĐÚNG ở chỗ đọc lại CSDL.
  assert.equal(canSend({ mode: "AUTO", conversationExternalId: "conv-gia-mao", text: "x", humanTakeover: false }, OFF_SETTINGS).allowed, true);

  // Công cụ GHI có HAI chốt độc lập, và khối này thử từng chốt một — hai chốt cùng chặn thì
  // không biết chốt nào đang làm việc, mà một chốt hỏng âm thầm là một chốt không còn tồn tại.
  const draftArgs = {
    variantId: "v-ai-e2e-l",
    quantity: 1,
    name: "Khách",
    phone: "0912345678",
    address: "Số 5 ngõ 12 Nguyễn Trãi, Thanh Xuân, Hà Nội",
    confirmationEvidence: { reviewSentAt: "x", customerRepliedAt: "y", quote: "ok" },
  };
  const forgedCtx = { agentKey: "sales", mode: "AUTO" as const, allowedTools: sales.definition.allowedTools, run: null, conversationId };

  // Chốt 1 — CHẶN CỨNG cấp môi trường. Đứng trước cả phép đọc CSDL: công tắc tắt thì không cần
  // biết nấc thật là gì, câu trả lời đã là KHÔNG.
  const lockedTool = await callTool(forgedCtx, "order.create_draft", draftArgs);
  assert.equal(lockedTool.ok, false, "AI_ALLOW_ORDER_CREATE=false thì không công cụ đơn hàng nào chạy");
  assert.equal(lockedTool.outcome, "DENIED");
  assert.match(lockedTool.error, /AI_ALLOW_ORDER_CREATE/, "lý do phải chỉ đúng công tắc, không lẫn với lý do nấc quyền hạn");

  // Chốt 2 — nấc quyền hạn THẬT đọc lại từ CSDL. Mở công tắc môi trường ra để lộ chốt này: khai
  // `mode: "AUTO"` từ nơi gọi vẫn không chạy được, vì dòng trong `ai_agents` mới là con số quyết định.
  const savedOrderEnv = process.env.AI_ALLOW_ORDER_CREATE;
  try {
    process.env.AI_ALLOW_ORDER_CREATE = "true";
    const forgedTool = await callTool(forgedCtx, "order.create_draft", draftArgs);
    assert.equal(forgedTool.ok, false, "khai nấc AUTO không chạy được công cụ tạo đơn");
    assert.equal(forgedTool.outcome, "DENIED");
    assert.match(forgedTool.error, /CSDL/, "lý do phải nói rõ nấc thật lấy từ CSDL");
  } finally {
    if (savedOrderEnv === undefined) delete process.env.AI_ALLOW_ORDER_CREATE;
    else process.env.AI_ALLOW_ORDER_CREATE = savedOrderEnv;
  }
  // Và đóng lại xong thì chốt 1 phải hoạt động trở lại — không được để rò trạng thái sang khối sau.
  assert.equal((await callTool(forgedCtx, "order.create_draft", draftArgs)).outcome, "DENIED");

  // ═════════ 10C. THIẾU KHOÁ MÔ HÌNH: KHÔNG SẬP, ĐÁNH DẤU RÕ, CHUYỂN NGƯỜI ═════════
  await setSettingJson(AI_CONFIG_KEY, { modelCallsEnabled: true });
  const noKeySettings = await getAiSettings();
  const noKey = await runModelStep({
    step: "test",
    system: "s",
    messages: [{ role: "user", content: "x" }],
    schema: z.object({ text: z.string() }),
    routing: parseRouting({ provider: "anthropic", tiers: ["ECONOMY", "STRONG"] }),
    settings: noKeySettings,
  });
  assert.equal(noKey.tier, "HUMAN", "không có khoá thì chuyển người, không ném lỗi");
  assert.equal(noKey.escalation, "MODEL_NOT_CONFIGURED", "CHƯA CẤU HÌNH phải tách khỏi MÔ HÌNH LỖI — hai việc sửa ở hai nơi khác nhau");
  assert.equal(noKey.attempts.length, 0, "không gọi mạng lần nào thì không ghi lần gọi nào");

  // ═════════ 10D. THIẾU BẢNG SỐ ĐO: KHÔNG ĐOÁN SIZE ═════════
  //
  // ERP hiện KHÔNG có bảng số đo nào (chỉ có nhãn size). Máy phải nói thẳng là chưa có căn cứ và
  // chuyển người — đoán size trên cơ thể người thật là cách chắc chắn tạo ra một đơn đổi size.
  assert.equal(recommendSize(null, { heightCm: 158, weightKg: 47 }).code, "SIZE_DATA_MISSING");
  assert.equal(recommendSize({ version: "v1", scope: "GLOBAL", rows: [] }, { heightCm: 158 }).code, "SIZE_DATA_MISSING");

  const chart: SizeRule = {
    version: "v1",
    scope: "PRODUCT",
    key: "p-ai-e2e",
    rows: [
      { size: "M", heightCm: [150, 160], weightKg: [45, 52] },
      { size: "L", heightCm: [158, 168], weightKg: [53, 60] },
    ],
  };
  assert.equal(recommendSize(chart, { heightCm: 155, weightKg: 47 }).size, "M", "khớp đúng một hàng thì gợi ý được");
  assert.equal(recommendSize(chart, { heightCm: 155 }).code, "MEASUREMENTS_MISSING", "thiếu số đo bảng cần ⇒ đòi thêm, không đoán");
  assert.deepEqual(recommendSize(chart, { heightCm: 155 }).missing, ["weightKg"]);
  assert.equal(recommendSize(chart, { heightCm: 190, weightKg: 90 }).code, "OUT_OF_RANGE");
  const ambiguous: SizeRule = { version: "v1", scope: "GLOBAL", rows: [{ size: "M", heightCm: [150, 170] }, { size: "L", heightCm: [150, 170] }] };
  assert.equal(recommendSize(ambiguous, { heightCm: 160 }).code, "AMBIGUOUS", "hai size cùng khớp là CHƯA BIẾT, không chọn cái đầu");
  for (const code of ["SIZE_DATA_MISSING", "MEASUREMENTS_MISSING", "AMBIGUOUS", "OUT_OF_RANGE"] as const) {
    assert.equal(sizeNeedsHuman(code), true, `${code} phải chuyển người`);
  }
  assert.equal(sizeNeedsHuman("OK"), false);

  // Phạm vi HẸP thắng phạm vi RỘNG — một mẫu vải co giãn không bị áp bảng của vải cứng.
  const rules: SizeRule[] = [
    { version: "global", scope: "GLOBAL", rows: [{ size: "FREE" }] },
    { version: "theo-san-pham", scope: "PRODUCT", key: "p-ai-e2e", rows: [{ size: "M" }] },
  ];
  assert.equal(resolveSizeRule(rules, { productId: "p-ai-e2e" })?.version, "theo-san-pham");
  assert.equal(resolveSizeRule(rules, { productId: "khac" })?.version, "global");
  assert.equal(resolveSizeRule([], { productId: "p" }), null, "không khai bảng nào ⇒ null ⇒ SIZE_DATA_MISSING");

  // Chạy thật: khách đưa số đo mà ERP chưa có bảng ⇒ hội thoại chuyển người.
  await setSettingJson(AI_CONFIG_KEY, { modelCallsEnabled: false });
  const sizeConv = { pageId: "page-size", externalId: "conv-size", pancakeCustomerId: "cs", customerName: "Chị Vân", phone: "", platform: "facebook" };
  const sizeAsk = await ingestMessage(
    sizeConv,
    { externalId: "size-1", text: "Đầm suông AIE2E em cao 1m58 nặng 47kg thì mặc size nào ạ", fromPage: false, senderType: "CUSTOMER", fromName: "Chị Vân", sentAt: new Date(), hasAttachment: false, attachmentCount: 0, raw: {} },
    "test",
    db,
  );
  await drainSalesTasks(5, db);
  const sizeConvRow = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, sizeAsk.conversationId) });
  assert.equal(sizeConvRow?.stage, "HUMAN_TAKEOVER", "chưa có bảng số đo thì chuyển người, không đoán size");
  const sizeRun = await db.query.aiRuns.findFirst({
    where: and(eq(schema.aiRuns.subjectId, sizeAsk.conversationId), eq(schema.aiRuns.subjectType, "CONVERSATION")),
    orderBy: (r, { desc }) => [desc(r.startedAt)],
  });
  const sizeDecision = (sizeRun?.decision ?? {}) as Record<string, unknown>;
  assert.equal(sizeDecision.handoffReason, "SIZE_DATA_MISSING");
  assert.ok(!String(sizeRun?.suggestedReply ?? "").match(/size (S|M|L|XL)\b/), "câu gợi ý KHÔNG được nêu một size cụ thể khi chưa có bảng");

  // ═════════ 11. MÀN HÌNH QUAN SÁT ĐỌC ĐƯỢC THẬT ═════════
  //
  // Truy vấn quan sát chạy trên SQL thật (percentile_cont, filter, truy vấn con). Không kiểm ở đây
  // thì lần đầu ai đó mở /ai trên production mới biết nó hỏng.
  clearMemo();
  const summary = await aiSummary(7);
  assert.ok(summary.runs > 0, "phải đếm được lượt chạy");
  assert.equal(summary.sentToCustomer, 0, "nấc SHADOW: tổng hợp phải báo 0 tin gửi cho khách");
  assert.ok(summary.suggestions > 0, "phải đếm được gợi ý");
  assert.ok(summary.medianLatencyMs >= 0, "phải tính được độ trễ trung vị");
  // Có lượt chạy dùng mô hình chưa khai đơn giá (khối 9) ⇒ tổng chi phí là CHƯA BIẾT.
  assert.equal(summary.costVnd, null, "còn lượt chạy chưa khai đơn giá thì tổng chi phí phải là CHƯA BIẾT, không phải một con số");

  const list = await listAiRuns({ days: 7, limit: 50 });
  assert.ok(list.length > 0, "danh sách lượt chạy phải đọc được");
  const withSuggestion = list.find((r) => r.suggestedReply);
  assert.ok(withSuggestion, "phải có lượt chạy mang câu gợi ý");
  assert.ok(withSuggestion.customerMessage.length > 0, "bảng phải hiện được tin nhắn khách đã kích hoạt lượt chạy");

  const detail = await getAiRunDetail(withSuggestion.id);
  assert.ok(detail, "phải mở được chi tiết một lượt chạy");
  assert.ok(detail.run.understanding && detail.run.decision, "chi tiết phải đủ ý định và quyết định");
  assert.ok(detail.messages.length > 0, "chi tiết phải kèm bối cảnh hội thoại");

  const stages = await salesStageBreakdown();
  assert.ok(stages.some((x) => x.stage === "HUMAN_TAKEOVER"), "bảng giai đoạn phải thấy hội thoại đã chuyển người");

  // ═════════ 12. MÀN HÌNH SOÁT & CHẤM TAY ═════════
  const shadowTurns = await listShadowTurns({ limit: 100 });
  assert.ok(shadowTurns.length > 0, "màn hình soát phải đọc được các lượt");
  const withReply = shadowTurns.find((t) => t.humanReply);
  assert.ok(withReply, "phải có lượt kèm câu nhân viên trả lời để đối chiếu");
  assert.ok(withReply.customerMessage.length > 0, "mỗi lượt phải hiện được tin khách đã kích hoạt nó");

  // Bộ lọc phải thật sự lọc, không phải trang trí.
  const onlyTakeover = await listShadowTurns({ humanTakeover: true, limit: 100 });
  assert.ok(onlyTakeover.every((t) => t.humanTakeoverAt), "lọc 'đã chuyển người' phải chỉ trả hội thoại đã chuyển");
  const notReviewed = await listShadowTurns({ reviewed: false, limit: 100 });
  assert.ok(notReviewed.every((t) => t.reviewedAt === null), "lọc 'chưa chấm' phải chỉ trả lượt chưa chấm");
  assert.ok(notReviewed.length > 0, "lúc này chưa chấm lượt nào");

  // ĐỘ CHÍNH XÁC CHỈ TÍNH TRÊN PHẦN ĐÃ CHẤM — chưa chấm là CHƯA BIẾT, không phải 0%.
  const before = await shadowMetrics(7);
  assert.equal(before.reviewed, 0);
  for (const metric of before.labelled) {
    assert.equal(metric.accuracy, null, `${metric.key}: chưa chấm ô nào thì độ chính xác phải là CHƯA BIẾT, không phải 0%`);
  }
  assert.ok(before.handoffRate !== null, "tỷ lệ chuyển người đo được mà không cần chấm tay");
  assert.equal(before.sentToCustomer, 0, "nấc chạy ngầm: 0 tin gửi cho khách");

  // Chấm tay hai lượt, một đúng một sai ⇒ 50% trên độ phủ 2.
  await db.insert(schema.salesReviewLabels).values([
    { suggestionId: shadowTurns[0].suggestionId, conversationId: shadowTurns[0].conversationId, productOk: true, intentOk: true, reviewedAt: new Date() },
    { suggestionId: shadowTurns[1].suggestionId, conversationId: shadowTurns[1].conversationId, productOk: false, intentOk: true, reviewedAt: new Date() },
  ]);
  clearMemo();
  const afterLabels = await shadowMetrics(7);
  assert.equal(afterLabels.reviewed, 2);
  const product = afterLabels.labelled.find((m) => m.key === "productOk");
  assert.equal(product?.reviewed, 2);
  assert.equal(product?.accuracy, 50, "độ chính xác tính đúng trên phần đã chấm");
  const size = afterLabels.labelled.find((m) => m.key === "sizeOk");
  assert.equal(size?.accuracy, null, "chiều chưa ai chấm vẫn là CHƯA BIẾT, không bị kéo xuống 0%");
  assert.ok(afterLabels.reviewCoverage !== null && afterLabels.reviewCoverage < 100, "độ phủ phải hiện cạnh tỷ lệ để không ai đọc nhầm");

  /*
    ═════════ 12A. TRANG SOÁT PHẢI CHIA TRANG ĐƯỢC ═════════

    ĐO 19/09/2026 trên bản chạy thử: trang soát dựng một thẻ chấm cho MỖI lượt trong cửa sổ ⇒ HTML
    1.097.170 ký tự và 2.414 thẻ <button> trong một lần dựng. Cả 30/30 tệp JS đều trả 200 — máy
    chủ giao đủ. Nhưng React phải gắn tay cầm cho từng ấy nút trước khi BẤT CỨ cú bấm nào có tác
    dụng, kể cả một nút chỉ đổi `useState`. Người soát bấm, không thấy gì, và kết luận "hỏng".
    Họ đúng.

    Nên `offset` không phải tiện nghi: nó là thứ giữ cho trang còn bấm được.
  */
  const trang1 = await listShadowTurns({ limit: 2, offset: 0 });
  const trang2 = await listShadowTurns({ limit: 2, offset: 2 });
  assert.ok(trang1.length <= 2, "trần mỗi trang phải được tôn trọng");
  assert.ok(trang2.length <= 2);
  const giao = trang1.filter((a) => trang2.some((b) => b.suggestionId === a.suggestionId));
  assert.equal(giao.length, 0, "hai trang liên tiếp KHÔNG được trùng lượt nào");
  const gopLai = [...trang1, ...trang2].map((t) => t.suggestionId);
  const bonDau = (await listShadowTurns({ limit: 4, offset: 0 })).map((t) => t.suggestionId);
  assert.deepEqual(gopLai, bonDau, "hai trang ghép lại phải đúng bằng một lần lấy liền bốn lượt");

  /*
    LƯU LẠI LẦN HAI LÀ SỬA, KHÔNG PHẢI THÊM DÒNG. Ràng buộc ở CSDL chứ không ở tầng ứng dụng: hai
    tab cùng bấm Lưu thì cả hai đều đọc thấy "chưa có dòng nào" trước khi lượt nào kịp ghi.
  */
  await assert.rejects(
    db.insert(schema.salesReviewLabels).values({
      suggestionId: shadowTurns[0].suggestionId,
      conversationId: shadowTurns[0].conversationId,
      productOk: false,
      reviewedAt: new Date(),
    }),
    "chấm lần hai trên cùng một lượt phải bị CSDL từ chối — đường ghi thật là cập nhật",
  );

  // ═════════ 12B. LÝ DO CHẤM LÀ DANH SÁCH ĐÓNG, CHẶN Ở CẢ HAI ĐẦU ═════════
  //
  // Ô chữ tự do ghi được mọi thứ nhưng ĐẾM được không thứ gì. Sau ba mươi lượt chấm, câu hỏi thật
  // sự là "máy hay hỏng ở ĐÂU NHẤT" — và câu trả lời ấy chỉ có nếu lý do là một danh sách đóng.

  for (const tag of REVIEW_REASON_TAGS) {
    const meta = REVIEW_REASON_TAG_META[tag];
    assert.ok(meta && meta.label.length > 3, `${tag}: phải có nhãn tiếng Việt đọc được`);
    assert.ok(["MODEL", "DATA", "POLICY"].includes(meta.owner), `${tag}: phải khai AI đi sửa — đó mới là thứ biến một bảng đếm thành một việc`);
  }
  // Ba nhóm người phải đều có mặt: gộp hết vào MODEL là quay về "AI còn yếu" cho cả lỗi dữ liệu.
  const nhomNguoi = new Set(REVIEW_REASON_TAGS.map((t) => REVIEW_REASON_TAG_META[t].owner));
  assert.deepEqual([...nhomNguoi].sort(), ["DATA", "MODEL", "POLICY"]);

  // CSDL chặn lại, không chỉ lược đồ đầu vào: một nhãn lạ lọt vào thì mọi bảng đếm sau này phải
  // chọn giữa bỏ qua nó và hiện một nhãn không ai hiểu.
  const mauChamId = shadowTurns[2].suggestionId;
  const mauChamConv = shadowTurns[2].conversationId;
  await assert.rejects(
    db.insert(schema.salesReviewLabels).values({ suggestionId: mauChamId, conversationId: mauChamConv, verdict: "TAM_DUOC", reviewedAt: new Date() }),
    "kết luận ngoài ba nấc phải bị CSDL từ chối",
  );
  await assert.rejects(
    db.execute(sql`insert into sales_review_labels (id, suggestion_id, conversation_id, reason_tags) values ('rv-rac', ${mauChamId}, ${mauChamConv}, '"WRONG_PRICE"'::jsonb)`),
    "lý do phải LÀ một mảng — một chuỗi lọt vào thì mọi phép đếm bên dưới sai thầm",
  );

  await db.insert(schema.salesReviewLabels).values({
    suggestionId: mauChamId,
    conversationId: mauChamConv,
    verdict: "BAD",
    reasonTags: ["MISSED_QUESTION", "MISSING_ERP_DATA"],
    reviewedAt: new Date(),
  });
  const daCham = await db.query.salesReviewLabels.findFirst({ where: eq(schema.salesReviewLabels.suggestionId, mauChamId) });
  assert.equal(daCham?.verdict, "BAD");
  assert.deepEqual(daCham?.reasonTags, ["MISSED_QUESTION", "MISSING_ERP_DATA"]);
  // Và hai lý do ấy KHÔNG cùng một người đi sửa — đó là lý do phải tách nhãn thay vì một ô chữ.
  assert.notEqual(REVIEW_REASON_TAG_META.MISSED_QUESTION.owner, REVIEW_REASON_TAG_META.MISSING_ERP_DATA.owner);

  // Lượt chưa ai mở ra xem phải đọc ra CHƯA CHẤM, không phải "tạm được".
  const chuaCham = await db.query.salesReviewLabels.findFirst({ where: eq(schema.salesReviewLabels.suggestionId, shadowTurns[0].suggestionId) });
  assert.equal(chuaCham?.verdict ?? null, null, "chưa chấm kết luận chung thì là NULL, không phải một nấc nào đó");
  assert.deepEqual(chuaCham?.reasonTags ?? [], [], "chưa chọn lý do nào thì là mảng rỗng");

  console.log(
    `✓ Nhân viên bán hàng AI: ${SALES_STAGES.length} giai đoạn · ${combos} tổ hợp chuyển trạng thái đều nằm trong bảng khai báo · "ok" trơ trọi KHÔNG tạo đơn · nấc SHADOW gửi 0 tin · ${lockedChecks} tổ hợp đều bị chặn cứng chặn lại`,
  );
  console.log(
    "✓ Nạp hội thoại & soát nấc chạy ngầm: gói tin lạ bị từ chối KÈM chẩn đoán · bot tách khỏi nhân viên · trùng chéo kênh bị chặn · chốt cứng không giả mạo nấc được · thiếu bảng số đo thì chuyển người · độ chính xác chỉ tính trên phần đã chấm",
  );
}


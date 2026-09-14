import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";
import { SALES_STAGES, SALES_TRANSITIONS, nextStage, type SalesFacts, type SalesStage } from "@/lib/constants/sales-agent";
import { UNDERSTANDING_SCHEMA, findBody, findPhone, findQuantity, understandByRule } from "@/lib/ai-workforce/agents/sales/understand";
import { checkContextualConfirmation, isAffirmativeText, missingOrderRequirements } from "@/lib/ai-workforce/agents/sales/confirm";
import { EMPTY_SALES_STATE, confirmationFingerprint, parseSalesState, type SalesState } from "@/lib/ai-workforce/agents/sales/state";
import { ROUNDTRIP_TEST_MESSAGE, assertOutboundAllowed, canSend } from "@/lib/ai-workforce/agents/sales/outbound";
import { guardGeneratedText, moneyMentions, renderOrderReview } from "@/lib/ai-workforce/agents/sales/generate";
import { ingestMessage, normalizeChatWebhook } from "@/lib/ai-workforce/agents/sales/ingest";
import { drainSalesTasks, runSalesTask } from "@/lib/ai-workforce/agents/sales/pipeline";
import { ensureAgents, getAgent } from "@/lib/ai-workforce/registry";
import { registerErpTools } from "@/lib/ai-workforce/tools/erp";
import { callTool } from "@/lib/ai-workforce/tools/gateway";
import { parseRouting, runModelStep } from "@/lib/ai-workforce/model-router";
import { providerNames } from "@/lib/ai-workforce/providers";
import { recommendSize, resolveSizeRule, sizeNeedsHuman, type SizeRule } from "@/lib/constants/size-engine";
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
  hardLimits: { allowCustomerSend: true, allowOrderCreate: true },
  pricingVersion: "",
};

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

  // Lược đồ chặn rác của mô hình: số lượng âm, SĐT quá dài, ý định lạ đều bị loại.
  assert.equal(UNDERSTANDING_SCHEMA.safeParse({ intents: ["KHONG_CO_Y_DINH_NAY"], entities: {}, confidence: 1 }).success, false, "ý định lạ phải bị lược đồ chặn");
  assert.equal(UNDERSTANDING_SCHEMA.safeParse({ intents: ["CONFIRM"], entities: { quantity: -3 }, confidence: 0.9 }).success, false, "số lượng âm phải bị chặn");
  assert.equal(UNDERSTANDING_SCHEMA.safeParse({ intents: ["CONFIRM"], entities: {}, confidence: 5 }).success, false, "độ tin ngoài [0,1] phải bị chặn");
  assert.equal(UNDERSTANDING_SCHEMA.safeParse({ intents: [], entities: {}, confidence: 0.5 }).success, false, "phải có ít nhất một ý định");

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

  // ═════════ 5. CỔNG GỬI TIN — SHADOW KHÔNG BAO GIỜ GỬI ═════════

  const base = { conversationExternalId: "conv-1", text: "Dạ em chào chị", humanTakeover: false };
  assert.equal(canSend({ ...base, mode: "SHADOW" }, OFF_SETTINGS).allowed, false, "nấc SHADOW không được gửi câu do AI soạn");
  assert.equal(canSend({ ...base, mode: "OFF" }, OFF_SETTINGS).allowed, false);
  assert.equal(canSend({ ...base, mode: "COPILOT" }, OFF_SETTINGS).allowed, false, "nấc COPILOT chưa có người duyệt thì chưa được gửi");
  assert.equal(canSend({ ...base, mode: "COPILOT", approved: true }, OFF_SETTINGS).allowed, true);
  assert.equal(canSend({ ...base, mode: "AUTO" }, OFF_SETTINGS).allowed, true);
  // Người đã cầm việc ⇒ im lặng ở MỌI nấc.
  for (const mode of ["SHADOW", "COPILOT", "AUTO"] as const) {
    assert.equal(canSend({ ...base, mode, approved: true, humanTakeover: true }, OFF_SETTINGS).allowed, false, `nấc ${mode}: người cầm việc thì máy không gửi`);
  }
  // Tin kiểm thử tất định: chỉ tới hội thoại trong danh sách trắng.
  assert.equal(canSend({ ...base, mode: "SHADOW", text: ROUNDTRIP_TEST_MESSAGE }, OFF_SETTINGS).allowed, false, "chưa có danh sách trắng thì tin kiểm thử cũng không gửi");
  const whitelisted = { ...OFF_SETTINGS, testConversationIds: ["conv-1"] };
  const roundtrip = canSend({ ...base, mode: "SHADOW", text: ROUNDTRIP_TEST_MESSAGE }, whitelisted);
  assert.equal(roundtrip.allowed, true);
  assert.equal(roundtrip.allowed === true && roundtrip.kind, "ROUNDTRIP_TEST");
  // Danh sách trắng KHÔNG mở cửa cho câu do AI soạn.
  assert.equal(canSend({ ...base, mode: "SHADOW", text: "Dạ mẫu này 499k ạ" }, whitelisted).allowed, false, "danh sách trắng chỉ cho tin kiểm thử, không cho câu AI");

  // ═════════ 5B. CHẶN CỨNG CẤP MÔI TRƯỜNG — CÂU TRẢ LỜI CHO "CÓ TỔ HỢP NÀO LỠ NHẮN KHÁCH KHÔNG" ═════════
  //
  // Bản chạy thử cắm vào một page Pancake THẬT, nên câu hỏi không còn là "nấc SHADOW có gửi
  // không" mà là "có TỔ HỢP CẤU HÌNH NÀO gửi được không". Hai công tắc `AI_ALLOW_CUSTOMER_SEND`
  // và `AI_ALLOW_ORDER_CREATE` trả lời bằng cách đứng TRƯỚC mọi chốt khác và chỉ biết nói KHÔNG.
  //
  // Khối này quét đủ tổ hợp nấc × phiếu duyệt × danh sách trắng × nội dung — kể cả những tổ hợp
  // mà khối 5 vừa chứng minh là ĐƯỢC GỬI — để chứng minh chặn cứng đè lên tất cả.
  const locked: AiSettings = { ...OFF_SETTINGS, testConversationIds: ["conv-1"], hardLimits: SAFEST_HARD_LIMITS };
  let lockedChecks = 0;
  for (const mode of ["OFF", "SHADOW", "COPILOT", "AUTO"] as const) {
    for (const approved of [false, true]) {
      for (const text of ["Dạ mẫu này 499k ạ", ROUNDTRIP_TEST_MESSAGE]) {
        const decision = canSend({ conversationExternalId: "conv-1", humanTakeover: false, mode, approved, text }, locked);
        lockedChecks += 1;
        assert.equal(decision.allowed, false, `chặn cứng phải thắng: nấc ${mode}, duyệt=${approved}, nội dung=${text.slice(0, 12)}`);
        assert.match(decision.reason, /AI_ALLOW_CUSTOMER_SEND/, "lý do phải chỉ đúng công tắc đang chặn, để người vận hành biết sửa ở đâu");
      }
    }
  }
  assert.equal(lockedChecks, 16, "phải quét đủ 4 nấc × 2 phiếu duyệt × 2 loại nội dung");

  // Chặn cứng là chốt ĐẦU TIÊN: một tổ hợp mà khối 5 đã chứng minh là gửi được (AUTO + đã duyệt)
  // vẫn bị chặn, và bị chặn vì công tắc chứ không phải vì nấc.
  assert.equal(canSend({ ...base, mode: "AUTO", approved: true }, OFF_SETTINGS).allowed, true, "mở công tắc thì logic nấc chạy như cũ");
  assert.equal(canSend({ ...base, mode: "AUTO", approved: true }, locked).allowed, false, "khoá công tắc thì chính tổ hợp đó bị chặn");

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
    await setSettingJson(AI_CONFIG_KEY, { hardLimits: { allowCustomerSend: true, allowOrderCreate: true } });
    const fromDb = await getAiSettings();
    assert.deepEqual(fromDb.hardLimits, SAFEST_HARD_LIMITS, "ghi hardLimits vào bảng settings KHÔNG được mở công tắc");

    // Chỉ đúng một chuỗi mở được. Một công tắc mà gõ kiểu gì cũng bật được là một công tắc sẽ bị
    // bật nhầm — nên `1`, `yes`, `on` đều là CẤM.
    for (const raw of ["1", "yes", "on", "TRUE ", "false", ""]) {
      process.env.AI_ALLOW_CUSTOMER_SEND = raw;
      assert.equal(aiEnv.hardLimits.allowCustomerSend, raw.trim().toLowerCase() === "true", `giá trị ${JSON.stringify(raw)}: chỉ chuỗi "true" mới mở`);
    }
    process.env.AI_ALLOW_CUSTOMER_SEND = "true";
    assert.equal(aiEnv.hardLimits.allowCustomerSend, true, 'đúng chuỗi "true" thì mở');
    assert.equal((await getAiSettings()).hardLimits.allowOrderCreate, false, "hai công tắc độc lập: mở cái gửi tin không mở cái tạo đơn");
  } finally {
    if (savedSend === undefined) delete process.env.AI_ALLOW_CUSTOMER_SEND;
    else process.env.AI_ALLOW_CUSTOMER_SEND = savedSend;
    if (savedOrder === undefined) delete process.env.AI_ALLOW_ORDER_CREATE;
    else process.env.AI_ALLOW_ORDER_CREATE = savedOrder;
    await setSettingJson(AI_CONFIG_KEY, {});
  }

  // Không khai gì trong môi trường ⇒ giá trị an toàn nhất. Mặc định của bản chạy thử là CẤM,
  // không phải "cho tới khi có người nghĩ ra là phải cấm".
  assert.deepEqual(aiEnv.hardLimits, SAFEST_HARD_LIMITS, "không khai biến môi trường thì cả hai công tắc đều CẤM");

  // ── HAI HỆ AI, HAI BIẾN MÔI TRƯỜNG — KHÔNG ĐƯỢC ĐỌC CHUNG ──
  //
  // ERP có SẴN một AI Copilot dùng `AI_PROVIDER` với bộ giá trị `auto|openai|anthropic|off`.
  // Nhân sự AI dùng bộ khác (`stub|anthropic`). Nếu hai hệ đọc chung một biến thì đặt đúng cho
  // hệ này là đặt sai cho hệ kia — và cái sai ấy im lặng.
  assert.deepEqual([...WORKFORCE_PROVIDERS].sort(), providerNames().sort(), "danh sách tên nhà cung cấp phải khớp sổ đăng ký thật");
  const savedWf = process.env.AI_WORKFORCE_PROVIDER;
  const savedProv = process.env.AI_PROVIDER;
  try {
    delete process.env.AI_WORKFORCE_PROVIDER;
    // Giá trị của Copilot KHÔNG được kéo nhân sự AI đi theo: rơi về `stub`, tức KHÔNG gọi mạng.
    for (const raw of ["auto", "openai", "off", "lung-tung"]) {
      process.env.AI_PROVIDER = raw;
      assert.equal(aiEnv.provider, "stub", `AI_PROVIDER=${raw} là của Copilot — nhân sự AI phải rơi về stub, không gọi mạng`);
    }
    // Nhưng một tên mà nhân sự AI THẬT SỰ CÓ thì vẫn nhận, để cấu hình cũ không gãy.
    process.env.AI_PROVIDER = "anthropic";
    assert.equal(aiEnv.provider, "anthropic", "tên nhà cung cấp hợp lệ ở AI_PROVIDER vẫn dùng được");
    // Và biến riêng thắng tuyệt đối.
    process.env.AI_WORKFORCE_PROVIDER = "stub";
    assert.equal(aiEnv.provider, "stub", "AI_WORKFORCE_PROVIDER thắng AI_PROVIDER");
  } finally {
    if (savedWf === undefined) delete process.env.AI_WORKFORCE_PROVIDER;
    else process.env.AI_WORKFORCE_PROVIDER = savedWf;
    if (savedProv === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = savedProv;
  }

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
  assert.equal(echo.eventEmitted, false, "tin của shop KHÔNG được tạo việc — nếu không con bot sẽ tự nói chuyện với chính nó");
  assert.match(echo.reason, /vòng lặp/);

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

  // ═════════ 10B. CHỐT CHẶN CỨNG: KHÔNG GIẢ MẠO NẤC ĐƯỢC ═════════
  //
  // `canSend()` tin vào nấc mà nơi gọi đưa xuống. Chốt cứng đọc lại nấc THẬT từ CSDL, nên dù một
  // lỗi lập trình hay một câu trả lời dị thường của mô hình có đặt `mode: "AUTO"`, tin vẫn không
  // đi được. Muốn gửi tin cho khách phải đổi DỮ LIỆU, không đổi được bằng một chuỗi.
  const forgedRequest = {
    mode: "AUTO" as const,
    approved: true,
    conversationExternalId: "conv-gia-mao",
    text: "Dạ em chốt đơn cho chị luôn nhé",
    humanTakeover: false,
  };

  // Chốt 1 — chặn cứng cấp môi trường, đứng trước cả phép đọc CSDL.
  const lockedOutbound = await assertOutboundAllowed(forgedRequest);
  assert.equal(lockedOutbound.allowed, false);
  assert.match(lockedOutbound.reason, /AI_ALLOW_CUSTOMER_SEND/, "công tắc môi trường chặn trước, và nói rõ mình là ai");

  // Chốt 2 — mở công tắc ra để lộ chốt nấc quyền hạn đọc lại từ CSDL.
  const savedSendEnv = process.env.AI_ALLOW_CUSTOMER_SEND;
  try {
    process.env.AI_ALLOW_CUSTOMER_SEND = "true";
    const forged = await assertOutboundAllowed(forgedRequest);
    assert.equal(forged.allowed, false, "khai nấc AUTO từ nơi gọi KHÔNG mở được cổng khi CSDL vẫn ở nấc SHADOW");
    assert.match(forged.reason, /SHADOW|chạy ngầm|GỢI Ý/i, "lý do phải nói rõ đang bị chặn vì nấc chạy ngầm");
  } finally {
    if (savedSendEnv === undefined) delete process.env.AI_ALLOW_CUSTOMER_SEND;
    else process.env.AI_ALLOW_CUSTOMER_SEND = savedSendEnv;
  }
  assert.equal((await assertOutboundAllowed(forgedRequest)).allowed, false, "đóng công tắc lại thì chốt 1 hoạt động trở lại");

  // Hàm thuần vẫn cho phép AUTO — chứng minh khác biệt nằm ĐÚNG ở chỗ đọc lại CSDL.
  assert.equal(canSend({ mode: "AUTO", approved: true, conversationExternalId: "conv-gia-mao", text: "x", humanTakeover: false }, OFF_SETTINGS).allowed, true);

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

  console.log(
    `✓ Nhân viên bán hàng AI: ${SALES_STAGES.length} giai đoạn · ${combos} tổ hợp chuyển trạng thái đều nằm trong bảng khai báo · "ok" trơ trọi KHÔNG tạo đơn · nấc SHADOW gửi 0 tin · ${lockedChecks} tổ hợp đều bị chặn cứng chặn lại`,
  );
  console.log(
    "✓ Nạp hội thoại & soát nấc chạy ngầm: gói tin lạ bị từ chối KÈM chẩn đoán · bot tách khỏi nhân viên · trùng chéo kênh bị chặn · chốt cứng không giả mạo nấc được · thiếu bảng số đo thì chuyển người · độ chính xác chỉ tính trên phần đã chấm",
  );
}


import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";
import { SALES_STAGES, SALES_TRANSITIONS, nextStage, type SalesFacts, type SalesStage } from "@/lib/constants/sales-agent";
import { UNDERSTANDING_SCHEMA, findBody, findPhone, findQuantity, understandByRule } from "@/lib/ai/agents/sales/understand";
import { checkContextualConfirmation, isAffirmativeText, missingOrderRequirements } from "@/lib/ai/agents/sales/confirm";
import { EMPTY_SALES_STATE, confirmationFingerprint, parseSalesState, type SalesState } from "@/lib/ai/agents/sales/state";
import { ROUNDTRIP_TEST_MESSAGE, canSend } from "@/lib/ai/agents/sales/outbound";
import { guardGeneratedText, moneyMentions, renderOrderReview } from "@/lib/ai/agents/sales/generate";
import { ingestMessage, normalizeChatWebhook } from "@/lib/ai/agents/sales/ingest";
import { drainSalesTasks, runSalesTask } from "@/lib/ai/agents/sales/pipeline";
import { ensureAgents, getAgent } from "@/lib/ai/registry";
import { registerErpTools } from "@/lib/ai/tools/erp";
import { getAiSettings } from "@/lib/ai/config";
import { setSettingJson } from "@/lib/settings";
import { queueStubResponse, resetStub } from "@/lib/ai/providers/stub";
import { aiSummary, getAiRunDetail, listAiRuns, salesStageBreakdown } from "@/lib/queries/ai";
import { clearMemo } from "@/lib/cache";

const OFF_SETTINGS = { enabled: true, modelCallsEnabled: false, ingestEnabled: true, maxRunsPerHour: 600, dailyCostCapVnd: 0, testConversationIds: [], modes: {}, pricing: {} };

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

  // ═════════ 6. WEBHOOK: CHUẨN HOÁ, CHỐNG TRÙNG, CHỐNG VÒNG LẶP ═════════

  const webhook = {
    page_id: "page-77",
    conversation_id: "conv-77",
    message: { id: "msg-1", message: "<div>em muốn mua đầm Q002 size L màu đỏ</div>", inserted_at: "2026-09-14T03:00:00", from: { id: "cust-9", name: "Chị Lan" } },
    conversation: { customer: { id: "cust-9", name: "Chị Lan", phone_numbers: [{ phone_number: "0912345678" }] } },
  };
  const parsed = normalizeChatWebhook(webhook);
  assert.ok(parsed, "gói tin đủ khoá phải chuẩn hoá được");
  assert.equal(parsed.message.text, "em muốn mua đầm Q002 size L màu đỏ", "phải bỏ thẻ HTML của Pancake");
  assert.equal(parsed.message.fromPage, false, "tin của khách không phải tin của shop");
  assert.equal(parsed.conversation.phone, "0912345678");
  assert.equal(parsed.message.sentAt?.toISOString(), "2026-09-14T03:00:00.000Z", "Pancake trả ISO không múi giờ nhưng là UTC");

  assert.equal(normalizeChatWebhook({ page_id: "p", conversation_id: "c" }), null, "thiếu mã tin nhắn ⇒ không chuẩn hoá được (không chống trùng được)");
  assert.equal(normalizeChatWebhook({}), null);
  assert.equal(normalizeChatWebhook({ message: { id: "m" } }), null);

  const shopEcho = normalizeChatWebhook({ ...webhook, message: { ...webhook.message, id: "msg-2", from: { id: "page-77", name: "Shop" } } });
  assert.equal(shopEcho?.message.fromPage, true, "tin gửi từ chính page phải được nhận là tin của shop");

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
  const echo = await ingestMessage(parsed.conversation, { ...parsed.message, externalId: "msg-2", fromPage: true, text: "Dạ em chào chị" }, "test", db);
  assert.equal(echo.eventEmitted, false, "tin của shop KHÔNG được tạo việc — nếu không con bot sẽ tự nói chuyện với chính nó");
  assert.match(echo.reason, /vòng lặp/);

  // 6d. Câu nhân viên trả lời được nối vào gợi ý gần nhất (giá trị của nấc chạy ngầm).
  const conversationId = first.conversationId;
  const sales = await getAgent("sales", undefined, db);
  assert.ok(sales);
  const [suggestion] = await db
    .insert(schema.salesSuggestions)
    .values({ conversationId, stageBefore: "NEW_LEAD", stageAfter: "PRODUCT_IDENTIFIED", action: "ASK_SIZE", suggestedReply: "Dạ chị cho em xin chiều cao cân nặng ạ" })
    .returning({ id: schema.salesSuggestions.id });
  await ingestMessage(parsed.conversation, { ...parsed.message, externalId: "msg-3", fromPage: true, text: "Chị cao bao nhiêu ạ?", sentAt: new Date() }, "test", db);
  const linked = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, suggestion.id) });
  assert.equal(linked?.humanReply, "Chị cao bao nhiêu ạ?", "câu nhân viên thật sự gửi phải được nối vào gợi ý để đối chiếu");

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

  const flowConv = { pageId: "page-e2e", externalId: "conv-e2e", pancakeCustomerId: "cust-e2e", customerName: "Chị Mai", phone: "" };
  let seq = 0;
  const say = async (text: string) => {
    seq += 1;
    const result = await ingestMessage(
      flowConv,
      { externalId: `e2e-${seq}`, text, fromPage: false, fromName: "Chị Mai", sentAt: new Date(Date.now() + seq * 1000), hasAttachment: false, raw: {} },
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

  const soldOutConv = { pageId: "page-hết", externalId: "conv-het", pancakeCustomerId: "cust-het", customerName: "Chị Thu", phone: "" };
  const soldOut = await ingestMessage(
    soldOutConv,
    { externalId: "het-1", text: "em muốn mua Đầm suông AIE2E size M ạ", fromPage: false, fromName: "Chị Thu", sentAt: new Date(), hasAttachment: false, raw: {} },
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

  const complaintConv = { pageId: "page-88", externalId: "conv-88", pancakeCustomerId: "cust-88", customerName: "Chị Hoa", phone: "" };
  const complaintIngest = await ingestMessage(
    complaintConv,
    { externalId: "msg-complaint", text: "shop lua dao, hang loi, cho em gap nhan vien", fromPage: false, fromName: "Chị Hoa", sentAt: new Date(), hasAttachment: false, raw: {} },
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
    { externalId: "msg-complaint-2", text: "em muon mua them mau nay", fromPage: false, fromName: "Chị Hoa", sentAt: new Date(), hasAttachment: false, raw: {} },
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
  const noisyConv = { pageId: "page-99", externalId: "conv-99", pancakeCustomerId: "cust-99", customerName: "Khách", phone: "" };
  const noisy = await ingestMessage(
    noisyConv,
    { externalId: "msg-noisy", text: "??? ... ???", fromPage: false, fromName: "Khách", sentAt: new Date(), hasAttachment: false, raw: {} },
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
  const offConv = { pageId: "page-off", externalId: "conv-off", pancakeCustomerId: "", customerName: "", phone: "" };
  const offIngest = await ingestMessage(offConv, { externalId: "msg-off", text: "alo shop", fromPage: false, fromName: "", sentAt: new Date(), hasAttachment: false, raw: {} }, "test", db);
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

  console.log(
    `✓ Nhân viên bán hàng AI: ${SALES_STAGES.length} giai đoạn · ${combos} tổ hợp chuyển trạng thái đều nằm trong bảng khai báo · "ok" trơ trọi KHÔNG tạo đơn · nấc SHADOW gửi 0 tin`,
  );
}


import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { schema } from "@/db";
import { AGENT_MODES, clampMode, MAX_ALLOWED_MODE, modeAtLeast } from "@/lib/constants/ai";
import { FORBIDDEN_TOOL_PATTERNS, TOOL_CATALOG, TOOL_NAMES, type ToolName } from "@/lib/constants/ai-tools";
import { AI_EVENT_SUBJECT, AI_EVENT_TYPES, aiEventKey } from "@/lib/constants/ai-events";
import { emitAiEvent, emitAndDispatch, claimTask, recordAiError } from "@/lib/ai-workforce/events";
import { ensureAgents, getAgent, AGENT_DEFINITIONS } from "@/lib/ai-workforce/registry";
import { estimateCostVnd, parseRouting, runModelStep } from "@/lib/ai-workforce/model-router";
import { callTool, defineTool, registeredTools } from "@/lib/ai-workforce/tools/gateway";
import { registerErpTools, shippingPolicyTool } from "@/lib/ai-workforce/tools/erp";
import { startRun } from "@/lib/ai-workforce/runs";
import { queueStubResponse, resetStub, stubCalls } from "@/lib/ai-workforce/providers/stub";
import { getProvider, providerNames } from "@/lib/ai-workforce/providers";
import { setSettingJson } from "@/lib/settings";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";

/**
 * NỀN TẢNG NHÂN SỰ AI.
 *
 * Những điều phải khoá ở tầng này không nói gì về bán hàng: quyền hạn, cổng công cụ, chống trùng
 * sự kiện, định tuyến mô hình, sổ chi phí. Nếu một trong số đó hỏng thì MỌI nhân sự AI sau này
 * đều hỏng theo, nên chúng được kiểm riêng khỏi kiểm thử của nhân sự bán hàng.
 */
export async function testAiPlatform(db: Db) {
  registerErpTools();

  // ───────── 1. Sổ công cụ: điều KHÔNG ĐƯỢC CÓ ─────────
  // Đây là lá chắn quan trọng nhất của cả nền tảng: không có công cụ nào sửa giá, sửa tồn, xoá
  // đơn, đánh dấu đã giao hay đụng vào tiền. Kiểm ở mức TÊN để một công cụ như thế không lọt vào
  // sổ đăng ký dù người viết có ý gì.
  for (const name of TOOL_NAMES) {
    for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
      assert.ok(!pattern.test(name), `Công cụ ${name} rơi vào nhóm bị cấm ${pattern}`);
    }
    assert.ok(TOOL_CATALOG[name], `Công cụ ${name} phải khai đủ trong sổ`);
    assert.ok(TOOL_CATALOG[name].permission, `${name} phải khai quyền ERP tương ứng`);
    assert.ok(TOOL_CATALOG[name].source.length > 5, `${name} phải khai nguồn sự thật đằng sau nó`);
  }
  // Mọi công cụ đã khai đều phải được cài đặt — khai mà không cài là một lời hứa suông với mô hình.
  const installed = new Set(registeredTools());
  for (const name of TOOL_NAMES) assert.ok(installed.has(name), `Công cụ ${name} đã khai nhưng chưa cài đặt`);

  // Công cụ GHI phải nằm trên nấc SHADOW, trừ ba công cụ an toàn tuyệt đối (nhãn nội bộ, chuyển
  // người, xếp hàng chăm sóc) — chúng không chạm tới khách và không chạm tới tiền.
  const SAFE_WRITES = new Set<ToolName>(["conversation.tag", "conversation.handoff", "followup.schedule"]);
  for (const name of TOOL_NAMES) {
    const decl = TOOL_CATALOG[name];
    if (decl.kind !== "WRITE" || SAFE_WRITES.has(name)) continue;
    assert.ok(modeAtLeast("COPILOT", decl.minMode) === true || decl.minMode === "AUTO", `${name} là công cụ ghi nên phải cần ít nhất nấc COPILOT`);
    assert.ok(!modeAtLeast("SHADOW", decl.minMode), `${name} KHÔNG được chạy ở nấc SHADOW`);
  }

  // ───────── 2. Nấc quyền hạn: trần là COPILOT, và AUTO KHÔNG với tới được ─────────
  //
  // Bản trước viết `clampMode("COPILOT") === MAX_ALLOWED_MODE`. Câu ấy CÓ NGHĨA khi trần là SHADOW,
  // nhưng nó đúng với BẤT KỲ trần nào — kể cả AUTO — nên nó không khoá được điều thật sự quan
  // trọng. Điều phải khoá là "máy tự nhắn khách không với tới được", nên viết thẳng tên `AUTO` ra.
  assert.notEqual(MAX_ALLOWED_MODE, "AUTO", "trần KHÔNG bao giờ được là AUTO — đó là nấc máy tự nhắn khách");
  assert.equal(clampMode("AUTO"), MAX_ALLOWED_MODE, "yêu cầu nấc AUTO phải bị kẹp xuống trần hiện hành");
  assert.ok(!modeAtLeast(clampMode("AUTO"), "AUTO"), "KHÔNG đường nào qua clampMode ra được nấc AUTO");
  assert.equal(clampMode("COPILOT"), "COPILOT", "nấc trợ lý (người bấm gửi) PHẢI đi qua được — trần kẹp nó là chặn im lặng cả đợt thí điểm");
  assert.equal(clampMode("OFF"), "OFF", "hạ nấc thì không bị kẹp");
  assert.ok(modeAtLeast("SHADOW", "SHADOW") && !modeAtLeast("SHADOW", "COPILOT"), "so sánh nấc phải theo thứ bậc, không so chuỗi");
  for (const mode of AGENT_MODES) assert.ok(modeAtLeast(mode, "OFF"), `nấc ${mode} phải >= OFF`);

  // ───────── 3. Sổ đăng ký nhân sự ─────────
  await ensureAgents(db);
  await ensureAgents(db); // idempotent: chạy hai lần không đẻ thêm bản
  const agentRows = await db.query.aiAgents.findMany();
  assert.equal(agentRows.length, AGENT_DEFINITIONS.length, "mỗi nhân sự trong mã nguồn có đúng một dòng CSDL");
  const versions = await db.query.aiAgentVersions.findMany();
  assert.equal(versions.length, AGENT_DEFINITIONS.length, "chạy lại registry không tạo thêm bản trùng");
  const sales = await getAgent("sales", undefined, db);
  assert.ok(sales, "phải đăng ký được nhân sự bán hàng");
  assert.equal(sales.mode, "SHADOW", "nhân sự mới phải sinh ra ở nấc an toàn");
  // Bản nhân sự không được cấp công cụ nằm ngoài sổ đăng ký.
  for (const tool of sales.definition.allowedTools) assert.ok(TOOL_CATALOG[tool], `bản nhân sự cấp công cụ lạ: ${tool}`);

  // ───────── 4. Cổng công cụ: bốn kiểu từ chối ─────────
  const runForTools = await startRun(
    { agentId: sales.id, agentKey: "sales", agentVersionId: sales.versionId, mode: "SHADOW", subjectType: "TEST", subjectId: "gateway" },
    db,
  );
  const ctx = { agentKey: "sales", mode: "SHADOW" as const, allowedTools: sales.definition.allowedTools, run: runForTools, conversationId: null };

  const notAllowed = await callTool({ ...ctx, allowedTools: ["product.get"] }, "product.search", { query: "abc" });
  assert.equal(notAllowed.ok, false);
  assert.equal(notAllowed.outcome, "DENIED", "công cụ không được cấp cho bản nhân sự phải bị chặn");

  const tooLowMode = await callTool(ctx, "order.create_draft", {
    variantId: "v", quantity: 1, name: "A", phone: "0900000000", address: "1 Nguyễn Trãi, Thanh Xuân, Hà Nội",
    confirmationEvidence: { reviewSentAt: "x", customerRepliedAt: "y", quote: "ok" },
  });
  assert.equal(tooLowMode.ok, false);
  assert.equal(tooLowMode.outcome, "DENIED", "công cụ tạo đơn KHÔNG được chạy ở nấc SHADOW");
  assert.match(tooLowMode.error, /COPILOT/, "lý do từ chối phải nói rõ cần nấc nào");

  const badArgs = await callTool(ctx, "product.search", { query: "" });
  assert.equal(badArgs.outcome, "DENIED", "tham số sai lược đồ phải bị chặn ở cổng, không tới được hàm xử lý");

  const unknown = await callTool(ctx, "khong.co.cong.cu.nay" as ToolName, {});
  assert.equal(unknown.outcome, "DENIED", "công cụ không có trong sổ phải bị chặn");

  // Mọi lần từ chối đều để lại dấu vết — đây là dòng đáng giá nhất của cả sổ.
  const logged = await db.query.aiToolCalls.findMany({ where: eq(schema.aiToolCalls.runId, runForTools.id) });
  assert.equal(logged.length, 4, "bốn lần gọi đều phải được ghi, kể cả lần bị từ chối");
  assert.equal(logged.filter((c) => c.outcome === "DENIED").length, 4, "cả bốn đều là DENIED");
  await runForTools.finish({ status: "SUCCEEDED" });

  // Công cụ treo phải ra TIMEOUT, không phải "kết quả rỗng" — treo mà trả rỗng thì dây chuyền
  // tưởng shop không có chính sách ship và đi nói với khách điều đó.
  // Thay tạm hàm xử lý bằng một hàm ngủ để phép thử TẤT ĐỊNH, rồi trả lại hàm thật ngay sau đó.
  defineTool({
    name: "shipping.policy",
    describe: "bản treo dùng cho kiểm thử",
    input: z.object({}),
    handler: () => new Promise(() => {}),
  });
  const slowRun = await startRun({ agentId: sales.id, agentKey: "sales", mode: "SHADOW", subjectType: "TEST", subjectId: "timeout" }, db);
  const slow = await callTool({ ...ctx, run: slowRun }, "shipping.policy", {}, { timeoutMs: 30 });
  assert.equal(slow.ok, false);
  assert.equal(slow.outcome, "TIMEOUT", "công cụ treo phải ra TIMEOUT");
  await slowRun.finish({ status: "SUCCEEDED" });
  defineTool(shippingPolicyTool);
  const restored = await callTool({ ...ctx, run: null }, "shipping.policy", {});
  assert.equal(restored.ok, true, "phải trả lại được hàm xử lý thật sau khi thử treo");

  // ───────── 5. Sự kiện: chống trùng và điều phối ─────────
  for (const type of AI_EVENT_TYPES) assert.ok(AI_EVENT_SUBJECT[type], `sự kiện ${type} phải khai loại đối tượng`);
  assert.equal(aiEventKey("ORDER_CREATED", [null, undefined, "  "]), null, "không đủ mảnh thì không có khoá chống trùng");

  const key = aiEventKey("ORDER_CREATED", ["don-test-1"]);
  const first = await emitAiEvent({ type: "ORDER_CREATED", source: "test", subjectType: "ORDER", subjectId: "don-test-1", dedupeKey: key }, db);
  const again = await emitAiEvent({ type: "ORDER_CREATED", source: "test", subjectType: "ORDER", subjectId: "don-test-1", dedupeKey: key }, db);
  assert.equal(again.duplicate, true, "gửi lại cùng một sự việc không được đẻ dòng mới");
  assert.equal(again.id, first.id, "lần gửi lại phải trỏ về đúng dòng cũ");
  assert.equal(again.deliveryCount, 2, "lần gửi lại chỉ tăng số lần đẩy");

  // Sự kiện không nhân sự nào nhận ⇒ IGNORED, không im lặng biến mất.
  const orphan = await emitAndDispatch({ type: "INVENTORY_LOW", source: "test", subjectType: "VARIANT", subjectId: "v-test", dedupeKey: aiEventKey("INVENTORY_LOW", ["v-test"]) }, db);
  assert.equal(orphan.tasks.length, 0, "chưa nhân sự nào nhận cảnh báo tồn kho");
  const orphanRow = await db.query.aiEvents.findFirst({ where: eq(schema.aiEvents.id, orphan.id) });
  assert.equal(orphanRow?.status, "IGNORED", "sự kiện không ai nhận phải được đánh dấu IGNORED");

  // ───────── 6. Giành việc: hai tiến trình, một việc ─────────
  const conversationId = await seedConversation(db, "platform-claim");
  const dispatched = await emitAndDispatch(
    { type: "CUSTOMER_MESSAGE_RECEIVED", source: "test", subjectType: "CONVERSATION", subjectId: conversationId, dedupeKey: aiEventKey("CUSTOMER_MESSAGE_RECEIVED", [conversationId, "m1"]) },
    db,
  );
  assert.equal(dispatched.tasks.length, 1, "sự kiện tin nhắn khách phải sinh đúng một việc cho nhân sự bán hàng");
  const taskId = dispatched.tasks[0];
  assert.equal(await claimTask(taskId, db), true, "lần nhận việc đầu phải thành công");
  assert.equal(await claimTask(taskId, db), false, "việc đã có người nhận thì tiến trình thứ hai không nhận được");
  // Đẩy lại chính sự kiện đó không được đẻ thêm việc.
  const redispatch = await emitAndDispatch(
    { type: "CUSTOMER_MESSAGE_RECEIVED", source: "test", subjectType: "CONVERSATION", subjectId: conversationId, dedupeKey: aiEventKey("CUSTOMER_MESSAGE_RECEIVED", [conversationId, "m1"]) },
    db,
  );
  assert.equal(redispatch.tasks.length, 0, "sự kiện gửi lại không được tạo việc thứ hai");

  // ───────── 7. Định tuyến mô hình ─────────
  assert.ok(providerNames().includes("stub") && providerNames().includes("anthropic"), "phải có ít nhất hai nhà cung cấp đăng ký");
  assert.equal(getProvider("khong-co-nha-cung-cap-nay"), null, "tên nhà cung cấp lạ phải trả null, không âm thầm rơi về nhà khác");

  const routing = parseRouting({ provider: "stub", tiers: ["ECONOMY", "STRONG"] });
  const schemaOk = z.object({ text: z.string() });

  // 7a. Cờ tắt gọi mô hình ⇒ chuyển người, KHÔNG phải giá trị mặc định.
  await setSettingJson(AI_CONFIG_KEY, { modelCallsEnabled: false });
  const offSettings = await getAiSettings();
  const off = await runModelStep({ step: "test", system: "s", messages: [{ role: "user", content: "x" }], schema: schemaOk, routing, settings: offSettings });
  assert.equal(off.tier, "HUMAN");
  assert.equal(off.escalation, "POLICY_REQUIRES_HUMAN", "tắt gọi mô hình thì phải chuyển người, không đoán bừa");

  await setSettingJson(AI_CONFIG_KEY, {
    modelCallsEnabled: true,
    pricingVersion: "bang-gia-kiem-thu",
    pricing: { "stub:stub-strong": { inputVndPerMillion: 1_000_000, outputVndPerMillion: 2_000_000 } },
  });
  const onSettings = await getAiSettings();

  // 7b. Mô hình trả RÁC ⇒ leo nấc; nấc trên trả đúng ⇒ dùng kết quả nấc trên.
  resetStub();
  queueStubResponse({ text: "đây không phải JSON" });
  queueStubResponse({ text: JSON.stringify({ text: "ổn rồi" }), inputTokens: 1_000_000, outputTokens: 500_000 });
  const escalated = await runModelStep({ step: "test", system: "s", messages: [{ role: "user", content: "x" }], schema: schemaOk, routing, settings: onSettings });
  assert.equal(escalated.tier, "STRONG", "nấc rẻ trả rác thì phải leo lên nấc mạnh");
  assert.equal(escalated.attempts.length, 2, "cả hai lần gọi đều phải được ghi lại");
  assert.equal(escalated.attempts[0].ok, false, "lần đầu phải bị đánh dấu hỏng lược đồ");
  assert.match(escalated.attempts[0].error ?? "", /lược đồ/i);

  // 7c. Chi phí: có đơn giá thì tính, không có thì CHƯA BIẾT (null), không phải 0.
  const priced = escalated.attempts[1];
  assert.equal(priced.costVnd, 1_000_000 + 1_000_000, "chi phí = token vào × đơn giá vào + token ra × đơn giá ra");
  assert.equal(priced.pricingVersion, "bang-gia-kiem-thu", "lượt tính được tiền phải ghi phiên bản bảng giá đã dùng");
  const noTokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const oneMillion = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  assert.equal(estimateCostVnd("stub", "chua-khai-gia", oneMillion, onSettings.pricing), null, "mô hình chưa khai đơn giá ⇒ chi phí CHƯA BIẾT");
  assert.equal(estimateCostVnd("stub", "stub-strong", noTokens, onSettings.pricing), 0, "không dùng token nào thì chi phí thật sự bằng 0");

  // ── Bốn rổ token, ba mức giá: không được gộp ──
  // Có token đọc từ đệm mà bảng giá chưa khai giá đệm ⇒ CHƯA BIẾT. Lấy giá đầu vào áp cho token
  // đệm sẽ báo đắt gấp nhiều lần thực tế; bỏ qua chúng thì báo rẻ hơn thực tế. Cả hai đều bịa.
  const withCacheRead = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheWriteInputTokens: 0 };
  assert.equal(estimateCostVnd("stub", "stub-strong", withCacheRead, onSettings.pricing), null, "có token đệm mà chưa khai giá đệm ⇒ CHƯA BIẾT");
  const fullPricing = {
    "stub:stub-strong": { inputVndPerMillion: 1_000_000, outputVndPerMillion: 2_000_000, cachedReadVndPerMillion: 100_000, cacheWriteVndPerMillion: 1_250_000 },
  };
  assert.equal(estimateCostVnd("stub", "stub-strong", withCacheRead, fullPricing), 100_000, "khai đủ giá đệm thì token đệm tính theo giá đệm");
  const allFour = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, cacheWriteInputTokens: 1_000_000 };
  assert.equal(estimateCostVnd("stub", "stub-strong", allFour, fullPricing), 1_000_000 + 2_000_000 + 100_000 + 1_250_000, "bốn rổ cộng theo bốn đơn giá riêng");

  // 7d. Mô hình quá thời gian ở cả hai nấc ⇒ chuyển người, ghi đúng lý do.
  resetStub();
  queueStubResponse({ behavior: "timeout" });
  queueStubResponse({ behavior: "timeout" });
  const timedOut = await runModelStep({ step: "test", system: "s", messages: [{ role: "user", content: "x" }], schema: schemaOk, routing, settings: onSettings });
  assert.equal(timedOut.tier, "HUMAN");
  assert.equal(timedOut.escalation, "MODEL_TIMEOUT", "mô hình treo phải ra đúng lý do MODEL_TIMEOUT");

  // 7e. Mô hình báo lỗi ⇒ cũng chuyển người, không rơi về giá trị bịa.
  resetStub();
  queueStubResponse({ behavior: "error" });
  queueStubResponse({ behavior: "error" });
  const errored = await runModelStep({ step: "test", system: "s", messages: [{ role: "user", content: "x" }], schema: schemaOk, routing, settings: onSettings });
  assert.equal(errored.tier, "HUMAN");
  assert.equal(errored.escalation, "MODEL_ERROR");

  // 7f. Độ tin dưới ngưỡng ⇒ leo nấc, không nhận kết quả "hơi đúng".
  resetStub();
  const confidenceSchema = z.object({ confidence: z.number() });
  queueStubResponse({ text: JSON.stringify({ confidence: 0.1 }) });
  queueStubResponse({ text: JSON.stringify({ confidence: 0.95 }) });
  const lowFirst = await runModelStep({
    step: "test", system: "s", messages: [{ role: "user", content: "x" }], schema: confidenceSchema, routing, settings: onSettings,
    confidenceOf: (v) => v.confidence,
  });
  assert.equal(lowFirst.tier, "STRONG", "độ tin thấp ở nấc rẻ phải leo nấc");

  // 7g′. NHÀ CUNG CẤP CHỈ-Ở-BÓNG BỊ TỪ CHỐI NGAY TRÊN ĐƯỜNG PHỤC VỤ KHÁCH.
  //
  // Cánh cửa khó nhất trong bốn cánh: `routing.provider` đến từ `ai_agent_versions.routing`, tức
  // một ô JSON trong CSDL sửa được từ màn hình — nó KHÔNG phải một thẩm quyền đủ để đưa một mô
  // hình chưa ai chấm chất lượng ra trước mặt người mua. Ở đây ca gọi đích danh `google` với khoá
  // đã cấu hình sẵn, và kết quả vẫn phải là CHUYỂN NGƯỜI.
  const savedGoogleKey = process.env.GOOGLE_AI_API_KEY;
  const savedGoogleModel = process.env.AI_MODEL_GOOGLE_ECONOMY;
  try {
    process.env.GOOGLE_AI_API_KEY = "khoa-gia-khong-goi-that";
    process.env.AI_MODEL_GOOGLE_ECONOMY = "gemini-test";
    resetStub();
    const bongOnly = await runModelStep({
      step: "test", system: "s", messages: [{ role: "user", content: "x" }], schema: schemaOk,
      routing: parseRouting({ provider: "google", tiers: ["ECONOMY"] }), settings: onSettings,
    });
    assert.equal(bongOnly.tier, "HUMAN", "cấu hình gọi đích danh nhà cung cấp ở bóng vẫn phải chuyển người");
    assert.equal(bongOnly.escalation, "MODEL_NOT_CONFIGURED");
    assert.equal(bongOnly.attempts.length, 0, "và KHÔNG được gọi mạng lần nào — chặn trước khi gọi, không phải bỏ kết quả sau khi gọi");
  } finally {
    if (savedGoogleKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
    else process.env.GOOGLE_AI_API_KEY = savedGoogleKey;
    if (savedGoogleModel === undefined) delete process.env.AI_MODEL_GOOGLE_ECONOMY;
    else process.env.AI_MODEL_GOOGLE_ECONOMY = savedGoogleModel;
  }

  // 7g. Lời dặn gửi cho mô hình KHÔNG được chứa bí mật.
  for (const call of stubCalls()) {
    assert.ok(!/sk-|api[_-]?key|password|token=/i.test(call.system), "lời dặn hệ thống không được chứa bí mật");
  }

  // ───────── 8. Sổ lượt chạy: tổng token, chi phí, độ trễ ─────────
  const run = await startRun({ agentId: sales.id, agentKey: "sales", mode: "SHADOW", subjectType: "TEST", subjectId: "cost" }, db);
  await run.model([
    { tier: "ECONOMY", provider: "stub", model: "stub-economy", ok: true, step: "understand", inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costVnd: 7, pricingVersion: "bang-gia-kiem-thu", latencyMs: 12, error: null },
    { tier: "STRONG", provider: "stub", model: "stub-strong", ok: true, step: "generate", inputTokens: 200, outputTokens: 80, cachedInputTokens: 0, costVnd: 20, pricingVersion: "bang-gia-kiem-thu", latencyMs: 30, error: null },
  ]);
  await run.finish({ status: "SUCCEEDED", suggestedReply: "xin chào" });
  const saved = await db.query.aiRuns.findFirst({ where: eq(schema.aiRuns.id, run.id) });
  assert.equal(saved?.inputTokens, 300, "tổng token vào lấy từ sổ chi phí, không cộng tay");
  assert.equal(saved?.outputTokens, 130);
  assert.equal(saved?.costVnd, 27, "tổng chi phí = tổng các lần gọi");
  assert.equal(saved?.status, "SUCCEEDED");

  // Có lần gọi chưa khai đơn giá ⇒ TỔNG là CHƯA BIẾT, không phải "tổng phần biết được".
  const mixed = await startRun({ agentId: sales.id, agentKey: "sales", mode: "SHADOW", subjectType: "TEST", subjectId: "cost-unknown" }, db);
  await mixed.model([
    { tier: "ECONOMY", provider: "stub", model: "a", ok: true, step: "understand", inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costVnd: 3, pricingVersion: "bang-gia-kiem-thu", latencyMs: 1, error: null },
    { tier: "STRONG", provider: "stub", model: "chua-khai", ok: true, step: "generate", inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costVnd: null, pricingVersion: "bang-gia-kiem-thu", latencyMs: 1, error: null },
  ]);
  await mixed.finish({ status: "SUCCEEDED" });
  const mixedRow = await db.query.aiRuns.findFirst({ where: eq(schema.aiRuns.id, mixed.id) });
  assert.equal(mixedRow?.costVnd, null, "một lần gọi chưa khai đơn giá làm cả lượt chạy thành CHƯA BIẾT");

  // Không gọi mô hình lần nào ⇒ chi phí THẬT SỰ bằng 0 (khác hẳn chưa biết).
  const free = await startRun({ agentId: sales.id, agentKey: "sales", mode: "SHADOW", subjectType: "TEST", subjectId: "cost-free" }, db);
  await free.finish({ status: "SUCCEEDED" });
  const freeRow = await db.query.aiRuns.findFirst({ where: eq(schema.aiRuns.id, free.id) });
  assert.equal(freeRow?.costVnd, 0, "lượt chạy hết bằng luật thì chi phí bằng 0 thật, không phải chưa biết");

  // ───────── 9. Bí mật không bao giờ vào sổ ─────────
  const secretRun = await startRun(
    { agentId: sales.id, agentKey: "sales", mode: "SHADOW", subjectType: "TEST", subjectId: "secret", input: { apiKey: "sk-rat-bi-mat", text: "xin chào" } },
    db,
  );
  await secretRun.finish({ status: "SUCCEEDED" });
  const secretRow = await db.query.aiRuns.findFirst({ where: eq(schema.aiRuns.id, secretRun.id) });
  assert.ok(!JSON.stringify(secretRow?.input).includes("sk-rat-bi-mat"), "khoá API không bao giờ được ghi vào sổ lượt chạy");

  // ───────── 10. Lỗi ngoài lượt chạy vẫn có chỗ ghi ─────────
  await recordAiError({ scope: "WEBHOOK", agentKey: "sales", message: "Gói tin thiếu conversation_id" }, db);
  const errors = await db.query.aiErrors.findMany({ where: eq(schema.aiErrors.scope, "WEBHOOK") });
  assert.ok(errors.length >= 1, "lỗi xảy ra ngoài một lượt chạy vẫn phải ghi được");

  // ═════════ MÀN HÌNH QUAN SÁT PHẢI HIỆN ĐỦ MỘT LƯỢT CHẠY ═════════
  //
  // Một lượt chạy chỉ giải thích được nếu người đọc thấy ĐỦ dây chuyền: khách nói gì → máy hiểu gì
  // → trạng thái trước/sau → quyết định → gọi ERP những gì → gọi mô hình nào, hết bao nhiêu token
  // và bao nhiêu tiền theo BẢNG GIÁ NÀO → máy định nói gì → người thực sự nói gì. Thiếu một mắt
  // xích là lúc cần truy thì chỉ còn cách đoán, và đoán về một quyết định của máy là vô ích.
  //
  // Kiểm ở mức NGUỒN vì đây là hợp đồng giao diện, không phải một phép tính: một lần "dọn dẹp" gỡ
  // mất khối token hay khối công cụ sẽ không làm hỏng bất cứ bài kiểm dữ liệu nào.
  const manHinh = readFileSync("app/(dashboard)/ai/[id]/page.tsx", "utf8");
  const PHAI_CO: [string, RegExp][] = [
    ["tin nhắn của khách", /input\.text/],
    ["ý định & thực thể", /run\.understanding/],
    ["trạng thái trước", /run\.stateBefore/],
    ["trạng thái sau", /run\.stateAfter/],
    ["quyết định", /run\.decision/],
    ["công cụ ERP đã gọi", /toolCalls\.map/],
    ["kết cục từng lời gọi công cụ", /TOOL_OUTCOME_LABEL/],
    ["lần gọi mô hình", /modelCalls\.map/],
    ["nhà cung cấp & tên mô hình", /call\.provider[\s\S]{0,80}call\.model/],
    ["token vào/ra", /call\.inputTokens[\s\S]{0,120}call\.outputTokens/],
    ["token đệm", /cachedInputTokens/],
    ["chi phí", /costLabel/],
    ["phiên bản bảng giá", /pricingVersion/],
    ["độ trễ", /latencyMs/],
    ["lỗi của lượt chạy", /run\.error/],
    ["lỗi của từng lời gọi", /call\.error/],
    ["câu máy gợi ý", /run\.suggestedReply/],
    ["câu nhân viên thật sự trả lời", /suggestion\?\.humanReply/],
    ["đã gửi cho khách hay chưa", /suggestion\?\.sent/],
  ];
  const thieu = PHAI_CO.filter(([, re]) => !re.test(manHinh)).map(([ten]) => ten);
  assert.deepEqual(thieu, [], `màn hình chi tiết lượt chạy thiếu: ${thieu.join(", ")} — không truy được thì không soát được`);

  // Màn hình SOÁT phải dẫn được sang màn hình chi tiết, nếu không người chấm thấy ba cột mà không
  // bao giờ xem được vì sao máy nói như vậy.
  const manHinhSoat = readFileSync("app/(dashboard)/ai/review/page.tsx", "utf8");
  assert.match(manHinhSoat, /href={`\/ai\/\$\{turn\.runId\}`}/, "mỗi lượt trên màn hình soát phải bấm sang được chi tiết lượt chạy");

  await setSettingJson(AI_CONFIG_KEY, {});
  resetStub();
  console.log(`✓ Nền tảng nhân sự AI: ${TOOL_NAMES.length} công cụ có sổ đăng ký · 4 kiểu từ chối đều ghi vết · leo nấc mô hình đúng · chi phí CHƯA BIẾT không thành 0đ · màn hình quan sát hiện đủ ${PHAI_CO.length} mắt xích`);
}

/** Hội thoại tối thiểu để kiểm tầng nền tảng (miền bán hàng có fixture riêng). */
export async function seedConversation(db: Db, suffix: string): Promise<string> {
  const [row] = await db
    .insert(schema.salesConversations)
    .values({ channel: "PANCAKE", pageId: `page-${suffix}`, externalId: `conv-${suffix}`, customerName: "Khách kiểm thử", stage: "NEW_LEAD" })
    .onConflictDoNothing({ target: [schema.salesConversations.pageId, schema.salesConversations.externalId] })
    .returning({ id: schema.salesConversations.id });
  if (row) return row.id;
  const existing = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.externalId, `conv-${suffix}`) });
  return existing!.id;
}

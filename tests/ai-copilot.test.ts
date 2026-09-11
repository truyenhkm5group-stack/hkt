import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { confirmCopilotActions, runCopilot } from "@/lib/ai/copilot";
import { actionToken, stableStringify } from "@/lib/ai/policy";
import { COPILOT_SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { estimateCostUsd, FakeProvider, type AiResponse } from "@/lib/ai/provider";
import { OpenAiProvider } from "@/lib/ai/providers/openai";
import { registerCareTools } from "@/lib/ai/tools/care";
import { registerErpTools } from "@/lib/ai/tools/erp";
import { aiDisabledReason, MODEL_BY_TIER, modelFor, resolveProviderName } from "@/lib/ai/router";
import { allTools, RISK_FLOOR, strictInputSchema, toolsFor } from "@/lib/ai/tools/registry";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";

/**
 * ───────────── AI COPILOT: ERP TRUTH → TYPED TOOLS → AI ─────────────
 *
 * Khoá:
 *  1. AI chỉ thấy tool đúng quyền; tool `forbidden` (ĐVVC / tài chính / tồn kho) không bao giờ tới model;
 *  2. tool ĐỌC chạy ngay và trả về đúng số của bàn làm việc; tool GHI KHÔNG chạy — chỉ là đề nghị;
 *  3. đề nghị chỉ chạy sau `confirmCopilotActions`: đúng người, đúng token (HMAC người·tool·input),
 *     còn quyền; chạy rồi không chạy lại; sửa input là token vô hiệu;
 *  4. hành động AI đã chạy để lại dấu ở care_case_events (source = AI) + audit_logs + ai_interactions;
 *  5. vòng lặp có trần; kết quả tool cũ dữ liệu được nêu thành cảnh báo;
 *  6. mã tool không đụng DB trực tiếp — đi qua lib/queries và lib/care/service.
 */
export async function testAiCopilot(db: Db) {
  registerCareTools();
  registerErpTools();
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);

  // ───────── Sổ đăng ký: phân tách đọc/ghi, sàn rủi ro, JSON Schema chặt ─────────
  const tools = allTools();
  assert.ok(tools.length >= 20, `phải có ít nhất 20 tool (care + ERP), thấy ${tools.length}`);
  for (const n of ["search_customer", "get_order_context", "get_customer_history", "get_profit_summary", "get_cash_position", "get_inventory_risks", "get_product_performance", "get_owner_brief", "resolve_case", "reopen_case"]) assert.ok(tools.some((t) => t.name === n), `thiếu tool ${n}`);
  for (const t of tools) {
    if (t.kind === "write") assert.notEqual(t.policy, "auto", `${t.name}: tool ghi không được chạy tự động`);
    if (RISK_FLOOR[t.riskClass] === "forbidden") assert.equal(t.policy, "forbidden", `${t.name}: nhóm ${t.riskClass} phải bị cấm ở MVP`);
    const js = strictInputSchema(t.input) as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    assert.equal(js.additionalProperties, false, `${t.name}: schema phải chặn khoá lạ`);
    assert.deepEqual([...js.required].sort(), Object.keys(js.properties).sort(), `${t.name}: strict mode đòi mọi khoá đều bắt buộc`);
  }
  assert.ok(tools.some((t) => t.name === "request_carrier_action" && t.policy === "forbidden"), "yêu cầu ĐVVC phải được khai tường minh là AI không được làm");

  // Tool không được import DB: mọi thứ AI biết/làm phải đi qua lib/queries và lớp nghiệp vụ.
  for (const f of readdirSync("lib/ai/tools").filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(`lib/ai/tools/${f}`, "utf8");
    assert.ok(!/from "@\/db"/.test(src) && !/drizzle-orm/.test(src), `lib/ai/tools/${f}: tool không được chạm DB trực tiếp`);
  }
  assert.ok(!/ANTHROPIC_API_KEY|sk-ant/.test(COPILOT_SYSTEM_PROMPT), "prompt hệ thống không chứa bí mật");

  // ───────── Người dùng & dữ liệu ─────────
  await db.insert(schema.users).values({ id: "ai-user-cs", email: "cs-ai@test", name: "Hà", passwordHash: "x", role: "CS", active: true }).onConflictDoNothing();
  await db.insert(schema.users).values({ id: "ai-user-viewer", email: "viewer-ai@test", name: "Khách xem", passwordHash: "x", role: "VIEWER", active: true }).onConflictDoNothing();
  const cs: SessionUser = { id: "ai-user-cs", email: "cs-ai@test", name: "Hà", role: "CS", permissions: resolvePermissions("CS", null) };
  const viewer: SessionUser = { id: "ai-user-viewer", email: "viewer-ai@test", name: "Khách xem", role: "VIEWER", permissions: [] };

  const csTools = toolsFor(cs).map((t) => t.name);
  assert.ok(csTools.includes("get_care_case") && csTools.includes("add_care_note"), "CS thấy tool đọc và tool ghi care");
  assert.ok(!csTools.includes("request_carrier_action"), "tool cấm không tới model dù có quyền shipments:manage");
  assert.deepEqual(toolsFor(viewer), [], "không có quyền ⇒ không tool nào");

  await db.insert(schema.orders).values({ id: "ai-o1", stage: "SHIPPED", status: 3, insertedAt: gio(40), billFullName: "Khách AI", billPhone: "0900000099", moneyToCollect: 420_000, totalPriceAfterDiscount: 420_000 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "ai-s1", orderId: "ai-o1", carrier: "Viettel Post", vtpOrderNumber: "AICARE001", stage: "DELIVERY_FAILED", codAmount: 420_000, trackingCapability: "WEBHOOK_ONLY", vtpStatusDate: gio(30), vtpStatusName: "Phát không thành công" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "ai-s1", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(30), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
  clearMemo();

  const text = (t: string): Omit<AiResponse, "usage" | "model" | "latencyMs"> => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
  const use = (name: string, input: unknown, id = `tu_${name}`): Omit<AiResponse, "usage" | "model" | "latencyMs"> => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" });
  const ctx = { route: "/shipments", entityType: "shipment" as const, entityId: "ai-s1" };

  // ───────── 1. Tool đọc chạy ngay, trả đúng số của bàn làm việc, nêu dữ liệu cũ ─────────
  const p1 = new FakeProvider([() => use("get_care_case", { shipmentId: "ai-s1" }), (req) => {
    const last = req.messages[req.messages.length - 1]!.content[0]!;
    assert.equal(last.type, "tool_result");
    const data = JSON.parse((last as { content: string }).content);
    assert.equal(data.shipment.tracking, "AICARE001");
    assert.equal(data.shipment.codAmount, 420_000);
    assert.equal(data.care.status, "NEW");
    assert.ok(typeof data.staleness === "string" && data.staleness.includes("giờ"), "kiện tin cuối 30 giờ + WEBHOOK_ONLY phải được đánh dấu cũ");
    return text("Kiện AICARE001 giao hụt 1 lần, COD 420.000đ, chưa ai nhận.");
  }]);
  const r1 = await runCopilot({ user: cs, provider: p1, message: "Tóm tắt kiện này", context: ctx });
  assert.equal(r1.status, "OK");
  assert.equal(r1.rounds, 2);
  assert.equal(r1.toolCalls.length, 1);
  assert.ok(r1.toolCalls[0]!.executed && r1.toolCalls[0]!.ok);
  assert.ok(r1.warnings.some((w) => w.includes("giờ")), "cảnh báo dữ liệu cũ phải nổi lên kết quả");
  assert.ok(r1.answer.includes("AICARE001"));
  assert.ok(r1.interactionId, "phải ghi ai_interactions");
  assert.ok(p1.calls[0]!.system === COPILOT_SYSTEM_PROMPT, "system prompt ổn định để đệm");
  assert.ok(p1.calls[0]!.messages[0]!.content[0]!.type === "text" && (p1.calls[0]!.messages[0]!.content[0] as { text: string }).text.includes("shipment ai-s1"), "bối cảnh màn hình nằm trong tin nhắn user");
  assert.ok(!p1.calls[0]!.tools.some((t) => t.name === "request_carrier_action"));
  const [row1] = await db.select().from(schema.aiInteractions).where(eq(schema.aiInteractions.id, r1.interactionId!));
  assert.equal(row1!.status, "OK");
  assert.equal(row1!.userEmail, "cs-ai@test");
  assert.equal((row1!.toolCalls as unknown[]).length, 1);

  // ───────── 2. Tool ghi KHÔNG chạy — chỉ đề nghị; chạy sau xác nhận; không chạy lại ─────────
  const eventsOf = async () => db.select().from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, "ai-s1"));
  assert.equal((await eventsOf()).length, 0);
  const p2 = new FakeProvider([
    () => use("add_care_note", { shipmentId: "ai-s1", kind: "CALLED_REACHED", note: "Khách hẹn nhận sáng mai" }),
    (req) => {
      const last = req.messages[req.messages.length - 1]!.content[0] as { content: string };
      assert.ok(last.content.includes("CHỜ XÁC NHẬN"));
      return text("Tôi đã đề nghị ghi note. Bấm xác nhận để lưu.");
    },
  ]);
  const r2 = await runCopilot({ user: cs, provider: p2, message: "Ghi note: đã gọi được, khách hẹn nhận sáng mai", context: ctx });
  assert.equal(r2.status, "NEEDS_CONFIRMATION");
  assert.equal(r2.pendingActions.length, 1);
  assert.equal(r2.pendingActions[0]!.name, "add_care_note");
  assert.equal(r2.pendingActions[0]!.riskClass, "care");
  assert.ok(r2.pendingActions[0]!.summary.includes("Khách hẹn nhận sáng mai"));
  assert.equal((await eventsOf()).length, 0, "chưa xác nhận thì KHÔNG được ghi");
  const [care0] = await db.select().from(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, "ai-s1"));
  assert.ok(!care0 || care0.careStatus === "NEW");

  const token = r2.pendingActions[0]!.token;
  assert.equal(token, actionToken(cs.id, "add_care_note", r2.pendingActions[0]!.input), "token = HMAC(người·tool·input)");
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');

  // Người khác không xác nhận hộ được.
  const other: SessionUser = { ...cs, id: "ai-user-viewer" };
  assert.ok("error" in (await confirmCopilotActions({ user: other, interactionId: r2.interactionId!, tokens: [token] })));
  // Token lạ / sửa input ⇒ từ chối.
  assert.ok("error" in (await confirmCopilotActions({ user: cs, interactionId: r2.interactionId!, tokens: ["deadbeefdeadbeefdeadbeefdeadbeef"] })));
  assert.equal((await eventsOf()).length, 0);

  const c1 = await confirmCopilotActions({ user: cs, interactionId: r2.interactionId!, tokens: [token] });
  assert.ok("ok" in c1, `xác nhận phải chạy được: ${JSON.stringify(c1)}`);
  assert.equal(c1.data.executed.length, 1);
  assert.ok(c1.data.executed[0]!.ok, c1.data.executed[0]!.summary);
  const ev = await eventsOf();
  assert.equal(ev.length, 1, "một sự kiện care sau khi xác nhận");
  assert.equal(ev[0]!.source, "AI", "nguồn sự kiện phải là AI");
  assert.equal(ev[0]!.actorEmail, "cs-ai@test", "actor là người xác nhận, không phải 'AI'");
  assert.equal(ev[0]!.nextStatus, "IN_PROGRESS");
  const [care1] = await db.select().from(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, "ai-s1"));
  assert.equal(care1!.careStatus, "IN_PROGRESS");
  const [row2] = await db.select().from(schema.aiInteractions).where(eq(schema.aiInteractions.id, r2.interactionId!));
  assert.equal((row2!.actionsExecuted as unknown[]).length, 1);
  const auditRows = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "AI_ACTIONS_CONFIRMED"), eq(schema.auditLogs.entityId, r2.interactionId!)));
  assert.equal(auditRows.length, 1, "xác nhận phải ghi audit_logs");

  // Xác nhận lại cùng token ⇒ không chạy lại.
  const c2 = await confirmCopilotActions({ user: cs, interactionId: r2.interactionId!, tokens: [token] });
  assert.ok("ok" in c2 && !c2.data.executed[0]!.ok && c2.data.executed[0]!.summary.includes("không chạy lại"));
  assert.equal((await eventsOf()).length, 1);

  // ───────── 3. Không có quyền ⇒ model không có tool; gọi bừa cũng không chạy ─────────
  const p3 = new FakeProvider([() => use("add_care_note", { shipmentId: "ai-s1", kind: "OTHER", note: "lén" }), () => text("Không làm được.")]);
  const r3 = await runCopilot({ user: viewer, provider: p3, message: "Ghi note", context: ctx });
  assert.equal(p3.calls[0]!.tools.length, 0, "người không quyền ⇒ model không thấy tool nào");
  assert.equal(r3.pendingActions.length, 0);
  assert.ok(r3.toolCalls[0] && !r3.toolCalls[0].executed && !r3.toolCalls[0].ok);
  assert.equal((await eventsOf()).length, 1);

  // Tool cấm gọi thẳng cũng bị chặn dù có quyền shipments:manage.
  const p4 = new FakeProvider([() => use("request_carrier_action", { shipmentId: "ai-s1" }), () => text("Không được.")]);
  const r4 = await runCopilot({ user: cs, provider: p4, message: "Phát lại kiện", context: ctx });
  assert.equal(r4.pendingActions.length, 0);
  assert.ok(r4.toolCalls[0]!.summary.includes("không được phép"));

  // Input sai ⇒ lỗi trả model, không chạy.
  const p5 = new FakeProvider([() => use("set_care_status", { shipmentIds: ["ai-s1"], status: "DONE", note: "" }), () => text("Sai.")]);
  const r5 = await runCopilot({ user: cs, provider: p5, message: "Đóng kiện", context: ctx });
  assert.equal(r5.pendingActions.length, 0);
  assert.equal(r5.toolCalls[0]!.summary, "Input sai");

  // ───────── 4. Trần vòng lặp; provider tắt ─────────
  const p6 = new FakeProvider([() => use("get_care_queue_summary", {}, `tu_${Math.random()}`)]);
  const r6 = await runCopilot({ user: cs, provider: p6, message: "Lặp mãi", context: ctx });
  assert.ok(r6.rounds <= 10 && r6.warnings.some((w) => w.includes("Dừng sau")), `vòng lặp phải có trần: rounds=${r6.rounds}`);
  const r7 = await runCopilot({ user: cs, provider: null, message: "Xin chào", context: ctx });
  assert.equal(r7.status, "DISABLED");

  // Tool tổng quan / tìm / báo cáo / độ tươi chạy được và thấy kiện thật.
  const p8 = new FakeProvider([
    () => ({ content: [{ type: "tool_use", id: "a", name: "get_care_queue_summary", input: {} }, { type: "tool_use", id: "b", name: "search_care_cases", input: { query: "AICARE", view: null, ownerName: null, careStatus: null, limit: 5 } }, { type: "tool_use", id: "c", name: "get_care_report", input: { period: "30d" } }, { type: "tool_use", id: "d", name: "get_data_freshness", input: {} }], stopReason: "tool_use" }),
    (req) => {
      const results = req.messages[req.messages.length - 1]!.content as { toolUseId: string; content: string }[];
      const search = JSON.parse(results.find((r) => r.toolUseId === "b")!.content);
      assert.ok(search.cases.some((c: { shipmentId: string }) => c.shipmentId === "ai-s1"), "tìm phải thấy kiện AICARE001");
      const report = JSON.parse(results.find((r) => r.toolUseId === "c")!.content);
      assert.ok(typeof report.recovery.failedTotal === "number");
      return text("ok");
    },
  ]);
  const r8 = await runCopilot({ user: cs, provider: p8, message: "Hôm nay còn bao nhiêu kiện?", context: { route: "/shipments", entityType: "", entityId: "" } });
  assert.equal(r8.status, "OK");
  assert.equal(r8.toolCalls.filter((t) => t.executed && t.ok).length, 4, JSON.stringify(r8.toolCalls.map((t) => t.summary)));

  // ───────── 4b. OpenAI Responses API: ánh xạ đúng, không mạng (fetch giả) ─────────
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ url: String(url), body });
    const isSecond = (body.input as unknown[]).some((it) => (it as { type?: string }).type === "function_call_output");
    const payload = isSecond
      ? { id: "resp_2", object: "response", status: "completed", model: "gpt-5.6-terra", output: [{ type: "message", id: "m2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Kiện AICARE001 giao hụt 1 lần.", annotations: [] }] }], usage: { input_tokens: 900, output_tokens: 50, input_tokens_details: { cached_tokens: 700 }, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 950 } }
      : { id: "resp_1", object: "response", status: "completed", model: "gpt-5.6-terra", output: [{ type: "function_call", id: "fc_1", call_id: "call_abc", name: "get_care_case", arguments: JSON.stringify({ shipmentId: "ai-s1" }), status: "completed" }], usage: { input_tokens: 800, output_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 820 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test-khong-that";
  try {
    const oa = new OpenAiProvider("gpt-5.6-terra", "medium", fakeFetch);
    const r9 = await runCopilot({ user: cs, provider: oa, message: "Tóm tắt kiện này", context: ctx });
    assert.equal(r9.status, "OK", JSON.stringify(r9));
    assert.equal(r9.rounds, 2);
    assert.ok(r9.answer.includes("AICARE001"));
    assert.equal(r9.toolCalls[0]!.name, "get_care_case");
    assert.ok(r9.toolCalls[0]!.executed && r9.toolCalls[0]!.ok, "tool đọc phải chạy với input từ function_call");
    assert.equal(seen.length, 2);
    assert.ok(seen[0]!.url.endsWith("/responses"), `phải gọi Responses API, thấy ${seen[0]!.url}`);
    const b0 = seen[0]!.body;
    assert.equal(b0.model, "gpt-5.6-terra");
    assert.equal(b0.instructions, COPILOT_SYSTEM_PROMPT, "system prompt ⇒ instructions");
    assert.equal(b0.store, false, "không lưu hội thoại phía OpenAI");
    assert.deepEqual(b0.reasoning, { effort: "medium" });
    const t0 = (b0.tools as { type: string; name: string; strict: boolean; parameters: { additionalProperties: boolean } }[]).find((t) => t.name === "get_care_case")!;
    assert.ok(t0 && t0.type === "function" && t0.strict === true && t0.parameters.additionalProperties === false, "tool ⇒ function strict");
    const in1 = seen[1]!.body.input as { type: string; call_id?: string; name?: string; output?: string; role?: string }[];
    assert.ok(in1.some((i) => i.type === "function_call" && i.call_id === "call_abc" && i.name === "get_care_case"), "lượt 2 phải phát lại function_call");
    const out = in1.find((i) => i.type === "function_call_output" && i.call_id === "call_abc");
    assert.ok(out && JSON.parse(out.output!).shipment.tracking === "AICARE001", "function_call_output mang kết quả tool");
    assert.equal(r9.usage.cacheReadTokens, 700, "cached_tokens ⇒ cacheReadTokens");
    assert.equal(r9.usage.inputTokens, 800 + 200, "input không đệm = input_tokens − cached");
    assert.equal(r9.costUsd, null, "model chưa có giá ⇒ chi phí chưa biết");
    const [row9] = await db.select().from(schema.aiInteractions).where(eq(schema.aiInteractions.id, r9.interactionId!));
    assert.equal(row9!.provider, "openai");
    assert.equal(row9!.costUsd, "", "chưa biết giá ⇒ chuỗi rỗng, không phải 0");
    assert.ok(!JSON.stringify(seen).includes("sk-test-khong-that"), "khoá không nằm trong body");

    // Router: chọn provider theo khoá có sẵn, model theo bậc, không rải chuỗi model.
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    const hadAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    assert.equal(resolveProviderName(), "openai");
    assert.equal(modelFor("openai", "routine"), "gpt-5.6-luna");
    assert.equal(modelFor("openai", "copilot"), "gpt-5.6-terra");
    assert.equal(modelFor("openai", "analysis"), "gpt-5.6-sol");
    process.env.AI_MODEL = "gpt-5.6-luna";
    assert.equal(modelFor("openai", "copilot"), "gpt-5.6-luna", "AI_MODEL ghi đè bậc copilot");
    delete process.env.AI_MODEL;
    delete process.env.OPENAI_API_KEY;
    assert.equal(resolveProviderName(), null);
    assert.ok(aiDisabledReason()!.includes("OPENAI_API_KEY"), "lý do tắt phải nói đúng secret còn thiếu");
    process.env.AI_PROVIDER = "off";
    assert.equal(aiDisabledReason(), "AI_PROVIDER=off");
    delete process.env.AI_PROVIDER;
    if (hadAnthropic) process.env.ANTHROPIC_API_KEY = hadAnthropic;
    assert.equal(MODEL_BY_TIER.anthropic.copilot, "claude-opus-5");
    const src = readFileSync("lib/ai/copilot.ts", "utf8") + readFileSync("lib/ai/tools/care.ts", "utf8") + readFileSync("lib/ai/tools/erp.ts", "utf8") + readFileSync("lib/actions/ai.ts", "utf8");
    assert.ok(!/gpt-5|claude-opus|claude-sonnet|claude-haiku/.test(src), "chuỗi model chỉ được nằm ở router / provider");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }

  // ───────── 5. Benchmark: chi phí vòng lặp (không mạng) và ước tính tiền ─────────
  const lat: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const p = new FakeProvider([() => use("get_care_case", { shipmentId: "ai-s1" }), () => text("ok")]);
    const t0 = performance.now();
    await runCopilot({ user: cs, provider: p, message: "Tóm tắt", context: ctx });
    lat.push(performance.now() - t0);
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)]!;
  const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]!;
  assert.ok(p95 < 2000, `vòng lặp copilot (tool + ghi nhật ký) p95 ${p95.toFixed(0)}ms quá chậm`);
  const promptTokens = Math.ceil(COPILOT_SYSTEM_PROMPT.length / 3) + toolsFor(cs).reduce((s, t) => s + Math.ceil((t.description.length + JSON.stringify(strictInputSchema(t.input)).length) / 3), 0);
  const caseTokens = Math.ceil(JSON.stringify(await (allTools().find((t) => t.name === "get_care_case")!.run({ user: cs, actor: { id: cs.id, email: cs.email, source: "AI" }, route: "", entityType: "", entityId: "", now: new Date() }, { shipmentId: "ai-s1" }))).length / 3);
  const typical = { inputTokens: promptTokens + caseTokens + 200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const cached = { inputTokens: caseTokens + 200, outputTokens: 400, cacheReadTokens: promptTokens, cacheWriteTokens: 0 };
  const costCold = estimateCostUsd("claude-opus-5", typical);
  const costWarm = estimateCostUsd("claude-opus-5", cached);
  assert.ok(costCold !== null && costWarm !== null && costCold < 0.2, `một lượt tóm tắt kiện ước ${costCold} USD — quá đắt cho thao tác thường ngày`);
  assert.equal(estimateCostUsd("gpt-5.6-terra", typical), null, "model chưa có giá ⇒ chi phí CHƯA BIẾT, không phải 0");

  console.log(
    `✓ AI Copilot (Anthropic + OpenAI Responses, router 3 bậc): ${tools.length} tool (${tools.filter((t) => t.kind === "read").length} đọc · ${tools.filter((t) => t.kind === "write" && t.policy === "confirm").length} ghi-cần-xác-nhận · ${tools.filter((t) => t.policy === "forbidden").length} cấm) · ghi chỉ chạy sau xác nhận, có token, không chạy lại · vòng lặp p50 ${p50.toFixed(0)}ms p95 ${p95.toFixed(0)}ms (không mạng) · ước ~${promptTokens} token prompt+tool, hồ sơ kiện ~${caseTokens} token · một lượt tóm tắt ≈ $${costCold.toFixed(4)} lạnh / $${costWarm.toFixed(4)} có đệm`,
  );
}

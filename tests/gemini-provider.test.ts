/**
 * GEMINI CHO CHATBOT BÁN HÀNG (01/10/2026) — `ByokGeminiProvider` (lib/ai-builder/providers.ts) + kết nối `gemini-byok`.
 * Không gọi mạng thật (luật 65): `fetch` giả ghi lại mọi yêu cầu.
 */
import assert from "node:assert/strict";
import { ByokGeminiProvider, GEMINI_DEFAULT_MODEL, toGeminiContents, toGeminiSchema } from "@/lib/ai-builder/providers";
import { estimateCostUsd, type AiRequest } from "@/lib/ai/provider";
import { CONNECTORS } from "@/lib/connectors/registry";
import { GEMINI_MODELS_URL, ORG_CONNECTION_TESTERS, testGeminiKey } from "@/lib/connectors/testers";
import { SALES_BOT_CONNECTORS } from "@/lib/sales-chatbot/config";

const KEY = `AIza${"x".repeat(35)}`;

type Seen = { url: string; init?: RequestInit; body: Record<string, unknown> };
function fakeGemini(responses: { status?: number; body: unknown }[]) {
  const seen: Seen[] = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen };
}

export async function testGeminiProvider() {
  // ── Phần thuần: schema + hội thoại ──
  const schema = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["variant_id"], additionalProperties: false } } }, required: ["items"], additionalProperties: false };
  const gs = JSON.stringify(toGeminiSchema(schema));
  assert.ok(!gs.includes("additionalProperties") && gs.includes('"minimum":1') && gs.includes('"required":["variant_id"]'), gs);
  const contents = toGeminiContents([
    { role: "user", content: [{ type: "text", text: "Chả cá thu bao nhiêu?" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "g0_abc|SIG123", name: "search_products", input: { query: "chả cá thu" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "g0_abc|SIG123", content: JSON.stringify({ results: [{ name: "Chả cá thu" }] }) }] },
    { role: "user", content: [{ type: "text", text: "1kg nhé" }] },
  ]);
  assert.equal(contents.length, 3, "lượt liền nhau cùng vai gộp làm một");
  assert.deepEqual(contents[1], { role: "model", parts: [{ functionCall: { name: "search_products", args: { query: "chả cá thu" } }, thoughtSignature: "SIG123" }] });
  assert.equal(contents[2].parts[0].functionResponse?.name, "search_products", "tên tool tra theo toolUseId");
  assert.equal(contents[2].parts[1].text, "1kg nhé");

  // ── Một lượt có công cụ: header khoá, URL không mang khoá, suy luận theo mức, tool khai đúng tập con ──
  const fc = fakeGemini([{ body: { candidates: [{ content: { parts: [{ functionCall: { name: "search_products", args: { query: "chả cá thu" } }, thoughtSignature: "SIG9" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 10 }, modelVersion: "gemini-2.5-flash-lite" } }]);
  const p = new ByokGeminiProvider({ apiKey: KEY, model: "", fetch: fc.fetch });
  assert.equal(p.model, GEMINI_DEFAULT_MODEL);
  const req: AiRequest = { system: "Bạn là trợ lý", messages: [{ role: "user", content: [{ type: "text", text: "giá chả cá thu" }] }], tools: [{ name: "search_products", description: "Tìm", inputSchema: schema }], maxTokens: 4000, reasoning: "low" };
  const r = await p.complete(req);
  const s0 = fc.seen[0];
  assert.ok(s0.url.endsWith("/models/gemini-2.5-flash-lite:generateContent") && !s0.url.includes(KEY), s0.url);
  assert.equal((s0.init?.headers as Record<string, string>)["x-goog-api-key"], KEY);
  assert.equal(s0.init?.redirect, "manual");
  assert.deepEqual((s0.body.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 0 }, "low ⇒ tắt suy nghĩ");
  assert.ok(!JSON.stringify(s0.body.tools).includes("additionalProperties"));
  assert.ok(r.stopReason === "tool_use" && r.content[0].type === "tool_use" && r.content[0].name === "search_products" && r.content[0].id.endsWith("|SIG9"), JSON.stringify(r));
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 0 }, "token suy nghĩ tính vào token ra");
  // Mức «medium» ⇒ ngân sách suy nghĩ 1024.
  const fm = fakeGemini([{ body: { candidates: [{ content: { parts: [{ text: "Dạ 280.000đ ạ" }] }, finishReason: "STOP" }], usageMetadata: {} } }]);
  const rm = await new ByokGeminiProvider({ apiKey: KEY, model: "gemini-2.5-flash", fetch: fm.fetch }).complete({ ...req, reasoning: "medium", tools: [] });
  assert.deepEqual((fm.seen[0].body.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 1024 });
  assert.ok(rm.stopReason === "end_turn" && rm.content[0].type === "text" && !("tools" in fm.seen[0].body));
  // Quá tải 503 ⇒ thử lại sau 2 giây rồi được.
  const sleeps: number[] = [];
  const fr = fakeGemini([{ status: 503, body: { error: { message: "high demand" } } }, { body: { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} } }]);
  const rr = await new ByokGeminiProvider({ apiKey: KEY, fetch: fr.fetch, sleep: async (ms) => void sleeps.push(ms) }).complete({ ...req, tools: [] });
  assert.ok(rr.content[0].type === "text" && fr.seen.length === 2 && sleeps.join(",") === "2000", JSON.stringify({ n: fr.seen.length, sleeps }));
  // 400 ⇒ ném lỗi đọc được, KHÔNG lộ khoá.
  const fe = fakeGemini([{ status: 400, body: { error: { message: `API key ${KEY} not valid` } } }]);
  await assert.rejects(new ByokGeminiProvider({ apiKey: KEY, fetch: fe.fetch }).complete({ ...req, tools: [] }), (e: Error) => /HTTP 400/.test(e.message) && !e.message.includes(KEY));

  // ── Giá: cùng bảng bot nhà; tiền tố dài nhất (flash-lite không bị tính giá flash) ──
  assert.equal(estimateCostUsd("gemini-2.5-flash-lite", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0.5);
  assert.equal(estimateCostUsd("gemini-2.5-flash-001", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0.3);

  // ── Kết nối: sổ + kiểm tra (chỉ đọc, khoá ở header, không ở URL) + chatbot chọn được ──
  const c = CONNECTORS.find((x) => x.key === "gemini-byok");
  assert.ok(c && c.tenancy === "PER_ORG" && c.settings.some((st) => st.key === "apiKey" && st.secret) && ORG_CONNECTION_TESTERS["gemini-byok"], "kết nối gemini-byok theo tổ chức");
  assert.ok((SALES_BOT_CONNECTORS as readonly string[]).includes("gemini-byok"));
  const ft = fakeGemini([{ body: { models: [] } }]);
  assert.ok((await testGeminiKey({ secrets: { apiKey: KEY } }, { fetch: ft.fetch })).ok);
  assert.ok(ft.seen[0].url === GEMINI_MODELS_URL && ft.seen[0].init?.method === "GET" && (ft.seen[0].init?.headers as Record<string, string>)["x-goog-api-key"] === KEY);
  assert.ok(!(await testGeminiKey({ secrets: { apiKey: "sk-sai-dang" } }, { fetch: ft.fetch })).ok, "sai dạng ⇒ không gửi");
  assert.equal(ft.seen.length, 1);

  console.log("✓ Gemini cho chatbot: hội thoại / tool / chữ ký suy nghĩ đúng định dạng · khoá ở header · suy nghĩ theo mức · 503 thử lại · lỗi không lộ khoá · giá theo bảng bot nhà · kết nối gemini-byok kiểm chỉ đọc");
}

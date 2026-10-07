/**
 * ═══════════ PLATFORM AI MODEL CONTROL (06/10/2026 · docs/platform/ai-model-control.md) ═══════════
 *
 * Chuyển AI dùng chung từ `gemini-3.5-flash-lite` sang `gemini-2.5-flash-lite` mà KHÔNG được làm gián đoạn bot production.
 * Bài này khoá:
 *   ① model của khoá nền tảng resolve từ `PLATFORM_AI_MODEL` (trống ⇒ mặc định), model không giá ⇒ tắt;
 *   ② bảng giá: 2.5-flash-lite 0,10 / 0,40 · 3.5-flash-lite 0,30 / 2,50 USD mỗi 1M token, và phép tính chi phí;
 *   ③ chính sách: hỏng hình / tắt / chưa hiệu lực / model không giá ⇒ ĐÚNG model của biến môi trường (hành vi cũ);
 *      canary băm ỔN ĐỊNH theo hội thoại, 100% = áp dụng;
 *   ④ model mới hỏng (404 «no longer available») ⇒ CÙNG lượt đi lại bằng model dự phòng, khách không thấy gì; lượt hỏng là
 *      một dòng ERROR (token / tiền NULL — chưa biết, không phải 0); lượt thành công ghi ĐÚNG model đã chạy;
 *   ⑤ kiểm khả dụng phân biệt available · 404 · 401/403 · 429 · lỗi khác, không bao giờ để khoá lọt vào URL / câu lỗi;
 *   ⑥ quy trình người vận hành: chưa kiểm ⇒ không cho đổi; khách / người không có `platform:operate` ⇒ không đổi được;
 *      hoàn tác trả về bản trước / tắt; mọi lượt có nhật ký nền tảng;
 *   ⑦ sổ AI của engine tách dòng khi model đổi giữa lượt.
 * Không gọi mạng thật (luật 65): `fetch` giả, môi trường giả.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { estimateCostUsd, giaCuaModel, type AiProvider, type AiRequest, type AiResponse } from "@/lib/ai/provider";
import { platformProvider, platformRoute } from "@/lib/ai-builder/provider";
import { resetPlatformPrimarySkipForTests, withPlatformFallback, type PlatformPrimaryFailure } from "@/lib/ai-builder/platform-fallback";
import type { SessionUser } from "@/lib/auth/session";
import { PLATFORM_GEMINI_DEFAULT_MODEL, platformAiConfig } from "@/lib/ai-usage/platform-ai";
import { applyPlatformAiPolicyAsScript, controlStage, estimateSwitch, loadPlatformAiControl, PLATFORM_AI_PROBES_KEY, probePlatformAiModelAsOperator, probeWithPlatformKey, rollbackPlatformAiPolicy, rollbackPlatformAiPolicyAsScript, SCRIPT_WRITER_LABEL, setPlatformAiPolicy } from "@/lib/ai-usage/platform-ai-admin";
import { abVerdict, AB_RULES, armStats, quantile, readPlatformModelAbForScript, type AbConversation } from "@/lib/ai-usage/platform-ai-ab";
import { canaryBucket, invalidatePlatformAiPolicy, readConversationPlatformModels, parsePlatformAiPolicy, PLATFORM_AI_POLICY_KEY, readPlatformAiPolicy, routePlatformModel, type PlatformAiPolicy } from "@/lib/ai-usage/platform-ai-policy";
import { classifyProbe, probeRequestBody, redactProbeMessage } from "@/lib/ai-usage/platform-model-probe";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";

const PLAT_KEY = `AIza${"p".repeat(35)}`;
const M25 = "gemini-2.5-flash-lite";
const M35 = "gemini-3.5-flash-lite";
const NOW = new Date("2026-10-06T08:00:00Z");
const envOf = (vars: Record<string, string>) => (name: string) => vars[name];
const GEMINI_ENV = envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: PLAT_KEY, PLATFORM_AI_PROVIDER: "gemini" });
const GONE = `models/${M25} is no longer available to new users. Please update your code to use a newer model.`;

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "pam-user", email: "pam@local", name: "PAM", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

function policy(over: Partial<PlatformAiPolicy> = {}): PlatformAiPolicy {
  return { enabled: true, provider: "gemini", primaryModel: M25, fallbackModel: M35, canaryPct: 100, effectiveFrom: "2026-10-01T00:00:00.000Z", reason: "giảm chi phí", changedBy: "op@local", changedAt: "2026-10-01T00:00:00.000Z", cohortSince: "2026-10-01T00:00:00.000Z", previous: null, ...over };
}

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
/** Gemini giả: trả lời theo model trong URL. */
function fakeGemini(byModel: Record<string, { status: number; body: unknown } | (() => never)>) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const model = /models\/([^:]+):/.exec(url)?.[1] ?? "";
    const r = byModel[decodeURIComponent(model)];
    if (!r) return new Response(JSON.stringify({ error: { message: "không khai" } }), { status: 500 });
    if (typeof r === "function") return r();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen };
}
const okBody = (model: string, text = "pong") => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 }, modelVersion: model });
const REQ: AiRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "Chả mực bao nhiêu?" }] }], tools: [] };

// ─────────────────────────── ① + ② cấu hình và giá ───────────────────────────

function testConfigAndPrices() {
  const def = platformAiConfig(GEMINI_ENV);
  assert.ok(def.ready && def.model === PLATFORM_GEMINI_DEFAULT_MODEL && def.model === M35, "trống ⇒ mặc định 3.5-flash-lite (hành vi production hiện tại)");
  const v25 = platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: PLAT_KEY, PLATFORM_AI_PROVIDER: "gemini", PLATFORM_AI_MODEL: ` ${M25} ` }));
  assert.ok(v25.ready && v25.model === M25, "PLATFORM_AI_MODEL thắng mặc định (đã cắt khoảng trắng)");
  assert.equal(platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: PLAT_KEY, PLATFORM_AI_PROVIDER: "gemini", PLATFORM_AI_MODEL: "gemini-9-chua-co-gia" })).ready, false, "model không có giá ⇒ tắt, không rơi về model khác");

  assert.deepEqual(giaCuaModel(M25), { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 });
  assert.equal(giaCuaModel(M35)?.input, 0.3);
  assert.equal(giaCuaModel(M35)?.output, 2.5);
  assert.equal(giaCuaModel(`${M25}-001`)?.input, 0.1, "modelVersion có hậu tố vẫn tra đúng giá (tiền tố dài nhất)");
  const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.ok(Math.abs((estimateCostUsd(M25, u) ?? NaN) - 0.5) < 1e-9, "2.5: 0,10 + 0,40");
  assert.ok(Math.abs((estimateCostUsd(M35, u) ?? NaN) - 2.8) < 1e-9, "3.5: 0,30 + 2,50");
  assert.equal(estimateCostUsd("model-la", u), null, "không giá ⇒ CHƯA BIẾT, không phải 0");

  // Ước tính khi đổi: cùng token 30 ngày × giá ứng viên.
  const rows = [{ model: M35, requests: 100, errors: 2, inputTokens: 10_000_000, outputTokens: 1_000_000, costUsd: 5.5, unpricedRequests: 0 }];
  const e = estimateSwitch(rows, { input: 0.1, output: 0.4 });
  assert.ok(Math.abs((e.estimatedUsd ?? NaN) - 1.4) < 1e-9 && Math.abs((e.savingsPct ?? NaN) - ((5.5 - 1.4) / 5.5) * 100) < 1e-9, JSON.stringify(e));
  assert.equal(estimateSwitch([{ ...rows[0], unpricedRequests: 3 }], { input: 0.1, output: 0.4 }).savingsPct, null, "có lượt chưa định giá ⇒ chi phí hiện tại là cận dưới ⇒ không in % tiết kiệm");
  assert.equal(estimateSwitch([], { input: 0.1, output: 0.4 }).savingsPct, null, "chưa có token ⇒ không có %");
}

// ─────────────────────────── ③ chính sách ───────────────────────────

function testPolicyRouting() {
  const priced = (m: string) => giaCuaModel(m) !== null;
  const route = (p: PlatformAiPolicy | null, key = "conv-1", now = NOW) => routePlatformModel({ baseModel: M35, provider: "gemini", policy: p, now, routingKey: key, priced });
  assert.deepEqual(route(null), { model: M35, fallbackModel: null, arm: "BASE", note: null }, "không chính sách ⇒ model của biến môi trường");
  assert.equal(route(policy({ enabled: false })).model, M35, "tắt ⇒ cũ");
  assert.equal(route(policy({ effectiveFrom: "2026-12-01T00:00:00.000Z" })).arm, "BASE", "chưa tới giờ hiệu lực ⇒ cũ");
  assert.equal(route(policy({ primaryModel: "gemini-9-khong-gia" })).model, M35, "model không giá ⇒ bỏ chính sách");
  assert.equal(route(policy({ provider: "anthropic" })).arm, "BASE", "khác nhà cung cấp ⇒ bỏ");
  assert.deepEqual(route(policy()), { model: M25, fallbackModel: M35, arm: "CANARY", note: null }, "100% ⇒ mọi lượt đi 2.5, 3.5 đỡ");
  assert.equal(route(policy({ canaryPct: 0 })).arm, "CONTROL");

  // Hình chính sách: sai một ô ⇒ null, không đoán.
  assert.ok(parsePlatformAiPolicy(policy()));
  for (const bad of [{ canaryPct: 101 }, { canaryPct: 10.5 }, { provider: "openai" }, { primaryModel: "Gemini 2.5" }, { effectiveFrom: "hôm qua" }, { enabled: "true" }]) assert.equal(parsePlatformAiPolicy({ ...policy(), ...bad }), null, JSON.stringify(bad));
  assert.equal(parsePlatformAiPolicy(null), null);

  // Canary: ổn định theo hội thoại + tỷ lệ gần đúng.
  assert.equal(canaryBucket("conv-abc"), canaryBucket("conv-abc"));
  let hit = 0;
  for (let i = 0; i < 2000; i++) if (route(policy({ canaryPct: 10 }), `conv-${i}`).arm === "CANARY") hit++;
  assert.ok(hit > 140 && hit < 260, `~10% của 2000 hội thoại đi canary (đo ${hit})`);
  const k = "conv-co-dinh";
  const arms = new Set(Array.from({ length: 20 }, () => route(policy({ canaryPct: 50 }), k).arm));
  assert.equal(arms.size, 1, "một hội thoại không nhảy model giữa hai tin");
}

// ─────────────────────────── ④ model mới hỏng ⇒ dự phòng ───────────────────────────

const fake = (model: string, fn: () => AiResponse | Error, calls: { n: number }): AiProvider => ({
  name: "gemini-platform",
  model,
  schemaDialect: "openai",
  async complete() {
    calls.n += 1;
    const r = fn();
    if (r instanceof Error) throw r;
    return r;
  },
});
const resp = (model: string): AiResponse => ({ content: [{ type: "text", text: "Dạ" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, latencyMs: 1 });

async function testFallback() {
  resetPlatformPrimarySkipForTests();
  const p = { n: 0 };
  const f = { n: 0 };
  const failures: PlatformPrimaryFailure[] = [];
  let t = 1_000;
  const w = withPlatformFallback(fake(M25, () => new Error(`Gemini trả lỗi HTTP 404: ${GONE}`), p), fake(M35, () => resp(M35), f), (x) => failures.push(x), () => t);
  const r = await w.complete(REQ);
  assert.equal(r.model, M35, "khách vẫn được trả lời bằng model dự phòng");
  assert.equal(w.model, M35, "model đọc SAU lời gọi là model VỪA phục vụ — sổ AI ghi đúng");
  assert.deepEqual(failures.map((x) => [x.model, x.fallbackModel, x.modelUnavailable]), [[M25, M35, true]]);
  await w.complete(REQ);
  assert.equal(p.n, 1, "404 model ⇒ bỏ qua model chính 1 giờ, khỏi tốn một lời gọi hỏng mỗi tin");
  t += 3_600_001;
  await w.complete(REQ);
  assert.equal(p.n, 2, "hết 1 giờ ⇒ thử lại model chính");

  resetPlatformPrimarySkipForTests();
  const p2 = { n: 0 };
  let flaky = true;
  const w2 = withPlatformFallback(fake(M25, () => (flaky ? new Error("Gemini trả lỗi HTTP 503: high demand") : resp(M25)), p2), fake(M35, () => resp(M35), { n: 0 }));
  assert.equal((await w2.complete(REQ)).model, M35);
  flaky = false;
  assert.equal((await w2.complete(REQ)).model, M25, "503 không đánh dấu ⇒ lượt sau quay lại model chính");
  assert.equal(w2.model, M25);

  const w3 = withPlatformFallback(fake(M25, () => new Error("Gemini trả lỗi HTTP 500"), { n: 0 }), fake(M35, () => new Error("Gemini trả lỗi HTTP 429: Your prepayment credits are depleted"), { n: 0 }));
  await assert.rejects(w3.complete(REQ), /prepayment credits/, "cả hai hỏng ⇒ ném lỗi của model dự phòng (engine chuyển người như cũ)");
  const w4 = withPlatformFallback(fake(M25, () => new Error("x"), { n: 0 }), fake(M35, () => resp(M35), { n: 0 }), () => {
    throw new Error("sổ hỏng");
  });
  assert.equal((await w4.complete(REQ)).model, M35, "ghi sổ hỏng không làm hỏng lượt trả lời");

  // Đường thật: định tuyến theo chính sách + provider của khoá nền tảng + Gemini giả.
  resetPlatformPrimarySkipForTests();
  const g = fakeGemini({ [M25]: { status: 404, body: { error: { message: GONE } } }, [M35]: { status: 200, body: okBody(M35) } });
  const fails: PlatformPrimaryFailure[] = [];
  const cfg = platformAiConfig(GEMINI_ENV);
  if (!cfg.ready) throw new Error("cấu hình giả phải sẵn sàng");
  const r100 = await platformRoute(cfg, "org-x", { policy: policy(), routingKey: "conv-1", now: NOW });
  const prov = platformProvider(cfg, g.fetch, r100, (x) => fails.push(x));
  const out = await prov.complete(REQ);
  assert.deepEqual(g.seen.map((s) => /models\/([^:]+):/.exec(s.url)?.[1]), [M25, M35], "gọi 2.5 trước, 404 ⇒ cùng lượt đi 3.5");
  assert.ok(g.seen.every((s) => !s.url.includes(PLAT_KEY) && s.headers["x-goog-api-key"] === PLAT_KEY), "khoá chỉ đi trong header");
  assert.equal(out.model, M35);
  assert.equal(fails.length, 1);
  const noPolicy = await platformRoute(cfg, "org-x", { policy: null, now: NOW });
  assert.equal(platformProvider(cfg, g.fetch, noPolicy).model, M35, "không chính sách ⇒ đúng provider cũ, không bọc");
  // Hoàn tác = chính sách tắt ⇒ về model của biến môi trường.
  const rolled = await platformRoute(cfg, "org-x", { policy: policy({ enabled: false }), now: NOW });
  assert.equal(rolled.model, M35);
}

// ─────────────────────────── ⑤ kiểm khả dụng ───────────────────────────

async function testProbe() {
  assert.equal(classifyProbe(200, null), "AVAILABLE");
  assert.equal(classifyProbe(404, GONE), "MODEL_UNAVAILABLE");
  assert.equal(classifyProbe(400, `* GenerateContentRequest.model: unexpected model name format ... models/${M25} is not found for API version v1beta`), "MODEL_UNAVAILABLE");
  assert.equal(classifyProbe(403, "Method doesn't allow unregistered callers"), "KEY_REJECTED");
  assert.equal(classifyProbe(400, "API key not valid. Please pass a valid API key."), "KEY_REJECTED");
  assert.equal(classifyProbe(401, null), "KEY_REJECTED");
  assert.equal(classifyProbe(429, "Resource has been exhausted"), "QUOTA");
  assert.equal(classifyProbe(400, "Your prepayment credits are depleted."), "QUOTA", "hết credit trả trước (06/10) ⇒ QUOTA, không phải model");
  assert.equal(classifyProbe(503, "The model is overloaded"), "OTHER");
  assert.equal(classifyProbe(null, "fetch failed"), "OTHER");
  assert.equal(redactProbeMessage(`bad key ${PLAT_KEY} x`, PLAT_KEY), "bad key … x");
  assert.ok(!redactProbeMessage(`key AIza${"q".repeat(35)}`, "").includes("qqqq"), "khoá khác dạng AIza… cũng bị che");
  const body = probeRequestBody(M25);
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 0 } }, "yêu cầu cực nhỏ, tắt suy nghĩ");

  const g = fakeGemini({ [M25]: { status: 404, body: { error: { message: `${GONE} key=${PLAT_KEY}` } } }, [M35]: { status: 200, body: okBody(M35) }, "gemini-3.1-flash-lite": { status: 429, body: { error: { message: "quota" } } } });
  const r = await probeWithPlatformKey([M25, M35, "gemini-3.1-flash-lite"], { fetch: g.fetch, env: GEMINI_ENV });
  assert.ok(r.ready);
  if (r.ready) {
    assert.deepEqual(r.results.map((x) => [x.model, x.verdict, x.httpStatus]), [[M25, "MODEL_UNAVAILABLE", 404], [M35, "AVAILABLE", 200], ["gemini-3.1-flash-lite", "QUOTA", 429]]);
    assert.ok(r.results.every((x) => !(x.message ?? "").includes(PLAT_KEY)), "câu lỗi không mang khoá");
    assert.equal(r.results[1].modelVersion, M35);
  }
  assert.equal(g.seen.length, 3, "MỘT lời gọi mỗi model, không thử lại");
  const off = await probeWithPlatformKey([M25], { env: envOf({}) });
  assert.equal(off.ready, false, "khoá nền tảng chưa bật ⇒ không gọi gì");
  const thrown = await probeWithPlatformKey([M25], { env: GEMINI_ENV, fetch: (async () => { throw new Error(`connect ETIMEDOUT ${PLAT_KEY}`); }) as typeof fetch });
  assert.ok(thrown.ready && thrown.results[0].verdict === "OTHER" && !(thrown.results[0].message ?? "").includes(PLAT_KEY));
}

// ─────────────────────────── ⑥ quy trình người vận hành ───────────────────────────

async function cleanupSettings() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformSettings).where(inArray(schema.platformSettings.key, [PLATFORM_AI_POLICY_KEY, PLATFORM_AI_PROBES_KEY]));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.action, ["PLATFORM_AI_MODEL_PROBE", "PLATFORM_AI_POLICY_SET", "PLATFORM_AI_POLICY_ROLLBACK"]));
  invalidatePlatformAiPolicy();
}

async function testOperatorWorkflow() {
  await cleanupSettings();
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "pam-op", email: "op@pam.local", organization: { code: home.code, name: home.name, isHome: true } });
  const viewer = sessionUser({ id: "pam-xem", email: "xem@pam.local", role: "VIEWER", permissions: ["dashboard:view"], organization: op.organization });
  const tenantAdmin = sessionUser({ id: "pam-khach", email: "qt@khach.local", permissions: ["platform:operate"], organization: { code: "khach-x", name: "Khách", isHome: false } });
  const env = GEMINI_ENV;
  try {
    // Không phải người vận hành ⇒ không đọc, không kiểm, không đổi, không hoàn tác.
    for (const u of [viewer, tenantAdmin]) {
      assert.equal((await loadPlatformAiControl(u, NOW, env)).ok, false);
      assert.ok("error" in (await probePlatformAiModelAsOperator(u, { model: M25 }, { env })));
      assert.ok("error" in (await setPlatformAiPolicy(u, { primaryModel: M25, canaryPct: 100, reason: "thu tien" }, { env, now: NOW })));
      assert.ok("error" in (await rollbackPlatformAiPolicy(u, { reason: "hoan tac" })));
    }
    assert.equal(await readPlatformAiPolicy({ fresh: true }), null, "khách không ghi được chính sách");

    // Chưa kiểm ⇒ không cho đổi.
    const before = await loadPlatformAiControl(op, NOW, env);
    assert.ok(before.ok && before.value.candidate === M25 && before.value.stage === "NEED_PROBE", JSON.stringify(before.ok ? [before.value.candidate, before.value.stage] : before));
    assert.ok("error" in (await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 10, reason: "canary giam chi phi" }, { env, now: NOW })), "chưa có lượt kiểm thành công ⇒ từ chối");

    // Kiểm ⇒ 404 ⇒ vẫn từ chối, giữ model cũ.
    const g404 = fakeGemini({ [M25]: { status: 404, body: { error: { message: GONE } } } });
    const p404 = await probePlatformAiModelAsOperator(op, { model: M25 }, { env, fetch: g404.fetch, now: NOW });
    assert.ok("ok" in p404 && p404.verdict === "MODEL_UNAVAILABLE");
    const s404 = await loadPlatformAiControl(op, NOW, env);
    assert.ok(s404.ok && s404.value.stage === "PROBE_FAILED");
    assert.ok("error" in (await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 10, reason: "canary giam chi phi" }, { env, now: NOW })), "404 ⇒ KHÔNG đổi production");
    assert.equal(await readPlatformAiPolicy({ fresh: true }), null);

    // Kiểm ⇒ 200 ⇒ chạy thử 10% ⇒ áp dụng ⇒ hoàn tác ⇒ hoàn tác.
    const g200 = fakeGemini({ [M25]: { status: 200, body: okBody(M25) } });
    const p200 = await probePlatformAiModelAsOperator(op, { model: M25 }, { env, fetch: g200.fetch, now: NOW });
    assert.ok("ok" in p200 && p200.verdict === "AVAILABLE");
    assert.ok(!JSON.stringify((await getPlatformDb().then((pdb) => pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_AI_PROBES_KEY) })))?.value).includes(PLAT_KEY), "sổ kiểm không lưu khoá");
    assert.ok("error" in (await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 10, reason: "x" }, { env, now: NOW })), "thiếu lý do");
    assert.ok("error" in (await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 0, reason: "canary giam chi phi" }, { env, now: NOW })));
    assert.ok("error" in (await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 10, reason: "canary giam chi phi" }, { env, now: new Date(NOW.getTime() + 25 * 3_600_000) })), "lượt kiểm quá 24 giờ ⇒ phải kiểm lại");
    const canary = await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 10, reason: "canary giam chi phi" }, { env, now: NOW });
    assert.ok("ok" in canary, JSON.stringify(canary));
    const p1 = await readPlatformAiPolicy({ fresh: true });
    assert.ok(p1 && p1.primaryModel === M25 && p1.fallbackModel === M35 && p1.canaryPct === 10 && p1.previous === null && p1.changedBy === op.email);
    const sCanary = await loadPlatformAiControl(op, NOW, env);
    assert.ok(sCanary.ok && sCanary.value.stage === "CANARY" && sCanary.value.currentModel === M35, "10% ⇒ phần lớn vẫn 3.5");
    assert.ok("ok" in (await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 100, reason: "canary on, ap dung" }, { env, now: NOW })));
    const sApplied = await loadPlatformAiControl(op, NOW, env);
    assert.ok(sApplied.ok && sApplied.value.stage === "APPLIED" && sApplied.value.currentModel === M25);
    assert.ok(sApplied.ok && sApplied.value.prices.current?.output === 2.5 && sApplied.value.prices.candidate?.output === 0.4, "so giá: 3.5 → 2.5");
    const p2 = await readPlatformAiPolicy({ fresh: true });
    assert.equal(p2?.previous?.canaryPct, 10, "bản trước được giữ để hoàn tác");

    assert.ok("ok" in (await rollbackPlatformAiPolicy(op, { reason: "loi tang sau khi doi" }, { now: NOW })));
    const p3 = await readPlatformAiPolicy({ fresh: true });
    assert.ok(p3?.enabled && p3.canaryPct === 10, "hoàn tác ⇒ về đúng bản trước (canary 10%)");
    // Hoàn tác khi bản trước là "chưa có chính sách": đặt chính sách mới từ trạng thái trống rồi hoàn tác ⇒ TẮT.
    await cleanupSettings();
    await probePlatformAiModelAsOperator(op, { model: M25 }, { env, fetch: g200.fetch, now: NOW });
    await setPlatformAiPolicy(op, { primaryModel: M25, canaryPct: 100, reason: "ap dung thang" }, { env, now: NOW });
    assert.ok("ok" in (await rollbackPlatformAiPolicy(op, { reason: "quay ve model cu" }, { now: NOW })));
    const p4 = await readPlatformAiPolicy({ fresh: true });
    assert.equal(p4?.enabled, false, "không có bản trước ⇒ chính sách TẮT");
    const cfg = platformAiConfig(env);
    assert.ok(cfg.ready);
    if (cfg.ready) assert.equal((await platformRoute(cfg, "org-x", { routingKey: "conv-9", now: NOW })).model, M35, "sau hoàn tác, đường nóng đọc chính sách đã lưu ⇒ model của biến môi trường");

    const pdb = await getPlatformDb();
    const audit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, home.code), inArray(schema.platformAuditLog.action, ["PLATFORM_AI_MODEL_PROBE", "PLATFORM_AI_POLICY_SET", "PLATFORM_AI_POLICY_ROLLBACK"])));
    assert.ok(audit.some((a) => a.action === "PLATFORM_AI_POLICY_SET" && a.actorEmail === op.email && a.reason === "ap dung thang"));
    assert.ok(audit.some((a) => a.action === "PLATFORM_AI_POLICY_ROLLBACK" && a.reason === "quay ve model cu"));
    assert.ok(audit.every((a) => !JSON.stringify([a.before, a.after]).includes(PLAT_KEY)), "nhật ký không mang khoá");

    // Đường ops: kiểm lại NGAY trước khi ghi — 404 thì không ghi gì; 200 thì ghi, người làm = máy, nguồn SCRIPT.
    await cleanupSettings();
    const sc404 = await applyPlatformAiPolicyAsScript({ primaryModel: M25, canaryPct: 100, reason: "ops ap dung" }, { env, fetch: g404.fetch, now: NOW });
    assert.ok("error" in sc404 && sc404.verdict === "MODEL_UNAVAILABLE", JSON.stringify(sc404));
    assert.equal(await readPlatformAiPolicy({ fresh: true }), null, "khoá không gọi được 2.5 ⇒ production KHÔNG đổi");
    const s200 = await applyPlatformAiPolicyAsScript({ primaryModel: M25, canaryPct: 100, reason: "ops ap dung" }, { env, fetch: g200.fetch, now: NOW });
    assert.ok("ok" in s200, JSON.stringify(s200));
    const ps = await readPlatformAiPolicy({ fresh: true });
    assert.ok(ps?.enabled && ps.primaryModel === M25 && ps.fallbackModel === M35 && ps.changedBy === SCRIPT_WRITER_LABEL);
    assert.ok("ok" in (await rollbackPlatformAiPolicyAsScript({ reason: "ops hoan tac" }, { now: NOW })));
    assert.equal((await readPlatformAiPolicy({ fresh: true }))?.enabled, false);
    const pdbS = await getPlatformDb();
    const scriptRows = await pdbS.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.source, "SCRIPT"), inArray(schema.platformAuditLog.action, ["PLATFORM_AI_POLICY_SET", "PLATFORM_AI_POLICY_ROLLBACK"])));
    assert.ok(scriptRows.length === 2 && scriptRows.every((a) => a.actorUserId === null && a.actorEmail === null), "ops ⇒ nhật ký nguồn SCRIPT, người làm = máy");

    // Bước của quy trình (thuần).
    assert.equal(controlStage({ keyReady: false, policy: null, candidate: M25, probe: undefined, now: NOW }), "KEY_OFF");
    assert.equal(controlStage({ keyReady: true, policy: null, candidate: null, probe: undefined, now: NOW }), "NO_CANDIDATE");
  } finally {
    await cleanupSettings();
  }
}

// ─────────────────────────── ⑦ sổ AI của engine ghi đúng model thật ───────────────────────────

const ORG = "pam-ledger";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testLedger() {
  await cleanupOrg();
  resetPlatformPrimarySkipForTests();
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "Ledger@12345" }, source: "TEST", actor: null });
  // Vòng 1: model mới gọi công cụ (OK, 2.5). Vòng 2: model mới hỏng 404 ⇒ model dự phòng trả lời (3.5).
  let round = 0;
  const primary: AiProvider = {
    name: "gemini-byok",
    model: M25,
    schemaDialect: "openai",
    async complete() {
      round += 1;
      if (round === 1) return { content: [{ type: "tool_use", id: "g0_x", name: "search_products", input: { query: "chả mực" } }], stopReason: "tool_use", usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: M25, latencyMs: 1 };
      throw new Error(`Gemini trả lỗi HTTP 404: ${GONE}`);
    },
  };
  const fallback: AiProvider = { name: "gemini-byok", model: M35, schemaDialect: "openai", complete: async () => ({ content: [{ type: "text", text: "Dạ chả mực 400.000đ ạ." }], stopReason: "end_turn", usage: { inputTokens: 2000, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: M35, latencyMs: 1 }) };
  const failed: PlatformPrimaryFailure[] = [];
  setSalesChatProviderForTests(() => withPlatformFallback(primary, fallback, (f) => failed.push(f)));
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const v = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true, connectorKey: "gemini-byok" });
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: v }).onConflictDoUpdate({ target: schema.settings.key, set: { value: v } });
      const vk = visitorKeyOf("pam-ledger-0123456789abcdef");
      const w = await openConversation("WEB", { visitorKey: vk });
      const r = await chatTurn(w.id, "Chả mực bao nhiêu?", { channel: "WEB", visitorKey: vk });
      assert.ok(r.ok, r.ok ? "" : r.error);
      const pdb = await getPlatformDb();
      const rows = (await pdb.select().from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG))).filter((u) => u.ref === w.id && u.status === "OK" && u.requests > 0);
      const by = new Map(rows.map((u) => [u.model, u]));
      assert.equal(rows.length, 2, `đổi model giữa lượt ⇒ hai dòng, mỗi dòng một model: ${JSON.stringify(rows.map((u) => [u.model, u.requests]))}`);
      const r25 = by.get(M25);
      const r35 = by.get(M35);
      assert.ok(r25 && r25.inputTokens === 1000 && r25.outputTokens === 50 && Math.abs((r25.costUsd ?? NaN) - (1000 * 0.1 + 50 * 0.4) / 1e6) < 1e-12, JSON.stringify(r25));
      assert.ok(r35 && r35.inputTokens === 2000 && r35.outputTokens === 80 && Math.abs((r35.costUsd ?? NaN) - (2000 * 0.3 + 80 * 2.5) / 1e6) < 1e-12, JSON.stringify(r35));
      assert.equal(failed.length, 1, "lượt hỏng của model mới được báo để ghi một dòng ERROR");

      // ── A/B trên hai sổ THẬT: 12 hội thoại canary (3.1) · 12 đối chứng (3.5) · 1 hội thoại khung thử (bị loại) ──
      await cleanupSettings();
      const M31 = "gemini-3.1-flash-lite";
      const start = new Date(Date.now() - 3_600_000);
      const g31 = fakeGemini({ [M31]: { status: 200, body: okBody(M31) } });
      const ap = await applyPlatformAiPolicyAsScript({ primaryModel: M31, canaryPct: 10, reason: "canary 3.1" }, { env: GEMINI_ENV, fetch: g31.fetch, now: start });
      assert.ok("ok" in ap, JSON.stringify(ap));
      const conv = schema.salesChatConversations;
      const ev = schema.salesConversationEvents;
      const mkConv = async (channel: string, phone: string | null) => (await db.insert(conv).values({ channel, customerPhone: phone }).returning({ id: conv.id }))[0].id;
      const evt = (conversationId: string, type: string, payload: Record<string, unknown> = {}) => ({ conversationId, type, actorKind: "AI", channel: "WEB", occurredAt: new Date(), payload, dedupeKey: `pam:${conversationId}:${type}` });
      const ledger: (typeof schema.platformAiUsage.$inferInsert)[] = [];
      const row = (ref: string, model: string, status: "OK" | "ERROR", inT: number | null, outT: number | null, cost: number | null) => ledger.push({ orgCode: ORG, feature: "sales_chatbot", billingSource: "PLATFORM", provider: "gemini-platform", model, requests: 1, inputTokens: inT, outputTokens: outT, costUsd: cost, status, ref });
      for (let i = 0; i < 12; i++) {
        // Canary: mọi hội thoại có SĐT + địa chỉ, 9/12 chốt; 1 lượt hỏng 3.1 được 3.5 đỡ ở hội thoại đầu.
        const c = await mkConv("WEB", null);
        await db.insert(ev).values([evt(c, "customer.identified", { simulated: false }), evt(c, "ai.replied", { mode: "AI", responseMs: 1000 + i * 100 }), ...(i < 9 ? [evt(c, "order.confirmed", { simulated: false })] : i === 11 ? [evt(c, "order.confirmed", { simulated: true })] : [])]);
        await db.insert(schema.salesChatMessages).values({ conversationId: c, seq: 1, role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "{}" }, { type: "tool_result", toolUseId: "t2", content: "{}", isError: i === 0 }] });
        row(c, M31, "OK", 4000, 100, (4000 * 0.25 + 100 * 1.5) / 1e6);
        if (i === 0) {
          row(c, M31, "ERROR", null, null, null);
          row(c, M35, "OK", 4000, 100, (4000 * 0.3 + 100 * 2.5) / 1e6);
        }
        // Đối chứng: SĐT ở cột hội thoại cho 10/12, địa chỉ 8/12, chốt 6/12, handoff 2/12.
        const k = await mkConv("FANPAGE", i < 10 ? "0912000000" : null);
        await db.insert(ev).values([evt(k, "ai.replied", { mode: "AI", responseMs: 2000 }), ...(i < 8 ? [evt(k, "customer.identified", { simulated: false })] : []), ...(i < 6 ? [evt(k, "order.confirmed", { simulated: false })] : []), ...(i >= 10 ? [evt(k, "handoff.requested")] : [])]);
        row(k, M35, "OK", 4000, 100, (4000 * 0.3 + 100 * 2.5) / 1e6);
      }
      const t = await mkConv("TEST", "0912000001");
      await db.insert(ev).values([evt(t, "order.confirmed", { simulated: true })]);
      row(t, M31, "OK", 1, 1, 0);
      await pdb.insert(schema.platformAiUsage).values(ledger);

      // Ghim nhánh: hội thoại đã chạy 3.1 (kể cả dòng ERROR) đọc ra 3.1.
      const firstCanary = ledger[0].ref as string;
      assert.deepEqual((await readConversationPlatformModels(ORG, firstCanary)).sort(), [M31, M35].sort());

      const ab = await readPlatformModelAbForScript(new Date(), GEMINI_ENV);
      assert.ok(ab, "có chính sách ⇒ có báo cáo");
      if (ab) {
        assert.equal(ab.canary.conversations, 12, "khung thử bị loại");
        assert.equal(ab.control.conversations, 12);
        assert.equal(ab.canary.model, M31);
        assert.equal(ab.control.model, M35);
        assert.equal(ab.canary.orders, 9, "đơn mô phỏng không tính");
        assert.equal(ab.canary.closeRate, 9 / 12);
        assert.equal(ab.control.closeRate, 6 / 12);
        assert.equal(ab.canary.phoneRate, 1);
        assert.equal(ab.control.phoneRate, 10 / 12, "SĐT ở cột hội thoại cũng tính");
        assert.equal(ab.control.addressRate, 8 / 12);
        assert.equal(ab.control.handoffRate, 2 / 12);
        assert.equal(ab.canary.requests, 14);
        assert.equal(ab.canary.errorRate, 1 / 14, "lượt hỏng của 3.1 được 3.5 đỡ vẫn là lỗi của cohort canary");
        assert.equal(ab.canary.toolSuccessRate, 23 / 24);
        assert.equal(ab.control.toolSuccessRate, null, "không có công cụ ⇒ chưa đo");
        assert.equal(ab.canary.p50Ms, quantile(Array.from({ length: 12 }, (_, i) => 1000 + i * 100), 0.5));
        const canaryCost = 12 * ((4000 * 0.25 + 100 * 1.5) / 1e6) + (4000 * 0.3 + 100 * 2.5) / 1e6;
        assert.ok(Math.abs((ab.canary.costPerConvUsd ?? NaN) - canaryCost / 12) < 1e-12, "chi phí canary gồm cả lượt 3.5 đỡ");
        assert.ok(Math.abs((ab.canary.costPerOrderUsd ?? NaN) - canaryCost / 9) < 1e-12);
        assert.equal(ab.verdict.decision, "INSUFFICIENT_DATA", "12 < 200 hội thoại và 9 < 50 đơn ⇒ giữ nấc");
      }

      // Tăng nấc với CÙNG cặp model ⇒ giữ mốc cohort; đổi cặp ⇒ mốc mới.
      const before30 = await readPlatformAiPolicy({ fresh: true });
      assert.ok("ok" in (await applyPlatformAiPolicyAsScript({ primaryModel: M31, canaryPct: 30, reason: "len 30" }, { env: GEMINI_ENV, fetch: g31.fetch, now: new Date() })));
      const after30 = await readPlatformAiPolicy({ fresh: true });
      assert.ok(before30 && after30 && after30.canaryPct === 30 && after30.cohortSince === before30.cohortSince, "tăng nấc giữ cohort");
    });
  } finally {
    setSalesChatProviderForTests(null);
    resetPlatformPrimarySkipForTests();
    await cleanupSettings();
    await cleanupOrg();
  }
}

// ─────────────────────────── ⑧ ghim nhánh + luật quyết định A/B (thuần) ───────────────────────────

async function testStickyAndVerdict() {
  const priced = (m: string) => giaCuaModel(m) !== null;
  const M31 = "gemini-3.1-flash-lite";
  const p10 = policy({ primaryModel: M31, canaryPct: 10 });
  const route = (p: PlatformAiPolicy | null, key: string, prior: string[]) => routePlatformModel({ baseModel: M35, provider: "gemini", policy: p, now: NOW, routingKey: key, priced, prior });
  // Tìm một khoá rơi vào ô ≥ 10 (đối chứng) và một khoá < 10 (canary).
  let ctl = "";
  let can = "";
  for (let i = 0; (!ctl || !can) && i < 1000; i++) {
    const k = `conv-${i}`;
    if (canaryBucket(k) < 10) can ||= k;
    else if (canaryBucket(k) >= 50) ctl ||= k;
  }
  assert.equal(route(p10, can, []).arm, "CANARY");
  assert.equal(route(p10, ctl, []).arm, "CONTROL");
  assert.equal(route(p10, ctl, [M31]).arm, "CANARY", "đã chạy 3.1 ⇒ giữ 3.1 dù ô băm là đối chứng");
  assert.equal(route(p10, can, [M35]).arm, "CONTROL", "hội thoại mở trước canary (chỉ có 3.5) ⇒ không đổi model giữa chừng");
  assert.equal(route(policy({ primaryModel: M31, canaryPct: 100 }), can, [M35]).arm, "CONTROL", "lên 100% vẫn không kéo hội thoại đang dở");
  assert.equal(route(policy({ primaryModel: M31, enabled: false }), can, [M31]).arm, "BASE", "hoàn tác thắng ghim: về model ổn định ngay");

  // Đường nóng chỉ hỏi sổ AI khi chính sách đang chạy.
  const cfg = platformAiConfig(GEMINI_ENV);
  if (!cfg.ready) throw new Error("cấu hình giả phải sẵn sàng");
  let asked = 0;
  const priorModels = async () => {
    asked++;
    return [M31];
  };
  await platformRoute(cfg, "org-x", { policy: null, routingKey: ctl, now: NOW, priorModels });
  await platformRoute(cfg, "org-x", { policy: policy({ primaryModel: M31, enabled: false }), routingKey: ctl, now: NOW, priorModels });
  assert.equal(asked, 0, "không chạy thử ⇒ không tốn câu đọc sổ nào");
  assert.equal((await platformRoute(cfg, "org-x", { policy: p10, routingKey: ctl, now: NOW, priorModels })).model, M31);
  assert.equal(asked, 1);

  // Luật quyết định.
  const conv = (over: Partial<AbConversation>): AbConversation => ({ arm: "CANARY", requests: 2, errors: 0, inputTokens: 4000, outputTokens: 100, costUsd: 0.001, unpriced: false, phone: true, address: true, orders: 1, handoff: false, upsellOffered: false, upsellAccepted: false, toolResults: 4, toolErrors: 0, responseMs: [1500], ...over });
  const many = (n: number, f: (i: number) => Partial<AbConversation>) => Array.from({ length: n }, (_, i) => conv(f(i)));
  const control = armStats(M35, many(1800, (i) => ({ arm: "CONTROL", orders: i % 2 ? 0 : 1, costUsd: 0.0013 })));
  const good = armStats(M31, many(200, (i) => ({ orders: i % 2 ? 0 : 1, costUsd: 0.001 })));
  const ctx = { currentPct: 10, hoursSinceChange: 30, enabled: true };
  const pv = abVerdict(good, control, ctx);
  assert.deepEqual([pv.decision, pv.nextPct], ["PROMOTE", 30], JSON.stringify(pv));
  assert.deepEqual([abVerdict(good, control, { ...ctx, currentPct: 30 }).nextPct, abVerdict(good, control, { ...ctx, currentPct: 50 }).nextPct], [50, 100], "10 → 30 → 50 → 100");
  assert.equal(abVerdict(good, control, { ...ctx, currentPct: 100 }).decision, "DONE");
  assert.equal(abVerdict(good, control, { ...ctx, hoursSinceChange: 5 }).decision, "HOLD", "mỗi nấc ≥ 24 giờ");
  assert.equal(abVerdict(armStats(M31, many(199, (i) => ({ orders: i % 5 === 0 ? 1 : 0, costUsd: 0.001 }))), control, ctx).decision, "INSUFFICIENT_DATA", "199 hội thoại · 40 đơn ⇒ chưa đủ mẫu, chưa kết luận gì");
  assert.equal(abVerdict(armStats(M31, many(60, () => ({ orders: 1, costUsd: 0.001 }))), control, ctx).decision, "PROMOTE", "≥ 50 đơn cũng là đủ mẫu");
  const lowClose = armStats(M31, many(200, (i) => ({ orders: i % 5 === 0 ? 1 : 0, costUsd: 0.001 })));
  assert.equal(abVerdict(lowClose, control, ctx).decision, "ROLLBACK", "chốt giảm > 5% tương đối ⇒ hoàn tác");
  const cheapNotEnough = armStats(M31, many(200, (i) => ({ orders: i % 2 ? 0 : 1, costUsd: 0.0012 })));
  assert.equal(abVerdict(cheapNotEnough, control, ctx).decision, "ROLLBACK", "rẻ hơn < 15% ⇒ không thắng");
  const noPhone = armStats(M31, many(200, (i) => ({ orders: i % 2 ? 0 : 1, costUsd: 0.001, phone: i % 4 !== 0 })));
  assert.equal(abVerdict(noPhone, control, ctx).decision, "ROLLBACK", "SĐT giảm 25% ⇒ hoàn tác");
  const badTools = armStats(M31, many(200, (i) => ({ orders: i % 2 ? 0 : 1, costUsd: 0.001, toolErrors: i % 10 === 0 ? 1 : 0 })));
  assert.equal(abVerdict(badTools, control, ctx).decision, "ROLLBACK", "công cụ đúng giảm 2,5 điểm ⇒ hoàn tác");
  const severe = armStats(M31, many(30, () => ({ errors: 1, requests: 4 })));
  assert.equal(abVerdict(severe, control, ctx).decision, "ROLLBACK", "lỗi tăng 25 điểm khi mới 30 hội thoại ⇒ hoàn tác ngay");
  const unpriced = armStats(M31, many(200, (i) => ({ orders: i % 2 ? 0 : 1, unpriced: i === 0 })));
  assert.equal(abVerdict(unpriced, control, ctx).decision, "HOLD", "có lượt chưa định giá ⇒ chi phí là cận dưới ⇒ chưa kết luận");
  assert.equal(armStats(M31, many(9, () => ({}))).closeRate, null, "dưới 10 hội thoại ⇒ tỷ lệ CHƯA ĐỦ, không phải 0");
  assert.equal(AB_RULES.steps.join(","), "10,30,50,100");
}

export async function testPlatformAiModel() {
  testConfigAndPrices();
  testPolicyRouting();
  await testFallback();
  await testProbe();
  await testOperatorWorkflow();
  await testStickyAndVerdict();
  await testLedger();
  console.log("✓ Platform AI Model Control: PLATFORM_AI_MODEL resolve đúng, giá 2.5 / 3.5 đúng · chính sách hỏng / tắt / chưa hiệu lực ⇒ model cũ, canary băm ổn định · 404 ⇒ cùng lượt đi model dự phòng, lượt hỏng là ERROR không token · kiểm khả dụng tách 5 lớp, không lộ khoá · chưa kiểm / 404 / khách ⇒ không đổi được · hoàn tác về bản trước hoặc tắt · sổ AI tách dòng theo model thật · canary ghim theo hội thoại, tăng nấc giữ cohort · A/B đo chốt / SĐT / địa chỉ / handoff / lỗi / p95 / công cụ / chi phí từ hai sổ thật, đề xuất giữ · lên nấc · hoàn tác đúng luật chủ nền tảng");
}

if (/platform-ai-model\.test\.ts$/.test(process.argv[1] ?? "")) {
  testPlatformAiModel().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

/**
 * ═══════════ KHOÁ AI CHÍNH → KHOÁ DỰ PHÒNG → NGƯỜI (lib/sales-chatbot/provider-failover.ts · 06/10/2026) ═══════════
 *
 * Sự cố thật: Google AI Studio hết credit trả trước 11:38 ⇒ khoá BYOK của shop VÀ khoá nền tảng hỏng cùng lúc ⇒ bot im ~2 giờ.
 *
 * Khoá:
 *  · PHÂN LOẠI: hết credit (câu thật của Google) · hết giờ · 5xx · mất kết nối ⇒ chuyển; 400 nội dung · lỗi lạ ⇒ KHÔNG chuyển.
 *    Bộ phân loại THÔ cũ (`classifyAiError` / `salesBotError`) giữ nguyên câu trả lời — «Request timed out.» vẫn là OTHER.
 *  · NGẮT MẠCH (hàm thuần): credit / khoá ⇒ mở lâu; quá tải / 5xx / hết giờ LIÊN TIẾP N lần ⇒ mở ngắn; hết hạn ⇒ nửa mở,
 *    đúng MỘT lượt thử; thử hỏng ⇒ mở lại ngay; thành công ⇒ đóng. Ghi CSDL chỉ khi trạng thái đổi.
 *  · PROVIDER BỌC (giả, không gọi mạng — luật 65): CREDIT / TIMEOUT / 5xx ⇒ khoá dự phòng trả lời; 400 ⇒ không gọi khoá dự
 *    phòng; mạch mở ⇒ bỏ qua khoá chính; nửa mở ⇒ thử khoá chính, khoẻ ⇒ quay về; cả hai hỏng ⇒ ném lỗi; KHÔNG GỬI TRÙNG.
 *  · ENGINE (CSDL thật của một tổ chức thử): khoá chính hết credit ⇒ khách nhận ĐÚNG MỘT câu, của khoá dự phòng; sổ AI có
 *    một dòng ERROR của khoá chính + một dòng `+failover`; lượt sau bỏ qua khoá chính; cả hai hỏng ⇒ HANDOFF như cũ; không
 *    cấu hình dự phòng ⇒ hành vi cũ (một lời gọi, HANDOFF, không ghi sổ sức khoẻ).
 *
 * Mốc thời gian đi theo ĐỒNG HỒ GIẢ dựng từ `Date.now()` lúc chạy (luật 50 / 65) — không ngày tuyệt đối nào.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { classifyAiError, classifyAiFailure } from "@/lib/constants/ai-incidents";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, effectiveFallback, parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY, salesBotError, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import {
  circuitState,
  EMPTY_HEALTH,
  FAILOVER_LABEL_SUFFIX,
  FAILOVER_RULE,
  FailoverProvider,
  nextHealth,
  parseProviderHealth,
  planAttempts,
  PROVIDER_HEALTH_SETTING_KEY,
  resetProviderHealthCacheForTests,
  shouldPersistHealth,
  type FailedAttempt,
  type FailoverCandidate,
  type ProviderHealthEntry,
  type ProviderHealthState,
  type ProviderHealthStore,
} from "@/lib/sales-chatbot/provider-failover";

const GOOGLE_CREDIT = "Gemini trả lỗi HTTP 429: Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.";
const LONG_MS = 30 * 60_000;

function testClassify() {
  assert.equal(classifyAiFailure(GOOGLE_CREDIT), "CREDIT", "câu thật của Google 06/10 ⇒ CREDIT (chuyển + ngắt lâu)");
  assert.equal(classifyAiFailure("400 {\"type\":\"error\",\"error\":{\"message\":\"Your credit balance is too low to access the Anthropic API.\"}}"), "CREDIT");
  assert.equal(classifyAiFailure("401 invalid_api_key"), "AUTH");
  assert.equal(classifyAiFailure("429 rate_limit_error: too many requests"), "RATE_LIMIT");
  assert.equal(classifyAiFailure("Request timed out."), "TIMEOUT", "SDK Anthropic / OpenAI hết giờ");
  assert.equal(classifyAiFailure("The operation was aborted due to timeout"), "TIMEOUT", "AbortSignal.timeout của provider Gemini");
  assert.equal(classifyAiFailure("Gemini trả lỗi HTTP 500: Internal error encountered."), "SERVER_ERROR");
  assert.equal(classifyAiFailure('500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), "SERVER_ERROR");
  assert.equal(classifyAiFailure("fetch failed"), "SERVER_ERROR", "mất kết nối tới nhà cung cấp");
  assert.equal(classifyAiFailure("Connection error."), "SERVER_ERROR");
  assert.equal(classifyAiFailure("Gemini trả lỗi HTTP 404: models/gemini-2.5-flash-lite is no longer available to new users"), "MODEL_UNAVAILABLE");
  assert.equal(classifyAiFailure("400 invalid_request_error: messages.1.content: text content blocks must be non-empty"), "INVALID_REQUEST", "câu hỏi sai hình ⇒ KHÔNG chuyển");
  assert.equal(classifyAiFailure("Gemini trả lỗi HTTP 400: Invalid JSON payload received."), "INVALID_REQUEST");
  assert.equal(classifyAiFailure("điều gì đó rất lạ"), "OTHER");
  assert.equal(classifyAiFailure(null), "OTHER");
  // Bộ phân loại THÔ không đổi câu trả lời (sổ sự cố · câu cho chủ shop · bài kiểm cũ).
  assert.equal(classifyAiError("Request timed out."), "OTHER");
  assert.equal(classifyAiError("Gemini trả lỗi HTTP 500: Internal error"), "OTHER");
  assert.equal(salesBotError(GOOGLE_CREDIT)?.kind, "CREDIT");
  assert.equal(salesBotError("Request timed out.")?.notify, false, "hết giờ tự khỏi ⇒ không báo chủ shop");
}

function testCircuit() {
  const t0 = Date.now();
  const credit = nextHealth(undefined, { ok: false, kind: "CREDIT", message: GOOGLE_CREDIT }, t0, LONG_MS);
  assert.equal(circuitState(credit, t0 + 1), "OPEN", "hết credit ⇒ ngắt ngay lần đầu");
  assert.equal(Date.parse(credit.openUntil!), t0 + LONG_MS, "ngắt LÂU theo cấu hình");
  assert.equal(circuitState(credit, t0 + LONG_MS), "HALF_OPEN");

  let e: ProviderHealthEntry | undefined;
  for (let i = 1; i < FAILOVER_RULE.failuresToOpen; i++) e = nextHealth(e, { ok: false, kind: "SERVER_ERROR", message: "HTTP 503" }, t0 + i, LONG_MS);
  assert.equal(circuitState(e, t0 + 10), "CLOSED", `5xx dưới ${FAILOVER_RULE.failuresToOpen} lần liên tiếp ⇒ chưa ngắt`);
  e = nextHealth(e, { ok: false, kind: "TIMEOUT", message: "Request timed out." }, t0 + 20, LONG_MS);
  assert.equal(circuitState(e, t0 + 21), "OPEN", "đủ N lỗi tự khỏi LIÊN TIẾP ⇒ ngắt ngắn");
  assert.equal(Date.parse(e.openUntil!), t0 + 20 + FAILOVER_RULE.shortOpenMs);
  const halfAt = t0 + 20 + FAILOVER_RULE.shortOpenMs;
  assert.equal(circuitState(e, halfAt), "HALF_OPEN");
  const reopened = nextHealth(e, { ok: false, kind: "RATE_LIMIT", message: "429" }, halfAt, LONG_MS);
  assert.equal(circuitState(reopened, halfAt + 1), "OPEN", "lượt thử nửa mở hỏng ⇒ ngắt lại NGAY, không đợi đủ N lần");
  const healed = nextHealth(e, { ok: true }, halfAt, LONG_MS);
  assert.ok(circuitState(healed, halfAt) === "CLOSED" && healed.consecutiveFailures === 0, "lượt thử nửa mở thành công ⇒ đóng mạch");
  assert.equal(healed.lastErrorClass, "TIMEOUT", "lớp lỗi gần nhất giữ lại cho người đọc");

  const content = nextHealth(undefined, { ok: false, kind: "INVALID_REQUEST", message: "400 bad request" }, t0, LONG_MS);
  assert.ok(content.openUntil === null && content.consecutiveFailures === 0, "lỗi NỘI DUNG không phải bệnh của nhà cung cấp ⇒ không đụng mạch");

  // Ghi CSDL chỉ khi trạng thái đổi.
  const ok1 = nextHealth(undefined, { ok: true }, t0, LONG_MS);
  assert.equal(shouldPersistHealth(undefined, ok1, t0), true, "lần đầu ⇒ ghi");
  const ok2 = nextHealth(ok1, { ok: true }, t0 + 60_000, LONG_MS);
  assert.equal(shouldPersistHealth(ok1, ok2, t0 + 60_000), false, "thành công nối tiếp thành công ⇒ KHÔNG ghi mỗi lượt");
  const ok3 = nextHealth(ok1, { ok: true }, t0 + FAILOVER_RULE.heartbeatMs, LONG_MS);
  assert.equal(shouldPersistHealth(ok1, ok3, t0 + FAILOVER_RULE.heartbeatMs), true, "nhịp tim mỗi giờ");
  const f1 = nextHealth(ok1, { ok: false, kind: "SERVER_ERROR", message: "503" }, t0 + 1, LONG_MS);
  assert.equal(shouldPersistHealth(ok1, f1, t0 + 1), true, "đếm lỗi đổi ⇒ ghi");
  const c2 = nextHealth(content, { ok: false, kind: "INVALID_REQUEST", message: "400 bad request" }, t0 + 5, LONG_MS);
  assert.equal(shouldPersistHealth(content, c2, t0 + 5), false, "lỗi nội dung cùng lớp lặp lại ⇒ không ghi");

  // Kế hoạch thử.
  const open = { ...EMPTY_HEALTH, openUntil: new Date(t0 + 60_000).toISOString() };
  const half = { ...EMPTY_HEALTH, openUntil: new Date(t0 - 1).toISOString() };
  const none = { PRIMARY: false, SECONDARY: false };
  assert.deepEqual(planAttempts({ primary: undefined, secondary: undefined, nowMs: t0, probing: none }).order, ["PRIMARY", "SECONDARY"]);
  assert.deepEqual(planAttempts({ primary: open, secondary: undefined, nowMs: t0, probing: none }).order, ["SECONDARY"], "mạch mở ⇒ bỏ qua khoá chính");
  const p = planAttempts({ primary: half, secondary: undefined, nowMs: t0, probing: none });
  assert.ok(p.order.join() === "PRIMARY,SECONDARY" && p.probe.join() === "PRIMARY", "nửa mở ⇒ khoá chính được thử lại, khoá chính vẫn đứng trước");
  assert.deepEqual(planAttempts({ primary: half, secondary: undefined, nowMs: t0, probing: { PRIMARY: true, SECONDARY: false } }).order, ["SECONDARY"], "lượt khác đang thử nửa mở ⇒ không thử chồng");
  assert.deepEqual(planAttempts({ primary: open, secondary: open, nowMs: t0, probing: none }).order, [], "cả hai mở ⇒ không tốn lời gọi nào");
  assert.deepEqual(planAttempts({ primary: null, secondary: undefined, nowMs: t0, probing: none }).order, ["SECONDARY"]);

  assert.deepEqual(parseProviderHealth({ "gemini-byok": { consecutiveFailures: "x", openUntil: "không phải ngày", lastErrorClass: "BỊA" }, "BAD KEY": {} }), { "gemini-byok": { ...EMPTY_HEALTH } }, "dữ liệu hỏng ⇒ mạch đóng (hỏng về phía hành vi cũ)");
}

function testConfig() {
  assert.equal(DEFAULT_SALES_CHATBOT_CONFIG.fallbackConnectorKey, null, "mặc định KHÔNG có khoá dự phòng");
  const legacy = { ...DEFAULT_SALES_CHATBOT_CONFIG } as Partial<SalesChatbotConfig>;
  delete legacy.fallbackConnectorKey;
  delete legacy.fallbackModel;
  delete legacy.failoverEnabled;
  delete legacy.failoverOpenMinutes;
  const parsed = parseSalesChatbotConfig({ ...legacy, enabled: true, connectorKey: "gemini-byok" });
  assert.ok(parsed.enabled && parsed.fallbackConnectorKey === null && parsed.failoverOpenMinutes === 30, "cấu hình đã lưu trước ngày này vẫn đọc được, không có dự phòng");
  const cfg = { ...parsed, fallbackConnectorKey: "anthropic-byok" as const };
  assert.deepEqual(effectiveFallback(cfg), { connectorKey: "anthropic-byok", model: "" });
  assert.equal(effectiveFallback({ ...cfg, failoverEnabled: false }), null, "công tắc tắt chuyển dự phòng theo tổ chức");
  assert.equal(effectiveFallback({ ...cfg, fallbackConnectorKey: "gemini-byok" }), null, "trùng khoá chính ⇒ không có dự phòng");
  assert.equal(effectiveFallback(parsed), null);
}

// ─────────────────────────── provider bọc với provider giả ───────────────────────────

type Script = (req: AiRequest) => AiResponse | Error;
function fake(name: string, script: Script): AiProvider & { calls: number; partial: string[] } {
  const p = {
    name,
    model: `${name}-model`,
    schemaDialect: "openai" as const,
    calls: 0,
    partial: [] as string[],
    async complete(req: AiRequest): Promise<AiResponse> {
      p.calls += 1;
      const r = script(req);
      if (r instanceof Error) {
        p.partial.push(`${name}: nửa câu dở dang`);
        throw r;
      }
      return r;
    },
  };
  return p;
}
const answer = (text: string, model: string): AiResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, latencyMs: 1 });
const REQ: AiRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "Chả mực bao nhiêu?" }] }], tools: [] };

function memoryStore(): ProviderHealthStore & { state: ProviderHealthState; writes: number } {
  const s = {
    state: {} as ProviderHealthState,
    writes: 0,
    async read() {
      return s.state;
    },
    async update(key: string, entry: ProviderHealthEntry, persist: boolean) {
      s.state = { ...s.state, [key]: entry };
      if (persist) s.writes += 1;
    },
  };
  return s;
}

async function testWrapper() {
  resetProviderHealthCacheForTests();
  let clock = Date.now();
  let primaryScript: Script = () => new Error(GOOGLE_CREDIT);
  let secondaryScript: Script = () => answer("Dạ chả mực 400.000đ/gói ạ.", "claude-x");
  const primary = fake("gemini-byok", (r) => primaryScript(r));
  const secondary = fake("anthropic-byok", (r) => secondaryScript(r));
  const store = memoryStore();
  const failed: FailedAttempt[] = [];
  const needsHuman: FailedAttempt[] = [];
  let resolves = 0;
  const make = (over: Partial<ConstructorParameters<typeof FailoverProvider>[0]> = {}) =>
    new FailoverProvider({
      orgCode: "fo-wrapper",
      primary: { key: "gemini-byok", source: "BYOK", provider: primary } satisfies FailoverCandidate,
      secondaryKey: "platform",
      resolveSecondary: async () => {
        resolves += 1;
        return { ok: true, candidate: { key: "platform", source: "PLATFORM", provider: secondary } };
      },
      longOpenMs: LONG_MS,
      store,
      onAttemptFailed: (a) => void failed.push(a),
      onPrimaryNeedsHuman: (a) => void needsHuman.push(a),
      now: () => clock,
      ...over,
    });

  // ① Khoá chính HẾT CREDIT ⇒ khoá dự phòng trả lời — và khách chỉ nhận ĐÚNG MỘT câu.
  const sent: string[] = [];
  const send = (res: AiResponse) => sent.push(res.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  const fp = make();
  assert.equal(fp.name, "gemini-byok", "trước lời gọi: nhãn của khoá chính");
  assert.equal(resolves, 0, "khoá dự phòng mở LÚC CẦN, không mở khi khoá chính chưa hỏng");
  send(await fp.complete(REQ));
  assert.deepEqual(sent, ["Dạ chả mực 400.000đ/gói ạ."], "MỘT kết quả, của khoá dự phòng — phần dở dang của khoá chính không bao giờ ra khỏi hàm");
  assert.equal(primary.partial.length, 1);
  assert.ok(!sent.some((x) => x.includes("dở dang")));
  assert.ok(primary.calls === 1 && secondary.calls === 1);
  assert.equal(fp.name, `anthropic-byok${FAILOVER_LABEL_SUFFIX}`, "sổ AI đọc SAU lời gọi ⇒ nhà cung cấp thật + dấu failover");
  assert.equal(fp.source, "PLATFORM", "nguồn trả tiền là của khoá dự phòng");
  assert.equal(fp.model, "anthropic-byok-model");
  assert.ok(failed.length === 1 && failed[0].key === "gemini-byok" && failed[0].kind === "CREDIT" && failed[0].source === "BYOK", `lời gọi hỏng của khoá chính được báo để ghi sổ: ${JSON.stringify(failed)}`);
  assert.equal(needsHuman.length, 1, "khoá chính hết tiền ⇒ báo chủ shop dù bot vẫn trả lời");
  assert.equal(circuitState(store.state["gemini-byok"], clock), "OPEN");

  // ② Mạch mở ⇒ lượt sau bỏ qua khoá chính (không tốn một lời gọi hỏng mỗi tin).
  send(await make().complete(REQ));
  assert.equal(primary.calls, 1, "mạch mở ⇒ khoá chính KHÔNG bị gọi");
  assert.equal(secondary.calls, 2);
  assert.equal(failed.length, 1, "không có lời gọi hỏng mới");

  // ③ Hết hạn ngắt ⇒ nửa mở: khoá chính được thử lại; khoẻ ⇒ tự quay về khoá chính.
  clock += LONG_MS;
  primaryScript = () => answer("Dạ em báo giá ạ.", "gemini-3.5-flash-lite");
  const back = make();
  send(await back.complete(REQ));
  assert.equal(primary.calls, 2, "nửa mở ⇒ thử khoá chính");
  assert.equal(secondary.calls, 2, "khoá chính khoẻ ⇒ không gọi khoá dự phòng");
  assert.equal(back.name, "gemini-byok", "quay về khoá chính, không còn dấu failover");
  assert.equal(circuitState(store.state["gemini-byok"], clock), "CLOSED");
  const writesBefore = store.writes;
  await make().complete(REQ);
  assert.equal(store.writes, writesBefore, "thành công nối tiếp thành công ⇒ không ghi sổ sức khoẻ");

  // ④ HẾT GIỜ và 5xx ⇒ chuyển; 5xx liên tiếp đủ N lần ⇒ ngắt ngắn.
  primaryScript = () => new Error("Request timed out.");
  let r = await make().complete(REQ);
  assert.equal(r.model, "claude-x", "hết giờ ⇒ khoá dự phòng trả lời");
  primaryScript = () => new Error("Gemini trả lỗi HTTP 503: Service Unavailable");
  r = await make().complete(REQ);
  assert.equal(r.model, "claude-x", "5xx ⇒ khoá dự phòng trả lời");
  assert.equal(circuitState(store.state["gemini-byok"], clock), "CLOSED", "2 lỗi tự khỏi ⇒ chưa ngắt");
  await make().complete(REQ);
  assert.equal(circuitState(store.state["gemini-byok"], clock), "OPEN", `${FAILOVER_RULE.failuresToOpen} lỗi tự khỏi liên tiếp ⇒ ngắt ngắn`);
  assert.equal(needsHuman.length, 1, "lỗi tự khỏi không báo chủ shop");
  clock += FAILOVER_RULE.shortOpenMs;
  primaryScript = () => answer("ok", "g");
  await make().complete(REQ);
  assert.equal(circuitState(store.state["gemini-byok"], clock), "CLOSED");

  // ⑤ 400 NỘI DUNG ⇒ KHÔNG chuyển (không trả tiền hai lần cho cùng một lần hỏng).
  const sBefore = secondary.calls;
  primaryScript = () => new Error("400 invalid_request_error: messages: text content blocks must be non-empty");
  await assert.rejects(make().complete(REQ), /invalid_request_error/);
  assert.equal(secondary.calls, sBefore, "lỗi nội dung ⇒ khoá dự phòng không bị gọi");
  assert.equal(circuitState(store.state["gemini-byok"], clock), "CLOSED", "lỗi nội dung không ngắt mạch khoá chính");

  // ⑥ Cả hai hỏng ⇒ ném lỗi (engine chuyển người như cũ); chỉ lời gọi hỏng ĐÃ CHUYỂN đi mới báo `onAttemptFailed`.
  const fBefore = failed.length;
  primaryScript = () => new Error(GOOGLE_CREDIT);
  secondaryScript = () => new Error("Gemini trả lỗi HTTP 503: The model is overloaded");
  const both = make();
  await assert.rejects(both.complete(REQ), /overloaded/);
  assert.equal(failed.length, fBefore + 1, "lời gọi hỏng cuối cùng do engine ghi, không ghi hai lần");
  assert.equal(both.name, `anthropic-byok${FAILOVER_LABEL_SUFFIX}`, "dòng ERROR cuối cùng mang nhà cung cấp hỏng cuối cùng");
  // Khoá chính đã ngắt (credit) ⇒ lượt sau chỉ thử khoá dự phòng; khoá dự phòng cũng ngắt ⇒ không tốn lời gọi nào, câu lỗi
  // mang NGUYÊN lỗi của khoá chính để chủ shop vẫn được báo «hết tiền».
  for (let i = 0; i < FAILOVER_RULE.failuresToOpen; i++) await make().complete(REQ).catch(() => undefined);
  const pCalls = primary.calls;
  const sCalls = secondary.calls;
  const err = await make()
    .complete(REQ)
    .then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  assert.ok(err && primary.calls === pCalls && secondary.calls === sCalls, `cả hai mạch mở ⇒ 0 lời gọi: ${err}`);
  assert.equal(salesBotError(err)?.kind, "CREDIT", "câu lỗi khi mọi mạch mở vẫn xếp đúng lớp của khoá chính ⇒ báo chủ shop");

  // ⑦ Khoá dự phòng không mở được ⇒ ném NGUYÊN lỗi của khoá chính (câu lỗi thật, lớp lỗi thật).
  resetProviderHealthCacheForTests();
  store.state = {};
  const noSecondary = make({ resolveSecondary: async () => ({ ok: false, error: "Gói hiện tại chưa có AI dùng chung" }) });
  primaryScript = () => new Error(GOOGLE_CREDIT);
  await assert.rejects(noSecondary.complete(REQ), /prepayment credits/);

  // ⑧ Khoá chính không mở được (kết nối tắt) ⇒ khoá dự phòng đỡ ngay.
  store.state = {};
  secondaryScript = () => answer("Dạ em đây ạ.", "claude-x");
  const onlySecondary = make({ primary: null, primaryError: "Chưa dùng được khoá AI «gemini-byok»: kết nối đang tắt" });
  assert.equal((await onlySecondary.complete(REQ)).model, "claude-x");
  assert.equal(onlySecondary.source, "PLATFORM");
}

// ─────────────────────────── engine trên CSDL thật của một tổ chức thử ───────────────────────────

const ORG = "fo-ai-failover";

async function cleanup() {
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

async function testEngine() {
  await cleanup();
  resetProviderHealthCacheForTests();
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "Failover@12345" }, source: "TEST", actor: null });
  const calls = { primary: 0, secondary: 0 };
  let primaryFails: Error | null = new Error(GOOGLE_CREDIT);
  let secondaryFails: Error | null = null;
  const BACKUP_TEXT = "Dạ chả mực 400.000đ một gói ạ.";
  const byKey = (cfg: SalesChatbotConfig): AiProvider | null => {
    if (cfg.connectorKey === "gemini-byok")
      return {
        name: "fake-gemini",
        model: "gemini-fake",
        schemaDialect: "openai",
        async complete() {
          calls.primary += 1;
          if (primaryFails) throw primaryFails;
          return answer("Dạ khoá chính trả lời ạ.", "gemini-fake");
        },
      };
    if (cfg.connectorKey === "anthropic-byok")
      return {
        name: "fake-anthropic",
        model: "claude-fake",
        schemaDialect: "anthropic",
        async complete() {
          calls.secondary += 1;
          if (secondaryFails) throw secondaryFails;
          return answer(BACKUP_TEXT, "claude-fake");
        },
      };
    return null;
  };
  setSalesChatProviderForTests(byKey);
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const setCfg = async (patch: Partial<SalesChatbotConfig>) => {
        const v = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true, connectorKey: "gemini-byok", ...patch });
        await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: v }).onConflictDoUpdate({ target: schema.settings.key, set: { value: v } });
      };
      const pdb = await getPlatformDb();
      const usage = async () => pdb.select().from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
      const turn = async (visitor: string, text: string) => {
        const vk = visitorKeyOf(`fo-${visitor}-0123456789abcdef`);
        const w = await openConversation("WEB", { visitorKey: vk });
        const r = await chatTurn(w.id, text, { channel: "WEB", visitorKey: vk });
        assert.ok(r.ok, r.ok ? "" : r.error);
        const [conv] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, w.id));
        // Tin bot sau lời chào (seq 1): mỗi tin assistant có chữ là MỘT câu gửi khách.
        const botTexts = r.view.messages.slice(1).filter((m) => m.role === "assistant" && m.text).map((m) => m.text);
        return { conv, botTexts };
      };

      // ① Không có khoá dự phòng ⇒ hành vi CŨ: một lời gọi, HANDOFF, không câu nào tới khách web, không ghi sổ sức khoẻ.
      await setCfg({});
      const old = await turn("old", "Chả mực bao nhiêu?");
      assert.ok(old.conv.status === "HANDOFF" && old.botTexts.length === 0, JSON.stringify({ s: old.conv.status, t: old.botTexts }));
      assert.deepEqual({ ...calls }, { primary: 1, secondary: 0 });
      const health0 = await db.select().from(schema.settings).where(eq(schema.settings.key, PROVIDER_HEALTH_SETTING_KEY));
      assert.equal(health0.length, 0, "không có dự phòng ⇒ không bọc, không ghi sổ sức khoẻ");

      // ② Khoá chính hết credit ⇒ khoá dự phòng trả lời — khách nhận ĐÚNG MỘT câu.
      await setCfg({ fallbackConnectorKey: "anthropic-byok" });
      const fo = await turn("fo", "Chả mực bao nhiêu?");
      assert.deepEqual(fo.botTexts, [BACKUP_TEXT], "đúng MỘT câu, của khoá dự phòng");
      assert.notEqual(fo.conv.status, "HANDOFF", "khoá dự phòng đỡ ⇒ không chuyển người");
      assert.deepEqual({ ...calls }, { primary: 2, secondary: 1 }, "khoá chính một lần hỏng, khoá dự phòng một lần trả lời");
      const rows = (await usage()).filter((u) => u.ref === fo.conv.id);
      const err = rows.find((u) => u.status === "ERROR");
      const ok = rows.find((u) => u.status === "OK");
      assert.ok(err && err.provider === "fake-gemini" && err.requests === 1 && err.inputTokens === null && err.costUsd === null, `lời gọi hỏng của khoá chính vẫn vào sổ (token NULL = chưa biết): ${JSON.stringify(rows)}`);
      assert.ok(ok && ok.provider === `fake-anthropic${FAILOVER_LABEL_SUFFIX}` && ok.model === "claude-fake" && ok.requests === 1 && ok.inputTokens === 10 && ok.billingSource === "BYOK", `lượt trả lời ghi nhà cung cấp thật + dấu failover: ${JSON.stringify(ok)}`);
      assert.equal(rows.length, 2);
      const [h] = await db.select().from(schema.settings).where(eq(schema.settings.key, PROVIDER_HEALTH_SETTING_KEY));
      const health = parseProviderHealth(JSON.parse(h.value));
      assert.ok(circuitState(health["gemini-byok"], Date.now()) === "OPEN" && health["gemini-byok"].lastErrorClass === "CREDIT", `sức khoẻ lưu ở settings của tổ chức: ${h.value}`);

      // ③ Mạch mở ⇒ lượt sau KHÔNG gọi khoá chính.
      const next = await turn("fo2", "Ruốc tôm bao nhiêu?");
      assert.deepEqual(next.botTexts, [BACKUP_TEXT]);
      assert.deepEqual({ ...calls }, { primary: 2, secondary: 2 }, "mạch mở ⇒ khoá chính không bị gọi");

      // ④ Cả hai hỏng ⇒ chuyển người như cũ.
      secondaryFails = new Error("Gemini trả lỗi HTTP 500: Internal error");
      const down = await turn("down", "Còn hàng không?");
      assert.ok(down.conv.status === "HANDOFF" && down.botTexts.length === 0, JSON.stringify({ s: down.conv.status, t: down.botTexts }));
      const downRows = (await usage()).filter((u) => u.ref === down.conv.id);
      assert.ok(downRows.length === 1 && downRows[0].status === "ERROR" && downRows[0].provider === `fake-anthropic${FAILOVER_LABEL_SUFFIX}`, `khoá chính đang ngắt ⇒ chỉ một lời gọi hỏng (khoá dự phòng): ${JSON.stringify(downRows)}`);

      // ⑤ Công tắc tắt chuyển dự phòng ⇒ hành vi cũ dù đã chọn khoá dự phòng.
      secondaryFails = null;
      const before = { ...calls };
      await setCfg({ fallbackConnectorKey: "anthropic-byok", failoverEnabled: false });
      const off = await turn("off", "Chả mực bao nhiêu?");
      assert.ok(off.conv.status === "HANDOFF" && calls.primary === before.primary + 1 && calls.secondary === before.secondary, JSON.stringify(calls));
      primaryFails = null;
      const healthy = await turn("healthy", "Chả mực bao nhiêu?");
      assert.deepEqual(healthy.botTexts, ["Dạ khoá chính trả lời ạ."]);
      const hRows = await db.select().from(schema.salesChatConversations).where(and(eq(schema.salesChatConversations.id, healthy.conv.id)));
      assert.equal(hRows.length, 1);
    });
  } finally {
    setSalesChatProviderForTests(null);
    resetProviderHealthCacheForTests();
    await cleanup();
  }
}

export async function testAiProviderFailover() {
  testClassify();
  testCircuit();
  testConfig();
  await testWrapper();
  await testEngine();
  console.log("✓ Khoá AI dự phòng: credit / hết giờ / 5xx ⇒ chuyển, 400 ⇒ không · ngắt mạch theo (tổ chức, khoá), nửa mở tự quay về · khách nhận ĐÚNG MỘT câu · cả hai hỏng ⇒ chuyển người · không cấu hình ⇒ hành vi cũ");
}

if (/ai-provider-failover\.test\.ts$/.test(process.argv[1] ?? "")) {
  testAiProviderFailover().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

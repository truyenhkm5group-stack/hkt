/**
 * ═══════════ PLATFORM AI MODEL CONTROL — LÕI NGƯỜI VẬN HÀNH, CHỈ MÁY CHỦ (docs/platform/ai-model-control.md) ═══════════
 *
 * Quy trình bốn bước, mỗi bước một hàm, mỗi lượt ghi một dòng nhật ký nền tảng (bắt buộc lý do):
 *   1. KIỂM TRA KHẢ DỤNG (`probePlatformAiModelAsOperator`) — một lời gọi cực nhỏ bằng CHÍNH `PLATFORM_AI_API_KEY`.
 *   2. CHẠY THỬ (`setPlatformAiPolicy`, canary 1–99%) — chỉ khi bước 1 nói AVAILABLE trong 24 giờ qua.
 *   3. ÁP DỤNG (`setPlatformAiPolicy`, canary 100%) — cùng điều kiện.
 *   4. HOÀN TÁC (`rollbackPlatformAiPolicy`) — về đúng bản trước; không có bản trước ⇒ TẮT chính sách (về model của biến
 *      môi trường, thứ đã chạy trước khi có màn này).
 *
 * Chỉ người vận hành (`platform:operate` + tổ chức nhà — `platformOperatorDenial`) — tổ chức khách KHÔNG có đường nào đổi model
 * của AI dùng chung: không action, không ô cấu hình (ô Model của chatbot bị BỎ QUA ở nhánh `platform`, xem engine).
 * Không in khoá: màn hình chỉ biết khoá "có / không"; câu lỗi của nhà cung cấp đã che khoá trước khi lưu.
 */
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { giaCuaModel } from "@/lib/ai/provider";
import { defaultEnvReader, platformAiConfig, type EnvReader, type PlatformAiProviderName } from "@/lib/ai-usage/platform-ai";
import { invalidatePlatformAiPolicy, PLATFORM_AI_REASONINGS, policyForWorkload, readPlatformAiPolicies, platformAiPolicyKey, POLICY_MAX_OUTPUT, readPlatformAiPolicy, type PlatformAiPolicy, type PlatformAiPolicyCore, type PlatformAiReasoning } from "@/lib/ai-usage/platform-ai-policy";
import { PLATFORM_WORKLOAD_LABEL, PLATFORM_WORKLOADS, type PlatformWorkload } from "@/lib/ai-usage/types";
import { MODEL_PROBE_VERDICTS, probePlatformModel, type ModelProbeResult, type ModelProbeVerdict } from "@/lib/ai-usage/platform-model-probe";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { KILL_SWITCH_REASON_MIN } from "@/lib/platform/kill-switches";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { suggestCheaperModel } from "@/lib/pricing/guard";
import { priceKeyFor, resolveUnitPrices, type UnitPrice } from "@/lib/pricing/unit-prices";

export const PLATFORM_AI_PROBES_KEY = "platform.ai.model-probes";
/** Một lần kiểm khả dụng có giá trị 24 giờ — quá hạn thì phải kiểm lại trước khi chạy thử / áp dụng. */
export const PROBE_FRESH_MS = 24 * 3_600_000;
export const USAGE_WINDOW_DAYS = 30;

export type ProbeRecord = ModelProbeResult & { checkedAt: string; checkedBy: string | null };
export type PlatformAiResult = { ok: true; message: string } | { error: string };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Sổ kiểm khả dụng đã lưu ⇒ kiểu đã kiểm; dòng sai hình bị bỏ. HÀM THUẦN. */
export function parseProbeRecords(raw: unknown): Record<string, ProbeRecord> {
  if (!isRec(raw)) return {};
  const out: Record<string, ProbeRecord> = {};
  for (const [model, v] of Object.entries(raw)) {
    if (!isRec(v) || typeof v.verdict !== "string" || !(MODEL_PROBE_VERDICTS as readonly string[]).includes(v.verdict) || typeof v.checkedAt !== "string" || !Number.isFinite(Date.parse(v.checkedAt))) continue;
    out[model] = {
      model,
      provider: v.provider === "anthropic" ? "anthropic" : "gemini",
      verdict: v.verdict as ModelProbeVerdict,
      httpStatus: typeof v.httpStatus === "number" ? v.httpStatus : null,
      latencyMs: typeof v.latencyMs === "number" ? v.latencyMs : 0,
      message: typeof v.message === "string" ? v.message.slice(0, 160) : null,
      modelVersion: typeof v.modelVersion === "string" ? v.modelVersion : null,
      checkedAt: v.checkedAt,
      checkedBy: typeof v.checkedBy === "string" ? v.checkedBy : null,
    };
  }
  return out;
}

/** Model đã được CHÍNH khoá nền tảng gọi thành công trong 24 giờ qua. HÀM THUẦN. */
export function probeIsFreshAvailable(rec: ProbeRecord | undefined, now: Date): boolean {
  return Boolean(rec && rec.verdict === "AVAILABLE" && now.getTime() - Date.parse(rec.checkedAt) < PROBE_FRESH_MS);
}

export type ModelUsageRow = { model: string | null; requests: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number; unpricedRequests: number };
export type SwitchEstimate = { currentUsd: number; currentComplete: boolean; inputTokens: number; outputTokens: number; estimatedUsd: number | null; savingsPct: number | null; currentPerMTokUsd: number | null; candidatePerMTokUsd: number | null };

/**
 * Chi phí 30 ngày ĐÃ GHI (sổ AI, ESTIMATED theo bảng giá lúc ghi) ⇒ chi phí ƯỚC TÍNH nếu CÙNG lượng token đó chạy model ứng
 * viên. Có lượt chưa định giá ⇒ chi phí hiện tại là CẬN DƯỚI ⇒ % tiết kiệm `null` (không so một cận dưới với một số đủ).
 * HÀM THUẦN.
 */
export function estimateSwitch(rows: readonly ModelUsageRow[], candidate: UnitPrice | null): SwitchEstimate {
  const inputTokens = rows.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = rows.reduce((s, r) => s + r.outputTokens, 0);
  const currentUsd = rows.reduce((s, r) => s + r.costUsd, 0);
  const currentComplete = rows.every((r) => r.unpricedRequests === 0);
  const tokens = inputTokens + outputTokens;
  const estimatedUsd = candidate ? (inputTokens * candidate.input + outputTokens * candidate.output) / 1_000_000 : null;
  const savingsPct = estimatedUsd !== null && currentComplete && currentUsd > 0 ? ((currentUsd - estimatedUsd) / currentUsd) * 100 : null;
  return { currentUsd, currentComplete, inputTokens, outputTokens, estimatedUsd, savingsPct, currentPerMTokUsd: tokens > 0 && currentComplete ? (currentUsd / tokens) * 1_000_000 : null, candidatePerMTokUsd: tokens > 0 && estimatedUsd !== null ? (estimatedUsd / tokens) * 1_000_000 : null };
}

export const CONTROL_STAGES = ["KEY_OFF", "NO_CANDIDATE", "NEED_PROBE", "PROBE_FAILED", "READY", "CANARY", "APPLIED"] as const;
export type ControlStage = (typeof CONTROL_STAGES)[number];
export const CONTROL_STAGE_LABEL: Record<ControlStage, string> = {
  KEY_OFF: "Khoá nền tảng chưa bật — không có gì để đổi",
  NO_CANDIDATE: "Chưa có model rẻ hơn cùng họ trong bảng giá",
  NEED_PROBE: "Bước 1 · cần Kiểm tra khả dụng với khoá nền tảng",
  PROBE_FAILED: "Model đề xuất KHÔNG dùng được với khoá này — giữ model hiện tại",
  READY: "Bước 2 · sẵn sàng Chạy thử (canary)",
  CANARY: "Đang chạy thử — theo dõi lỗi / chi phí rồi Áp dụng hoặc Hoàn tác",
  APPLIED: "Đã áp dụng cho toàn bộ AI dùng chung — Hoàn tác nếu cần",
};

/** Bước hiện tại của quy trình. HÀM THUẦN. */
export function controlStage(input: { keyReady: boolean; policy: PlatformAiPolicy | null; candidate: string | null; probe: ProbeRecord | undefined; now: Date }): ControlStage {
  if (!input.keyReady) return "KEY_OFF";
  const p = input.policy;
  if (p?.enabled && p.primaryModel === input.candidate) return p.canaryPct >= 100 ? "APPLIED" : "CANARY";
  if (!input.candidate) return "NO_CANDIDATE";
  if (!input.probe || input.now.getTime() - Date.parse(input.probe.checkedAt) >= PROBE_FRESH_MS) return "NEED_PROBE";
  return input.probe.verdict === "AVAILABLE" ? "READY" : "PROBE_FAILED";
}

/** Một dòng bảng PLATFORM AI ROUTING: chính sách CÓ HIỆU LỰC của loại việc + sổ AI 30 ngày của nó. */
export type RoutingRow = {
  workload: PlatformWorkload | "other";
  scope: PlatformWorkload | "global" | null;
  model: string | null;
  fallbackModel: string | null;
  reasoning: string | null;
  canaryPct: number | null;
  calls: number;
  errorRate: number | null;
  thinkingTokens: number | null;
  /** lượt OK đã tách được suy nghĩ / mọi lượt OK. */
  thinkCoverage: number | null;
  costUsd: number;
  units: number;
  costPerUnitUsd: number | null;
};

export type PlatformAiControlView = {
  key: { ready: boolean; reason: string | null; provider: PlatformAiProviderName | null; baseModel: string | null };
  policy: PlatformAiPolicy | null;
  /** Model đang phục vụ PHẦN LỚN lưu lượng lúc này (chính sách áp 100% ⇒ primary; canary < 50% ⇒ model nền). */
  currentModel: string | null;
  candidate: string | null;
  prices: { current: UnitPrice | null; candidate: UnitPrice | null };
  usage: ModelUsageRow[];
  estimate: SwitchEstimate;
  probes: Record<string, ProbeRecord>;
  stage: ControlStage;
  audit: { at: string; action: string; actorEmail: string | null; reason: string | null; after: unknown }[];
  windowDays: number;
  routing: RoutingRow[];
};

async function readProbeRecords(): Promise<Record<string, ProbeRecord>> {
  try {
    const pdb = await getPlatformDb();
    const r = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_AI_PROBES_KEY) });
    return parseProbeRecords(r?.value);
  } catch {
    return {};
  }
}

/**
 * Ai ghi: người vận hành qua màn hình (`UI`, có tài khoản) hoặc ops (`SCRIPT`, `actor = null` = MÁY — luật 34, khác hẳn
 * "không biết ai"). Hai đường đi CÙNG một lõi ghi bên dưới, nên cổng (giá · kiểm khả dụng · lý do) không có bản thứ hai.
 */
type Writer = { updatedBy: string; label: string; source: "UI" | "SCRIPT"; actor: PlatformActor };
const writerOf = (user: SessionUser): Writer => ({ updatedBy: `${user.organization?.code ?? ""}:${user.id}`, label: user.email, source: "UI", actor: user.organization ? { orgCode: user.organization.code, userId: user.id, email: user.email } : null });
export const SCRIPT_WRITER_LABEL = "ops:platform-ai-model-probe";
const SCRIPT_WRITER: Writer = { updatedBy: SCRIPT_WRITER_LABEL, label: SCRIPT_WRITER_LABEL, source: "SCRIPT", actor: null };

async function putSetting(w: Writer, key: string, value: unknown) {
  const pdb = await getPlatformDb();
  const set = { value, updatedAt: new Date(), updatedBy: w.updatedBy, updatedByEmail: w.source === "UI" ? w.label : null };
  await pdb.insert(schema.platformSettings).values({ key, ...set }).onConflictDoUpdate({ target: schema.platformSettings.key, set });
}

function reasonOf(raw: unknown): string | { error: string } {
  const reason = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
  if (reason.length < KILL_SWITCH_REASON_MIN) return { error: `Ghi lý do (ít nhất ${KILL_SWITCH_REASON_MIN} ký tự) — nó vào nhật ký nền tảng.` };
  return reason;
}

/** Màn Platform AI Model Control ở /platform/saas. `env` chỉ để bài kiểm đưa môi trường giả (luật 65). */
export async function loadPlatformAiControl(user: SessionUser, now: Date = new Date(), env: EnvReader = defaultEnvReader): Promise<{ ok: true; value: PlatformAiControlView } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const cfg = platformAiConfig(env);
  const pdb = await getPlatformDb();
  const a = schema.platformAiUsage;
  const from = new Date(now.getTime() - USAGE_WINDOW_DAYS * 86_400_000);
  const [policy, probes, unit, rows, audit] = await Promise.all([
    readPlatformAiPolicy({ fresh: true }),
    readProbeRecords(),
    resolveUnitPrices(),
    pdb
      .select({
        model: a.model,
        requests: sql<number>`coalesce(sum(${a.requests}), 0)::int`,
        errors: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.status} = 'ERROR'), 0)::int`,
        inputTokens: sql<number>`coalesce(sum(${a.inputTokens}), 0)::float8`,
        outputTokens: sql<number>`coalesce(sum(${a.outputTokens}), 0)::float8`,
        costUsd: sql<number>`coalesce(sum(${a.costUsd}), 0)::float8`,
        unpricedRequests: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.costUsd} is null and ${a.status} = 'OK'), 0)::int`,
      })
      .from(a)
      .where(and(eq(a.billingSource, "PLATFORM"), gte(a.at, from), ne(a.status, "BLOCKED_QUOTA")))
      .groupBy(a.model),
    pdb
      .select({ at: schema.platformAuditLog.at, action: schema.platformAuditLog.action, actorEmail: schema.platformAuditLog.actorEmail, reason: schema.platformAuditLog.reason, after: schema.platformAuditLog.after })
      .from(schema.platformAuditLog)
      .where(inArray(schema.platformAuditLog.action, ["PLATFORM_AI_MODEL_PROBE", "PLATFORM_AI_POLICY_SET", "PLATFORM_AI_POLICY_ROLLBACK"]))
      .orderBy(desc(schema.platformAuditLog.at))
      .limit(10),
  ]);
  // PLATFORM AI ROUTING — loại việc suy từ `ref` (ghi đơn = `order-sync:*`) cho tới khi sổ có cột `workload` (migration riêng):
  // chọn câu mẫu / đọc ảnh tới lúc đó nằm chung dòng Sales Chat.
  const wlExpr = sql<string>`case when ${a.feature} <> 'sales_chatbot' then 'other' when ${a.ref} like 'order-sync:%' then 'order_sync' else 'sales_chatbot' end`;
  const [policySet, routingRows] = await Promise.all([
    readPlatformAiPolicies({ fresh: true }),
    pdb
      .select({
        wl: wlExpr,
        calls: sql<number>`coalesce(sum(${a.requests}), 0)::int`,
        errors: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.status} = 'ERROR'), 0)::int`,
        okCalls: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.status} = 'OK'), 0)::int`,
        cost: sql<number>`coalesce(sum(${a.costUsd}), 0)::float8`,
        units: sql<number>`count(distinct ${a.ref})::int`,
      })
      .from(a)
      .where(and(eq(a.billingSource, "PLATFORM"), gte(a.at, from), ne(a.status, "BLOCKED_QUOTA")))
      .groupBy(wlExpr),
  ]);
  const routing: RoutingRow[] = ([...PLATFORM_WORKLOADS, "other"] as const).map((w) => {
    const r = routingRows.find((x) => x.wl === w);
    const eff = w === "other" ? { policy: policySet.global, scope: "global" as const } : policyForWorkload(policySet, w);
    const p = eff.policy && eff.policy.enabled ? eff.policy : null;
    const calls = Number(r?.calls ?? 0);
    const ok = Number(r?.okCalls ?? 0);
    const known = 0;
    const units = Number(r?.units ?? 0);
    const cost = Number(r?.cost ?? 0);
    return {
      workload: w,
      scope: p ? eff.scope : null,
      model: p ? p.primaryModel : cfg.ready ? cfg.model : null,
      fallbackModel: p ? (p.fallbackModel ?? (cfg.ready ? cfg.model : null)) : null,
      reasoning: p?.reasoning ?? null,
      canaryPct: p ? p.canaryPct : null,
      calls,
      errorRate: calls > 0 ? Number(r?.errors ?? 0) / calls : null,
      thinkingTokens: null,
      thinkCoverage: ok > 0 ? known / ok : null,
      costUsd: cost,
      units,
      costPerUnitUsd: units > 0 ? cost / units : null,
    };
  });
  const usage: ModelUsageRow[] = rows.map((r) => ({ model: r.model, requests: Number(r.requests), errors: Number(r.errors), inputTokens: Number(r.inputTokens), outputTokens: Number(r.outputTokens), costUsd: Number(r.costUsd), unpricedRequests: Number(r.unpricedRequests) })).sort((x, y) => y.requests - x.requests);
  const priceOf = (m: string | null): UnitPrice | null => {
    if (!m) return null;
    const k = priceKeyFor(m, unit.byModel);
    return k ? unit.byModel[k] : null;
  };
  const baseModel = cfg.ready ? cfg.model : null;
  const live = policy?.enabled && Date.parse(policy.effectiveFrom) <= now.getTime() ? policy : null;
  // Model ỔN ĐỊNH (nền so sánh): model dự phòng của chính sách đang bật, không có ⇒ model của biến môi trường.
  const stable = live ? (live.fallbackModel ?? baseModel) : baseModel;
  // Model phục vụ PHẦN LỚN lưu lượng lúc này.
  const currentModel = live && live.canaryPct >= 50 ? live.primaryModel : stable;
  // Ứng viên: model chính sách đang thử / đã áp; chưa có ⇒ model CÙNG HỌ rẻ nhất cho đúng lượng token 30 ngày (chưa có token ⇒
  // so theo một hỗn hợp 10:1 vào/ra — chỉ để chọn tên, không in thành tiền).
  const tokensIn = usage.reduce((s, r) => s + r.inputTokens, 0);
  const tokensOut = usage.reduce((s, r) => s + r.outputTokens, 0);
  const suggestion = stable ? suggestCheaperModel({ model: stable, inputTokens: tokensIn || 1_000_000, outputTokens: tokensOut || 100_000, prices: unit.byModel, priceKeyOf: (m) => priceKeyFor(m, unit.byModel), minSavingsPct: 1 }) : null;
  const candidate = live ? live.primaryModel : (suggestion?.to ?? null);
  return {
    ok: true,
    value: {
      key: { ready: cfg.ready, reason: cfg.ready ? null : cfg.reason, provider: cfg.ready ? cfg.provider : null, baseModel },
      policy,
      currentModel,
      candidate,
      prices: { current: priceOf(stable), candidate: priceOf(candidate) },
      usage,
      estimate: estimateSwitch(usage, priceOf(candidate)),
      probes,
      stage: controlStage({ keyReady: cfg.ready, policy, candidate, probe: candidate ? probes[candidate] : undefined, now }),
      audit: audit.map((r) => ({ at: r.at.toISOString(), action: r.action, actorEmail: r.actorEmail, reason: r.reason, after: r.after })),
      windowDays: USAGE_WINDOW_DAYS,
      routing,
    },
  };
}

/**
 * Bước 1 — KIỂM TRA KHẢ DỤNG bằng chính khoá nền tảng. Lưu kết quả (theo model) + nhật ký. Không đổi model nào.
 * `deps` chỉ cho bài kiểm (fetch giả, môi trường giả — luật 65).
 */
export async function probePlatformAiModelAsOperator(user: SessionUser, raw: { model?: unknown }, deps: { fetch?: typeof fetch; env?: EnvReader; now?: Date } = {}): Promise<PlatformAiResult & { verdict?: ModelProbeVerdict }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!/^[a-z0-9][a-z0-9.\-]{1,60}$/.test(model)) return { error: "Tên model không hợp lệ." };
  if (!giaCuaModel(model)) return { error: `Model ${model} chưa có trong bảng giá — không trừ được credit, không kiểm.` };
  const cfg = platformAiConfig(deps.env ?? defaultEnvReader);
  if (!cfg.ready) return { error: `Khoá nền tảng chưa sẵn sàng: ${cfg.reason}` };
  const r = await probePlatformModel({ apiKey: cfg.apiKey, provider: cfg.provider, model, fetch: deps.fetch });
  await recordProbe(writerOf(user), r, deps.now ?? new Date());
  return { ok: true, verdict: r.verdict, message: `${model}: ${r.verdict}${r.httpStatus !== null ? ` (HTTP ${r.httpStatus})` : ""}${r.message ? ` — ${r.message}` : ""}` };
}

async function recordProbe(w: Writer, r: ModelProbeResult, now: Date) {
  const rec: ProbeRecord = { ...r, checkedAt: now.toISOString(), checkedBy: w.label };
  const before = await readProbeRecords();
  await putSetting(w, PLATFORM_AI_PROBES_KEY, { ...before, [r.model]: rec });
  const home = await getHomeOrganization();
  await platformAudit({ action: "PLATFORM_AI_MODEL_PROBE", targetOrgCode: home.code, subject: r.model, before: before[r.model] ?? null, after: rec, reason: `Kiểm tra khả dụng ${r.model}`, source: w.source, actor: w.actor });
}

/**
 * Bước 2 / 3 — CHẠY THỬ (canary 1–99%) hoặc ÁP DỤNG (100%). Điều kiện: khoá nền tảng sẵn sàng, cả hai model có giá, model
 * chính ĐÃ kiểm AVAILABLE trong 24 giờ, model dự phòng hoặc là model đang chạy (biến môi trường) hoặc cũng đã kiểm AVAILABLE.
 */
export async function setPlatformAiPolicy(user: SessionUser, raw: PolicyInput, deps: { env?: EnvReader; now?: Date } = {}): Promise<PlatformAiResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  return applyPolicy(writerOf(user), raw, deps);
}

type PolicyInput = { primaryModel?: unknown; fallbackModel?: unknown; canaryPct?: unknown; effectiveFrom?: unknown; reason?: unknown; workload?: unknown; reasoning?: unknown; maxOutputTokens?: unknown };

/** Loại việc của yêu cầu: trống ⇒ chính sách chung; giá trị lạ ⇒ lỗi (không đoán). HÀM THUẦN. */
export function parseWorkload(raw: unknown): { ok: true; workload: PlatformWorkload | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "" || raw === "global") return { ok: true, workload: null };
  return typeof raw === "string" && (PLATFORM_WORKLOADS as readonly string[]).includes(raw) ? { ok: true, workload: raw as PlatformWorkload } : { ok: false, error: `Loại việc «${String(raw).slice(0, 40)}» không hợp lệ.` };
}

async function applyPolicy(w: Writer, raw: PolicyInput, deps: { env?: EnvReader; now?: Date }): Promise<PlatformAiResult> {
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const now = deps.now ?? new Date();
  const cfg = platformAiConfig(deps.env ?? defaultEnvReader);
  if (!cfg.ready) return { error: `Khoá nền tảng chưa sẵn sàng: ${cfg.reason}` };
  const primaryModel = typeof raw.primaryModel === "string" ? raw.primaryModel.trim() : "";
  const fallbackModel = typeof raw.fallbackModel === "string" && raw.fallbackModel.trim() ? raw.fallbackModel.trim() : cfg.model;
  const canaryPct = typeof raw.canaryPct === "number" ? raw.canaryPct : Number(raw.canaryPct);
  if (!Number.isInteger(canaryPct) || canaryPct < 1 || canaryPct > 100) return { error: "Tỷ lệ chạy thử phải là số nguyên 1–100 (100 = áp dụng toàn bộ)." };
  if (!giaCuaModel(primaryModel)) return { error: `Model ${primaryModel || "(trống)"} chưa có trong bảng giá — không trừ được credit nền tảng.` };
  if (!giaCuaModel(fallbackModel)) return { error: `Model dự phòng ${fallbackModel} chưa có trong bảng giá.` };
  const wl = parseWorkload(raw.workload);
  if (!wl.ok) return { error: wl.error };
  const reasoning = raw.reasoning === undefined || raw.reasoning === null || raw.reasoning === "" ? null : (PLATFORM_AI_REASONINGS as readonly unknown[]).includes(raw.reasoning) ? (raw.reasoning as PlatformAiReasoning) : undefined;
  if (reasoning === undefined) return { error: "Mức suy nghĩ phải là minimal · low · medium · high (hoặc để trống = giữ của nơi gọi)." };
  const maxRaw = raw.maxOutputTokens === undefined || raw.maxOutputTokens === null || raw.maxOutputTokens === "" ? null : Number(raw.maxOutputTokens);
  if (maxRaw !== null && (!Number.isInteger(maxRaw) || maxRaw < POLICY_MAX_OUTPUT.min || maxRaw > POLICY_MAX_OUTPUT.max)) return { error: `Trần token ra phải là số nguyên ${POLICY_MAX_OUTPUT.min}–${POLICY_MAX_OUTPUT.max} (gồm cả suy nghĩ) hoặc để trống.` };
  // Hai nhánh phải KHÁC model: A/B phân nhánh theo tên model trong sổ AI — cùng model khác mức suy nghĩ thì hai nhánh lẫn vào nhau.
  if (primaryModel === fallbackModel) return { error: "Model chính và model dự phòng trùng nhau — so mức suy nghĩ của CÙNG model hãy dùng benchmark phát lại (ops platform-ai-bench)." };
  const probes = await readProbeRecords();
  if (!probeIsFreshAvailable(probes[primaryModel], now)) return { error: `Chưa có lượt Kiểm tra khả dụng THÀNH CÔNG cho ${primaryModel} bằng khoá nền tảng trong 24 giờ qua — kiểm trước, không đổi model chưa chứng minh gọi được.` };
  if (fallbackModel !== cfg.model && !probeIsFreshAvailable(probes[fallbackModel], now)) return { error: `Model dự phòng ${fallbackModel} không phải model đang chạy và chưa được kiểm khả dụng trong 24 giờ.` };
  const effectiveFrom = typeof raw.effectiveFrom === "string" && Number.isFinite(Date.parse(raw.effectiveFrom)) ? new Date(raw.effectiveFrom).toISOString() : now.toISOString();
  const key = platformAiPolicyKey(wl.workload);
  const before = await readPlatformAiPolicy({ fresh: true, workload: wl.workload });
  // Tăng / giảm nấc với CÙNG cấu hình (model chính · dự phòng · mức suy nghĩ · trần) ⇒ giữ mốc cohort (A/B cộng dồn); đổi ⇒ mới.
  const sameCohort = before?.enabled && before.primaryModel === primaryModel && (before.fallbackModel ?? cfg.model) === fallbackModel && before.reasoning === reasoning && before.maxOutputTokens === maxRaw;
  const cohortSince = sameCohort ? before.cohortSince : effectiveFrom;
  const core: PlatformAiPolicyCore = { enabled: true, provider: cfg.provider, primaryModel, fallbackModel, canaryPct, effectiveFrom, reason, changedBy: w.label, changedAt: now.toISOString(), cohortSince, reasoning, maxOutputTokens: maxRaw };
  const next: PlatformAiPolicy = { ...core, previous: before ? stripPrevious(before) : null };
  await putSetting(w, key, next);
  const home = await getHomeOrganization();
  await platformAudit({ action: "PLATFORM_AI_POLICY_SET", targetOrgCode: home.code, subject: key, before: before ? stripPrevious(before) : null, after: core, reason, source: w.source, actor: w.actor });
  invalidatePlatformAiPolicy();
  const scope = wl.workload ? PLATFORM_WORKLOAD_LABEL[wl.workload] : "toàn bộ AI dùng chung";
  const conf = `${primaryModel}${reasoning ? ` · suy nghĩ ${reasoning}` : ""}${maxRaw ? ` · trần ${maxRaw} token` : ""}`;
  return { ok: true, message: canaryPct >= 100 ? `Đã ÁP DỤNG ${conf} cho ${scope} (dự phòng ${fallbackModel}).` : `Đang CHẠY THỬ ${conf} trên ~${canaryPct}% hội thoại của ${scope} (phần còn lại + dự phòng: ${fallbackModel}).` };
}

function stripPrevious(p: PlatformAiPolicy): PlatformAiPolicyCore {
  const { previous: _previous, ...core } = p;
  void _previous;
  return core;
}

/** Bước 4 — HOÀN TÁC: về đúng bản trước; không có bản trước ⇒ tắt chính sách (model của biến môi trường). */
export async function rollbackPlatformAiPolicy(user: SessionUser, raw: { reason?: unknown; workload?: unknown }, deps: { now?: Date } = {}): Promise<PlatformAiResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  return rollbackPolicy(writerOf(user), raw, deps);
}

async function rollbackPolicy(w: Writer, raw: { reason?: unknown; workload?: unknown }, deps: { now?: Date }): Promise<PlatformAiResult> {
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const wl = parseWorkload(raw.workload);
  if (!wl.ok) return { error: wl.error };
  const key = platformAiPolicyKey(wl.workload);
  const now = deps.now ?? new Date();
  const current = await readPlatformAiPolicy({ fresh: true, workload: wl.workload });
  if (!current) return { error: "Chưa có chính sách nào — AI dùng chung đang chạy model của biến môi trường, không có gì để hoàn tác." };
  const restored: PlatformAiPolicyCore = current.previous ? { ...current.previous, changedBy: w.label, changedAt: now.toISOString(), reason } : { ...stripPrevious(current), enabled: false, changedBy: w.label, changedAt: now.toISOString(), reason };
  const next: PlatformAiPolicy = { ...restored, previous: stripPrevious(current) };
  await putSetting(w, key, next);
  const home = await getHomeOrganization();
  await platformAudit({ action: "PLATFORM_AI_POLICY_ROLLBACK", targetOrgCode: home.code, subject: key, before: stripPrevious(current), after: restored, reason, source: w.source, actor: w.actor });
  invalidatePlatformAiPolicy();
  return { ok: true, message: restored.enabled ? `Đã hoàn tác về bản trước: ${restored.primaryModel} ở ${restored.canaryPct}%.` : wl.workload ? `Đã hoàn tác: chính sách riêng của ${PLATFORM_WORKLOAD_LABEL[wl.workload]} TẮT — loại việc này đi lại chính sách chung.` : "Đã hoàn tác: chính sách TẮT — AI dùng chung chạy lại model của biến môi trường." };
}

/**
 * ĐƯỜNG OPS (`scripts/platform-ai-model-probe.ts --apply=<%>` / `--rollback`) — cho lúc không có người vận hành đăng nhập. CÙNG
 * lõi với nút trên màn hình, và CHẶT HƠN ở một chỗ: kiểm khả dụng model chính NGAY TRƯỚC khi ghi (không dựa vào lượt kiểm cũ),
 * nên không thể áp dụng một model mà khoá nền tảng vừa không gọi được. Nhật ký nguồn `SCRIPT`, người làm = máy.
 */
export async function applyPlatformAiPolicyAsScript(raw: { primaryModel: string; canaryPct: number; reason: string; workload?: PlatformWorkload | null; reasoning?: PlatformAiReasoning | null; maxOutputTokens?: number | null }, deps: { fetch?: typeof fetch; env?: EnvReader; now?: Date } = {}): Promise<PlatformAiResult & { verdict?: ModelProbeVerdict }> {
  const cfg = platformAiConfig(deps.env ?? defaultEnvReader);
  if (!cfg.ready) return { error: `Khoá nền tảng chưa sẵn sàng: ${cfg.reason}` };
  if (!giaCuaModel(raw.primaryModel)) return { error: `Model ${raw.primaryModel} chưa có trong bảng giá.` };
  const r = await probePlatformModel({ apiKey: cfg.apiKey, provider: cfg.provider, model: raw.primaryModel, fetch: deps.fetch });
  await recordProbe(SCRIPT_WRITER, r, deps.now ?? new Date());
  if (r.verdict !== "AVAILABLE") return { error: `KHÔNG ĐỔI: ${raw.primaryModel} ⇒ ${r.verdict}${r.httpStatus !== null ? ` (HTTP ${r.httpStatus})` : ""}.`, verdict: r.verdict };
  const out = await applyPolicy(SCRIPT_WRITER, { primaryModel: raw.primaryModel, canaryPct: raw.canaryPct, reason: raw.reason, workload: raw.workload ?? null, reasoning: raw.reasoning ?? null, maxOutputTokens: raw.maxOutputTokens ?? null }, deps);
  return { ...out, verdict: r.verdict };
}

export async function rollbackPlatformAiPolicyAsScript(raw: { reason: string; workload?: PlatformWorkload | null }, deps: { now?: Date } = {}): Promise<PlatformAiResult> {
  return rollbackPolicy(SCRIPT_WRITER, raw, deps);
}

/**
 * Kiểm khả dụng CHỈ ĐỌC cho ops (`scripts/platform-ai-model-probe.ts`): không người, không lưu, không nhật ký — in phán quyết
 * ra log công khai, nên KHÔNG trả gì ngoài mã HTTP, phán quyết, độ trễ và câu lỗi đã che khoá.
 */
export async function probeWithPlatformKey(models: readonly string[], deps: { fetch?: typeof fetch; env?: EnvReader } = {}): Promise<{ ready: false; reason: string } | { ready: true; provider: PlatformAiProviderName; baseModel: string; results: ModelProbeResult[] }> {
  const cfg = platformAiConfig(deps.env ?? defaultEnvReader);
  if (!cfg.ready) return { ready: false, reason: cfg.reason };
  const results: ModelProbeResult[] = [];
  for (const model of models) results.push(await probePlatformModel({ apiKey: cfg.apiKey, provider: cfg.provider, model, fetch: deps.fetch }));
  return { ready: true, provider: cfg.provider, baseModel: cfg.model, results };
}

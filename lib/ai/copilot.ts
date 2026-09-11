import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CopilotConfirmResult, CopilotExecutedAction, CopilotPendingAction, CopilotRequest, CopilotResult, CopilotToolCall } from "@/lib/ai/contracts";
import { actionToken, COPILOT_LIMITS, verifyActionToken } from "@/lib/ai/policy";
import { COPILOT_SYSTEM_PROMPT, contextPreamble } from "@/lib/ai/prompt";
import { estimateCostUsd, getAiProvider, type AiBlock, type AiMessage, type AiProvider, type AiUsage } from "@/lib/ai/provider";
import { registerCareTools } from "@/lib/ai/tools/care";
import { registerErpTools } from "@/lib/ai/tools/erp";
import { getTool, toolsFor, toProviderTools, type AiToolContext, type AiToolDefinition } from "@/lib/ai/tools/registry";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { aiDisabledReason } from "@/lib/ai/router";

/**
 * ═══════════ VÒNG LẶP COPILOT — ERP TRUTH → TYPED TOOLS → AI ═══════════
 *
 * `runCopilot` là đường duy nhất để AI nói chuyện với ERP:
 *  · tool ĐỌC chạy ngay, kết quả đưa lại cho model (cắt ngắn, JSON);
 *  · tool GHI KHÔNG chạy: được ghi vào `pendingActions` kèm token; model nhận "CHỜ XÁC NHẬN";
 *  · người bấm xác nhận ⇒ `confirmCopilotActions` kiểm token + quyền lần nữa rồi mới gọi tool.
 *
 * Mọi lần hỏi ghi một dòng `ai_interactions` (ai hỏi, model nào, tool gọi gì, đề nghị gì, đã chạy
 * gì, token/chi phí/độ trễ). Không ghi khoá API, không ghi toàn bộ kết quả tool (chỉ tóm tắt).
 */

registerCareTools();
registerErpTools();

const EMPTY_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}

function clip(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}… [cắt ${s.length - max} ký tự]` : s;
}

/** Tóm tắt kết quả tool cho audit / UI — một câu, không phải dữ liệu. */
function summarizeResult(tool: AiToolDefinition, result: unknown): string {
  if (result && typeof result === "object" && "error" in result && typeof (result as { error: unknown }).error === "string") return `Lỗi: ${(result as { error: string }).error}`;
  if (tool.kind === "write") return "Đã thực hiện";
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.cases)) return `${r.cases.length} kiện (tổng ${String(r.total ?? r.cases.length)})`;
    if (r.counts && typeof r.counts === "object") return `Hàng đợi: ${Object.entries(r.counts as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(", ")}`;
    if (r.shipment && typeof r.shipment === "object") return `Kiện ${String((r.shipment as { tracking?: string }).tracking ?? "")}`;
    if (typeof r.period === "string") return `Báo cáo ${r.period}`;
    if (typeof r.inFlight === "number") return `${r.inFlight} kiện đang đi`;
  }
  return "Đã đọc";
}

function actorOf(user: SessionUser) {
  return { id: user.id, email: user.email, name: user.name, source: "AI" as const };
}

export type RunCopilotInput = CopilotRequest & { user: SessionUser; provider?: AiProvider | null; now?: Date };

export async function runCopilot(input: RunCopilotInput): Promise<CopilotResult> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const provider = input.provider === undefined ? getAiProvider() : input.provider;
  const base: Omit<CopilotResult, "status" | "answer"> = { interactionId: null, toolCalls: [], pendingActions: [], warnings: [], usage: EMPTY_USAGE, costUsd: null, latencyMs: 0, rounds: 0, model: provider?.model ?? "" };
  if (!provider) return { ...base, status: "DISABLED", answer: `AI chưa được cấu hình trên máy chủ này (${aiDisabledReason() ?? "chưa có khoá API"}).`, error: "AI_DISABLED" };

  const message = clip(input.message.trim(), COPILOT_LIMITS.maxPromptChars);
  if (!message) return { ...base, status: "ERROR", answer: "", error: "Câu hỏi trống" };

  const tools = toolsFor(input.user);
  const ctx: AiToolContext = { user: input.user, actor: actorOf(input.user), route: input.context.route, entityType: input.context.entityType, entityId: input.context.entityId, now };
  const messages: AiMessage[] = [];
  for (const h of (input.history ?? []).slice(-COPILOT_LIMITS.maxHistoryTurns)) messages.push({ role: h.role, content: [{ type: "text", text: clip(h.text, 4000) }] });
  // Lượt đầu phải là user: nếu lịch sử bắt đầu bằng assistant thì bỏ lượt đó.
  while (messages[0]?.role === "assistant") messages.shift();
  messages.push({ role: "user", content: [{ type: "text", text: `${contextPreamble({ ...input.context, userName: input.user.name, now })}\n\n${message}` }] });

  const toolCalls: CopilotToolCall[] = [];
  const pending: CopilotPendingAction[] = [];
  const warnings: string[] = [];
  let usage = EMPTY_USAGE;
  let rounds = 0;
  let answer = "";
  let status: CopilotResult["status"] = "OK";
  let error: string | undefined;
  let model = provider.model;

  try {
    const maxRounds = COPILOT_LIMITS.maxRounds();
    for (;;) {
      rounds += 1;
      const res = await provider.complete({ system: COPILOT_SYSTEM_PROMPT, messages, tools: toProviderTools(tools) });
      usage = addUsage(usage, res.usage);
      model = res.model || model;
      const text = res.content.filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
      const uses = res.content.filter((b): b is Extract<AiBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (text) answer = text;
      if (res.stopReason === "refusal") {
        status = "REFUSED";
        break;
      }
      if (uses.length === 0 || res.stopReason !== "tool_use") break;
      if (rounds >= maxRounds) {
        warnings.push(`Dừng sau ${maxRounds} lượt tra cứu — câu trả lời có thể chưa đủ.`);
        break;
      }
      messages.push({ role: "assistant", content: res.content });
      const results: AiBlock[] = [];
      for (const u of uses) {
        const t0 = Date.now();
        const tool = getTool(u.name);
        // Model chỉ được thấy tool trong `tools`; gọi tên khác (hoặc tool bị chặn) là lỗi, không chạy.
        if (!tool || !tools.some((x) => x.name === tool.name)) {
          toolCalls.push({ name: u.name, label: u.name, kind: "read", input: u.input, executed: false, ok: false, summary: "Tool không tồn tại hoặc không được phép", latencyMs: 0 });
          results.push({ type: "tool_result", toolUseId: u.id, content: JSON.stringify({ error: "Tool không tồn tại hoặc bạn không được phép dùng" }), isError: true });
          continue;
        }
        const parsed = tool.input.safeParse(u.input);
        if (!parsed.success) {
          toolCalls.push({ name: tool.name, label: tool.label, kind: tool.kind, input: u.input, executed: false, ok: false, summary: "Input sai", latencyMs: 0 });
          results.push({ type: "tool_result", toolUseId: u.id, content: JSON.stringify({ error: "Input không hợp lệ", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }), isError: true });
          continue;
        }
        if (tool.kind === "write") {
          if (pending.length >= COPILOT_LIMITS.maxPendingActions) {
            results.push({ type: "tool_result", toolUseId: u.id, content: JSON.stringify({ error: "Đã quá số hành động được đề nghị trong một câu hỏi" }), isError: true });
            continue;
          }
          const token = actionToken(input.user.id, tool.name, parsed.data);
          const summary = tool.summarize!(parsed.data);
          if (!pending.some((p) => p.token === token)) pending.push({ token, name: tool.name, label: tool.label, summary, input: parsed.data, riskClass: tool.riskClass });
          toolCalls.push({ name: tool.name, label: tool.label, kind: "write", input: parsed.data, executed: false, ok: true, summary: "Chờ người xác nhận", latencyMs: 0 });
          results.push({ type: "tool_result", toolUseId: u.id, content: JSON.stringify({ status: "CHỜ XÁC NHẬN", message: `Hành động "${summary}" đã đưa cho người dùng xác nhận. Không gọi lại. Kết thúc câu trả lời bằng cách nói người dùng bấm xác nhận.` }) });
          continue;
        }
        try {
          const out = await tool.run(ctx, parsed.data);
          const ok = !(out && typeof out === "object" && "error" in out);
          toolCalls.push({ name: tool.name, label: tool.label, kind: "read", input: parsed.data, executed: true, ok, summary: summarizeResult(tool, out), latencyMs: Date.now() - t0 });
          const stale = out && typeof out === "object" && typeof (out as { staleness?: unknown }).staleness === "string" ? (out as { staleness: string }).staleness : null;
          if (stale) warnings.push(stale);
          results.push({ type: "tool_result", toolUseId: u.id, content: clip(JSON.stringify(out), COPILOT_LIMITS.maxToolResultChars), isError: !ok });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          toolCalls.push({ name: tool.name, label: tool.label, kind: "read", input: parsed.data, executed: true, ok: false, summary: `Lỗi: ${msg}`, latencyMs: Date.now() - t0 });
          warnings.push(`Tool ${tool.label} lỗi: ${msg}`);
          results.push({ type: "tool_result", toolUseId: u.id, content: JSON.stringify({ error: msg }), isError: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    status = "ERROR";
    error = e instanceof Error ? e.message : String(e);
  }
  if (status === "OK" && pending.length) status = "NEEDS_CONFIRMATION";
  if (!answer && status === "OK") answer = "(AI không trả lời)";
  answer = clip(answer, COPILOT_LIMITS.maxAnswerChars);

  const latencyMs = Date.now() - started;
  const costUsd = estimateCostUsd(model, usage);
  let interactionId: string | null = null;
  try {
    const db = await getDb();
    const [row] = await db
      .insert(schema.aiInteractions)
      .values({
        userId: input.user.id,
        userEmail: input.user.email,
        provider: provider.name,
        model,
        route: input.context.route,
        entityType: input.context.entityType,
        entityId: input.context.entityId,
        prompt: message,
        answer,
        toolCalls,
        actionsProposed: pending,
        actionsExecuted: [],
        usage,
        // Chuỗi rỗng = chưa biết giá (model chưa có trong bảng), không phải 0.
        costUsd: costUsd === null ? "" : costUsd.toFixed(6),
        latencyMs,
        rounds,
        status,
        error: error ?? null,
      })
      .returning({ id: schema.aiInteractions.id });
    interactionId = row?.id ?? null;
  } catch (e) {
    warnings.push(`Không ghi được nhật ký AI: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { interactionId, status, answer, toolCalls, pendingActions: pending, warnings: [...new Set(warnings)], usage, costUsd, latencyMs, rounds, model, error };
}

/**
 * Người dùng xác nhận các hành động AI đề nghị. Kiểm lại từ đầu: đúng người, đúng token, còn quyền,
 * tool còn được phép — rồi mới gọi tool. Kết quả ghi thêm vào `actions_executed` (chỉ thêm).
 */
export async function confirmCopilotActions(input: { user: SessionUser; interactionId: string; tokens: string[]; now?: Date }): Promise<CopilotConfirmResult> {
  const db = await getDb();
  const [row] = await db.select().from(schema.aiInteractions).where(eq(schema.aiInteractions.id, input.interactionId));
  if (!row) return { error: "Không tìm thấy lượt hỏi" };
  if (row.userId !== input.user.id) return { error: "Chỉ người đã hỏi mới xác nhận được" };
  const proposed = (Array.isArray(row.actionsProposed) ? row.actionsProposed : []) as CopilotPendingAction[];
  const already = (Array.isArray(row.actionsExecuted) ? row.actionsExecuted : []) as CopilotExecutedAction[];
  const tokens = [...new Set(input.tokens)];
  if (!tokens.length) return { error: "Chưa chọn hành động nào" };
  const now = input.now ?? new Date();
  const ctx: AiToolContext = { user: input.user, actor: actorOf(input.user), route: row.route, entityType: row.entityType, entityId: row.entityId, now };
  // Hai pha: KIỂM hết rồi mới CHẠY. Nếu chạy dở rồi mới phát hiện token sai thì hành động đã chạy
  // sẽ không được ghi nhận và có thể bị chạy lại lần sau.
  type Plan = { token: string; p: CopilotPendingAction; tool: AiToolDefinition | null; input: unknown };
  const plan: Plan[] = [];
  for (const token of tokens) {
    const p = proposed.find((x) => x.token === token);
    if (!p) return { error: "Hành động không nằm trong đề nghị của lượt hỏi này" };
    if (already.some((x) => x.token === token)) {
      plan.push({ token, p, tool: null, input: null });
      continue;
    }
    const tool = getTool(p.name);
    if (!tool || tool.kind !== "write" || tool.policy === "forbidden") return { error: `Hành động ${p.name} không còn được phép` };
    if (!can(input.user, tool.permission)) return { error: `Thiếu quyền ${tool.permission}` };
    if (!verifyActionToken(token, input.user.id, tool.name, p.input)) return { error: "Token xác nhận không khớp — hành động đã bị sửa" };
    const parsed = tool.input.safeParse(p.input);
    if (!parsed.success) return { error: "Input hành động không còn hợp lệ" };
    plan.push({ token, p, tool, input: parsed.data });
  }
  const executed: CopilotExecutedAction[] = [];
  for (const { token, p, tool, input: data } of plan) {
    if (!tool) {
      executed.push({ token, name: p.name, label: p.label, ok: false, summary: "Đã chạy trước đó — không chạy lại", at: now.toISOString() });
      continue;
    }
    let ok = false;
    let summary = "";
    try {
      const out = await tool.run(ctx, data);
      ok = !(out && typeof out === "object" && "error" in out);
      summary = ok ? p.summary : `Lỗi: ${String((out as { error: unknown }).error)}`;
    } catch (e) {
      summary = `Lỗi: ${e instanceof Error ? e.message : String(e)}`;
    }
    executed.push({ token, name: tool.name, label: tool.label, ok, summary, at: now.toISOString() });
  }
  await db
    .update(schema.aiInteractions)
    .set({ actionsExecuted: [...already, ...executed] })
    .where(eq(schema.aiInteractions.id, input.interactionId));
  await audit({
    userId: input.user.id,
    userEmail: input.user.email,
    action: "AI_ACTIONS_CONFIRMED",
    entity: "AI_INTERACTION",
    entityId: input.interactionId,
    after: executed.map((e) => ({ name: e.name, ok: e.ok, summary: e.summary })),
    reason: "Người dùng xác nhận hành động do AI đề nghị",
  });
  return { ok: true, data: { interactionId: input.interactionId, executed } };
}

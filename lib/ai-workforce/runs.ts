/**
 * SỔ LƯỢT CHẠY — tầng quan sát của nền tảng nhân sự AI.
 *
 * Một lượt chạy phải trả lời đủ: tin nhắn vào · trạng thái trước · ý định & thực thể · công cụ đã
 * gọi · kết quả công cụ · quyết định · câu gợi ý · trạng thái sau · mô hình · token · chi phí ·
 * độ trễ · lỗi. Thiếu một mảnh thì khi máy trả lời sai không ai lần ngược được — mà đó chính là
 * lúc cần sổ này nhất.
 *
 * Ghi sổ KHÔNG BAO GIỜ làm hỏng việc chính: mọi lời gọi ở đây đều nuốt lỗi của chính nó.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { ModelAttempt } from "@/lib/ai-workforce/model-router";
import type { AgentMode, RunStatus, RouteTier, EscalationReason } from "@/lib/constants/ai";
import type { ToolName, ToolOutcome } from "@/lib/constants/ai-tools";
import { redactSecrets } from "@/lib/audit";

export type RunRecorder = {
  id: string;
  agentId: string;
  agentKey: string;
  mode: AgentMode;
  /** Ghi một lần chạm vào ERP (kể cả lần bị từ chối). */
  tool: (call: { tool: ToolName; outcome: ToolOutcome; args: unknown; result?: unknown; error?: string | null; latencyMs: number }) => Promise<void>;
  /** Ghi các lần gọi nhà cung cấp mô hình của một bước. */
  model: (attempts: ModelAttempt[]) => Promise<void>;
  finish: (params: {
    status: RunStatus;
    stateAfter?: unknown;
    understanding?: unknown;
    decision?: unknown;
    suggestedReply?: string;
    tier?: RouteTier;
    escalationReason?: EscalationReason | null;
    error?: string | null;
  }) => Promise<void>;
};

export type StartRunInput = {
  agentId: string;
  agentKey: string;
  agentVersionId?: string | null;
  taskId?: string | null;
  eventId?: string | null;
  mode: AgentMode;
  subjectType: string;
  subjectId: string;
  input?: unknown;
  stateBefore?: unknown;
};

/**
 * Mở một lượt chạy. Trả về một "cây bút" ghi tiếp các mảnh còn lại.
 * Mọi dữ liệu ghi vào sổ đều đi qua `redactSecrets()` — kho mã là PUBLIC, sổ có thể được chụp
 * màn hình, và một token lọt vào đây là lộ vĩnh viễn.
 */
export async function startRun(params: StartRunInput, db?: Db): Promise<RunRecorder> {
  const conn = db ?? (await getDb());
  const [row] = await conn
    .insert(schema.aiRuns)
    .values({
      agentId: params.agentId,
      agentVersionId: params.agentVersionId ?? null,
      taskId: params.taskId ?? null,
      eventId: params.eventId ?? null,
      mode: params.mode,
      status: "RUNNING",
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      input: (redactSecrets(params.input) ?? null) as object | null,
      stateBefore: (redactSecrets(params.stateBefore) ?? null) as object | null,
      startedAt: new Date(),
    })
    .returning({ id: schema.aiRuns.id });

  const runId = row.id;
  const startedAt = Date.now();
  let seq = 0;

  return {
    id: runId,
    agentId: params.agentId,
    agentKey: params.agentKey,
    mode: params.mode,

    async tool(call) {
      try {
        seq += 1;
        await conn.insert(schema.aiToolCalls).values({
          runId,
          seq,
          tool: call.tool,
          outcome: call.outcome,
          args: (redactSecrets(call.args) ?? null) as object | null,
          result: (redactSecrets(call.result) ?? null) as object | null,
          error: call.error ? call.error.slice(0, 1000) : null,
          latencyMs: Math.max(0, Math.round(call.latencyMs)),
        });
      } catch {
        // ghi sổ hỏng không được làm hỏng việc
      }
    },

    async model(attempts) {
      if (!attempts.length) return;
      try {
        await conn.insert(schema.aiModelCalls).values(
          attempts.map((a) => ({
            runId,
            provider: a.provider,
            model: a.model,
            tier: a.tier,
            step: a.step,
            inputTokens: a.inputTokens,
            outputTokens: a.outputTokens,
            cachedInputTokens: a.cachedInputTokens,
            costVnd: a.costVnd,
            pricingVersion: a.pricingVersion,
            // Ảnh chụp đơn giá ĐÃ DÙNG — để tháng sau nhà cung cấp đổi giá thì lịch sử vẫn tính
            // đúng theo giá lúc gọi, thay vì phải tin vào một bảng giá có thể đã bị ghi đè.
            inputPriceVndPerMillion: a.inputPriceVndPerMillion,
            cachedInputPriceVndPerMillion: a.cachedInputPriceVndPerMillion,
            outputPriceVndPerMillion: a.outputPriceVndPerMillion,
            latencyMs: Math.max(0, Math.round(a.latencyMs)),
            ok: a.ok,
            error: a.error ? a.error.slice(0, 1000) : null,
          })),
        );
      } catch {
        // như trên
      }
    },

    async finish(result) {
      try {
        // Tổng token / chi phí lấy từ chính sổ chi phí, không cộng tay ở nhiều nơi.
        const [totals] = await conn
          .select({
            input: sql<number>`coalesce(sum(${schema.aiModelCalls.inputTokens}), 0)`,
            output: sql<number>`coalesce(sum(${schema.aiModelCalls.outputTokens}), 0)`,
            cached: sql<number>`coalesce(sum(${schema.aiModelCalls.cachedInputTokens}), 0)`,
            /** Có lần gọi nào chưa khai đơn giá không — nếu có thì tổng chi phí là CHƯA BIẾT. */
            unpriced: sql<number>`count(*) filter (where ${schema.aiModelCalls.costVnd} is null)`,
            cost: sql<number>`coalesce(sum(${schema.aiModelCalls.costVnd}), 0)`,
            calls: sql<number>`count(*)`,
            /** Phiên bản bảng giá của các lần gọi ĐÃ tính được tiền. */
            version: sql<string>`coalesce(max(${schema.aiModelCalls.pricingVersion}) filter (where ${schema.aiModelCalls.costVnd} is not null), '')`,
            /** Số phiên bản giá khác nhau trong cùng một lượt chạy — hơn một là bất thường. */
            versions: sql<number>`count(distinct ${schema.aiModelCalls.pricingVersion}) filter (where ${schema.aiModelCalls.costVnd} is not null)`,
          })
          .from(schema.aiModelCalls)
          .where(eq(schema.aiModelCalls.runId, runId));
        const calls = Number(totals?.calls ?? 0);
        const unpriced = Number(totals?.unpriced ?? 0);
        // Hai bảng giá khác nhau trong một lượt chạy thì tổng không thuộc phiên bản nào cả —
        // nói "hỗn hợp" còn hơn gắn nhãn một phiên bản mà chỉ đúng một nửa.
        const pricingVersion = calls === 0 || unpriced > 0 ? "" : Number(totals?.versions ?? 0) > 1 ? "hon-hop" : String(totals?.version ?? "");
        await conn
          .update(schema.aiRuns)
          .set({
            status: result.status,
            stateAfter: (redactSecrets(result.stateAfter) ?? null) as object | null,
            understanding: (redactSecrets(result.understanding) ?? null) as object | null,
            decision: (redactSecrets(result.decision) ?? null) as object | null,
            suggestedReply: result.suggestedReply ?? "",
            tier: result.tier ?? "RULE",
            escalationReason: result.escalationReason ?? null,
            inputTokens: Number(totals?.input ?? 0),
            outputTokens: Number(totals?.output ?? 0),
            cachedInputTokens: Number(totals?.cached ?? 0),
            // Không gọi mô hình lần nào ⇒ chi phí THẬT SỰ bằng 0. Có gọi mà thiếu đơn giá ⇒ null.
            costVnd: calls === 0 ? 0 : unpriced > 0 ? null : Number(totals?.cost ?? 0),
            pricingVersion,
            latencyMs: Date.now() - startedAt,
            error: result.error ? result.error.slice(0, 2000) : null,
            finishedAt: new Date(),
          })
          .where(eq(schema.aiRuns.id, runId));
      } catch {
        // như trên
      }
    },
  };
}

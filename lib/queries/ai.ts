/**
 * TRUY VẤN QUAN SÁT NHÂN SỰ AI (chỉ-server).
 *
 * Màn hình `/ai` phải trả lời được đúng một câu hỏi: **máy đã quyết định gì, dựa vào đâu, và câu
 * nhân viên thật sự trả lời khác ra sao.** Vì thế mọi truy vấn ở đây đều kéo theo đủ mảnh để dựng
 * lại một lượt chạy, chứ không chỉ in ra một con số tổng.
 *
 * Chi phí: `NULL` là CHƯA BIẾT (chưa khai đơn giá mô hình), KHÔNG phải 0đ — đúng luật tiền của ERP.
 */
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import type { RunStatus } from "@/lib/constants/ai";
import type { SalesStage } from "@/lib/constants/sales-agent";

export type AiRunRow = {
  id: string;
  agentKey: string;
  agentName: string;
  mode: string;
  status: RunStatus;
  stage: string;
  action: string;
  tier: string;
  escalationReason: string | null;
  conversationId: string;
  customerName: string;
  customerMessage: string;
  suggestedReply: string;
  humanReply: string;
  toolCalls: number;
  deniedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** null = chưa khai đơn giá cho mô hình đã dùng ⇒ CHƯA BIẾT. */
  costVnd: number | null;
  latencyMs: number;
  error: string | null;
  startedAt: Date;
};

export type AiRunFilters = { agentKey?: string; status?: RunStatus[]; days?: number; limit?: number };

export async function listAiRuns(filters: AiRunFilters = {}): Promise<AiRunRow[]> {
  const db = await getDb();
  const days = Math.min(Math.max(filters.days ?? 7, 1), 90);
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      id: schema.aiRuns.id,
      agentKey: schema.aiAgents.key,
      agentName: schema.aiAgents.name,
      mode: schema.aiRuns.mode,
      status: schema.aiRuns.status,
      tier: schema.aiRuns.tier,
      escalationReason: schema.aiRuns.escalationReason,
      subjectId: schema.aiRuns.subjectId,
      input: schema.aiRuns.input,
      decision: schema.aiRuns.decision,
      stateAfter: schema.aiRuns.stateAfter,
      suggestedReply: schema.aiRuns.suggestedReply,
      inputTokens: schema.aiRuns.inputTokens,
      outputTokens: schema.aiRuns.outputTokens,
      costVnd: schema.aiRuns.costVnd,
      latencyMs: schema.aiRuns.latencyMs,
      error: schema.aiRuns.error,
      startedAt: schema.aiRuns.startedAt,
      customerName: schema.salesConversations.customerName,
      toolCalls: sql<number>`(select count(*) from ${schema.aiToolCalls} where ${schema.aiToolCalls.runId} = ${schema.aiRuns.id})`,
      deniedCalls: sql<number>`(select count(*) from ${schema.aiToolCalls} where ${schema.aiToolCalls.runId} = ${schema.aiRuns.id} and ${schema.aiToolCalls.outcome} = 'DENIED')`,
      humanReply: sql<string>`coalesce((select s.human_reply from sales_suggestions s where s.run_id = ${schema.aiRuns.id} limit 1), '')`,
    })
    .from(schema.aiRuns)
    .innerJoin(schema.aiAgents, eq(schema.aiAgents.id, schema.aiRuns.agentId))
    .leftJoin(schema.salesConversations, eq(schema.salesConversations.id, schema.aiRuns.subjectId))
    .where(and(gte(schema.aiRuns.startedAt, since), filters.agentKey ? eq(schema.aiAgents.key, filters.agentKey) : undefined))
    .orderBy(desc(schema.aiRuns.startedAt))
    .limit(Math.min(filters.limit ?? 200, 500));

  return rows.map((r) => {
    const input = (r.input ?? {}) as Record<string, unknown>;
    const decision = (r.decision ?? {}) as Record<string, unknown>;
    const stateAfter = (r.stateAfter ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      agentKey: r.agentKey,
      agentName: r.agentName,
      mode: r.mode,
      status: r.status as RunStatus,
      stage: String(stateAfter.stage ?? ""),
      action: String(decision.action ?? ""),
      tier: r.tier,
      escalationReason: r.escalationReason,
      conversationId: r.subjectId,
      customerName: r.customerName ?? "",
      customerMessage: String(input.text ?? ""),
      suggestedReply: r.suggestedReply,
      humanReply: r.humanReply ?? "",
      toolCalls: Number(r.toolCalls ?? 0),
      deniedCalls: Number(r.deniedCalls ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      costVnd: r.costVnd === null ? null : Number(r.costVnd),
      latencyMs: Number(r.latencyMs ?? 0),
      error: r.error,
      startedAt: r.startedAt,
    };
  });
}

export type AiRunDetail = NonNullable<Awaited<ReturnType<typeof getAiRunDetail>>>;

/** Toàn bộ mảnh của MỘT lượt chạy — đủ để dựng lại quyết định mà không cần mở CSDL. */
export async function getAiRunDetail(id: string) {
  const db = await getDb();
  const run = await db.query.aiRuns.findFirst({ where: eq(schema.aiRuns.id, id) });
  if (!run) return null;
  const [agent, toolCalls, modelCalls, suggestion] = await Promise.all([
    db.query.aiAgents.findFirst({ where: eq(schema.aiAgents.id, run.agentId), columns: { key: true, name: true } }),
    db.query.aiToolCalls.findMany({ where: eq(schema.aiToolCalls.runId, id), orderBy: (t, { asc }) => [asc(t.seq)] }),
    db.query.aiModelCalls.findMany({ where: eq(schema.aiModelCalls.runId, id), orderBy: (m, { asc }) => [asc(m.createdAt)] }),
    db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.runId, id) }),
  ]);
  const conversation = run.subjectType === "CONVERSATION" ? await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, run.subjectId) }) : null;
  const messages = conversation
    ? await db.query.salesMessages.findMany({
        where: eq(schema.salesMessages.conversationId, conversation.id),
        orderBy: (m, { desc: d }) => [d(m.sentAt), d(m.createdAt)],
        limit: 12,
      })
    : [];
  return { run, agent, toolCalls, modelCalls, suggestion, conversation, messages: messages.reverse() };
}

export type AiSummary = {
  runs: number;
  succeeded: number;
  handedOff: number;
  failed: number;
  deniedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** null = có lượt chạy chưa khai được đơn giá ⇒ tổng chi phí CHƯA BIẾT. */
  costVnd: number | null;
  unpricedRuns: number;
  medianLatencyMs: number;
  sentToCustomer: number;
  suggestionsWithHumanReply: number;
  suggestions: number;
};

/** Tổng hợp N ngày gần nhất. Cache ngắn vì màn hình này hay được mở lại liên tục khi đang theo dõi. */
export async function aiSummary(days = 7): Promise<AiSummary> {
  return memo(`ai:summary:${days}`, 60_000, async () => {
    const db = await getDb();
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000);
    const [totals] = await db
      .select({
        runs: count(),
        succeeded: sql<number>`count(*) filter (where ${schema.aiRuns.status} = 'SUCCEEDED')`,
        handedOff: sql<number>`count(*) filter (where ${schema.aiRuns.status} = 'HANDED_OFF')`,
        failed: sql<number>`count(*) filter (where ${schema.aiRuns.status} = 'FAILED')`,
        inputTokens: sql<number>`coalesce(sum(${schema.aiRuns.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.aiRuns.outputTokens}), 0)`,
        cost: sql<number>`coalesce(sum(${schema.aiRuns.costVnd}), 0)`,
        unpriced: sql<number>`count(*) filter (where ${schema.aiRuns.costVnd} is null)`,
        medianLatency: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${schema.aiRuns.latencyMs}), 0)`,
      })
      .from(schema.aiRuns)
      .where(gte(schema.aiRuns.startedAt, since));
    const [tools] = await db
      .select({ denied: sql<number>`count(*) filter (where ${schema.aiToolCalls.outcome} = 'DENIED')` })
      .from(schema.aiToolCalls)
      .where(gte(schema.aiToolCalls.createdAt, since));
    const [suggestions] = await db
      .select({
        total: count(),
        sent: sql<number>`count(*) filter (where ${schema.salesSuggestions.sent})`,
        withHuman: sql<number>`count(*) filter (where ${schema.salesSuggestions.humanReply} <> '')`,
      })
      .from(schema.salesSuggestions)
      .where(gte(schema.salesSuggestions.createdAt, since));
    const unpricedRuns = Number(totals?.unpriced ?? 0);
    return {
      runs: Number(totals?.runs ?? 0),
      succeeded: Number(totals?.succeeded ?? 0),
      handedOff: Number(totals?.handedOff ?? 0),
      failed: Number(totals?.failed ?? 0),
      deniedToolCalls: Number(tools?.denied ?? 0),
      inputTokens: Number(totals?.inputTokens ?? 0),
      outputTokens: Number(totals?.outputTokens ?? 0),
      costVnd: unpricedRuns > 0 ? null : Number(totals?.cost ?? 0),
      unpricedRuns,
      medianLatencyMs: Math.round(Number(totals?.medianLatency ?? 0)),
      sentToCustomer: Number(suggestions?.sent ?? 0),
      suggestionsWithHumanReply: Number(suggestions?.withHuman ?? 0),
      suggestions: Number(suggestions?.total ?? 0),
    };
  });
}

export type SalesStageCount = { stage: SalesStage | string; count: number };

export async function salesStageBreakdown(): Promise<SalesStageCount[]> {
  const db = await getDb();
  const rows = await db
    .select({ stage: schema.salesConversations.stage, n: count() })
    .from(schema.salesConversations)
    .groupBy(schema.salesConversations.stage)
    .orderBy(desc(count()));
  return rows.map((r) => ({ stage: r.stage, count: Number(r.n) }));
}

/** Lỗi nền tảng gần nhất — để trang quan sát không giấu phần hỏng. */
export async function recentAiErrors(limit = 20) {
  const db = await getDb();
  return db.query.aiErrors.findMany({ orderBy: (e, { desc: d }) => [d(e.createdAt)], limit });
}

/** Nhân sự AI đã đăng ký và nấc quyền hạn đang lưu trong CSDL. */
export async function listAiAgents() {
  const db = await getDb();
  return db.query.aiAgents.findMany({ orderBy: (a, { asc }) => [asc(a.key)] });
}

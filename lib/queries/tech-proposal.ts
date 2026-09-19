/**
 * Đọc bản đề xuất của AI CTO cho màn hình `/tech/cto`.
 *
 * CHỈ ĐỌC. Mọi phép ghi đi qua `lib/tech/proposal.ts`, và phép duyệt đi qua đúng một hàm ở đó.
 *
 * Mỗi dòng việc mang HAI mức rủi ro: `suggestedRisk` là AI *nghĩ*, `willBeRisk` là mức MÁY sẽ xếp
 * nếu duyệt bây giờ. Hai con số ấy đứng cạnh nhau có chủ ý — chỗ chúng lệch nhau là chỗ người
 * duyệt cần nhìn kỹ, chứ không phải chỗ cần giấu đi.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { previewRisk } from "@/lib/tech/proposal";
import type { TechRisk } from "@/lib/constants/tech";

export type ProposalTaskRow = {
  id: string;
  key: string;
  seq: number;
  title: string;
  description: string;
  taskType: string;
  module: string;
  suggestedPriority: string;
  suggestedRisk: TechRisk;
  /** Mức MÁY sẽ xếp nếu duyệt bây giờ — `classifyTechRisk()`, không phải ý kiến của AI. */
  willBeRisk: TechRisk;
  riskExplanation: string;
  suggestedAgentKey: string;
  dependsOnKeys: string[];
  acceptanceCriteria: string[];
  expectedScope: string[];
  needsHumanDecision: boolean;
  humanDecisionNote: string;
  appliedTaskId: string | null;
  appliedRisk: string;
  appliedCode: string | null;
};

export type ProposalRow = {
  id: string;
  status: string;
  sourceTaskId: string;
  sourceCode: string;
  sourceTitle: string;
  agentKey: string;
  provider: string;
  model: string;
  summary: string;
  assumptions: string[];
  questions: string[];
  error: string;
  decidedByName: string;
  decidedAt: Date | null;
  decisionNote: string;
  createdAt: Date;
  tasks: ProposalTaskRow[];
};

export async function listTechProposals(limit = 20): Promise<ProposalRow[]> {
  const db = await getDb();
  const rows = await db.query.techProposals.findMany({ orderBy: [desc(schema.techProposals.createdAt)], limit });
  if (!rows.length) return [];

  const out: ProposalRow[] = [];
  for (const p of rows) {
    const source = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, p.sourceTaskId) });
    const items = await db.query.techProposalTasks.findMany({
      where: eq(schema.techProposalTasks.proposalId, p.id),
      orderBy: (t, { asc }) => [asc(t.seq)],
    });
    const tasks: ProposalTaskRow[] = [];
    for (const t of items) {
      const applied = t.appliedTaskId ? await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t.appliedTaskId) }) : null;
      tasks.push({
        id: t.id,
        key: t.key,
        seq: t.seq,
        title: t.title,
        description: t.description,
        taskType: t.taskType,
        module: t.module,
        suggestedPriority: t.suggestedPriority,
        suggestedRisk: t.suggestedRisk as TechRisk,
        willBeRisk: previewRisk({ title: t.title, description: t.description, taskType: t.taskType, module: t.module }),
        riskExplanation: t.riskExplanation,
        suggestedAgentKey: t.suggestedAgentKey,
        dependsOnKeys: (t.dependsOnKeys as string[]) ?? [],
        acceptanceCriteria: (t.acceptanceCriteria as string[]) ?? [],
        expectedScope: (t.expectedScope as string[]) ?? [],
        needsHumanDecision: t.needsHumanDecision,
        humanDecisionNote: t.humanDecisionNote,
        appliedTaskId: t.appliedTaskId,
        appliedRisk: t.appliedRisk,
        appliedCode: applied?.code ?? null,
      });
    }
    out.push({
      id: p.id,
      status: p.status,
      sourceTaskId: p.sourceTaskId,
      sourceCode: source?.code ?? "",
      sourceTitle: source?.title ?? "",
      agentKey: p.createdByAgentKey,
      provider: p.provider,
      model: p.model,
      summary: p.summary,
      assumptions: (p.assumptions as string[]) ?? [],
      questions: (p.questions as string[]) ?? [],
      error: p.error,
      decidedByName: p.decidedByName,
      decidedAt: p.decidedAt,
      decisionNote: p.decisionNote,
      createdAt: p.createdAt,
      tasks,
    });
  }
  return out;
}

/** Mục tiêu có thể nhờ AI CTO lập kế hoạch: việc đang mở, chưa có bản chờ duyệt nào. */
export async function ctoPlannableTasks(limit = 30) {
  const db = await getDb();
  const rows = await db.query.techTasks.findMany({
    where: (t, { ne: khac }) => khac(t.status, "DONE"),
    orderBy: [desc(schema.techTasks.createdAt)],
    limit,
  });
  return rows.map((t) => ({ id: t.id, code: t.code, title: t.title, module: t.module, risk: t.risk as TechRisk, status: t.status }));
}

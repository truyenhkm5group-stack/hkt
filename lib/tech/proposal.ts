/**
 * ═══════════ ĐỀ XUẤT CỦA AI CTO — MỘT ĐƯỜNG GHI, MỘT LẦN ÁP ═══════════
 *
 * AI CTO đọc một MỤC TIÊU và đề nghị cách chia nó ra. Bản đề nghị nằm ở `tech_proposals`, và
 * KHÔNG phải là việc: chừng nào chưa có NGƯỜI bấm duyệt, nó không có mặt ở hàng đợi nào, không
 * agent nào chạy được nó, không ai bị giao.
 *
 * ─── BA ĐIỀU TỆP NÀY BẢO VỆ ───
 *
 * 1. **AI không tạo việc thật.** `createProposal()` chỉ ghi vào hai bảng đề xuất. Đường duy nhất
 *    biến đề xuất thành `tech_tasks` là `approveProposal()`, và hàm đó từ chối mọi actor không
 *    phải người — cùng một cổng mà `decideTechApproval` và `seedTechAgents` đã dựng.
 *
 * 2. **AI không chọn mức rủi ro.** `suggested_risk` là ý kiến, giữ lại để đọc. Lúc áp, TỪNG việc
 *    đi qua `createTechTask()`, và hàm đó tự gọi `classifyTechRisk()`. Không có tham số nào ở đây
 *    truyền được một mức rủi ro xuống — nên kể cả một bản đề xuất nói "R0" cho việc sửa lương thì
 *    việc thật vẫn ra R2 và vẫn chờ chủ shop ký.
 *
 * 3. **Bấm duyệt hai lần không tạo hai bộ việc.** `applied_task_id` trên từng dòng đề xuất là cờ
 *    idempotent: đã có khoá thì bỏ qua dòng đó. Không dựa vào trạng thái của bản đề xuất, vì một
 *    lượt áp có thể hỏng giữa chừng và để lại một nửa.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { classifyTechRisk } from "@/lib/constants/tech-risk";
import type { CtoPlan } from "@/lib/constants/cto-proposal";
import type { TechModule, TechPriority, TechRisk, TechTaskType } from "@/lib/constants/tech";
import { createTechTask, type TechActor, type TechResult } from "@/lib/tech/service";

export type ProposalStatus = "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";

/** Trạng thái còn ÁP ĐƯỢC. Mọi trạng thái khác là đã quyết xong — áp lại là ghi đè một quyết định. */
const AP_DUOC: ProposalStatus[] = ["READY_FOR_REVIEW"];

export type CreateProposalInput = {
  sourceTaskId: string;
  agentId: string | null;
  agentKey: string;
  provider: string;
  model: string;
  /** `null` ⇒ lượt lập kế hoạch hỏng; `error` nói vì sao, và bản đề xuất nằm ở `DRAFT`. */
  plan: CtoPlan | null;
  error?: string;
  rawOutput?: unknown;
  /*
    Bằng chứng về lượt gọi. Bỏ trống ⇒ (1, '', 'NONE') — đúng với một lượt không có đường sửa nào,
    và đúng với mọi dòng đã có trước migration 0105. Ràng buộc `tech_proposals_repair_check` không
    cho hai cột này nói hai điều khác nhau.
  */
  modelCalls?: 0 | 1 | 2;
  initialError?: string;
  repairOutcome?: "NONE" | "PASS" | "FAIL";
};

/**
 * Ghi một bản đề xuất. Gọi được bởi AI — đây là TOÀN BỘ những gì AI CTO làm được.
 *
 * Bản hỏng vẫn được ghi, cố ý: một lượt lập kế hoạch thất bại mà không để lại dấu thì lần sau
 * không ai biết nó đã từng thất bại vì lý do gì.
 */
export async function createProposal(input: CreateProposalInput): Promise<TechResult<{ id: string; status: ProposalStatus }>> {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.sourceTaskId) });
  if (!task) return { error: "Không tìm thấy mục tiêu gốc." };

  const status: ProposalStatus = input.plan ? "READY_FOR_REVIEW" : "DRAFT";
  const [row] = await db
    .insert(schema.techProposals)
    .values({
      sourceTaskId: input.sourceTaskId,
      status,
      createdByAgentId: input.agentId,
      createdByAgentKey: input.agentKey,
      provider: input.provider,
      model: input.model,
      summary: input.plan?.summary ?? "",
      assumptions: input.plan?.assumptions ?? [],
      questions: input.plan?.questions ?? [],
      rawOutput: input.rawOutput ?? null,
      error: input.error?.slice(0, 4000) ?? "",
      modelCalls: input.modelCalls ?? 1,
      initialError: input.initialError?.slice(0, 4000) ?? "",
      repairOutcome: input.repairOutcome ?? "NONE",
    })
    .returning({ id: schema.techProposals.id });

  if (input.plan) {
    await db.insert(schema.techProposalTasks).values(
      input.plan.tasks.map((t, i) => ({
        proposalId: row.id,
        key: t.key,
        seq: i,
        title: t.title,
        description: t.description,
        taskType: t.taskType,
        module: t.module,
        suggestedPriority: t.suggestedPriority,
        suggestedRisk: t.suggestedRisk,
        riskExplanation: t.riskExplanation,
        suggestedAgentKey: t.suggestedAgent,
        dependsOnKeys: t.dependsOn,
        acceptanceCriteria: t.acceptanceCriteria,
        expectedScope: t.expectedScope,
        needsHumanDecision: t.needsHumanDecision,
        humanDecisionNote: t.humanDecisionNote,
      })),
    );
  }
  return { ok: true, id: row.id, status };
}

/** Chặn đích danh AI ở mọi cổng quyết định. Cùng câu chữ với các cổng đã có ở `lib/tech/service.ts`. */
function chanAgent(viec: string): { error: string } {
  return { error: `Agent KHÔNG được ${viec} — đây là cổng phê duyệt, nó tồn tại để một con người chịu trách nhiệm.` };
}

export type ApplyResult = {
  created: number;
  skipped: number;
  tasks: { key: string; taskId: string; code: string; suggestedRisk: TechRisk; appliedRisk: TechRisk; riskChanged: boolean }[];
};

/**
 * NGƯỜI duyệt bản kế hoạch ⇒ tạo việc thật.
 *
 * Bảy bước, đúng thứ tự, và không bước nào bỏ được:
 *   1. xác minh NGƯỜI · 2. bản còn hiệu lực · 3. tạo qua `createTechTask()` (máy tự xếp rủi ro)
 *   4. nối phụ thuộc bằng khoá THẬT · 5. ghi ngược mapping · 6. chốt trạng thái · 7. nhật ký
 */
export async function approveProposal(
  input: { proposalId: string; note?: string },
  actor: TechActor,
): Promise<TechResult<ApplyResult>> {
  if (actor.kind !== "HUMAN") return chanAgent("duyệt kế hoạch của chính nó");
  const db = await getDb();
  const p = await db.query.techProposals.findFirst({ where: eq(schema.techProposals.id, input.proposalId) });
  if (!p) return { error: "Không tìm thấy bản đề xuất." };

  const trangThai = p.status as ProposalStatus;
  /*
    ĐÃ TỪ CHỐI / ĐÃ BỊ THAY THẾ / CÒN NHÁP thì KHÔNG áp được.

    `APPROVED` là ngoại lệ có chủ ý: một lượt áp có thể hỏng giữa chừng (mất kết nối, một việc lỗi)
    và để lại bản đề xuất đã chốt nhưng mới tạo được vài việc. Cho chạy lại, và `applied_task_id`
    bảo đảm những dòng đã tạo không tạo lần nữa.
  */
  if (!AP_DUOC.includes(trangThai) && trangThai !== "APPROVED") {
    return { error: `Bản đề xuất đang ở trạng thái “${trangThai}” nên không áp được. Chỉ bản đang CHỜ DUYỆT mới tạo được việc.` };
  }

  const rows = await db.query.techProposalTasks.findMany({
    where: eq(schema.techProposalTasks.proposalId, p.id),
    orderBy: (t, { asc }) => [asc(t.seq)],
  });
  if (rows.length === 0) return { error: "Bản đề xuất không có việc nào để tạo." };

  const out: ApplyResult = { created: 0, skipped: 0, tasks: [] };
  /** khoá đề xuất → id việc thật, để nối `dependsOn` sau khi đã tạo đủ. */
  const theoKhoa = new Map<string, string>();

  for (const r of rows) {
    if (r.appliedTaskId) {
      // Đã tạo ở một lượt áp trước — KHÔNG tạo lại. Đây là toàn bộ phép idempotent.
      theoKhoa.set(r.key, r.appliedTaskId);
      out.skipped += 1;
      continue;
    }
    const res = await createTechTask(
      {
        title: r.title,
        description: r.description,
        taskType: r.taskType as TechTaskType,
        module: r.module as TechModule,
        priority: r.suggestedPriority as TechPriority,
        source: "OWNER",
        sourceRef: `proposal:${p.id}`,
        parentTaskId: p.sourceTaskId,
        // KHÔNG truyền `riskOverride`: mức rủi ro do `classifyTechRisk()` quyết, không do AI.
      },
      actor,
    );
    if (!("ok" in res)) return { error: `Không tạo được việc “${r.title}”: ${res.error}` };

    theoKhoa.set(r.key, res.id);
    await db
      .update(schema.techProposalTasks)
      .set({ appliedTaskId: res.id, appliedRisk: res.risk })
      .where(eq(schema.techProposalTasks.id, r.id));
    out.created += 1;
    out.tasks.push({
      key: r.key,
      taskId: res.id,
      code: res.code,
      suggestedRisk: r.suggestedRisk as TechRisk,
      appliedRisk: res.risk,
      // Hai con số lệch nhau là tín hiệu đáng xem: AI đoán một đằng, máy xếp một nẻo.
      riskChanged: r.suggestedRisk !== res.risk,
    });
  }

  /*
    NỐI PHỤ THUỘC SAU KHI ĐÃ TẠO ĐỦ.

    `depends_on_keys` trỏ bằng khoá cục bộ (`T1`), còn `tech_tasks.depends_on` cần id thật — mà id
    của việc sau chưa tồn tại lúc tạo việc trước. Nên đây là lượt thứ hai, và nó chạy lại được:
    ghi đè bằng đúng tập id suy ra từ khoá.
  */
  for (const r of rows) {
    const taskId = theoKhoa.get(r.key);
    if (!taskId) continue;
    const deps = (r.dependsOnKeys as string[]).map((k) => theoKhoa.get(k)).filter((v): v is string => Boolean(v));
    if (deps.length) await db.update(schema.techTasks).set({ dependsOn: deps }).where(eq(schema.techTasks.id, taskId));
  }

  if (trangThai !== "APPROVED") {
    await db
      .update(schema.techProposals)
      .set({
        status: "APPROVED",
        decidedBy: actor.id ?? null,
        decidedByName: actor.name,
        decidedAt: new Date(),
        decisionNote: input.note?.trim() ?? "",
        updatedAt: new Date(),
      })
      .where(eq(schema.techProposals.id, p.id));
  }
  return { ok: true, ...out };
}

/** NGƯỜI từ chối. Bắt buộc nói vì sao — lần lập lại kế hoạch sau đọc chính câu đó. */
export async function rejectProposal(input: { proposalId: string; reason: string }, actor: TechActor): Promise<TechResult> {
  if (actor.kind !== "HUMAN") return chanAgent("từ chối kế hoạch");
  const reason = input.reason.trim();
  if (reason.length < 10) return { error: "Từ chối thì phải nói vì sao — nếu không, lần lập lại kế hoạch sau lặp đúng sai lầm cũ." };
  const db = await getDb();
  const p = await db.query.techProposals.findFirst({ where: eq(schema.techProposals.id, input.proposalId) });
  if (!p) return { error: "Không tìm thấy bản đề xuất." };
  if (p.status === "APPROVED") return { error: "Bản đã duyệt rồi thì không từ chối ngược được — việc thật đã tồn tại." };
  await db
    .update(schema.techProposals)
    .set({ status: "REJECTED", decidedBy: actor.id ?? null, decidedByName: actor.name, decidedAt: new Date(), decisionNote: reason, updatedAt: new Date() })
    .where(eq(schema.techProposals.id, input.proposalId));
  return { ok: true };
}

/**
 * Đánh dấu các bản CHỜ DUYỆT cũ của cùng một mục tiêu là ĐÃ BỊ THAY THẾ.
 *
 * Gọi khi lập lại kế hoạch. Bản cũ KHÔNG bị xoá — nó vẫn đọc được để so hai lần AI nghĩ khác
 * nhau chỗ nào — nhưng nó thôi áp được, nên không ai lỡ tay duyệt một kế hoạch đã lỗi thời.
 */
export async function supersedeOpenProposals(sourceTaskId: string, byProposalId: string): Promise<number> {
  const db = await getDb();
  const cu = await db.query.techProposals.findMany({
    where: and(eq(schema.techProposals.sourceTaskId, sourceTaskId), inArray(schema.techProposals.status, ["DRAFT", "READY_FOR_REVIEW"])),
  });
  const ids = cu.map((c) => c.id).filter((id) => id !== byProposalId);
  if (!ids.length) return 0;
  await db
    .update(schema.techProposals)
    .set({ status: "SUPERSEDED", supersededById: byProposalId, updatedAt: new Date() })
    .where(inArray(schema.techProposals.id, ids));
  return ids.length;
}

/** Mức rủi ro MÁY sẽ xếp cho một dòng đề xuất — để màn hình nói trước "duyệt xong nó sẽ là R2". */
export function previewRisk(row: { title: string; description: string; taskType: string; module: string }): TechRisk {
  return classifyTechRisk({
    taskType: row.taskType as TechTaskType,
    module: row.module as TechModule,
    title: row.title,
    description: row.description,
  }).risk;
}

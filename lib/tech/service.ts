import { DO_DAI_TOI_THIEU_GHI_CHU_LOI, REVIEW_VERDICTS, type ReviewVerdict } from "@/lib/constants/agent-clean-streak";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  canTransitionTechIncident,
  canTransitionTechTask,
  TECH_AGENT_TEMPLATES,
  TECH_TASK_STATUS_LABEL,
  techDeployBlockers,
  techIncidentCloseBlockers,
  type TechActorKind,
  type TechApprovalStatus,
  type TechEventKind,
  type TechGateResult,
  type TechIncidentSeverity,
  type TechIncidentStatus,
  type TechModule,
  type TechPriority,
  TECH_RISKS,
  type TechRisk,
  type TechTaskSource,
  type TechTaskStatus,
  type TechTaskType,
} from "@/lib/constants/tech";
import { classifyTechRisk } from "@/lib/constants/tech-risk";

/**
 * ═══════════ DỊCH VỤ CỦA PHÒNG TECH — MỘT ĐƯỜNG GHI DUY NHẤT ═══════════
 *
 * Mọi lượt ghi vào mặt phẳng điều khiển Tech đi qua tệp này. `lib/actions/tech.ts` chỉ là lớp vỏ
 * mỏng: kiểm quyền → gọi vào đây → `audit()` → `revalidatePath`. Tách như vậy vì hai lý do:
 *
 *  1. Luật vòng đời (chuyển trạng thái nào hợp lệ, cổng phê duyệt, chống bấm hai lần) KIỂM THỬ
 *     ĐƯỢC mà không cần dựng một phiên đăng nhập Next.js. Luật không kiểm thử được là luật sẽ trôi.
 *  2. Phase 2 sẽ có một agent gọi vào đúng những hàm này với `actor.kind = "AI_AGENT"`. Nếu luật
 *     nằm trong Server Action thì agent sẽ phải có đường ghi RIÊNG — và hai đường ghi cho một sự
 *     việc luôn lệch nhau (AGENTS.md mục 32).
 *
 * ─── AI LÀM: BA LOẠI, KHOÁ ĐI CÙNG TÊN ───
 *
 * `TechActor` bắt nơi gọi khai CẢ `kind` lẫn danh tính. `id` chỉ có nghĩa khi `kind = "HUMAN"`;
 * `agentId` chỉ có nghĩa khi `kind = "AI_AGENT"`. Ràng buộc CHECK ở CSDL ép đúng điều đó, nên một
 * đường ghi mới không thể lặng lẽ ghi một agent thành người (AGENTS.md mục 34 & 36).
 */
export type TechActor = {
  kind: TechActorKind;
  /** `users.id` — CHỈ khi `kind = "HUMAN"`. */
  id?: string | null;
  /** `tech_agents.id` — CHỈ khi `kind = "AI_AGENT"`. */
  agentId?: string | null;
  /** Ảnh chụp tên để người đọc. Máy chủ đọc từ `users`/`tech_agents`, không nhận từ client. */
  name: string;
};

export type TechResult<T = object> = ({ ok: true } & T) | { error: string };

type Db = Awaited<ReturnType<typeof getDb>>;

/*
  ═══════════ HAI CỔNG CUỐI CÙNG TRƯỚC PRODUCTION CHỈ NGƯỜI MỚI MỞ ĐƯỢC ═══════════

  ERP KHÔNG kích hoạt được một lượt deploy — GitHub Actions giữ thẩm quyền đó, và client GitHub
  trong kho này chỉ có `GET`. Nhưng hai thứ agent VẪN chạm tới được nếu không chặn, và cả hai đều
  là lời KHẲNG ĐỊNH về production chứ không phải một ô dữ liệu:

  · `READY_TO_DEPLOY` / `DEPLOYING` — nhãn "việc này sẵn sàng ra production". Một agent tự dán
    nhãn đó lên việc của chính nó là AI tự chấm mình lần thứ hai, ở đúng chỗ tốn kém nhất.
  · `tech_deployments` — sổ QUAN SÁT. Dòng do agent gõ vào trông y hệt dòng do lượt đồng bộ
    GitHub nạp về, nên một lượt deploy chưa từng xảy ra vẫn đọc ra như đã xảy ra, và phép đối
    chiếu commit (VERIFIED / MISMATCH) đứng trên một quan sát bịa.

  Lượt đồng bộ GitHub ghi thẳng với `actorKind: "SYSTEM"` (xem `lib/integrations/github/
  deployments.ts`), KHÔNG đi qua hai hàm dưới, nên cổng này không chặn nhầm nó. Cấm đích danh
  `AI_AGENT` chứ không đòi `HUMAN`: một job nền của hệ thống vẫn phải ghi được sổ quan sát.
*/
function chanAgent(viec: string): { error: string } | null {
  return { error: `Agent KHÔNG được ${viec} — đây là lời khẳng định về production, phải có một con người chịu trách nhiệm. Phòng Tech AI không có đường tự deploy, và cũng không có đường tự nói rằng mình đã deploy.` };
}

/** Chuẩn hoá người thao tác về đúng ba cột mà ràng buộc CSDL chấp nhận. */
function coloumnsOfActor(actor: TechActor) {
  return {
    actorKind: actor.kind,
    actorId: actor.kind === "HUMAN" ? (actor.id ?? null) : null,
    actorAgentId: actor.kind === "AI_AGENT" ? (actor.agentId ?? null) : null,
    actorName: actor.name,
  };
}

async function ghiSuKien(
  db: Db,
  input: { taskId: string; kind: TechEventKind; note?: string; previousValue?: string; nextValue?: string; payload?: unknown },
  actor: TechActor,
) {
  await db.insert(schema.techTaskEvents).values({
    taskId: input.taskId,
    kind: input.kind,
    note: input.note ?? "",
    previousValue: input.previousValue ?? "",
    nextValue: input.nextValue ?? "",
    payload: (input.payload as object) ?? null,
    ...coloumnsOfActor(actor),
  });
}

/**
 * MÃ VIỆC ĐỌC ĐƯỢC (`TECH-12`).
 *
 * Tính từ số lớn nhất đang có chứ không phải từ `count(*)`: xoá một việc rồi thì `count` sẽ cấp lại
 * một mã đã từng dùng, và hai việc khác nhau mang cùng một mã trong lịch sử chat là cách chắc chắn
 * nhất để hai người nói về hai thứ mà tưởng là một.
 *
 * Có khoá duy nhất ở CSDL đứng sau, nên hai lượt tạo cùng lúc thì lượt thua sẽ lỗi và được thử lại
 * ở `createTechTask` — không im lặng ghi đè.
 */
async function nextCode(db: Db, prefix: "TECH" | "INC") {
  const bang = prefix === "TECH" ? schema.techTasks : schema.techIncidents;
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(nullif(regexp_replace(${bang.code}, '^[A-Z]+-', ''), '')::int), 0)` })
    .from(bang);
  return `${prefix}-${Number(row?.max ?? 0) + 1}`;
}

/**
 * GHI MỘT DÒNG NHẬT KÝ VIỆC TỪ BÊN NGOÀI TỆP NÀY.
 *
 * `ghiSuKien` nhận sẵn một `Db` vì mọi hàm trong tệp đã mở kết nối rồi. Job nền thì không — nên
 * đây là cửa cho chúng, và nó là cửa DUY NHẤT: mọi đường ghi nhật ký vẫn đi qua cùng một phép
 * chuẩn hoá người thao tác (`coloumnsOfActor`), nên không đường nào lặng lẽ ghi một job thành
 * một con người (AGENTS.md mục 34 & 36).
 */
export async function recordTechTaskEvent(
  input: { taskId: string; kind: TechEventKind; note?: string; previousValue?: string; nextValue?: string; payload?: unknown },
  actor: TechActor,
) {
  const db = await getDb();
  await ghiSuKien(db, input, actor);
}

/* ═════════════════════ VIỆC TECH ═════════════════════ */

export type CreateTechTaskInput = {
  title: string;
  description?: string;
  taskType: TechTaskType;
  module: TechModule;
  priority: TechPriority;
  source: TechTaskSource;
  sourceRef?: string;
  branch?: string;
  worktree?: string;
  parentTaskId?: string | null;
  dependsOn?: string[];
  agentId?: string | null;
  /**
   * Mức rủi ro do NGƯỜI đặt, đè lên máy. Phải kèm lý do ≥ 10 ký tự — xem
   * `lib/constants/tech-risk.ts`. Bỏ trống ⇒ dùng mức máy xếp.
   */
  riskOverride?: { risk: TechRisk; reason: string } | null;
};

export async function createTechTask(input: CreateTechTaskInput, actor: TechActor): Promise<TechResult<{ id: string; code: string; risk: TechRisk }>> {
  const title = input.title.trim();
  if (title.length < 5) return { error: "Tiêu đề quá ngắn — viết đủ để người khác đọc là hiểu phải làm gì." };

  const mayXep = classifyTechRisk({ taskType: input.taskType, module: input.module, title, description: input.description });
  const dat = input.riskOverride ?? null;
  if (dat && dat.reason.trim().length < 10) {
    return { error: "Đè mức rủi ro của máy thì phải nói vì sao (ít nhất một câu) — nếu không, không ai đọc lại được quyết định đó." };
  }

  const risk = dat?.risk ?? mayXep.risk;
  const approvalRequired = risk === "R2";
  const db = await getDb();

  for (let lan = 0; lan < 3; lan += 1) {
    const code = await nextCode(db, "TECH");
    try {
      const [row] = await db
        .insert(schema.techTasks)
        .values({
          code,
          title,
          description: input.description?.trim() ?? "",
          taskType: input.taskType,
          module: input.module,
          status: "NEW",
          priority: input.priority,
          risk,
          riskRules: dat ? [] : mayXep.rules,
          riskOverriddenBy: dat && actor.kind === "HUMAN" ? (actor.id ?? null) : null,
          riskOverrideReason: dat ? dat.reason.trim() : "",
          source: input.source,
          sourceRef: input.sourceRef?.trim() ?? "",
          branch: input.branch?.trim() ?? "",
          worktree: input.worktree?.trim() ?? "",
          parentTaskId: input.parentTaskId || null,
          dependsOn: input.dependsOn ?? [],
          agentId: input.agentId || null,
          approvalRequired,
          approvalStatus: approvalRequired ? "PENDING" : "NOT_REQUIRED",
          createdByKind: actor.kind,
          createdById: actor.kind === "HUMAN" ? (actor.id ?? null) : null,
          createdByName: actor.name,
        })
        .returning({ id: schema.techTasks.id, code: schema.techTasks.code });

      await ghiSuKien(
        db,
        {
          taskId: row.id,
          kind: "CREATE",
          note: title,
          nextValue: "NEW",
          payload: { risk, riskRules: dat ? ["OVERRIDE"] : mayXep.rules, riskReasons: dat ? [dat.reason.trim()] : mayXep.reasons, approvalRequired },
        },
        actor,
      );
      return { ok: true, id: row.id, code: row.code, risk };
    } catch (error) {
      // Đụng khoá duy nhất vì một lượt tạo song song vừa lấy mất mã — thử lại với mã kế tiếp.
      if (lan < 2 && String(error).includes("tech_tasks_code_uq")) continue;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { error: "Không cấp được mã việc sau ba lần thử — thử lại sau." };
}

/**
 * ĐỔI TRẠNG THÁI.
 *
 * Bốn lá chắn, theo đúng thứ tự:
 *  1. **Bấm lại đúng trạng thái đang có ⇒ BỎ QUA, không ghi gì.** Một cú bấm hai lần, hoặc một lần
 *     trình duyệt gửi lại, từng đẻ ra hai dòng lịch sử và đẩy mốc hoàn thành về lần bấm sau
 *     (AGENTS.md mục 61). Đây là nhánh ĐẦU TIÊN, trước cả kiểm tra hợp lệ.
 *  2. Phép chuyển phải nằm trong `TECH_TASK_TRANSITIONS`.
 *  3. `BLOCKED` phải nói bị chặn bởi cái gì.
 *  4. `DEPLOYING` phải qua cổng phê duyệt; `DONE` phải có bằng chứng.
 */
export async function setTechTaskStatus(
  input: { taskId: string; to: TechTaskStatus; note?: string },
  actor: TechActor,
): Promise<TechResult<{ status: TechTaskStatus; skipped?: true }>> {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId) });
  if (!task) return { error: "Không tìm thấy việc này." };
  const from = task.status as TechTaskStatus;
  const note = input.note?.trim() ?? "";

  if (from === input.to) return { ok: true, status: from, skipped: true };

  if (!canTransitionTechTask(from, input.to)) {
    return { error: `Không đi thẳng từ “${TECH_TASK_STATUS_LABEL[from]}” sang “${TECH_TASK_STATUS_LABEL[input.to]}” được.` };
  }
  if (input.to === "BLOCKED" && note.length < 5) {
    return { error: "Báo bị chặn thì phải nói bị chặn bởi cái gì — chặn mà không nói vì sao thì không ai gỡ được." };
  }
  /*
    CỔNG PHÊ DUYỆT CHẶN Ở CẢ HAI BƯỚC, KHÔNG CHỈ Ở LƯỢT DEPLOY.

    `READY_TO_DEPLOY` đọc ra là "đã xanh hết và (nếu cần) đã được chủ shop phê duyệt" — chính câu
    trong `TECH_TASK_STATUS_HINT`. Chặn muộn hơn một bước thì cái nhãn ấy nói dối: một việc R2 chưa
    ai ký vẫn đứng trong cột "Sẵn sàng deploy", và người nhìn bảng sẽ tin là nó sẵn sàng thật.

    Vẫn giữ nguyên lá chắn ở `DEPLOYING` chứ không dời đi: một việc đã duyệt, đã vào
    `READY_TO_DEPLOY`, rồi bị xếp lại thành R2 (đè mức rủi ro) sẽ quay về "chờ duyệt" — và lúc đó
    chỉ còn lá chắn thứ hai đứng giữa nó với production.
  */
  if (input.to === "READY_TO_DEPLOY" || input.to === "DEPLOYING") {
    if (actor.kind === "AI_AGENT") return chanAgent("tự đưa việc sang khâu deploy")!;
    const chan = techDeployBlockers({
      approvalRequired: task.approvalRequired,
      approvalStatus: task.approvalStatus as TechApprovalStatus,
      risk: task.risk as TechRisk,
    });
    if (chan.length) return { error: chan.join(" ") };
  }
  /*
    ĐÓNG MỘT VIỆC PHẢI CÓ BẰNG CHỨNG.

    Hoặc đã xác minh trên production (mốc + chứng cứ), hoặc nói rõ vì sao việc này không có gì để
    xác minh (tài liệu, dọn mã, kiểm thử). Không có đường thứ ba: một việc đóng im lặng là một việc
    không ai biết nó có thật sự chạy được hay không.
  */
  if (input.to === "DONE" && !task.productionVerifiedAt && note.length < 10) {
    return { error: "Đóng việc thì phải có xác minh trên production, hoặc một câu nói rõ vì sao việc này không có gì để xác minh." };
  }

  const now = new Date();
  await db
    .update(schema.techTasks)
    .set({
      status: input.to,
      blockedReason: input.to === "BLOCKED" ? note : "",
      // Mốc bắt đầu ghi MỘT LẦN, ở lần đầu việc rời khỏi khâu chuẩn bị. Ghi đè mỗi lần quay lại
      // `BUILDING` thì mọi phép đo thời gian làm việc đều ngắn đi một cách có hệ thống.
      startedAt: task.startedAt ?? (input.to === "BUILDING" ? now : null),
      completedAt: input.to === "DONE" ? (task.completedAt ?? now) : null,
    })
    .where(eq(schema.techTasks.id, input.taskId));

  await ghiSuKien(db, { taskId: input.taskId, kind: "STATUS", note, previousValue: from, nextValue: input.to }, actor);
  return { ok: true, status: input.to };
}

export async function setTechTaskPriority(input: { taskId: string; priority: TechPriority; note?: string }, actor: TechActor): Promise<TechResult> {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), columns: { id: true, priority: true } });
  if (!task) return { error: "Không tìm thấy việc này." };
  if (task.priority === input.priority) return { ok: true };
  await db.update(schema.techTasks).set({ priority: input.priority }).where(eq(schema.techTasks.id, input.taskId));
  await ghiSuKien(db, { taskId: input.taskId, kind: "PRIORITY", note: input.note?.trim() ?? "", previousValue: task.priority, nextValue: input.priority }, actor);
  return { ok: true };
}

/**
 * NGƯỜI ĐÈ MỨC RỦI RO CỦA MÁY.
 *
 * Chỉ NGƯỜI được đè — một agent tự hạ mức rủi ro của chính việc mình đang làm là tự cấp cho mình
 * quyền đi qua cổng phê duyệt. Lý do bắt buộc, và cổng phê duyệt được tính lại ngay: nâng lên `R2`
 * thì việc quay về "chờ duyệt" kể cả khi trước đó đã được duyệt — vì cái đã duyệt là một việc khác.
 */
export async function overrideTechTaskRisk(input: { taskId: string; risk: TechRisk; reason: string }, actor: TechActor): Promise<TechResult> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ người mới đè được mức rủi ro — đây là cổng phê duyệt, không phải một ô dữ liệu." };
  const reason = input.reason.trim();
  if (reason.length < 10) return { error: "Phải nói vì sao đổi mức rủi ro (ít nhất một câu)." };

  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId) });
  if (!task) return { error: "Không tìm thấy việc này." };
  if (task.risk === input.risk) return { ok: true };

  const canDuyet = input.risk === "R2";
  await db
    .update(schema.techTasks)
    .set({
      risk: input.risk,
      riskRules: [],
      riskOverriddenBy: actor.id ?? null,
      riskOverrideReason: reason,
      approvalRequired: canDuyet,
      approvalStatus: canDuyet ? "PENDING" : "NOT_REQUIRED",
      approvedBy: canDuyet ? null : task.approvedBy,
      approvedByName: canDuyet ? "" : task.approvedByName,
      approvedAt: canDuyet ? null : task.approvedAt,
    })
    .where(eq(schema.techTasks.id, input.taskId));

  await ghiSuKien(db, { taskId: input.taskId, kind: "RISK", note: reason, previousValue: task.risk, nextValue: input.risk, payload: { approvalRequired: canDuyet } }, actor);
  return { ok: true };
}

export async function assignTechTaskAgent(input: { taskId: string; agentId: string | null; note?: string }, actor: TechActor): Promise<TechResult> {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), with: { agent: { columns: { key: true } } } });
  if (!task) return { error: "Không tìm thấy việc này." };

  let tenAgent = "";
  if (input.agentId) {
    const agent = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.id, input.agentId), columns: { id: true, key: true, name: true, enabled: true, allowedRisks: true } });
    if (!agent) return { error: "Không tìm thấy agent này trong sổ." };
    if (!agent.enabled) return { error: `Agent “${agent.name}” đang TẮT — bật ở /tech/agents trước khi giao việc.` };
    /*
      Giao một việc R2 cho agent chưa được phép chạm R2 là mở cổng bằng cửa sau. Phase 1 chưa agent
      nào khai `R2`, nên nhánh này luôn chặn — và đó đúng là ý định.
    */
    if (!agent.allowedRisks.includes(task.risk)) {
      return { error: `Agent “${agent.name}” chưa được phép làm việc mức ${task.risk}. Sửa quyền của agent, hoặc đổi mức rủi ro (có lý do) — không lách bằng cách giao bừa.` };
    }
    tenAgent = agent.key;
  }

  if ((task.agentId ?? null) === (input.agentId ?? null)) return { ok: true };
  await db.update(schema.techTasks).set({ agentId: input.agentId || null }).where(eq(schema.techTasks.id, input.taskId));
  await ghiSuKien(db, { taskId: input.taskId, kind: "ASSIGN", note: input.note?.trim() ?? "", previousValue: task.agent?.key ?? "", nextValue: tenAgent }, actor);
  return { ok: true };
}

/**
 * CHỦ SHOP BẤM DUYỆT / TỪ CHỐI.
 *
 * Chỉ NGƯỜI. Một agent tự duyệt việc của mình là toàn bộ cổng này trở thành trang trí.
 */
export async function decideTechApproval(
  input: { taskId: string; decision: Extract<TechApprovalStatus, "APPROVED" | "REJECTED">; note?: string },
  actor: TechActor,
): Promise<TechResult> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ người mới phê duyệt được — cổng này tồn tại để một con người chịu trách nhiệm." };
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), columns: { id: true, approvalRequired: true, approvalStatus: true } });
  if (!task) return { error: "Không tìm thấy việc này." };
  if (!task.approvalRequired) return { error: "Việc này không cần phê duyệt — đừng ký một thứ không ai hỏi." };
  if (task.approvalStatus === input.decision) return { ok: true };

  await db
    .update(schema.techTasks)
    .set({
      approvalStatus: input.decision,
      approvedBy: actor.id ?? null,
      approvedByName: actor.name,
      approvedAt: new Date(),
      approvalNote: input.note?.trim() ?? "",
    })
    .where(eq(schema.techTasks.id, input.taskId));

  await ghiSuKien(db, { taskId: input.taskId, kind: "APPROVAL", note: input.note?.trim() ?? "", previousValue: task.approvalStatus, nextValue: input.decision }, actor);
  return { ok: true };
}

/** Ghi lại rằng một người đã MỞ MÀN HÌNH THẬT trên production và thấy đúng thứ mong đợi. */
export async function verifyTechTaskOnProduction(input: { taskId: string; evidence: string }, actor: TechActor): Promise<TechResult> {
  const evidence = input.evidence.trim();
  if (evidence.length < 10) return { error: "Xác minh phải kèm bằng chứng: câu truy vấn đã chạy, số trước/sau, hoặc màn hình đã mở." };
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), columns: { id: true } });
  if (!task) return { error: "Không tìm thấy việc này." };
  await db
    .update(schema.techTasks)
    .set({ productionVerifiedAt: new Date(), productionVerifiedBy: actor.kind === "HUMAN" ? (actor.id ?? null) : null, productionEvidence: evidence })
    .where(eq(schema.techTasks.id, input.taskId));
  await ghiSuKien(db, { taskId: input.taskId, kind: "VERIFY", note: evidence }, actor);
  return { ok: true };
}

export async function addTechTaskNote(input: { taskId: string; note: string }, actor: TechActor): Promise<TechResult> {
  const note = input.note.trim();
  if (!note) return { error: "Ghi chú rỗng thì không ghi." };
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), columns: { id: true } });
  if (!task) return { error: "Không tìm thấy việc này." };
  await ghiSuKien(db, { taskId: input.taskId, kind: "NOTE", note }, actor);
  return { ok: true };
}

export async function setTechTaskBranch(input: { taskId: string; branch: string; worktree?: string }, actor: TechActor): Promise<TechResult> {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), columns: { id: true, branch: true } });
  if (!task) return { error: "Không tìm thấy việc này." };
  const branch = input.branch.trim();
  if (task.branch === branch) return { ok: true };
  await db.update(schema.techTasks).set({ branch, worktree: input.worktree?.trim() ?? "" }).where(eq(schema.techTasks.id, input.taskId));
  await ghiSuKien(db, { taskId: input.taskId, kind: "BRANCH", previousValue: task.branch, nextValue: branch }, actor);
  return { ok: true };
}

/* ═════════════════════ SỔ AGENT ═════════════════════ */

/**
 * KHỞI TẠO SỔ AGENT TỪ BẢN KHAI — CHỈ KHI CÓ NGƯỜI BẤM.
 *
 * Mẫu không tự kích hoạt (AGENTS.md mục 23). Hàm này CHỈ THÊM những khoá còn thiếu và KHÔNG đụng
 * tới dòng đã có: chủ shop đã tắt một agent rồi thì bấm lại nút này không được bật nó lên.
 *
 * Mọi agent sinh ra ở trạng thái TẮT.
 */
export async function seedTechAgents(actor: TechActor): Promise<TechResult<{ created: number; skipped: number }>> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ người mới khởi tạo được sổ agent." };
  const db = await getDb();
  const daCo = new Set((await db.select({ key: schema.techAgents.key }).from(schema.techAgents)).map((r) => r.key));
  const them = TECH_AGENT_TEMPLATES.filter((t) => !daCo.has(t.key));
  if (them.length) {
    await db.insert(schema.techAgents).values(
      them.map((t) => ({
        key: t.key,
        name: t.name,
        role: t.role,
        description: t.description,
        enabled: false,
        capabilities: [...t.capabilities],
        allowedRisks: [...t.allowedRisks],
        canCode: t.canCode,
        canReview: t.canReview,
        canMerge: t.canMerge,
        canDeploy: t.canDeploy,
        canRunProdRead: t.canRunProdRead,
        canRunProdWrite: t.canRunProdWrite,
        status: "IDLE" as const,
      })),
    );
  }
  return { ok: true, created: them.length, skipped: daCo.size };
}

/**
 * Bật / tắt một định nghĩa agent.
 *
 * Phase 1 KHÔNG cho bật một agent mang cờ `can_deploy` / `can_merge` / `can_run_prod_write`: máy
 * thi hành chưa tồn tại, nên một cờ bật ở đây là một lời hứa mã nguồn không giữ được. Chặn ở đây
 * chứ không ở CSDL, vì Phase 2 sẽ nới nó bằng mã chứ không bằng một migration.
 */
/**
 * ═══════════ CẤP MỨC RỦI RO CHO MỘT VAI ═══════════
 *
 * ─── VÌ SAO HÀM NÀY PHẢI TỒN TẠI ───
 *
 * `tech_agents.allowed_risks` là một trong những cổng quyết định agent nhận được việc nào — nó
 * được HỎI ở `canDispatchTask()` và lại ở `runner.ts`, và câu từ chối của cổng giao việc nói thẳng
 * *"Cấp mức cho vai ở /tech/agents"*. Nhưng màn hình ấy chỉ IN ra cột rủi ro, chưa bao giờ có chỗ
 * sửa, và không có đường ghi nào khác. Nghĩa là sản phẩm đang chỉ người dùng tới một cái nút không
 * tồn tại (đo 22/09/2026: chủ shop bật đủ 12 vai nhưng 0/12 vai đổi được mức, vì không có cách).
 *
 * Một cổng mà người có quyền không mở được thì không phải cổng chặt — nó là cổng hỏng.
 *
 * ─── BA HÀNG RÀO GIỮ NGUYÊN ───
 *
 *  1. Chỉ NGƯỜI. Agent tự nới mức của chính nó là hết chuyện.
 *  2. Danh sách ĐÓNG: chỉ `R0` · `R1` · `R2`. Chuỗi lạ buộc mã phải chọn giữa khoá nhầm và mở
 *     nhầm, nên không có ô gõ tự do (cùng luật với mục 30).
 *  3. Cấp `R2` là quyết định RIÊNG và phải nêu LÝ DO. Đó là mức chạm tiền; một lượt nới không ai
 *     đọc lại được sau này thì sổ quyền chỉ là một bảng số.
 *
 * KHÔNG kiểm phạm vi ghi ở đây, và đó là cố ý: `allowed_risks` khai vai ĐƯỢC PHÉP làm việc mức nào,
 * còn "ghi được vào đâu" là câu hỏi của `writeGlobsForRole()` mà cổng giao việc hỏi riêng. Gộp hai
 * trục vào một chỗ là đúng thứ đã làm cổng cũ đọc sai (xem `agent-dispatch.ts`). Vai `qa` cấp R2
 * được — rồi vẫn không qua cửa hẹp vì nó ghi `tests/`, và câu từ chối ở cổng nói rõ điều đó.
 */
export async function setTechAgentRisks(
  input: { agentId: string; allowedRisks: string[]; reason?: string },
  actor: TechActor,
): Promise<TechResult<{ truoc: string[]; sau: TechRisk[] }>> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ người mới đổi được mức rủi ro của một vai." };

  const hopLe = input.allowedRisks.filter((r): r is TechRisk => TECH_RISKS.includes(r as TechRisk));
  if (hopLe.length !== input.allowedRisks.length) {
    return { error: `Mức rủi ro không hợp lệ. Chỉ nhận: ${TECH_RISKS.join(" · ")}.` };
  }
  /* Xếp theo đúng thứ tự sổ để hai lần cấp cùng tập mức không ra hai dòng dữ liệu khác nhau. */
  const sau = TECH_RISKS.filter((r) => hopLe.includes(r));

  const db = await getDb();
  const agent = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.id, input.agentId) });
  if (!agent) return { error: "Không tìm thấy agent này." };

  const truoc = agent.allowedRisks ?? [];
  const themR2 = sau.includes("R2") && !truoc.includes("R2");
  if (themR2 && (input.reason ?? "").trim().length < 10) {
    return { error: "Cấp mức R2 cho một vai thì phải nói vì sao (ít nhất một câu) — đây là mức chạm tiền, và một lượt nới không ai đọc lại được là một lượt nới không ai kiểm được." };
  }

  if (truoc.length === sau.length && truoc.every((r, i) => r === sau[i])) return { ok: true, truoc, sau };

  await db.update(schema.techAgents).set({ allowedRisks: sau }).where(eq(schema.techAgents.id, input.agentId));
  return { ok: true, truoc, sau };
}

/**
 * GHI PHÁN QUYẾT REVIEW CHO MỘT LƯỢT CHẠY — cơ sở của chuỗi "lượt chạy sạch".
 *
 * Chỉ NGƯỜI ghi được: "sạch" nghĩa là có người đã đọc và không tìm ra gì phải sửa. Một agent tự
 * chấm lượt chạy của mình là sạch thì cả phép đếm thành tự khen.
 *
 * Chỉ lượt `SUCCEEDED`: lượt hỏng đã tự cắt chuỗi, và lượt `BLOCKED` là một lời khai trung thực,
 * không phải một lần giao hàng để mà chấm.
 *
 * "Có lỗi" phải nói lỗi GÌ. Một phán quyết không kèm lý do thì lần sau không ai học được gì từ nó.
 *
 * Được sửa phán quyết — review có thể tìm ra lỗi muộn. Người ghi và mốc ghi luôn là của lần ghi
 * cuối cùng, và người ấy lấy từ PHIÊN, không nhận từ client (AGENTS.md mục 34).
 */
export async function setTechRunVerdict(
  input: { runId: string; verdict: string; note?: string },
  actor: TechActor,
): Promise<TechResult> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ người mới ghi được phán quyết review — agent không tự chấm lượt chạy của mình." };
  if (!(REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) {
    return { error: `Phán quyết không hợp lệ. Chỉ nhận: ${REVIEW_VERDICTS.join(" · ")}.` };
  }
  const verdict = input.verdict as ReviewVerdict;
  const note = (input.note ?? "").trim();
  if (verdict === "CO_LOI" && note.length < DO_DAI_TOI_THIEU_GHI_CHU_LOI) {
    return { error: "Ghi \"có lỗi\" thì phải nói lỗi gì (ít nhất một câu) — một phán quyết không kèm lý do thì lần sau không ai học được gì." };
  }

  const db = await getDb();
  const run = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, input.runId) });
  if (!run) return { error: "Không tìm thấy lượt chạy này." };
  if (run.status !== "SUCCEEDED") {
    return { error: `Chỉ chấm được lượt đã giao xong. Lượt này đang ở trạng thái ${run.status} — lượt hỏng đã tự cắt chuỗi, lượt BLOCKED là lời khai không làm được, không phải một lần giao hàng.` };
  }
  await db
    .update(schema.techAgentRuns)
    .set({ reviewVerdict: verdict, reviewNote: note, reviewedByUserId: actor.id, reviewedAt: new Date() })
    .where(eq(schema.techAgentRuns.id, input.runId));
  return { ok: true };
}

export async function setTechAgentEnabled(input: { agentId: string; enabled: boolean }, actor: TechActor): Promise<TechResult> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ người mới bật/tắt được agent." };
  const db = await getDb();
  const agent = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.id, input.agentId) });
  if (!agent) return { error: "Không tìm thấy agent này." };
  if (input.enabled && (agent.canDeploy || agent.canMerge || agent.canRunProdWrite)) {
    return { error: "Phase 1 chưa có máy thi hành: không bật được agent mang quyền merge / deploy / ghi production." };
  }
  if (agent.enabled === input.enabled) return { ok: true };
  await db.update(schema.techAgents).set({ enabled: input.enabled }).where(eq(schema.techAgents.id, input.agentId));
  return { ok: true };
}

/* ═════════════════════ LƯỢT CHẠY ═════════════════════ */

export async function startTechAgentRun(
  input: { agentId: string; taskId?: string | null; branch?: string; baseCommit?: string; metadata?: unknown },
  actor: TechActor,
): Promise<TechResult<{ id: string }>> {
  const db = await getDb();
  const agent = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.id, input.agentId), columns: { id: true, key: true, enabled: true, name: true, allowedRisks: true } });
  if (!agent) return { error: "Không tìm thấy agent này." };
  if (!agent.enabled) return { error: `Agent “${agent.name}” đang TẮT — không mở lượt chạy cho một agent chưa ai bật.` };

  /*
    KIỂM LẠI MỨC RỦI RO LÚC CHẠY, KHÔNG CHỈ LÚC GIAO.

    `assignTechTaskAgent` đã chặn giao việc R2 cho agent chưa được phép. Nhưng một việc được giao
    lúc còn R0 có thể bị NÂNG lên R2 sau đó (người đè mức rủi ro), và lúc ấy agent vẫn đang nằm ở ô
    phụ trách. Máy KHÔNG tự gỡ việc khỏi tay người/agent đang cầm (AGENTS.md mục 25) — nên chỗ phải
    chặn là lúc SẮP LÀM, không phải lúc được giao.
  */
  if (input.taskId) {
    const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), columns: { id: true, risk: true, code: true } });
    if (!task) return { error: "Không tìm thấy việc này." };
    if (!agent.allowedRisks.includes(task.risk)) {
      return { error: `Việc ${task.code} nay ở mức ${task.risk}, agent “${agent.name}” chưa được phép chạm mức đó. Giao lại cho agent khác, hoặc đổi mức rủi ro (có lý do).` };
    }
  }

  const [row] = await db
    .insert(schema.techAgentRuns)
    .values({
      agentId: agent.id,
      agentKey: agent.key,
      taskId: input.taskId || null,
      status: "RUNNING",
      branch: input.branch?.trim() ?? "",
      baseCommit: input.baseCommit?.trim() ?? "",
      metadata: (input.metadata as object) ?? null,
    })
    .returning({ id: schema.techAgentRuns.id });

  if (input.taskId) {
    await ghiSuKien(db, { taskId: input.taskId, kind: "RUN", note: `Mở lượt chạy của ${agent.key}`, nextValue: "RUNNING", payload: { runId: row.id } }, actor);
  }
  return { ok: true, id: row.id };
}

/**
 * ĐÓNG MỘT LƯỢT CHẠY.
 *
 * Bốn cổng khai riêng và mặc định `UNKNOWN`: nơi gọi phải nói CHẠY GÌ và KẾT QUẢ RA SAO. Chưa chạy
 * `npm test` mà để trống thì nó nằm ở `UNKNOWN` — KHÔNG phải `PASSED` (AGENTS.md mục 42).
 *
 * `summary` cắt ở 4.000 ký tự và chỉ nhận KẾT LUẬN: không lưu dòng suy nghĩ của model.
 */
export async function finishTechAgentRun(
  input: {
    runId: string;
    status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "BLOCKED";
    summary?: string;
    resultCommit?: string;
    testsRun?: string;
    typecheckResult?: TechGateResult;
    lintResult?: TechGateResult;
    testResult?: TechGateResult;
    buildResult?: TechGateResult;
    filesChanged?: string[];
    error?: string;
    /**
     * TIỀN CỦA LƯỢT CHẠY — `usd: null` nghĩa là CHƯA ĐO ĐƯỢC, khác hẳn 0 (mục 42).
     *
     * Ngày 22/09/2026 chủ shop hết sạch tín dụng API và không ai trả lời được tiền đi đâu. Sổ
     * `ai_interactions` chỉ ghi lượt gọi TRONG ERP; agent chạy trên máy Actions nên KHÔNG có mặt
     * ở đó. Nghĩa là đúng thứ tiêu nhiều nhất lại là thứ duy nhất không hiện ở bất kỳ đâu.
     */
    chiPhi?: { soVong: number; vao: number; ra: number; demDoc: number; demGhi: number; usd: number | null };
    /**
     * CÂU LỖI CỦA CỔNG ĐỎ — để đọc được NGAY TRONG ERP.
     *
     * Trước đây sổ chỉ ghi "Có cổng kiểm thử ĐỎ." và bốn huy hiệu cổng. Người xem biết `typecheck`
     * đỏ nhưng KHÔNG biết đỏ vì gì, nên vẫn phải mở log GitHub Actions — tức phải rời ERP, và phải
     * có quyền vào kho. Câu lỗi thật là thứ duy nhất trả lời được "sửa cái gì".
     */
    loiCong?: { ten: string; exitCode: number | null; dauRa: string }[];
    /**
     * HÌNH DẠNG LƯỢT CHẠY — đọc mấy lần, ghi mấy lần, vào tệp nào, bao nhiêu byte.
     *
     * KHÔNG phải nội dung: kho mã PUBLIC, và nội dung đã nằm ở PR. Đây là thứ duy nhất trả lời
     * "24 vòng ấy nó làm gì" khi một lượt chạy đốt tiền rồi hỏng (xem `lib/constants/agent-steps.ts`).
     */
    vetBuoc?: unknown;
  },
  actor: TechActor,
): Promise<TechResult> {
  const db = await getDb();
  const run = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, input.runId) });
  if (!run) return { error: "Không tìm thấy lượt chạy này." };
  // Đóng một lượt đã đóng KHÔNG được đẩy mốc kết thúc về lần bấm sau (AGENTS.md mục 61).
  if (run.status !== "RUNNING") return { ok: true };

  await db
    .update(schema.techAgentRuns)
    .set({
      status: input.status,
      endedAt: new Date(),
      summary: (input.summary ?? "").trim().slice(0, 4000),
      resultCommit: input.resultCommit?.trim() ?? "",
      testsRun: input.testsRun?.trim() ?? "",
      typecheckResult: input.typecheckResult ?? "UNKNOWN",
      lintResult: input.lintResult ?? "UNKNOWN",
      testResult: input.testResult ?? "UNKNOWN",
      buildResult: input.buildResult ?? "UNKNOWN",
      filesChanged: input.filesChanged ?? [],
      error: input.error?.trim().slice(0, 4000) ?? "",
      metadata: { ...((run.metadata as Record<string, unknown>) ?? {}), chiPhi: input.chiPhi ?? null, loiCong: input.loiCong?.length ? input.loiCong : null, vetBuoc: input.vetBuoc ?? null },
    })
    .where(eq(schema.techAgentRuns.id, input.runId));

  if (run.taskId) {
    await ghiSuKien(
      db,
      { taskId: run.taskId, kind: "RUN", note: (input.summary ?? "").slice(0, 500), previousValue: "RUNNING", nextValue: input.status, payload: { runId: run.id } },
      actor,
    );
  }
  return { ok: true };
}

/* ═════════════════════ DEPLOYMENT (QUAN SÁT) ═════════════════════ */

/**
 * GHI LẠI MỘT LƯỢT DEPLOY ĐÃ XẢY RA.
 *
 * Hàm này KHÔNG deploy. Nó ghi một QUAN SÁT về thứ GitHub Actions đã làm, để `/tech` đọc lại được.
 * Cùng một commit deploy hai lần là chuyện có thật (chạy lại workflow), nên KHÔNG chống trùng theo
 * commit — chống trùng ở đây sẽ giấu mất lần chạy lại, mà lần chạy lại mới là lần đáng xem.
 */
export async function recordTechDeployment(
  input: {
    commitSha: string;
    branch?: string;
    status?: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
    taskId?: string | null;
    externalRef?: string;
    notes?: string;
    startedAt?: Date;
  },
  actor: TechActor,
): Promise<TechResult<{ id: string }>> {
  if (actor.kind === "AI_AGENT") return chanAgent("ghi một lượt deploy vào sổ")!;
  const commit = input.commitSha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { error: "Mã commit không hợp lệ — cần 7–40 ký tự hex." };
  const db = await getDb();
  const [row] = await db
    .insert(schema.techDeployments)
    .values({
      commitSha: commit,
      branch: input.branch?.trim() || "main",
      status: input.status ?? "PENDING",
      startedAt: input.startedAt ?? new Date(),
      finishedAt: input.status === "SUCCEEDED" || input.status === "FAILED" ? new Date() : null,
      actorKind: actor.kind,
      actorId: actor.kind === "HUMAN" ? (actor.id ?? null) : null,
      actorName: actor.name,
      taskId: input.taskId || null,
      externalRef: input.externalRef?.trim() ?? "",
      notes: input.notes?.trim() ?? "",
    })
    .returning({ id: schema.techDeployments.id });

  if (input.taskId) {
    await ghiSuKien(db, { taskId: input.taskId, kind: "DEPLOY", note: `Commit ${commit.slice(0, 7)}`, nextValue: input.status ?? "PENDING", payload: { deploymentId: row.id } }, actor);
  }
  return { ok: true, id: row.id };
}

export async function updateTechDeployment(
  input: {
    deploymentId: string;
    status?: "RUNNING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK";
    healthResult?: TechGateResult;
    smokeResult?: TechGateResult;
    observationResult?: TechGateResult;
    rollbackOfId?: string | null;
    notes?: string;
  },
  actor: TechActor,
): Promise<TechResult> {
  if (actor.kind === "AI_AGENT") return chanAgent("sửa một lượt deploy trong sổ")!;
  const db = await getDb();
  const dep = await db.query.techDeployments.findFirst({ where: eq(schema.techDeployments.id, input.deploymentId) });
  if (!dep) return { error: "Không tìm thấy lượt deploy này." };
  if (input.status === "ROLLED_BACK" && !(input.rollbackOfId ?? dep.rollbackOfId)) {
    return { error: "Một lượt quay lui phải trỏ tới lượt nó quay lui — nếu không thì nó chỉ là một lượt deploy nữa." };
  }
  const ketThuc = input.status && input.status !== "RUNNING";
  await db
    .update(schema.techDeployments)
    .set({
      status: input.status ?? dep.status,
      finishedAt: ketThuc ? (dep.finishedAt ?? new Date()) : dep.finishedAt,
      healthResult: input.healthResult ?? dep.healthResult,
      smokeResult: input.smokeResult ?? dep.smokeResult,
      observationResult: input.observationResult ?? dep.observationResult,
      rollbackOfId: input.rollbackOfId ?? dep.rollbackOfId,
      notes: input.notes?.trim() ?? dep.notes,
    })
    .where(eq(schema.techDeployments.id, input.deploymentId));

  if (dep.taskId && input.status && input.status !== dep.status) {
    await ghiSuKien(db, { taskId: dep.taskId, kind: "DEPLOY", previousValue: dep.status, nextValue: input.status, payload: { deploymentId: dep.id } }, actor);
  }
  return { ok: true };
}

/* ═════════════════════ SỰ CỐ ═════════════════════ */

export async function createTechIncident(
  input: {
    title: string;
    severity: TechIncidentSeverity;
    module: TechModule;
    source?: string;
    evidence?: string;
    detectedAt?: Date;
    taskId?: string | null;
    deploymentId?: string | null;
  },
  actor: TechActor,
): Promise<TechResult<{ id: string; code: string }>> {
  const title = input.title.trim();
  if (title.length < 5) return { error: "Tiêu đề sự cố quá ngắn." };
  const db = await getDb();
  for (let lan = 0; lan < 3; lan += 1) {
    const code = await nextCode(db, "INC");
    try {
      const [row] = await db
        .insert(schema.techIncidents)
        .values({
          code,
          title,
          severity: input.severity,
          module: input.module,
          source: input.source?.trim() || "MONITOR",
          evidence: input.evidence?.trim() ?? "",
          // Mốc PHÁT HIỆN do nơi gọi khai; mặc định là bây giờ vì đó là lúc người mở sự cố nhìn thấy nó.
          detectedAt: input.detectedAt ?? new Date(),
          status: "OPEN",
          taskId: input.taskId || null,
          deploymentId: input.deploymentId || null,
          openedByKind: actor.kind,
          openedById: actor.kind === "HUMAN" ? (actor.id ?? null) : null,
          openedByName: actor.name,
        })
        .returning({ id: schema.techIncidents.id, code: schema.techIncidents.code });
      if (input.taskId) await ghiSuKien(db, { taskId: input.taskId, kind: "INCIDENT", note: `${code} · ${title}`, nextValue: "OPEN", payload: { incidentId: row.id } }, actor);
      return { ok: true, id: row.id, code: row.code };
    } catch (error) {
      if (lan < 2 && String(error).includes("tech_incidents_code_uq")) continue;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { error: "Không cấp được mã sự cố sau ba lần thử." };
}

/**
 * ĐỔI TRẠNG THÁI SỰ CỐ.
 *
 * Đóng thì bắt buộc kể được ĐÃ LÀM GÌ (`resolution`). KHÔNG bắt buộc `rootCause`: chưa chứng minh
 * được nguyên nhân là chuyện bình thường, và ép điền nó chỉ đẻ ra những câu nghe hợp lý mà không
 * ai kiểm được (AGENTS.md mục 45).
 */
export async function setTechIncidentStatus(
  input: { incidentId: string; to: TechIncidentStatus; resolution?: string; mitigation?: string; rootCause?: string },
  actor: TechActor,
): Promise<TechResult<{ skipped?: true }>> {
  const db = await getDb();
  const inc = await db.query.techIncidents.findFirst({ where: eq(schema.techIncidents.id, input.incidentId) });
  if (!inc) return { error: "Không tìm thấy sự cố này." };
  const from = inc.status as TechIncidentStatus;
  if (from === input.to) return { ok: true, skipped: true };
  if (!canTransitionTechIncident(from, input.to)) return { error: `Sự cố không đi thẳng từ ${from} sang ${input.to} được.` };

  const resolution = (input.resolution ?? inc.resolution).trim();
  if (input.to === "RESOLVED") {
    const chan = techIncidentCloseBlockers({ resolution });
    if (chan.length) return { error: chan.join(" ") };
  }

  await db
    .update(schema.techIncidents)
    .set({
      status: input.to,
      resolution,
      mitigation: (input.mitigation ?? inc.mitigation).trim(),
      rootCause: (input.rootCause ?? inc.rootCause).trim(),
      resolvedAt: input.to === "RESOLVED" ? (inc.resolvedAt ?? new Date()) : null,
    })
    .where(eq(schema.techIncidents.id, input.incidentId));

  if (inc.taskId) await ghiSuKien(db, { taskId: inc.taskId, kind: "INCIDENT", previousValue: from, nextValue: input.to, payload: { incidentId: inc.id } }, actor);
  return { ok: true };
}

/** Nối một sự cố vào việc Tech đang xử lý nó. Nối chứ không chép: việc vẫn giữ trạng thái của việc. */
export async function linkTechIncidentToTask(input: { incidentId: string; taskId: string | null }, actor: TechActor): Promise<TechResult> {
  const db = await getDb();
  const inc = await db.query.techIncidents.findFirst({ where: eq(schema.techIncidents.id, input.incidentId), columns: { id: true, code: true, title: true, taskId: true } });
  if (!inc) return { error: "Không tìm thấy sự cố này." };
  if (input.taskId) {
    const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, input.taskId), columns: { id: true } });
    if (!task) return { error: "Không tìm thấy việc Tech này." };
  }
  if ((inc.taskId ?? null) === (input.taskId ?? null)) return { ok: true };
  await db.update(schema.techIncidents).set({ taskId: input.taskId || null }).where(eq(schema.techIncidents.id, input.incidentId));
  if (input.taskId) await ghiSuKien(db, { taskId: input.taskId, kind: "INCIDENT", note: `Nối sự cố ${inc.code} · ${inc.title}`, payload: { incidentId: inc.id } }, actor);
  return { ok: true };
}

/** Lượt chạy gần nhất của một agent — dùng cho màn hình và cho kiểm thử, không nhân bản truy vấn. */
export async function lastRunOfAgent(agentId: string) {
  const db = await getDb();
  const row = await db.query.techAgentRuns.findFirst({
    where: and(eq(schema.techAgentRuns.agentId, agentId)),
    orderBy: [desc(schema.techAgentRuns.startedAt)],
  });
  return row ?? null;
}

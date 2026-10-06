import { eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TechPriority, TechTaskStatus } from "@/lib/constants/tech";
import {
  canTransitionTechGoal,
  canTransitionTechMission,
  missionDoneBlockers,
  TECH_EVENT_NAMES,
  TECH_GOAL_STATUS_LABEL,
  TECH_MISSION_STATUS_LABEL,
  TECH_SEED_PROJECTS,
  type TechEventName,
  type TechEventSubject,
  type TechGoalStatus,
  type TechMissionStatus,
} from "@/lib/constants/tech-control-plane";
import { recordTechTaskEvent, type TechActor, type TechResult } from "@/lib/tech/service";

/**
 * ═══════════ GOAL · MISSION — MỘT ĐƯỜNG GHI DUY NHẤT ═══════════
 *
 * Kiến trúc: docs/tech-control-plane/README.md mục 3. Cùng hình dạng với `lib/tech/service.ts`: Server
 * Action chỉ là vỏ mỏng (quyền → gọi vào đây → `audit()` → `revalidatePath`), worker / job nền gọi CÙNG
 * hàm với `actor.kind` của mình — không có đường ghi thứ hai.
 *
 * ─── AI KHÔNG TỰ CẤP PHÉP THI HÀNH CHO CHÍNH MÌNH ───
 *
 * Planner (AI) được TẠO mục tiêu nháp và sứ mệnh `PLANNING`. Đổi trạng thái mục tiêu là quyết định của
 * chủ shop (chỉ NGƯỜI). Bật một sứ mệnh sang `ACTIVE` — tức là cho worker nhận việc của nó — chỉ NGƯỜI
 * hoặc luật tất định của hệ thống (`SYSTEM`); không bao giờ agent: một agent tự bật sứ mệnh của mình là
 * tự cấp quyền tiêu tiền và đẩy mã.
 */

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Tx;

/* ═════════════════════ LUỒNG SỰ KIỆN ═════════════════════ */

export type TechEventInput = {
  name: TechEventName;
  subjectType: TechEventSubject;
  subjectId: string;
  taskId?: string | null;
  missionId?: string | null;
  goalId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
};

/**
 * Ghi MỘT sự kiện vào `tech_events` — chỗ DUY NHẤT INSERT bảng này (append-only, không UPDATE / DELETE ở
 * đâu cả). Tên chưa khai ⇒ NÉM LỖI: đó là lỗi lập trình, và một tên gõ sai sẽ lặng lẽ thành sự kiện không
 * ai nghe. Trùng `dedupeKey` ⇒ bỏ qua, trả `null`.
 */
export async function recordTechEvent(db: DbLike, input: TechEventInput, actor: TechActor): Promise<string | null> {
  if (!(TECH_EVENT_NAMES as readonly string[]).includes(input.name)) {
    throw new Error(`Sự kiện "${String(input.name)}" chưa khai trong TECH_EVENT_NAMES`);
  }
  const [row] = await db
    .insert(schema.techEvents)
    .values({
      name: input.name,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      taskId: input.taskId ?? null,
      missionId: input.missionId ?? null,
      goalId: input.goalId ?? null,
      payload: input.payload ?? {},
      actorKind: actor.kind,
      actorId: actor.kind === "HUMAN" ? (actor.id ?? null) : null,
      actorAgentId: actor.kind === "AI_AGENT" ? (actor.agentId ?? null) : null,
      actorName: actor.name,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: schema.techEvents.dedupeKey })
    .returning({ id: schema.techEvents.id });
  return row?.id ?? null;
}

/* ═════════════════════ MÃ ĐỌC ĐƯỢC ═════════════════════ */

/** Tính từ số lớn nhất đang có, không từ `count(*)` — cùng lý do `nextCode` của việc Tech. */
async function nextCode(db: DbLike, prefix: "GOAL" | "MIS") {
  const bang = prefix === "GOAL" ? schema.techGoals : schema.techMissions;
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(nullif(regexp_replace(${bang.code}, '^[A-Z]+-', ''), '')::int), 0)` })
    .from(bang);
  return `${prefix}-${Number(row?.max ?? 0) + 1}`;
}

/** Hai lượt tạo cùng lúc lấy cùng mã ⇒ lượt thua đụng khoá duy nhất và thử lại với mã kế tiếp. */
async function withCodeRetry<T>(uniqueName: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  for (let lan = 0; lan < 3; lan += 1) {
    try {
      return await fn();
    } catch (error) {
      if (lan < 2 && String(error).includes(uniqueName)) continue;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { error: "Không cấp được mã sau ba lần thử — thử lại sau." };
}

async function resolveProjectId(db: DbLike, projectKeyOrId: string | null | undefined): Promise<string | null | { error: string }> {
  const v = projectKeyOrId?.trim();
  if (!v) return null;
  const row = await db.query.techProjects.findFirst({
    where: sql`${schema.techProjects.id} = ${v} OR ${schema.techProjects.key} = ${v}`,
    columns: { id: true, active: true },
  });
  if (!row) return { error: "Không tìm thấy dự án này." };
  if (!row.active) return { error: "Dự án đã ngừng — bật lại dự án trước khi thêm mục tiêu / sứ mệnh." };
  return row.id;
}

/* ═════════════════════ SỨ MỆNH / MỤC TIÊU CỦA MỘT VIỆC ═════════════════════ */

/**
 * Trạng thái sứ mệnh + mục tiêu chứa việc — đầu vào `plan` của `canDispatchTask`. MỘT chỗ đọc cho mọi cửa giao
 * việc (nút giao, cửa đọc của runner). `null` = việc lẻ.
 */
export async function loadTaskPlan(missionId: string | null | undefined): Promise<{ missionCode: string; missionStatus: string; goalCode: string | null; goalStatus: string | null } | null> {
  if (!missionId) return null;
  const db = await getDb();
  const m = await db.query.techMissions.findFirst({
    where: eq(schema.techMissions.id, missionId),
    columns: { code: true, status: true },
    with: { goal: { columns: { code: true, status: true } } },
  });
  // Sứ mệnh mất dấu (đã xoá) ⇒ rơi về phía HẸP: coi như không chạy.
  if (!m) return { missionCode: "(mất dấu)", missionStatus: "MISSING", goalCode: null, goalStatus: null };
  return { missionCode: m.code, missionStatus: m.status, goalCode: m.goal?.code ?? null, goalStatus: m.goal?.status ?? null };
}

/* ═════════════════════ DỰ ÁN ═════════════════════ */

/**
 * Gieo bốn dự án mặc định (`TECH_SEED_PROJECTS`) — chỉ NGƯỜI bấm, cùng tiền lệ "Khởi tạo sổ agent": migration
 * chạy trên CSDL của MỌI tổ chức, còn danh sách dự án kỹ thuật là của tổ chức nhà. Bấm lại không nhân đôi, không
 * đè dòng người đã sửa.
 */
export async function seedTechProjects(actor: TechActor): Promise<TechResult<{ created: number }>> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ NGƯỜI khởi tạo được danh sách dự án." };
  const db = await getDb();
  const rows = await db
    .insert(schema.techProjects)
    .values(TECH_SEED_PROJECTS.map((p) => ({ key: p.key, name: p.name, description: p.description })))
    .onConflictDoNothing({ target: schema.techProjects.key })
    .returning({ id: schema.techProjects.id });
  return { ok: true, created: rows.length };
}

/* ═════════════════════ GOAL ═════════════════════ */

export type CreateTechGoalInput = {
  title: string;
  description?: string;
  successCriteria?: string;
  priority: TechPriority;
  /** `tech_projects.id` hoặc khoá (`erp`, `chotdon`…). */
  project?: string | null;
  /** `true` ⇒ bắt đầu ở `ACTIVE` (chỉ NGƯỜI). Mặc định `DRAFT`. */
  activate?: boolean;
};

export async function createTechGoal(input: CreateTechGoalInput, actor: TechActor): Promise<TechResult<{ id: string; code: string }>> {
  const title = input.title.trim();
  if (title.length < 5) return { error: "Mục tiêu quá ngắn — viết đủ để người khác đọc là hiểu muốn đạt điều gì." };
  if (input.activate && actor.kind !== "HUMAN") return { error: "Chỉ NGƯỜI bật được một mục tiêu — máy / agent chỉ tạo bản nháp." };
  const db = await getDb();
  const projectId = await resolveProjectId(db, input.project);
  if (projectId && typeof projectId === "object") return projectId;
  const now = new Date();

  const out = await withCodeRetry("tech_goals_code_uq", () =>
    db.transaction(async (tx) => {
      const code = await nextCode(tx, "GOAL");
      const status: TechGoalStatus = input.activate ? "ACTIVE" : "DRAFT";
      const [row] = await tx
        .insert(schema.techGoals)
        .values({
          code,
          projectId: projectId as string | null,
          title,
          description: input.description?.trim() ?? "",
          successCriteria: input.successCriteria?.trim() ?? "",
          status,
          priority: input.priority,
          createdByKind: actor.kind,
          createdById: actor.kind === "HUMAN" ? (actor.id ?? null) : null,
          createdByName: actor.name,
          activatedAt: status === "ACTIVE" ? now : null,
        })
        .returning({ id: schema.techGoals.id, code: schema.techGoals.code });
      await recordTechEvent(tx, { name: "goal.created", subjectType: "GOAL", subjectId: row.id, goalId: row.id, payload: { code, title, status } }, actor);
      return row;
    }),
  );
  if ("error" in out) return out;
  return { ok: true, id: out.id, code: out.code };
}

/**
 * ĐỔI TRẠNG THÁI MỤC TIÊU — chỉ NGƯỜI.
 *
 *  · `ACHIEVED` đòi mọi sứ mệnh đã kết thúc: "đạt rồi" trong khi worker còn chạy việc của nó là hai câu
 *    trả lời cho cùng một câu hỏi.
 *  · `ABANDONED` HUỶ LUÔN mọi sứ mệnh chưa kết thúc trong CÙNG giao dịch — bỏ mục tiêu mà sứ mệnh vẫn
 *    `ACTIVE` thì worker vẫn nhận việc và vẫn tiêu tiền cho một thứ chủ shop đã bỏ.
 *  · Hai trạng thái cuối đòi một câu kết quả (CHECK ở CSDL).
 */
export async function setTechGoalStatus(
  input: { goalId: string; to: TechGoalStatus; note?: string },
  actor: TechActor,
): Promise<TechResult<{ status: TechGoalStatus; skipped?: true; cancelledMissions?: number }>> {
  if (actor.kind !== "HUMAN") return { error: "Đổi trạng thái mục tiêu là quyết định của chủ shop — chỉ NGƯỜI làm được." };
  const db = await getDb();
  const goal = await db.query.techGoals.findFirst({ where: eq(schema.techGoals.id, input.goalId) });
  if (!goal) return { error: "Không tìm thấy mục tiêu này." };
  const from = goal.status as TechGoalStatus;
  const note = input.note?.trim() ?? "";
  if (from === input.to) return { ok: true, status: from, skipped: true };
  if (!canTransitionTechGoal(from, input.to)) {
    return { error: `Không đi thẳng từ “${TECH_GOAL_STATUS_LABEL[from]}” sang “${TECH_GOAL_STATUS_LABEL[input.to]}” được.` };
  }
  const closing = input.to === "ACHIEVED" || input.to === "ABANDONED";
  if (closing && [...note].length < 10) return { error: "Đóng mục tiêu thì ghi lại kết quả / lý do (ít nhất một câu) — lần sau còn đọc được đã học được gì." };

  const missions = await db.query.techMissions.findMany({
    where: eq(schema.techMissions.goalId, goal.id),
    columns: { id: true, code: true, status: true },
  });
  const open = missions.filter((m) => m.status !== "DONE" && m.status !== "CANCELLED");
  if (input.to === "ACHIEVED" && open.length > 0) {
    return { error: `Còn ${open.length} sứ mệnh chưa kết thúc (${open.map((m) => m.code).join(", ")}) — chốt hoặc huỷ chúng trước khi nói mục tiêu đã đạt.` };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(schema.techGoals)
      .set({
        status: input.to,
        outcomeNote: closing ? note : goal.outcomeNote,
        activatedAt: goal.activatedAt ?? (input.to === "ACTIVE" ? now : null),
        closedAt: closing ? now : null,
      })
      .where(eq(schema.techGoals.id, goal.id));
    await recordTechEvent(tx, { name: "goal.status_changed", subjectType: "GOAL", subjectId: goal.id, goalId: goal.id, payload: { from, to: input.to, note } }, actor);

    if (input.to === "ABANDONED" && open.length > 0) {
      const ly = `Mục tiêu ${goal.code} bị bỏ: ${note}`;
      await tx
        .update(schema.techMissions)
        .set({ status: "CANCELLED", outcomeNote: ly, closedAt: now })
        .where(inArray(schema.techMissions.id, open.map((m) => m.id)));
      for (const m of open) {
        await recordTechEvent(
          tx,
          { name: "mission.status_changed", subjectType: "MISSION", subjectId: m.id, missionId: m.id, goalId: goal.id, payload: { from: m.status, to: "CANCELLED", note: ly, cascadeFromGoal: goal.id } },
          actor,
        );
      }
    }
  });
  return { ok: true, status: input.to, cancelledMissions: input.to === "ABANDONED" ? open.length : 0 };
}

/* ═════════════════════ MISSION ═════════════════════ */

export type CreateTechMissionInput = {
  title: string;
  objective?: string;
  definitionOfDone?: string;
  priority: TechPriority;
  goalId?: string | null;
  /** Bỏ trống mà có mục tiêu ⇒ lấy dự án của mục tiêu. */
  project?: string | null;
  /** Mã sứ mệnh trên sổ AI Tech Room, nếu đã có. */
  registryId?: string | null;
};

export async function createTechMission(input: CreateTechMissionInput, actor: TechActor): Promise<TechResult<{ id: string; code: string }>> {
  const title = input.title.trim();
  if (title.length < 5) return { error: "Tên sứ mệnh quá ngắn — viết đủ để người khác đọc là hiểu phải giao cái gì." };
  const db = await getDb();

  let goalId: string | null = null;
  let goalProjectId: string | null = null;
  if (input.goalId) {
    const goal = await db.query.techGoals.findFirst({ where: eq(schema.techGoals.id, input.goalId), columns: { id: true, status: true, projectId: true } });
    if (!goal) return { error: "Không tìm thấy mục tiêu này." };
    if (goal.status === "ACHIEVED" || goal.status === "ABANDONED") return { error: "Mục tiêu đã đóng — không thêm sứ mệnh vào mục tiêu đã đóng." };
    goalId = goal.id;
    goalProjectId = goal.projectId;
  }
  const projectId = await resolveProjectId(db, input.project);
  if (projectId && typeof projectId === "object") return projectId;
  const registryId = input.registryId?.trim() ?? "";

  const out = await withCodeRetry("tech_missions_code_uq", () =>
    db.transaction(async (tx) => {
      const code = await nextCode(tx, "MIS");
      const [row] = await tx
        .insert(schema.techMissions)
        .values({
          code,
          goalId,
          projectId: (projectId as string | null) ?? goalProjectId,
          title,
          objective: input.objective?.trim() ?? "",
          definitionOfDone: input.definitionOfDone?.trim() ?? "",
          status: "PLANNING",
          priority: input.priority,
          registryId,
          createdByKind: actor.kind,
          createdById: actor.kind === "HUMAN" ? (actor.id ?? null) : null,
          createdByName: actor.name,
        })
        .returning({ id: schema.techMissions.id, code: schema.techMissions.code });
      await recordTechEvent(tx, { name: "mission.created", subjectType: "MISSION", subjectId: row.id, missionId: row.id, goalId, payload: { code, title } }, actor);
      return row;
    }),
  );
  if ("error" in out) return out;
  return { ok: true, id: out.id, code: out.code };
}

/**
 * ĐỔI TRẠNG THÁI SỨ MỆNH.
 *
 *  · AI_AGENT: không bao giờ (xem đầu tệp).
 *  · SYSTEM: chỉ `PAUSED` (watchdog / ngân sách đạp phanh) và `DONE` (luật tất định thấy mọi việc đã xong).
 *  · `ACTIVE` đòi mục tiêu (nếu có) đang `ACTIVE`: sứ mệnh chạy dưới một mục tiêu nháp / đang dừng là
 *    worker làm việc cho một thứ chủ shop chưa bật.
 *  · `DONE` đòi `missionDoneBlockers` rỗng. `DONE` / `CANCELLED` đòi một câu kết quả.
 */
export async function setTechMissionStatus(
  input: { missionId: string; to: TechMissionStatus; note?: string },
  actor: TechActor,
): Promise<TechResult<{ status: TechMissionStatus; skipped?: true }>> {
  if (actor.kind === "AI_AGENT") return { error: "Agent không đổi được trạng thái sứ mệnh — bật / dừng / chốt là quyết định của người hoặc luật hệ thống." };
  if (actor.kind === "SYSTEM" && input.to !== "PAUSED" && input.to !== "DONE") {
    return { error: "Hệ thống chỉ được tạm dừng hoặc chốt xong một sứ mệnh — bật / huỷ là quyết định của người." };
  }
  const db = await getDb();
  const mission = await db.query.techMissions.findFirst({ where: eq(schema.techMissions.id, input.missionId) });
  if (!mission) return { error: "Không tìm thấy sứ mệnh này." };
  const from = mission.status as TechMissionStatus;
  const note = input.note?.trim() ?? "";
  if (from === input.to) return { ok: true, status: from, skipped: true };
  if (!canTransitionTechMission(from, input.to)) {
    return { error: `Không đi thẳng từ “${TECH_MISSION_STATUS_LABEL[from]}” sang “${TECH_MISSION_STATUS_LABEL[input.to]}” được.` };
  }
  const closing = input.to === "DONE" || input.to === "CANCELLED";
  if (closing && [...note].length < 10) return { error: "Đóng sứ mệnh thì ghi lại kết quả / lý do (ít nhất một câu)." };

  if (input.to === "ACTIVE" && mission.goalId) {
    const goal = await db.query.techGoals.findFirst({ where: eq(schema.techGoals.id, mission.goalId), columns: { code: true, status: true } });
    if (goal && goal.status !== "ACTIVE") {
      return { error: `Mục tiêu ${goal.code} đang “${TECH_GOAL_STATUS_LABEL[goal.status as TechGoalStatus]}” — bật mục tiêu trước rồi mới cho sứ mệnh chạy.` };
    }
  }
  if (input.to === "DONE") {
    const tasks = await db.query.techTasks.findMany({ where: eq(schema.techTasks.missionId, mission.id), columns: { status: true } });
    const chan = missionDoneBlockers(tasks.map((t) => t.status as TechTaskStatus));
    if (chan.length) return { error: chan.join(" ") };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(schema.techMissions)
      .set({
        status: input.to,
        outcomeNote: closing ? note : mission.outcomeNote,
        activatedAt: mission.activatedAt ?? (input.to === "ACTIVE" ? now : null),
        closedAt: closing ? now : null,
      })
      .where(eq(schema.techMissions.id, mission.id));
    await recordTechEvent(
      tx,
      { name: "mission.status_changed", subjectType: "MISSION", subjectId: mission.id, missionId: mission.id, goalId: mission.goalId, payload: { from, to: input.to, note } },
      actor,
    );
  });
  return { ok: true, status: input.to };
}

/**
 * GẮN (hoặc gỡ, `missionId = null`) một việc vào sứ mệnh. Ghi ở CẢ HAI nhật ký vì cả hai dòng thời gian
 * đều cần nó: việc biết nó thuộc sứ mệnh nào, sứ mệnh biết việc nào vừa vào. Việc đã kết thúc không đổi
 * sứ mệnh được — đổi là viết lại lịch sử của một sứ mệnh đã chốt.
 */
export async function attachTechTaskToMission(
  input: { taskId: string; missionId: string | null },
  actor: TechActor,
): Promise<TechResult<{ skipped?: true; previousMissionId?: string | null }>> {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({
    where: eq(schema.techTasks.id, input.taskId),
    columns: { id: true, code: true, status: true, missionId: true, projectId: true },
  });
  if (!task) return { error: "Không tìm thấy việc này." };
  if ((task.missionId ?? null) === (input.missionId ?? null)) return { ok: true, skipped: true };
  if (task.status === "DONE" || task.status === "CANCELLED") return { error: "Việc đã kết thúc — không đổi sứ mệnh của nó nữa." };

  const cols = { id: true, code: true, status: true, goalId: true, projectId: true } as const;
  let mission: { id: string; code: string; status: string; goalId: string | null; projectId: string | null } | undefined;
  if (input.missionId) {
    mission = await db.query.techMissions.findFirst({ where: eq(schema.techMissions.id, input.missionId), columns: cols });
    if (!mission) return { error: "Không tìm thấy sứ mệnh này." };
    if (mission.status === "DONE" || mission.status === "CANCELLED") return { error: "Sứ mệnh đã kết thúc — không thêm việc vào." };
  }
  const cu = task.missionId ? await db.query.techMissions.findFirst({ where: eq(schema.techMissions.id, task.missionId), columns: cols }) : undefined;

  await db.transaction(async (tx) => {
    // Dự án đi theo sứ mệnh mới (chuyển sang sứ mệnh của dự án khác thì việc đổi dự án theo); gỡ ra thì giữ dự án cũ.
    await tx
      .update(schema.techTasks)
      .set({ missionId: mission?.id ?? null, projectId: mission?.projectId ?? task.projectId ?? null })
      .where(eq(schema.techTasks.id, task.id));
    if (mission) {
      await recordTechEvent(
        tx,
        { name: "mission.task_attached", subjectType: "MISSION", subjectId: mission.id, missionId: mission.id, goalId: mission.goalId, taskId: task.id, payload: { taskCode: task.code, previousMission: cu?.code ?? null } },
        actor,
      );
    }
    // Sứ mệnh CŨ cũng phải thấy việc rời đi — không thì dòng thời gian của nó có việc vào mà không có việc ra.
    if (cu) {
      await recordTechEvent(
        tx,
        { name: "mission.task_detached", subjectType: "MISSION", subjectId: cu.id, missionId: cu.id, goalId: cu.goalId, taskId: task.id, payload: { taskCode: task.code, nextMission: mission?.code ?? null } },
        actor,
      );
    }
  });
  await recordTechTaskEvent(
    { taskId: task.id, kind: "MISSION", previousValue: cu?.code ?? "", nextValue: mission?.code ?? "", note: mission ? `Vào sứ mệnh ${mission.code}` : `Gỡ khỏi sứ mệnh ${cu?.code ?? ""}`.trim() },
    actor,
  );
  return { ok: true, previousMissionId: task.missionId };
}

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TechTaskStatus } from "@/lib/constants/tech";
import {
  canonicalTaskState,
  countOpenDependencies,
  deriveMissionExecution,
  type CanonicalTaskState,
  type MissionExecution,
} from "@/lib/constants/tech-control-plane";
import { workerLiveness } from "@/lib/constants/tech-worker";

/**
 * ───────────── TRUY VẤN MẶT PHẲNG ĐIỀU KHIỂN — GOAL · MISSION ─────────────
 *
 * CHỈ CHẠY TRÊN MÁY CHỦ. Không đệm (`memo`) — cùng lý do `lib/queries/tech.ts`: người mở trang này để
 * hành động ngay sau khi bấm. Bảng nhỏ (chục mục tiêu, trăm sứ mệnh).
 *
 * Trạng thái thi hành / tiến độ KHÔNG đọc từ cột nào: luôn suy ra ở đây từ các việc bên dưới bằng hàm
 * thuần `deriveMissionExecution` — một nơi tính, mọi màn hình đọc cùng một câu trả lời.
 */

type TaskLite = { id: string; status: string; dependsOn: string[]; missionId: string | null };

/** Vòng đời chuẩn cho một tập việc — đọc trạng thái của mọi việc được phụ thuộc trong MỘT lượt. */
async function canonicalStates(tasks: TaskLite[]): Promise<Map<string, CanonicalTaskState>> {
  const db = await getDb();
  const depIds = [...new Set(tasks.flatMap((t) => t.dependsOn ?? []))];
  const statusById = new Map<string, TechTaskStatus>(tasks.map((t) => [t.id, t.status as TechTaskStatus]));
  const missing = depIds.filter((id) => !statusById.has(id));
  if (missing.length) {
    const rows = await db.select({ id: schema.techTasks.id, status: schema.techTasks.status }).from(schema.techTasks).where(inArray(schema.techTasks.id, missing));
    for (const r of rows) statusById.set(r.id, r.status as TechTaskStatus);
  }
  return new Map(
    tasks.map((t) => [
      t.id,
      canonicalTaskState({ status: t.status as TechTaskStatus, openDependencies: countOpenDependencies(t.dependsOn ?? [], statusById) }),
    ]),
  );
}

function executionByMission(tasks: TaskLite[], states: Map<string, CanonicalTaskState>): Map<string, MissionExecution> {
  const grouped = new Map<string, CanonicalTaskState[]>();
  for (const t of tasks) {
    if (!t.missionId) continue;
    const arr = grouped.get(t.missionId) ?? [];
    arr.push(states.get(t.id)!);
    grouped.set(t.missionId, arr);
  }
  return new Map([...grouped].map(([id, arr]) => [id, deriveMissionExecution(arr)]));
}

const EMPTY_EXECUTION = deriveMissionExecution([]);

export async function listTechProjects() {
  const db = await getDb();
  return db.query.techProjects.findMany({ orderBy: [asc(schema.techProjects.createdAt), asc(schema.techProjects.key)] });
}

/** Sứ mệnh kèm trạng thái thi hành suy ra. `goalId` lọc theo mục tiêu; `undefined` = mọi sứ mệnh. */
export async function listTechMissions(opts: { goalId?: string; includeClosed?: boolean } = {}) {
  const db = await getDb();
  const m = schema.techMissions;
  const missions = await db.query.techMissions.findMany({
    where: and(opts.goalId ? eq(m.goalId, opts.goalId) : undefined, opts.includeClosed ? undefined : sql`${m.status} NOT IN ('DONE','CANCELLED')`),
    orderBy: [sql`case ${m.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`, desc(m.createdAt)],
    with: { goal: { columns: { id: true, code: true, title: true, status: true } }, project: { columns: { key: true, name: true } } },
    limit: 300,
  });
  if (!missions.length) return [];
  const tasks = await db
    .select({ id: schema.techTasks.id, status: schema.techTasks.status, dependsOn: schema.techTasks.dependsOn, missionId: schema.techTasks.missionId })
    .from(schema.techTasks)
    .where(inArray(schema.techTasks.missionId, missions.map((x) => x.id)));
  const states = await canonicalStates(tasks);
  const exec = executionByMission(tasks, states);
  return missions.map((x) => ({ ...x, execution: exec.get(x.id) ?? EMPTY_EXECUTION }));
}

export type TechMissionListItem = Awaited<ReturnType<typeof listTechMissions>>[number];

/** Mục tiêu kèm số sứ mệnh và tiến độ gộp (đếm việc của mọi sứ mệnh bên dưới). */
export async function listTechGoals(opts: { includeClosed?: boolean } = {}) {
  const db = await getDb();
  const g = schema.techGoals;
  const goals = await db.query.techGoals.findMany({
    where: opts.includeClosed ? undefined : sql`${g.status} NOT IN ('ACHIEVED','ABANDONED')`,
    orderBy: [sql`case ${g.status} when 'ACTIVE' then 0 when 'DRAFT' then 1 when 'PAUSED' then 2 else 3 end`, sql`case ${g.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`, desc(g.createdAt)],
    with: { project: { columns: { key: true, name: true } } },
    limit: 200,
  });
  if (!goals.length) return [];
  const missions = await db
    .select({ id: schema.techMissions.id, goalId: schema.techMissions.goalId, status: schema.techMissions.status })
    .from(schema.techMissions)
    .where(inArray(schema.techMissions.goalId, goals.map((x) => x.id)));
  const tasks = missions.length
    ? await db
        .select({ id: schema.techTasks.id, status: schema.techTasks.status, dependsOn: schema.techTasks.dependsOn, missionId: schema.techTasks.missionId })
        .from(schema.techTasks)
        .where(inArray(schema.techTasks.missionId, missions.map((x) => x.id)))
    : [];
  const states = await canonicalStates(tasks);
  const goalOfMission = new Map(missions.map((m) => [m.id, m.goalId]));
  const byGoal = new Map<string, CanonicalTaskState[]>();
  for (const t of tasks) {
    const gid = t.missionId ? goalOfMission.get(t.missionId) : null;
    if (!gid) continue;
    const arr = byGoal.get(gid) ?? [];
    arr.push(states.get(t.id)!);
    byGoal.set(gid, arr);
  }
  return goals.map((x) => {
    const ms = missions.filter((m) => m.goalId === x.id);
    return {
      ...x,
      missionCount: ms.length,
      openMissionCount: ms.filter((m) => m.status !== "DONE" && m.status !== "CANCELLED").length,
      execution: deriveMissionExecution(byGoal.get(x.id) ?? []),
    };
  });
}

export type TechGoalListItem = Awaited<ReturnType<typeof listTechGoals>>[number];

export async function getTechGoal(id: string) {
  const db = await getDb();
  const goal = await db.query.techGoals.findFirst({ where: eq(schema.techGoals.id, id), with: { project: { columns: { key: true, name: true } } } });
  if (!goal) return null;
  const [missions, events] = await Promise.all([
    listTechMissions({ goalId: id, includeClosed: true }),
    db.query.techEvents.findMany({ where: eq(schema.techEvents.goalId, id), orderBy: [desc(schema.techEvents.occurredAt)], limit: 100 }),
  ]);
  return { goal, missions, events };
}

export type TechGoalDetail = NonNullable<Awaited<ReturnType<typeof getTechGoal>>>;

export async function getTechMission(id: string) {
  const db = await getDb();
  const mission = await db.query.techMissions.findFirst({
    where: eq(schema.techMissions.id, id),
    with: { goal: { columns: { id: true, code: true, title: true, status: true } }, project: { columns: { key: true, name: true } } },
  });
  if (!mission) return null;
  const [tasks, events] = await Promise.all([
    db.query.techTasks.findMany({
      where: eq(schema.techTasks.missionId, id),
      columns: {
        id: true,
        code: true,
        title: true,
        status: true,
        priority: true,
        risk: true,
        dependsOn: true,
        missionId: true,
        prNumber: true,
        prUrl: true,
        ciState: true,
        ownerEscalation: true,
        ownerAction: true,
        updatedAt: true,
      },
      orderBy: [asc(schema.techTasks.createdAt)],
      with: { agent: { columns: { key: true, name: true } } },
    }),
    db.query.techEvents.findMany({ where: eq(schema.techEvents.missionId, id), orderBy: [desc(schema.techEvents.occurredAt)], limit: 100 }),
  ]);
  const states = await canonicalStates(tasks);
  const withState = tasks.map((t) => ({ ...t, canonical: states.get(t.id)! }));
  return { mission, tasks: withState, execution: deriveMissionExecution(withState.map((t) => t.canonical)), events };
}

export type TechMissionDetail = NonNullable<Awaited<ReturnType<typeof getTechMission>>>;

/** Sứ mệnh còn nhận việc mới (cho ô chọn ở form việc). */
export async function listOpenTechMissionOptions() {
  const db = await getDb();
  return db.query.techMissions.findMany({
    where: sql`${schema.techMissions.status} NOT IN ('DONE','CANCELLED')`,
    columns: { id: true, code: true, title: true, status: true },
    orderBy: [desc(schema.techMissions.createdAt)],
    limit: 200,
  });
}

/**
 * HÀNG "CẦN CHỦ SHOP" — mọi việc đang `NEEDS_OWNER` và mọi việc R2 đang chờ duyệt. Hai loại khác nhau nhưng
 * cùng một câu hỏi với chủ shop: "cái gì đang đứng im vì tôi?".
 */
export async function techNeedsOwnerQueue() {
  const db = await getDb();
  const t = schema.techTasks;
  return db.query.techTasks.findMany({
    where: sql`${t.status} = 'NEEDS_OWNER' OR (${t.approvalStatus} = 'PENDING' AND ${t.status} NOT IN ('DONE','CANCELLED'))`,
    columns: { id: true, code: true, title: true, status: true, priority: true, risk: true, approvalStatus: true, ownerEscalation: true, ownerAction: true, updatedAt: true, missionId: true },
    with: { mission: { columns: { id: true, code: true, title: true } } },
    orderBy: [sql`case ${t.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`, asc(t.updatedAt)],
    limit: 100,
  });
}

export type TechNeedsOwnerItem = Awaited<ReturnType<typeof techNeedsOwnerQueue>>[number];

/* ═════════════════════ WORKER (Pha 2) ═════════════════════ */

/**
 * Worker kèm độ sống (hàm của nhịp tim cuối — không cột trạng thái) và các lượt đang chạy. Khoá bí mật KHÔNG
 * bao giờ rời máy chủ: cột băm không được chọn ra.
 */
export async function listTechWorkers(now = new Date()) {
  const db = await getDb();
  const workers = await db.query.techWorkers.findMany({
    columns: { secretHash: false },
    orderBy: [desc(schema.techWorkers.createdAt)],
  });
  if (!workers.length) return [];
  const runs = await db.query.techAgentRuns.findMany({
    where: and(inArray(schema.techAgentRuns.workerId, workers.map((w) => w.id)), eq(schema.techAgentRuns.status, "RUNNING")),
    columns: { id: true, workerId: true, taskId: true, startedAt: true, heartbeatAt: true, branch: true, metadata: true, provider: true, model: true },
    with: { task: { columns: { id: true, code: true, title: true, status: true } } },
  });
  return workers.map((w) => ({
    ...w,
    liveness: workerLiveness(w.lastHeartbeatAt, now),
    running: runs.filter((r) => r.workerId === w.id),
  }));
}

export type TechWorkerListItem = Awaited<ReturnType<typeof listTechWorkers>>[number];

/** Lượt chạy gần đây của worker hàng đợi, kèm nhật ký cuối (có trần) — cho trang Workers và trang việc. */
export async function recentWorkerRuns(limit = 20, logTail = 40) {
  const db = await getDb();
  const runs = await db.query.techAgentRuns.findMany({
    where: sql`${schema.techAgentRuns.workerId} IS NOT NULL`,
    orderBy: [desc(schema.techAgentRuns.startedAt)],
    limit,
    columns: { id: true, status: true, startedAt: true, endedAt: true, heartbeatAt: true, branch: true, provider: true, model: true, summary: true, error: true, metadata: true, typecheckResult: true, lintResult: true, testResult: true, buildResult: true },
    with: { task: { columns: { id: true, code: true, title: true } }, worker: { columns: { key: true } } },
  });
  if (!runs.length) return [];
  const logs = await db
    .select()
    .from(schema.techRunLogs)
    .where(sql`${schema.techRunLogs.runId} IN (${sql.join(runs.map((r) => sql`${r.id}`), sql`, `)}) AND ${schema.techRunLogs.seq} > (SELECT coalesce(max(l2.seq), 0) - ${logTail} FROM tech_run_logs l2 WHERE l2.run_id = ${schema.techRunLogs.runId})`)
    .orderBy(asc(schema.techRunLogs.seq));
  return runs.map((r) => ({ ...r, logs: logs.filter((l) => l.runId === r.id) }));
}

export type TechWorkerRunItem = Awaited<ReturnType<typeof recentWorkerRuns>>[number];

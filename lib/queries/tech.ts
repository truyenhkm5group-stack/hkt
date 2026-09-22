import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import {
  TECH_AGENT_BUSY,
  TECH_MODULE_LABEL,
  TECH_TASK_OPEN,
  TECH_TASK_SOURCE_LABEL,
  TECH_TASK_SORTABLE,
  TECH_TASK_STATUS_LABEL,
  TECH_TASK_TYPE_LABEL,
  type TechModule,
  type TechPriority,
  type TechTaskSource,
  type TechTaskStatus,
  type TechTaskType,
} from "@/lib/constants/tech";
import type { ListParams } from "@/lib/search-params";

export { TECH_TASK_SORTABLE };

/**
 * ───────────── TRUY VẤN HÀNG ĐỢI TECH ─────────────
 *
 * CHỈ CHẠY TRÊN MÁY CHỦ (`@/db`). Client component chỉ được `import type` từ đây.
 *
 * KHÔNG dùng `lib/cache.ts::memo`: hàng đợi Tech là thứ người ta mở ra để hành động ngay sau khi
 * vừa bấm một nút. Một lớp đệm 60 giây ở đây nghĩa là bấm "Duyệt" xong mở lại vẫn thấy "Chờ duyệt",
 * và người dùng sẽ bấm lần thứ hai. Bảng này nhỏ (hàng trăm dòng, không phải hàng trăm nghìn) nên
 * cái giá của việc luôn đọc mới là không đáng kể.
 */

export function techTaskWhere(params: ListParams) {
  const t = schema.techTasks;
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(t.createdAt, params.period.from));
  if (params.period.to) conds.push(lte(t.createdAt, params.period.to));
  if (params.filters.status?.length) conds.push(inArray(t.status, params.filters.status));
  if (params.filters.priority?.length) conds.push(inArray(t.priority, params.filters.priority));
  if (params.filters.risk?.length) conds.push(inArray(t.risk, params.filters.risk));
  if (params.filters.module?.length) conds.push(inArray(t.module, params.filters.module));
  if (params.filters.taskType?.length) conds.push(inArray(t.taskType, params.filters.taskType));
  if (params.filters.source?.length) conds.push(inArray(t.source, params.filters.source));
  /*
    Bộ lọc agent nhận CẢ khoá agent lẫn giá trị đặc biệt `NONE`. "Chưa giao cho agent nào" là một
    câu hỏi người ta hỏi thật, và nó KHÔNG biểu diễn được bằng một danh sách khoá — bỏ nó đi thì
    những việc chưa ai nhận biến mất khỏi mọi bộ lọc, đúng kiểu việc bị chôn.
  */
  if (params.filters.agent?.length) {
    const khoa = params.filters.agent.filter((v) => v !== "NONE");
    const coChuaGiao = params.filters.agent.includes("NONE");
    const ve: SQL[] = [];
    if (khoa.length) {
      ve.push(sql`${t.agentId} in (select ${schema.techAgents.id} from ${schema.techAgents} where ${schema.techAgents.key} in ${khoa})`);
    }
    if (coChuaGiao) ve.push(sql`${t.agentId} is null`);
    if (ve.length) conds.push(ve.length === 1 ? ve[0] : or(...ve));
  }
  /* `mo=1`: chỉ việc còn trên bàn. `DONE` là trạng thái kết thúc duy nhất. */
  if (params.filters.open?.includes("1")) conds.push(inArray(t.status, [...TECH_TASK_OPEN]));
  if (params.filters.approval?.length) conds.push(inArray(t.approvalStatus, params.filters.approval));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(t.code, like), ilike(t.title, like), ilike(t.description, like), ilike(t.branch, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listTechTasks(params: ListParams) {
  const db = await getDb();
  const t = schema.techTasks;
  const where = techTaskWhere(params);
  /*
    Sắp xếp theo mức ưu tiên phải theo ĐỘ GẤP, không theo bảng chữ cái. Tình cờ `P0 < P1 < P2 < P3`
    đúng thứ tự chữ, nhưng dựa vào sự tình cờ đó là để một ngày ai đó thêm `P4`/`PX` rồi bảng xếp
    sai mà không ai hiểu vì sao. Khai tường minh.
  */
  const uuTien = sql`case ${t.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`;
  const rui = sql`case ${t.risk} when 'R2' then 0 when 'R1' then 1 else 2 end`;
  const sortMap: Record<string, SQLWrapper> = {
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    code: t.code,
    status: t.status,
    module: t.module,
    priority: uuTien,
    risk: rui,
  };
  const col = sortMap[params.sort] ?? t.createdAt;
  const orderBy = params.dir === "asc" ? asc(col) : desc(col);

  const [rows, [{ total }]] = await Promise.all([
    db.query.techTasks.findMany({
      where,
      orderBy: [orderBy, desc(t.createdAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { agent: { columns: { id: true, key: true, name: true, role: true, status: true, enabled: true } } },
    }),
    db.select({ total: count() }).from(t).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type TechTaskListRow = Awaited<ReturnType<typeof listTechTasks>>["rows"][number];

export async function techTaskFacets(params: ListParams) {
  const db = await getDb();
  const t = schema.techTasks;
  // Đếm mặt cắt trên tập ĐÃ BỎ bộ lọc mặt cắt: nếu không, chọn một giá trị xong thì mọi giá trị
  // khác hiện số 0 và người dùng tưởng không còn gì.
  const base = techTaskWhere({ ...params, filters: {} });
  const nhom = async (col: AnyPgColumn) =>
    (await db.select({ value: col, count: count() }).from(t).where(base).groupBy(col).orderBy(desc(count()))).map((r) => ({ value: String(r.value), count: Number(r.count) }));
  const [status, priority, risk, mod, taskType, source] = await Promise.all([
    nhom(t.status),
    nhom(t.priority),
    nhom(t.risk),
    nhom(t.module),
    nhom(t.taskType),
    nhom(t.source),
  ]);
  const gan = (rows: { value: string; count: number }[], chon: string[] | undefined, nhan: (v: string) => string) => {
    const out = rows.map((r) => ({ value: r.value, label: nhan(r.value), count: Number(r.count) }));
    for (const v of chon ?? []) if (!out.some((r) => r.value === v)) out.push({ value: v, label: nhan(v), count: 0 });
    return out;
  };
  return {
    status: gan(status, params.filters.status, (v) => TECH_TASK_STATUS_LABEL[v as TechTaskStatus] ?? v),
    priority: gan(priority, params.filters.priority, (v) => v),
    risk: gan(risk, params.filters.risk, (v) => v),
    module: gan(mod, params.filters.module, (v) => TECH_MODULE_LABEL[v as TechModule] ?? v),
    taskType: gan(taskType, params.filters.taskType, (v) => TECH_TASK_TYPE_LABEL[v as TechTaskType] ?? v),
    source: gan(source, params.filters.source, (v) => TECH_TASK_SOURCE_LABEL[v as TechTaskSource] ?? v),
  };
}

/** Chi tiết một việc, kèm dòng thời gian, các lượt chạy và những thứ nối vào nó. */
export async function getTechTask(id: string) {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({
    where: eq(schema.techTasks.id, id),
    with: {
      agent: true,
      parent: { columns: { id: true, code: true, title: true, status: true } },
      children: { columns: { id: true, code: true, title: true, status: true, priority: true }, orderBy: [asc(schema.techTasks.createdAt)] },
    },
  });
  if (!task) return null;

  const [events, runs, deployments, incidents, phuThuoc] = await Promise.all([
    db.query.techTaskEvents.findMany({
      where: eq(schema.techTaskEvents.taskId, id),
      orderBy: [asc(schema.techTaskEvents.createdAt)],
      with: { agent: { columns: { key: true, name: true } } },
    }),
    db.query.techAgentRuns.findMany({
      where: eq(schema.techAgentRuns.taskId, id),
      orderBy: [desc(schema.techAgentRuns.startedAt)],
      with: { agent: { columns: { key: true, name: true, role: true } } },
    }),
    db.query.techDeployments.findMany({ where: eq(schema.techDeployments.taskId, id), orderBy: [desc(schema.techDeployments.startedAt)] }),
    db.query.techIncidents.findMany({ where: eq(schema.techIncidents.taskId, id), orderBy: [desc(schema.techIncidents.detectedAt)] }),
    task.dependsOn.length
      ? db.query.techTasks.findMany({
          where: inArray(schema.techTasks.id, task.dependsOn),
          columns: { id: true, code: true, title: true, status: true, priority: true },
        })
      : Promise.resolve([]),
  ]);

  return { task, events, runs, deployments, incidents, dependsOn: phuThuoc };
}

export type TechTaskDetail = NonNullable<Awaited<ReturnType<typeof getTechTask>>>;

/** Việc để chọn làm cha / làm phụ thuộc. Chỉ lấy việc CÒN MỞ — chọn một việc đã đóng làm phụ thuộc là tự chặn mình. */
export async function listTechTaskOptions(limit = 200) {
  const db = await getDb();
  return db.query.techTasks.findMany({
    where: inArray(schema.techTasks.status, [...TECH_TASK_OPEN]),
    columns: { id: true, code: true, title: true, status: true },
    orderBy: [desc(schema.techTasks.createdAt)],
    limit,
  });
}

/**
 * SỐ LIỆU CHO THẺ Ở TRANG TỔNG QUAN.
 *
 * Mỗi con số ở đây phải truy ngược được về một bộ lọc trên `/tech/tasks` — nếu không thì nó chỉ là
 * một con số để ngắm. `href` đi kèm chính là bộ lọc ấy.
 */
export async function techOverviewCounts() {
  const db = await getDb();
  const t = schema.techTasks;
  const homNay = new Date(Date.now() - 24 * 3600_000);

  const [[task], [agent], [run], [deploy], [incident]] = await Promise.all([
    db
      .select({
        open: sql<number>`count(*) filter (where ${t.status} <> 'DONE')`,
        p0: sql<number>`count(*) filter (where ${t.status} <> 'DONE' and ${t.priority} = 'P0')`,
        p1: sql<number>`count(*) filter (where ${t.status} <> 'DONE' and ${t.priority} = 'P1')`,
        blocked: sql<number>`count(*) filter (where ${t.status} = 'BLOCKED')`,
        failed: sql<number>`count(*) filter (where ${t.status} in ('FAILED','ROLLED_BACK'))`,
        waitingApproval: sql<number>`count(*) filter (where ${t.approvalStatus} = 'PENDING')`,
        active: sql<number>`count(*) filter (where ${t.status} in ('BUILDING','REVIEW','QA','DEPLOYING','OBSERVING'))`,
        total: sql<number>`count(*)`,
      })
      .from(t),
    db
      .select({
        enabled: sql<number>`count(*) filter (where ${schema.techAgents.enabled})`,
        busy: sql<number>`count(*) filter (where ${schema.techAgents.enabled} and ${schema.techAgents.status} in ${TECH_AGENT_BUSY})`,
        total: sql<number>`count(*)`,
      })
      .from(schema.techAgents),
    db
      .select({
        running: sql<number>`count(*) filter (where ${schema.techAgentRuns.status} = 'RUNNING')`,
        failed24h: sql<number>`count(*) filter (where ${schema.techAgentRuns.status} = 'FAILED' and ${schema.techAgentRuns.startedAt} >= ${homNay})`,
        last24h: sql<number>`count(*) filter (where ${schema.techAgentRuns.startedAt} >= ${homNay})`,
        /*
          TIỀN 24 GIỜ QUA — cận dưới, và nói ra mình là cận dưới.

          22/09/2026: chủ shop hết sạch tín dụng API và hỏi "tiền đi đâu". Không màn hình nào trả
          lời được. Tiền nay nằm ở `metadata.chiPhi`, nhưng dữ liệu có mà không ai nhìn thấy thì
          vẫn là không đo được.

          Lượt chạy TRƯỚC bản vá không có khoá ấy — chúng được ĐẾM RIÊNG chứ không cộng thành 0,
          nếu không phòng này trông như miễn phí (mục 42, và không backfill — mục 8.8).
        */
        usd24h: sql<string>`coalesce(sum((${schema.techAgentRuns.metadata} #>> '{chiPhi,usd}')::numeric) filter (where ${schema.techAgentRuns.startedAt} >= ${homNay}), 0)`,
        chuaDoDuoc24h: sql<number>`count(*) filter (where ${schema.techAgentRuns.startedAt} >= ${homNay} and (${schema.techAgentRuns.metadata} #>> '{chiPhi,usd}') is null)`,
      })
      .from(schema.techAgentRuns),
    db
      .select({
        today: sql<number>`count(*) filter (where ${schema.techDeployments.startedAt} >= ${homNay})`,
        failedToday: sql<number>`count(*) filter (where ${schema.techDeployments.startedAt} >= ${homNay} and ${schema.techDeployments.status} in ('FAILED','ROLLED_BACK'))`,
        lastAt: sql<Date | null>`max(${schema.techDeployments.startedAt})`,
      })
      .from(schema.techDeployments),
    db
      .select({
        open: sql<number>`count(*) filter (where ${schema.techIncidents.status} <> 'RESOLVED')`,
        sev01: sql<number>`count(*) filter (where ${schema.techIncidents.status} <> 'RESOLVED' and ${schema.techIncidents.severity} in ('SEV0','SEV1'))`,
      })
      .from(schema.techIncidents),
  ]);

  const so = (v: unknown) => Number(v ?? 0);
  return {
    tasks: {
      open: so(task?.open),
      p0: so(task?.p0),
      p1: so(task?.p1),
      blocked: so(task?.blocked),
      failed: so(task?.failed),
      waitingApproval: so(task?.waitingApproval),
      active: so(task?.active),
      total: so(task?.total),
    },
    agents: { enabled: so(agent?.enabled), busy: so(agent?.busy), total: so(agent?.total) },
    runs: { running: so(run?.running), failed24h: so(run?.failed24h), last24h: so(run?.last24h), usd24h: Number(run?.usd24h ?? 0), chuaDoDuoc24h: so(run?.chuaDoDuoc24h) },
    deployments: { today: so(deploy?.today), failedToday: so(deploy?.failedToday), lastAt: deploy?.lastAt ? new Date(deploy.lastAt) : null },
    incidents: { open: so(incident?.open), sev01: so(incident?.sev01) },
  };
}

export type TechOverviewCounts = Awaited<ReturnType<typeof techOverviewCounts>>;

/** Việc gấp nhất đang mở — dùng cho khối "hàng đợi" ở trang tổng quan. */
export async function topTechTasks(limit = 8) {
  const db = await getDb();
  const t = schema.techTasks;
  return db.query.techTasks.findMany({
    where: inArray(t.status, [...TECH_TASK_OPEN]),
    orderBy: [sql`case ${t.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`, desc(t.updatedAt)],
    limit,
    with: { agent: { columns: { key: true, name: true } } },
  });
}

/** Việc đang chờ chủ shop bấm duyệt. Đứng riêng vì đây là hàng đợi CỦA NGƯỜI, không phải của máy. */
export async function techTasksAwaitingApproval(limit = 20) {
  const db = await getDb();
  return db.query.techTasks.findMany({
    where: eq(schema.techTasks.approvalStatus, "PENDING"),
    orderBy: [desc(schema.techTasks.updatedAt)],
    limit,
  });
}

/** Việc mới xong và đã xác minh trên production — bằng chứng rằng vòng đời chạy tới cuối. */
export async function techRecentlyVerified(limit = 5) {
  const db = await getDb();
  return db.query.techTasks.findMany({
    where: isNotNull(schema.techTasks.productionVerifiedAt),
    orderBy: [desc(schema.techTasks.productionVerifiedAt)],
    limit,
    columns: { id: true, code: true, title: true, productionVerifiedAt: true, productionEvidence: true },
  });
}

export type TechPriorityCount = Record<TechPriority, number>;

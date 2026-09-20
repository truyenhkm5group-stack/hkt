import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { TECH_DEPLOY_SORTABLE, TECH_INCIDENT_OPEN, TECH_INCIDENT_SORTABLE } from "@/lib/constants/tech";
import type { ListParams } from "@/lib/search-params";

export { TECH_DEPLOY_SORTABLE, TECH_INCIDENT_SORTABLE };

/**
 * ───────────── DEPLOYMENT (QUAN SÁT) & SỰ CỐ ─────────────
 *
 * ERP KHÔNG phải bên có thẩm quyền về deploy — GitHub Actions là. Mọi hàm ở đây chỉ ĐỌC lại thứ đã
 * xảy ra. Không hàm nào trong tệp này kích hoạt được một lượt deploy, và đó là cố ý.
 */

export function techDeploymentWhere(params: ListParams) {
  const d = schema.techDeployments;
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(d.startedAt, params.period.from));
  if (params.period.to) conds.push(lte(d.startedAt, params.period.to));
  if (params.filters.status?.length) conds.push(inArray(d.status, params.filters.status));
  if (params.filters.branch?.length) conds.push(inArray(d.branch, params.filters.branch));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(d.commitSha, like), ilike(d.branch, like), ilike(d.notes, like), ilike(d.actorName, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listTechDeployments(params: ListParams) {
  const db = await getDb();
  const d = schema.techDeployments;
  const where = techDeploymentWhere(params);
  const sortMap = { startedAt: d.startedAt, status: d.status, commitSha: d.commitSha, branch: d.branch } as const;
  const col = sortMap[params.sort as keyof typeof sortMap] ?? d.startedAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.techDeployments.findMany({
      where,
      orderBy: [params.dir === "asc" ? asc(col) : desc(col), desc(d.startedAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { task: { columns: { id: true, code: true, title: true } } },
    }),
    db.select({ total: count() }).from(d).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type TechDeploymentListRow = Awaited<ReturnType<typeof listTechDeployments>>["rows"][number];

export async function techDeploymentFacets(params: ListParams) {
  const db = await getDb();
  const d = schema.techDeployments;
  const base = techDeploymentWhere({ ...params, filters: {} });
  const [status, branch] = await Promise.all([
    db.select({ value: d.status, count: count() }).from(d).where(base).groupBy(d.status).orderBy(desc(count())),
    db.select({ value: d.branch, count: count() }).from(d).where(base).groupBy(d.branch).orderBy(desc(count())),
  ]);
  return {
    status: status.map((s) => ({ value: s.value, label: s.value, count: Number(s.count) })),
    branch: branch.map((b) => ({ value: b.value, label: b.value, count: Number(b.count) })),
  };
}

export async function recentTechDeployments(limit = 5) {
  const db = await getDb();
  return db.query.techDeployments.findMany({
    orderBy: [desc(schema.techDeployments.startedAt)],
    limit,
    with: { task: { columns: { id: true, code: true, title: true } } },
  });
}

/**
 * Lượt deploy THÀNH CÔNG gần nhất — để đối chiếu với commit `/api/health` đang khai.
 *
 * Hai con số này lệch nhau là một dấu hiệu thật: hoặc lượt deploy chưa khởi động lại container,
 * hoặc có ai đó cập nhật máy chủ bằng đường khác. Màn hình phải nói ra chứ không im lặng chọn một.
 */
export async function lastSuccessfulDeployment() {
  const db = await getDb();
  const row = await db.query.techDeployments.findFirst({
    where: eq(schema.techDeployments.status, "SUCCEEDED"),
    orderBy: [desc(schema.techDeployments.startedAt)],
  });
  return row ?? null;
}

/**
 * LƯỢT ĐỌC GITHUB GẦN NHẤT CÓ KẾT QUẢ.
 *
 * `PARTIAL` cũng tính: lượt đó CÓ đọc được danh sách lượt chạy và có ghi vào sổ, chỉ kèm cảnh báo.
 * Loại nó ra sẽ làm sổ trông cũ hơn thực tế và đẩy màn hình về "chưa kết luận được" một cách vô cớ.
 * `FAILED` thì không tính — lượt hỏng không đọc được gì, nên nó không làm sổ mới hơn.
 *
 * `null` = chưa lượt nào. Đó là CHƯA BIẾT, không phải "sổ vừa được đọc".
 */
export async function lastGithubDeploySyncAt(): Promise<Date | null> {
  const db = await getDb();
  const row = await db.query.syncRuns.findFirst({
    where: and(eq(schema.syncRuns.source, "GITHUB"), eq(schema.syncRuns.job, "deploy_runs"), inArray(schema.syncRuns.status, ["SUCCESS", "PARTIAL"])),
    orderBy: [desc(schema.syncRuns.startedAt)],
    columns: { startedAt: true },
  });
  return row?.startedAt ?? null;
}

export function techIncidentWhere(params: ListParams) {
  const i = schema.techIncidents;
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(i.detectedAt, params.period.from));
  if (params.period.to) conds.push(lte(i.detectedAt, params.period.to));
  if (params.filters.status?.length) conds.push(inArray(i.status, params.filters.status));
  if (params.filters.severity?.length) conds.push(inArray(i.severity, params.filters.severity));
  if (params.filters.module?.length) conds.push(inArray(i.module, params.filters.module));
  if (params.filters.open?.includes("1")) conds.push(inArray(i.status, [...TECH_INCIDENT_OPEN]));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(i.code, like), ilike(i.title, like), ilike(i.evidence, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listTechIncidents(params: ListParams) {
  const db = await getDb();
  const i = schema.techIncidents;
  const where = techIncidentWhere(params);
  // Mức nặng nhẹ xếp theo ĐỘ NẶNG, khai tường minh (xem cùng lý do ở `listTechTasks`).
  const nang = sql`case ${i.severity} when 'SEV0' then 0 when 'SEV1' then 1 when 'SEV2' then 2 else 3 end`;
  const sortMap: Record<string, SQLWrapper> = { detectedAt: i.detectedAt, status: i.status, code: i.code, severity: nang };
  const col = sortMap[params.sort] ?? i.detectedAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.techIncidents.findMany({
      where,
      orderBy: [params.dir === "asc" ? asc(col) : desc(col), desc(i.detectedAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { task: { columns: { id: true, code: true, title: true } }, deployment: { columns: { id: true, commitSha: true, status: true } } },
    }),
    db.select({ total: count() }).from(i).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type TechIncidentListRow = Awaited<ReturnType<typeof listTechIncidents>>["rows"][number];

export async function techIncidentFacets(params: ListParams) {
  const db = await getDb();
  const i = schema.techIncidents;
  const base = techIncidentWhere({ ...params, filters: {} });
  const [status, severity] = await Promise.all([
    db.select({ value: i.status, count: count() }).from(i).where(base).groupBy(i.status).orderBy(desc(count())),
    db.select({ value: i.severity, count: count() }).from(i).where(base).groupBy(i.severity).orderBy(desc(count())),
  ]);
  return {
    status: status.map((s) => ({ value: s.value, label: s.value, count: Number(s.count) })),
    severity: severity.map((s) => ({ value: s.value, label: s.value, count: Number(s.count) })),
  };
}

export async function getTechIncident(id: string) {
  const db = await getDb();
  const row = await db.query.techIncidents.findFirst({
    where: eq(schema.techIncidents.id, id),
    with: { task: { columns: { id: true, code: true, title: true, status: true } }, deployment: true },
  });
  return row ?? null;
}

export type TechIncidentDetail = NonNullable<Awaited<ReturnType<typeof getTechIncident>>>;

export async function openTechIncidents(limit = 10) {
  const db = await getDb();
  return db.query.techIncidents.findMany({
    where: inArray(schema.techIncidents.status, [...TECH_INCIDENT_OPEN]),
    orderBy: [sql`case ${schema.techIncidents.severity} when 'SEV0' then 0 when 'SEV1' then 1 when 'SEV2' then 2 else 3 end`, desc(schema.techIncidents.detectedAt)],
    limit,
    with: { task: { columns: { id: true, code: true } } },
  });
}

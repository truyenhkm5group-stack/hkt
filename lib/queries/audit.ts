import { and, asc, count, desc, gte, ilike, inArray, lte, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { auditActionLabel, auditEntityLabel } from "@/lib/constants/audit";
import type { ListParams } from "@/lib/search-params";

export const AUDIT_SORTABLE = ["createdAt", "action", "entity", "userEmail"];

export function auditListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(schema.auditLogs.createdAt, params.period.from));
  if (params.period.to) conds.push(lte(schema.auditLogs.createdAt, params.period.to));
  if (params.filters.action?.length) conds.push(inArray(schema.auditLogs.action, params.filters.action));
  if (params.filters.entity?.length) conds.push(inArray(schema.auditLogs.entity, params.filters.entity));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(schema.auditLogs.userEmail, like), ilike(schema.auditLogs.entityId, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listAuditLogs(params: ListParams) {
  const db = await getDb();
  const where = auditListWhere(params);
  const sortMap = { createdAt: schema.auditLogs.createdAt, action: schema.auditLogs.action, entity: schema.auditLogs.entity, userEmail: schema.auditLogs.userEmail } as const;
  const sortColumn = sortMap[params.sort as keyof typeof sortMap] ?? schema.auditLogs.createdAt;
  const orderBy = params.dir === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [rows, [{ total }]] = await Promise.all([
    db.query.auditLogs.findMany({
      where,
      orderBy: [orderBy, desc(schema.auditLogs.createdAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { user: { columns: { id: true, name: true, role: true, active: true } } },
    }),
    db.select({ total: count() }).from(schema.auditLogs).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type AuditLogRow = Awaited<ReturnType<typeof listAuditLogs>>["rows"][number];

export async function auditFacets(params: ListParams) {
  const db = await getDb();
  const base = auditListWhere({ ...params, filters: {} });
  const [actions, entities] = await Promise.all([
    db.select({ value: schema.auditLogs.action, count: count() }).from(schema.auditLogs).where(base).groupBy(schema.auditLogs.action).orderBy(desc(count())),
    db.select({ value: schema.auditLogs.entity, count: count() }).from(schema.auditLogs).where(base).groupBy(schema.auditLogs.entity).orderBy(desc(count())),
  ]);
  const withSelected = (rows: { value: string; label: string; count: number }[], selected: string[] | undefined, label: (v: string) => string) => {
    for (const v of selected ?? []) if (!rows.some((r) => r.value === v)) rows.push({ value: v, label: label(v), count: 0 });
    return rows;
  };
  return {
    actions: withSelected(actions.map((a) => ({ value: a.value, label: auditActionLabel(a.value), count: Number(a.count) })), params.filters.action, auditActionLabel),
    entities: withSelected(entities.map((e) => ({ value: e.value, label: auditEntityLabel(e.value), count: Number(e.count) })), params.filters.entity, auditEntityLabel),
  };
}

import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_KIND_LABEL, CS_STATUS_LABEL, type CsKind, type CsStatus } from "@/lib/constants/cs";
import type { ListParams } from "@/lib/search-params";

export const CS_SORTABLE = ["createdAt", "updatedAt", "status", "kind"];

function whereOf(params: ListParams) {
  const c = schema.csCases;
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(c.createdAt, params.period.from));
  if (params.period.to) conds.push(lte(c.createdAt, params.period.to));
  if (params.filters.kind?.length) conds.push(inArray(c.kind, params.filters.kind));
  if (params.filters.status?.length) conds.push(inArray(c.status, params.filters.status));
  if (params.filters.assignee?.length) conds.push(inArray(c.assignee, params.filters.assignee));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(c.title, like), ilike(c.detail, like), ilike(c.customerName, like), ilike(c.customerPhone, like), ilike(c.assignee, like)));
  }
  const defined = conds.filter((x): x is SQL => Boolean(x));
  return defined.length ? and(...defined) : undefined;
}

export async function listCsCases(params: ListParams) {
  const db = await getDb();
  const c = schema.csCases;
  const where = whereOf(params);
  const sortCol = params.sort === "updatedAt" ? c.updatedAt : params.sort === "status" ? c.status : params.sort === "kind" ? c.kind : c.createdAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.csCases.findMany({
      where,
      orderBy: [params.dir === "asc" ? asc(sortCol) : desc(sortCol), desc(c.createdAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { order: { columns: { id: true, systemId: true, pageId: true, conversationId: true, stage: true, totalPriceAfterDiscount: true, shipAddress: true, billPhone: true } } },
    }),
    db.select({ total: count() }).from(c).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}
export type CsCaseRow = Awaited<ReturnType<typeof listCsCases>>["rows"][number];

export async function csFacets(params: ListParams) {
  const db = await getDb();
  const c = schema.csCases;
  const base = whereOf({ ...params, filters: {} });
  const [kinds, statuses, assignees] = await Promise.all([
    db.select({ value: c.kind, count: count() }).from(c).where(base).groupBy(c.kind),
    db.select({ value: c.status, count: count() }).from(c).where(base).groupBy(c.status),
    db.select({ value: c.assignee, count: count() }).from(c).where(and(base, sql`${c.assignee} <> ''`)).groupBy(c.assignee),
  ]);
  return {
    kinds: kinds.map((k) => ({ value: k.value, label: CS_KIND_LABEL[k.value as CsKind] ?? k.value, count: Number(k.count) })),
    statuses: statuses.map((k) => ({ value: k.value, label: CS_STATUS_LABEL[k.value as CsStatus] ?? k.value, count: Number(k.count) })),
    assignees: assignees.map((k) => ({ value: k.value, label: k.value, count: Number(k.count) })),
  };
}

export async function csSummary() {
  const db = await getDb();
  const c = schema.csCases;
  const rows = await db.select({ kind: c.kind, status: c.status, count: count() }).from(c).where(isNull(c.resolvedAt)).groupBy(c.kind, c.status);
  const open = rows.filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS");
  const byKind: Record<string, number> = {};
  for (const r of open) byKind[r.kind] = (byKind[r.kind] ?? 0) + Number(r.count);
  return { open: open.reduce((a, r) => a + Number(r.count), 0), new: rows.filter((r) => r.status === "OPEN").reduce((a, r) => a + Number(r.count), 0), byKind };
}

/** Case đang mở (cho cảnh báo) */
export async function openCsCases() {
  const db = await getDb();
  return db.select().from(schema.csCases).where(inArray(schema.csCases.status, ["OPEN"])).orderBy(desc(schema.csCases.createdAt)).limit(500);
}

export async function findOrderForCase(term: string) {
  const db = await getDb();
  const o = schema.orders;
  const num = Number(term);
  return db
    .select({ id: o.id, systemId: o.systemId, name: o.billFullName, phone: o.billPhone, customerId: o.customerId, total: o.totalPriceAfterDiscount })
    .from(o)
    .where(or(Number.isInteger(num) ? eq(o.systemId, num) : undefined, eq(o.id, term), ilike(o.billPhone, `%${term}%`)))
    .orderBy(desc(o.insertedAt))
    .limit(8);
}

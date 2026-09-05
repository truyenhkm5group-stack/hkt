import { and, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ListParams } from "@/lib/search-params";

export const OUTREACH_SORTABLE = ["createdAt", "lastActivityAt", "sentAt"];

function whereOf(params: ListParams, segment: string) {
  const t = schema.outreachTargets;
  const conds: (SQL | undefined)[] = [eq(t.segment, segment)];
  if (params.filters.status?.length) conds.push(inArray(t.status, params.filters.status));
  const term = params.q.trim();
  if (term) conds.push(or(ilike(t.customerName, `%${term}%`), ilike(t.phone, `%${term}%`), ilike(t.context, `%${term}%`)));
  return and(...conds.filter((c): c is SQL => Boolean(c)));
}

export async function listOutreachTargets(params: ListParams, segment: string) {
  const db = await getDb();
  const t = schema.outreachTargets;
  const where = whereOf(params, segment);
  const sortCol = params.sort === "lastActivityAt" ? t.lastActivityAt : params.sort === "sentAt" ? t.sentAt : t.createdAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.outreachTargets.findMany({ where, orderBy: [params.dir === "asc" ? sql`${sortCol} asc nulls last` : sql`${sortCol} desc nulls last`], limit: params.pageSize, offset: (params.page - 1) * params.pageSize, with: { order: { columns: { id: true, systemId: true } } } }),
    db.select({ total: count() }).from(t).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}
export type OutreachRow = Awaited<ReturnType<typeof listOutreachTargets>>["rows"][number];

export async function outreachSummary() {
  const db = await getDb();
  const t = schema.outreachTargets;
  const rows = await db.select({ segment: t.segment, status: t.status, count: count() }).from(t).groupBy(t.segment, t.status);
  const [today] = await db.select({ count: count() }).from(t).where(and(eq(t.status, "SENT"), gte(t.sentAt, new Date(Date.now() - 86_400_000))));
  const get = (seg: string, st: string) => Number(rows.find((r) => r.segment === seg && r.status === st)?.count ?? 0);
  return {
    nurture: { pending: get("NURTURE", "PENDING"), sent: get("NURTURE", "SENT"), failed: get("NURTURE", "FAILED") },
    crossSell: { pending: get("CROSS_SELL", "PENDING"), sent: get("CROSS_SELL", "SENT"), failed: get("CROSS_SELL", "FAILED") },
    sentToday: Number(today?.count ?? 0),
  };
}

export async function outreachStatusFacet(segment: string) {
  const db = await getDb();
  const t = schema.outreachTargets;
  const rows = await db.select({ value: t.status, count: count() }).from(t).where(eq(t.segment, segment)).groupBy(t.status).orderBy(desc(count()));
  return rows.map((r) => ({ value: r.value, label: r.value, count: Number(r.count) }));
}

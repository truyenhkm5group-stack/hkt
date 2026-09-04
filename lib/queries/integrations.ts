import { and, asc, count, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { RUN_STATUS_LABEL, SYNC_SOURCE_LABEL, SYNC_STATUS_ORDER, WEBHOOK_EVENT_LABEL, WEBHOOK_STATUS_ORDER } from "@/lib/constants/sync";
import type { ListParams } from "@/lib/search-params";

export const SYNC_RUN_SORTABLE = ["startedAt", "finishedAt", "status", "source"];

export function syncRunWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(schema.syncRuns.startedAt, params.period.from));
  if (params.period.to) conds.push(lte(schema.syncRuns.startedAt, params.period.to));
  if (params.filters.source?.length) conds.push(inArray(schema.syncRuns.source, params.filters.source));
  if (params.filters.status?.length) conds.push(inArray(schema.syncRuns.status, params.filters.status));
  if (params.filters.trigger?.length) conds.push(inArray(schema.syncRuns.trigger, params.filters.trigger));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listSyncRuns(params: ListParams) {
  const db = await getDb();
  const where = syncRunWhere(params);
  const sortMap = { startedAt: schema.syncRuns.startedAt, finishedAt: schema.syncRuns.finishedAt, status: schema.syncRuns.status, source: schema.syncRuns.source } as const;
  const sortColumn = sortMap[params.sort as keyof typeof sortMap] ?? schema.syncRuns.startedAt;
  const orderBy = params.dir === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [rows, [{ total }]] = await Promise.all([
    db.query.syncRuns.findMany({ where, orderBy: [orderBy, desc(schema.syncRuns.startedAt)], limit: params.pageSize, offset: (params.page - 1) * params.pageSize }),
    db.select({ total: count() }).from(schema.syncRuns).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type SyncRunRow = Awaited<ReturnType<typeof listSyncRuns>>["rows"][number];

export async function syncRunFacets(params: ListParams) {
  const db = await getDb();
  const base = syncRunWhere({ ...params, filters: {} });
  const [sources, statuses] = await Promise.all([
    db.select({ value: schema.syncRuns.source, count: count() }).from(schema.syncRuns).where(base).groupBy(schema.syncRuns.source),
    db.select({ value: schema.syncRuns.status, count: count() }).from(schema.syncRuns).where(base).groupBy(schema.syncRuns.status),
  ]);
  const statusCount = Object.fromEntries(statuses.map((s) => [s.value, Number(s.count)]));
  return {
    sources: sources.map((s) => ({ value: s.value, label: SYNC_SOURCE_LABEL[s.value] ?? s.value, count: Number(s.count) })),
    statuses: SYNC_STATUS_ORDER.map((s) => ({ value: s, label: RUN_STATUS_LABEL[s] ?? s, count: statusCount[s] ?? 0 })).filter((s) => s.count > 0 || params.filters.status?.includes(s.value)),
  };
}

/** Webhook gần nhất (không phân trang) */
export async function listRecentWebhooks(filters: { source?: string[]; status?: string[] }, limit = 30) {
  const db = await getDb();
  const conds: SQL[] = [];
  if (filters.source?.length) conds.push(inArray(schema.webhookEvents.source, filters.source));
  if (filters.status?.length) conds.push(inArray(schema.webhookEvents.status, filters.status));
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [{ total }], sources, statuses] = await Promise.all([
    db.query.webhookEvents.findMany({ where, orderBy: [desc(schema.webhookEvents.receivedAt)], limit, columns: { id: true, source: true, eventType: true, externalId: true, status: true, error: true, receivedAt: true, processedAt: true, payload: true } }),
    db.select({ total: count() }).from(schema.webhookEvents).where(where),
    db.select({ value: schema.webhookEvents.source, count: count() }).from(schema.webhookEvents).groupBy(schema.webhookEvents.source),
    db.select({ value: schema.webhookEvents.status, count: count() }).from(schema.webhookEvents).groupBy(schema.webhookEvents.status),
  ]);
  const statusCount = Object.fromEntries(statuses.map((s) => [s.value, Number(s.count)]));
  return {
    rows: rows.map((r) => ({ ...r, eventLabel: WEBHOOK_EVENT_LABEL[r.eventType] ?? r.eventType })),
    total: Number(total),
    facets: {
      sources: sources.map((s) => ({ value: s.value, label: SYNC_SOURCE_LABEL[s.value] ?? s.value, count: Number(s.count) })),
      statuses: WEBHOOK_STATUS_ORDER.map((s) => ({ value: s, label: RUN_STATUS_LABEL[s] ?? s, count: statusCount[s] ?? 0 })).filter((s) => s.count > 0 || filters.status?.includes(s.value)),
    },
  };
}

export type WebhookRow = Awaited<ReturnType<typeof listRecentWebhooks>>["rows"][number];

/** Token đối tác đã lưu (không trả về token) */
export async function getIntegrationTokenInfo(provider: string) {
  const db = await getDb();
  const row = await db.query.integrationTokens.findFirst({ where: eq(schema.integrationTokens.provider, provider), columns: { expiresAt: true, meta: true, updatedAt: true } });
  return row ?? null;
}

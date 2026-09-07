import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
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

/**
 * SỨC KHOẺ TÍCH HỢP VIETTEL POST — trả lời đúng một câu hỏi: dữ liệu vận đơn của ERP hiện đang
 * đến từ đâu và có còn chảy không.
 *
 * Hai nguồn có bản chất khác nhau, không được trộn:
 *  · webhook — dữ liệu ERP THỰC SỰ nhận được (thời gian thực);
 *  · đối chiếu qua API — ERP chủ động tra lại, dùng để vá webhook rơi.
 * Khi tài khoản API không sở hữu vận đơn thì nhánh đối chiếu vô hiệu; số liệu dưới đây phải nói
 * thẳng điều đó thay vì hiện "đồng bộ thành công".
 */
export async function viettelPostHealth() {
  const db = await getDb();
  const now = Date.now();
  const since = (hours: number) => new Date(now - hours * 3600_000);

  const [latest, counts, lastPoll, scope, pending, mismatch] = await Promise.all([
    db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.source, "VIETTELPOST"),
      orderBy: [desc(schema.webhookEvents.receivedAt)],
      columns: { externalId: true, receivedAt: true, status: true, payload: true },
    }),
    db
      .select({
        h24: sql<number>`count(*) filter (where ${schema.webhookEvents.receivedAt} >= ${since(24)})`,
        d7: sql<number>`count(*) filter (where ${schema.webhookEvents.receivedAt} >= ${since(24 * 7)})`,
        failed: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'FAILED')`,
        ignored: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'IGNORED')`,
        total: sql<number>`count(*)`,
      })
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.source, "VIETTELPOST")),
    db.query.syncRuns.findFirst({
      where: and(eq(schema.syncRuns.source, "VIETTELPOST"), eq(schema.syncRuns.job, "tracking_poll"), isNotNull(schema.syncRuns.finishedAt)),
      orderBy: [desc(schema.syncRuns.finishedAt)],
      columns: { status: true, detail: true, error: true, updated: true, finishedAt: true },
    }),
    db.query.syncState.findFirst({ where: eq(schema.syncState.key, "viettelpost:api-scope") }),
    // Vận đơn chưa kết thúc mà đã lâu không có tin mới từ Viettel Post: đây là phần đang chờ
    // được đối chiếu, cũng là phần rủi ro nhất nếu webhook rơi.
    db
      .select({
        n: sql<number>`count(*)`,
        stale48: sql<number>`count(*) filter (where coalesce(${schema.shipments.vtpStatusDate}, ${schema.shipments.createdAt}) < ${since(48)})`,
      })
      .from(schema.shipments)
      .where(and(eq(schema.shipments.isFinal, false), isNotNull(schema.shipments.vtpOrderNumber))),
    // ERP ↔ VTP lệch: trạng thái vận đơn khác trạng thái của sự kiện Viettel Post mới nhất.
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.shipments)
      .where(
        sql`exists (
          select 1 from shipment_events ev
          where ev.shipment_id = ${schema.shipments.id}
            and ev.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT')
            and ev.normalized_stage is not null
            and ev.occurred_at = (
              select max(e2.occurred_at) from shipment_events e2
              where e2.shipment_id = ${schema.shipments.id} and e2.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT') and e2.normalized_stage is not null
            )
            and ev.normalized_stage <> ${schema.shipments.stage}
        )`,
      ),
  ]);

  const data = latest?.payload && typeof latest.payload === "object" ? ((latest.payload as Record<string, unknown>).DATA as Record<string, unknown> | undefined) : undefined;
  const apiScope = (scope?.value ?? null) as { missingStreak: number; lastFoundAt: string | null; lastCheckedAt: string | null } | null;

  return {
    lastWebhook: latest
      ? { at: latest.receivedAt, orderNumber: latest.externalId ?? "", status: latest.status, statusName: String(data?.STATUS_NAME ?? "") }
      : null,
    webhooks: { last24h: Number(counts[0].h24), last7d: Number(counts[0].d7), failed: Number(counts[0].failed), ignored: Number(counts[0].ignored), total: Number(counts[0].total) },
    lastPoll: lastPoll ?? null,
    apiScope,
    /** API đang KHÔNG thấy vận đơn nào của shop — đối chiếu qua API coi như không có. */
    apiBlind: (apiScope?.missingStreak ?? 0) >= 3,
    openShipments: { total: Number(pending[0].n), stale48h: Number(pending[0].stale48) },
    stageMismatch: Number(mismatch[0].n),
  };
}

export type ViettelPostHealth = Awaited<ReturnType<typeof viettelPostHealth>>;

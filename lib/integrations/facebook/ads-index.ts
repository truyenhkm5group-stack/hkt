/**
 * Danh mục quảng cáo Facebook theo ad_id: đơn Pancake ghi ad_id của quảng cáo tạo ra đơn → tra Facebook lấy chiến dịch / tài khoản
 * → ghi nhận đơn, doanh thu cho đúng marketer (theo quy tắc nhận diện marketer của chiến dịch), kể cả khi nhiều người chạy chung một fanpage.
 * Chỉ tra các ad_id chưa có trong bảng (hoặc tra lại sau 7 ngày với ad thiếu), mỗi lô 50 id.
 */
import { and, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { loadAdsMapping, resolveMarketer } from "@/lib/integrations/facebook/mapping";
import { clearMemo } from "@/lib/cache";

export type AdIndexResult = { candidates: number; fetched: number; resolved: number; missing: number; errors: string[] };

/** Tra Facebook cho các ad_id trong đơn N ngày gần đây chưa có trong fb_ads */
export async function syncFacebookAdIndex(options: { days?: number; log?: (m: string) => void } = {}): Promise<AdIndexResult> {
  const result: AdIndexResult = { candidates: 0, fetched: 0, resolved: 0, missing: 0, errors: [] };
  const log = options.log ?? (() => undefined);
  if (!env.facebook.accessToken) {
    result.errors.push("Chưa cấu hình FACEBOOK_ACCESS_TOKEN");
    return result;
  }
  const db = await getDb();
  const since = new Date(Date.now() - (options.days ?? 120) * 86_400_000);
  const rows = await db
    .selectDistinct({ adId: schema.orders.adId })
    .from(schema.orders)
    .where(and(isNotNull(schema.orders.adId), gte(schema.orders.insertedAt, since)));
  const wanted = rows.map((r) => r.adId).filter((x): x is string => Boolean(x && /^\d{5,}$/.test(x)));
  if (!wanted.length) return result;
  const retryBefore = new Date(Date.now() - 7 * 86_400_000);
  const known = await db
    .select({ id: schema.fbAds.id })
    .from(schema.fbAds)
    .where(and(inArray(schema.fbAds.id, wanted), or(sql`${schema.fbAds.missing} = false`, gte(schema.fbAds.fetchedAt, retryBefore))));
  const knownSet = new Set(known.map((k) => k.id));
  const todo = wanted.filter((id) => !knownSet.has(id));
  result.candidates = todo.length;
  if (!todo.length) return result;
  const client = getFacebookAdsClient();
  const infos = await client.getAdsByIds(todo);
  const now = new Date();
  for (const info of infos) {
    await db
      .insert(schema.fbAds)
      .values({ id: info.id, name: info.name, adsetId: info.adsetId, campaignId: info.campaignId, campaignName: info.campaignName, accountId: info.accountId, status: info.status, missing: info.missing, fetchedAt: now })
      .onConflictDoUpdate({ target: schema.fbAds.id, set: { name: info.name, adsetId: info.adsetId, campaignId: info.campaignId, campaignName: info.campaignName, accountId: info.accountId, status: info.status, missing: info.missing, fetchedAt: now, updatedAt: now } });
    if (info.missing) {
      result.missing += 1;
      if (info.error && result.errors.length < 5) result.errors.push(`${info.id}: ${info.error}`);
    } else result.fetched += 1;
  }
  const mapping = await loadAdsMapping();
  result.resolved = infos.filter((i) => !i.missing && i.campaignId && resolveMarketer(i.campaignId, i.campaignName, i.accountId, mapping)).length;
  clearMemo();
  log(`Tra ${todo.length} ad_id: ${result.fetched} có chiến dịch, ${result.missing} không tra được, ${result.resolved} nhận diện được marketer`);
  return result;
}

/** ad_id → marketerId theo chiến dịch (ghép tay / bí danh / tài khoản); null nếu chưa tra được hoặc không nhận diện */
export async function adMarketerMap(adIds: string[]): Promise<Map<string, string | null>> {
  const clean = [...new Set(adIds.filter(Boolean))];
  const out = new Map<string, string | null>();
  if (!clean.length) return out;
  const db = await getDb();
  const [rows, mapping] = await Promise.all([db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, clean)), loadAdsMapping()]);
  for (const r of rows) out.set(r.id, r.missing || !r.campaignId ? null : resolveMarketer(r.campaignId, r.campaignName, r.accountId, mapping));
  return out;
}

/** Số ad_id trong đơn (N ngày) đã tra được / chưa tra được — để hiển thị độ phủ */
export async function adIndexCoverage(days = 90): Promise<{ orders: number; withAd: number; indexed: number; resolved: number }> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const [row] = await db
    .select({
      orders: sql<number>`count(*)`,
      withAd: sql<number>`count(*) filter (where ${schema.orders.adId} is not null)`,
      indexed: sql<number>`count(*) filter (where ${schema.fbAds.id} is not null and ${schema.fbAds.missing} = false)`,
    })
    .from(schema.orders)
    .leftJoin(schema.fbAds, sql`${schema.fbAds.id} = ${schema.orders.adId}`)
    .where(and(gte(schema.orders.insertedAt, since), sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`, lt(schema.orders.insertedAt, new Date(Date.now() + 86_400_000))));
  const ids = await db.selectDistinct({ adId: schema.orders.adId }).from(schema.orders).where(and(isNotNull(schema.orders.adId), gte(schema.orders.insertedAt, since)));
  const map = await adMarketerMap(ids.map((r) => r.adId as string));
  const resolvedIds = new Set([...map.entries()].filter(([, m]) => m).map(([id]) => id));
  const [res] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(and(gte(schema.orders.insertedAt, since), resolvedIds.size ? inArray(schema.orders.adId, [...resolvedIds]) : sql`false`));
  return { orders: Number(row?.orders ?? 0), withAd: Number(row?.withAd ?? 0), indexed: Number(row?.indexed ?? 0), resolved: Number(res?.n ?? 0) };
}

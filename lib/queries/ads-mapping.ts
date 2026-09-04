import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadAdsMapping } from "@/lib/integrations/facebook/mapping";
import { adFilterCond, type AdFilters } from "@/lib/queries/expenses";
import type { Period } from "@/lib/search-params";

export type CampaignMappingRow = {
  campaignId: string;
  campaign: string;
  accountName: string;
  spend: number;
  days: number;
  lastDate: Date | null;
  productId: string | null;
  excluded: boolean;
  manual: boolean;
  testCost: boolean;
  marketerId: string | null;
  marketerManual: boolean;
};

/** Danh sách chiến dịch Facebook trong kỳ (số ngày hoặc Period; mặc định 90 ngày) kèm trạng thái ghép để chỉnh tay */
export async function listCampaignsForMapping(range: number | Period = 90, filters?: AdFilters): Promise<CampaignMappingRow[]> {
  const db = await getDb();
  const conds: SQL[] = adFilterCond(filters);
  if (typeof range === "number") conds.push(gte(schema.adSpends.spendDate, new Date(Date.now() - range * 86_400_000)));
  else {
    if (range.from) conds.push(gte(schema.adSpends.spendDate, range.from));
    if (range.to) conds.push(lte(schema.adSpends.spendDate, range.to));
  }
  const { campaignMap } = await loadAdsMapping();
  const rows = await db
    .select({
      campaignId: schema.adSpends.campaignId,
      campaign: sql<string>`max(${schema.adSpends.campaign})`,
      accountName: sql<string>`max(coalesce(${schema.adSpends.accountName}, ''))`,
      spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`,
      days: sql<number>`count(*)`,
      lastDate: sql<string | null>`max(${schema.adSpends.spendDate})`,
      productId: sql<string | null>`max(${schema.adSpends.productId})`,
      excluded: sql<boolean>`bool_or(${schema.adSpends.excluded})`,
      marketerId: sql<string | null>`max(${schema.adSpends.marketerId})`,
    })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.platform, "Facebook"), sql`${schema.adSpends.campaignId} is not null`, ...conds))
    .groupBy(schema.adSpends.campaignId)
    .orderBy(desc(sql`coalesce(sum(${schema.adSpends.spend}), 0)`));
  return rows
    .filter((r) => r.campaignId)
    .map((r) => ({
      campaignId: r.campaignId as string,
      campaign: r.campaign ?? "",
      accountName: r.accountName ?? "",
      spend: Number(r.spend),
      days: Number(r.days),
      lastDate: r.lastDate ? new Date(r.lastDate) : null,
      productId: r.productId,
      excluded: Boolean(r.excluded),
      manual: Boolean(campaignMap[r.campaignId as string] && (campaignMap[r.campaignId as string].productId || campaignMap[r.campaignId as string].exclude || campaignMap[r.campaignId as string].testCost)),
      testCost: Boolean(campaignMap[r.campaignId as string]?.testCost),
      marketerId: r.marketerId,
      marketerManual: campaignMap[r.campaignId as string]?.marketerId !== undefined,
    }));
}

export async function listProductsForMapping() {
  const db = await getDb();
  const rows = await db.select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId }).from(schema.products).where(eq(schema.products.isRemoved, false)).orderBy(asc(schema.products.name));
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.customId ?? "" }));
}

import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadAdsMapping } from "@/lib/integrations/facebook/mapping";

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
};

/** Danh sách chiến dịch Facebook (N ngày) kèm trạng thái ghép để chỉnh tay */
export async function listCampaignsForMapping(days = 90): Promise<CampaignMappingRow[]> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86_400_000);
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
    })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.platform, "Facebook"), sql`${schema.adSpends.campaignId} is not null`, gte(schema.adSpends.spendDate, since)))
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
      manual: Boolean(campaignMap[r.campaignId as string]),
    }));
}

export async function listProductsForMapping() {
  const db = await getDb();
  const rows = await db.select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId }).from(schema.products).where(eq(schema.products.isRemoved, false)).orderBy(asc(schema.products.name));
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.customId ?? "" }));
}

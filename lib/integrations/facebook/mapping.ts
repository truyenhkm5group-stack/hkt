import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadProductCodeIndex } from "@/lib/integrations/facebook/sync";
import { matchCampaignToProduct, type ProductCodeEntry } from "@/lib/integrations/facebook/match";
import { getSettingJson, setSettingJson } from "@/lib/settings";

export const ADS_CAMPAIGN_MAP_KEY = "ads.campaignMap";
export const ADS_ALIASES_KEY = "ads.productAliases";

/** Ghép thủ công theo campaignId: productId (null = chung, không theo mã) và exclude (không tính) */
export type CampaignMap = Record<string, { productId: string | null; exclude: boolean }>;
/** Bí danh xuất hiện trong tên chiến dịch → productId (vd "q2" → Đầm Q002) */
export type ProductAliases = Record<string, string[]>;

export async function loadAdsMapping() {
  const [campaignMap, aliases] = await Promise.all([getSettingJson<CampaignMap>(ADS_CAMPAIGN_MAP_KEY, {}), getSettingJson<ProductAliases>(ADS_ALIASES_KEY, {})]);
  return { campaignMap, aliases };
}

export async function saveCampaignMap(map: CampaignMap) {
  await setSettingJson(ADS_CAMPAIGN_MAP_KEY, map);
}

export async function saveProductAliases(aliases: ProductAliases) {
  await setSettingJson(ADS_ALIASES_KEY, aliases);
}

function normalize(text: string) {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
}

/** Thứ tự ưu tiên: ghép tay theo chiến dịch → bí danh → mã tự nhận diện trong tên */
export function resolveCampaign(campaignId: string, campaignName: string, mapping: { campaignMap: CampaignMap; aliases: ProductAliases }, index: ProductCodeEntry[]): { productId: string | null; excluded: boolean; source: "manual" | "alias" | "auto" | "none" } {
  const manual = mapping.campaignMap[campaignId];
  if (manual) return { productId: manual.exclude ? null : manual.productId, excluded: manual.exclude, source: "manual" };
  const name = normalize(campaignName);
  const aliasHits = Object.entries(mapping.aliases)
    .flatMap(([productId, list]) => list.map((alias) => ({ productId, alias: alias.trim().toLowerCase() })))
    .filter((a) => a.alias && (name.includes(` ${a.alias} `) || (a.alias.length >= 3 && name.includes(a.alias))))
    .sort((a, b) => b.alias.length - a.alias.length);
  if (aliasHits[0]) return { productId: aliasHits[0].productId, excluded: false, source: "alias" };
  const auto = matchCampaignToProduct(campaignName, index);
  return { productId: auto, excluded: false, source: auto ? "auto" : "none" };
}

/** Áp lại ghép mã hàng / loại trừ cho toàn bộ dòng Facebook đã có (sau khi sửa bảng ghép hoặc bí danh) */
export async function reapplyAdsMapping() {
  const db = await getDb();
  const [mapping, index] = await Promise.all([loadAdsMapping(), loadProductCodeIndex()]);
  const rows = await db
    .select({ campaignId: schema.adSpends.campaignId, campaign: sql<string>`max(${schema.adSpends.campaign})` })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.platform, "Facebook"), sql`${schema.adSpends.campaignId} is not null`))
    .groupBy(schema.adSpends.campaignId);
  let changed = 0;
  for (const row of rows) {
    if (!row.campaignId) continue;
    const r = resolveCampaign(row.campaignId, row.campaign ?? "", mapping, index);
    const result = await db
      .update(schema.adSpends)
      .set({ productId: r.productId, excluded: r.excluded })
      .where(and(eq(schema.adSpends.campaignId, row.campaignId), sql`(${schema.adSpends.productId} is distinct from ${r.productId} or ${schema.adSpends.excluded} <> ${r.excluded})`))
      .returning({ id: schema.adSpends.id });
    changed += result.length;
  }
  return { campaigns: rows.length, changed };
}

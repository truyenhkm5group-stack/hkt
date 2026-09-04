import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadProductCodeIndex } from "@/lib/integrations/facebook/sync";
import { matchCampaignToProduct, type ProductCodeEntry } from "@/lib/integrations/facebook/match";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";

export const ADS_CAMPAIGN_MAP_KEY = "ads.campaignMap";
export const ADS_ALIASES_KEY = "ads.productAliases";

/** Ghép thủ công theo campaignId: productId (null = chung, không theo mã) và exclude (không tính) */
export type CampaignMap = Record<string, { productId: string | null; exclude: boolean; marketerId?: string | null; testCost?: boolean }>;
/** Bí danh xuất hiện trong tên chiến dịch → productId (vd "q2" → Đầm Q002) */
export type ProductAliases = Record<string, string[]>;

export type AdsMapping = { campaignMap: CampaignMap; aliases: ProductAliases; employees: Employee[] };

export async function loadAdsMapping(): Promise<AdsMapping> {
  const [campaignMap, aliases, payroll] = await Promise.all([
    getSettingJson<CampaignMap>(ADS_CAMPAIGN_MAP_KEY, {}),
    getSettingJson<ProductAliases>(ADS_ALIASES_KEY, {}),
    getSettingJson<{ list: Employee[] }>(PAYROLL_EMPLOYEES_KEY, { list: [] }),
  ]);
  return { campaignMap, aliases, employees: payroll.list ?? [] };
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

/** Marketer của chiến dịch: ghép tay → bí danh trong tên chiến dịch → tài khoản quảng cáo mặc định của marketer */
export function resolveMarketer(campaignId: string, campaignName: string, accountId: string | null, mapping: AdsMapping): string | null {
  const manual = mapping.campaignMap[campaignId];
  if (manual && manual.marketerId !== undefined) return manual.marketerId;
  const name = normalize(campaignName);
  const hits = mapping.employees
    .filter((e) => e.active !== false)
    .flatMap((e) => (e.aliases ?? []).map((alias) => ({ id: e.id, alias: normalize(alias).trim() })))
    .filter((a) => a.alias && name.includes(` ${a.alias} `))
    .sort((a, b) => b.alias.length - a.alias.length);
  if (hits[0]) return hits[0].id;
  if (accountId) {
    const byAccount = mapping.employees.find((e) => e.active !== false && (e.accountIds ?? []).includes(accountId));
    if (byAccount) return byAccount.id;
  }
  return null;
}

/** Thứ tự ưu tiên: ghép tay theo chiến dịch → bí danh → mã tự nhận diện trong tên. Không thuộc mã nào = chi phí test. */
export function resolveCampaign(campaignId: string, campaignName: string, mapping: AdsMapping, index: ProductCodeEntry[], accountId: string | null = null): { productId: string | null; excluded: boolean; marketerId: string | null; source: "manual" | "alias" | "auto" | "none" } {
  const marketerId = resolveMarketer(campaignId, campaignName, accountId, mapping);
  const manual = mapping.campaignMap[campaignId];
  if (manual && (manual.exclude || manual.productId !== undefined && (manual.productId || manual.testCost))) {
    return { productId: manual.exclude ? null : manual.productId, excluded: manual.exclude, marketerId, source: "manual" };
  }
  const name = normalize(campaignName);
  const aliasHits = Object.entries(mapping.aliases)
    .flatMap(([productId, list]) => list.map((alias) => ({ productId, alias: alias.trim().toLowerCase() })))
    .filter((a) => a.alias && (name.includes(` ${a.alias} `) || (a.alias.length >= 3 && name.includes(a.alias))))
    .sort((a, b) => b.alias.length - a.alias.length);
  if (aliasHits[0]) return { productId: aliasHits[0].productId, excluded: false, marketerId, source: "alias" };
  const auto = matchCampaignToProduct(campaignName, index);
  return { productId: auto, excluded: false, marketerId, source: auto ? "auto" : "none" };
}

/** Áp lại ghép mã hàng / loại trừ cho toàn bộ dòng Facebook đã có (sau khi sửa bảng ghép hoặc bí danh) */
export async function reapplyAdsMapping() {
  const db = await getDb();
  const [mapping, index] = await Promise.all([loadAdsMapping(), loadProductCodeIndex()]);
  const rows = await db
    .select({ campaignId: schema.adSpends.campaignId, campaign: sql<string>`max(${schema.adSpends.campaign})`, accountId: sql<string | null>`max(${schema.adSpends.accountId})` })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.platform, "Facebook"), sql`${schema.adSpends.campaignId} is not null`))
    .groupBy(schema.adSpends.campaignId);
  let changed = 0;
  for (const row of rows) {
    if (!row.campaignId) continue;
    const r = resolveCampaign(row.campaignId, row.campaign ?? "", mapping, index, row.accountId);
    const result = await db
      .update(schema.adSpends)
      .set({ productId: r.productId, excluded: r.excluded, marketerId: r.marketerId })
      .where(and(eq(schema.adSpends.campaignId, row.campaignId), sql`(${schema.adSpends.productId} is distinct from ${r.productId} or ${schema.adSpends.excluded} <> ${r.excluded} or ${schema.adSpends.marketerId} is distinct from ${r.marketerId})`))
      .returning({ id: schema.adSpends.id });
    changed += result.length;
  }
  return { campaigns: rows.length, changed };
}

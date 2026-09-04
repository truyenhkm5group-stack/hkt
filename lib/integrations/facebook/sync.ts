import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { buildProductCodeIndex, type ProductCodeEntry } from "@/lib/integrations/facebook/match";
import { loadAdsMapping, reapplyAdsMapping, resolveCampaign } from "@/lib/integrations/facebook/mapping";
import { vnStartOfDay } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

const PLATFORM = "Facebook";

function dayKey(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export async function loadProductCodeIndex(): Promise<ProductCodeEntry[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId, skus: sql<string[]>`coalesce(array_agg(distinct ${schema.productVariants.sku}) filter (where ${schema.productVariants.sku} <> ''), '{}')` })
    .from(schema.products)
    .leftJoin(schema.productVariants, eq(schema.productVariants.productId, schema.products.id))
    .where(eq(schema.products.isRemoved, false))
    .groupBy(schema.products.id);
  return buildProductCodeIndex(rows.map((r) => ({ ...r, skus: Array.isArray(r.skus) ? r.skus : [] })));
}

/**
 * Đồng bộ chi tiêu quảng cáo Facebook: mọi tài khoản trong Business Manager, theo ngày × chiến dịch.
 * Ghi đè các dòng đã có cùng khoá (Facebook có thể điều chỉnh số liệu vài ngày sau).
 */
export async function syncFacebookAds(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}) {
  return runSyncJob({ source: "FACEBOOK", job: "ads_insights", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getFacebookAdsClient();
    const days = Math.min(Math.max(options.days ?? 3, 1), 1100);
    const until = dayKey(new Date());
    const since = dayKey(new Date(Date.now() - (days - 1) * 86_400_000));
    const [index, mapping] = await Promise.all([loadProductCodeIndex(), loadAdsMapping()]);
    const accounts = await client.listAdAccounts();
    ctx.summary.detail = `${accounts.length} tài khoản · ${since} → ${until}`;
    await ctx.progress();
    let rows = 0;
    let matched = 0;
    for (const account of accounts) {
      try {
        const insights = await client.campaignInsights(account.accountId, since, until);
        const rate = account.currency && account.currency !== "VND" ? (account.currency === "USD" ? env.facebook.usdToVnd : 1) : 1;
        for (const row of insights) {
          if (!row.date) continue;
          const resolved = resolveCampaign(row.campaignId, row.campaignName, mapping, index, account.accountId);
          if (resolved.productId) matched += 1;
          const spend = Math.round(row.spend * rate);
          const values = {
            platform: PLATFORM,
            campaign: row.campaignName || row.campaignId,
            spend,
            leads: row.messages || row.leads,
            orders: row.purchases,
            revenue: Math.round(row.purchaseValue * rate),
            spendDate: vnStartOfDay(row.date),
            note: `Tài khoản ${account.name}${account.currency !== "VND" ? ` · ${account.currency} ×${rate}` : ""}`,
            createdBy: "facebook-sync",
            externalKey: `fb:${account.accountId}:${row.campaignId}:${row.date}`,
            accountId: account.accountId,
            accountName: account.name,
            campaignId: row.campaignId,
            productId: resolved.productId,
            impressions: row.impressions,
            clicks: row.clicks,
            messages: row.messages,
            currency: account.currency,
            excluded: resolved.excluded,
            marketerId: resolved.marketerId,
          };
          const [r] = await db
            .insert(schema.adSpends)
            .values(values)
            .onConflictDoUpdate({ target: schema.adSpends.externalKey, set: { ...values, updatedAt: new Date() } })
            .returning({ createdAt: schema.adSpends.createdAt, updatedAt: schema.adSpends.updatedAt });
          if (r && r.updatedAt.getTime() - r.createdAt.getTime() < 2000) ctx.summary.imported += 1;
          else ctx.summary.updated += 1;
          rows += 1;
        }
        ctx.log(`${account.name} (${account.accountId}): ${insights.length} dòng`);
      } catch (error) {
        ctx.summary.failed += 1;
        ctx.log(`${account.name} (${account.accountId}): ${error instanceof Error ? error.message : String(error)}`);
      }
      await ctx.progress();
    }
    // Áp lại bảng ghép / bí danh cho các dòng cũ (khi có sản phẩm hoặc ghép tay mới)
    const reapplied = await reapplyAdsMapping();
    if (reapplied.changed) ctx.log(`Áp lại ghép mã hàng: ${reapplied.changed} dòng thay đổi`);
    ctx.summary.detail = `${accounts.length} tài khoản · ${rows} dòng ngày×chiến dịch (${since} → ${until}) · ghép được mã hàng ${matched}/${rows}`;
    publish({ type: "ads" });
    return { accounts: accounts.length, rows, matched };
  });
}

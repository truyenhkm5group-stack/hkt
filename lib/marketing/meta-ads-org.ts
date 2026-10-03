import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { openActiveConnection } from "@/lib/connectors/service";
import type { SecretsKeyState } from "@/lib/connectors/secrets";
import { META_ADS_ORG_CONNECTOR, META_ADS_ORG_DEFAULT_DAYS, META_ADS_ORG_FIRST_RUN_DAYS, META_ADS_ORG_MAX_ACCOUNTS, parseAdAccountIds } from "@/lib/constants/meta-ads-org";
import { FacebookAdsClient } from "@/lib/integrations/facebook/client";
import { syncFacebookAds } from "@/lib/integrations/facebook/sync";
import { currentOrganization } from "@/lib/platform/context";
import type { SyncTrigger } from "@/lib/sync/runner";

/**
 * ═══════════ CHI TIÊU QUẢNG CÁO FACEBOOK CỦA TỔ CHỨC KHÁCH — JOB `ads-spend-org` ═══════════
 *
 * Chủ nền tảng chốt 03/10/2026: tổ chức khách (Hải Sản Làng Chài trước tiên) phải có chi tiêu quảng cáo Facebook TỰ
 * ĐỘNG vào `ad_spends`, bằng credential CỦA CHÍNH HỌ. Tệp này chỉ là lớp nối:
 *
 *   kết nối «meta-ads-org» ĐANG BẬT của tổ chức ngữ cảnh (`openActiveConnection` — AAD gắn tổ chức)
 *     ⇒ `FacebookAdsClient.fromOrgConnection` (chặn bằng chủ của khoá, không đọc biến môi trường chứa khoá nào)
 *     ⇒ `syncFacebookAds` — ĐÚNG bộ đồng bộ của nhà: cùng khoá tự nhiên `fb:<tk>:…:<ngày>`, cùng cổng hạt mẩu/chiến
 *       dịch, cùng bước dọn dòng tự động không còn được báo, dòng gõ tay (`external_key IS NULL`) không bao giờ bị đụng.
 *
 * Không có bộ đồng bộ thứ hai: hai bản là hai luật ghi tiền quảng cáo sống song song (AGENTS.md mục 8.12).
 *
 * ─── BỎ QUA LẶNG LẼ, NHƯNG CÓ LÝ DO ───
 *
 * Tổ chức nhà dùng `facebook-ads` (biến môi trường) — job này bỏ qua nó, để không có hai đường ghi cùng một bảng của nhà.
 * Tổ chức chưa có kết nối đang bật ⇒ bỏ qua, KHÔNG ghi `sync_runs` (lịch fan-out gõ mọi tổ chức mỗi giờ; một dòng
 * FAILED mỗi giờ cho tổ chức không chạy quảng cáo là rác che mất lỗi thật). Trả `{ skipped, detail }` — bộ lập lịch in
 * «bỏ qua <lý do>».
 *
 * Quy kết marketer (luật 67) KHÔNG nằm ở đây: dòng chi tiêu chưa ánh xạ chiến dịch → marketer rơi vào «Chưa quy kết»
 * như mọi dòng của nhà.
 */

export type OrgMetaAdsSkipped = { skipped: "HOME_USES_ENV" | "NO_ACTIVE_CONNECTION" | "NO_AD_ACCOUNTS"; org: string; detail: string };

export function isOrgMetaAdsSkipped(r: unknown): r is OrgMetaAdsSkipped {
  return !!r && typeof r === "object" && typeof (r as { skipped?: unknown }).skipped === "string";
}

/** Tổ chức ngữ cảnh đã có dòng chi tiêu Facebook TỰ ĐỘNG nào chưa — chưa có ⇒ lượt đầu kéo lùi 30 ngày. */
async function hasAutoFacebookRows(): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: schema.adSpends.id })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.platform, "Facebook"), isNotNull(schema.adSpends.externalKey)))
    .limit(1);
  return !!row;
}

export async function syncOrgMetaAds(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}, deps: { keyState?: SecretsKeyState } = {}) {
  const org = await currentOrganization();
  if (org.isHome) {
    const r: OrgMetaAdsSkipped = { skipped: "HOME_USES_ENV", org: org.code, detail: "Tổ chức nhà đồng bộ chi tiêu bằng job «facebook-ads» (biến môi trường) — job này chỉ dành cho tổ chức khách." };
    return r;
  }
  const conn = await openActiveConnection(META_ADS_ORG_CONNECTOR, { keyState: deps.keyState });
  if (!conn.ok) {
    const r: OrgMetaAdsSkipped = { skipped: "NO_ACTIVE_CONNECTION", org: org.code, detail: `Bỏ qua: ${conn.reason}` };
    return r;
  }
  const { ids } = parseAdAccountIds(conn.settings.adAccountIds);
  if (!ids.length) {
    const r: OrgMetaAdsSkipped = { skipped: "NO_AD_ACCOUNTS", org: org.code, detail: "Bỏ qua: kết nối chưa khai tài khoản quảng cáo hợp lệ nào." };
    return r;
  }
  const client = FacebookAdsClient.fromOrgConnection({ organization: org.code, accessToken: (conn.secrets.accessToken ?? "").trim(), adAccountIds: ids.slice(0, META_ADS_ORG_MAX_ACCOUNTS) });
  const days = options.days ?? ((await hasAutoFacebookRows()) ? META_ADS_ORG_DEFAULT_DAYS : META_ADS_ORG_FIRST_RUN_DAYS);
  return syncFacebookAds({ trigger: options.trigger, actor: options.actor, days, client });
}

/**
 * ═══════ TRA NHÓM QUẢNG CÁO THEO ĐÚNG MÃ ĐANG CẦN — KHÔNG QUÉT CẢ TÀI KHOẢN ═══════
 *
 * ─── VẤN ĐỀ NÀY GIẢI ───
 *
 * Form landing ghi `utm_source` bằng **adset_id**. ERP không có chỗ nào tra được mã ấy:
 * `fb_ads` chỉ tra `ad_id` xuất hiện trong `orders.ad_id` (đơn landing không có), còn `ad_spends`
 * chỉ giữ số liệu ở mức CHIẾN DỊCH nên `adset_id` không bao giờ khớp — sai CẤP, không phải thiếu
 * dữ liệu. Kết quả: 29 đơn treo ở `NO_MATCH` trong khi chiến dịch cha của chúng đã nằm sẵn trong
 * `ad_spends` với đúng một marketer.
 *
 * ─── VÌ SAO TRA THEO MÃ CHỨ KHÔNG ĐỒNG BỘ TOÀN BỘ ───
 *
 * Quét mọi adset của mọi tài khoản là hàng nghìn lời gọi Graph cho một việc cần đúng 10 mã, và
 * nó sẽ đụng giới hạn tần suất của chính lượt đồng bộ chi tiêu đang chạy. Ở đây chỉ hỏi NHỮNG MÃ
 * MÀ TRACKING ĐANG THAM CHIẾU, mỗi lô 50, và mã đã tra rồi thì không hỏi lại.
 *
 * Nhóm đã TẮT / chiến dịch đã tạm dừng vẫn tra được bình thường — Graph trả metadata cho cả
 * `PAUSED` lẫn `CAMPAIGN_PAUSED` (đo thật trên 10 mã của production).
 */
import { inArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { env } from "@/lib/env";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";

export type AdsetIndexResult = {
  /** Mã adset mà tracking landing đang tham chiếu. */
  referenced: number;
  /** Đã có trong bảng, không hỏi lại. */
  alreadyIndexed: number;
  candidates: number;
  fetched: number;
  /** Tra được và biết chiến dịch cha — đây mới là phần dùng được để quy kết. */
  withCampaign: number;
  missing: number;
  errors: string[];
};

/**
 * Những mã dạng số mà tracking landing đang tham chiếu nhưng ERP chưa tra được cấp nào.
 *
 * Đọc từ ảnh chụp `landing_attributions.utm` — tức đúng cái ERP đã thấy, không đọc lại sheet.
 */
export async function referencedAdsetIds(db?: Db): Promise<string[]> {
  const d = db ?? (await getDb());
  const rows = await d
    .select({ id: sql<string>`x.mid` })
    .from(
      sql`(
        select distinct coalesce(nullif(${schema.landingAttributions.utm} ->> 'adsetId', ''), nullif(${schema.landingAttributions.utm} ->> 'campaignName', '')) as mid
          from ${schema.landingAttributions}
         where ${schema.landingAttributions.marketerId} is null
      ) x`,
    )
    .where(sql`x.mid ~ '^[0-9]{10,25}$'`);
  return [...new Set(rows.map((r) => r.id).filter(Boolean))];
}

/** Tra Graph cho những adset đang cần, ghi vào `fb_adsets`. Idempotent; `dryRun` chỉ đếm. */
export async function syncFacebookAdsetIndex(options: { dryRun?: boolean; db?: Db; ids?: string[]; log?: (m: string) => void } = {}): Promise<AdsetIndexResult> {
  const result: AdsetIndexResult = { referenced: 0, alreadyIndexed: 0, candidates: 0, fetched: 0, withCampaign: 0, missing: 0, errors: [] };
  const log = options.log ?? (() => undefined);
  if (!env.facebook.accessToken) {
    result.errors.push("Chưa cấu hình FACEBOOK_ACCESS_TOKEN");
    return result;
  }
  const d = options.db ?? (await getDb());
  const wanted = options.ids?.length ? [...new Set(options.ids.filter((x) => /^[0-9]{10,25}$/.test(x)))] : await referencedAdsetIds(d);
  result.referenced = wanted.length;
  if (!wanted.length) return result;

  // Mã đã tra được rồi thì thôi. Mã tra HỎNG cũng không hỏi lại ngay — Graph đã trả lời "không có
  // quyền / đã xoá" thì hỏi lại sau một giờ cũng cùng câu trả lời ấy.
  const known = await d.select({ id: schema.fbAdsets.id }).from(schema.fbAdsets).where(inArray(schema.fbAdsets.id, wanted));
  const knownSet = new Set(known.map((k) => k.id));
  const todo = wanted.filter((id) => !knownSet.has(id));
  result.alreadyIndexed = knownSet.size;
  result.candidates = todo.length;
  if (!todo.length || options.dryRun) return result;

  const client = getFacebookAdsClient();
  const infos = await client.getAdsetsByIds(todo);
  const now = new Date();
  for (const info of infos) {
    if (info.missing) {
      result.missing += 1;
      if (info.error && result.errors.length < 5) result.errors.push(`${info.id}: ${info.error}`);
    } else {
      result.fetched += 1;
      if (info.campaignId) result.withCampaign += 1;
    }
    const values = { id: info.id, name: info.name, campaignId: info.campaignId, accountId: info.accountId, status: info.status, missing: info.missing, fetchedAt: now };
    await d
      .insert(schema.fbAdsets)
      .values(values)
      .onConflictDoUpdate({ target: schema.fbAdsets.id, set: { ...values, updatedAt: now } });
  }
  log(`Tra ${todo.length} adset: ${result.fetched} tra được (${result.withCampaign} biết chiến dịch cha), ${result.missing} không tra được`);
  return result;
}

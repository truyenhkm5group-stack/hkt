import { and, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AD_BOT_WINDOW_DAYS, productCodeOf, type AdBotSourceRow } from "@/lib/constants/chatbot-ad-bots";

/**
 * Quảng cáo test đang có (hoặc vừa có) khách nhắn tới — nguồn của "bot riêng theo quảng cáo".
 * Ba bảng, cùng một câu hỏi: ad_id này quảng cáo MẪU nào, khách đã xem nội dung gì.
 *   · `creative_variants`     — mẫu test của Thư viện Media (đã lên Facebook: LIVE / PAUSED / ENDED).
 *   · `creative_scale_drafts` — bản scale mẫu thắng (mẫu = mẫu của mẫu gốc).
 *   · `video_scale_ads`       — quảng cáo video.
 * Còn chạy thì luôn lấy; đã dừng thì lấy trong `AD_BOT_WINDOW_DAYS` ngày (khách bấm từ trước vẫn nhắn tới).
 */
export async function listAdBotSources(now = new Date()): Promise<AdBotSourceRow[]> {
  const db = await getDb();
  const from = new Date(now.getTime() - AD_BOT_WINDOW_DAYS * 86_400_000);
  const cv = schema.creativeVariants;
  const cb = schema.creativeBatches;
  const p = schema.products;

  const variants = await db
    .select({
      adId: cv.fbAdId,
      status: cv.status,
      campaignName: cv.campaignName,
      adName: cv.adName,
      headline: cv.headline,
      primaryText: cv.primaryText,
      productId: cv.productId,
      customId: p.customId,
      displayId: p.displayId,
      productName: p.name,
      publishedAt: sql<Date | null>`coalesce(${cv.publishedAt}, ${cb.startAt})`.mapWith((v) => (v ? new Date(v as string) : null)),
    })
    .from(cv)
    .innerJoin(cb, eq(cb.id, cv.batchId))
    .leftJoin(p, eq(p.id, cv.productId))
    .where(and(isNotNull(cv.fbAdId), inArray(cv.status, ["LIVE", "PAUSED", "ENDED"]), or(eq(cv.status, "LIVE"), gte(sql`coalesce(${cv.publishedAt}, ${cb.startAt})`, from))));

  const sd = schema.creativeScaleDrafts;
  const scales = await db
    .select({
      adId: sd.fbAdId,
      status: sd.status,
      campaignName: cv.campaignName,
      adName: cv.adName,
      headline: cv.headline,
      primaryText: cv.primaryText,
      productId: cv.productId,
      customId: p.customId,
      displayId: p.displayId,
      productName: p.name,
      publishedAt: sd.approvedAt,
    })
    .from(sd)
    .innerJoin(cv, eq(cv.id, sd.variantId))
    .leftJoin(p, eq(p.id, cv.productId))
    .where(and(isNotNull(sd.fbAdId), inArray(sd.status, ["ACTIVE", "PAUSED", "DRAFT"]), or(eq(sd.status, "ACTIVE"), gte(sd.updatedAt, from))));

  const va = schema.videoScaleAds;
  const videos = await db
    .select({
      adId: va.fbAdId,
      status: va.status,
      campaignName: va.campaignName,
      adName: va.adName,
      message: va.message,
      productId: va.productId,
      customId: p.customId,
      displayId: p.displayId,
      productName: p.name,
      publishedAt: sql<Date | null>`coalesce(${va.activatedAt}, ${va.createdAt})`.mapWith((v) => (v ? new Date(v as string) : null)),
    })
    .from(va)
    .leftJoin(p, eq(p.id, va.productId))
    .where(and(ne(va.fbAdId, ""), inArray(va.status, ["ACTIVE", "PAUSED", "STOPPED"]), or(eq(va.status, "ACTIVE"), gte(va.updatedAt, from))));

  const rows: AdBotSourceRow[] = [];
  for (const r of variants) {
    if (!r.adId) continue;
    rows.push({
      adId: r.adId,
      source: "CREATIVE_TEST",
      status: r.status,
      campaignName: r.campaignName,
      adName: r.adName,
      adCopy: [r.headline, r.primaryText].filter(Boolean).join(" — "),
      productId: r.productId,
      productCode: productCodeOf(r.customId, r.displayId),
      productName: r.productName,
      publishedAt: r.publishedAt,
    });
  }
  for (const r of scales) {
    if (!r.adId) continue;
    rows.push({
      adId: r.adId,
      source: "CREATIVE_SCALE",
      status: r.status,
      campaignName: r.campaignName ? `${r.campaignName} (scale)` : "",
      adName: r.adName,
      adCopy: [r.headline, r.primaryText].filter(Boolean).join(" — "),
      productId: r.productId,
      productCode: productCodeOf(r.customId, r.displayId),
      productName: r.productName,
      publishedAt: r.publishedAt,
    });
  }
  for (const r of videos) {
    rows.push({
      adId: r.adId,
      source: "VIDEO_SCALE",
      status: r.status,
      campaignName: r.campaignName,
      adName: r.adName,
      adCopy: r.message,
      productId: r.productId,
      productCode: productCodeOf(r.customId, r.displayId),
      productName: r.productName,
      publishedAt: r.publishedAt,
    });
  }
  return rows;
}

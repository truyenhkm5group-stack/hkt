import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Độ phủ của mối nối mẩu → bài trong `fb_ads` — để màn hình tra tay nói rõ đường TỰ ĐỒNG BỘ đang
 * làm tới đâu (tra tay chỉ là công cụ kiểm tra / dự phòng, không phải đường chính).
 *
 * `withoutCreativeInfo` là mẩu chưa từng được hỏi creative (dòng cũ trước migration 0173, hoặc dòng
 * đến từ chi tiêu chưa tới lượt) — CHƯA BIẾT, không phải "không có bài".
 */
export async function getAdPostCoverage() {
  const db = await getDb();
  const f = schema.fbAds;
  const [row] = await db
    .select({
      total: sql<number>`count(*) filter (where ${f.missing} = false)`,
      withPost: sql<number>`count(*) filter (where ${f.missing} = false and ${f.postId} is not null)`,
      withCreativeInfo: sql<number>`count(*) filter (where ${f.missing} = false and ${f.creativeId} is not null)`,
      fromObjectStory: sql<number>`count(*) filter (where ${f.postResolutionSource} = 'OBJECT_STORY_ID')`,
      missing: sql<number>`count(*) filter (where ${f.missing})`,
      lastResolvedAt: sql<string | null>`max(${f.postResolvedAt})`,
    })
    .from(f);
  const total = Number(row?.total ?? 0);
  return {
    total,
    withPost: Number(row?.withPost ?? 0),
    withoutCreativeInfo: total - Number(row?.withCreativeInfo ?? 0),
    fromObjectStory: Number(row?.fromObjectStory ?? 0),
    missing: Number(row?.missing ?? 0),
    lastResolvedAt: row?.lastResolvedAt ?? null,
  };
}

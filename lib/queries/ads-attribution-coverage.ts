import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";

/**
 * ───────────── ĐỘ PHỦ QUY KẾT QUẢNG CÁO, THEO NGÀY ─────────────
 *
 * Chủ shop chốt 09/09/2026: **~49% là GIỚI HẠN CỦA DỮ LIỆU, không phải lỗi cần làm đẹp.** Quan hệ
 * bài viết ↔ chiến dịch là nhiều–nhiều theo đúng nghiệp vụ marketing (một bài được scale ra nhiều
 * quảng cáo → nhóm → chiến dịch → tài khoản). Nên KHÔNG suy diễn bài → chiến dịch khi bài chạy ở
 * nhiều nơi, và KHÔNG ngoại suy kết quả của phần quy kết được sang toàn bộ đơn.
 *
 * Chỉ số này tồn tại để trả lời đúng một câu: **dữ liệu mới có đang tốt lên không?** Nếu shop bắt
 * đầu gắn mã theo dõi cho từng mẩu quảng cáo, đường này phải đi lên. Nếu nó nằm ngang, mọi lời hứa
 * "sẽ cải thiện quy kết" đều chưa thành hiện thực — và biểu đồ nói thẳng điều đó.
 *
 * BA NHÓM, KHÔNG PHẢI HAI:
 *   · UNIQUE_DETERMINISTIC — có `ad_id` thật, hoặc bài chỉ thuộc ĐÚNG MỘT chiến dịch ⇒ quy kết được;
 *   · AMBIGUOUS            — có bài, nhưng bài chạy ở NHIỀU chiến dịch ⇒ KHÔNG quy kết;
 *   · UNMAPPED             — không có gì để nối ⇒ KHÔNG quy kết.
 *
 * Gộp AMBIGUOUS vào UNMAPPED sẽ giấu mất thông tin quan trọng nhất: phần nhập nhằng là phần CÓ dữ
 * liệu mà vẫn không dùng được, và nó chỉ hết khi cách gắn mã thay đổi — không phải khi code đổi.
 */

const o = schema.orders;

/** Bài viết chỉ thuộc ĐÚNG MỘT chiến dịch. Nhiều hơn một là nhập nhằng, và nhập nhằng thì để yên. */
const POST_TO_ONE_CAMPAIGN = sql`(
  select fa.post_id
  from fb_ads fa
  where fa.post_id is not null and fa.post_id ~ '^[0-9]{5,}$' and fa.campaign_id is not null
  group by fa.post_id
  having count(distinct fa.campaign_id) = 1
)`;

/** Khoá bài viết của đơn: Pancake lưu `<page_id>_<post_id>`, bảng quảng cáo lưu phần sau. */
const ORDER_POST_KEY = sql`regexp_replace(${o.postId}, '^.*_', '')`;

const HAS_REAL_AD = sql`(${o.adId} is not null and exists (select 1 from fb_ads f2 where f2.id = ${o.adId}))`;
const HAS_UNIQUE_POST = sql`exists (select 1 from ${POST_TO_ONE_CAMPAIGN} p where p.post_id = ${ORDER_POST_KEY})`;
const HAS_ANY_POST = sql`coalesce(${ORDER_POST_KEY}, '') ~ '^[0-9]{5,}$'`;

export type AttributionCoverage = {
  total: number;
  uniqueDeterministic: number;
  ambiguous: number;
  unmapped: number;
  /** Phần trăm quy kết được. Đây là con số DUY NHẤT được phép gọi là "độ phủ". */
  coveragePct: number;
  /** Đơn có mã theo dõi riêng (utm / mã giới thiệu) — đường duy nhất để độ phủ tăng thật. */
  withTrackingCode: number;
};

export type CoverageDay = { day: string } & AttributionCoverage;

function shape(row: Record<string, unknown> | undefined): AttributionCoverage {
  const total = Number(row?.total ?? 0);
  const uniqueDeterministic = Number(row?.uniqueDeterministic ?? 0);
  return {
    total,
    uniqueDeterministic,
    ambiguous: Number(row?.ambiguous ?? 0),
    unmapped: Number(row?.unmapped ?? 0),
    coveragePct: total > 0 ? Math.round((uniqueDeterministic / total) * 1000) / 10 : 0,
    withTrackingCode: Number(row?.withTrackingCode ?? 0),
  };
}

const SELECT = {
  total: sql<number>`count(*)`,
  uniqueDeterministic: sql<number>`count(*) filter (where ${HAS_REAL_AD} or ${HAS_UNIQUE_POST})`,
  ambiguous: sql<number>`count(*) filter (where not (${HAS_REAL_AD} or ${HAS_UNIQUE_POST}) and ${HAS_ANY_POST})`,
  unmapped: sql<number>`count(*) filter (where not (${HAS_REAL_AD} or ${HAS_UNIQUE_POST}) and not ${HAS_ANY_POST})`,
  withTrackingCode: sql<number>`count(*) filter (where coalesce(${o.utmCampaign}, '') <> '' or coalesce(${o.referralCode}, '') <> '')`,
};

/** Độ phủ trong một khoảng. */
export async function adsAttributionCoverage(from: Date | null, to: Date | null): Promise<AttributionCoverage> {
  return memo(`ads-coverage:${from?.toISOString() ?? ""}:${to?.toISOString() ?? ""}`, 120, async () => {
    const db = await getDb();
    const where =
      from && to
        ? sql`${o.insertedAt} between ${from.toISOString()}::timestamptz and ${to.toISOString()}::timestamptz`
        : sql`true`;
    const [row] = await db.select(SELECT).from(o).where(where);
    return shape(row as Record<string, unknown>);
  });
}

/**
 * Độ phủ TỪNG NGÀY — để nhìn ra xu hướng, không chỉ một con số tĩnh.
 *
 * Ngày theo giờ Việt Nam: một ngày bán hàng của shop kết thúc lúc nửa đêm giờ VN, không phải UTC.
 */
export async function adsAttributionCoverageByDay(days = 30): Promise<CoverageDay[]> {
  return memo(`ads-coverage-day:${days}`, 120, async () => {
    const db = await getDb();
    const rows = await db
      .select({ day: sql<string>`to_char((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD')`, ...SELECT })
      .from(o)
      .where(sql`${o.insertedAt} >= now() - (${days} * interval '1 day')`)
      .groupBy(sql`(${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date`)
      .orderBy(sql`(${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date`);
    return rows.map((r) => ({ day: r.day, ...shape(r as unknown as Record<string, unknown>) }));
  });
}

/**
 * Độ phủ có đủ để KẾT LUẬN về một chiến dịch không.
 *
 * Dùng chung một ngưỡng với cảnh báo lợi nhuận quảng cáo. Dưới ngưỡng thì mọi khuyến nghị
 * SCALE/CUT đều là kết luận trên tập thiếu dữ liệu — trả `DATA_INSUFFICIENT` thay vì một con số
 * trông chắc chắn.
 */
export function coverageVerdict(coveragePct: number, threshold: number): "SUFFICIENT" | "DATA_INSUFFICIENT" {
  return coveragePct >= threshold ? "SUFFICIENT" : "DATA_INSUFFICIENT";
}

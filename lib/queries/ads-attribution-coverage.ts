import { and, sql } from "drizzle-orm";
import { postKeySql, usablePostKeySql } from "@/lib/queries/ads-identity-sql";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { populationFilter } from "@/lib/queries/metrics";

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
 * BỐN NHÓM, KHÔNG PHẢI BA (sửa 22/09/2026 — xem `docs/ads-measurement-audit-2026-09-22.md`):
 *   · UNIQUE_DETERMINISTIC — có `ad_id` thật, hoặc bài chỉ thuộc ĐÚNG MỘT chiến dịch ⇒ quy kết được;
 *   · AMBIGUOUS            — có bài, nhưng bài chạy ở NHIỀU chiến dịch ⇒ KHÔNG quy kết;
 *   · LOST_FACEBOOK        — CÓ dấu vết Facebook (fanpage / bài / mẩu) nhưng không nối được;
 *   · NOT_FROM_ADS         — KHÔNG có một dấu vết Facebook nào ⇒ **nằm NGOÀI mẫu số**.
 *
 * Gộp AMBIGUOUS vào phần còn lại sẽ giấu mất thông tin quan trọng nhất: phần nhập nhằng là phần CÓ
 * dữ liệu mà vẫn không dùng được, và nó chỉ hết khi cách gắn mã thay đổi — không phải khi code đổi.
 *
 * ─── VÌ SAO NHÓM THỨ TƯ PHẢI TÁCH RA ───
 *
 * Đo production 22/09/2026 trên 30 ngày: 514 đơn không có `ad_id` lẫn `post_id`, và chúng là HAI
 * nhóm có hệ quả trái ngược — **286** đơn nguồn `Facebook` trên 8 fanpage (mất dấu thật) và **228**
 * đơn `page_id` rỗng (đơn điện thoại / landing / khách cũ — **chưa bao giờ đi qua quảng cáo**).
 *
 * Gộp chúng lại là tính 228 đơn không thuộc về quảng cáo vào mẫu số của một tỷ lệ quảng cáo. Độ phủ
 * khi ấy đọc ra 60,6% trong khi con số đúng là 72,5% — và hai con số ấy dẫn tới hai kết luận khác
 * nhau: 72,5% là nền đủ để kết luận về một chiến dịch lớn, 60,6% thì không.
 *
 * ─── VÀ NÓ VẪN CHỈ LÀ CẬN DƯỚI, PHẢI NÓI RA ───
 *
 * `LOST_FACEBOOK` gộp hai thứ mà ERP **không tách được**: đơn quảng cáo bị mất dấu, và đơn hữu cơ
 * nhắn thẳng vào fanpage. Nên `coveragePct` là **cận dưới** của độ phủ thật, không phải con số
 * chính xác. Gọi nó là con số chính xác là khẳng định một điều chưa đo.
 *
 * ─── PHẠM VI ĐƠN PHẢI KHỚP VỚI BẢNG NÓ ĐANG DÁN NHÃN ───
 *
 * Bản trước đếm MỌI dòng `orders` trong khoảng ngày — kể cả `NEW`, `CANCELLED`, `DELETED` — trong
 * khi bảng quyết định mà nó dán nhãn chạy trên `metricScope(period, "confirmed")`. Hai mẫu số khác
 * nhau dưới cùng một cái tên: đúng lớp lỗi mà `adsRatios()` đã phải đi dọn ở báo cáo lợi nhuận.
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
const ORDER_POST_KEY = postKeySql(o.postId);

const HAS_REAL_AD = sql`(${o.adId} is not null and exists (select 1 from fb_ads f2 where f2.id = ${o.adId}))`;
const HAS_UNIQUE_POST = sql`exists (select 1 from ${POST_TO_ONE_CAMPAIGN} p where p.post_id = ${ORDER_POST_KEY})`;
const HAS_ANY_POST = usablePostKeySql(o.postId);

/**
 * KHÔNG CÓ MỘT DẤU VẾT FACEBOOK NÀO.
 *
 * Định nghĩa CẤU TRÚC, cố ý không đọc cột `orders.source` — `source` là ô chữ do Pancake đặt và
 * người dùng sửa được, nên một mẫu số tài chính không được đứng trên nó. Ba cột dưới đây thì hoặc
 * có hoặc không: không fanpage, không bài viết, không mẩu quảng cáo ⇒ đơn này chưa bao giờ đi qua
 * một quảng cáo nào, và nó không phải bằng chứng của một lần quy kết thất bại.
 */
const NO_FB_SIGNAL = sql`(
  coalesce(${o.pageId}, '') = '' and coalesce(${o.adId}, '') = '' and coalesce(${o.postId}, '') = ''
)`;

export type AttributionCoverage = {
  /** Đơn ĐÃ CHỐT trong kỳ — cùng phạm vi với bảng quyết định (`populationFilter("confirmed")`). */
  total: number;
  uniqueDeterministic: number;
  ambiguous: number;
  /** CÓ dấu vết Facebook nhưng không nối được. Gộp cả đơn mất dấu lẫn đơn hữu cơ vào fanpage. */
  lostFacebook: number;
  /** KHÔNG có dấu vết Facebook nào ⇒ nằm NGOÀI mẫu số của mọi tỷ lệ quảng cáo. */
  notFromAds: number;
  /** Mẫu số đúng: `total − notFromAds`. */
  attributable: number;
  /**
   * Phần trăm quy kết được, trên mẫu số `attributable`. Đây là con số DUY NHẤT được phép gọi là
   * "độ phủ", và nó là **CẬN DƯỚI** — mẫu số còn chứa đơn hữu cơ mà ERP không tách được.
   *
   * `null` = CHƯA ĐO ĐƯỢC (không có đơn nào trong phạm vi), KHÔNG phải 0% (mục 42).
   */
  coveragePct: number | null;
  /** Đơn có mã theo dõi riêng (utm / mã giới thiệu) — đường duy nhất để độ phủ tăng thật. */
  withTrackingCode: number;
};

export type CoverageDay = { day: string } & AttributionCoverage;

function shape(row: Record<string, unknown> | undefined): AttributionCoverage {
  const total = Number(row?.total ?? 0);
  const uniqueDeterministic = Number(row?.uniqueDeterministic ?? 0);
  const notFromAds = Number(row?.notFromAds ?? 0);
  const attributable = total - notFromAds;
  return {
    total,
    uniqueDeterministic,
    ambiguous: Number(row?.ambiguous ?? 0),
    lostFacebook: Number(row?.lostFacebook ?? 0),
    notFromAds,
    attributable,
    coveragePct: attributable > 0 ? Math.round((uniqueDeterministic / attributable) * 1000) / 10 : null,
    withTrackingCode: Number(row?.withTrackingCode ?? 0),
  };
}

const NOI_DUOC = sql`(${HAS_REAL_AD} or ${HAS_UNIQUE_POST})`;

const SELECT = {
  total: sql<number>`count(*)`,
  uniqueDeterministic: sql<number>`count(*) filter (where ${NOI_DUOC})`,
  ambiguous: sql<number>`count(*) filter (where not ${NOI_DUOC} and ${HAS_ANY_POST})`,
  lostFacebook: sql<number>`count(*) filter (where not ${NOI_DUOC} and not ${HAS_ANY_POST} and not ${NO_FB_SIGNAL})`,
  notFromAds: sql<number>`count(*) filter (where not ${NOI_DUOC} and ${NO_FB_SIGNAL})`,
  withTrackingCode: sql<number>`count(*) filter (where coalesce(${o.utmCampaign}, '') <> '' or coalesce(${o.referralCode}, '') <> '')`,
};

/** Độ phủ trong một khoảng. */
export async function adsAttributionCoverage(from: Date | null, to: Date | null): Promise<AttributionCoverage> {
  return memo(`ads-coverage:${from?.toISOString() ?? ""}:${to?.toISOString() ?? ""}`, 120_000, async () => {
    const db = await getDb();
    const inPeriod =
      from && to
        ? sql`${o.insertedAt} between ${from.toISOString()}::timestamptz and ${to.toISOString()}::timestamptz`
        : sql`true`;
    // PHẠM VI ĐƠN PHẢI KHỚP với bảng mà con số này dán nhãn — xem khối chú thích đầu tệp.
    const [row] = await db.select(SELECT).from(o).where(and(populationFilter("confirmed"), inPeriod));
    return shape(row as Record<string, unknown>);
  });
}

/**
 * Độ phủ TỪNG NGÀY — để nhìn ra xu hướng, không chỉ một con số tĩnh.
 *
 * Ngày theo giờ Việt Nam: một ngày bán hàng của shop kết thúc lúc nửa đêm giờ VN, không phải UTC.
 */
export async function adsAttributionCoverageByDay(days = 30): Promise<CoverageDay[]> {
  return memo(`ads-coverage-day:${days}`, 120_000, async () => {
    const db = await getDb();
    const rows = await db
      .select({ day: sql<string>`to_char((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD')`, ...SELECT })
      .from(o)
      .where(and(populationFilter("confirmed"), sql`${o.insertedAt} >= now() - (${days} * interval '1 day')`))
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
export function coverageVerdict(coveragePct: number | null, threshold: number): "SUFFICIENT" | "DATA_INSUFFICIENT" {
  /*
    CHƯA ĐO ĐƯỢC RƠI VỀ PHÍA HẸP HƠN.

    `null` nghĩa là không có đơn nào trong phạm vi, tức KHÔNG BIẾT độ phủ — và không biết thì không
    được coi là đủ. Nhưng giao diện phải in đúng chữ "chưa đo được" chứ không in "dưới ngưỡng": hai
    câu ấy dẫn người đọc đi hai nơi khác nhau.
  */
  if (coveragePct === null) return "DATA_INSUFFICIENT";
  return coveragePct >= threshold ? "SUFFICIENT" : "DATA_INSUFFICIENT";
}

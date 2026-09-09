import { sql } from "drizzle-orm";
import { postKeySql } from "@/lib/queries/ads-identity-sql";
import { getDb, schema } from "@/db";

/**
 * ───────────── NỐI ĐƠN VỀ CHIẾN DỊCH QUA BÀI VIẾT ─────────────
 *
 * Đo trên production: **46%** đơn đã chốt có `ad_id`, nhưng **82%** có `post_id`. Pancake không gửi
 * ad_id cho phần lớn đơn đến từ bình luận / nhắn tin dưới bài viết — và dữ liệu thô cũng không có
 * (đã kiểm: 0 đơn có ad_id trong `raw` mà thiếu ở cột). Nên chờ Pancake là chờ mãi.
 *
 * Facebook thì biết: mỗi mẩu quảng cáo quảng bá BÀI VIẾT nào (`effective_object_story_id`). Lưu mối
 * nối đó lại thì đơn chỉ có `post_id` vẫn truy được về chiến dịch — bằng DỮ KIỆN CỦA FACEBOOK,
 * không phải suy đoán.
 *
 * BA RÀNG BUỘC, và chúng quyết định toàn bộ thiết kế:
 *
 * 1. NHIỀU MẨU QUẢNG CÁO CÓ THỂ CÙNG QUẢNG BÁ MỘT BÀI. Khi đó không biết đơn đến từ mẩu nào ⇒ ở
 *    cấp MẨU là NHẬP NHẰNG, không được chọn bừa một mẩu. Nhưng nếu tất cả các mẩu đó thuộc CÙNG MỘT
 *    CHIẾN DỊCH thì cấp chiến dịch vẫn xác định — và chiến dịch mới là nơi có số chi tiêu, tức là
 *    nơi ROAS thật sự được tính.
 *
 * 2. KHÔNG GHI NGƯỢC vào bảng đơn. Đơn giữ nguyên sự thật thô của nó; phần nối được tính lúc truy
 *    vấn. Ghi một `ad_id` suy ra vào `orders` là bịa quy kết, và sau đó không ai phân biệt được đâu
 *    là dữ liệu Pancake gửi, đâu là dữ liệu ERP tự đoán.
 *
 * 3. NHẬP NHẰNG THÌ VẪN LÀ NHẬP NHẰNG. Bài viết được nhiều chiến dịch cùng chạy sẽ KHÔNG được nối,
 *    và phải đếm riêng để nhìn thấy.
 */

const o = schema.orders;

/**
 * KHOÁ BÀI VIẾT DÙNG CHUNG CHO HAI BÊN.
 *
 * Pancake ghi `orders.post_id` dạng ĐẦY ĐỦ `"<page_id>_<post_id>"`; Facebook trả
 * `effective_object_story_id` cũng dạng đó, và ERP lưu phần sau vào `fb_ads.post_id`.
 *
 * Đo trên production mới thấy: so thẳng hai cột thì KHÔNG BAO GIỜ khớp — một bên có tiền tố trang,
 * một bên không. Nên cả hai phải quy về CÙNG một khoá: phần sau dấu gạch dưới cuối cùng.
 *
 * `regexp_replace(..., '^.*_', '')` cắt tiền tố nếu có, và trả nguyên chuỗi nếu không có gạch dưới —
 * an toàn với cả hai định dạng.
 */
const ORDER_POST_KEY = postKeySql(o.postId);

/**
 * KHOÁ DÙNG ĐƯỢC: sau khi cắt tiền tố, phải là chuỗi chữ số đủ dài. Khoá hỏng (nhập tay, cắt sai,
 * mã của hệ thống khác) bị loại — nối theo nó là gán doanh thu vào chỗ không có thật.
 * Điều kiện này phải khớp `isUsablePostKey` trong lib/constants/ads-identity.ts.
 */
const ORDER_POST_USABLE = sql`(${ORDER_POST_KEY} ~ '^[0-9]{5,}$')`;

/**
 * Bài viết → chiến dịch, CHỈ khi mọi mẩu quảng cáo của bài đó thuộc cùng một chiến dịch.
 * Bài được nhiều chiến dịch chạy sẽ không có mặt ở đây.
 */
export const POST_TO_CAMPAIGN = sql`(
  select fa.post_id, min(fa.campaign_id) as campaign_id
  from fb_ads fa
  where fa.post_id is not null and fa.post_id ~ '^[0-9]{5,}$' and fa.campaign_id is not null
  group by fa.post_id
  having count(distinct fa.campaign_id) = 1
)`;

/**
 * CHIẾN DỊCH CỦA MỘT ĐƠN, theo thứ tự thẩm quyền:
 *  1. `ad_id` do Pancake gửi → chiến dịch của mẩu đó (bằng chứng trực tiếp nhất);
 *  2. `post_id` → chiến dịch, chỉ khi bài đó chỉ thuộc MỘT chiến dịch;
 *  3. không nối được ⇒ NULL, và phải hiện ra chứ không được giấu.
 */
export const ORDER_CAMPAIGN_ID = sql<string | null>`coalesce(
  (select fa.campaign_id from fb_ads fa where fa.id = ${o.adId}),
  (select p.campaign_id from ${POST_TO_CAMPAIGN} p where p.post_id = ${ORDER_POST_KEY})
)`;

/** Đơn nối được về chiến dịch bằng bài viết (không phải bằng ad_id). */
export const LINKED_BY_POST = sql`(
  (${o.adId} is null or ${o.adId} = '' or not exists (select 1 from fb_ads fa where fa.id = ${o.adId}))
  and ${ORDER_POST_USABLE}
  and exists (select 1 from ${POST_TO_CAMPAIGN} p where p.post_id = ${ORDER_POST_KEY})
)`;

/** Đơn CÓ bài viết nhưng bài đó do nhiều chiến dịch cùng chạy ⇒ nhập nhằng, cố ý không nối. */
export const AMBIGUOUS_BY_POST = sql`(
  (${o.adId} is null or ${o.adId} = '')
  and ${ORDER_POST_USABLE}
  and exists (
    select 1 from fb_ads fa where fa.post_id = ${ORDER_POST_KEY} and fa.campaign_id is not null
    group by fa.post_id having count(distinct fa.campaign_id) > 1
  )
)`;

export type AttributionLinkReport = {
  /** Đơn đã chốt trong kỳ. */
  total: number;
  /** Nối được bằng `ad_id` Pancake gửi. */
  byAdId: number;
  /** Nối thêm được nhờ bài viết. */
  byPost: number;
  /** Có bài viết nhưng bài đó do nhiều chiến dịch chạy — cố ý để nhập nhằng. */
  ambiguous: number;
  /** Không có cả ad_id lẫn post_id — nguồn thật sự thiếu. */
  noSignal: number;
  /** Có post_id nhưng chưa mẩu quảng cáo nào khai bài đó (chưa đồng bộ hoặc bài không chạy QC). */
  postNotIndexed: number;
  /** Mã bài viết hỏng — không phải chuỗi chữ số sau khi chuẩn hoá. Không nối, và phải nhìn thấy. */
  invalidPostKey: number;
  coverageBefore: number;
  coverageAfter: number;
  /** Trần lý thuyết nếu mọi bài viết đều tra được: đơn có ad_id hoặc post_id. */
  ceiling: number;
};

/**
 * Đo độ phủ TRƯỚC và SAU khi nối qua bài viết, trên cùng một tập đơn.
 * Đây là con số dùng để quyết định có bật lại cảnh báo lợi nhuận quảng cáo hay không.
 */
export async function getAttributionLinkReport(days = 30): Promise<AttributionLinkReport> {
  const db = await getDb();
  const scope = sql`${o.stage} not in ('NEW','CANCELLED','DELETED') and ${o.insertedAt} > now() - (${days} || ' days')::interval`;
  const HAS_AD = sql`(${o.adId} is not null and ${o.adId} <> '' and exists (select 1 from fb_ads fa where fa.id = ${o.adId} and fa.campaign_id is not null))`;
  const HAS_POST = sql`(${o.postId} is not null and ${o.postId} <> '')`;

  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      byAdId: sql<number>`count(*) filter (where ${HAS_AD})`,
      byPost: sql<number>`count(*) filter (where not ${HAS_AD} and ${LINKED_BY_POST})`,
      ambiguous: sql<number>`count(*) filter (where not ${HAS_AD} and ${AMBIGUOUS_BY_POST})`,
      noSignal: sql<number>`count(*) filter (where (${o.adId} is null or ${o.adId} = '') and not ${HAS_POST})`,
      postNotIndexed: sql<number>`count(*) filter (where not ${HAS_AD} and ${HAS_POST} and not exists (select 1 from fb_ads fa where fa.post_id = ${ORDER_POST_KEY}))`,
      ceiling: sql<number>`count(*) filter (where (${o.adId} is not null and ${o.adId} <> '') or ${HAS_POST})`,
      invalidPostKey: sql<number>`count(*) filter (where ${HAS_POST} and not ${ORDER_POST_USABLE})`,
    })
    .from(o)
    .where(scope);

  const total = Number(row?.total ?? 0);
  const byAdId = Number(row?.byAdId ?? 0);
  const byPost = Number(row?.byPost ?? 0);
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

  return {
    total,
    byAdId,
    byPost,
    ambiguous: Number(row?.ambiguous ?? 0),
    noSignal: Number(row?.noSignal ?? 0),
    postNotIndexed: Number(row?.postNotIndexed ?? 0),
    invalidPostKey: Number(row?.invalidPostKey ?? 0),
    coverageBefore: pct(byAdId),
    coverageAfter: pct(byAdId + byPost),
    ceiling: pct(Number(row?.ceiling ?? 0)),
  };
}

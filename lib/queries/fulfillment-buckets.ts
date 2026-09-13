import { and, gte, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { CARRIER_EVENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";
import { FULFILLMENT_BUCKETS, type FulfillmentBucket } from "@/lib/constants/fulfillment-bucket";
import { fulfillmentBucketSql } from "@/lib/queries/carrier-substate-sql";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;

/**
 * ═══════════ ĐƠN HÀNG ĐANG Ở ĐÂU TRONG TAY ĐVVC — MỘT BỘ RỔ, KHÔNG CHỒNG LẤN ═══════════
 *
 * ─── THAY CHO CÁI GÌ ───
 *
 * Khối "Luồng đơn hàng" trên trang chủ đếm theo `orders.stage`, tức theo TRẠNG THÁI PANCAKE —
 * mười ba nhãn do người bán bấm tay. "Đã gửi hàng" ở đó nghĩa là ai đó đã bấm nút, không nghĩa là
 * bưu tá đã cầm gói hàng. Khối này trả lời đúng câu còn lại: **theo chứng từ ĐVVC, hàng đang ở đâu.**
 *
 * Hai khối KHÔNG thay thế nhau và cố ý đứng cạnh nhau: chênh lệch giữa chúng chính là việc tồn
 * đọng của khâu bàn giao (đơn bấm "đã gửi" mà chưa ai lấy, đơn đã tới tay khách mà chưa ai bấm).
 *
 * ─── MỖI ĐƠN ĐÚNG MỘT RỔ, ĐÚNG MỘT LẦN ───
 *
 * `PRIMARY_ATTEMPT` chọn LẦN GỬI QUYẾT ĐỊNH, cùng luật với `ORDER_OUTCOME`. Nhờ nó đơn gửi lại
 * không bị đếm hai lần, và lần gửi hỏng trước KHÔNG đè lên lần gửi đang chạy.
 *
 * Các rổ loại trừ nhau theo cấu trúc: biểu thức `case` trả về đúng một giá trị cho mỗi dòng, và
 * mỗi đơn chỉ có một dòng. Tổng các rổ vì thế luôn bằng tổng số đơn trong kỳ — `tongRoDayDu()`
 * kiểm điều đó, và `tests/fulfillment-bucket.test.ts` khoá lại.
 */

/** Có dấu vết ĐVVC nào không — cùng nghĩa với `HAS_CARRIER_LINK` của return-rate.ts. */
const CO_DAU_VET = sql`(${s.vtpOrderNumber} is not null or ${s.trackingCode} is not null or exists (
  select 1 from shipment_events ev where ev.shipment_id = ${s.id} and ev.source in (${sql.raw(sqlSourceList(CARRIER_EVENT_SOURCES))}) and ev.normalized_stage is not null
))`;

/**
 * CHỨNG TỪ NÓI GÓI HÀNG ĐÃ RỜI KHO — mốc lấy hàng, hoặc một sự kiện hành trình mang chặng sau mốc
 * lấy. Dùng CHỈ cho trạng thái con mơ hồ ("chờ xử lý"), nơi câu chữ không kết luận được.
 */
const DA_ROI_KHO = sql`(${s.pickedUpAt} is not null or exists (
  select 1 from shipment_events ev where ev.shipment_id = ${s.id}
    and ev.normalized_stage in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','RETURNING','RETURNED')
))`;

export const FULFILLMENT_BUCKET_EXPR = fulfillmentBucketSql({
  ma: sql`${s.vtpStatus}`,
  chu: sql`${s.vtpStatusName}`,
  chang: sql`${s.stage}::text`,
  coDauVetDvvc: CO_DAU_VET,
  coVanDon: sql`(${s.id} is not null)`,
  changDon: sql`${o.stage}::text`,
  daRoiKho: DA_ROI_KHO,
});

/**
 * RỔ CỦA MỘT ĐƠN, dưới dạng MỘT GIÁ TRỊ dùng được ở cả câu đếm lẫn câu lọc.
 *
 * Đây là lý do thẻ trên trang chủ và danh sách mở ra khi bấm vào thẻ luôn khớp nhau: chúng không
 * phải hai câu lệnh "cùng ý"; chúng là CÙNG MỘT biểu thức. Hai câu viết riêng rồi cùng đúng hôm nay
 * là hai câu sẽ lệch nhau vào một ngày không ai để ý.
 *
 * `coalesce` bắt trường hợp đơn KHÔNG có dòng vận đơn nào: truy vấn con không trả dòng nào nên giá
 * trị là NULL, và ở đó chỉ trạng thái Pancake mới nói được điều gì — huỷ/xoá, hay chưa bàn giao.
 */
export const ORDER_BUCKET_SCALAR = sql<string>`coalesce(
  (select ${FULFILLMENT_BUCKET_EXPR} from shipments where shipments.order_id = ${o.id} and ${PRIMARY_ATTEMPT} limit 1),
  case when ${o.stage} in ('CANCELLED','DELETED') then 'CANCELLED' else 'NOT_SHIPPED' end
)`;

export type FulfillmentSummary = {
  counts: Record<FulfillmentBucket, number>;
  /** Tiền LÊN ĐƠN của mỗi rổ. KHÔNG phải tiền sẽ thu — rổ "đang hoàn" có COD nhưng COD đó đã mất. */
  bookedRevenue: Record<FulfillmentBucket, number>;
  /** Tổng đơn trong kỳ. Phải bằng tổng các rổ — nếu lệch thì có đơn không rổ nào nhận. */
  total: number;
  measuredAt: Date;
};

function roRong(): Record<FulfillmentBucket, number> {
  return Object.fromEntries(FULFILLMENT_BUCKETS.map((b) => [b, 0])) as Record<FulfillmentBucket, number>;
}

export async function getFulfillmentBuckets(period: Period): Promise<FulfillmentSummary> {
  return memo(`fulfillment-buckets:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 90_000, async () => {
    const db = await getDb();
    const dieuKien = [period.from ? gte(o.insertedAt, period.from) : undefined, period.to ? lte(o.insertedAt, period.to) : undefined].filter(Boolean);
    const rows = await db
      .select({ bucket: ORDER_BUCKET_SCALAR, count: sql<number>`count(*)`, revenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}), 0)` })
      .from(o)
      .where(dieuKien.length ? and(...dieuKien) : undefined)
      .groupBy(sql`1`);

    const counts = roRong();
    const bookedRevenue = roRong();
    let total = 0;
    for (const r of rows) {
      const key = (FULFILLMENT_BUCKETS as readonly string[]).includes(r.bucket) ? (r.bucket as FulfillmentBucket) : "UNKNOWN";
      counts[key] += Number(r.count ?? 0);
      bookedRevenue[key] += Number(r.revenue ?? 0);
      total += Number(r.count ?? 0);
    }
    return { counts, bookedRevenue, total, measuredAt: new Date() };
  });
}

/**
 * TỔNG KIỂM: các rổ phải cộng đúng bằng tổng đơn.
 *
 * Không phải nghi thức. Một biểu thức `case` thiếu nhánh sẽ trả `NULL`, và `NULL` không rơi vào rổ
 * nào — con số biến mất mà không có lỗi nào phát ra. Phép cộng này là chỗ nó lộ ra.
 */
export function tongRoDayDu(s: FulfillmentSummary): { ok: boolean; tongRo: number; chenh: number } {
  const tongRo = FULFILLMENT_BUCKETS.reduce((a, b) => a + s.counts[b], 0);
  return { ok: tongRo === s.total, tongRo, chenh: s.total - tongRo };
}

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import type { Period } from "@/lib/search-params";

/**
 * HIỆU SUẤT GIAO VẬN TÍNH TỪ HÀNH TRÌNH, KHÔNG TỪ TRẠNG THÁI HIỆN TẠI.
 *
 * Trạng thái hiện tại chỉ nói vận đơn đang ở đâu; nó không trả lời được "lấy hàng mất bao lâu",
 * "bao nhiêu đơn phát thành công ngay lần đầu", "bao nhiêu đơn đang kẹt". Những câu đó phải tính
 * từ mốc thời gian của từng sự kiện.
 *
 * Nguyên tắc:
 *  · chỉ dùng sự kiện ĐẾN THẲNG TỪ ĐVVC (xem lib/integrations/viettelpost/state.ts) — bản sao
 *    Pancake mang giờ Pancake ghi nhận nên không đo thời gian được;
 *  · vận đơn CHƯA kết thúc không bị tính là giao thất bại;
 *  · mọi tỷ lệ đều kèm mẫu số và cỡ mẫu, không có tỷ lệ nào đứng một mình;
 *  · thiếu dữ liệu thì trả null, không trả 0.
 */
export type LogisticsPerformance = {
  /** Vận đơn có ít nhất một sự kiện thật từ Viettel Post trong kỳ. */
  tracked: number;
  delivered: number;
  returned: number;
  /** Đã kết thúc = giao thành công + hoàn. Mẫu số của tỷ lệ giao thành công. */
  terminal: number;
  inFlight: number;
  /** Giao thành công ÷ đã kết thúc (%). null khi chưa có đơn nào kết thúc. */
  successRateTerminal: number | null;
  /** Giao thành công ÷ tất cả vận đơn có hành trình (%) — mẫu số rộng hơn, luôn thấp hơn. */
  successRateAll: number | null;
  /**
   * Phát thành công ngay lần đầu ÷ tổng đơn đã giao (%) — không có bước phát thất bại nào trước đó.
   *
   * CHỈ ĐÁNG TIN KHI HÀNH TRÌNH ĐẦY ĐỦ. Tệp danh sách vận đơn chỉ mang TRẠNG THÁI CUỐI của mỗi
   * vận đơn, nên vận đơn nào chỉ có dữ liệu từ tệp sẽ không có bước "phát thất bại" trong lịch sử
   * và bị tính nhầm là thành công ngay lần đầu. Vì vậy luôn kèm `failureEvidence` — số vận đơn
   * thực sự có ghi nhận phát thất bại — để người đọc biết con số dựa trên bao nhiêu bằng chứng.
   */
  firstAttemptRate: number | null;
  firstAttemptSample: number;
  /** Số vận đơn có ít nhất một bước phát thất bại trong hành trình. */
  failureEvidence: number;
  /** Giờ từ lúc tạo vận đơn tới lúc ĐVVC lấy hàng. */
  pickupHours: { p50: number | null; p90: number | null; sample: number };
  /** Giờ từ lúc lấy hàng tới lúc phát thành công. */
  deliveryHours: { p50: number | null; p90: number | null; sample: number };
  /** Vận đơn chưa kết thúc mà đã lâu không có tin mới từ ĐVVC. */
  stuck24h: number;
  stuck48h: number;
  stuck72h: number;
};

export async function logisticsPerformance(period: Period): Promise<LogisticsPerformance> {
  return memo(`logistics-performance:${period.fromKey ?? "-"}:${period.toKey ?? "-"}`, 90, async () => {
    const db = await getDb();
    const from = period.from ? sql`${period.from}` : sql`'-infinity'::timestamptz`;
    const to = period.to ? sql`${period.to}` : sql`'infinity'::timestamptz`;

    const result = await db.execute<{
      tracked: number; delivered: number; returned: number; in_flight: number;
      first_attempt: number; first_attempt_sample: number; failure_evidence: number;
      pickup_p50: number | null; pickup_p90: number | null; pickup_sample: number;
      delivery_p50: number | null; delivery_p90: number | null; delivery_sample: number;
      stuck24: number; stuck48: number; stuck72: number;
    }>(sql`
      with ev as (
        select e.shipment_id,
          min(e.occurred_at) filter (where e.normalized_stage in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED')) as picked_at,
          min(e.occurred_at) filter (where e.normalized_stage = 'DELIVERED') as delivered_at,
          min(e.occurred_at) filter (where e.normalized_stage = 'DELIVERY_FAILED') as first_failed_at,
          min(e.occurred_at) filter (where e.normalized_stage = 'RETURNED') as returned_at,
          max(e.occurred_at) as last_event_at
        from shipment_events e
        where e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','MANUAL') and e.normalized_stage is not null
        group by e.shipment_id
      ),
      base as (
        select s.id, s.created_at, s.is_final, ev.picked_at, ev.delivered_at, ev.first_failed_at, ev.returned_at, ev.last_event_at,
          extract(epoch from (ev.picked_at - s.created_at)) / 3600.0 as pickup_hours,
          extract(epoch from (ev.delivered_at - ev.picked_at)) / 3600.0 as delivery_hours
        from shipments s
        join ev on ev.shipment_id = s.id
        where ev.last_event_at >= ${from} and ev.last_event_at <= ${to}
      )
      select
        count(*)::int as tracked,
        count(*) filter (where delivered_at is not null)::int as delivered,
        count(*) filter (where returned_at is not null)::int as returned,
        count(*) filter (where is_final = false)::int as in_flight,
        count(*) filter (where delivered_at is not null and (first_failed_at is null or first_failed_at > delivered_at))::int as first_attempt,
        count(*) filter (where delivered_at is not null)::int as first_attempt_sample,
        count(*) filter (where first_failed_at is not null)::int as failure_evidence,
        percentile_cont(0.5) within group (order by pickup_hours) filter (where pickup_hours > 0) as pickup_p50,
        percentile_cont(0.9) within group (order by pickup_hours) filter (where pickup_hours > 0) as pickup_p90,
        count(*) filter (where pickup_hours > 0)::int as pickup_sample,
        percentile_cont(0.5) within group (order by delivery_hours) filter (where delivery_hours > 0) as delivery_p50,
        percentile_cont(0.9) within group (order by delivery_hours) filter (where delivery_hours > 0) as delivery_p90,
        count(*) filter (where delivery_hours > 0)::int as delivery_sample,
        count(*) filter (where is_final = false and last_event_at < now() - interval '24 hours')::int as stuck24,
        count(*) filter (where is_final = false and last_event_at < now() - interval '48 hours')::int as stuck48,
        count(*) filter (where is_final = false and last_event_at < now() - interval '72 hours')::int as stuck72
      from base
    `);
    const row = (Array.isArray(result) ? result[0] : result.rows?.[0]) as Record<string, unknown> | undefined;

    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    const tracked = Number(row?.tracked ?? 0);
    const delivered = Number(row?.delivered ?? 0);
    const returned = Number(row?.returned ?? 0);
    const firstAttempt = Number(row?.first_attempt ?? 0);
    const firstAttemptSample = Number(row?.first_attempt_sample ?? 0);
    const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

    return {
      tracked,
      delivered,
      returned,
      terminal: delivered + returned,
      inFlight: Number(row?.in_flight ?? 0),
      successRateTerminal: pct(delivered, delivered + returned),
      successRateAll: pct(delivered, tracked),
      firstAttemptRate: pct(firstAttempt, firstAttemptSample),
      firstAttemptSample,
      failureEvidence: Number(row?.failure_evidence ?? 0),
      pickupHours: { p50: round1(n(row?.pickup_p50)), p90: round1(n(row?.pickup_p90)), sample: Number(row?.pickup_sample ?? 0) },
      deliveryHours: { p50: round1(n(row?.delivery_p50)), p90: round1(n(row?.delivery_p90)), sample: Number(row?.delivery_sample ?? 0) },
      stuck24h: Number(row?.stuck24 ?? 0),
      stuck48h: Number(row?.stuck48 ?? 0),
      stuck72h: Number(row?.stuck72 ?? 0),
    };
  });
}

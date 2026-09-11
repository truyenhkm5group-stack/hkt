import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { CARE_SLA } from "@/lib/constants/care";
import { getCareWorkbench } from "@/lib/queries/care-workbench";
import { SHIPMENT_DELIVERED, SHIPMENT_RETURNED } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ HIỆU QUẢ CARE: KẾT QUẢ + SLA + TIỀN, KHÔNG PHẢI SỐ LẦN BẤM ═══════════
 *
 * Một người bấm 100 lần "đã gọi" không đáng khen hơn một người gọi 10 cuộc mà 8 kiện giao được.
 * Nên mỗi con số ở đây đi kèm MẪU SỐ và KẾT CỤC của kiện (theo `SHIPMENT_DELIVERED` /
 * `SHIPMENT_RETURNED` — chứng từ ĐVVC, không phải trạng thái care):
 *
 *  · can thiệp = kiện có ÍT NHẤT MỘT hành động care của NGƯỜI (care_actions) sau lần giao hụt;
 *  · cứu được = kiện giao hụt, có can thiệp, rồi giao thành công;
 *  · so với nhóm giao hụt KHÔNG ai can thiệp — để biết can thiệp có khác gì không.
 *
 * Tiền "cứu được" là COD của kiện đã giao thành công SAU can thiệp — đã tới tay khách, chưa chắc đã
 * về tài khoản (đó là chuyện của Đối soát COD).
 */

export type CareStaffRow = {
  actor: string;
  actions: number;
  reached: number;
  casesDone: number;
  /** Kiện giao hụt người này can thiệp rồi giao thành công. */
  recovered: number;
  recoveredCod: number;
  /** Kiện người này can thiệp rồi vẫn hoàn. */
  returnedAfterCare: number;
  intervened: number;
  overdueOwned: number;
  medianFirstResponseHours: number | null;
};

export type CareReport = {
  period: Period;
  backlog: { care: number; waiting: number; escalated: number; overdue: number; unassigned: number; moneyAtRisk: number };
  firstResponse: { medianHours: number | null; withinSla: number; measured: number };
  done: { count: number; reopened: number; medianResolveHours: number | null; withinSla: number };
  recovery: {
    failedTotal: number;
    failedIntervened: number;
    failedNotIntervened: number;
    recoveredIntervened: number;
    recoveredNotIntervened: number;
    returnedIntervened: number;
    returnedNotIntervened: number;
    recoveredCod: number;
    stillOpen: number;
  };
  redelivery: { requested: number; delivered: number; returned: number; pending: number };
  carrierRequests: { total: number; success: number; ack: number; failed: number; unsupported: number; manual: number; manualDone: number };
  staff: CareStaffRow[];
};

/** `array_agg` về dạng mảng hoặc chuỗi "{1.5,3}" tuỳ driver — đọc cả hai, bỏ NULL. */
function pgArray(v: unknown): number[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",") : [];
  return raw.map((x) => (x === null || x === "" || x === "NULL" ? NaN : Number(x))).filter((x) => Number.isFinite(x));
}

function between(col: string, period: Period) {
  const parts: string[] = [];
  if (period.from) parts.push(`${col} >= '${period.from.toISOString()}'::timestamptz`);
  if (period.to) parts.push(`${col} <= '${period.to.toISOString()}'::timestamptz`);
  return parts.length ? sql.raw(parts.join(" and ")) : sql.raw("true");
}

export async function getCareReport(period: Period): Promise<CareReport> {
  return memo(`care-report:${periodKey(period)}`, 120_000, () => build(period));
}

async function build(period: Period): Promise<CareReport> {
  const db = await getDb();
  const wb = await getCareWorkbench();

  // ── Kiện giao hụt trong kỳ: có ai can thiệp không, kết cục ra sao ──
  const failed = rowsOf<{ shipment_id: string; intervened: boolean; delivered: boolean; returned: boolean; cod: string | number; actors: string[] | null }>(
    await db.execute(sql`
      with hut as (
        select e.shipment_id, min(e.occurred_at) as first_failed_at
          from shipment_events e
         where e.normalized_stage = 'DELIVERY_FAILED' and ${between("e.occurred_at", period)}
         group by e.shipment_id
      )
      select h.shipment_id,
             exists (select 1 from care_actions a where a.shipment_id = h.shipment_id and a.created_at >= h.first_failed_at) as intervened,
             (${SHIPMENT_DELIVERED}) as delivered,
             (${SHIPMENT_RETURNED}) as returned,
             shipments.cod_amount as cod,
             (select array_agg(distinct a.actor_email) from care_actions a where a.shipment_id = h.shipment_id and a.created_at >= h.first_failed_at) as actors
        from hut h
        join shipments on shipments.id = h.shipment_id
        left join orders on orders.id = shipments.order_id
    `),
  );
  const fi = failed.filter((r) => r.intervened);
  const fn = failed.filter((r) => !r.intervened);
  const recovery = {
    failedTotal: failed.length,
    failedIntervened: fi.length,
    failedNotIntervened: fn.length,
    recoveredIntervened: fi.filter((r) => r.delivered).length,
    recoveredNotIntervened: fn.filter((r) => r.delivered).length,
    returnedIntervened: fi.filter((r) => r.returned).length,
    returnedNotIntervened: fn.filter((r) => r.returned).length,
    recoveredCod: fi.filter((r) => r.delivered).reduce((a, r) => a + Number(r.cod ?? 0), 0),
    stillOpen: failed.filter((r) => !r.delivered && !r.returned).length,
  };

  // ── Phát lại: đã hẹn lại / yêu cầu phát tiếp ⇒ kết cục ──
  const redeliver = rowsOf<{ delivered: boolean; returned: boolean }>(
    await db.execute(sql`
      with yc as (
        select a.shipment_id from care_actions a where a.kind = 'RESCHEDULED' and ${between("a.created_at", period)}
        union
        select r.shipment_id from carrier_action_requests r where r.action_key = 'redeliver' and r.status in ('ACK','SUCCESS','MANUAL_DONE') and ${between("r.created_at", period)}
      )
      select (${SHIPMENT_DELIVERED}) as delivered, (${SHIPMENT_RETURNED}) as returned
        from yc join shipments on shipments.id = yc.shipment_id left join orders on orders.id = shipments.order_id
    `),
  );
  const redelivery = {
    requested: redeliver.length,
    delivered: redeliver.filter((r) => r.delivered).length,
    returned: redeliver.filter((r) => r.returned).length,
    pending: redeliver.filter((r) => !r.delivered && !r.returned).length,
  };

  // ── Yêu cầu gửi ĐVVC ──
  const [cr] = rowsOf<{ total: number; success: number; ack: number; failed: number; unsupported: number; manual: number; manual_done: number }>(
    await db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where status = 'SUCCESS')::int as success,
             count(*) filter (where status in ('SENT','ACK'))::int as ack,
             count(*) filter (where status = 'FAILED')::int as failed,
             count(*) filter (where status = 'UNSUPPORTED')::int as unsupported,
             count(*) filter (where status = 'MANUAL_REQUIRED')::int as manual,
             count(*) filter (where status = 'MANUAL_DONE')::int as manual_done
        from carrier_action_requests where ${between("created_at", period)}
    `),
  );

  // ── Phản hồi đầu / đóng việc theo SLA (trên bảng care) ──
  const careRows = rowsOf<{ first_hours: string | null; resolve_hours: string | null; done: boolean; reopened: boolean }>(
    await db.execute(sql`
      select extract(epoch from (c.first_response_at - c.created_at)) / 3600 as first_hours,
             extract(epoch from (c.done_at - c.created_at)) / 3600 as resolve_hours,
             (c.care_status = 'DONE' and ${between("c.done_at", period)}) as done,
             (c.reopen_count > 0) as reopened
        from shipment_care c
       where ${between("c.updated_at", period)}
    `),
  );
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
  };
  const firstHours = careRows.map((r) => (r.first_hours === null ? null : Number(r.first_hours))).filter((x): x is number => x !== null && x >= 0);
  const doneRows = careRows.filter((r) => r.done);
  const resolveHours = doneRows.map((r) => (r.resolve_hours === null ? null : Number(r.resolve_hours))).filter((x): x is number => x !== null && x >= 0);

  // ── Theo nhân viên: kết quả, không phải số lần bấm ──
  const staffRows = rowsOf<{ actor: string; actions: number; reached: number; cases_done: number; intervened: number; recovered: number; recovered_cod: string | number; returned_after: number; overdue_owned: number; first_hours: unknown }>(
    await db.execute(sql`
      with hd as (
        select a.actor_email as actor, count(*)::int as actions,
               count(*) filter (where a.kind in ('CALLED_REACHED','MESSAGED','ADDRESS_FIXED','RESCHEDULED','CUSTOMER_REFUSED'))::int as reached
          from care_actions a where ${between("a.created_at", period)} group by a.actor_email
      ),
      xong as (
        select c.updated_by as actor, count(*)::int as cases_done
          from shipment_care c where c.care_status = 'DONE' and ${between("c.done_at", period)} group by c.updated_by
      ),
      ket as (
        select a.actor_email as actor,
               count(distinct a.shipment_id)::int as intervened,
               count(distinct a.shipment_id) filter (where (${SHIPMENT_DELIVERED}))::int as recovered,
               coalesce(sum(shipments.cod_amount) filter (where (${SHIPMENT_DELIVERED})), 0) as recovered_cod,
               count(distinct a.shipment_id) filter (where (${SHIPMENT_RETURNED}))::int as returned_after
          from care_actions a
          join shipments on shipments.id = a.shipment_id
          left join orders on orders.id = shipments.order_id
         where ${between("a.created_at", period)}
           and exists (select 1 from shipment_events e where e.shipment_id = a.shipment_id and e.normalized_stage = 'DELIVERY_FAILED' and e.occurred_at <= a.created_at)
         group by a.actor_email
      ),
      tre as (
        select c.owner_email as actor, count(*)::int as overdue_owned
          from shipment_care c
         where c.care_status in ('NEW','IN_PROGRESS','WAITING') and c.first_response_at is null and c.created_at < now() - (${CARE_SLA.firstResponseHours} || ' hours')::interval
         group by c.owner_email
      ),
      ph as (
        select c.updated_by as actor, array_agg(extract(epoch from (c.first_response_at - c.created_at)) / 3600) as first_hours
          from shipment_care c where c.first_response_at is not null and ${between("c.first_response_at", period)} group by c.updated_by
      )
      select coalesce(hd.actor, xong.actor, ket.actor, tre.actor, ph.actor) as actor,
             coalesce(hd.actions, 0) as actions, coalesce(hd.reached, 0) as reached,
             coalesce(xong.cases_done, 0) as cases_done,
             coalesce(ket.intervened, 0) as intervened, coalesce(ket.recovered, 0) as recovered, coalesce(ket.recovered_cod, 0) as recovered_cod, coalesce(ket.returned_after, 0) as returned_after,
             coalesce(tre.overdue_owned, 0) as overdue_owned,
             ph.first_hours
        from hd
        full join xong on xong.actor = hd.actor
        full join ket on ket.actor = coalesce(hd.actor, xong.actor)
        full join tre on tre.actor = coalesce(hd.actor, xong.actor, ket.actor)
        full join ph on ph.actor = coalesce(hd.actor, xong.actor, ket.actor, tre.actor)
       where coalesce(hd.actor, xong.actor, ket.actor, tre.actor, ph.actor) <> ''
    `),
  );
  const staff: CareStaffRow[] = staffRows
    .map((r) => ({
      actor: r.actor,
      actions: Number(r.actions),
      reached: Number(r.reached),
      casesDone: Number(r.cases_done),
      recovered: Number(r.recovered),
      recoveredCod: Number(r.recovered_cod ?? 0),
      returnedAfterCare: Number(r.returned_after),
      intervened: Number(r.intervened),
      overdueOwned: Number(r.overdue_owned),
      medianFirstResponseHours: median(pgArray(r.first_hours).filter((x) => x >= 0)),
    }))
    .sort((a, b) => b.recoveredCod - a.recoveredCod || b.recovered - a.recovered || b.casesDone - a.casesDone);

  return {
    period,
    backlog: { care: wb.counts.care, waiting: wb.counts.waiting, escalated: wb.counts.escalated, overdue: wb.overdue, unassigned: wb.unassigned, moneyAtRisk: wb.moneyAtRisk },
    firstResponse: { medianHours: median(firstHours), withinSla: firstHours.filter((h) => h <= CARE_SLA.firstResponseHours).length, measured: firstHours.length },
    done: { count: doneRows.length, reopened: careRows.filter((r) => r.reopened).length, medianResolveHours: median(resolveHours), withinSla: resolveHours.filter((h) => h <= CARE_SLA.resolveHours).length },
    recovery,
    redelivery,
    carrierRequests: { total: Number(cr?.total ?? 0), success: Number(cr?.success ?? 0), ack: Number(cr?.ack ?? 0), failed: Number(cr?.failed ?? 0), unsupported: Number(cr?.unsupported ?? 0), manual: Number(cr?.manual ?? 0), manualDone: Number(cr?.manual_done ?? 0) },
    staff,
  };
}

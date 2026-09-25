import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { CARRIER_HANDOFF_AT_SQL } from "@/lib/constants/carrier-handoff";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { variantLabel } from "@/lib/constants/stock-shortage";
import {
  DEFAULT_WAIT_ORIGIN,
  PANCAKE_CANCEL_CODES,
  PANCAKE_WAITING_CODES,
  buildRecommendations,
  buildWaitReport,
  dailyWaitingSeries,
  dayRange,
  expectedRateFor,
  findWaitBreakpoint,
  waitBucketCaseSql,
  waitBucketOf,
  type CurrentWaitingOrder,
  type DailyWaitingRow,
  type Recommendation,
  type WaitBreakpoint,
  type WaitCell,
  type WaitCellKey,
  type WaitInterval,
  type WaitOrigin,
  type WaitReport,
  type WaitSegment,
} from "@/lib/constants/stock-wait-report";
import { provinceRegion } from "@/lib/constants/vn-regions";
import { todayVN, vnDateKey } from "@/lib/format";
import { CONFIRMED_AT } from "@/lib/queries/conversion-funnel";
import { MIN_TIER_SAMPLE, OUTCOME_FENCE, PRIMARY_ATTEMPT, REPORTABLE_ORDER, outcomeColumn } from "@/lib/queries/return-rate";
import { getStockShortage } from "@/lib/queries/stock-shortage";
import { rowsOf } from "@/lib/sql-rows";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;
const w = schema.stockWaitLog;

/**
 * ═══════════ CHỜ HÀNG & GTC — ĐỌC ═══════════
 *
 * Luật (khoảng chờ, gộp bảng, kiểm định, đề xuất) nằm ở `lib/constants/stock-wait-report.ts`. Tệp
 * này chỉ gom đầu vào, từ ĐÚNG các nguồn đã có hợp đồng:
 *
 *   · Kết quả đơn    = `outcomeColumn()` (ORDER_OUTCOME đã vật chất hoá, có nhánh dự phòng) — không
 *                      viết lại điều kiện giao / hoàn (AGENTS.md mục 3.1).
 *   · Mốc bàn giao   = `CARRIER_HANDOFF_AT_SQL` (mục 41).
 *   · Chờ hàng ERP   = sổ `stock_wait_log` do job `alerts` ghi.
 *   · Chờ hàng Pancake = `order_status_history` ở các mã nhóm "Chờ hàng".
 *   · Đơn đang chờ   = bảng thiếu hàng hiện tại (`getStockShortage`) + đơn đang ở nhóm "Chờ hàng" của Pancake.
 *
 * Kỳ lọc theo NGÀY LÊN ĐƠN (mục 58): câu hỏi là "đơn khách chốt trong kỳ, chờ bao lâu, rồi ra sao".
 */

/** Ngày tối đa của chuỗi theo ngày — một năm từng ngày không đọc được trên một màn hình. */
export const DAILY_MAX_DAYS = 60;
/** Số đơn đang chờ in ra trang; danh sách đầy đủ ở trang Thiếu hàng giao đơn / hàng đợi fulfillment. */
export const CURRENT_LIST_LIMIT = 200;

const codeList = (codes: number[]) => sql.raw(`(${codes.length ? codes.join(",") : "null"})`);

/**
 * Biểu thức mốc bắt đầu tính ngày chờ. `CONFIRMED` dùng lại ĐÚNG `CONFIRMED_AT` của phễu chuyển đổi
 * (lần đầu trạng thái Pancake rời nhóm chờ) — không viết định nghĩa "xác nhận" thứ hai.
 */
function originSql(origin: WaitOrigin): SQL {
  return origin === "CONFIRMED" ? sql`${CONFIRMED_AT}` : sql`${o.insertedAt}`;
}

async function waitCells(period: Period, origin: WaitOrigin): Promise<WaitCell[]> {
  const db = await getDb();
  const conds: SQL[] = [REPORTABLE_ORDER];
  if (period.from) conds.push(sql`${o.insertedAt} >= ${period.from}`);
  if (period.to) conds.push(sql`${o.insertedAt} <= ${period.to}`);
  const base = db
    .select({
      province: o.shipProvince,
      value: o.totalPriceAfterDiscount,
      outcome: outcomeColumn(),
      originAt: sql<Date | null>`${originSql(origin)}`.as("origin_at"),
      handoffAt: sql<Date | null>`${sql.raw(CARRIER_HANDOFF_AT_SQL)}`.as("handoff_at"),
      cancelAt: sql<Date | null>`(select min(h.updated_at) from order_status_history h where h.order_id = ${o.id} and h.status in ${codeList(PANCAKE_CANCEL_CODES)})`.as("cancel_at"),
      segment: sql<WaitSegment>`case
        when exists (select 1 from stock_wait_log wl where wl.order_id = ${o.id}) then 'ERP_LOG'
        when exists (select 1 from order_status_history hw where hw.order_id = ${o.id} and hw.status in ${codeList(PANCAKE_WAITING_CODES)}) then 'PANCAKE_WAITING'
        else 'NONE' end`.as("segment"),
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(...conds))
    .offset(OUTCOME_FENCE)
    .as("wait_base");

  const og = `"wait_base"."origin_at"`;
  const ha = `"wait_base"."handoff_at"`;
  const ca = `"wait_base"."cancel_at"`;
  const hd = `(extract(epoch from (${ha} - ${og})) / 86400.0)`;
  const cd = `(extract(epoch from (${ca} - ${og})) / 86400.0)`;
  const oc = `"wait_base"."outcome"`;
  const finishedSql = `${oc} = 'DELIVERED' or ${oc} in (${RETURNED_OUTCOMES_SQL})`;
  /*
    Khoảng chờ: có mốc bàn giao ⇒ đo từ mốc bắt đầu tới mốc đó; huỷ khi chưa gửi ⇒ đo tới mốc huỷ;
    đã gửi / đã huỷ mà KHÔNG có mốc bắt đầu đang chọn ⇒ 'NO_ORIGIN' (đếm riêng, không rơi về mốc kia);
    huỷ khi chưa gửi mà mốc bắt đầu KHÔNG sớm hơn lúc huỷ ⇒ cũng 'NO_ORIGIN': đơn chưa từng bắt đầu chờ
    theo mốc này. Đo production 25/09/2026 (mốc xác nhận): 682 đơn huỷ khi còn ở nhóm chờ mang mốc
    "rời nhóm chờ" = CHÍNH lúc huỷ và bị đếm là "chờ 0 ngày rồi huỷ" — sai nghĩa cột huỷ trước gửi.
    Với mốc lên đơn luật này không đổi gì: đơn luôn được lên trước khi huỷ.
    đã có kết cục mà THIẾU mốc bàn giao ⇒ '?'; còn lại (chưa gửi, chưa huỷ) ⇒ 'OPEN'.
  */
  const bucket = sql<WaitCellKey>`${sql.raw(`case
    when (${ha} is not null or ${oc} = 'CANCELLED') and ${og} is null then 'NO_ORIGIN'
    when ${ha} is null and ${oc} = 'CANCELLED' and ${ca} is not null and ${og} >= ${ca} then 'NO_ORIGIN'
    when ${ha} is not null then ${waitBucketCaseSql(hd)}
    when ${oc} = 'CANCELLED' then ${waitBucketCaseSql(cd)}
    when ${finishedSql} then '?'
    else 'OPEN' end`)}`;

  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        province: base.province,
        bucket: bucket.as("bucket"),
        segment: base.segment,
        orders: sql<number>`count(*)`,
        delivered: sql<number>`count(*) filter (where ${base.outcome} = 'DELIVERED')`,
        returned: sql<number>`count(*) filter (where ${base.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
        inTransit: sql<number>`count(*) filter (where ${base.outcome} = 'IN_TRANSIT')`,
        cancelledBeforeShip: sql<number>`count(*) filter (where ${base.outcome} = 'CANCELLED' and ${base.handoffAt} is null)`,
        deliveredValue: sql<number>`coalesce(sum(${base.value}) filter (where ${base.outcome} = 'DELIVERED'), 0)`,
        returnedValue: sql<number>`coalesce(sum(${base.value}) filter (where ${base.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)})), 0)`,
      })
      .from(base)
      .groupBy(base.province, bucket, base.segment),
  );
  return rows.map((r) => ({
    province: r.province ?? "",
    bucket: String(r.bucket) as WaitCellKey,
    segment: String(r.segment) as WaitSegment,
    orders: Number(r.orders),
    delivered: Number(r.delivered),
    returned: Number(r.returned),
    inTransit: Number(r.inTransit),
    cancelledBeforeShip: Number(r.cancelledBeforeShip),
    deliveredValue: Number(r.deliveredValue),
    returnedValue: Number(r.returnedValue),
  }));
}

/** Khoảng chờ ERP (sổ) và Pancake (lịch sử trạng thái) chạm vào [from, to]. */
async function waitIntervals(from: Date, to: Date): Promise<{ erp: WaitInterval[]; pancake: WaitInterval[]; erpSince: Date | null }> {
  const db = await getDb();
  const [erpRows, sinceRow, pancakeRes] = await Promise.all([
    db
      .select({ orderId: w.orderId, start: w.firstSeenAt, end: w.clearedAt })
      .from(w)
      .where(and(lte(w.firstSeenAt, to), or(isNull(w.clearedAt), gte(w.clearedAt, from)))),
    db.select({ since: sql<string | null>`min(${w.firstSeenAt})` }).from(w),
    db.execute(sql`
      select x.order_id,
             x.start_at,
             case when x.end_at is not null then x.end_at
                  -- Không có dòng sau mà đơn VẪN ở nhóm Chờ hàng ⇒ còn đang chờ.
                  when od.status in ${codeList(PANCAKE_WAITING_CODES)} then null
                  -- Không có dòng sau mà đơn đã sang trạng thái khác ⇒ lịch sử thiếu; lấy mốc đổi trạng thái gần nhất.
                  else greatest(x.start_at, coalesce(od.last_update_status_at, x.start_at)) end as end_at
        from (
          select h.order_id, h.status, h.updated_at as start_at,
                 lead(h.updated_at) over (partition by h.order_id order by h.updated_at, h.id) as end_at
            from order_status_history h
           where h.order_id in (select h2.order_id from order_status_history h2 where h2.status in ${codeList(PANCAKE_WAITING_CODES)})
        ) x
        join orders od on od.id = x.order_id
       where x.status in ${codeList(PANCAKE_WAITING_CODES)}
         and x.start_at <= ${to}
         and (x.end_at is null or x.end_at >= ${from})
    `),
  ]);
  const since = sinceRow[0]?.since;
  return {
    erp: erpRows.map((r) => ({ orderId: r.orderId, start: new Date(r.start), end: r.end ? new Date(r.end) : null })),
    pancake: rowsOf<{ order_id: string; start_at: string | Date; end_at: string | Date | null }>(pancakeRes).map((r) => ({
      orderId: r.order_id,
      start: new Date(r.start_at),
      end: r.end_at ? new Date(r.end_at) : null,
    })),
    erpSince: since ? new Date(since) : null,
  };
}

async function currentWaiting(report: WaitReport, now: Date, origin: WaitOrigin) {
  const db = await getDb();
  const snapshot = await getStockShortage();
  const erp = [...snapshot.orders.values()].filter((x) => x.state === "WAITING_STOCK");
  const pancake = await db
    .select({ id: o.id, systemId: o.systemId, customer: o.billFullName, value: o.totalPriceAfterDiscount, insertedAt: o.insertedAt, province: o.shipProvince })
    .from(o)
    .where(eq(o.stage, "WAITING"));
  const ids = [...new Set([...erp.map((x) => x.orderId), ...pancake.map((p) => p.id)])];
  const metaRows = ids.length ? await db.select({ id: o.id, province: o.shipProvince, originAt: sql<Date | string | null>`${originSql(origin)}` }).from(o).where(inArray(o.id, ids)) : [];
  const provinceOf = new Map(metaRows.map((r) => [r.id, r.province]));
  const originOf = new Map(metaRows.map((r) => [r.id, r.originAt ? new Date(r.originAt) : null]));

  const byId = new Map<string, CurrentWaitingOrder>();
  const make = (x: { orderId: string; systemId: number | null; customer: string; value: number; insertedAt: Date; province: string }): CurrentWaitingOrder => {
    const reg = provinceRegion(x.province);
    // Đơn chưa có mốc bắt đầu đang chọn (vd chưa xác nhận) ⇒ ngày chờ CHƯA BIẾT, không phải 0.
    const start = originOf.get(x.orderId) ?? null;
    const waitDays = start ? Math.max(0, (now.getTime() - start.getTime()) / 86_400_000) : null;
    const bucket = waitDays === null ? ("?" as const) : waitBucketOf(waitDays);
    const exp = expectedRateFor(report, bucket, reg?.mien ?? null);
    return { ...x, mien: reg?.mien ?? null, vung: reg?.vung ?? null, sources: [], shortText: "", waitDays, bucket, expectedRate: exp.rate, expectedBasis: exp.basis };
  };
  for (const v of erp) {
    const row = make({ orderId: v.orderId, systemId: v.systemId, customer: v.customer, value: v.value, insertedAt: v.insertedAt, province: provinceOf.get(v.orderId) ?? "" });
    row.sources.push("ERP");
    row.shortText = v.shortLines.map((l) => `${l.label} ×${l.short}`).join(", ");
    byId.set(v.orderId, row);
  }
  let pancakeOnly = 0;
  for (const p of pancake) {
    const cur = byId.get(p.id);
    if (cur) {
      cur.sources.push("PANCAKE");
      continue;
    }
    pancakeOnly++;
    const row = make({ orderId: p.id, systemId: p.systemId ?? null, customer: p.customer || "Khách", value: Number(p.value ?? 0), insertedAt: new Date(p.insertedAt), province: p.province });
    row.sources.push("PANCAKE");
    byId.set(p.id, row);
  }
  const list = [...byId.values()].sort((a, b) => (b.waitDays ?? -1) - (a.waitDays ?? -1) || (a.orderId < b.orderId ? -1 : 1));
  const topShortVariants = [...snapshot.variants]
    .sort((a, b) => b.waitingOrders - a.waitingOrders || b.shortQty - a.shortQty)
    .slice(0, 5)
    .map((v) => ({ label: variantLabel(v), waitingOrders: v.waitingOrders }));
  return { list, pancakeOnly, topShortVariants, measuredAt: snapshot.measuredAt };
}

export type StockWaitReport = {
  /** Mốc bắt đầu tính ngày chờ mà mọi con số của lượt này dùng. */
  origin: WaitOrigin;
  report: WaitReport;
  breakpoint: WaitBreakpoint | null;
  daily: DailyWaitingRow[];
  erpSince: Date | null;
  current: CurrentWaitingOrder[];
  pancakeOnlyWaiting: number;
  recommendations: Recommendation[];
  measuredAt: Date;
};

async function getStockWaitReportUncached(period: Period, origin: WaitOrigin, now: Date): Promise<StockWaitReport> {
  const cells = await waitCells(period, origin);
  const report = buildWaitReport(cells, MIN_TIER_SAMPLE);
  const breakpoint = findWaitBreakpoint(report.byWait, MIN_TIER_SAMPLE);

  const toKey = period.toKey ?? todayVN();
  const fromKey = period.fromKey ?? vnDateKey(new Date(now.getTime() - (DAILY_MAX_DAYS - 1) * 86_400_000));
  const days = dayRange(fromKey, toKey > todayVN() ? todayVN() : toKey, DAILY_MAX_DAYS);
  const ivFrom = days.length ? new Date(`${days[0]}T00:00:00+07:00`) : now;
  const ivTo = days.length ? new Date(`${days[days.length - 1]}T23:59:59.999+07:00`) : now;
  const [iv, cur] = await Promise.all([waitIntervals(ivFrom, ivTo), currentWaiting(report, now, origin)]);
  const daily = dailyWaitingSeries(days, iv.erp, iv.pancake, iv.erpSince, now);

  const recommendations = buildRecommendations({
    report,
    breakpoint,
    current: cur.list,
    topShortVariants: cur.topShortVariants,
    erpSince: iv.erpSince,
    pancakeOnlyWaiting: cur.pancakeOnly,
  });
  return { origin, report, breakpoint, daily, erpSince: iv.erpSince, current: cur.list, pancakeOnlyWaiting: cur.pancakeOnly, recommendations, measuredAt: now };
}

/** Đệm 90 giây theo kỳ — cùng nhịp với các báo cáo GTC khác. */
export async function getStockWaitReport(period: Period, opts: { fresh?: boolean; now?: Date; origin?: WaitOrigin } = {}): Promise<StockWaitReport> {
  const now = opts.now ?? new Date();
  const origin = opts.origin ?? DEFAULT_WAIT_ORIGIN;
  if (opts.fresh || opts.now) return getStockWaitReportUncached(period, origin, now);
  // Mốc bắt đầu đổi mọi con số ⇒ phải nằm trong khoá đệm (AGENTS.md mục 2).
  return memo(`getStockWaitReport:${origin}:${period.key}:${period.fromKey ?? ""}:${period.toKey ?? ""}`, 90_000, () => getStockWaitReportUncached(period, origin, now));
}

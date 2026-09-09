import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CRM_RULE, CRM_SEGMENT_ORDER, type CrmSegment } from "@/lib/constants/crm";
import { ORDER_OUTCOME, REPORTABLE_ORDER } from "@/lib/queries/return-rate";

/**
 * ───────────── GIỮ CHÂN KHÁCH ─────────────
 *
 * Câu hỏi: bao nhiêu khách quay lại, quay lại sau bao lâu, và nhóm nào đang nguội đi?
 *
 * MỘT ĐIỀU DUY NHẤT PHẢI NHỚ Ở TRANG NÀY: **khách mua lại đếm trên đơn GIAO THÀNH CÔNG, không
 * phải đơn đã đặt.** Một khách đặt 5 đơn rồi hoàn cả 5 không phải khách trung thành — đó là khách
 * đang gây lỗ (mất cước đi, cước hoàn, và hàng nằm ngoài kho cả tuần). Đếm theo đơn đã đặt là cách
 * nhanh nhất để thổi phồng tỷ lệ mua lại rồi đổ tiền chăm sóc nhầm nhóm.
 *
 * Vì con số "đếm theo đơn đã đặt" đang được dùng ở nhiều nơi (kể cả trang Khách hàng), trang này
 * hiện CẢ HAI và khoảng chênh giữa chúng — để người đọc thấy sai lệch chứ không phải tin lời hứa.
 *
 * Nguồn sự thật kết quả đơn: `ORDER_OUTCOME` (lib/queries/return-rate.ts). Không viết lại điều kiện.
 * Grain: một dòng = một KHÁCH; tiền = doanh thu của đơn giao thành công.
 *
 * Module này CHỈ ĐỌC.
 */

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Tỷ lệ phần trăm một chữ số thập phân. `null` khi mẫu số bằng 0 — CHƯA BIẾT, không phải 0%. */
function rate(part: number, total: number): number | null {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Bảng dẫn xuất "một dòng một đơn, kết quả đơn tính sẵn".
 *
 * `offset 0` là rào tối ưu hoá: không có nó Postgres kéo biểu thức `ORDER_OUTCOME` lên và tính lại
 * cho từng cột gộp (xem ghi chú dài trong `lib/queries/return-rate.ts`).
 */
const ORDER_FACTS = sql`
  select orders.customer_id as customer_id,
         orders.inserted_at as at,
         coalesce(orders.total_price_after_discount, 0) as revenue,
         ${ORDER_OUTCOME} as outcome
  from orders
  left join shipments on shipments.order_id = orders.id
  where ${REPORTABLE_ORDER}
  offset 0
`;

export type CrmSegmentRow = {
  segment: CrmSegment;
  customers: number;
  /** Doanh thu của các đơn GIAO THÀNH CÔNG thuộc nhóm này, cộng dồn từ trước tới nay. */
  revenue: number;
  /** Giá trị trung bình một khách trong nhóm. `null` khi nhóm rỗng. */
  avgValue: number | null;
  share: number | null;
};

export type CohortRow = {
  /** Tháng khách nhận hàng LẦN ĐẦU (YYYY-MM, giờ Việt Nam). */
  cohort: string;
  size: number;
  /**
   * Số khách của cohort có mua lại ở tháng thứ 1..n sau đó. `null` = tháng đó CHƯA TỚI, khác hẳn
   * với 0 = đã tới và không ai quay lại.
   */
  months: (number | null)[];
};

export type AtRiskCustomer = {
  id: string;
  name: string;
  phone: string;
  orders: number;
  revenue: number;
  lastOrderAt: Date | null;
  daysSince: number;
};

export type RetentionReport = {
  /** Khách có ít nhất một đơn GIAO THÀNH CÔNG. Đây là mẫu số của mọi tỷ lệ trên trang. */
  buyers: number;
  repeatBuyers: number;
  repeatRate: number | null;
  /** Cùng công thức nhưng đếm theo ĐƠN ĐÃ ĐẶT — con số quen dùng, và là con số bị thổi phồng. */
  naiveBuyers: number;
  naiveRepeatBuyers: number;
  naiveRepeatRate: number | null;
  /** Chênh lệch giữa hai cách đếm, tính bằng điểm phần trăm. */
  inflationPoints: number | null;
  /** Giá trị trung bình một khách đã nhận hàng (doanh thu giao thành công / số khách). */
  avgCustomerValue: number | null;
  /** Số ngày trung vị giữa lần nhận hàng thứ nhất và thứ hai. `null` khi chưa có khách nào mua lại. */
  medianDaysToSecond: number | null;
  segments: CrmSegmentRow[];
  cohorts: CohortRow[];
  atRisk: AtRiskCustomer[];
  coverage: {
    /** Đơn giao thành công có gán khách / tổng đơn giao thành công. Đây là TRẦN của mọi con số. */
    deliveredOrders: number;
    deliveredWithCustomer: number;
    coveragePercent: number | null;
  };
  limitations: string[];
};

/** Chỉ số tháng giữa hai chuỗi 'YYYY-MM'. */
export function monthIndex(cohort: string, month: string): number {
  const [cy, cm] = cohort.split("-").map(Number);
  const [my, mm] = month.split("-").map(Number);
  return (my - cy) * 12 + (mm - cm);
}

/** Phân khúc một khách theo số đơn ĐÃ NHẬN và khoảng cách tới lần nhận gần nhất. */
export function segmentOf(deliveredOrders: number, daysSinceLast: number): CrmSegment {
  if (daysSinceLast > CRM_RULE.churnedDays) return "CHURNED";
  if (daysSinceLast > CRM_RULE.activeDays) return deliveredOrders >= 2 ? "AT_RISK" : "CHURNED";
  if (deliveredOrders >= CRM_RULE.loyalOrders) return "LOYAL";
  if (deliveredOrders >= 2) return "REPEAT";
  return "NEW";
}

async function retentionUncached(): Promise<RetentionReport> {
  const db = await getDb();

  // ───────── 1. Mỗi khách một dòng, tính trên ĐƠN ĐÃ NHẬN ─────────
  const perCustomer = rowsOf(
    await db.execute(sql`
      with facts as (${ORDER_FACTS})
      select customer_id,
             count(*) as orders_n,
             coalesce(sum(revenue), 0) as revenue,
             min(at) as first_at,
             max(at) as last_at,
             floor(extract(epoch from now() - max(at)) / 86400) as days_since
      from facts
      where outcome = 'DELIVERED' and customer_id is not null
      group by customer_id
    `),
  ).map((r) => ({
    id: text(r.customer_id),
    orders: num(r.orders_n),
    revenue: num(r.revenue),
    daysSince: num(r.days_since),
  }));

  const buyers = perCustomer.length;
  const repeatBuyers = perCustomer.filter((c) => c.orders >= 2).length;
  const revenueTotal = perCustomer.reduce((sum, c) => sum + c.revenue, 0);

  // ───────── 2. Cùng công thức, nhưng đếm theo ĐƠN ĐÃ ĐẶT ─────────
  // Giữ lại có chủ đích: không so được với con số quen dùng thì không ai tin con số đúng.
  const [naive] = rowsOf(
    await db.execute(sql`
      with facts as (${ORDER_FACTS}),
      per_customer as (
        select customer_id, count(*) as orders_n
        from facts
        where customer_id is not null and outcome <> 'CANCELLED'
        group by customer_id
      )
      select count(*) as buyers, count(*) filter (where orders_n >= 2) as repeat_buyers
      from per_customer
    `),
  );

  // ───────── 3. Bao lâu thì khách quay lại (trung vị, chỉ trên khách ĐÃ mua lại) ─────────
  const gaps = rowsOf(
    await db.execute(sql`
      with facts as (${ORDER_FACTS}),
      ranked as (
        select customer_id, at,
               row_number() over (partition by customer_id order by at asc) as rn
        from facts
        where outcome = 'DELIVERED' and customer_id is not null
      )
      select floor(extract(epoch from r2.at - r1.at) / 86400) as gap_days
      from ranked r1
      join ranked r2 on r2.customer_id = r1.customer_id and r2.rn = 2
      where r1.rn = 1
      order by gap_days asc
    `),
  ).map((r) => num(r.gap_days));
  const medianDaysToSecond = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : null;

  // ───────── 4. Cohort theo tháng nhận hàng lần đầu ─────────
  const cohortRows = rowsOf(
    await db.execute(sql`
      with facts as (${ORDER_FACTS}),
      delivered as (
        select customer_id, at from facts where outcome = 'DELIVERED' and customer_id is not null
      ),
      first_buy as (
        select customer_id, to_char(min(at) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') as cohort
        from delivered group by customer_id
      )
      select f.cohort,
             to_char(d.at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') as month,
             count(distinct d.customer_id) as customers
      from delivered d
      join first_buy f on f.customer_id = d.customer_id
      group by f.cohort, month
      order by f.cohort desc, month asc
    `),
  ).map((r) => ({ cohort: text(r.cohort), month: text(r.month), customers: num(r.customers) }));

  const cohortNames = [...new Set(cohortRows.map((r) => r.cohort))].sort().slice(-CRM_RULE.cohortMonths);
  const nowMonth = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).slice(0, 7);
  const cohorts: CohortRow[] = cohortNames.map((cohort) => {
    const rows = cohortRows.filter((r) => r.cohort === cohort);
    const size = rows.find((r) => r.month === cohort)?.customers ?? 0;
    const elapsed = monthIndex(cohort, nowMonth);
    const months: (number | null)[] = [];
    for (let i = 1; i <= CRM_RULE.cohortMonths; i += 1) {
      // Tháng chưa tới là CHƯA BIẾT. Ghi 0 ở đó là vu cho cohort mới một tỷ lệ giữ chân bằng không.
      months.push(i > elapsed ? null : (rows.find((r) => monthIndex(cohort, r.month) === i)?.customers ?? 0));
    }
    return { cohort, size, months };
  });

  // ───────── 5. Phân khúc ─────────
  const bySegment = new Map<CrmSegment, { customers: number; revenue: number }>();
  for (const c of perCustomer) {
    const seg = segmentOf(c.orders, c.daysSince);
    const acc = bySegment.get(seg) ?? { customers: 0, revenue: 0 };
    bySegment.set(seg, { customers: acc.customers + 1, revenue: acc.revenue + c.revenue });
  }
  const segments: CrmSegmentRow[] = CRM_SEGMENT_ORDER.map((segment) => {
    const acc = bySegment.get(segment) ?? { customers: 0, revenue: 0 };
    return {
      segment,
      customers: acc.customers,
      revenue: acc.revenue,
      avgValue: acc.customers ? Math.round(acc.revenue / acc.customers) : null,
      share: rate(acc.customers, buyers),
    };
  });

  // ───────── 6. Khách nguy cơ rời bỏ, xếp theo tiền đã mang lại ─────────
  const atRiskIds = perCustomer
    .filter((c) => segmentOf(c.orders, c.daysSince) === "AT_RISK")
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, CRM_RULE.atRiskListSize);
  const atRisk: AtRiskCustomer[] = [];
  if (atRiskIds.length) {
    const info = rowsOf(
      await db.execute(sql`
        select id, name, coalesce(phone, '') as phone, last_order_at
        from customers
        where id in (${sql.join(atRiskIds.map((c) => sql`${c.id}`), sql`, `)})
      `),
    );
    const byId = new Map(info.map((r) => [text(r.id), r]));
    for (const c of atRiskIds) {
      const row = byId.get(c.id);
      atRisk.push({
        id: c.id,
        name: text(row?.name) || "(không rõ tên)",
        phone: text(row?.phone),
        orders: c.orders,
        revenue: c.revenue,
        lastOrderAt: row?.last_order_at instanceof Date ? row.last_order_at : row?.last_order_at ? new Date(String(row.last_order_at)) : null,
        daysSince: c.daysSince,
      });
    }
  }

  // ───────── 7. Độ phủ: đơn giao thành công có gán khách ─────────
  const [cov] = rowsOf(
    await db.execute(sql`
      with facts as (${ORDER_FACTS})
      select count(*) filter (where outcome = 'DELIVERED') as delivered_all,
             count(*) filter (where outcome = 'DELIVERED' and customer_id is not null) as delivered_linked
      from facts
    `),
  );
  const deliveredOrders = num(cov?.delivered_all);
  const deliveredWithCustomer = num(cov?.delivered_linked);

  const naiveBuyers = num(naive?.buyers);
  const naiveRepeatBuyers = num(naive?.repeat_buyers);
  const repeatRate = rate(repeatBuyers, buyers);
  const naiveRepeatRate = rate(naiveRepeatBuyers, naiveBuyers);

  return {
    buyers,
    repeatBuyers,
    repeatRate,
    naiveBuyers,
    naiveRepeatBuyers,
    naiveRepeatRate,
    inflationPoints: repeatRate !== null && naiveRepeatRate !== null ? Math.round((naiveRepeatRate - repeatRate) * 10) / 10 : null,
    avgCustomerValue: buyers ? Math.round(revenueTotal / buyers) : null,
    medianDaysToSecond,
    segments,
    cohorts,
    atRisk,
    coverage: {
      deliveredOrders,
      deliveredWithCustomer,
      coveragePercent: rate(deliveredWithCustomer, deliveredOrders),
    },
    limitations: [
      "Khách mua lại đếm trên ĐƠN GIAO THÀNH CÔNG. Một khách đặt nhiều đơn rồi hoàn hết KHÔNG phải khách trung thành — con số đếm theo đơn đã đặt luôn cao hơn và luôn sai theo hướng lạc quan.",
      "Đơn giao thành công KHÔNG gán được khách thì nằm ngoài mọi tỷ lệ ở đây — độ phủ gán khách là trần độ tin của cả trang.",
      "Một người mua bằng hai số điện thoại là hai khách trong ERP: tỷ lệ mua lại thật có thể CAO hơn con số này. Gộp trùng khách chưa được làm.",
      "Cột tháng chưa tới của cohort mới để TRỐNG, không phải 0 — cohort tháng này chưa có cơ hội quay lại.",
      "Trang này CHỈ ĐỌC: không tự nhắn khách, không tự tạo việc chăm sóc. Danh sách nguy cơ là đề xuất để người bấm.",
    ],
  };
}

/** Báo cáo giữ chân khách. Nặng nên nhớ tạm 2 phút như các báo cáo khác. */
export async function getRetentionReport(): Promise<RetentionReport> {
  return memo("crm-retention", 120_000, retentionUncached);
}

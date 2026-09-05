import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { RETURN_RULE, type OrderOutcome } from "@/lib/constants/returns";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;
const i = schema.orderItems;
const MAX_FEE = RETURN_RULE.maxFeeForFakeDelivery;

/** Cước ĐVVC của đơn: ưu tiên số trên vận đơn, không có thì lấy phí đối tác Pancake ghi trên đơn */
const FEE = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`;
/** COD của đơn: ưu tiên vận đơn, không có thì lấy COD trên đơn Pancake */
const COD = sql`coalesce(nullif(${s.codAmount}, 0), ${o.cod}, 0)`;

const MAX_COD = RETURN_RULE.maxCodForFakeDelivery;
/** Khách đã trả trước (chuyển khoản / ví) — đơn COD 0 nhưng giao thật */
const PREPAID = sql`(coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0))`;

/**
 * Quy tắc 1: vận đơn "giao thành công" chỉ là giao thật khi COD thu > 100K (hoặc khách đã chuyển khoản trước > 100K).
 * COD ≤ 100K (khách không nhận, chỉ trả tiền ship / phí xem hàng) → hoàn. Giữ thêm nhánh cũ: COD = 0 và cước < 10K.
 */
const FEE_RULE = sql`(${s.stage} = 'DELIVERED' and ${PREPAID} <= ${MAX_COD} and (${COD} <= ${MAX_COD} or (${COD} = 0 and ${FEE} > 0 and ${FEE} < ${MAX_FEE})))`;

/**
 * Quy tắc 2: tồn tại một vận đơn Viettel Post khác (vận đơn hoàn / thu tiền ship, ví dụ PKE…1P1)
 * tham chiếu tới vận đơn gốc, ở trạng thái giao thành công, COD = 0, cước < 10K.
 */
const LEG_RULE = sql`(${s.vtpOrderNumber} is not null and exists (
  select 1 from shipments rl
  where rl.id <> ${s.id}
    and rl.stage = 'DELIVERED' and rl.cod_amount = 0 and rl.shipping_fee > 0 and rl.shipping_fee < ${MAX_FEE}
    and (rl.order_reference = ${s.vtpOrderNumber} or rl.vtp_order_number ~ ('^' || ${s.vtpOrderNumber} || '[0-9]?P[0-9]+$'))
))`;

/**
 * Kết quả cuối cùng của một đơn — dùng chung cho MỌI báo cáo (tổng quan, lợi nhuận, tỷ lệ hoàn, lương, COD).
 * Ưu tiên trạng thái VẬN ĐƠN Viettel Post (đầu cuối giao hàng) trước trạng thái đơn Pancake:
 *  1. vận đơn đang hoàn / đã hoàn → hoàn; vận đơn đã giao → giao thành công (trừ quy tắc phát hiện hoàn: COD = 0 & cước nhỏ, vận đơn chiều về);
 *  2. vận đơn đang đi (lấy hàng, đang giao, giao thất bại chờ phát lại) → đang giao;
 *  3. chưa có trạng thái vận đơn mới xét theo Pancake: huỷ / hoàn / đã giao / đã gửi / chưa gửi.
 * Yêu cầu FROM orders LEFT JOIN shipments.
 */
export const ORDER_OUTCOME = sql<OrderOutcome>`case
  when ${s.stage} in ('RETURNING','RETURNED') then 'RETURNED'
  when ${s.stage} = 'DELIVERED' and (${FEE_RULE} or ${LEG_RULE}) then 'RETURNED_BY_RULE'
  when ${s.stage} = 'DELIVERED' then 'DELIVERED'
  when ${s.stage} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED') and ${o.stage} not in ('CANCELLED','DELETED') then 'IN_TRANSIT'
  when ${o.stage} in ('CANCELLED','DELETED') then 'CANCELLED'
  when ${o.stage} in ('RETURNING','PARTIAL_RETURN','RETURNED') then 'RETURNED'
  when ${o.stage} in ('DELIVERED','PAID') then 'DELIVERED'
  when ${o.stage} = 'SHIPPED' then 'IN_TRANSIT'
  else 'NOT_SHIPPED' end`;

const IS_RETURNED = sql`${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')`;
/** Giao thất bại, đang chờ phát lại (chưa kết thúc nhưng khả năng hoàn cao) */
const IS_FAILED = sql`${ORDER_OUTCOME} = 'IN_TRANSIT' and ${s.stage} = 'DELIVERY_FAILED'`;
const IS_PENDING = sql`${ORDER_OUTCOME} = 'NOT_SHIPPED'`;
const IS_SHIPPED = sql`${ORDER_OUTCOME} in ('IN_TRANSIT','DELIVERED','RETURNED','RETURNED_BY_RULE')`;

/** Khoá gộp theo mẫu mã: id mẫu mã Pancake, hoặc SKU + tên nếu mẫu mã chưa có trong ERP */
const VARIANT_KEY = sql<string>`coalesce(${i.variantId}, 'sku:' || ${i.sku} || '|' || ${i.productName} || '|' || ${i.variationDetail})`;

export type ReturnRateQuery = {
  period: Period;
  q: string;
  minShipped: number;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type ReturnRateRow = {
  key: string;
  variantId: string | null;
  sku: string;
  productName: string;
  variationDetail: string;
  image: string | null;
  shipped: number;
  delivered: number;
  returned: number;
  returnedByRule: number;
  inTransit: number;
  /** Đang chờ phát lại (giao thất bại chưa kết thúc) */
  failed: number;
  /** Tỷ lệ hoàn dự kiến (%) = (hoàn + chờ phát lại × xác suất thành hoàn) ÷ (giao thật + hoàn + chờ phát lại) */
  expectedRate: number | null;
  cancelled: number;
  returnedQty: number;
  lostRevenue: number;
  deliveredRevenue: number;
  /** % hoàn trên các đơn đã có kết quả (giao thật + hoàn); null nếu chưa có đơn nào kết thúc */
  rate: number | null;
};

export const RETURN_RATE_SORTABLE = ["rate", "expectedRate", "returned", "delivered", "shipped", "inTransit", "failed", "lostRevenue", "sku"];

function baseWhere(period: Period, q: string): SQL | undefined {
  const conds: SQL[] = [eq(i.isBonus, false)];
  if (period.from) conds.push(gte(o.insertedAt, period.from));
  if (period.to) conds.push(lte(o.insertedAt, period.to));
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(${i.sku} ilike ${like} or ${i.productName} ilike ${like} or ${i.variationDetail} ilike ${like})`);
  }
  return and(...conds);
}

/** Tỷ lệ hoàn theo từng mẫu mã (SKU) — gộp theo đơn, một đơn có N mẫu mã được tính cho cả N mẫu mã. */
export async function getReturnRateByVariant(query: ReturnRateQuery): Promise<{ rows: ReturnRateRow[]; total: number; pageCount: number; all: ReturnRateRow[] }> {
  const db = await getDb();
  const raw = await db
    .select({
      key: VARIANT_KEY,
      variantId: sql<string | null>`max(${i.variantId})`,
      sku: sql<string>`max(${i.sku})`,
      productName: sql<string>`max(${i.productName})`,
      variationDetail: sql<string>`max(${i.variationDetail})`,
      image: sql<string | null>`max(${i.image})`,
      shipped: sql<number>`count(distinct ${o.id}) filter (where ${IS_SHIPPED})`,
      delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
      returnedByRule: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'RETURNED_BY_RULE')`,
      inTransit: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      failed: sql<number>`count(distinct ${o.id}) filter (where ${IS_FAILED})`,
      cancelled: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
      returnedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${IS_RETURNED}), 0)`,
      lostRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${IS_RETURNED}), 0)`,
      deliveredRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .where(baseWhere(query.period, query.q))
    .groupBy(VARIANT_KEY);

  const p = await failedToReturnRate();
  const all: ReturnRateRow[] = raw
    .map((r) => {
      const delivered = Number(r.delivered);
      const returned = Number(r.returned);
      const finished = delivered + returned;
      return {
        key: r.key,
        variantId: r.variantId,
        sku: r.sku ?? "",
        productName: r.productName ?? "",
        variationDetail: r.variationDetail ?? "",
        image: r.image,
        shipped: Number(r.shipped),
        delivered,
        returned,
        returnedByRule: Number(r.returnedByRule),
        inTransit: Number(r.inTransit),
        failed: Number(r.failed),
        expectedRate: delivered + returned + Number(r.failed) ? ((returned + Number(r.failed) * p.rate) / (delivered + returned + Number(r.failed))) * 100 : null,
        cancelled: Number(r.cancelled),
        returnedQty: Number(r.returnedQty),
        lostRevenue: Number(r.lostRevenue),
        deliveredRevenue: Number(r.deliveredRevenue),
        rate: finished ? (returned / finished) * 100 : null,
      };
    })
    .filter((r) => r.shipped >= query.minShipped);

  const sortKey = RETURN_RATE_SORTABLE.includes(query.sort) ? query.sort : "rate";
  const sign = query.dir === "asc" ? 1 : -1;
  all.sort((a, b) => {
    if (sortKey === "sku") return sign * (a.sku || a.productName).localeCompare(b.sku || b.productName, "vi");
    const av = a[sortKey as keyof ReturnRateRow] as number | null;
    const bv = b[sortKey as keyof ReturnRateRow] as number | null;
    if (av === null && bv === null) return b.shipped - a.shipped;
    if (av === null) return 1; // chưa có kết quả xếp cuối
    if (bv === null) return -1;
    return sign * (av - bv) || b.returned - a.returned || b.shipped - a.shipped;
  });

  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const start = (query.page - 1) * query.pageSize;
  return { rows: all.slice(start, start + query.pageSize), total, pageCount, all };
}

export type ReturnRateSummary = {
  orders: number;
  shipped: number;
  delivered: number;
  returned: number;
  returnedByRule: number;
  inTransit: number;
  /** Chờ phát lại (giao thất bại chưa kết thúc) */
  failed: number;
  /** Chờ xử lý, chưa gửi ĐVVC (không tính vào tỷ lệ) */
  pending: number;
  cancelled: number;
  lostRevenue: number;
  rate: number | null;
  /** Tỷ lệ hoàn dự kiến khi các đơn chờ phát lại kết thúc (theo xác suất lịch sử) */
  expectedRate: number | null;
  /** Xác suất đơn giao thất bại → hoàn, học từ lịch sử (%) và cỡ mẫu */
  failedToReturnPct: number;
  failedSample: number;
};

/** Xác suất một vận đơn đã từng giao thất bại cuối cùng thành hoàn (180 ngày gần nhất); dưới 15 mẫu dùng 60% */
export async function failedToReturnRate(): Promise<{ rate: number; sample: number }> {
  return memo("failedToReturnRate", 300_000, async () => {
    const db = await getDb();
    const [row] = await db
      .select({
        returned: sql<number>`count(*) filter (where sh.stage = 'RETURNED')`,
        delivered: sql<number>`count(*) filter (where sh.stage = 'DELIVERED')`,
      })
      .from(sql`(select distinct e.shipment_id from shipment_events e where e.occurred_at >= now() - interval '180 days' and (e.status in ('505','506','507','510') or e.status_name ilike '%thất bại%' or e.status_name ilike '%hẹn%' or e.status_name ilike '%không liên lạc%')) f`)
      .innerJoin(sql`shipments sh`, sql`sh.id = f.shipment_id`);
    const returned = Number(row?.returned ?? 0);
    const delivered = Number(row?.delivered ?? 0);
    const sample = returned + delivered;
    return { rate: sample >= 15 ? returned / sample : 0.6, sample };
  });
}

/** Tổng hợp ở cấp đơn (mỗi đơn tính một lần) với cùng bộ lọc kỳ / tìm kiếm */
export async function getReturnRateSummary(period: Period, q: string): Promise<ReturnRateSummary> {
  const db = await getDb();
  const conds: SQL[] = [];
  if (period.from) conds.push(gte(o.insertedAt, period.from));
  if (period.to) conds.push(lte(o.insertedAt, period.to));
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`exists (select 1 from order_items oi where oi.order_id = ${o.id} and oi.is_bonus = false and (oi.sku ilike ${like} or oi.product_name ilike ${like} or oi.variation_detail ilike ${like}))`);
  }
  const [row] = await db
    .select({
      orders: sql<number>`count(*)`,
      shipped: sql<number>`count(*) filter (where ${IS_SHIPPED})`,
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${IS_RETURNED})`,
      returnedByRule: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'RETURNED_BY_RULE')`,
      inTransit: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      failed: sql<number>`count(*) filter (where ${IS_FAILED})`,
      pending: sql<number>`count(*) filter (where ${IS_PENDING})`,
      cancelled: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
      lostRevenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${IS_RETURNED}), 0)`,
    })
    .from(o)
    .leftJoin(s, eq(s.orderId, o.id))
    .where(conds.length ? and(...conds) : undefined);
  const delivered = Number(row?.delivered ?? 0);
  const returned = Number(row?.returned ?? 0);
  const failed = Number(row?.failed ?? 0);
  const p = await failedToReturnRate();
  return {
    orders: Number(row?.orders ?? 0),
    shipped: Number(row?.shipped ?? 0),
    delivered,
    returned,
    returnedByRule: Number(row?.returnedByRule ?? 0),
    inTransit: Number(row?.inTransit ?? 0),
    failed,
    pending: Number(row?.pending ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    lostRevenue: Number(row?.lostRevenue ?? 0),
    rate: delivered + returned ? (returned / (delivered + returned)) * 100 : null,
    expectedRate: delivered + returned + failed ? ((returned + failed * p.rate) / (delivered + returned + failed)) * 100 : null,
    failedToReturnPct: Math.round(p.rate * 100),
    failedSample: p.sample,
  };
}

export type VariantOrderRow = {
  id: string;
  systemId: number | null;
  insertedAt: Date;
  stage: (typeof schema.orders.$inferSelect)["stage"];
  outcome: OrderOutcome;
  billFullName: string;
  billPhone: string;
  shipProvince: string;
  quantity: number;
  lineTotal: number;
  cod: number;
  fee: number;
  vtpOrderNumber: string | null;
  shipmentStage: (typeof schema.shipments.$inferSelect)["stage"] | null;
  returnedReason: string | null;
};

/** Danh sách đơn của một mẫu mã trong kỳ kèm kết quả, để đối chiếu (tối đa 300 đơn, hoàn xếp trước) */
export async function listOrdersForVariant(key: string, period: Period): Promise<VariantOrderRow[]> {
  const db = await getDb();
  const conds: SQL[] = [eq(VARIANT_KEY, key), eq(i.isBonus, false)];
  if (period.from) conds.push(gte(o.insertedAt, period.from));
  if (period.to) conds.push(lte(o.insertedAt, period.to));
  const rows = await db
    .select({
      id: o.id,
      systemId: o.systemId,
      insertedAt: o.insertedAt,
      stage: o.stage,
      outcome: ORDER_OUTCOME,
      billFullName: o.billFullName,
      billPhone: o.billPhone,
      shipProvince: o.shipProvince,
      quantity: sql<number>`sum(${i.quantity})`,
      lineTotal: sql<number>`sum(${i.lineTotal})`,
      cod: sql<number>`${COD}`,
      fee: sql<number>`${FEE}`,
      vtpOrderNumber: s.vtpOrderNumber,
      shipmentStage: s.stage,
      returnedReason: o.returnedReason,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .where(and(...conds))
    .groupBy(o.id, s.id)
    .orderBy(sql`case when ${IS_RETURNED} then 0 when ${ORDER_OUTCOME} = 'DELIVERED' then 2 else 1 end`, desc(o.insertedAt))
    .limit(300);
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity), lineTotal: Number(r.lineTotal), cod: Number(r.cod), fee: Number(r.fee) }));
}

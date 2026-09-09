import { and, count, desc, eq, gte, inArray, lte, sql, sum, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { lineUnitCost, orderCogsColumn } from "@/lib/queries/cogs";
import { OUTCOME_FENCE, ORDER_OUTCOME, outcomeColumn } from "@/lib/queries/return-rate";
import { variantLastCostSubquery } from "@/lib/queries/stock";
import { previousPeriod, type Period } from "@/lib/search-params";
import { allocatedExpenseByDay, allocatedExpenseSum, expenseInRange } from "@/lib/queries/cost-allocation";

export type ReportBasis = "created" | "delivered";

export const REPORT_BASIS_LABEL: Record<ReportBasis, string> = {
  created: "Theo ngày lên đơn",
  delivered: "Theo ngày giao thành công",
};

export function parseBasis(value: string | undefined): ReportBasis {
  return value === "delivered" ? "delivered" : "created";
}

/** Cột ngày dùng để gán đơn vào kỳ báo cáo */
function basisDate(basis: ReportBasis): SQL {
  return basis === "delivered" ? sql`coalesce(${schema.shipments.deliveredAt}, ${schema.orders.insertedAt})` : sql`${schema.orders.insertedAt}`;
}

function between(column: SQL | AnyPgColumn, from: Date | null, to: Date | null): SQL | undefined {
  const conds: SQL[] = [];
  if (from) conds.push(sql`${column} >= ${from.toISOString()}::timestamptz`);
  if (to) conds.push(sql`${column} <= ${to.toISOString()}::timestamptz`);
  return conds.length ? and(...conds) : undefined;
}

// Kết quả đơn theo trạng thái VẬN ĐƠN (Viettel Post: webhook / tra cứu / nhập danh sách vận đơn) kết hợp trạng thái Pancake — xem ORDER_OUTCOME.
// Các vị ngữ còn lại (đơn không huỷ / đã gửi / hoàn / huỷ) nay đọc trên BẢNG DẪN XUẤT `orderFacts`
// để `ORDER_OUTCOME` chỉ phải tính một lần cho mỗi đơn — xem `facts()` bên dưới.
const SUCCESS = sql`${ORDER_OUTCOME} = 'DELIVERED'`;

/**
 * BẢNG DẪN XUẤT CẤP ĐƠN — `ORDER_OUTCOME` và `ORDER_COGS` tính ĐÚNG MỘT LẦN cho mỗi đơn.
 *
 * Cả hai đều là biểu thức chứa truy vấn con tương quan, và Postgres nội tuyến lại chúng vào TỪNG
 * cột `filter (where …)`. Báo cáo lợi nhuận có 11 cột như vậy ⇒ mỗi đơn bị tính kết quả 8 lần và
 * tính giá vốn 3 lần. Gói vào bảng dẫn xuất (kèm rào `OUTCOME_FENCE`) thì mỗi đơn tính đúng một lần.
 * Đây là đổi hình dạng truy vấn, không đổi công thức — khoá bằng tests/metric-shape-consistency.test.ts.
 */
function orderFacts(db: Awaited<ReturnType<typeof getDb>>, basis: ReportBasis, from: Date | null, to: Date | null) {
  return db
    .select({
      orderId: schema.orders.id,
      orderStage: schema.orders.stage,
      source: schema.orders.source,
      sellerName: schema.orders.sellerName,
      day: sql<string>`to_char(${basisDate(basis)} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`.as("day"),
      revenue: schema.orders.totalPriceAfterDiscount,
      partnerFee: schema.orders.partnerFee,
      returnFee: schema.orders.returnFee,
      feeMarketplace: schema.orders.feeMarketplace,
      prepaidTotal: sql<number>`(${schema.orders.prepaid} + ${schema.orders.transferMoney} + ${schema.orders.cash})`.as("prepaid_total"),
      cogs: orderCogsColumn(),
      outcome: outcomeColumn(),
    })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(between(basisDate(basis), from, to))
    .offset(OUTCOME_FENCE)
    .as("order_facts");
}

/** Vị ngữ kết quả đơn đọc trên BẢNG DẪN XUẤT (cột đã tính sẵn), không tính lại. */
function facts(base: ReturnType<typeof orderFacts>) {
  return {
    success: sql`${base.outcome} = 'DELIVERED'`,
    notCancelled: sql`${base.orderStage} not in ('CANCELLED','DELETED')`,
    shipped: sql`${base.outcome} in ('IN_TRANSIT','DELIVERED','RETURNED','RETURNED_BY_RULE')`,
    returned: sql`${base.outcome} in ('RETURNED','RETURNED_BY_RULE')`,
    cancelled: sql`${base.orderStage} in ('CANCELLED','DELETED')`,
  };
}

export type PnlLines = {
  orders: number;
  successOrders: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  shipping: number;
  returnFee: number;
  marketplaceFee: number;
  adSpend: number;
  operating: number;
  netProfit: number;
  margin: number;
  prepaid: number;
  returned: number;
  cancelled: number;
  lostShipping: number;
  adOrders: number;
  adRevenue: number;
};

async function pnl(from: Date | null, to: Date | null, basis: ReportBasis): Promise<PnlLines> {
  const db = await getDb();
  const base = orderFacts(db, basis, from, to);
  const f = facts(base);
  // Ba truy vấn độc lập (đơn · chi tiêu QC · chi phí vận hành) — chạy song song, không đứng chờ nhau.
  const [[o], [ads], expenseRows] = await Promise.all([
    db
    .select({
      orders: sql<number>`count(*) filter (where ${f.notCancelled})`,
      successOrders: sql<number>`count(*) filter (where ${f.success})`,
      revenue: sql<number>`coalesce(sum(${base.revenue}) filter (where ${f.success}), 0)`,
      cogs: sql<number>`coalesce(sum(${base.cogs}) filter (where ${f.success}), 0)`,
      shipping: sql<number>`coalesce(sum(${base.partnerFee}) filter (where ${f.shipped}), 0)`,
      returnFee: sql<number>`coalesce(sum(${base.returnFee}) filter (where ${f.notCancelled}), 0)`,
      marketplaceFee: sql<number>`coalesce(sum(${base.feeMarketplace}) filter (where ${f.notCancelled}), 0)`,
      prepaid: sql<number>`coalesce(sum(${base.prepaidTotal}) filter (where ${f.success}), 0)`,
      returned: sql<number>`count(*) filter (where ${f.returned})`,
      cancelled: sql<number>`count(*) filter (where ${f.cancelled})`,
      lostShipping: sql<number>`coalesce(sum(${base.partnerFee} + ${base.returnFee}) filter (where ${f.returned}), 0)`,
    })
    .from(base),
    db
      .select({ spend: sum(schema.adSpends.spend), orders: sum(schema.adSpends.orders), revenue: sum(schema.adSpends.revenue) })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), between(schema.adSpends.spendDate, from, to))),
    db
      // Khoản theo kỳ (thuê mặt bằng, phần mềm) chia theo số ngày chồng lấn, không cộng nguyên khoản.
      .select({ category: schema.expenses.category, amount: allocatedExpenseSum(from, to) })
      .from(schema.expenses)
      .where(expenseInRange(from, to))
      .groupBy(schema.expenses.category),
  ]);

  const adsExpense = expenseRows.filter((r) => r.category === "ADS").reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const operating = expenseRows.filter((r) => r.category !== "ADS" && r.category !== "PURCHASE").reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const revenue = Number(o?.revenue ?? 0);
  const cogs = Number(o?.cogs ?? 0);
  const shipping = Number(o?.shipping ?? 0);
  const returnFee = Number(o?.returnFee ?? 0);
  const marketplaceFee = Number(o?.marketplaceFee ?? 0);
  const adSpend = Number(ads?.spend ?? 0) + adsExpense;
  const grossProfit = revenue - cogs;
  const netProfit = grossProfit - shipping - returnFee - marketplaceFee - adSpend - operating;
  return {
    orders: Number(o?.orders ?? 0),
    successOrders: Number(o?.successOrders ?? 0),
    revenue,
    cogs,
    grossProfit,
    shipping,
    returnFee,
    marketplaceFee,
    adSpend,
    operating,
    netProfit,
    margin: revenue ? (netProfit / revenue) * 100 : 0,
    prepaid: Number(o?.prepaid ?? 0),
    returned: Number(o?.returned ?? 0),
    cancelled: Number(o?.cancelled ?? 0),
    lostShipping: Number(o?.lostShipping ?? 0),
    adOrders: Number(ads?.orders ?? 0),
    adRevenue: Number(ads?.revenue ?? 0),
  };
}

export type DailyRow = {
  day: string;
  orders: number;
  success: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  shipping: number;
  returnFee: number;
  marketplaceFee: number;
  adSpend: number;
  operating: number;
  netProfit: number;
};

/** Doanh thu, chi phí và lợi nhuận theo ngày (giờ VN) */
export async function getDailyBreakdown(period: Period, basis: ReportBasis): Promise<DailyRow[]> {
  const db = await getDb();
  const dayOf = (col: SQL | AnyPgColumn) => sql<string>`to_char(${col} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
  const base = orderFacts(db, basis, period.from, period.to);
  const f = facts(base);
  const [orderRows, adRows, expenseRows] = await Promise.all([
    db
      .select({
        day: base.day,
        orders: sql<number>`count(*) filter (where ${f.notCancelled})`,
        success: sql<number>`count(*) filter (where ${f.success})`,
        revenue: sql<number>`coalesce(sum(${base.revenue}) filter (where ${f.success}), 0)`,
        cogs: sql<number>`coalesce(sum(${base.cogs}) filter (where ${f.success}), 0)`,
        shipping: sql<number>`coalesce(sum(${base.partnerFee}) filter (where ${f.shipped}), 0)`,
        returnFee: sql<number>`coalesce(sum(${base.returnFee}) filter (where ${f.notCancelled}), 0)`,
        marketplaceFee: sql<number>`coalesce(sum(${base.feeMarketplace}) filter (where ${f.notCancelled}), 0)`,
      })
      .from(base)
      .groupBy(base.day)
      .orderBy(base.day),
    db
      .select({ day: dayOf(schema.adSpends.spendDate), spend: sum(schema.adSpends.spend) })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), between(schema.adSpends.spendDate, period.from, period.to)))
      .groupBy(sql`1`),
    // Chi phí RẢI ĐỀU theo ngày trong kỳ hiệu lực. Gộp theo `occurred_at` thì tiền thuê cả tháng
    // dựng thành một cột duy nhất ở ngày ghi sổ và mọi ngày khác chi phí bằng 0 — nhìn biểu đồ đó
    // sẽ kết luận "ngày 01 lỗ nặng, các ngày sau lãi đều", cả hai đều sai.
    allocatedExpenseByDay(db, period.from, period.to),
  ]);

  const map = new Map<string, DailyRow>();
  const get = (day: string) => {
    let row = map.get(day);
    if (!row) {
      row = { day, orders: 0, success: 0, revenue: 0, cogs: 0, grossProfit: 0, shipping: 0, returnFee: 0, marketplaceFee: 0, adSpend: 0, operating: 0, netProfit: 0 };
      map.set(day, row);
    }
    return row;
  };
  for (const r of orderRows) {
    const row = get(r.day);
    row.orders += Number(r.orders);
    row.success += Number(r.success);
    row.revenue += Number(r.revenue);
    row.cogs += Number(r.cogs);
    row.shipping += Number(r.shipping);
    row.returnFee += Number(r.returnFee);
    row.marketplaceFee += Number(r.marketplaceFee);
  }
  for (const r of adRows) get(r.day).adSpend += Number(r.spend ?? 0);
  for (const [day, amounts] of expenseRows) {
    const row = get(day);
    row.adSpend += amounts.ads;
    row.operating += amounts.other;
  }
  const rows = [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const row of rows) {
    row.grossProfit = row.revenue - row.cogs;
    row.netProfit = row.grossProfit - row.shipping - row.returnFee - row.marketplaceFee - row.adSpend - row.operating;
  }
  return rows;
}

/**
 * Báo cáo lợi nhuận — 17 truy vấn cho mỗi lần dựng trang, trong đó có các truy vấn quét
 * `orders ⋈ shipments` kèm ORDER_OUTCOME. Đệm 60 giây như Tổng quan: đủ để đổi tab / bấm qua lại
 * không phải tính lại, và mọi thao tác ghi hay job đồng bộ đều gọi `clearMemo()` nên số liệu
 * không thể cũ hơn sự kiện nghiệp vụ gần nhất.
 */
export async function getProfitReport(period: Period, basis: ReportBasis) {
  return memo(`getProfitReport:${periodKey(period)}:${basis}`, 60_000, () => getProfitReportUncached(period, basis));
}

async function getProfitReportUncached(period: Period, basis: ReportBasis) {
  const db = await getDb();
  const dateCol = basisDate(basis);
  const inPeriod = between(dateCol, period.from, period.to);
  const prev = previousPeriod(period);

  const base = orderFacts(db, basis, period.from, period.to);
  const f = facts(base);
  // Giá nhập gần nhất tính một lần cho mỗi mẫu mã thay vì một lần cho mỗi dòng đơn.
  const lastCost = variantLastCostSubquery(db);
  const unitCost = lineUnitCost(lastCost);
  const groupSelect = {
    orders: sql<number>`count(*) filter (where ${f.notCancelled})`,
    success: sql<number>`count(*) filter (where ${f.success})`,
    revenue: sql<number>`coalesce(sum(${base.revenue}) filter (where ${f.success}), 0)`,
    cogs: sql<number>`coalesce(sum(${base.cogs}) filter (where ${f.success}), 0)`,
  };
  const groupOrder = desc(sql`coalesce(sum(${base.revenue}) filter (where ${f.success}), 0)`);

  const [current, previous, channels, sellers, products, daily, codPaid, codWaiting, batchesInPeriod, batchesToDate, linkedPaidToDate] = await Promise.all([
    pnl(period.from, period.to, basis),
    prev.from ? pnl(prev.from, prev.to, basis) : Promise.resolve(null),
    db.select({ key: base.source, ...groupSelect }).from(base).groupBy(base.source).orderBy(groupOrder),
    db.select({ key: base.sellerName, ...groupSelect }).from(base).groupBy(base.sellerName).orderBy(groupOrder).limit(20),
    db
      .select({
        productName: schema.orderItems.productName,
        skus: sql<number>`count(distinct ${schema.orderItems.sku})`,
        orders: sql<number>`count(distinct ${schema.orders.id})`,
        quantity: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)`,
        revenue: sql<number>`coalesce(sum(${schema.orderItems.lineTotal}), 0)`,
        cogs: sql<number>`coalesce(sum(${unitCost} * ${schema.orderItems.quantity}), 0)`,
        image: sql<string | null>`max(${schema.orderItems.image})`,
      })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderItems.variantId))
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .leftJoin(lastCost, eq(lastCost.variantId, schema.productVariants.id))
      .where(and(inPeriod, SUCCESS))
      .groupBy(schema.orderItems.productName)
      .orderBy(desc(sql`coalesce(sum(${schema.orderItems.lineTotal}), 0) - coalesce(sum(${unitCost} * ${schema.orderItems.quantity}), 0)`))
      .limit(15),
    getDailyBreakdown(period, basis),
    db
      .select({ amount: sum(schema.shipments.codCollected), count: count() })
      .from(schema.shipments)
      .where(and(eq(schema.shipments.codStatus, "PAID_TO_BANK"), between(schema.shipments.codPaidToBankAt, period.from, period.to))),
    db
      .select({ amount: sum(schema.shipments.codAmount), count: count() })
      .from(schema.shipments)
      .where(inArray(schema.shipments.codStatus, ["COLLECTED", "RECONCILED"])),
    // Bảng kê tiền COD Viettel Post (đợt nhận tiền) trong kỳ — nguồn "tiền đã về" kể cả khi chưa gắn từng vận đơn
    db
      .select({ count: count(), gross: sql<number>`coalesce(sum(coalesce(nullif(${schema.codBatches.codGross}, 0), ${schema.codBatches.totalAmount})), 0)`, fee: sql<number>`coalesce(sum(${schema.codBatches.feeTotal}), 0)`, net: sql<number>`coalesce(sum(${schema.codBatches.totalAmount}), 0)` })
      .from(schema.codBatches)
      .where(and(period.from ? gte(schema.codBatches.receivedAt, period.from) : undefined, period.to ? lte(schema.codBatches.receivedAt, period.to) : undefined)),
    // Toàn bộ bảng kê đến cuối kỳ (để trừ khỏi phần "đã thu, chờ về")
    db
      .select({ gross: sql<number>`coalesce(sum(coalesce(nullif(${schema.codBatches.codGross}, 0), ${schema.codBatches.totalAmount})), 0)` })
      .from(schema.codBatches)
      .where(period.to ? lte(schema.codBatches.receivedAt, period.to) : undefined),
    // Vận đơn đã gắn vào bảng kê (đã đánh dấu về ngân hàng) đến cuối kỳ — tránh trừ hai lần
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.shipments.codCollected}), 0)` })
      .from(schema.shipments)
      .where(and(eq(schema.shipments.codStatus, "PAID_TO_BANK"), period.to ? lte(schema.shipments.codPaidToBankAt, period.to) : undefined)),
  ]);

  const toGroup = (r: { key: string; orders: number; success: number; revenue: number; cogs: number }) => {
    const revenue = Number(r.revenue);
    const cogs = Number(r.cogs);
    return { key: r.key, orders: Number(r.orders), success: Number(r.success), revenue, cogs, grossProfit: revenue - cogs };
  };

  return {
    period,
    basis,
    current,
    previous,
    channels: channels.map(toGroup).filter((c) => c.orders > 0 || c.success > 0),
    sellers: sellers.map((r) => toGroup({ ...r, key: r.key || "Chưa gán" })).filter((c) => c.orders > 0 || c.success > 0),
    products: products.map((p) => {
      const revenue = Number(p.revenue);
      const cogs = Number(p.cogs);
      return { productName: p.productName, skus: Number(p.skus), orders: Number(p.orders), quantity: Number(p.quantity), revenue, cogs, profit: revenue - cogs, margin: revenue ? ((revenue - cogs) / revenue) * 100 : 0, image: p.image };
    }),
    daily,
    cash: (() => {
      const shipPaid = Number(codPaid[0]?.amount ?? 0);
      const b = { count: Number(batchesInPeriod[0]?.count ?? 0), gross: Number(batchesInPeriod[0]?.gross ?? 0), fee: Number(batchesInPeriod[0]?.fee ?? 0), net: Number(batchesInPeriod[0]?.net ?? 0) };
      // bảng kê chưa gắn được vào vận đơn nào: tổng bảng kê đến cuối kỳ − phần đã gắn
      const unlinkedToDate = Math.max(0, Number(batchesToDate[0]?.gross ?? 0) - Number(linkedPaidToDate[0]?.amount ?? 0));
      const collected = Number(codWaiting[0]?.amount ?? 0);
      return {
        /** Tiền COD đã về trong kỳ: theo bảng kê Viettel Post (COD gộp) nếu có, nếu không theo vận đơn đã đánh dấu về ngân hàng */
        codPaid: { amount: Math.max(shipPaid, b.gross), count: Number(codPaid[0]?.count ?? 0), batches: b, source: b.gross > shipPaid ? ("statements" as const) : ("shipments" as const) },
        /** Đã thu chờ về = COD các vận đơn đã thu / đã đối soát − phần bảng kê đã về nhưng chưa gắn vận đơn */
        codWaiting: { amount: Math.max(0, collected - unlinkedToDate), count: Number(codWaiting[0]?.count ?? 0), collected, deductedByStatements: Math.min(collected, unlinkedToDate) },
        prepaid: current.prepaid,
        /** Tiền thực về trong kỳ = COD thực nhận (sau cước theo bảng kê) + trả trước */
        cashIn: (b.gross > shipPaid ? b.net : shipPaid) + current.prepaid,
      };
    })(),
  };
}

export type ProfitReport = Awaited<ReturnType<typeof getProfitReport>>;

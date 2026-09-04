import { and, count, desc, eq, inArray, sql, sum, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { SUCCESS_STAGES } from "@/lib/constants/pancake";
import { previousPeriod, type Period } from "@/lib/search-params";

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

const SUCCESS = sql`${schema.orders.stage} in ('DELIVERED','PAID')`;
const NOT_CANCELLED = sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`;
const SHIPPED = sql`${schema.orders.stage} in ('SHIPPED','DELIVERED','PAID','RETURNING','PARTIAL_RETURN','RETURNED')`;
const RETURNED = sql`${schema.orders.stage} in ('RETURNING','PARTIAL_RETURN','RETURNED')`;
const CANCELLED = sql`${schema.orders.stage} in ('CANCELLED','DELETED')`;

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
  const dateCol = basisDate(basis);
  const [o] = await db
    .select({
      orders: sql<number>`count(*) filter (where ${NOT_CANCELLED})`,
      successOrders: sql<number>`count(*) filter (where ${SUCCESS})`,
      revenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${SUCCESS}), 0)`,
      cogs: sql<number>`coalesce(sum(${schema.orders.cogs}) filter (where ${SUCCESS}), 0)`,
      shipping: sql<number>`coalesce(sum(${schema.orders.partnerFee}) filter (where ${SHIPPED}), 0)`,
      returnFee: sql<number>`coalesce(sum(${schema.orders.returnFee}) filter (where ${NOT_CANCELLED}), 0)`,
      marketplaceFee: sql<number>`coalesce(sum(${schema.orders.feeMarketplace}) filter (where ${NOT_CANCELLED}), 0)`,
      prepaid: sql<number>`coalesce(sum(${schema.orders.prepaid} + ${schema.orders.transferMoney} + ${schema.orders.cash}) filter (where ${SUCCESS}), 0)`,
      returned: sql<number>`count(*) filter (where ${RETURNED})`,
      cancelled: sql<number>`count(*) filter (where ${CANCELLED})`,
      lostShipping: sql<number>`coalesce(sum(${schema.orders.partnerFee} + ${schema.orders.returnFee}) filter (where ${RETURNED}), 0)`,
    })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(between(dateCol, from, to));
  const [ads] = await db
    .select({ spend: sum(schema.adSpends.spend), orders: sum(schema.adSpends.orders), revenue: sum(schema.adSpends.revenue) })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.excluded, false), between(schema.adSpends.spendDate, from, to)));
  const expenseRows = await db
    .select({ category: schema.expenses.category, amount: sum(schema.expenses.amount) })
    .from(schema.expenses)
    .where(between(schema.expenses.occurredAt, from, to))
    .groupBy(schema.expenses.category);

  const adsExpense = expenseRows.filter((r) => r.category === "ADS").reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const operating = expenseRows.filter((r) => r.category !== "ADS").reduce((s, r) => s + Number(r.amount ?? 0), 0);
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
  const dateCol = basisDate(basis);
  const dayOf = (col: SQL | AnyPgColumn) => sql<string>`to_char(${col} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
  const [orderRows, adRows, expenseRows] = await Promise.all([
    db
      .select({
        day: dayOf(dateCol),
        orders: sql<number>`count(*) filter (where ${NOT_CANCELLED})`,
        success: sql<number>`count(*) filter (where ${SUCCESS})`,
        revenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${SUCCESS}), 0)`,
        cogs: sql<number>`coalesce(sum(${schema.orders.cogs}) filter (where ${SUCCESS}), 0)`,
        shipping: sql<number>`coalesce(sum(${schema.orders.partnerFee}) filter (where ${SHIPPED}), 0)`,
        returnFee: sql<number>`coalesce(sum(${schema.orders.returnFee}) filter (where ${NOT_CANCELLED}), 0)`,
        marketplaceFee: sql<number>`coalesce(sum(${schema.orders.feeMarketplace}) filter (where ${NOT_CANCELLED}), 0)`,
      })
      .from(schema.orders)
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(between(dateCol, period.from, period.to))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ day: dayOf(schema.adSpends.spendDate), spend: sum(schema.adSpends.spend) })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), between(schema.adSpends.spendDate, period.from, period.to)))
      .groupBy(sql`1`),
    db
      .select({ day: dayOf(schema.expenses.occurredAt), ads: sql<number>`coalesce(sum(${schema.expenses.amount}) filter (where ${schema.expenses.category} = 'ADS'), 0)`, other: sql<number>`coalesce(sum(${schema.expenses.amount}) filter (where ${schema.expenses.category} <> 'ADS'), 0)` })
      .from(schema.expenses)
      .where(between(schema.expenses.occurredAt, period.from, period.to))
      .groupBy(sql`1`),
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
  for (const r of expenseRows) {
    const row = get(r.day);
    row.adSpend += Number(r.ads);
    row.operating += Number(r.other);
  }
  const rows = [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const row of rows) {
    row.grossProfit = row.revenue - row.cogs;
    row.netProfit = row.grossProfit - row.shipping - row.returnFee - row.marketplaceFee - row.adSpend - row.operating;
  }
  return rows;
}

export async function getProfitReport(period: Period, basis: ReportBasis) {
  const db = await getDb();
  const dateCol = basisDate(basis);
  const inPeriod = between(dateCol, period.from, period.to);
  const prev = previousPeriod(period);

  const groupSelect = {
    orders: sql<number>`count(*) filter (where ${NOT_CANCELLED})`,
    success: sql<number>`count(*) filter (where ${SUCCESS})`,
    revenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${SUCCESS}), 0)`,
    cogs: sql<number>`coalesce(sum(${schema.orders.cogs}) filter (where ${SUCCESS}), 0)`,
  };

  const [current, previous, channels, sellers, products, daily, codPaid, codWaiting] = await Promise.all([
    pnl(period.from, period.to, basis),
    prev.from ? pnl(prev.from, prev.to, basis) : Promise.resolve(null),
    db
      .select({ key: schema.orders.source, ...groupSelect })
      .from(schema.orders)
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(inPeriod)
      .groupBy(schema.orders.source)
      .orderBy(desc(sql`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${SUCCESS}), 0)`)),
    db
      .select({ key: schema.orders.sellerName, ...groupSelect })
      .from(schema.orders)
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(inPeriod)
      .groupBy(schema.orders.sellerName)
      .orderBy(desc(sql`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${SUCCESS}), 0)`))
      .limit(20),
    db
      .select({
        productName: schema.orderItems.productName,
        skus: sql<number>`count(distinct ${schema.orderItems.sku})`,
        orders: sql<number>`count(distinct ${schema.orders.id})`,
        quantity: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)`,
        revenue: sql<number>`coalesce(sum(${schema.orderItems.lineTotal}), 0)`,
        cogs: sql<number>`coalesce(sum(${schema.orderItems.unitCost} * ${schema.orderItems.quantity}), 0)`,
        image: sql<string | null>`max(${schema.orderItems.image})`,
      })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(and(inPeriod, inArray(schema.orders.stage, SUCCESS_STAGES)))
      .groupBy(schema.orderItems.productName)
      .orderBy(desc(sql`coalesce(sum(${schema.orderItems.lineTotal}), 0) - coalesce(sum(${schema.orderItems.unitCost} * ${schema.orderItems.quantity}), 0)`))
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
    cash: {
      codPaid: { amount: Number(codPaid[0]?.amount ?? 0), count: Number(codPaid[0]?.count ?? 0) },
      codWaiting: { amount: Number(codWaiting[0]?.amount ?? 0), count: Number(codWaiting[0]?.count ?? 0) },
      prepaid: current.prepaid,
    },
  };
}

export type ProfitReport = Awaited<ReturnType<typeof getProfitReport>>;

import { and, count, desc, eq, gte, inArray, isNotNull, lte, ne, sql, sum } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { erpStockExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import type { OrderStage, ShipmentStage } from "@/db/schema";
import { vnDateKey } from "@/lib/format";
import { previousPeriod, type Period } from "@/lib/search-params";
import { ORDER_COGS } from "@/lib/queries/cogs";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";

function inPeriod(column: typeof schema.orders.insertedAt, from: Date | null, to: Date | null) {
  const conds = [];
  if (from) conds.push(gte(column, from));
  if (to) conds.push(lte(column, to));
  return conds.length ? and(...conds) : undefined;
}

export type OrderKpis = {
  orders: number;
  revenue: number; // doanh thu lên đơn (không tính đơn huỷ/xoá)
  cogs: number;
  successOrders: number;
  successRevenue: number;
  failedOrders: number;
  activeOrders: number;
  aov: number;
};

async function orderKpis(from: Date | null, to: Date | null): Promise<OrderKpis> {
  const db = await getDb();
  const where = inPeriod(schema.orders.insertedAt, from, to);
  // Kết quả đơn theo trạng thái vận đơn Viettel Post kết hợp Pancake (ORDER_OUTCOME)
  const [row] = await db
    .select({
      orders: sql<number>`count(*) filter (where ${ORDER_OUTCOME} <> 'CANCELLED')`,
      revenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      cogs: sql<number>`coalesce(sum(${ORDER_COGS}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      successOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      successRevenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      failedOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('CANCELLED','RETURNED','RETURNED_BY_RULE'))`,
      activeOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('IN_TRANSIT','NOT_SHIPPED'))`,
    })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(where);
  const kpi: OrderKpis = {
    orders: Number(row?.orders ?? 0),
    revenue: Number(row?.revenue ?? 0),
    cogs: Number(row?.cogs ?? 0),
    successOrders: Number(row?.successOrders ?? 0),
    successRevenue: Number(row?.successRevenue ?? 0),
    failedOrders: Number(row?.failedOrders ?? 0),
    activeOrders: Number(row?.activeOrders ?? 0),
    aov: 0,
  };
  kpi.aov = kpi.orders ? Math.round(kpi.revenue / kpi.orders) : 0;
  return kpi;
}

export async function getDashboardData(period: Period) {
  const db = await getDb();
  const [current, previous] = await Promise.all([orderKpis(period.from, period.to), (() => {
    const prev = previousPeriod(period);
    return prev.from ? orderKpis(prev.from, prev.to) : Promise.resolve(null);
  })()]);

  // Trạng thái đơn theo giai đoạn
  const stageRows = await db
    .select({ stage: schema.orders.stage, count: count(), revenue: sum(schema.orders.totalPriceAfterDiscount) })
    .from(schema.orders)
    .where(inPeriod(schema.orders.insertedAt, period.from, period.to))
    .groupBy(schema.orders.stage);
  const byStage = Object.fromEntries(stageRows.map((r) => [r.stage, { count: Number(r.count), revenue: Number(r.revenue ?? 0) }])) as Record<OrderStage, { count: number; revenue: number }>;

  // Doanh thu theo ngày (giờ VN)
  const dailyRows = await db
    .select({
      day: sql<string>`to_char(${schema.orders.insertedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
      orders: count(),
      revenue: sum(schema.orders.totalPriceAfterDiscount),
      success: sql<number>`sum(case when ${ORDER_OUTCOME} = 'DELIVERED' then 1 else 0 end)`,
      successRevenue: sql<number>`sum(case when ${ORDER_OUTCOME} = 'DELIVERED' then ${schema.orders.totalPriceAfterDiscount} else 0 end)`,
    })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(and(inPeriod(schema.orders.insertedAt, period.from, period.to), ne(schema.orders.stage, "CANCELLED"), ne(schema.orders.stage, "DELETED")))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const daily = dailyRows.map((r) => ({ day: r.day, orders: Number(r.orders), revenue: Number(r.revenue ?? 0), success: Number(r.success ?? 0), successRevenue: Number(r.successRevenue ?? 0) }));

  // Theo kênh bán
  const channelRows = await db
    .select({ source: schema.orders.source, orders: count(), revenue: sum(schema.orders.totalPriceAfterDiscount), success: sql<number>`sum(case when ${ORDER_OUTCOME} = 'DELIVERED' then 1 else 0 end)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(and(inPeriod(schema.orders.insertedAt, period.from, period.to), ne(schema.orders.stage, "CANCELLED"), ne(schema.orders.stage, "DELETED")))
    .groupBy(schema.orders.source)
    .orderBy(desc(sum(schema.orders.totalPriceAfterDiscount)));
  const channels = channelRows.map((r) => ({ source: r.source, orders: Number(r.orders), revenue: Number(r.revenue ?? 0), success: Number(r.success ?? 0) }));

  // Vận đơn theo giai đoạn (toàn bộ đang hoạt động, không theo kỳ)
  const shipmentRows = await db.select({ stage: schema.shipments.stage, count: count(), cod: sum(schema.shipments.codAmount) }).from(schema.shipments).groupBy(schema.shipments.stage);
  const shipmentsByStage = Object.fromEntries(shipmentRows.map((r) => [r.stage, { count: Number(r.count), cod: Number(r.cod ?? 0) }])) as Record<ShipmentStage, { count: number; cod: number }>;

  // COD
  const codRows = await db.select({ status: schema.shipments.codStatus, count: count(), amount: sum(schema.shipments.codAmount) }).from(schema.shipments).where(ne(schema.shipments.codStatus, "NOT_APPLICABLE")).groupBy(schema.shipments.codStatus);
  const cod = Object.fromEntries(codRows.map((r) => [r.status, { count: Number(r.count), amount: Number(r.amount ?? 0) }]));

  // Tiền thực về trong kỳ (COD về ngân hàng theo ngày ghi nhận)
  const [paid] = await db
    .select({ amount: sum(schema.shipments.codCollected), count: count() })
    .from(schema.shipments)
    .where(and(eq(schema.shipments.codStatus, "PAID_TO_BANK"), period.from ? gte(schema.shipments.codPaidToBankAt, period.from) : undefined, period.to ? lte(schema.shipments.codPaidToBankAt, period.to) : undefined));

  // Chi phí trong kỳ
  const [expense] = await db
    .select({ amount: sum(schema.expenses.amount) })
    .from(schema.expenses)
    // chi phí vận hành: không gồm quảng cáo (đã lấy từ tài khoản QC) và nhập hàng (đã nằm trong giá vốn)
    .where(and(sql`${schema.expenses.category} not in ('ADS','PURCHASE')`, period.from ? gte(schema.expenses.occurredAt, period.from) : undefined, period.to ? lte(schema.expenses.occurredAt, period.to) : undefined));
  const [ads] = await db
    .select({ amount: sum(schema.adSpends.spend) })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.excluded, false), period.from ? gte(schema.adSpends.spendDate, period.from) : undefined, period.to ? lte(schema.adSpends.spendDate, period.to) : undefined));
  const [shippingFees] = await db
    .select({ fee: sum(schema.orders.partnerFee), returnFee: sum(schema.orders.returnFee) })
    .from(schema.orders)
    .where(and(inPeriod(schema.orders.insertedAt, period.from, period.to), ne(schema.orders.stage, "CANCELLED"), ne(schema.orders.stage, "DELETED")));

  // Cần xử lý
  const [failedDelivery] = await db.select({ count: count() }).from(schema.shipments).where(inArray(schema.shipments.stage, ["DELIVERY_FAILED", "RETURNING"]));
  const lowStockSales = variantSalesSubquery(db);
  const lowStockReceipts = variantReceiptsSubquery(db);
  const [lowStock] = await db
    .select({ count: count() })
    .from(schema.productVariants)
    .leftJoin(lowStockSales, eq(lowStockSales.variantId, schema.productVariants.id))
    .leftJoin(lowStockReceipts, eq(lowStockReceipts.variantId, schema.productVariants.id))
    .where(and(lte(erpStockExpr(lowStockSales, lowStockReceipts), 5), eq(schema.productVariants.isRemoved, false), eq(schema.productVariants.isHidden, false)));
  const [stale] = await db
    .select({ count: count() })
    .from(schema.shipments)
    .where(and(inArray(schema.shipments.stage, ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"]), lte(schema.shipments.updatedAt, new Date(Date.now() - 4 * 86_400_000))));
  const [newOrders] = await db.select({ count: count() }).from(schema.orders).where(eq(schema.orders.stage, "NEW"));
  const [codWaiting] = await db.select({ count: count(), amount: sum(schema.shipments.codAmount) }).from(schema.shipments).where(inArray(schema.shipments.codStatus, ["COLLECTED", "RECONCILED"]));

  // Đơn mới nhất
  const recentOrders = await db.query.orders.findMany({
    orderBy: [desc(schema.orders.insertedAt)],
    limit: 8,
    columns: { id: true, systemId: true, billFullName: true, billPhone: true, source: true, stage: true, totalPriceAfterDiscount: true, insertedAt: true, itemsCount: true },
    with: { shipment: { columns: { stage: true, carrier: true } }, items: { columns: { productName: true, variationDetail: true, quantity: true }, limit: 2 } },
  });

  // Top sản phẩm bán chạy trong kỳ
  const topProducts = await db
    .select({ productName: schema.orderItems.productName, sku: schema.orderItems.sku, quantity: sum(schema.orderItems.quantity), revenue: sum(schema.orderItems.lineTotal), image: sql<string | null>`max(${schema.orderItems.image})` })
    .from(schema.orderItems)
    .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
    .where(and(inPeriod(schema.orders.insertedAt, period.from, period.to), ne(schema.orders.stage, "CANCELLED"), ne(schema.orders.stage, "DELETED")))
    .groupBy(schema.orderItems.productName, schema.orderItems.sku)
    .orderBy(desc(sum(schema.orderItems.quantity)))
    .limit(6);

  // Sự kiện gần nhất
  const lastSyncRows = await db.select().from(schema.syncRuns).where(isNotNull(schema.syncRuns.finishedAt)).orderBy(desc(schema.syncRuns.startedAt)).limit(3);
  const [orderTotal] = await db.select({ count: count() }).from(schema.orders);

  const netRevenue = current.successRevenue;
  const realized = Number(paid?.amount ?? 0);
  const expenses = Number(expense?.amount ?? 0);
  const adSpend = Number(ads?.amount ?? 0);
  const shipping = Number(shippingFees?.fee ?? 0);
  const returnFee = Number(shippingFees?.returnFee ?? 0);
  const successCogs = Number(
    (
      await db
        .select({ cogs: sql<number>`coalesce(sum(${ORDER_COGS}), 0)` })
        .from(schema.orders)
        .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
        .where(and(inPeriod(schema.orders.insertedAt, period.from, period.to), sql`${ORDER_OUTCOME} = 'DELIVERED'`))
    )[0]?.cogs ?? 0,
  );
  const estimatedProfit = netRevenue - successCogs - shipping - returnFee - adSpend - expenses;

  return {
    period,
    kpi: current,
    previous,
    byStage,
    daily,
    channels,
    shipmentsByStage,
    cod,
    realized: { amount: realized, count: Number(paid?.count ?? 0) },
    finance: { netRevenue, successCogs, shipping, returnFee, adSpend, expenses, estimatedProfit },
    attention: {
      newOrders: Number(newOrders?.count ?? 0),
      failedDelivery: Number(failedDelivery?.count ?? 0),
      lowStock: Number(lowStock?.count ?? 0),
      staleShipments: Number(stale?.count ?? 0),
      codWaiting: { count: Number(codWaiting?.count ?? 0), amount: Number(codWaiting?.amount ?? 0) },
    },
    recentOrders,
    topProducts: topProducts.map((p) => ({ ...p, quantity: Number(p.quantity ?? 0), revenue: Number(p.revenue ?? 0) })),
    lastSyncRows,
    orderTotal: Number(orderTotal?.count ?? 0),
    todayKey: vnDateKey(new Date()),
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboardData>>;

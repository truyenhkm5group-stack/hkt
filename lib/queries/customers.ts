import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema, type Db } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { toDate } from "@/lib/format";
import type { ListParams } from "@/lib/search-params";

export const CUSTOMER_SORTABLE = ["orderCount", "purchasedAmount", "lastOrderAt", "name", "insertedAt"];

const c = schema.customers;
const o = schema.orders;

/** Ngày tạo khách: theo Pancake, hoặc ngày tạo trong ERP nếu khách được tạo tự động từ đơn */
const customerCreatedAt = sql<Date>`coalesce(${c.insertedAt}, ${c.createdAt})`;

/** Tổng hợp đơn hàng phía ERP theo khách (bổ sung khi số liệu Pancake chưa cập nhật) */
function orderAggregate(db: Db) {
  return db
    .select({
      customerId: o.customerId,
      ordersErp: sql<number>`count(*) filter (where ${o.stage} not in ('CANCELLED','DELETED'))`.as("orders_erp"),
      // Giao thành công / hoàn theo KẾT QUẢ THẬT của đơn (COD thực thu), không theo trạng thái Pancake.
      succeedErp: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`.as("succeed_erp"),
      returnedErp: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`.as("returned_erp"),
      revenueErp: sql<number>`coalesce(sum(case when ${o.stage} not in ('CANCELLED','DELETED') then ${o.totalPriceAfterDiscount} else 0 end), 0)`.as("revenue_erp"),
      lastOrderErp: sql<Date | string | null>`max(${o.insertedAt})`.as("last_order_erp"),
    })
    .from(o)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, o.id))
    .where(isNotNull(o.customerId))
    .groupBy(o.customerId)
    .as("agg");
}

type Agg = ReturnType<typeof orderAggregate>;

/** Biểu thức "hiệu lực": lấy giá trị lớn hơn giữa số liệu Pancake và số liệu ERP */
function effective(agg: Agg) {
  return {
    orders: sql<number>`greatest(${c.orderCount}, coalesce(${agg.ordersErp}, 0))`,
    succeed: sql<number>`greatest(${c.succeedOrderCount}, coalesce(${agg.succeedErp}, 0))`,
    returned: sql<number>`greatest(${c.returnedOrderCount}, coalesce(${agg.returnedErp}, 0))`,
    amount: sql<number>`greatest(${c.purchasedAmount}, coalesce(${agg.revenueErp}, 0))`,
    lastOrderAt: sql<Date | string | null>`greatest(${c.lastOrderAt}, ${agg.lastOrderErp})`,
  };
}

export function customerSearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  const digits = term.replace(/\D/g, "");
  return or(ilike(c.name, like), ilike(c.phone, like), sql`array_to_string(${c.phones}, ',') ilike ${like}`, digits.length >= 4 ? ilike(c.phone, `%${digits}%`) : undefined, ilike(c.pancakeId, like));
}

export function customerListWhere(params: ListParams, agg: Agg, skip: string[] = []) {
  const conds: (SQL | undefined)[] = [];
  const { period, filters, q } = params;
  const eff = effective(agg);
  if (period.from) conds.push(gte(customerCreatedAt, period.from));
  if (period.to) conds.push(lte(customerCreatedAt, period.to));
  if (!skip.includes("province") && filters.province?.length) conds.push(inArray(c.province, filters.province));
  const tier = skip.includes("tier") ? undefined : filters.tier?.[0];
  if (tier === "repeat") conds.push(sql`${eff.orders} >= 3`);
  else if (tier === "once") conds.push(sql`${eff.orders} = 1`);
  else if (tier === "returned") conds.push(sql`${eff.returned} >= 1`);
  else if (tier === "none") conds.push(sql`${eff.orders} = 0`);
  conds.push(customerSearchCondition(q));
  const defined = conds.filter((x): x is SQL => Boolean(x));
  return defined.length ? and(...defined) : undefined;
}

export type CustomerListRow = {
  id: string;
  name: string;
  phone: string | null;
  phones: string[];
  level: string | null;
  tags: string[];
  province: string;
  address: string;
  isBlock: boolean;
  orderCount: number;
  succeedOrderCount: number;
  returnedOrderCount: number;
  purchasedAmount: number;
  lastOrderAt: Date | null;
  insertedAt: Date | null;
  lastSource: string | null;
};

export async function listCustomers(params: ListParams) {
  const db = await getDb();
  const agg = orderAggregate(db);
  const eff = effective(agg);
  const where = customerListWhere(params, agg);
  const sortMap: Record<string, SQL | AnyPgColumn> = { orderCount: eff.orders, purchasedAmount: eff.amount, lastOrderAt: eff.lastOrderAt, name: c.name, insertedAt: customerCreatedAt };
  const sortExpr = sortMap[params.sort] ?? eff.lastOrderAt;
  const orderBy = params.dir === "asc" ? sql`${sortExpr} asc nulls first` : sql`${sortExpr} desc nulls last`;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: c.id,
        name: c.name,
        phone: c.phone,
        phones: c.phones,
        level: c.level,
        tags: c.tags,
        province: c.province,
        address: c.address,
        isBlock: c.isBlock,
        orderCount: eff.orders,
        succeedOrderCount: eff.succeed,
        returnedOrderCount: eff.returned,
        purchasedAmount: eff.amount,
        lastOrderAt: eff.lastOrderAt,
        insertedAt: customerCreatedAt,
      })
      .from(c)
      .leftJoin(agg, eq(agg.customerId, c.id))
      .where(where)
      .orderBy(orderBy, asc(c.name), asc(c.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    db.select({ total: count() }).from(c).leftJoin(agg, eq(agg.customerId, c.id)).where(where),
  ]);

  const ids = rows.map((r) => r.id);
  const sources = ids.length
    ? await db.selectDistinctOn([o.customerId], { customerId: o.customerId, source: o.source }).from(o).where(inArray(o.customerId, ids)).orderBy(o.customerId, desc(o.insertedAt))
    : [];
  const sourceMap = Object.fromEntries(sources.map((s) => [s.customerId ?? "", s.source]));

  const mapped: CustomerListRow[] = rows.map((r) => ({
    ...r,
    orderCount: Number(r.orderCount ?? 0),
    succeedOrderCount: Number(r.succeedOrderCount ?? 0),
    returnedOrderCount: Number(r.returnedOrderCount ?? 0),
    purchasedAmount: Number(r.purchasedAmount ?? 0),
    lastOrderAt: toDate(r.lastOrderAt),
    insertedAt: toDate(r.insertedAt),
    lastSource: sourceMap[r.id] ?? null,
  }));
  return { rows: mapped, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

/** Số khách theo tỉnh / nhóm (cho bộ lọc) */
export async function customerFacets(params: ListParams) {
  const db = await getDb();
  const agg = orderAggregate(db);
  const eff = effective(agg);
  const base = customerListWhere({ ...params, filters: {} }, agg);
  const [provinces, [tiers]] = await Promise.all([
    db
      .select({ value: c.province, count: count() })
      .from(c)
      .leftJoin(agg, eq(agg.customerId, c.id))
      .where(and(base, sql`${c.province} <> ''`))
      .groupBy(c.province)
      .orderBy(desc(count()), asc(c.province))
      .limit(64),
    db
      .select({
        repeat: sql<number>`count(*) filter (where ${eff.orders} >= 3)`,
        once: sql<number>`count(*) filter (where ${eff.orders} = 1)`,
        returned: sql<number>`count(*) filter (where ${eff.returned} >= 1)`,
        none: sql<number>`count(*) filter (where ${eff.orders} = 0)`,
      })
      .from(c)
      .leftJoin(agg, eq(agg.customerId, c.id))
      .where(base),
  ]);
  return {
    provinces: provinces.map((p) => ({ value: p.value, label: p.value, count: Number(p.count) })),
    tiers: [
      { value: "repeat", label: "Mua ≥3 lần", count: Number(tiers?.repeat ?? 0) },
      { value: "once", label: "Mua 1 lần", count: Number(tiers?.once ?? 0) },
      { value: "returned", label: "Có đơn hoàn", count: Number(tiers?.returned ?? 0) },
      { value: "none", label: "Chưa có đơn", count: Number(tiers?.none ?? 0) },
    ],
  };
}

export async function customerSummary(params: ListParams) {
  const db = await getDb();
  const agg = orderAggregate(db);
  const eff = effective(agg);
  const where = customerListWhere(params, agg);
  const newSince = params.period.from ?? new Date(Date.now() - 30 * 86_400_000);
  const newUntil = params.period.to;
  const [row] = await db
    .select({
      total: count(),
      newInPeriod: sql<number>`count(*) filter (where ${customerCreatedAt} >= ${newSince}${newUntil ? sql` and ${customerCreatedAt} <= ${newUntil}` : sql``})`,
      repeat: sql<number>`count(*) filter (where ${eff.orders} >= 2)`,
      withOrders: sql<number>`count(*) filter (where ${eff.orders} >= 1)`,
      orders: sql<number>`coalesce(sum(${eff.orders}), 0)`,
      returned: sql<number>`coalesce(sum(${eff.returned}), 0)`,
      amount: sql<number>`coalesce(sum(${eff.amount}), 0)`,
    })
    .from(c)
    .leftJoin(agg, eq(agg.customerId, c.id))
    .where(where);
  return {
    total: Number(row?.total ?? 0),
    newInPeriod: Number(row?.newInPeriod ?? 0),
    newLabel: params.period.from ? params.period.label.toLowerCase() : "30 ngày qua",
    repeat: Number(row?.repeat ?? 0),
    withOrders: Number(row?.withOrders ?? 0),
    orders: Number(row?.orders ?? 0),
    returned: Number(row?.returned ?? 0),
    amount: Number(row?.amount ?? 0),
  };
}

// ───────────────────────── Chi tiết khách hàng ─────────────────────────

export async function getCustomerDetail(id: string) {
  const db = await getDb();
  const customer = await db.query.customers.findFirst({ where: or(eq(c.id, id), eq(c.pancakeId, id)) });
  if (!customer) return null;
  const notCancelled = notInArray(o.stage, ["CANCELLED", "DELETED"]);

  const [[agg], orders, topProducts] = await Promise.all([
    db
      .select({
        orders: sql<number>`count(*) filter (where ${notCancelled})`,
        allOrders: count(),
        succeed: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
        cancelled: sql<number>`count(*) filter (where ${o.stage} in ('CANCELLED','DELETED'))`,
        revenue: sql<number>`coalesce(sum(case when ${notCancelled} then ${o.totalPriceAfterDiscount} else 0 end), 0)`,
        successRevenue: sql<number>`coalesce(sum(case when ${ORDER_OUTCOME} = 'DELIVERED' then ${o.totalPriceAfterDiscount} else 0 end), 0)`,
        firstOrderAt: sql<Date | string | null>`min(${o.insertedAt})`,
        lastOrderAt: sql<Date | string | null>`max(${o.insertedAt})`,
      })
      .from(o)
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, o.id))
      .where(eq(o.customerId, customer.id)),
    db.query.orders.findMany({
      where: eq(o.customerId, customer.id),
      orderBy: [desc(o.insertedAt)],
      limit: 100,
      columns: { id: true, systemId: true, source: true, stage: true, statusName: true, totalPriceAfterDiscount: true, moneyToCollect: true, itemsCount: true, totalQuantity: true, insertedAt: true },
      with: { shipment: { columns: { id: true, stage: true, carrier: true, vtpStatusName: true, codStatus: true } }, items: { columns: { productName: true, variationDetail: true, quantity: true }, limit: 3 } },
    }),
    db
      .select({
        productId: schema.orderItems.productId,
        productName: schema.orderItems.productName,
        quantity: sql<number>`sum(${schema.orderItems.quantity})`,
        revenue: sql<number>`sum(${schema.orderItems.lineTotal})`,
        orders: sql<number>`count(distinct ${o.id})`,
        image: sql<string | null>`max(${schema.orderItems.image})`,
        lastAt: sql<Date | string | null>`max(${o.insertedAt})`,
      })
      .from(schema.orderItems)
      .innerJoin(o, eq(schema.orderItems.orderId, o.id))
      .where(and(eq(o.customerId, customer.id), notCancelled))
      .groupBy(schema.orderItems.productId, schema.orderItems.productName)
      .orderBy(desc(sql`sum(${schema.orderItems.quantity})`), desc(sql`sum(${schema.orderItems.lineTotal})`))
      .limit(8),
  ]);

  const lastCandidates = [toDate(customer.lastOrderAt), toDate(agg?.lastOrderAt)].filter((d): d is Date => Boolean(d));
  const stats = {
    orders: Math.max(customer.orderCount, Number(agg?.orders ?? 0)),
    succeed: Math.max(customer.succeedOrderCount, Number(agg?.succeed ?? 0)),
    returned: Math.max(customer.returnedOrderCount, Number(agg?.returned ?? 0)),
    cancelled: Number(agg?.cancelled ?? 0),
    allOrders: Number(agg?.allOrders ?? 0),
    amount: Math.max(customer.purchasedAmount, Number(agg?.revenue ?? 0)),
    successRevenue: Number(agg?.successRevenue ?? 0),
    firstOrderAt: toDate(agg?.firstOrderAt),
    lastOrderAt: lastCandidates.length ? new Date(Math.max(...lastCandidates.map((d) => d.getTime()))) : null,
    aov: 0,
  };
  stats.aov = stats.orders ? Math.round(stats.amount / stats.orders) : 0;

  return {
    ...customer,
    stats,
    orders,
    topProducts: topProducts.map((p) => ({ ...p, quantity: Number(p.quantity ?? 0), revenue: Number(p.revenue ?? 0), orders: Number(p.orders ?? 0), lastAt: toDate(p.lastAt) })),
  };
}

export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomerDetail>>>;

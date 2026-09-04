import { and, count, desc, eq, exists, gte, ilike, lte, ne, or, sql, sum, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { orderByNullsLast } from "@/lib/queries/shipments";
import type { ListParams } from "@/lib/search-params";

export const RETURN_SORTABLE = ["insertedAt", "returnedFee", "displayId", "status"];

export const RETURN_TYPE_OPTIONS = [
  { value: "exchange", label: "Đổi hàng" },
  { value: "return", label: "Trả hàng" },
];

export function returnSearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  const r = schema.orderReturns;
  const conds: SQL[] = [
    ilike(r.billFullName, like),
    ilike(r.billPhone, like),
    eq(r.id, term.replace(/^#/, "")),
    exists(sql`(select 1 from ${schema.orders} o where o.id = ${r.orderId} and (o.bill_phone ilike ${like} or o.bill_full_name ilike ${like}))`),
  ];
  const numeric = Number(term.replace(/^#/, ""));
  if (Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric)) {
    conds.push(eq(r.displayId, numeric));
    conds.push(exists(sql`(select 1 from ${schema.orders} o where o.id = ${r.orderId} and o.system_id = ${numeric})`));
  }
  return or(...conds);
}

export function returnListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [];
  const { period, filters, q } = params;
  const r = schema.orderReturns;
  if (period.from) conds.push(gte(r.insertedAt, period.from));
  if (period.to) conds.push(lte(r.insertedAt, period.to));
  if (filters.type?.includes("exchange")) conds.push(eq(r.isExchange, true));
  else if (filters.type?.includes("return")) conds.push(eq(r.isExchange, false));
  conds.push(returnSearchCondition(q));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listReturns(params: ListParams) {
  const db = await getDb();
  const where = returnListWhere(params);
  const r = schema.orderReturns;
  const sortMap: Record<string, AnyPgColumn> = { insertedAt: r.insertedAt, returnedFee: r.returnedFee, displayId: r.displayId, status: r.status };
  const sortColumn = sortMap[params.sort] ?? r.insertedAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.orderReturns.findMany({
      where,
      orderBy: [orderByNullsLast(sortColumn, params.dir), desc(r.id)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      columns: { id: true, displayId: true, orderId: true, orderToReturnedId: true, status: true, statusName: true, returnedFee: true, discount: true, isExchange: true, billFullName: true, billPhone: true, items: true, insertedAt: true, updatedAtExternal: true },
      with: { order: { columns: { id: true, systemId: true, billFullName: true, billPhone: true, shipProvince: true, source: true, stage: true, totalPriceAfterDiscount: true, returnedReason: true } } },
    }),
    db.select({ total: count() }).from(r).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type ReturnListRow = Awaited<ReturnType<typeof listReturns>>["rows"][number];

export async function returnFacets(params: ListParams) {
  const db = await getDb();
  const base = returnListWhere({ ...params, filters: {} });
  const rows = await db.select({ value: schema.orderReturns.isExchange, count: count() }).from(schema.orderReturns).where(base).groupBy(schema.orderReturns.isExchange);
  const byType = { exchange: 0, return: 0 };
  for (const row of rows) byType[row.value ? "exchange" : "return"] += Number(row.count);
  return { types: RETURN_TYPE_OPTIONS.map((o) => ({ ...o, count: byType[o.value as keyof typeof byType] })) };
}

/** Số phiếu, phí hoàn, giảm giá và tỷ lệ hoàn (phiếu / đơn tạo trong kỳ) */
export async function returnSummary(params: ListParams) {
  const db = await getDb();
  const where = returnListWhere(params);
  const r = schema.orderReturns;
  const orderConds = [
    params.period.from ? gte(schema.orders.insertedAt, params.period.from) : undefined,
    params.period.to ? lte(schema.orders.insertedAt, params.period.to) : undefined,
    ne(schema.orders.stage, "CANCELLED"),
    ne(schema.orders.stage, "DELETED"),
  ].filter((c): c is SQL => Boolean(c));
  const [[row], [orders]] = await Promise.all([
    db
      .select({
        total: count(),
        exchanges: sql<number>`coalesce(sum(case when ${r.isExchange} then 1 else 0 end), 0)`,
        returnedFee: sum(r.returnedFee),
        discount: sum(r.discount),
      })
      .from(r)
      .where(where),
    db.select({ total: count() }).from(schema.orders).where(and(...orderConds)),
  ]);
  const total = Number(row?.total ?? 0);
  const orderTotal = Number(orders?.total ?? 0);
  return {
    total,
    exchanges: Number(row?.exchanges ?? 0),
    returnedFee: Number(row?.returnedFee ?? 0),
    discount: Number(row?.discount ?? 0),
    orders: orderTotal,
    rate: orderTotal ? (total / orderTotal) * 100 : 0,
  };
}

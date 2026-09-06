import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, sum, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { ExpenseCategory } from "@/db/schema";
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { AD_PLATFORMS, EXPENSE_CATEGORY_LABEL, EXPENSE_CATEGORY_ORDER } from "@/lib/constants/expenses";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { previousPeriod, type ListParams, type Period } from "@/lib/search-params";

export const EXPENSE_SORTABLE = ["occurredAt", "amount", "category", "createdAt"];
export const AD_SORTABLE = ["spendDate", "spend", "leads", "orders", "revenue", "platform"];

function periodCond(column: AnyPgColumn, from: Date | null, to: Date | null) {
  const conds: SQL[] = [];
  if (from) conds.push(gte(column, from));
  if (to) conds.push(lte(column, to));
  return conds;
}

// ───────────────────────── Chi phí ─────────────────────────

export function expenseListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = periodCond(schema.expenses.occurredAt, params.period.from, params.period.to);
  if (params.filters.category?.length) conds.push(inArray(schema.expenses.category, params.filters.category as ExpenseCategory[]));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(schema.expenses.description, like), ilike(schema.expenses.reference, like), ilike(schema.expenses.createdBy, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listExpenses(params: ListParams) {
  const db = await getDb();
  const where = expenseListWhere(params);
  const sortMap: Record<string, AnyPgColumn> = {
    occurredAt: schema.expenses.occurredAt,
    amount: schema.expenses.amount,
    category: schema.expenses.category,
    createdAt: schema.expenses.createdAt,
  };
  const sortColumn = sortMap[params.sort] ?? schema.expenses.occurredAt;
  const orderBy = params.dir === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [rows, [{ total }]] = await Promise.all([
    db.query.expenses.findMany({ where, orderBy: [orderBy, desc(schema.expenses.createdAt)], limit: params.pageSize, offset: (params.page - 1) * params.pageSize }),
    db.select({ total: count() }).from(schema.expenses).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type ExpenseRow = Awaited<ReturnType<typeof listExpenses>>["rows"][number];

export async function expenseFacets(params: ListParams) {
  const db = await getDb();
  const base = expenseListWhere({ ...params, filters: {} });
  const rows = await db.select({ value: schema.expenses.category, count: count() }).from(schema.expenses).where(base).groupBy(schema.expenses.category);
  const counts = Object.fromEntries(rows.map((r) => [r.value, Number(r.count)]));
  return {
    categories: EXPENSE_CATEGORY_ORDER.map((c) => ({ value: c, label: EXPENSE_CATEGORY_LABEL[c], count: counts[c] ?? 0 })).filter((c) => c.count > 0 || params.filters.category?.includes(c.value)),
  };
}

/** Tổng chi phí trong kỳ + theo nhóm (không phụ thuộc bộ lọc nhóm/tìm kiếm) */
export async function expenseSummary(period: Period) {
  const db = await getDb();
  const prev = previousPeriod(period);
  const [rows, [previous]] = await Promise.all([
    db
      .select({ category: schema.expenses.category, amount: sum(schema.expenses.amount), count: count() })
      .from(schema.expenses)
      .where(and(...periodCond(schema.expenses.occurredAt, period.from, period.to)))
      .groupBy(schema.expenses.category)
      .orderBy(desc(sum(schema.expenses.amount))),
    prev.from
      ? db
          .select({ amount: sum(schema.expenses.amount) })
          .from(schema.expenses)
          .where(and(...periodCond(schema.expenses.occurredAt, prev.from, prev.to)))
      : Promise.resolve([{ amount: null as string | null }]),
  ]);
  const byCategory = rows.map((r) => ({ category: r.category, label: EXPENSE_CATEGORY_LABEL[r.category], amount: Number(r.amount ?? 0), count: Number(r.count) }));
  const total = byCategory.reduce((s, r) => s + r.amount, 0);
  const totalCount = byCategory.reduce((s, r) => s + r.count, 0);
  return { total, totalCount, byCategory, previousTotal: prev.from ? Number(previous?.amount ?? 0) : null };
}

// ───────────────────────── Quảng cáo ─────────────────────────

export type AdFilters = Record<string, string[]>;

/** Giá trị đặc biệt trong bộ lọc: chưa gán marketer / chi phí test (không thuộc mã) */
export const AD_FILTER_NONE = "__none__";
export const AD_FILTER_TEST = "__test__";

/** Điều kiện lọc chi tiêu QC theo nền tảng, tài khoản QC, marketer, mã hàng (dùng chung cho KPI, biểu đồ, bảng, ghép chiến dịch) */
export function adFilterCond(filters: AdFilters | undefined): SQL[] {
  const conds: SQL[] = [];
  if (!filters) return conds;
  if (filters.platform?.length) conds.push(inArray(schema.adSpends.platform, filters.platform));
  if (filters.account?.length) conds.push(inArray(schema.adSpends.accountId, filters.account));
  const oneOf = (column: AnyPgColumn, values: string[], noneValue: string, noneCond: SQL) => {
    const ids = values.filter((v) => v !== noneValue);
    const parts: SQL[] = [];
    if (ids.length) parts.push(inArray(column, ids));
    if (values.includes(noneValue)) parts.push(noneCond);
    const combined = parts.length > 1 ? or(...parts) : parts[0];
    if (combined) conds.push(combined);
  };
  if (filters.marketer?.length) oneOf(schema.adSpends.marketerId, filters.marketer, AD_FILTER_NONE, isNull(schema.adSpends.marketerId));
  if (filters.product?.length) oneOf(schema.adSpends.productId, filters.product, AD_FILTER_TEST, and(isNull(schema.adSpends.productId), eq(schema.adSpends.excluded, false)) as SQL);
  return conds;
}

export function adListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [...periodCond(schema.adSpends.spendDate, params.period.from, params.period.to), ...adFilterCond(params.filters)];
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(schema.adSpends.campaign, like), ilike(schema.adSpends.note, like), ilike(schema.adSpends.platform, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listAdSpends(params: ListParams) {
  const db = await getDb();
  const where = adListWhere(params);
  const sortMap: Record<string, AnyPgColumn> = {
    spendDate: schema.adSpends.spendDate,
    spend: schema.adSpends.spend,
    leads: schema.adSpends.leads,
    orders: schema.adSpends.orders,
    revenue: schema.adSpends.revenue,
    platform: schema.adSpends.platform,
  };
  const sortColumn = sortMap[params.sort] ?? schema.adSpends.spendDate;
  const orderBy = params.dir === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [rows, [{ total }]] = await Promise.all([
    db.query.adSpends.findMany({ where, orderBy: [orderBy, asc(schema.adSpends.platform), desc(schema.adSpends.createdAt)], limit: params.pageSize, offset: (params.page - 1) * params.pageSize }),
    db.select({ total: count() }).from(schema.adSpends).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type AdSpendRow = Awaited<ReturnType<typeof listAdSpends>>["rows"][number];

export async function adFacets(params: ListParams) {
  const db = await getDb();
  const base = adListWhere({ ...params, filters: {} });
  const rows = await db.select({ value: schema.adSpends.platform, count: count() }).from(schema.adSpends).where(base).groupBy(schema.adSpends.platform).orderBy(desc(count()));
  const known = new Set<string>(AD_PLATFORMS);
  const selected = params.filters.platform ?? [];
  const options = rows.map((r) => ({ value: r.value, label: r.value, count: Number(r.count) }));
  for (const p of selected) if (!options.some((o) => o.value === p)) options.push({ value: p, label: p, count: 0 });
  return { platforms: options.sort((a, b) => (known.has(a.value) === known.has(b.value) ? b.count - a.count : known.has(a.value) ? -1 : 1)) };
}

/** KPI quảng cáo trong kỳ (theo bộ lọc tài khoản / marketer / mã hàng nếu có) */
export async function adSummary(period: Period, filters?: AdFilters) {
  const db = await getDb();
  const prev = previousPeriod(period);
  const extra = adFilterCond(filters);
  const select = { spend: sum(schema.adSpends.spend), leads: sum(schema.adSpends.leads), orders: sum(schema.adSpends.orders), revenue: sum(schema.adSpends.revenue), rows: count() };
  const [[current], [previous]] = await Promise.all([
    db
      .select(select)
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), ...periodCond(schema.adSpends.spendDate, period.from, period.to), ...extra)),
    prev.from
      ? db
          .select(select)
          .from(schema.adSpends)
          .where(and(eq(schema.adSpends.excluded, false), ...periodCond(schema.adSpends.spendDate, prev.from, prev.to), ...extra))
      : Promise.resolve([null]),
  ]);
  // Đơn & doanh số theo đơn ĐÃ XÁC NHẬN trên Pancake trong kỳ (không tính đơn mới/chờ/huỷ); ghi chú thêm đơn có ad_id và giao thành công
  const [erpNow, erpPrev] = await Promise.all([adOrdersFromErp(period.from, period.to), prev.from ? adOrdersFromErp(prev.from, prev.to) : Promise.resolve(null)]);
  const toKpi = (r: typeof current | null, erp: Awaited<ReturnType<typeof adOrdersFromErp>> | null) => {
    const spend = Number(r?.spend ?? 0);
    const fbOrders = Number(r?.orders ?? 0);
    const fbRevenue = Number(r?.revenue ?? 0);
    const orders = erp?.orders ?? 0;
    const revenue = erp?.revenue ?? 0;
    return {
      spend,
      leads: Number(r?.leads ?? 0),
      rows: Number(r?.rows ?? 0),
      /** Đơn Pancake đã xác nhận trong kỳ */
      orders,
      /** Doanh số (tổng tiền sau giảm) của đơn đã xác nhận */
      revenue,
      /** Trong đó: đơn có ad_id (khách đến từ quảng cáo) */
      adOrders: erp?.adOrders ?? 0,
      adRevenue: erp?.adRevenue ?? 0,
      /** Đã giao thành công & doanh thu giao thành công */
      delivered: erp?.delivered ?? 0,
      deliveredRevenue: erp?.deliveredRevenue ?? 0,
      /** Số liệu Facebook tự báo (pixel/attribution) — chỉ để tham khảo */
      fbOrders,
      fbRevenue,
      roas: spend ? revenue / spend : 0,
      cpo: orders ? Math.round(spend / orders) : 0,
    };
  };
  return { ...toKpi(current, erpNow), previous: prev.from ? toKpi(previous, erpPrev) : null };
}

/** Phạm vi đơn dùng chung — định nghĩa gốc ở lib/constants/pancake.ts, giữ export này cho các import cũ. */
export { CONFIRMED_STAGES };

/** Đơn Pancake đã xác nhận trong kỳ (theo ngày lên đơn): số đơn, doanh số; đơn có ad_id; giao thành công */
export async function adOrdersFromErp(from: Date | null, to: Date | null) {
  const db = await getDb();
  const o = schema.orders;
  const hasAd = sql`${o.adId} is not null and ${o.adId} <> ''`;
  const [row] = await db
    .select({
      orders: sql<number>`count(*)`,
      revenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}), 0)`,
      adOrders: sql<number>`count(*) filter (where ${hasAd})`,
      adRevenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${hasAd}), 0)`,
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      deliveredRevenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
    })
    .from(o)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, o.id))
    .where(and(inArray(o.stage, [...CONFIRMED_STAGES]), ...periodCond(o.insertedAt, from, to)));
  return {
    orders: Number(row?.orders ?? 0),
    revenue: Number(row?.revenue ?? 0),
    adOrders: Number(row?.adOrders ?? 0),
    adRevenue: Number(row?.adRevenue ?? 0),
    delivered: Number(row?.delivered ?? 0),
    deliveredRevenue: Number(row?.deliveredRevenue ?? 0),
  };
}

/** Chi tiêu theo ngày × nền tảng cho biểu đồ */
export async function adDailyByPlatform(period: Period, filters?: AdFilters) {
  const db = await getDb();
  const rows = await db
    .select({
      day: sql<string>`to_char(${schema.adSpends.spendDate} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
      platform: schema.adSpends.platform,
      spend: sum(schema.adSpends.spend),
    })
    .from(schema.adSpends)
    .where(and(...periodCond(schema.adSpends.spendDate, period.from, period.to), ...adFilterCond(filters)))
    .groupBy(sql`1`, schema.adSpends.platform)
    .orderBy(sql`1`);
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.platform, (totals.get(r.platform) ?? 0) + Number(r.spend ?? 0));
  const platforms = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const byDay = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const row = byDay.get(r.day) ?? { day: r.day };
    row[r.platform] = Number(r.spend ?? 0);
    byDay.set(r.day, row);
  }
  return { platforms, data: [...byDay.values()] };
}

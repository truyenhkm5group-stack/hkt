import { and, asc, count, desc, gte, ilike, inArray, lte, or, sql, sum, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { ExpenseCategory } from "@/db/schema";
import { AD_PLATFORMS, EXPENSE_CATEGORY_LABEL, EXPENSE_CATEGORY_ORDER } from "@/lib/constants/expenses";
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

export function adListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = periodCond(schema.adSpends.spendDate, params.period.from, params.period.to);
  if (params.filters.platform?.length) conds.push(inArray(schema.adSpends.platform, params.filters.platform));
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

/** KPI quảng cáo trong kỳ (không phụ thuộc bộ lọc) */
export async function adSummary(period: Period) {
  const db = await getDb();
  const prev = previousPeriod(period);
  const select = { spend: sum(schema.adSpends.spend), leads: sum(schema.adSpends.leads), orders: sum(schema.adSpends.orders), revenue: sum(schema.adSpends.revenue), rows: count() };
  const [[current], [previous]] = await Promise.all([
    db
      .select(select)
      .from(schema.adSpends)
      .where(and(...periodCond(schema.adSpends.spendDate, period.from, period.to))),
    prev.from
      ? db
          .select(select)
          .from(schema.adSpends)
          .where(and(...periodCond(schema.adSpends.spendDate, prev.from, prev.to)))
      : Promise.resolve([null]),
  ]);
  const toKpi = (r: typeof current | null) => {
    const spend = Number(r?.spend ?? 0);
    const orders = Number(r?.orders ?? 0);
    const revenue = Number(r?.revenue ?? 0);
    return { spend, leads: Number(r?.leads ?? 0), orders, revenue, rows: Number(r?.rows ?? 0), roas: spend ? revenue / spend : 0, cpo: orders ? Math.round(spend / orders) : 0 };
  };
  return { ...toKpi(current), previous: prev.from ? toKpi(previous) : null };
}

/** Chi tiêu theo ngày × nền tảng cho biểu đồ */
export async function adDailyByPlatform(period: Period) {
  const db = await getDb();
  const rows = await db
    .select({
      day: sql<string>`to_char(${schema.adSpends.spendDate} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
      platform: schema.adSpends.platform,
      spend: sum(schema.adSpends.spend),
    })
    .from(schema.adSpends)
    .where(and(...periodCond(schema.adSpends.spendDate, period.from, period.to)))
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

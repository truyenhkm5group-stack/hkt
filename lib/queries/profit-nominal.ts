import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DEFAULT_PROFIT_ASSUMPTIONS, FALLBACK_SHIP_FEE_DELIVERED, FALLBACK_SHIP_FEE_RETURNED, PROFIT_ASSUMPTIONS_KEY, type ProfitAssumptions } from "@/lib/constants/profit";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { LAST_RECEIPT_COST } from "@/lib/queries/stock";
import type { Period } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";

const o = schema.orders;
const s = schema.shipments;
const i = schema.orderItems;
const pv = schema.productVariants;
const p = schema.products;
const ads = schema.adSpends;

const NOT_CANCELLED = sql`${o.stage} not in ('CANCELLED','DELETED')`;
const IS_RETURNED = sql`${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')`;
/** Giá vốn một sản phẩm trên dòng đơn: giá nhập trên phiếu gần nhất → giá vốn Pancake ghi trên đơn → giá nhập mẫu mã */
const LINE_UNIT_COST = sql<number>`coalesce(${LAST_RECEIPT_COST}, nullif(${i.unitCost}, 0), ${pv.lastImportedPrice}, 0)`;

function periodCond(from: Date | null, to: Date | null): SQL[] {
  const conds: SQL[] = [];
  if (from) conds.push(gte(o.insertedAt, from));
  if (to) conds.push(lte(o.insertedAt, to));
  return conds;
}

export type ResolvedAssumptions = ProfitAssumptions & { shipFeeDeliveredUsed: number; shipFeeReturnedUsed: number; shipFeeSource: "setting" | "data" | "fallback" };

/** Đọc giả định + tự tính cước bình quân từ dữ liệu 90 ngày nếu chưa đặt */
export async function resolveAssumptions(): Promise<ResolvedAssumptions> {
  const db = await getDb();
  const saved = await getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS);
  let shipFeeDeliveredUsed = saved.shipFeeDelivered;
  let shipFeeReturnedUsed = saved.shipFeeReturned;
  let shipFeeSource: ResolvedAssumptions["shipFeeSource"] = "setting";
  if (!shipFeeDeliveredUsed || !shipFeeReturnedUsed) {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const [row] = await db
      .select({
        delivered: sql<number>`avg(nullif(coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}), 0)) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        returned: sql<number>`avg(nullif(coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}) + ${o.returnFee}, 0)) filter (where ${IS_RETURNED})`,
      })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(gte(o.insertedAt, since));
    const d = Math.round(Number(row?.delivered ?? 0));
    const r = Math.round(Number(row?.returned ?? 0));
    if (!shipFeeDeliveredUsed) shipFeeDeliveredUsed = d || FALLBACK_SHIP_FEE_DELIVERED;
    if (!shipFeeReturnedUsed) shipFeeReturnedUsed = r || (d ? d + 8_500 : FALLBACK_SHIP_FEE_RETURNED);
    shipFeeSource = d || r ? "data" : "fallback";
  }
  return { ...saved, shipFeeDeliveredUsed, shipFeeReturnedUsed, shipFeeSource };
}

export type ProductReturnHistory = { productId: string; finished: number; returned: number; rate: number | null };

/** Tỷ lệ hoàn lịch sử theo sản phẩm trong N ngày gần nhất (đơn có kết quả: giao thật + hoàn) */
export async function productReturnHistory(windowDays: number): Promise<Map<string, ProductReturnHistory>> {
  const db = await getDb();
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await db
    .select({
      productId: sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`,
      finished: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} in ('DELIVERED','RETURNED','RETURNED_BY_RULE'))`,
      returned: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .leftJoin(pv, eq(pv.id, i.variantId))
    .where(and(gte(o.insertedAt, since), eq(i.isBonus, false)))
    .groupBy(sql`1`);
  const map = new Map<string, ProductReturnHistory>();
  for (const r of rows) {
    const finished = Number(r.finished);
    const returned = Number(r.returned);
    if (r.productId) map.set(r.productId, { productId: r.productId, finished, returned, rate: finished ? (returned / finished) * 100 : null });
  }
  return map;
}

export type NominalRow = {
  productId: string;
  productName: string;
  code: string;
  image: string | null;
  orders: number;
  items: number;
  grossSales: number;
  adSpend: number;
  returnRate: number;
  returnRateSource: "override" | "history" | "default";
  historyFinished: number;
  expectedRevenue: number;
  expectedCogs: number;
  shipCost: number;
  expectedProfit: number;
  margin: number | null;
  cpo: number | null;
  revenuePerOrder: number | null;
  /** Thực tế tới nay */
  delivered: number;
  returned: number;
  inTransit: number;
  pending: number;
  actualRevenue: number;
};

export type NominalReport = {
  assumptions: ResolvedAssumptions;
  rows: NominalRow[];
  unmatchedAdSpend: number;
  totals: { orders: number; items: number; grossSales: number; adSpend: number; expectedRevenue: number; expectedCogs: number; shipCost: number; expectedProfit: number; margin: number | null; delivered: number; returned: number; inTransit: number; actualRevenue: number; weightedReturnRate: number | null };
};

function applyAssumptions(base: { orders: number; items: number; grossSales: number; cogsFull: number; adSpend: number }, rate: number, a: ResolvedAssumptions) {
  const r = Math.min(Math.max(rate, 0), 100) / 100;
  const expectedRevenue = Math.round(base.grossSales * (1 - r));
  const expectedCogs = Math.round(base.cogsFull * (1 - r));
  const shipCost = Math.round(base.orders * ((1 - r) * a.shipFeeDeliveredUsed + r * a.shipFeeReturnedUsed));
  const expectedProfit = expectedRevenue - expectedCogs - shipCost - base.adSpend;
  return { expectedRevenue, expectedCogs, shipCost, expectedProfit, margin: expectedRevenue ? (expectedProfit / expectedRevenue) * 100 : null };
}

/** Lợi nhuận danh nghĩa theo mã hàng: đơn lên trong kỳ × (1 − tỷ lệ hoàn ước tính) − giá vốn − vận chuyển − quảng cáo */
export async function getNominalProfitReport(period: Period): Promise<NominalReport> {
  const db = await getDb();
  const assumptions = await resolveAssumptions();
  const history = await productReturnHistory(assumptions.returnRateWindowDays);
  const adConds: SQL[] = [eq(ads.excluded, false)];
  if (period.from) adConds.push(gte(ads.spendDate, period.from));
  if (period.to) adConds.push(lte(ads.spendDate, period.to));

  const [sales, adRows] = await Promise.all([
    db
      .select({
        productId: sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`,
        productName: sql<string>`max(coalesce(${p.name}, ${i.productName}))`,
        code: sql<string>`max(coalesce(${p.customId}, ''))`,
        image: sql<string | null>`max(coalesce(${p.image}, ${i.image}))`,
        orders: sql<number>`count(distinct ${o.id}) filter (where ${NOT_CANCELLED})`,
        items: sql<number>`coalesce(sum(${i.quantity}) filter (where ${NOT_CANCELLED}), 0)`,
        grossSales: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${NOT_CANCELLED}), 0)`,
        cogsFull: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${NOT_CANCELLED}), 0)`,
        delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        returned: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
        inTransit: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
        pending: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'NOT_SHIPPED')`,
        actualRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, eq(s.orderId, o.id))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .leftJoin(p, eq(p.id, sql`coalesce(${pv.productId}, ${i.productId})`))
      .where(and(eq(i.isBonus, false), ...periodCond(period.from, period.to)))
      .groupBy(sql`1`),
    db
      .select({ productId: ads.productId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
      .from(ads)
      .where(and(...adConds))
      .groupBy(ads.productId),
  ]);
  const adByProduct = new Map<string, number>();
  let unmatchedAdSpend = 0;
  for (const r of adRows) {
    if (r.productId) adByProduct.set(r.productId, Number(r.spend));
    else unmatchedAdSpend += Number(r.spend);
  }

  const rows: NominalRow[] = sales
    .filter((r) => r.productId)
    .map((r) => {
      const base = { orders: Number(r.orders), items: Number(r.items), grossSales: Number(r.grossSales), cogsFull: Number(r.cogsFull), adSpend: adByProduct.get(r.productId) ?? 0 };
      const h = history.get(r.productId);
      let returnRate = assumptions.defaultReturnRate;
      let returnRateSource: NominalRow["returnRateSource"] = "default";
      if (assumptions.overrides[r.productId] !== undefined && Number.isFinite(assumptions.overrides[r.productId])) {
        returnRate = assumptions.overrides[r.productId];
        returnRateSource = "override";
      } else if (h && h.rate !== null && h.finished >= assumptions.minFinishedOrders) {
        returnRate = h.rate;
        returnRateSource = "history";
      }
      const calc = applyAssumptions(base, returnRate, assumptions);
      return {
        productId: r.productId,
        productName: r.productName ?? "",
        code: r.code ?? "",
        image: r.image,
        ...base,
        returnRate,
        returnRateSource,
        historyFinished: h?.finished ?? 0,
        ...calc,
        cpo: base.orders ? base.adSpend / base.orders : null,
        revenuePerOrder: base.orders ? calc.expectedRevenue / base.orders : null,
        delivered: Number(r.delivered),
        returned: Number(r.returned),
        inTransit: Number(r.inTransit),
        pending: Number(r.pending),
        actualRevenue: Number(r.actualRevenue),
      };
    })
    .sort((a, b) => b.expectedProfit - a.expectedProfit);

  const totals = rows.reduce(
    (t, r) => ({
      orders: t.orders + r.orders,
      items: t.items + r.items,
      grossSales: t.grossSales + r.grossSales,
      adSpend: t.adSpend + r.adSpend,
      expectedRevenue: t.expectedRevenue + r.expectedRevenue,
      expectedCogs: t.expectedCogs + r.expectedCogs,
      shipCost: t.shipCost + r.shipCost,
      expectedProfit: t.expectedProfit + r.expectedProfit,
      delivered: t.delivered + r.delivered,
      returned: t.returned + r.returned,
      inTransit: t.inTransit + r.inTransit,
      actualRevenue: t.actualRevenue + r.actualRevenue,
      weightedReturn: t.weightedReturn + r.returnRate * r.orders,
    }),
    { orders: 0, items: 0, grossSales: 0, adSpend: 0, expectedRevenue: 0, expectedCogs: 0, shipCost: 0, expectedProfit: 0, delivered: 0, returned: 0, inTransit: 0, actualRevenue: 0, weightedReturn: 0 },
  );
  const adSpendAll = totals.adSpend + unmatchedAdSpend;
  const expectedProfitAll = totals.expectedProfit - unmatchedAdSpend;
  return {
    assumptions,
    rows,
    unmatchedAdSpend,
    totals: {
      orders: totals.orders,
      items: totals.items,
      grossSales: totals.grossSales,
      adSpend: adSpendAll,
      expectedRevenue: totals.expectedRevenue,
      expectedCogs: totals.expectedCogs,
      shipCost: totals.shipCost,
      expectedProfit: expectedProfitAll,
      margin: totals.expectedRevenue ? (expectedProfitAll / totals.expectedRevenue) * 100 : null,
      delivered: totals.delivered,
      returned: totals.returned,
      inTransit: totals.inTransit,
      actualRevenue: totals.actualRevenue,
      weightedReturnRate: totals.orders ? totals.weightedReturn / totals.orders : null,
    },
  };
}

export type NominalDailyRow = { day: string; orders: number; items: number; grossSales: number; adSpend: number; expectedRevenue: number; expectedCogs: number; shipCost: number; expectedProfit: number; margin: number | null; cpo: number | null; delivered: number; returned: number };

/** Bảng theo ngày của một mã hàng (giống sheet báo cáo mẫu): đơn, SP, CPQC, doanh số, DT ước tính, giá vốn, VC, lợi nhuận, margin */
export async function getNominalDailyForProduct(productId: string, period: Period, returnRate: number, assumptions: ResolvedAssumptions): Promise<NominalDailyRow[]> {
  const db = await getDb();
  const day = sql<string>`to_char(${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
  const adDay = sql<string>`to_char(${ads.spendDate} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
  const adConds: SQL[] = [eq(ads.productId, productId), eq(ads.excluded, false)];
  if (period.from) adConds.push(gte(ads.spendDate, period.from));
  if (period.to) adConds.push(lte(ads.spendDate, period.to));
  const [salesRows, adRows] = await Promise.all([
    db
      .select({
        day,
        orders: sql<number>`count(distinct ${o.id}) filter (where ${NOT_CANCELLED})`,
        items: sql<number>`coalesce(sum(${i.quantity}) filter (where ${NOT_CANCELLED}), 0)`,
        grossSales: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${NOT_CANCELLED}), 0)`,
        cogsFull: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${NOT_CANCELLED}), 0)`,
        delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        returned: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, eq(s.orderId, o.id))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .where(and(eq(i.isBonus, false), sql`coalesce(${pv.productId}, ${i.productId}) = ${productId}`, ...periodCond(period.from, period.to)))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ day: adDay, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
      .from(ads)
      .where(and(...adConds))
      .groupBy(sql`1`),
  ]);
  const adMap = new Map(adRows.map((r) => [r.day, Number(r.spend)]));
  const days = new Set<string>([...salesRows.map((r) => r.day), ...adMap.keys()]);
  const salesMap = new Map(salesRows.map((r) => [r.day, r]));
  return [...days]
    .sort()
    .map((d) => {
      const sr = salesMap.get(d);
      const base = { orders: Number(sr?.orders ?? 0), items: Number(sr?.items ?? 0), grossSales: Number(sr?.grossSales ?? 0), cogsFull: Number(sr?.cogsFull ?? 0), adSpend: adMap.get(d) ?? 0 };
      const calc = applyAssumptions(base, returnRate, assumptions);
      return { day: d, ...base, ...calc, cpo: base.orders ? base.adSpend / base.orders : null, delivered: Number(sr?.delivered ?? 0), returned: Number(sr?.returned ?? 0) };
    });
}

/**
 * ═══════════ ĐỐI SOÁT LỢI NHUẬN TÍNH LƯƠNG THEO THÁNG — LỚP ĐỌC ═══════════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9. Phép dựng: `lib/payroll/profit-reconciliation.ts` (thuần).
 *
 * Hai vế đặt cạnh nhau, KHÔNG vế nào tính lại lợi nhuận:
 *  · cơ sở lương — `getPayrollReport(tháng, "profit1").marketers` (đúng con số bảng lương dùng);
 *  · nguồn       — `getRecognizedCosts()` (máy chi phí, memo cùng kỳ) + một lượt đo trên đơn của tháng
 *    bằng CHÍNH các biểu thức của cơ sở (`ORDER_OUTCOME_FAST`, `PRIMARY_ATTEMPT`, `LINE_UNIT_COST`,
 *    `REVENUE_RECOGNIZED_ON_DELIVERY`) — viết lại luật kết quả đơn ở đây là tạo nguồn sự thật thứ hai.
 */
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { ELIGIBLE_SENT_SQL } from "@/lib/constants/returns";
import { FINISHED_OUTCOMES_SQL, OUTCOME_GROUP } from "@/lib/constants/truth";
import type { OrderOutcome } from "@/lib/constants/returns";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getPayrollReport, monthReportPeriod, type PayrollReport } from "@/lib/queries/payroll";
import { loadCodeBook } from "@/lib/queries/payroll-code-ledger";
import { buildMonthReconciliation, type MonthReconciliation } from "@/lib/payroll/profit-reconciliation";
import { PAYROLL_PROFIT_SIGNOFF_KEY, type ProfitReconSignoff } from "@/lib/constants/payroll-reconciliation";

const OPEN_OUTCOMES_SQL = (Object.keys(OUTCOME_GROUP) as OrderOutcome[])
  .filter((x) => OUTCOME_GROUP[x] === "OPEN")
  .map((x) => `'${x}'`)
  .join(",");

type OrderFacts = {
  deliveredRevenue: number;
  deliveredRevenueWithMoney: number;
  deliveredOrders: number;
  deliveredOrdersWithMoney: number;
  openOrders: number;
  openValue: number;
  settledValue: number;
  returnedOrders: number;
  cancelledOrders: number;
  unknownCostLines: number;
  unknownCostRevenue: number;
  sentNoFeeOrders: number;
};

/** Một lượt đo trên đơn của tháng (theo ngày lên đơn — cùng mốc với cơ sở lương). */
async function orderFacts(from: Date, to: Date): Promise<{ total: OrderFacts; unknownByProduct: Map<string, number> }> {
  const db = await getDb();
  const i = schema.orderItems;
  const o = schema.orders;
  const s = schema.shipments;
  const pv = schema.productVariants;
  const ky: SQL[] = [gte(o.insertedAt, from), lte(o.insertedAt, to)];
  const coTien = sql`(coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0) + coalesce(${o.cash}, 0) > 0 or exists (select 1 from shipments sh where sh.order_id = ${o.id} and coalesce(sh.cod_collected, 0) > 0))`;
  const giao = sql`${ORDER_OUTCOME_FAST} = 'DELIVERED' and ${REVENUE_RECOGNIZED_ON_DELIVERY}`;
  const productKey = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
  return chayKhongJit(db, async (tx) => {
    const [dong] = await tx
      .select({
        deliveredRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${giao} and ${i.isBonus} = false), 0)`,
        deliveredRevenueWithMoney: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${giao} and ${i.isBonus} = false and ${coTien}), 0)`,
        openValue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(OPEN_OUTCOMES_SQL)}) and ${i.isBonus} = false and ${o.stage} not in ('CANCELLED','DELETED')), 0)`,
        settledValue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(FINISHED_OUTCOMES_SQL)}) and ${i.isBonus} = false), 0)`,
        unknownCostLines: sql<number>`count(*) filter (where ${giao} and ${LINE_UNIT_COST} = 0)`,
        unknownCostRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${giao} and ${LINE_UNIT_COST} = 0), 0)`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .where(and(...ky));
    const [don] = await tx
      .select({
        deliveredOrders: sql<number>`count(*) filter (where ${giao})`,
        deliveredOrdersWithMoney: sql<number>`count(*) filter (where ${giao} and ${coTien})`,
        openOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(OPEN_OUTCOMES_SQL)}) and ${o.stage} not in ('CANCELLED','DELETED'))`,
        returnedOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE'))`,
        cancelledOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'CANCELLED')`,
        sentNoFeeOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(ELIGIBLE_SENT_SQL)}) and coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0) = 0)`,
      })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(...ky));
    const theoMa = await tx
      .select({ productId: productKey, n: sql<number>`count(*)` })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .where(and(...ky, giao, sql`${LINE_UNIT_COST} = 0`))
      .groupBy(sql`1`);
    const n = (v: unknown) => Number(v ?? 0);
    return {
      total: {
        deliveredRevenue: n(dong?.deliveredRevenue),
        deliveredRevenueWithMoney: n(dong?.deliveredRevenueWithMoney),
        deliveredOrders: n(don?.deliveredOrders),
        deliveredOrdersWithMoney: n(don?.deliveredOrdersWithMoney),
        openOrders: n(don?.openOrders),
        openValue: n(dong?.openValue),
        settledValue: n(dong?.settledValue),
        returnedOrders: n(don?.returnedOrders),
        cancelledOrders: n(don?.cancelledOrders),
        unknownCostLines: n(dong?.unknownCostLines),
        unknownCostRevenue: n(dong?.unknownCostRevenue),
        sentNoFeeOrders: n(don?.sentNoFeeOrders),
      },
      unknownByProduct: new Map(theoMa.map((x) => [x.productId, n(x.n)] as const)),
    };
  });
}

/**
 * ĐỐI SOÁT MỘT THÁNG LỊCH. `given.report` = bản tính bảng lương đã có của đúng tháng ấy (tránh tính
 * lại khi người gọi đã có — chốt kỳ, trang đối soát).
 */
export async function getMonthReconciliation(monthKey: string, given?: { report: PayrollReport }): Promise<MonthReconciliation> {
  const period = monthReportPeriod(monthKey);
  const from = period.from as Date;
  const to = period.to as Date;
  const [report, engine, facts, book] = await Promise.all([
    given ? Promise.resolve(given.report) : getPayrollReport(period, "profit1"),
    getRecognizedCosts(period),
    orderFacts(from, to),
    loadCodeBook(from, to),
  ]);
  const m = report.marketers;
  const t = m.totals;
  let adsCodeWithMarketer = 0;
  let adsCodeNoMarketer = 0;
  let adsTestWithMarketer = 0;
  let adsTestNoMarketer = 0;
  const adsNoMkByProduct = new Map<string, number>();
  for (const mk of m.marketers) {
    for (const pl of mk.products) {
      if (mk.marketerId) adsCodeWithMarketer += pl.adSpend;
      else {
        adsCodeNoMarketer += pl.adSpend;
        adsNoMkByProduct.set(pl.productId, (adsNoMkByProduct.get(pl.productId) ?? 0) + pl.adSpend);
      }
    }
    if (mk.marketerId) adsTestWithMarketer += mk.testSpend;
    else adsTestNoMarketer += mk.testSpend;
  }
  const assigned = new Set(book.assignments.map((a) => a.productId));
  const la = engine.logisticsAdjustment;
  const excl = t.basisExclusions ?? [];
  return buildMonthReconciliation(
    {
      monthKey,
      basis: {
        revenue: m.products.reduce((s, p) => s + p.revenue, 0),
        cogs: m.products.reduce((s, p) => s + p.cogs, 0),
        adsCodeWithMarketer,
        adsCodeNoMarketer,
        adsTestWithMarketer,
        adsTestNoMarketer,
        shippingPerShipment: t.shipping - t.logisticsAdjustment,
        logisticsAdjustment: t.logisticsAdjustment,
        logisticsAdjustmentUnallocated: t.logisticsAdjustmentUnallocated,
        operatingEntered: t.operatingEntered,
        operatingAllocToCodes: m.products.reduce((s, p) => s + p.operatingAlloc, 0),
        fixedCostAssumption: t.fixedCost,
        perOrderOpsEstimate: t.perOrderOps,
        sharedUnallocated: t.sharedUnallocated,
        profit: t.profit,
        basisExclusionMeasured: excl.filter((x) => x.confidence === "MEASURED").reduce((s, x) => s + x.amount, 0),
        basisExclusionEstimated: excl.filter((x) => x.confidence === "ESTIMATED").reduce((s, x) => s + x.amount, 0),
      },
      engine: {
        cogs: engine.components.COGS.amount,
        ads: engine.components.ADS.amount,
        shipping: engine.components.SHIPPING.amount - la.shipping,
        returnCost: engine.components.RETURN_COST.amount - la.returnFee,
        operatingTotal: engine.operatingTotal,
      },
      orders: facts.total,
      costWarnings: m.costWarnings.filter((w) => w.severity === "high").map((w) => ({ rule: w.rule, title: w.title, amount: w.amount })),
      codes: m.products.map((p) => ({
        productId: p.productId,
        code: p.code || p.productId,
        hasCustomId: Boolean(p.code),
        revenue: p.revenue,
        profit: p.profit,
        unknownCostLines: facts.unknownByProduct.get(p.productId) ?? 0,
        adsNoMarketer: adsNoMkByProduct.get(p.productId) ?? 0,
        assigned: assigned.has(p.productId),
      })),
    },
    `period=custom&from=${period.fromKey}&to=${period.toKey}`,
  );
}

/**
 * Lời KÝ XÁC NHẬN ĐỐI SOÁT (cấp 1) còn hiệu lực của một tháng — đọc THÔ bằng JSON.parse: `getSettingJson`
 * gộp mảng thành object (bài học Payroll V2 review vòng 5).
 */
export async function loadProfitSignoffs(monthKey?: string): Promise<ProfitReconSignoff[]> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_SIGNOFF_KEY)).limit(1);
  let all: unknown = [];
  try {
    all = row ? (JSON.parse(row.value) as unknown) : [];
  } catch {
    return [];
  }
  return (Array.isArray(all) ? (all as ProfitReconSignoff[]) : []).filter((c) => c && !c.revokedAt && (!monthKey || c.monthKey === monthKey));
}

/** Lời ký KHỚP đúng con số hiện tại của tháng (cùng dấu vân tay). */
export function matchingSignoff(signoffs: readonly ProfitReconSignoff[], recon: MonthReconciliation): ProfitReconSignoff | null {
  return signoffs.find((s) => s.monthKey === recon.monthKey && s.fingerprint === recon.fingerprint) ?? null;
}

export type ProfitReconReadiness = {
  /** Tháng có thưởng % lợi nhuận ĐỦ ĐIỀU KIỆN > 0 ⇒ bắt buộc duyệt hai cấp. */
  required: boolean;
  monthKey: string | null;
  recon: MonthReconciliation | null;
  signoff: ProfitReconSignoff | null;
};

/**
 * ĐIỀU KIỆN ĐỐI SOÁT CỦA MỘT BẢN TÍNH — một chỗ cho cả server (chốt kỳ) lẫn màn hình (nút chốt), để
 * hai nơi không nói hai điều khác nhau. Chỉ đo khi thật sự cần (có khoản đủ điều kiện): tháng không
 * có khoản nào thì không tốn thêm một câu truy vấn nào.
 */
export async function profitReconReadiness(report: PayrollReport): Promise<ProfitReconReadiness> {
  const monthKey = report.profitGate.result.monthKey;
  const required = Boolean(monthKey) && report.basis === "profit1" && (report.profitGate.result.allocatedTotal ?? 0) > 0;
  if (!required || !monthKey) return { required: false, monthKey: monthKey ?? null, recon: null, signoff: null };
  const [recon, signoffs] = await Promise.all([getMonthReconciliation(monthKey, { report }), loadProfitSignoffs(monthKey)]);
  return { required, monthKey, recon, signoff: matchingSignoff(signoffs, recon) };
}

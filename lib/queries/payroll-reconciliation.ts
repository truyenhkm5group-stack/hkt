/**
 * ═══════════ ĐỐI SOÁT LỢI NHUẬN TÍNH LƯƠNG THEO THÁNG — LỚP ĐỌC ═══════════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9. Phép dựng: `lib/payroll/profit-reconciliation.ts` (thuần).
 *
 * Hai vế đặt cạnh nhau, KHÔNG vế nào tính lại lợi nhuận:
 *  · cơ sở lương — `getPayrollReport(tháng, "profit1").marketers` (đúng con số bảng lương dùng);
 *  · nguồn       — `getRecognizedCosts()` (máy chi phí, memo cùng kỳ) + một lượt đo trên đơn của tháng
 *    bằng CHÍNH các biểu thức của cơ sở (`ORDER_OUTCOME_FAST`, `PRIMARY_ATTEMPT`, `LINE_UNIT_COST`,
 *    `REVENUE_RECOGNIZED_ON_DELIVERY`) — viết lại luật kết quả đơn ở đây là tạo nguồn sự thật thứ hai —
 *    và QC đo THẲNG trên `ad_spends` (không qua phép quy kết nào).
 *
 * Bảng của một kỳ đã TÍNH được chụp vào ảnh kỳ (`snapshot.profitRecon`); chữ ký cấp 1 ký đúng ảnh ấy.
 */
import { readSettingValue } from "@/lib/settings";
import { and, eq, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { ELIGIBLE_SENT_SQL } from "@/lib/constants/returns";
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { FINISHED_OUTCOMES_SQL, OUTCOME_GROUP, RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import type { OrderOutcome } from "@/lib/constants/returns";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { ON_COD_STATEMENT_SQL, shipmentCostSql, VTP_SHIPPING_FEE_SQL } from "@/lib/queries/shipping-cost";
import { getPayrollReport, monthReportPeriod, type PayrollReport } from "@/lib/queries/payroll";
import { loadCodeBook } from "@/lib/queries/payroll-code-ledger";
import { buildMonthReconciliation, type MonthReconciliation, type MonthReconInput } from "@/lib/payroll/profit-reconciliation";
import { PAYROLL_PROFIT_SIGNOFF_KEY, type ProfitReconSignoff } from "@/lib/constants/payroll-reconciliation";

const OPEN_OUTCOMES_SQL = (Object.keys(OUTCOME_GROUP) as OrderOutcome[])
  .filter((x) => OUTCOME_GROUP[x] === "OPEN")
  .map((x) => `'${x}'`)
  .join(",");
const CONFIRMED_SQL = CONFIRMED_STAGES.map((x) => `'${x}'`).join(",");

/**
 * CHỨNG TỪ TIỀN của một đơn: tiền trả trước / chuyển khoản / tiền mặt ghi trên đơn, hoặc COD thực thu > 0
 * trên bất kỳ vận đơn nào của đơn. Dùng chung cho bảng đối soát tháng và Trung tâm đối soát
 * (`payroll-recon-center.ts`) — một định nghĩa, không chép.
 */
export const MONEY_EVIDENCE_SQL = sql`(coalesce(${schema.orders.prepaid}, 0) + coalesce(${schema.orders.transferMoney}, 0) + coalesce(${schema.orders.cash}, 0) > 0 or exists (select 1 from shipments sh where sh.order_id = ${schema.orders.id} and coalesce(sh.cod_collected, 0) > 0))`;
/** Đơn ĐÃ GIAO và ĐƯỢC GHI NHẬN doanh thu — đúng điều kiện cơ sở lương dùng (cần nối vận đơn chính `PRIMARY_ATTEMPT`). */
export const DELIVERED_RECOGNIZED_SQL = sql`${ORDER_OUTCOME_FAST} = 'DELIVERED' and ${REVENUE_RECOGNIZED_ON_DELIVERY}`;

/** Một lượt đo trên đơn của tháng (theo ngày lên đơn — cùng mốc với cơ sở lương). */
export async function orderFacts(from: Date, to: Date): Promise<{ total: MonthReconInput["orders"]; unknownByProduct: Map<string, number> }> {
  const db = await getDb();
  const i = schema.orderItems;
  const o = schema.orders;
  const s = schema.shipments;
  const pv = schema.productVariants;
  const ky: SQL[] = [gte(o.insertedAt, from), lte(o.insertedAt, to)];
  const coTien = MONEY_EVIDENCE_SQL;
  const giao = DELIVERED_RECOGNIZED_SQL;
  const productKey = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
  const coMa = sql`${productKey} <> ''`;
  // Cùng biểu thức cước với cơ sở lương + máy chi phí (`shipping-cost.ts`): ghi nhận VTP, thiếu ⇒ ước tính có nhãn.
  const cuocVanDon = await shipmentCostSql();
  const cuoc = cuocVanDon.fee;
  const guiDi = sql`${ORDER_OUTCOME_FAST} in (${sql.raw(ELIGIBLE_SENT_SQL)})`;
  return chayKhongJit(db, async (tx) => {
    const [dong] = await tx
      .select({
        deliveredRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${giao} and ${i.isBonus} = false and ${coMa}), 0)`,
        deliveredRevenueNoProduct: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${giao} and ${i.isBonus} = false and not (${coMa})), 0)`,
        deliveredRevenueWithMoney: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${giao} and ${i.isBonus} = false and ${coMa} and ${coTien}), 0)`,
        openValue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(OPEN_OUTCOMES_SQL)}) and ${i.isBonus} = false and ${o.stage} in (${sql.raw(CONFIRMED_SQL)})), 0)`,
        settledValue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(FINISHED_OUTCOMES_SQL)}) and ${i.isBonus} = false), 0)`,
        unknownCostLines: sql<number>`count(*) filter (where ${giao} and ${coMa} and ${LINE_UNIT_COST} = 0)`,
        unknownCostRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${giao} and ${coMa} and ${LINE_UNIT_COST} = 0), 0)`,
        cogsNoProduct: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${giao} and not (${coMa})), 0)`,
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
        openOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(OPEN_OUTCOMES_SQL)}) and ${o.stage} in (${sql.raw(CONFIRMED_SQL)}))`,
        returnedOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
        cancelledOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'CANCELLED')`,
        sentOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(ELIGIBLE_SENT_SQL)}))`,
        sentNoFeeOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(ELIGIBLE_SENT_SQL)}) and ${cuoc} = 0)`,
        inTransitShipping: sql<number>`coalesce(sum(${cuoc}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(ELIGIBLE_SENT_SQL)}) and ${ORDER_OUTCOME_FAST} not in (${sql.raw(FINISHED_OUTCOMES_SQL)})), 0)`,
        // ĐỐI SOÁT CƯỚC CÙNG COD (chủ shop 21/10/2026): cước đã nằm trong bảng kê ⇒ số ĐÃ TÍNH TIỀN; cước VTP
        // chưa có bảng kê ⇒ ghi nhận nhưng CHƯA đối soát; còn lại là ƯỚC TÍNH.
        shipOnStatementOrders: sql<number>`count(*) filter (where ${guiDi} and ${VTP_SHIPPING_FEE_SQL} is not null and ${ON_COD_STATEMENT_SQL})`,
        shipOnStatement: sql<number>`coalesce(sum(${VTP_SHIPPING_FEE_SQL}) filter (where ${guiDi} and ${ON_COD_STATEMENT_SQL}), 0)`,
        shipVtpOnlyOrders: sql<number>`count(*) filter (where ${guiDi} and ${VTP_SHIPPING_FEE_SQL} is not null and not ${ON_COD_STATEMENT_SQL})`,
        shipVtpOnly: sql<number>`coalesce(sum(${VTP_SHIPPING_FEE_SQL}) filter (where ${guiDi} and not ${ON_COD_STATEMENT_SQL}), 0)`,
        shipEstimatedOrders: sql<number>`count(*) filter (where ${guiDi} and ${cuocVanDon.estimated} > 0)`,
        shipEstimated: sql<number>`coalesce(sum(${cuocVanDon.estimated}) filter (where ${guiDi}), 0)`,
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
      .where(and(...ky, giao, coMa, sql`${LINE_UNIT_COST} = 0`))
      .groupBy(sql`1`);
    const n = (v: unknown) => Number(v ?? 0);
    return {
      total: {
        deliveredRevenue: n(dong?.deliveredRevenue),
        deliveredRevenueNoProduct: n(dong?.deliveredRevenueNoProduct),
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
        cogsNoProduct: n(dong?.cogsNoProduct),
        inTransitShipping: n(don?.inTransitShipping),
        shipOnStatementOrders: n(don?.shipOnStatementOrders),
        shipOnStatement: n(don?.shipOnStatement),
        shipVtpOnlyOrders: n(don?.shipVtpOnlyOrders),
        shipVtpOnly: n(don?.shipVtpOnly),
        shipEstimatedOrders: n(don?.shipEstimatedOrders),
        shipEstimated: n(don?.shipEstimated),
        sentOrders: n(don?.sentOrders),
        sentNoFeeOrders: n(don?.sentNoFeeOrders),
      },
      unknownByProduct: new Map(theoMa.map((x) => [x.productId, n(x.n)] as const)),
    };
  });
}

/** QC của kỳ đo THẲNG trên `ad_spends` (ngày chi, không bị loại): bốn ô mã × người, và ô "chưa gán" theo mã. */
async function adsRaw(from: Date, to: Date) {
  const db = await getDb();
  const a = schema.adSpends;
  const rows = await db
    .select({
      coMa: sql<boolean>`${a.productId} is not null`,
      coNguoi: sql<boolean>`${a.marketerId} is not null`,
      spend: sql<number>`coalesce(sum(${a.spend}), 0)`,
    })
    .from(a)
    .where(and(eq(a.excluded, false), gte(a.spendDate, from), lte(a.spendDate, to)))
    .groupBy(sql`1`, sql`2`);
  const o = (ma: boolean, nguoi: boolean) => Number(rows.find((r) => Boolean(r.coMa) === ma && Boolean(r.coNguoi) === nguoi)?.spend ?? 0);
  const noMk = await db
    .select({ productId: a.productId, spend: sql<number>`coalesce(sum(${a.spend}), 0)` })
    .from(a)
    .where(and(eq(a.excluded, false), gte(a.spendDate, from), lte(a.spendDate, to), isNotNull(a.productId), isNull(a.marketerId)))
    .groupBy(a.productId);
  return {
    split: { codeWithMarketer: o(true, true), codeNoMarketer: o(true, false), testWithMarketer: o(false, true), testNoMarketer: o(false, false) },
    noMarketerByProduct: new Map(noMk.map((x) => [x.productId as string, Number(x.spend)] as const)),
  };
}

/**
 * ĐỐI SOÁT MỘT THÁNG LỊCH. `given.report` = bản tính bảng lương đã có của đúng tháng ấy (tránh tính
 * lại khi người gọi đã có — chốt kỳ, trang đối soát).
 */
export async function getMonthReconciliation(monthKey: string, given?: { report: PayrollReport }): Promise<MonthReconciliation> {
  const period = monthReportPeriod(monthKey);
  const from = period.from as Date;
  const to = period.to as Date;
  const [report, engine, facts, ads, book] = await Promise.all([
    given ? Promise.resolve(given.report) : getPayrollReport(period, "profit1"),
    getRecognizedCosts(period),
    orderFacts(from, to),
    adsRaw(from, to),
    loadCodeBook(from, to),
  ]);
  const m = report.marketers;
  const t = m.totals;
  const assigned = new Set(book.assignments.map((a) => a.productId));
  const la = engine.logisticsAdjustment;
  const excl = t.basisExclusions ?? [];
  return buildMonthReconciliation(
    {
      monthKey,
      basis: {
        revenue: m.products.reduce((s, p) => s + p.revenue, 0),
        cogs: m.products.reduce((s, p) => s + p.cogs, 0),
        adsCode: m.products.reduce((s, p) => s + p.adSpend, 0),
        adsTest: t.testSpend,
        adsCodeInPersonLines: m.marketers.reduce((s, mk) => s + mk.products.reduce((u, pl) => u + pl.adSpend, 0), 0),
        // `t.shipping` của từng mã đã gồm phí chiều hoàn gắn được mã ⇒ tách ra để so với máy chi phí riêng.
        shippingPerShipment: t.shipping - t.logisticsAdjustment - t.returnLeg.toCodes,
        returnLegToCodes: t.returnLeg.toCodes,
        returnLegShared: t.returnLeg.shared,
        logisticsAdjustment: t.logisticsAdjustment,
        logisticsAdjustmentUnallocated: t.logisticsAdjustmentUnallocated,
        operatingEntered: t.operatingEntered,
        fixedCostAssumption: t.fixedCost,
        perOrderOpsEstimate: t.perOrderOps,
        sharedUnallocated: t.sharedUnallocated,
        profit: t.profit,
        basisExclusionMeasured: excl.filter((x) => x.confidence === "MEASURED").reduce((s, x) => s + x.amount, 0),
        basisExclusionEstimated: excl.filter((x) => x.confidence === "ESTIMATED").reduce((s, x) => s + x.amount, 0),
      },
      adsRaw: ads.split,
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
        adsNoMarketer: ads.noMarketerByProduct.get(p.productId) ?? 0,
        assigned: assigned.has(p.productId),
      })),
    },
    `period=custom&from=${period.fromKey}&to=${period.toKey}`,
  );
}

/**
 * Chữ ký đối soát cấp 1 — đọc THÔ bằng JSON.parse: `getSettingJson` gộp mảng thành object (bài học
 * Payroll V2 review vòng 5). Mặc định chỉ chữ ký CÒN HIỆU LỰC.
 */
export async function loadProfitSignoffs(monthKey?: string, opts: { includeRevoked?: boolean } = {}): Promise<ProfitReconSignoff[]> {
  // Đọc thô qua lib/settings (dùng chung lượt đọc trong withSettingsScope — OD-UX-05 3c). Đường đọc TRONG giao dịch (khoá
  // dòng lúc ký) giữ nguyên `tx.select` ở lib/payroll/recon-signoff.ts — không đi qua phạm vi.
  return parseSignoffs(await readSettingValue(PAYROLL_PROFIT_SIGNOFF_KEY)).filter((c) => (opts.includeRevoked || !c.revokedAt) && (!monthKey || c.monthKey === monthKey));
}

/** Đọc ô settings chữ ký — dùng chung cho đường đọc thường và đường đọc TRONG giao dịch. Ô hỏng ⇒ rỗng (chặn duyệt). */
export function parseSignoffs(value: string | null): ProfitReconSignoff[] {
  if (!value) return [];
  try {
    const all = JSON.parse(value) as unknown;
    return Array.isArray(all) ? (all as ProfitReconSignoff[]).filter((c) => c && typeof c.fingerprint === "string") : [];
  } catch {
    return [];
  }
}

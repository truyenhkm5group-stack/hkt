import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CONFIRMED_STAGES } from "@/lib/queries/expenses";
import { memo, periodKey } from "@/lib/cache";
import { DEFAULT_PROFIT_ASSUMPTIONS, FALLBACK_SHIP_FEE_DELIVERED, fixedCostForPeriod, opsCosts, periodMonths, PROFIT_ASSUMPTIONS_KEY, type ProfitAssumptions } from "@/lib/constants/profit";
import { failedToReturnRate, ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
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

function periodCond(from: Date | null, to: Date | null): SQL[] {
  const conds: SQL[] = [];
  if (from) conds.push(gte(o.insertedAt, from));
  if (to) conds.push(lte(o.insertedAt, to));
  return conds;
}

export type ResolvedAssumptions = ProfitAssumptions & {
  shipFeeDeliveredUsed: number;
  shipFeeReturnedUsed: number;
  shipFeeSource: "setting" | "data" | "fallback";
  /** Phí hoàn về bình quân đọc được từ dữ liệu (đơn hoàn có return_fee > 0), 0 = chưa có dữ liệu */
  returnFeeFromData: number;
  /** Số đơn hoàn 90 ngày có ghi phí hoàn về */
  returnFeeSample: number;
};

/**
 * Đọc giả định + tự tính cước từ dữ liệu 90 ngày cho ô để trống:
 *  - cước gửi/đơn: bình quân cước ĐVVC của đơn đã giao (Pancake partner_fee / shipments.shipping_fee), không có thì 17.000đ;
 *  - cước đơn hoàn: cước gửi + phí hoàn về bình quân của các đơn hoàn CÓ ghi phí hoàn; Pancake/Viettel Post webhook không đẩy phí hoàn nên
 *    thường bằng 0 → giả định phí hoàn về = cước gửi (đơn hoàn tốn gấp đôi). Nhập tay ở "Sửa giả định" nếu hợp đồng VTP khác.
 */
export async function resolveAssumptions(): Promise<ResolvedAssumptions> {
  const db = await getDb();
  const saved = await getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS);
  let shipFeeDeliveredUsed = Math.max(0, Number(saved.shipFeeDelivered) || 0);
  let shipFeeReturnedUsed = Math.max(0, Number(saved.shipFeeReturned) || 0);
  let shipFeeSource: ResolvedAssumptions["shipFeeSource"] = "setting";
  let returnFeeFromData = 0;
  let returnFeeSample = 0;
  if (!shipFeeDeliveredUsed || !shipFeeReturnedUsed) {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const [row] = await db
      .select({
        delivered: sql<number>`avg(nullif(coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}), 0)) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        returnFee: sql<number>`avg(nullif(${o.returnFee}, 0)) filter (where ${IS_RETURNED})`,
        returnFeeSample: sql<number>`count(*) filter (where ${IS_RETURNED} and ${o.returnFee} > 0)`,
      })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(gte(o.insertedAt, since));
    const d = Math.round(Number(row?.delivered ?? 0));
    returnFeeFromData = Math.round(Number(row?.returnFee ?? 0));
    returnFeeSample = Number(row?.returnFeeSample ?? 0);
    if (!shipFeeDeliveredUsed) {
      shipFeeDeliveredUsed = d || FALLBACK_SHIP_FEE_DELIVERED;
      shipFeeSource = d ? "data" : "fallback";
    }
    if (!shipFeeReturnedUsed) {
      shipFeeReturnedUsed = shipFeeDeliveredUsed + (returnFeeFromData || shipFeeDeliveredUsed);
      if (shipFeeSource === "setting") shipFeeSource = returnFeeFromData ? "data" : "fallback";
    }
  }
  return { ...saved, shipFeeDeliveredUsed, shipFeeReturnedUsed, shipFeeSource, returnFeeFromData, returnFeeSample };
}

/** Trạng thái hành trình cho biết đã từng phát không thành (Pancake: "Tồn - …", "Phát tiếp"; Viettel Post: 505/506/507/508) */
const FAILED_EVENT = sql`(${schema.shipmentEvents.status} ilike 'Tồn%' or ${schema.shipmentEvents.status} ilike 'Phát tiếp%' or ${schema.shipmentEvents.status} in ('505','506','507','508'))`;

/** Số đơn "cứu được": đã từng phát không thành nhưng cuối cùng giao thành công, gộp theo mã hàng (đơn đã xác nhận lên trong kỳ) */
export async function rescuedOrdersByProduct(period: Period): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .select({
      productId: sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`,
      rescued: sql<number>`count(distinct ${o.id})`,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .innerJoin(s, eq(s.orderId, o.id))
    .leftJoin(pv, eq(pv.id, i.variantId))
    .where(
      and(
        eq(i.isBonus, false),
        inArray(o.stage, [...CONFIRMED_STAGES]),
        eq(s.stage, "DELIVERED"),
        sql`exists (select 1 from ${schema.shipmentEvents} where ${schema.shipmentEvents.shipmentId} = ${s.id} and ${FAILED_EVENT})`,
        ...periodCond(period.from, period.to),
      ),
    )
    .groupBy(sql`1`);
  return new Map(rows.filter((r) => r.productId).map((r) => [r.productId, Number(r.rescued)]));
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
  /** Tỷ lệ hoàn ước tính (%) đã trộn: đơn đã hoàn + đơn chờ xử lý / chờ phát lại × xác suất thành hoàn + đơn đang giao / chưa gửi × tỷ lệ lịch sử */
  returnRate: number;
  returnRateSource: "override" | "history" | "default";
  /** Tỷ lệ hoàn lịch sử / mặc định dùng cho phần đơn chưa có kết quả (%) */
  baseReturnRate: number;
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
  /** Giao thất bại, chờ xử lý / chờ phát lại (nằm trong inTransit) */
  failed: number;
  pending: number;
  actualRevenue: number;
  /** Chi phí vận hành đã nhập ở bảng Chi phí trong kỳ, phân bổ theo tỷ trọng doanh số POS */
  operatingAlloc: number;
  /** Đơn giao thất bại rồi giao thành công (nhân viên vận đơn cứu được) */
  rescued: number;
  /** Chi phí đóng hàng = đơn gửi × đơn giá đóng hàng */
  packingCost: number;
  /** Chi phí nhân viên vận đơn = đơn × đơn giá + đơn cứu được × thưởng */
  opsStaffCost: number;
  /** Chi phí cố định (văn phòng, điện nước…) của kỳ phân bổ theo tỷ trọng doanh số POS */
  fixedAlloc: number;
  /** Tổng vận hành = CP vận hành đã nhập + đóng hàng + nhân viên vận đơn + cố định */
  opexTotal: number;
  /** Tổng vận hành / đơn lên (trước hoàn huỷ) */
  opexPerOrder: number | null;
  /** Tổng vận hành / đơn giao thành công ước tính (sau hoàn huỷ) */
  opexPerDelivered: number | null;
  /** Hàng nhập trong kỳ theo phiếu nhập (số lượng, giá trị) */
  purchaseQty: number;
  purchaseCost: number;
  /** Dự phòng rủi ro tồn kho = tổng giá trị hàng nhập trong kỳ × % giả định */
  inventoryRisk: number;
  /** LN theo tổng giá trị hàng nhập = DT GTC ƯT − CPQC − hàng nhập − VC − vận hành − rủi ro TK − thuế − CP khác */
  profitOnPurchase: number;
  marginOnPurchase: number | null;
  /** Dự trù thuế = DT GTC ước tính × % */
  tax: number;
  /** Chi phí khác = CPQC × % (phí thanh toán thẻ ngoại tệ…) */
  otherCost: number;
  /** LN ròng ước tính = LN danh nghĩa − tổng vận hành (đã nhập + đóng hàng + NV vận đơn + cố định) − rủi ro tồn kho − thuế − chi phí khác */
  netProfit: number;
  netMargin: number | null;
};

export type NominalReport = {
  assumptions: ResolvedAssumptions;
  rows: NominalRow[];
  unmatchedAdSpend: number;
  /** Chi phí vận hành trong kỳ (bảng Chi phí, trừ Quảng cáo & Nhập hàng): lương, mặt bằng, phần mềm, đóng gói… */
  operatingExpenses: number;
  /** Số khoản chi vận hành trong kỳ */
  operatingCount: number;
  /** Số tháng của kỳ dùng quy đổi chi phí cố định (kỳ "Toàn bộ" tính từ đơn đầu tiên tới đơn cuối) */
  periodMonths: number;
  /** Chi phí cố định của kỳ = chi phí tháng × số tháng */
  fixedCost: number;
  totals: {
    orders: number;
    items: number;
    grossSales: number;
    adSpend: number;
    expectedRevenue: number;
    expectedCogs: number;
    shipCost: number;
    expectedProfit: number;
    margin: number | null;
    delivered: number;
    returned: number;
    inTransit: number;
    actualRevenue: number;
    weightedReturnRate: number | null;
    operatingExpenses: number;
    rescued: number;
    packingCost: number;
    opsStaffCost: number;
    fixedCost: number;
    opexTotal: number;
    inventoryRisk: number;
    netProfit: number;
    failed: number;
    pending: number;
    tax: number;
    otherCost: number;
    opexPerOrder: number | null;
    opexPerDelivered: number | null;
    failedToReturnPct: number;
    purchaseQty: number;
    purchaseCost: number;
    profitOnPurchase: number;
    marginOnPurchase: number | null;
    netMargin: number | null;
  };
};

function applyAssumptions(base: { orders: number; items: number; grossSales: number; cogsFull: number; adSpend: number }, rate: number, a: ResolvedAssumptions) {
  const r = Math.min(Math.max(rate, 0), 100) / 100;
  const expectedRevenue = Math.round(base.grossSales * (1 - r));
  const expectedCogs = Math.round(base.cogsFull * (1 - r));
  const shipCost = Math.round(base.orders * ((1 - r) * a.shipFeeDeliveredUsed + r * a.shipFeeReturnedUsed));
  const expectedProfit = expectedRevenue - expectedCogs - shipCost - base.adSpend;
  return { expectedRevenue, expectedCogs, shipCost, expectedProfit, margin: expectedRevenue ? (expectedProfit / expectedRevenue) * 100 : null };
}

/** Hàng nhập trong kỳ theo phiếu nhập (kind RECEIPT, số lượng dương) gộp theo mã */
export async function purchaseByProduct(period: Period): Promise<Map<string, { qty: number; cost: number; name: string; code: string }>> {
  const db = await getDb();
  const conds: SQL[] = [eq(schema.stockReceipts.kind, "RECEIPT"), sql`${schema.stockReceiptItems.quantity} > 0`];
  if (period.from) conds.push(gte(schema.stockReceipts.receivedAt, period.from));
  if (period.to) conds.push(lte(schema.stockReceipts.receivedAt, period.to));
  const rows = await db
    .select({ productId: pv.productId, name: sql<string>`max(${p.name})`, code: sql<string>`max(coalesce(${p.customId}, ''))`, qty: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)`, cost: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity} * ${schema.stockReceiptItems.unitCost}), 0)` })
    .from(schema.stockReceiptItems)
    .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
    .innerJoin(pv, eq(pv.id, schema.stockReceiptItems.variantId))
    .leftJoin(p, eq(p.id, pv.productId))
    .where(and(...conds))
    .groupBy(pv.productId);
  return new Map(rows.filter((r) => r.productId).map((r) => [r.productId as string, { qty: Number(r.qty), cost: Number(r.cost), name: r.name ?? "", code: r.code ?? "" }]));
}

/** Lợi nhuận danh nghĩa theo mã hàng: đơn lên trong kỳ × (1 − tỷ lệ hoàn ước tính) − giá vốn − vận chuyển − quảng cáo */
async function getNominalProfitReportUncached(period: Period): Promise<NominalReport> {
  const db = await getDb();
  const assumptions = await resolveAssumptions();
  const [history, failedProb, purchases, rescuedMap] = await Promise.all([productReturnHistory(assumptions.returnRateWindowDays), failedToReturnRate(), purchaseByProduct(period), rescuedOrdersByProduct(period)]);
  const pFail = assumptions.failedToReturnPercent > 0 ? Math.min(1, assumptions.failedToReturnPercent / 100) : failedProb.rate;
  const taxPct = Math.max(0, Number(assumptions.taxPercent ?? 0)) / 100;
  const otherPct = Math.max(0, Number(assumptions.otherCostPercentOfAds ?? 0)) / 100;
  const adConds: SQL[] = [eq(ads.excluded, false)];
  if (period.from) adConds.push(gte(ads.spendDate, period.from));
  if (period.to) adConds.push(lte(ads.spendDate, period.to));

  const expConds: SQL[] = [sql`${schema.expenses.category} not in ('ADS','PURCHASE')`];
  if (period.from) expConds.push(gte(schema.expenses.occurredAt, period.from));
  if (period.to) expConds.push(lte(schema.expenses.occurredAt, period.to));

  const [sales, adRows, [expRow]] = await Promise.all([
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
        failed: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT' and ${s.stage} = 'DELIVERY_FAILED')`,
        actualRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
        firstAt: sql<string | null>`min(${o.insertedAt}) filter (where ${NOT_CANCELLED})`,
        lastAt: sql<string | null>`max(${o.insertedAt}) filter (where ${NOT_CANCELLED})`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, eq(s.orderId, o.id))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .leftJoin(p, eq(p.id, sql`coalesce(${pv.productId}, ${i.productId})`))
      // chỉ tính đơn đã xác nhận trên Pancake (bỏ đơn mới / chờ xác nhận / huỷ)
      .where(and(eq(i.isBonus, false), inArray(o.stage, [...CONFIRMED_STAGES]), ...periodCond(period.from, period.to)))
      .groupBy(sql`1`),
    db
      .select({ productId: ads.productId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
      .from(ads)
      .where(and(...adConds))
      .groupBy(ads.productId),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.expenses.amount}), 0)`, count: sql<number>`count(*)` })
      .from(schema.expenses)
      .where(and(...expConds)),
  ]);
  const operatingExpenses = Number(expRow?.amount ?? 0);
  const operatingCount = Number(expRow?.count ?? 0);
  const riskPct = Math.min(Math.max(Number(assumptions.inventoryRiskPercent ?? 0), 0), 100) / 100;
  // kỳ "Toàn bộ" / thiếu mốc: lấy từ đơn đầu tiên tới đơn cuối (hoặc hôm nay nếu kỳ chưa kết thúc)
  const toDate = (v: string | Date | null | undefined) => (v ? new Date(v) : null);
  const firstAt = sales.map((r) => toDate(r.firstAt)).filter((d): d is Date => !!d && !Number.isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const lastAt = sales.map((r) => toDate(r.lastAt)).filter((d): d is Date => !!d && !Number.isNaN(d.getTime())).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const now = new Date();
  const monthsFrom = period.from ?? firstAt;
  const monthsTo = period.to ? (period.to.getTime() > now.getTime() ? now : period.to) : lastAt && lastAt.getTime() > now.getTime() ? lastAt : now;
  const months = monthsFrom ? Math.round(periodMonths(monthsFrom, monthsTo) * 100) / 100 : 0;
  const fixedCost = fixedCostForPeriod(Number(assumptions.fixedCostMonthly ?? 0), months);
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
      // trộn theo trạng thái thực tế: đã hoàn = 100%, đã giao = 0%, chờ xử lý / chờ phát lại = xác suất thành hoàn, còn lại = tỷ lệ lịch sử
      const delivered = Number(r.delivered);
      const returned = Number(r.returned);
      const failed = Number(r.failed);
      const unknown = Math.max(0, base.orders - delivered - returned - failed);
      const baseReturnRate = returnRate;
      const blended = base.orders ? ((returned + failed * pFail + unknown * (baseReturnRate / 100)) / base.orders) * 100 : baseReturnRate;
      returnRate = Math.round(blended * 10) / 10;
      const calc = applyAssumptions(base, returnRate, assumptions);
      return {
        productId: r.productId,
        productName: r.productName ?? "",
        code: r.code ?? "",
        image: r.image,
        ...base,
        returnRate,
        returnRateSource,
        baseReturnRate,
        historyFinished: h?.finished ?? 0,
        ...calc,
        cpo: base.orders ? base.adSpend / base.orders : null,
        revenuePerOrder: base.orders ? calc.expectedRevenue / base.orders : null,
        delivered: Number(r.delivered),
        returned: Number(r.returned),
        inTransit: Number(r.inTransit),
        failed,
        pending: Number(r.pending),
        actualRevenue: Number(r.actualRevenue),
        operatingAlloc: 0,
        rescued: Math.min(rescuedMap.get(r.productId) ?? 0, base.orders),
        ...opsCosts({ orders: base.orders, rescued: rescuedMap.get(r.productId) ?? 0 }, assumptions),
        fixedAlloc: 0,
        opexTotal: 0,
        opexPerOrder: null,
        opexPerDelivered: null,
        purchaseQty: purchases.get(r.productId)?.qty ?? 0,
        purchaseCost: purchases.get(r.productId)?.cost ?? 0,
        inventoryRisk: Math.round((purchases.get(r.productId)?.cost ?? 0) * riskPct),
        profitOnPurchase: 0,
        marginOnPurchase: null,
        tax: Math.round(calc.expectedRevenue * taxPct),
        otherCost: Math.round(base.adSpend * otherPct),
        netProfit: 0,
        netMargin: null,
      };
    })
    .sort((a, b) => b.expectedProfit - a.expectedProfit);
  // mã có nhập hàng trong kỳ nhưng chưa có đơn → vẫn hiện để tính lợi nhuận theo hàng nhập
  for (const [pid, pur] of purchases) {
    if (rows.some((r) => r.productId === pid)) continue;
    rows.push({
      productId: pid, productName: pur.name || pid, code: pur.code, image: null, orders: 0, items: 0, grossSales: 0, adSpend: adByProduct.get(pid) ?? 0,
      returnRate: 0, returnRateSource: "default", baseReturnRate: 0, historyFinished: 0, expectedRevenue: 0, expectedCogs: 0, shipCost: 0, expectedProfit: -(adByProduct.get(pid) ?? 0), margin: null, cpo: null, revenuePerOrder: null,
      delivered: 0, returned: 0, inTransit: 0, failed: 0, pending: 0, actualRevenue: 0, operatingAlloc: 0, rescued: 0, packingCost: 0, opsStaffCost: 0, fixedAlloc: 0, opexTotal: 0, opexPerOrder: null, opexPerDelivered: null,
      purchaseQty: pur.qty, purchaseCost: pur.cost, inventoryRisk: Math.round(pur.cost * riskPct), profitOnPurchase: 0, marginOnPurchase: null, tax: 0, otherCost: Math.round((adByProduct.get(pid) ?? 0) * otherPct), netProfit: 0, netMargin: null,
    });
  }
  // phân bổ chi phí vận hành đã nhập + chi phí cố định theo tỷ trọng doanh số POS, rồi tính LN ròng từng mã
  const grossAll = rows.reduce((t, r) => t + r.grossSales, 0);
  for (const r of rows) {
    r.operatingAlloc = grossAll ? Math.round((operatingExpenses * r.grossSales) / grossAll) : 0;
    r.fixedAlloc = grossAll ? Math.round((fixedCost * r.grossSales) / grossAll) : 0;
    r.opexTotal = r.operatingAlloc + r.packingCost + r.opsStaffCost + r.fixedAlloc;
    r.profitOnPurchase = r.expectedRevenue - r.adSpend - r.purchaseCost - r.shipCost - r.opexTotal - r.inventoryRisk - r.tax - r.otherCost;
    r.marginOnPurchase = r.expectedRevenue ? (r.profitOnPurchase / r.expectedRevenue) * 100 : null;
    r.opexPerOrder = r.orders ? Math.round(r.opexTotal / r.orders) : null;
    const expectedDelivered = r.orders * (1 - Math.min(Math.max(r.returnRate, 0), 100) / 100);
    r.opexPerDelivered = expectedDelivered > 0 ? Math.round(r.opexTotal / expectedDelivered) : null;
    r.netProfit = r.expectedProfit - r.opexTotal - r.inventoryRisk - r.tax - r.otherCost;
    r.netMargin = r.expectedRevenue ? (r.netProfit / r.expectedRevenue) * 100 : null;
  }

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
      rescued: t.rescued + r.rescued,
      packingCost: t.packingCost + r.packingCost,
      opsStaffCost: t.opsStaffCost + r.opsStaffCost,
      inventoryRisk: t.inventoryRisk + r.inventoryRisk,
      failed: t.failed + r.failed,
      pending: t.pending + r.pending,
      tax: t.tax + r.tax,
      otherCost: t.otherCost + r.otherCost,
      purchaseQty: t.purchaseQty + r.purchaseQty,
      purchaseCost: t.purchaseCost + r.purchaseCost,
    }),
    { orders: 0, items: 0, grossSales: 0, adSpend: 0, expectedRevenue: 0, expectedCogs: 0, shipCost: 0, expectedProfit: 0, delivered: 0, returned: 0, inTransit: 0, actualRevenue: 0, weightedReturn: 0, rescued: 0, packingCost: 0, opsStaffCost: 0, inventoryRisk: 0, failed: 0, pending: 0, tax: 0, otherCost: 0, purchaseQty: 0, purchaseCost: 0 },
  );
  const adSpendAll = totals.adSpend + unmatchedAdSpend;
  const otherCostAll = totals.otherCost + Math.round(unmatchedAdSpend * otherPct);
  const expectedProfitAll = totals.expectedProfit - unmatchedAdSpend;
  const opexTotal = operatingExpenses + totals.packingCost + totals.opsStaffCost + fixedCost;
  const netProfit = expectedProfitAll - opexTotal - totals.inventoryRisk - totals.tax - otherCostAll;
  const profitOnPurchase = totals.expectedRevenue - adSpendAll - totals.purchaseCost - totals.shipCost - opexTotal - totals.inventoryRisk - totals.tax - otherCostAll;
  const expectedDeliveredAll = rows.reduce((t, r) => t + r.orders * (1 - Math.min(Math.max(r.returnRate, 0), 100) / 100), 0);
  return {
    assumptions,
    rows,
    unmatchedAdSpend,
    operatingExpenses,
    operatingCount,
    periodMonths: months,
    fixedCost,
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
      operatingExpenses,
      rescued: totals.rescued,
      packingCost: totals.packingCost,
      opsStaffCost: totals.opsStaffCost,
      fixedCost,
      opexTotal,
      inventoryRisk: totals.inventoryRisk,
      netProfit,
      netMargin: totals.expectedRevenue ? (netProfit / totals.expectedRevenue) * 100 : null,
      failed: totals.failed,
      pending: totals.pending,
      tax: totals.tax,
      otherCost: otherCostAll,
      opexPerOrder: totals.orders ? Math.round(opexTotal / totals.orders) : null,
      opexPerDelivered: expectedDeliveredAll > 0 ? Math.round(opexTotal / expectedDeliveredAll) : null,
      failedToReturnPct: Math.round(pFail * 100),
      purchaseQty: totals.purchaseQty,
      purchaseCost: totals.purchaseCost,
      profitOnPurchase,
      marginOnPurchase: totals.expectedRevenue ? (profitOnPurchase / totals.expectedRevenue) * 100 : null,
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

export async function getNominalProfitReport(period: Period) : Promise<NominalReport> {
  return memo(`getNominalProfitReport:${periodKey(period)}`, 120000, () => getNominalProfitReportUncached(period));
}

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;

function between(column: SQL | AnyPgColumn, from: Date | null, to: Date | null): SQL | undefined {
  const conds: SQL[] = [];
  if (from) conds.push(sql`${column} >= ${from.toISOString()}::timestamptz`);
  if (to) conds.push(sql`${column} <= ${to.toISOString()}::timestamptz`);
  return conds.length ? and(...conds) : undefined;
}

export type CashReport = {
  cashIn: { codPaidToBank: number; codPaidCount: number; prepaid: number; prepaidOrders: number; total: number };
  /** Bảng kê Viettel Post trong kỳ (theo ngày đối soát): tiền COD gộp, cước/dư nợ đã trừ, tiền thu về */
  statements: { count: number; codGross: number; feeTotal: number; net: number; shipmentsLinked: number };
  cashOut: { purchases: number; purchaseReceipts: number; shippingDelivered: number; shippingReturned: number; returnFees: number; shippingStatement: number; shippingMode: "statement" | "estimate"; adSpend: number; operating: number; total: number };
  net: number;
  pending: { codCollectedWaiting: number; codCollectedCount: number; codInTransit: number; inTransitCount: number };
  finished: { delivered: number; returned: number };
};

/**
 * Lợi nhuận thực theo dòng tiền trong kỳ:
 *  Tiền vào = tiền COD Viettel Post thực nhận theo bảng kê / đợt nhận tiền (theo ngày đối soát) + khách đã thanh toán trước của đơn giao thành công trong kỳ
 *  Tiền ra  = tiền nhập hàng (phiếu nhập trong kỳ) + cước ship / phí hoàn (theo bảng kê nếu có, không thì ước tính theo đơn kết thúc) + quảng cáo + chi phí vận hành
 */
export async function getCashProfitReport(period: Period): Promise<CashReport> {
  const db = await getDb();
  const finishedAt = sql`coalesce(${s.deliveredAt}, ${s.returnedAt}, ${s.vtpStatusDate}, ${o.lastUpdateStatusAt}, ${o.updatedAtExternal}, ${o.insertedAt})`;
  const FEE = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`;
  const b = schema.codBatches;
  const [[batchRows], [orderRows], [purchases], [adRows], [expenseRows], codWaiting, codTransit] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)`,
        net: sql<number>`coalesce(sum(${b.totalAmount}), 0)`,
        codGross: sql<number>`coalesce(sum(case when ${b.codGross} > 0 then ${b.codGross} else ${b.totalAmount} end), 0)`,
        feeTotal: sql<number>`coalesce(sum(${b.feeTotal}), 0)`,
        shipmentsLinked: sql<number>`coalesce(sum((select count(*) from shipments sh where sh.cod_batch_id = ${b.id})), 0)`,
      })
      .from(b)
      .where(between(b.receivedAt, period.from, period.to)),
    db
      .select({
        prepaid: sql<number>`coalesce(sum(${o.prepaid} + ${o.transferMoney} + ${o.cash}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
        prepaidOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and (${o.prepaid} + ${o.transferMoney} + ${o.cash}) > 0)`,
        shippingDelivered: sql<number>`coalesce(sum(${FEE}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
        shippingReturned: sql<number>`coalesce(sum(${FEE}) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')), 0)`,
        returnFees: sql<number>`coalesce(sum(${o.returnFee}) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')), 0)`,
        delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
      })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(and(sql`${ORDER_OUTCOME} in ('DELIVERED','RETURNED','RETURNED_BY_RULE')`, between(finishedAt, period.from, period.to))),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.stockReceipts.totalCost}), 0)`, count: sql<number>`count(*)` })
      .from(schema.stockReceipts)
      .where(and(eq(schema.stockReceipts.kind, "RECEIPT"), between(schema.stockReceipts.receivedAt, period.from, period.to))),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), between(schema.adSpends.spendDate, period.from, period.to))),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.expenses.amount}), 0)` })
      .from(schema.expenses)
      .where(and(sql`${schema.expenses.category} not in ('ADS','PURCHASE')`, between(schema.expenses.occurredAt, period.from, period.to))),
    db
      .select({ amount: sql<number>`coalesce(sum(${s.codAmount}), 0)`, count: sql<number>`count(*)` })
      .from(s)
      .where(inArray(s.codStatus, ["COLLECTED", "RECONCILED"])),
    db
      .select({ amount: sql<number>`coalesce(sum(${s.codAmount}), 0)`, count: sql<number>`count(*)` })
      .from(s)
      .where(and(eq(s.codStatus, "PENDING"), inArray(s.stage, ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERY_FAILED"]))),
  ]);
  const statements = {
    count: Number(batchRows?.count ?? 0),
    codGross: Number(batchRows?.codGross ?? 0),
    feeTotal: Number(batchRows?.feeTotal ?? 0),
    net: Number(batchRows?.net ?? 0),
    shipmentsLinked: Number(batchRows?.shipmentsLinked ?? 0),
  };
  const cashIn = {
    codPaidToBank: statements.net,
    codPaidCount: statements.count,
    prepaid: Number(orderRows?.prepaid ?? 0),
    prepaidOrders: Number(orderRows?.prepaidOrders ?? 0),
    total: 0,
  };
  cashIn.total = cashIn.codPaidToBank + cashIn.prepaid;
  const cashOut = {
    purchases: Number(purchases?.amount ?? 0),
    purchaseReceipts: Number(purchases?.count ?? 0),
    shippingDelivered: Number(orderRows?.shippingDelivered ?? 0),
    shippingReturned: Number(orderRows?.shippingReturned ?? 0),
    returnFees: Number(orderRows?.returnFees ?? 0),
    shippingStatement: statements.feeTotal,
    shippingMode: (statements.feeTotal > 0 ? "statement" : "estimate") as "statement" | "estimate",
    adSpend: Number(adRows?.amount ?? 0),
    operating: Number(expenseRows?.amount ?? 0),
    total: 0,
  };
  // Cước đã bị Viettel Post trừ ngay trên bảng kê (tiền vào là số thực nhận) → không trừ lần nữa; chỉ dùng ước tính khi kỳ chưa có bảng kê
  const shippingOut = cashOut.shippingMode === "statement" ? 0 : cashOut.shippingDelivered + cashOut.shippingReturned + cashOut.returnFees;
  cashOut.total = cashOut.purchases + shippingOut + cashOut.adSpend + cashOut.operating;
  return {
    cashIn,
    statements,
    cashOut,
    net: cashIn.total - cashOut.total,
    pending: { codCollectedWaiting: Number(codWaiting[0]?.amount ?? 0), codCollectedCount: Number(codWaiting[0]?.count ?? 0), codInTransit: Number(codTransit[0]?.amount ?? 0), inTransitCount: Number(codTransit[0]?.count ?? 0) },
    finished: { delivered: Number(orderRows?.delivered ?? 0), returned: Number(orderRows?.returned ?? 0) },
  };
}

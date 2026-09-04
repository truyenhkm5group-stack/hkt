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
  cashOut: { purchases: number; purchaseReceipts: number; shippingDelivered: number; shippingReturned: number; returnFees: number; adSpend: number; operating: number; total: number };
  net: number;
  pending: { codCollectedWaiting: number; codCollectedCount: number; codInTransit: number; inTransitCount: number };
  finished: { delivered: number; returned: number };
};

/**
 * Lợi nhuận thực theo dòng tiền trong kỳ:
 *  Tiền vào = COD Viettel Post đã chuyển về ngân hàng (theo ngày ghi nhận) + khách đã thanh toán trước của đơn giao thành công trong kỳ
 *  Tiền ra  = tiền nhập hàng (phiếu nhập trong kỳ) + cước ship / phí hoàn của đơn kết thúc trong kỳ + quảng cáo + chi phí vận hành
 */
export async function getCashProfitReport(period: Period): Promise<CashReport> {
  const db = await getDb();
  const finishedAt = sql`coalesce(${s.deliveredAt}, ${s.returnedAt}, ${s.vtpStatusDate}, ${o.lastUpdateStatusAt}, ${o.updatedAtExternal}, ${o.insertedAt})`;
  const FEE = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`;
  const [codPaid, [orderRows], [purchases], [adRows], [expenseRows], codWaiting, codTransit] = await Promise.all([
    db
      .select({ amount: sql<number>`coalesce(sum(${s.codCollected}), 0)`, count: sql<number>`count(*)` })
      .from(s)
      .where(and(eq(s.codStatus, "PAID_TO_BANK"), between(s.codPaidToBankAt, period.from, period.to))),
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
  const cashIn = {
    codPaidToBank: Number(codPaid[0]?.amount ?? 0),
    codPaidCount: Number(codPaid[0]?.count ?? 0),
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
    adSpend: Number(adRows?.amount ?? 0),
    operating: Number(expenseRows?.amount ?? 0),
    total: 0,
  };
  cashOut.total = cashOut.purchases + cashOut.shippingDelivered + cashOut.shippingReturned + cashOut.returnFees + cashOut.adSpend + cashOut.operating;
  return {
    cashIn,
    cashOut,
    net: cashIn.total - cashOut.total,
    pending: { codCollectedWaiting: Number(codWaiting[0]?.amount ?? 0), codCollectedCount: Number(codWaiting[0]?.count ?? 0), codInTransit: Number(codTransit[0]?.amount ?? 0), inTransitCount: Number(codTransit[0]?.count ?? 0) },
    finished: { delivered: Number(orderRows?.delivered ?? 0), returned: Number(orderRows?.returned ?? 0) },
  };
}

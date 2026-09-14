import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { COD_COLLECTABLE, ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";
import { getOperatingCost } from "@/lib/queries/cost-engine";

const o = schema.orders;
const s = schema.shipments;

function between(column: SQL | AnyPgColumn, from: Date | null, to: Date | null): SQL | undefined {
  const conds: SQL[] = [];
  if (from) conds.push(sql`${column} >= ${from.toISOString()}::timestamptz`);
  if (to) conds.push(sql`${column} <= ${to.toISOString()}::timestamptz`);
  return conds.length ? and(...conds) : undefined;
}

export type CashReport = {
  /**
   * Tiền khách TRẢ TRƯỚC (chuyển khoản / đặt cọc / tiền mặt lúc lên đơn) ghi theo NGÀY TIỀN THỰC
   * TRẢ — chủ shop chốt 11/09/2026. Pancake không có mốc thanh toán riêng: tiền trả trước được ghi
   * lúc lên đơn, nên mốc đó là `orders.inserted_at`. Dòng tiền không đợi giao hàng; giao hay hoàn
   * là chuyện của lợi nhuận (Báo cáo lợi nhuận / Chân lý tài chính phân bổ theo kỳ ĐƠN GIAO).
   *
   * `prepaidOnReturned`: phần trong số đó thuộc đơn đã hoàn — tiền ĐÃ vào, nhưng có thể phải hoàn
   * lại khách; ERP không có chứng từ hoàn tiền nên chỉ nêu, không trừ.
   */
  cashIn: { codPaidToBank: number; codPaidCount: number; prepaid: number; prepaidOrders: number; prepaidOnReturned: number; total: number };
  /** Bảng kê Viettel Post trong kỳ (theo ngày đối soát): tiền COD gộp, cước/dư nợ đã trừ, tiền thu về */
  statements: { count: number; codGross: number; feeTotal: number; net: number; shipmentsLinked: number };
  cashOut: { purchases: number; purchaseReceipts: number; shippingDelivered: number; shippingReturned: number; returnFees: number; shippingStatement: number; shippingMode: "statement" | "estimate"; adSpend: number; operating: number; total: number };
  net: number;
  pending: {
    codCollectedWaiting: number;
    codCollectedCount: number;
    codInTransit: number;
    inTransitCount: number;
    /**
     * SỐ DƯ TRẢ TRƯỚC: tiền khách đã trả cho những đơn CHƯA kết thúc (chưa giao, chưa hoàn, chưa
     * huỷ) tính tới cuối kỳ. Đã vào dòng tiền, chưa được phân bổ vào lợi nhuận kỳ nào — phần này
     * là nghĩa vụ giao hàng, không phải lãi.
     */
    prepaidUnallocated: number;
    prepaidUnallocatedCount: number;
  };
  finished: { delivered: number; returned: number };
};

/**
 * Lợi nhuận thực theo dòng tiền trong kỳ:
 *  Tiền vào = tiền COD Viettel Post thực nhận theo bảng kê / đợt nhận tiền (theo ngày đối soát) + khách đã thanh toán trước theo NGÀY TIỀN THỰC TRẢ (không đợi giao)
 *  Tiền ra  = tiền nhập hàng (phiếu nhập trong kỳ) + cước ship / phí hoàn (theo bảng kê nếu có, không thì ước tính theo đơn kết thúc) + quảng cáo + chi phí vận hành
 */
export async function getCashProfitReport(period: Period): Promise<CashReport> {
  const db = await getDb();
  const finishedAt = sql`coalesce(${s.deliveredAt}, ${s.returnedAt}, ${s.vtpStatusDate}, ${o.lastUpdateStatusAt}, ${o.updatedAtExternal}, ${o.insertedAt})`;
  const FEE = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`;
  const PREPAID_TOTAL = sql`(${o.prepaid} + ${o.transferMoney} + ${o.cash})`;
  /** Mốc tiền khách thực trả — xem chú thích `CashReport.cashIn`. */
  const prepaidPaidAt = o.insertedAt;
  const FINAL_OUTCOMES = sql`('DELIVERED','RETURNED','RETURNED_BY_RULE','CANCELLED')`;
  const b = schema.codBatches;
  const [[batchRows], [orderRows], [prepaidRows], [prepaidBalance], [purchases], [adRows], expenseRows, codWaiting, codTransit] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)`,
        net: sql<number>`coalesce(sum(${b.totalAmount}), 0)`,
        codGross: sql<number>`coalesce(sum(case when ${b.codGross} > 0 then ${b.codGross} else ${b.totalAmount} end), 0)`,
        feeTotal: sql<number>`coalesce(sum(${b.feeTotal}), 0)`,
        // `"cod_batches"."id"` viết nguyên, KHÔNG `${b.id}`: trong DANH SÁCH CỘT drizzle dựng cột
        // không kèm tên bảng, nên `${b.id}` ra chữ `"id"` và bám vào `sh.id` của chính truy vấn con
        // — điều kiện thành `sh.cod_batch_id = sh.id`, luôn sai, và số vận đơn đã ghép LUÔN bằng 0
        // mà không có lỗi nào. Xem khối chú thích trong lib/queries/finance-ledger.ts.
        shipmentsLinked: sql<number>`coalesce(sum((select count(*) from shipments sh where sh.cod_batch_id = "cod_batches"."id")), 0)`,
      })
      .from(b)
      .where(between(b.receivedAt, period.from, period.to)),
    db
      .select({
        shippingDelivered: sql<number>`coalesce(sum(${FEE}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED'), 0)`,
        shippingReturned: sql<number>`coalesce(sum(${FEE}) filter (where ${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE')), 0)`,
        returnFees: sql<number>`coalesce(sum(${o.returnFee}) filter (where ${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE')), 0)`,
        delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
        returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE'))`,
      })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(sql`${ORDER_OUTCOME_FAST} in ('DELIVERED','RETURNED','RETURNED_BY_RULE')`, between(finishedAt, period.from, period.to))),
    // TIỀN TRẢ TRƯỚC theo NGÀY TIỀN VỀ, không theo ngày kết thúc đơn. Đơn huỷ bị loại: Pancake vẫn
    // giữ số trả trước trên đơn huỷ nhưng không có chứng từ tiền đã về, nên không được tính là tiền vào.
    db
      .select({
        prepaid: sql<number>`coalesce(sum(${PREPAID_TOTAL}), 0)`,
        prepaidOrders: sql<number>`count(*)`,
        prepaidOnReturned: sql<number>`coalesce(sum(${PREPAID_TOTAL}) filter (where ${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE')), 0)`,
      })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(sql`${PREPAID_TOTAL} > 0`, sql`${ORDER_OUTCOME_FAST} <> 'CANCELLED'`, between(prepaidPaidAt, period.from, period.to))),
    // SỐ DƯ TRẢ TRƯỚC tính tới cuối kỳ: tiền đã về của đơn chưa kết thúc.
    db
      .select({ amount: sql<number>`coalesce(sum(${PREPAID_TOTAL}), 0)`, count: sql<number>`count(*)` })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(sql`${PREPAID_TOTAL} > 0`, sql`${ORDER_OUTCOME_FAST} not in ${FINAL_OUTCOMES}`, between(prepaidPaidAt, null, period.to))),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.stockReceipts.totalCost}), 0)`, count: sql<number>`count(*)` })
      .from(schema.stockReceipts)
      .where(and(eq(schema.stockReceipts.kind, "RECEIPT"), between(schema.stockReceipts.receivedAt, period.from, period.to))),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), between(schema.adSpends.spendDate, period.from, period.to))),
    // CÙNG một đường với mọi báo cáo khác: Profit Engine quyết định nguồn nào có thẩm quyền.
    getOperatingCost(period),
    db
      // COD_COLLECTABLE: vận đơn đã hoàn / huỷ thì tiền không bao giờ về, dù trạng thái COD chưa cập nhật.
      // Trang Đối soát COD đã lọc điều kiện này; trước đây báo cáo dòng tiền thì không nên hai trang lệch nhau.
      .select({ amount: sql<number>`coalesce(sum(${s.codAmount}), 0)`, count: sql<number>`count(*)` })
      .from(s)
      .where(and(inArray(s.codStatus, ["COLLECTED", "RECONCILED"]), COD_COLLECTABLE)),
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
    prepaid: Number(prepaidRows?.prepaid ?? 0),
    prepaidOrders: Number(prepaidRows?.prepaidOrders ?? 0),
    prepaidOnReturned: Number(prepaidRows?.prepaidOnReturned ?? 0),
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
    operating: expenseRows.amount,
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
    pending: {
      codCollectedWaiting: Number(codWaiting[0]?.amount ?? 0),
      codCollectedCount: Number(codWaiting[0]?.count ?? 0),
      codInTransit: Number(codTransit[0]?.amount ?? 0),
      inTransitCount: Number(codTransit[0]?.count ?? 0),
      prepaidUnallocated: Number(prepaidBalance?.amount ?? 0),
      prepaidUnallocatedCount: Number(prepaidBalance?.count ?? 0),
    },
    finished: { delivered: Number(orderRows?.delivered ?? 0), returned: Number(orderRows?.returned ?? 0) },
  };
}

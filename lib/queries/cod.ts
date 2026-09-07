import { and, count, eq, gte, inArray, lte, sql, sum } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { COD_COLLECTABLE } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

export type CodKpi = { count: number; amount: number; collected: number };

export type CodCashSummary = {
  /** Tiền COD đã về trong kỳ: theo bảng kê Viettel Post (COD gộp) nếu có, không thì theo vận đơn đã đánh dấu về ngân hàng */
  codPaid: { amount: number; count: number; batches: { count: number; gross: number; fee: number; net: number }; source: "statements" | "shipments" };
  /** Đã thu chờ về = COD các vận đơn đã thu / đã đối soát (chưa hoàn) − phần bảng kê đã về nhưng chưa gắn vận đơn */
  codWaiting: { amount: number; count: number; collected: number; deductedByStatements: number };
  /** Tiền COD thực nhận trong kỳ (sau cước theo bảng kê) */
  cashInCod: number;
};

/**
 * Tiền COD đã về / chờ về dùng chung cho Tổng quan, Báo cáo lợi nhuận, Đối soát COD.
 * Bảng kê Viettel Post thường nhập gộp theo đợt (không gắn từng vận đơn) nên "đã về" lấy theo bảng kê, và phần bảng kê
 * chưa gắn được trừ khỏi "đã thu chờ về" để không đếm hai lần.
 */
export async function codCashSummary(period: Period): Promise<CodCashSummary> {
  const db = await getDb();
  const s = schema.shipments;
  const b = schema.codBatches;
  const [[shipPaid], [collected], [batchesInPeriod], [batchesToDate], [linkedPaidToDate]] = await Promise.all([
    db
      .select({ amount: sum(s.codCollected), count: count() })
      .from(s)
      .where(and(eq(s.codStatus, "PAID_TO_BANK"), period.from ? gte(s.codPaidToBankAt, period.from) : undefined, period.to ? lte(s.codPaidToBankAt, period.to) : undefined)),
    db
      .select({ amount: sum(s.codAmount), count: count() })
      .from(s)
      .where(and(inArray(s.codStatus, ["COLLECTED", "RECONCILED"]), COD_COLLECTABLE)),
    db
      .select({ count: count(), gross: sql<number>`coalesce(sum(coalesce(nullif(${b.codGross}, 0), ${b.totalAmount})), 0)`, fee: sql<number>`coalesce(sum(${b.feeTotal}), 0)`, net: sql<number>`coalesce(sum(${b.totalAmount}), 0)` })
      .from(b)
      .where(and(period.from ? gte(b.receivedAt, period.from) : undefined, period.to ? lte(b.receivedAt, period.to) : undefined)),
    db
      .select({ gross: sql<number>`coalesce(sum(coalesce(nullif(${b.codGross}, 0), ${b.totalAmount})), 0)` })
      .from(b)
      .where(period.to ? lte(b.receivedAt, period.to) : undefined),
    db
      .select({ amount: sql<number>`coalesce(sum(${s.codCollected}), 0)` })
      .from(s)
      .where(and(eq(s.codStatus, "PAID_TO_BANK"), period.to ? lte(s.codPaidToBankAt, period.to) : undefined)),
  ]);
  const paidByShipments = Number(shipPaid?.amount ?? 0);
  const batches = { count: Number(batchesInPeriod?.count ?? 0), gross: Number(batchesInPeriod?.gross ?? 0), fee: Number(batchesInPeriod?.fee ?? 0), net: Number(batchesInPeriod?.net ?? 0) };
  const unlinkedToDate = Math.max(0, Number(batchesToDate?.gross ?? 0) - Number(linkedPaidToDate?.amount ?? 0));
  const collectedAmount = Number(collected?.amount ?? 0);
  const useStatements = batches.gross > paidByShipments;
  return {
    codPaid: { amount: Math.max(paidByShipments, batches.gross), count: Number(shipPaid?.count ?? 0), batches, source: useStatements ? "statements" : "shipments" },
    codWaiting: { amount: Math.max(0, collectedAmount - unlinkedToDate), count: Number(collected?.count ?? 0), collected: collectedAmount, deductedByStatements: Math.min(collectedAmount, unlinkedToDate) },
    cashInCod: useStatements ? batches.net : paidByShipments,
  };
}

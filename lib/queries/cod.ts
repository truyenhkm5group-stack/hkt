import { and, count, desc, eq, gte, inArray, lte, ne, sql, sum, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { CodStatus } from "@/db/schema";
import { codStatusesFromFilter } from "@/lib/constants/cod";
import { COD_COLLECTABLE } from "@/lib/queries/return-rate";
import { orderByNullsLast, shipmentSearchCondition } from "@/lib/queries/shipments";
import type { ListParams, Period } from "@/lib/search-params";

export const COD_SORTABLE = ["deliveredAt", "codAmount", "codCollected", "codPaidToBankAt", "createdAt"];

/** Vận đơn chưa hoàn / huỷ (chỉ các vận đơn này mới còn tiền COD để thu) */
/** Dùng chung với Báo cáo dòng tiền — định nghĩa gốc ở lib/queries/return-rate.ts */
const NOT_RETURNED = COD_COLLECTABLE;

/** Cột ngày mà bộ lọc kỳ áp dụng, tuỳ tab đang xem */
export function codPeriodColumn(statuses: CodStatus[] | "all"): { column: AnyPgColumn; label: string } {
  if (statuses === "all") return { column: schema.shipments.createdAt, label: "ngày tạo vận đơn" };
  if (statuses.length === 1 && statuses[0] === "PAID_TO_BANK") return { column: schema.shipments.codPaidToBankAt, label: "ngày tiền về ngân hàng" };
  if (statuses.length === 1 && statuses[0] === "PENDING") return { column: schema.shipments.createdAt, label: "ngày tạo vận đơn" };
  return { column: schema.shipments.deliveredAt, label: "ngày giao thành công" };
}

/** Điều kiện lọc danh sách đối soát COD: theo trạng thái COD (tab), đợt nhận tiền, ĐVVC, kỳ và từ khoá */
export function codListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [];
  const { period, filters, q } = params;
  const statuses = codStatusesFromFilter(filters.cod);
  if (filters.batch?.length) {
    conds.push(inArray(schema.shipments.codBatchId, filters.batch));
  } else {
    conds.push(statuses === "all" ? ne(schema.shipments.codStatus, "NOT_APPLICABLE") : inArray(schema.shipments.codStatus, statuses));
    // Vận đơn đã hoàn / huỷ không còn tiền COD để thu dù trạng thái COD chưa được cập nhật
    if (statuses === "all" || statuses.some((st) => st === "PENDING" || st === "COLLECTED")) conds.push(NOT_RETURNED);
    const { column } = codPeriodColumn(statuses);
    if (period.from) conds.push(gte(column, period.from));
    if (period.to) conds.push(lte(column, period.to));
  }
  if (filters.carrier?.length) conds.push(inArray(schema.shipments.carrier, filters.carrier));
  conds.push(shipmentSearchCondition(q));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listCodShipments(params: ListParams) {
  const db = await getDb();
  const where = codListWhere(params);
  const sortMap: Record<string, AnyPgColumn> = {
    deliveredAt: schema.shipments.deliveredAt,
    codAmount: schema.shipments.codAmount,
    codCollected: schema.shipments.codCollected,
    codPaidToBankAt: schema.shipments.codPaidToBankAt,
    createdAt: schema.shipments.createdAt,
  };
  const sortColumn = sortMap[params.sort] ?? schema.shipments.deliveredAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.shipments.findMany({
      where,
      orderBy: [orderByNullsLast(sortColumn, params.dir), desc(schema.shipments.id)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      columns: {
        id: true,
        orderId: true,
        carrier: true,
        trackingCode: true,
        vtpOrderNumber: true,
        orderReference: true,
        stage: true,
        vtpStatusName: true,
        codAmount: true,
        codCollected: true,
        codFee: true,
        shippingFee: true,
        codStatus: true,
        codReconciledAt: true,
        codPaidToBankAt: true,
        codBatchId: true,
        receiverName: true,
        receiverPhone: true,
        deliveredAt: true,
        createdAt: true,
      },
      with: {
        order: { columns: { id: true, systemId: true, billFullName: true, billPhone: true, source: true, totalPriceAfterDiscount: true, partnerFee: true } },
        codBatch: { columns: { id: true, reference: true, receivedAt: true } },
      },
    }),
    db.select({ total: count() }).from(schema.shipments).where(where),
  ]);
  // Phí ship: cước thực tế từ Viettel Post (bảng kê / tra cứu) → nếu chưa có thì cước Pancake ghi trên đơn (ước tính)
  const withFee = rows.map((r) => {
    const feeSource: "vtp" | "pancake" | "none" = r.shippingFee > 0 ? "vtp" : (r.order?.partnerFee ?? 0) > 0 ? "pancake" : "none";
    return { ...r, shippingFee: r.shippingFee > 0 ? r.shippingFee : (r.order?.partnerFee ?? 0), feeSource };
  });
  return { rows: withFee, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type CodListRow = Awaited<ReturnType<typeof listCodShipments>>["rows"][number];

/** Tổng tiền của danh sách đang lọc */
export async function codSummary(params: ListParams) {
  const db = await getDb();
  const [row] = await db
    .select({
      total: count(),
      codAmount: sum(schema.shipments.codAmount),
      codCollected: sum(schema.shipments.codCollected),
      shippingFee: sql<number>`coalesce(sum(coalesce(nullif(${schema.shipments.shippingFee}, 0), ${schema.orders.partnerFee}, 0)), 0)`,
    })
    .from(schema.shipments)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(codListWhere(params));
  return { total: Number(row?.total ?? 0), codAmount: Number(row?.codAmount ?? 0), codCollected: Number(row?.codCollected ?? 0), shippingFee: Number(row?.shippingFee ?? 0) };
}

export async function codFacets(params: ListParams) {
  const db = await getDb();
  const base = codListWhere({ ...params, filters: { cod: params.filters.cod ?? [], batch: params.filters.batch ?? [] } });
  const carriers = await db.select({ value: schema.shipments.carrier, count: count() }).from(schema.shipments).where(base).groupBy(schema.shipments.carrier).orderBy(desc(count()));
  return { carriers: carriers.filter((c) => c.value).map((c) => ({ value: c.value, label: c.value, count: Number(c.count) })) };
}

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
      .where(and(inArray(s.codStatus, ["COLLECTED", "RECONCILED"]), NOT_RETURNED)),
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

/** Số liệu tổng theo trạng thái COD (toàn bộ) + tiền đã về ngân hàng trong kỳ */
export async function codKpis(period: Period) {
  const db = await getDb();
  const s = schema.shipments;
  const b = schema.codBatches;
  const [rows, [paid], [batches]] = await Promise.all([
    // Chưa thu / đã thu chỉ tính vận đơn chưa hoàn, chưa huỷ; PAID_TO_BANK / RECONCILED / DISPUTED tính theo trạng thái COD
    db
      .select({ status: s.codStatus, count: count(), amount: sum(s.codAmount), collected: sum(s.codCollected) })
      .from(s)
      .where(and(ne(s.codStatus, "NOT_APPLICABLE"), sql`(${s.codStatus} not in ('PENDING', 'COLLECTED') or ${NOT_RETURNED})`))
      .groupBy(s.codStatus),
    db
      .select({ count: count(), amount: sum(s.codCollected) })
      .from(s)
      .where(and(eq(s.codStatus, "PAID_TO_BANK"), period.from ? gte(s.codPaidToBankAt, period.from) : undefined, period.to ? lte(s.codPaidToBankAt, period.to) : undefined)),
    // Bảng kê Viettel Post (đợt nhận tiền) trong kỳ — nguồn "tiền đã về ngân hàng" kể cả khi chưa gắn được từng vận đơn
    db
      .select({ count: count(), gross: sql<number>`coalesce(sum(coalesce(nullif(${b.codGross}, 0), ${b.totalAmount})), 0)`, fee: sql<number>`coalesce(sum(${b.feeTotal}), 0)`, net: sql<number>`coalesce(sum(${b.totalAmount}), 0)` })
      .from(b)
      .where(and(period.from ? gte(b.receivedAt, period.from) : undefined, period.to ? lte(b.receivedAt, period.to) : undefined)),
  ]);
  const empty = (): CodKpi => ({ count: 0, amount: 0, collected: 0 });
  const byStatus: Record<CodStatus, CodKpi> = { NOT_APPLICABLE: empty(), PENDING: empty(), COLLECTED: empty(), RECONCILED: empty(), PAID_TO_BANK: empty(), DISPUTED: empty() };
  for (const r of rows) byStatus[r.status] = { count: Number(r.count), amount: Number(r.amount ?? 0), collected: Number(r.collected ?? 0) };
  return {
    byStatus,
    paidInPeriod: { count: Number(paid?.count ?? 0), amount: Number(paid?.amount ?? 0) },
    batchesInPeriod: { count: Number(batches?.count ?? 0), gross: Number(batches?.gross ?? 0), fee: Number(batches?.fee ?? 0), net: Number(batches?.net ?? 0) },
  };
}

/** Các đợt nhận tiền COD gần nhất kèm số vận đơn */
export async function recentCodBatches(limit = 10) {
  const db = await getDb();
  const b = schema.codBatches;
  const rows = await db
    .select({
      id: b.id,
      reference: b.reference,
      carrier: b.carrier,
      receivedAt: b.receivedAt,
      totalAmount: b.totalAmount,
      codGross: b.codGross,
      feeTotal: b.feeTotal,
      source: b.source,
      note: b.note,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      shipments: count(schema.shipments.id),
      collected: sql<number>`coalesce(sum(${schema.shipments.codCollected}), 0)`,
    })
    .from(b)
    .leftJoin(schema.shipments, eq(schema.shipments.codBatchId, b.id))
    .groupBy(b.id)
    .orderBy(desc(b.receivedAt), desc(b.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, shipments: Number(r.shipments), collected: Number(r.collected) }));
}

export type CodBatchRow = Awaited<ReturnType<typeof recentCodBatches>>[number];

export async function getCodBatch(id: string) {
  const db = await getDb();
  const batch = await db.query.codBatches.findFirst({ where: eq(schema.codBatches.id, id) });
  return batch ?? null;
}

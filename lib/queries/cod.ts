import { and, count, desc, eq, gte, inArray, lte, ne, sql, sum, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { CodStatus } from "@/db/schema";
import { codStatusesFromFilter } from "@/lib/constants/cod";
import { orderByNullsLast, shipmentSearchCondition } from "@/lib/queries/shipments";
import type { ListParams, Period } from "@/lib/search-params";

export const COD_SORTABLE = ["deliveredAt", "codAmount", "codCollected", "codPaidToBankAt", "createdAt"];

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
        order: { columns: { id: true, systemId: true, billFullName: true, billPhone: true, source: true, totalPriceAfterDiscount: true } },
        codBatch: { columns: { id: true, reference: true, receivedAt: true } },
      },
    }),
    db.select({ total: count() }).from(schema.shipments).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type CodListRow = Awaited<ReturnType<typeof listCodShipments>>["rows"][number];

/** Tổng tiền của danh sách đang lọc */
export async function codSummary(params: ListParams) {
  const db = await getDb();
  const [row] = await db
    .select({ total: count(), codAmount: sum(schema.shipments.codAmount), codCollected: sum(schema.shipments.codCollected), shippingFee: sum(schema.shipments.shippingFee) })
    .from(schema.shipments)
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

/** Số liệu tổng theo trạng thái COD (toàn bộ) + tiền đã về ngân hàng trong kỳ */
export async function codKpis(period: Period) {
  const db = await getDb();
  const s = schema.shipments;
  const [rows, [paid]] = await Promise.all([
    db.select({ status: s.codStatus, count: count(), amount: sum(s.codAmount), collected: sum(s.codCollected) }).from(s).where(ne(s.codStatus, "NOT_APPLICABLE")).groupBy(s.codStatus),
    db
      .select({ count: count(), amount: sum(s.codCollected) })
      .from(s)
      .where(and(eq(s.codStatus, "PAID_TO_BANK"), period.from ? gte(s.codPaidToBankAt, period.from) : undefined, period.to ? lte(s.codPaidToBankAt, period.to) : undefined)),
  ]);
  const empty = (): CodKpi => ({ count: 0, amount: 0, collected: 0 });
  const byStatus: Record<CodStatus, CodKpi> = { NOT_APPLICABLE: empty(), PENDING: empty(), COLLECTED: empty(), RECONCILED: empty(), PAID_TO_BANK: empty(), DISPUTED: empty() };
  for (const r of rows) byStatus[r.status] = { count: Number(r.count), amount: Number(r.amount ?? 0), collected: Number(r.collected ?? 0) };
  return { byStatus, paidInPeriod: { count: Number(paid?.count ?? 0), amount: Number(paid?.amount ?? 0) } };
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

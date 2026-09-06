import { and, asc, count, desc, eq, exists, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import type { OrderStage } from "@/db/schema";
import { ORDER_STAGE_LABEL, ORDER_STAGE_ORDER } from "@/lib/constants/pancake";
import type { ListParams } from "@/lib/search-params";

export const ORDER_SORTABLE = ["insertedAt", "total", "systemId", "updatedAtExternal", "status"];

export function orderSearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  const numeric = Number(term.replace(/^#/, ""));
  const conds: SQL[] = [ilike(schema.orders.billPhone, like), ilike(schema.orders.billFullName, like), ilike(schema.orders.shipFullName, like), eq(schema.orders.id, term.replace(/^#/, ""))];
  if (Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric)) conds.push(eq(schema.orders.systemId, numeric));
  if (term.length >= 5) {
    conds.push(
      exists(
        getShipmentSearch(like),
      ),
    );
    conds.push(exists(sql`(select 1 from ${schema.orderItems} oi where oi.order_id = ${schema.orders.id} and (oi.sku ilike ${like} or oi.product_name ilike ${like}))`));
  }
  return or(...conds);
}

function getShipmentSearch(like: string) {
  return sql`(select 1 from ${schema.shipments} s where s.order_id = ${schema.orders.id} and (s.tracking_code ilike ${like} or s.vtp_order_number ilike ${like}))`;
}

export function orderListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [];
  const { period, filters, q } = params;
  if (period.from) conds.push(gte(schema.orders.insertedAt, period.from));
  if (period.to) conds.push(lte(schema.orders.insertedAt, period.to));
  if (filters.stage?.length) conds.push(inArray(schema.orders.stage, filters.stage as OrderStage[]));
  if (filters.source?.length) conds.push(inArray(schema.orders.source, filters.source));
  if (filters.carrier?.length) conds.push(exists(sql`(select 1 from ${schema.shipments} s where s.order_id = ${schema.orders.id} and s.carrier in ${filters.carrier})`));
  if (filters.seller?.length) conds.push(inArray(schema.orders.sellerName, filters.seller));
  if (filters.tag?.length) conds.push(sql`${schema.orders.tags} && ${sql.raw(`ARRAY[${filters.tag.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")}]::text[]`)}`);
  if (filters.payment?.includes("cod")) conds.push(sql`${schema.orders.moneyToCollect} > 0`);
  if (filters.payment?.includes("prepaid")) conds.push(sql`${schema.orders.moneyToCollect} = 0`);
  conds.push(orderSearchCondition(q));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listOrders(params: ListParams) {
  const db = await getDb();
  const where = orderListWhere(params);
  const sortMap: Record<string, AnyPgColumn> = {
    insertedAt: schema.orders.insertedAt,
    total: schema.orders.totalPriceAfterDiscount,
    systemId: schema.orders.systemId,
    updatedAtExternal: schema.orders.updatedAtExternal,
    status: schema.orders.status,
  };
  const sortColumn = sortMap[params.sort] ?? schema.orders.insertedAt;
  const orderBy = params.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [rows, [{ total }]] = await Promise.all([
    db.query.orders.findMany({
      where,
      orderBy: [orderBy, desc(schema.orders.id)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      columns: {
        id: true,
        systemId: true,
        status: true,
        statusName: true,
        stage: true,
        billFullName: true,
        billPhone: true,
        shipProvince: true,
        source: true,
        totalPriceAfterDiscount: true,
        moneyToCollect: true,
        cogs: true,
        itemsCount: true,
        totalQuantity: true,
        sellerName: true,
        tags: true,
        insertedAt: true,
        updatedAtExternal: true,
        lastUpdateStatusAt: true,
      },
      with: {
        shipment: { columns: { id: true, stage: true, carrier: true, trackingCode: true, vtpOrderNumber: true, codStatus: true, vtpStatusName: true } },
        items: { columns: { productName: true, variationDetail: true, quantity: true, image: true }, limit: 3 },
      },
    }),
    db.select({ total: count() }).from(schema.orders).where(where),
  ]);

  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type OrderListRow = Awaited<ReturnType<typeof listOrders>>["rows"][number];

/** Số đơn theo giai đoạn / nguồn / ĐVVC trong kỳ (cho bộ lọc) */
export async function orderFacets(params: ListParams) {
  const db = await getDb();
  const base = orderListWhere({ ...params, filters: {}, q: params.q });
  const [stages, sources, carriers, sellers] = await Promise.all([
    db.select({ value: schema.orders.stage, count: count() }).from(schema.orders).where(base).groupBy(schema.orders.stage),
    db.select({ value: schema.orders.source, count: count() }).from(schema.orders).where(base).groupBy(schema.orders.source).orderBy(desc(count())),
    db
      .select({ value: schema.shipments.carrier, count: count() })
      .from(schema.shipments)
      .innerJoin(schema.orders, eq(schema.shipments.orderId, schema.orders.id))
      .where(base)
      .groupBy(schema.shipments.carrier)
      .orderBy(desc(count())),
    db.select({ value: schema.orders.sellerName, count: count() }).from(schema.orders).where(and(base, sql`${schema.orders.sellerName} <> ''`)).groupBy(schema.orders.sellerName).orderBy(desc(count())).limit(30),
  ]);
  const stageCount = Object.fromEntries(stages.map((s) => [s.value, Number(s.count)]));
  return {
    stages: ORDER_STAGE_ORDER.map((stage) => ({ value: stage, label: ORDER_STAGE_LABEL[stage], count: stageCount[stage] ?? 0 })).filter((s) => s.count > 0 || params.filters.stage?.includes(s.value)),
    sources: sources.map((s) => ({ value: s.value, label: s.value, count: Number(s.count) })),
    carriers: carriers.filter((c) => c.value).map((c) => ({ value: c.value, label: c.value, count: Number(c.count) })),
    sellers: sellers.map((s) => ({ value: s.value, label: s.value, count: Number(s.count) })),
  };
}

export async function orderSummary(params: ListParams) {
  const db = await getDb();
  const where = orderListWhere(params);
  const [row] = await db
    .select({
      orders: count(),
      revenue: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.totalPriceAfterDiscount} else 0 end), 0)`,
      cod: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.moneyToCollect} else 0 end), 0)`,
      success: sql<number>`sum(case when ${ORDER_OUTCOME} = 'DELIVERED' then 1 else 0 end)`,
      quantity: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.totalQuantity} else 0 end), 0)`,
    })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(where);
  return { orders: Number(row?.orders ?? 0), revenue: Number(row?.revenue ?? 0), cod: Number(row?.cod ?? 0), success: Number(row?.success ?? 0), quantity: Number(row?.quantity ?? 0) };
}

export async function getOrderDetail(id: string) {
  const db = await getDb();
  const order = await db.query.orders.findFirst({
    where: or(eq(schema.orders.id, id), Number.isInteger(Number(id)) ? eq(schema.orders.systemId, Number(id)) : undefined),
    with: {
      customer: true,
      warehouse: true,
      items: { with: { variant: { columns: { id: true, images: true, remainQuantity: true, sku: true, lastImportedPrice: true } } } },
      statusHistory: { orderBy: [desc(schema.orderStatusHistory.updatedAt)] },
      shipment: { with: { events: { orderBy: [desc(schema.shipmentEvents.occurredAt)] }, codBatch: true } },
      returns: true,
    },
  });
  if (!order) return null;
  // Giá vốn "sống": giá nhập trên phiếu ERP gần nhất → giá vốn Pancake ghi trên đơn → giá nhập mẫu mã
  const variantIds = order.items.map((it) => it.variantId).filter((v): v is string => Boolean(v));
  const receiptCosts = variantIds.length
    ? await db
        .select({ variantId: schema.stockReceiptItems.variantId, unitCost: schema.stockReceiptItems.unitCost })
        .from(schema.stockReceiptItems)
        .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
        .where(and(inArray(schema.stockReceiptItems.variantId, variantIds), sql`${schema.stockReceiptItems.unitCost} > 0`))
        .orderBy(desc(schema.stockReceipts.receivedAt), desc(schema.stockReceipts.createdAt))
    : [];
  const lastCost = new Map<string, number>();
  for (const rc of receiptCosts) if (rc.variantId && !lastCost.has(rc.variantId)) lastCost.set(rc.variantId, Number(rc.unitCost));
  const items = order.items.map((it) => ({ ...it, liveUnitCost: (it.variantId && lastCost.get(it.variantId)) || it.unitCost || it.variant?.lastImportedPrice || 0 }));
  const liveCogs = items.reduce((sum, it) => sum + it.liveUnitCost * it.quantity, 0);
  return { ...order, items, liveCogs };
}

export type OrderDetail = NonNullable<Awaited<ReturnType<typeof getOrderDetail>>>;

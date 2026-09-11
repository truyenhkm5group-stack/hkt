import { listKey, memo } from "@/lib/cache";
import { and, asc, count, desc, eq, exists, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { OrderStage } from "@/db/schema";
import { ORDER_STAGE_LABEL, ORDER_STAGE_ORDER } from "@/lib/constants/pancake";
import type { ListParams } from "@/lib/search-params";
import { loadAlertConfig } from "@/lib/alerts/config";
import { assessCustomerRisk } from "@/lib/alerts/risk";

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

export function orderListWhere(params: ListParams, opts: { ignoreAddressFilter?: boolean } = {}) {
  const conds: (SQL | undefined)[] = [];
  const { period, q } = params;
  const filters: Record<string, string[] | undefined> = opts.ignoreAddressFilter ? { ...params.filters, address: undefined } : params.filters;
  if (period.from) conds.push(gte(schema.orders.insertedAt, period.from));
  if (period.to) conds.push(lte(schema.orders.insertedAt, period.to));
  if (filters.stage?.length) conds.push(inArray(schema.orders.stage, filters.stage as OrderStage[]));
  if (filters.source?.length) conds.push(inArray(schema.orders.source, filters.source));
  if (filters.carrier?.length) conds.push(exists(sql`(select 1 from ${schema.shipments} s where s.order_id = ${schema.orders.id} and s.carrier in ${filters.carrier})`));
  if (filters.seller?.length) conds.push(inArray(schema.orders.sellerName, filters.seller));
  if (filters.tag?.length) conds.push(sql`${schema.orders.tags} && ${sql.raw(`ARRAY[${filters.tag.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")}]::text[]`)}`);
  // Pancake chỉ giao được khi đã ghép địa chỉ khách vào đơn vị hành chính (3 cấp cũ hoặc 2 cấp mới
  // từ 01/07/2025). Không ghép được thì `province_name` rỗng và đơn đứng im ở POS với dòng "Vui lòng
  // cung cấp địa chỉ cần chuẩn hoá" — nhân viên phải mở đơn, hỏi lại khách rồi chọn tay.
  if (filters.address?.includes("unnormalized")) conds.push(sql`coalesce(${schema.orders.shipProvince}, '') = ''`);
  if (filters.address?.includes("normalized")) conds.push(sql`coalesce(${schema.orders.shipProvince}, '') <> ''`);
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

  const [rowsRaw, [{ total }], riskCfg] = await Promise.all([
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
        // Lịch sử khách theo Pancake — đủ để chấm rủi ro ngay trên dòng.
        customer: { columns: { succeedOrderCount: true, returnedOrderCount: true, isBlock: true } },
      },
    }),
    db.select({ total: count() }).from(schema.orders).where(where),
    loadAlertConfig(),
  ]);

  /*
    CỜ RỦI RO NGAY TRÊN DÒNG. Trước đây khách có lịch sử hoàn cao chỉ lộ ra khi MỞ chi tiết đơn —
    người CSKH duyệt 50 đơn mỗi sáng thì không mở 50 trang. Cùng công thức với chi tiết đơn và luật
    cảnh báo (`assessCustomerRisk`), chỉ khác là ở đây dùng số Pancake của khách (không tra thêm lịch
    sử ERP theo SĐT cho từng dòng); chi tiết đơn vẫn có bản đầy đủ.
  */
  const rows = rowsRaw.map((r) => {
    const c = r.customer;
    const risk = c ? assessCustomerRisk({ succeed: c.succeedOrderCount ?? 0, returned: c.returnedOrderCount ?? 0, isBlock: Boolean(c.isBlock) }, riskCfg) : null;
    return { ...r, risk: risk?.risky ? { severity: risk.severity, reasons: risk.reasons } : null };
  });

  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type OrderListRow = Awaited<ReturnType<typeof listOrders>>["rows"][number];

/** Số đơn theo giai đoạn / nguồn / ĐVVC trong kỳ (cho bộ lọc) */
export async function orderFacets(params: ListParams) {
  return memo(`orderFacets:${listKey(params, false)}`, 30_000, () => orderFacetsUncached(params));
}

async function orderFacetsUncached(params: ListParams) {
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
  return memo(`orderSummary:${listKey(params)}`, 30_000, () => orderSummaryUncached(params));
}

async function orderSummaryUncached(params: ListParams) {
  const db = await getDb();
  const where = orderListWhere(params);
  const [row] = await db
    .select({
      orders: count(),
      revenue: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.totalPriceAfterDiscount} else 0 end), 0)`,
      cod: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.moneyToCollect} else 0 end), 0)`,
      success: sql<number>`sum(case when ${ORDER_OUTCOME_FAST} = 'DELIVERED' then 1 else 0 end)`,
      quantity: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.totalQuantity} else 0 end), 0)`,
    })
    .from(schema.orders)
    // MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT))
    .where(where);
  // Đếm đơn chưa chuẩn hoá địa chỉ BỎ QUA chính bộ lọc địa chỉ, để con số trên nhãn bộ lọc không
  // đổi theo lựa chọn của chính nó (chọn "Đã chuẩn hoá" mà nhãn kia hiện 0 thì gây hiểu nhầm).
  const [unnormalized] = await db
    .select({ n: count() })
    .from(schema.orders)
    .where(and(orderListWhere(params, { ignoreAddressFilter: true }), sql`coalesce(${schema.orders.shipProvince}, '') = ''`, sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`));
  return { orders: Number(row?.orders ?? 0), revenue: Number(row?.revenue ?? 0), cod: Number(row?.cod ?? 0), success: Number(row?.success ?? 0), quantity: Number(row?.quantity ?? 0), unnormalizedAddress: Number(unnormalized?.n ?? 0) };
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
      /**
       * MỌI LẦN GỬI, KHÔNG PHẢI MỘT.
       *
       * Quan hệ `shipment` là `one(...)` — nó lấy MỘT dòng bất kỳ. Từ 10/09/2026 một đơn được phép
       * có nhiều lần gửi (giao thất bại rồi gửi lại, huỷ rồi tạo lại, gửi hàng thay thế), nên hiển
       * thị một dòng là XOÁ lịch sử khỏi mắt người vận hành: họ thấy "đang giao" mà không biết đây
       * đã là lần thứ ba.
       *
       * Sắp theo thứ tự lần gửi để đọc được như một dòng thời gian.
       */
      attempts: {
        with: { events: { orderBy: [desc(schema.shipmentEvents.occurredAt)] }, codBatch: true },
        orderBy: [asc(schema.shipments.attemptNo), asc(schema.shipments.createdAt)],
      },
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

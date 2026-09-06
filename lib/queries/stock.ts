import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { ORDER_OUTCOME, RETURN_PENDING_WAREHOUSE } from "@/lib/queries/return-rate";

const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;
const ri = schema.stockReceiptItems;
const pv = schema.productVariants;
const p = schema.products;

/**
 * Số lượng đã bán / hoàn / đang giao / chờ gửi theo mẫu mã, tính từ kết quả cuối cùng của từng đơn
 * (cùng quy tắc với báo cáo tỷ lệ hoàn: giao thật = giao thành công có cước ≥ 10K hoặc có COD).
 */
export function variantSalesSubquery(db: Db) {
  return db
    .select({
      variantId: oi.variantId,
      delivered: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`.as("sold_delivered"),
      returned: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')), 0)`.as("sold_returned"),
      inTransit: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT'), 0)`.as("sold_in_transit"),
      pending: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${ORDER_OUTCOME} = 'NOT_SHIPPED' and ${o.stage} in ('CONFIRMED','PACKING','READY_TO_SHIP')), 0)`.as("sold_pending"),
      /** Hàng hoàn kho CHƯA xác nhận nhận về — vẫn đang ở ngoài, không được tính vào tồn. */
      returnedPending: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${RETURN_PENDING_WAREHOUSE}), 0)`.as("sold_returned_pending"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .groupBy(oi.variantId)
    .as("vsales");
}

/** Tổng nhập (phiếu nhập + điều chỉnh) theo mẫu mã */
export function variantReceiptsSubquery(db: Db) {
  return db
    .select({
      variantId: ri.variantId,
      received: sql<number>`coalesce(sum(${ri.quantity}), 0)`.as("received"),
      receiptCount: sql<number>`count(distinct ${ri.receiptId})`.as("receipt_count"),
    })
    .from(ri)
    .groupBy(ri.variantId)
    .as("vreceipts");
}

/** Giá nhập gần nhất ghi trên phiếu (nếu có), dùng thay giá vốn Pancake khi Pancake = 0 */
export const LAST_RECEIPT_COST = sql<number>`(select ri2.unit_cost from stock_receipt_items ri2 join stock_receipts r2 on r2.id = ri2.receipt_id where ri2.variant_id = ${pv.id} and ri2.unit_cost > 0 order by r2.received_at desc, r2.created_at desc limit 1)`;

export type StockAggregates = ReturnType<typeof variantSalesSubquery>;
export type ReceiptAggregates = ReturnType<typeof variantReceiptsSubquery>;

/** Tồn khả dụng ERP = Nhập − Giao thật − Đang giao − Hàng hoàn kho CHƯA xác nhận nhận về.
 *  Hàng hoàn chỉ được cộng lại tồn khi có `shipments.return_received_at`; ĐVVC báo "đã hoàn" là chưa đủ. */
export function erpStockExpr(sales: StockAggregates, receipts: ReceiptAggregates) {
  return sql<number>`coalesce(${receipts.received}, 0) - coalesce(${sales.delivered}, 0) - coalesce(${sales.inTransit}, 0) - coalesce(${sales.returnedPending}, 0)`;
}

export type VariantPickerRow = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  image: string | null;
  currentStock: number;
  lastCost: number;
  retailPrice: number;
  selling: boolean;
};

/** Danh sách mẫu mã để chọn khi lập phiếu (kèm tồn ERP hiện tại và giá nhập gần nhất) */
export async function listVariantsForReceipt(): Promise<VariantPickerRow[]> {
  const db = await getDb();
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const rows = await db
    .select({
      id: pv.id,
      productId: pv.productId,
      productName: p.name,
      sku: pv.sku,
      color: pv.color,
      size: pv.size,
      images: pv.images,
      productImage: p.image,
      currentStock: erpStockExpr(sales, receipts),
      lastCost: sql<number>`coalesce(${LAST_RECEIPT_COST}, ${pv.lastImportedPrice}, 0)`,
      retailPrice: pv.retailPrice,
      selling: sql<boolean>`(${pv.isRemoved} = false and ${pv.isHidden} = false and ${p.isRemoved} = false)`,
    })
    .from(pv)
    .innerJoin(p, eq(pv.productId, p.id))
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .where(eq(pv.isRemoved, false))
    .orderBy(asc(p.name), asc(pv.sku), asc(pv.color), asc(pv.size))
    .limit(3000);
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    productName: r.productName,
    sku: r.sku,
    color: r.color,
    size: r.size,
    image: r.images?.[0] || r.productImage || null,
    currentStock: Number(r.currentStock ?? 0),
    lastCost: Number(r.lastCost ?? 0),
    retailPrice: Number(r.retailPrice ?? 0),
    selling: Boolean(r.selling),
  }));
}

export async function listStockReceipts(limit = 100) {
  const db = await getDb();
  return db.query.stockReceipts.findMany({
    orderBy: [desc(schema.stockReceipts.receivedAt), desc(schema.stockReceipts.createdAt)],
    limit,
    with: { items: { with: { variant: { columns: { id: true, sku: true, color: true, size: true }, with: { product: { columns: { name: true } } } } } } },
  });
}

export type StockReceiptRow = Awaited<ReturnType<typeof listStockReceipts>>[number];

export async function stockReceiptSummary() {
  const db = await getDb();
  const [row] = await db
    .select({
      receipts: sql<number>`count(*) filter (where ${schema.stockReceipts.kind} = 'RECEIPT')`,
      adjustments: sql<number>`count(*) filter (where ${schema.stockReceipts.kind} = 'ADJUSTMENT')`,
      received: sql<number>`coalesce(sum(${schema.stockReceipts.totalQuantity}) filter (where ${schema.stockReceipts.kind} = 'RECEIPT'), 0)`,
      adjusted: sql<number>`coalesce(sum(${schema.stockReceipts.totalQuantity}) filter (where ${schema.stockReceipts.kind} = 'ADJUSTMENT'), 0)`,
      cost: sql<number>`coalesce(sum(${schema.stockReceipts.totalCost}), 0)`,
      lastAt: sql<string | null>`max(${schema.stockReceipts.receivedAt})`,
    })
    .from(schema.stockReceipts);
  return { receipts: Number(row?.receipts ?? 0), adjustments: Number(row?.adjustments ?? 0), received: Number(row?.received ?? 0), adjusted: Number(row?.adjusted ?? 0), cost: Number(row?.cost ?? 0), lastAt: row?.lastAt ? new Date(row.lastAt) : null };
}

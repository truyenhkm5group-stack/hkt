import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { ORDER_OUTCOME, RETURN_PENDING_WAREHOUSE, SHIPMENT_LEFT_WAREHOUSE, VTP_DESTROYED } from "@/lib/queries/return-rate";

const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;
const ri = schema.stockReceiptItems;
const r = schema.stockReceipts;
const pv = schema.productVariants;
const p = schema.products;

/**
 * SỔ KHO — mọi con số tồn của ERP đều ra từ một phương trình duy nhất:
 *
 *   Tồn thực tế   = (tổng phiếu kho) − (đã xuất qua ĐVVC)
 *   Tồn khả dụng  = Tồn thực tế − (đã chốt đơn nhưng chưa xuất)
 *
 * Phiếu kho quy ước DƯƠNG = vào kho (nhập mới, tái nhập hàng hoàn, điều chỉnh tăng),
 * ÂM = ra kho (xuất tay không qua ĐVVC, điều chỉnh giảm).
 *
 * ĐÃ XUẤT đếm theo VẬN ĐƠN, không theo tiền: hàng rời kho lúc bưu tá lấy hàng, không phải lúc
 * khách trả tiền. Vì vậy tồn kho KHÔNG dùng ORDER_OUTCOME (định nghĩa theo COD thực thu, dành cho
 * doanh thu / lợi nhuận). Hàng hoàn vẫn nằm trong "đã xuất" cho tới khi kho lập phiếu tái nhập —
 * ĐVVC báo "đã hoàn" chỉ là hàng đang trên đường về, không phải hàng đã có trong kho.
 *
 * Hàng tặng kèm (is_bonus) vẫn trừ tồn như hàng bán: lên đơn 0đ nhưng vẫn rời kho.
 */

/** Số món của một dòng đơn — hàng tặng tính như hàng bán vì cũng rời kho. */
const QTY = sql<number>`${oi.quantity}`;

/**
 * Đã chốt đơn nhưng CHƯA rời kho: hàng còn trong kho nhưng đã hứa cho khách.
 * Gồm đơn đã xác nhận/đang đóng/chờ chuyển và cả vận đơn đã tạo mã mà bưu tá chưa lấy.
 */
const RESERVED_IN_WAREHOUSE = sql`(not ${SHIPMENT_LEFT_WAREHOUSE}
  and ${o.stage} in ('CONFIRMED','PACKING','READY_TO_SHIP','SHIPPED'))`;

/** Hàng đã rời kho và đang trên đường (chưa kết thúc) — nằm ngoài kho, chưa biết về hay không. */
const OUT_IN_TRANSIT = sql`(${SHIPMENT_LEFT_WAREHOUSE} and ${s.stage} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED'))`;

/**
 * Hàng phải quay về kho mà kho CHƯA lập phiếu tái nhập.
 * Gồm đơn hoàn (theo kết quả đơn) và đơn huỷ sau khi đã xuất — chủ shop yêu cầu xử lý như hàng hoàn.
 */
const OUT_AWAITING_RETURN = sql`(${SHIPMENT_LEFT_WAREHOUSE} and ${s.returnReceivedAt} is null
  and (${RETURN_PENDING_WAREHOUSE} or ${s.stage} in ('RETURNING','RETURNED','CANCELLED') or ${o.stage} in ('CANCELLED','DELETED'))
  and not ${VTP_DESTROYED})`;

/** Hàng hoàn kho ĐÃ xử lý (đã có phiếu tái nhập) — dùng để đối chiếu với số thực nhập, ra phần hụt. */
const OUT_RETURN_HANDLED = sql`(${SHIPMENT_LEFT_WAREHOUSE} and ${s.returnReceivedAt} is not null)`;

/**
 * Số lượng theo mẫu mã ở phía ĐƠN HÀNG (grain: dòng đơn × vận đơn của đơn đó).
 * `shipped` là số THỰC SỰ RỜI KHO — trụ cột của phương trình tồn kho.
 */
export function variantSalesSubquery(db: Db) {
  return db
    .select({
      variantId: oi.variantId,
      /** ĐÃ XUẤT KHO qua ĐVVC — căn cứ trạng thái vận đơn dựng từ sự kiện Viettel Post. */
      shipped: sql<number>`coalesce(sum(${QTY}) filter (where ${SHIPMENT_LEFT_WAREHOUSE}), 0)`.as("out_shipped"),
      /** Đã xuất, đang trên đường, chưa kết thúc. */
      inTransit: sql<number>`coalesce(sum(${QTY}) filter (where ${OUT_IN_TRANSIT}), 0)`.as("out_in_transit"),
      /** Đã xuất, phải quay về, kho chưa lập phiếu tái nhập. */
      awaitingReturn: sql<number>`coalesce(sum(${QTY}) filter (where ${OUT_AWAITING_RETURN}), 0)`.as("out_awaiting_return"),
      /** Đã xuất và đã lập phiếu tái nhập — đối chiếu với số thực nhập để ra phần hụt. */
      returnHandled: sql<number>`coalesce(sum(${QTY}) filter (where ${OUT_RETURN_HANDLED}), 0)`.as("out_return_handled"),
      /** Đã chốt đơn, hàng còn trong kho — trừ khỏi tồn KHẢ DỤNG, không trừ khỏi tồn thực tế. */
      reserved: sql<number>`coalesce(sum(${QTY}) filter (where ${RESERVED_IN_WAREHOUSE}), 0)`.as("out_reserved"),
      /** Giao thành công theo TIỀN (ORDER_OUTCOME) — chỉ để đối chiếu, KHÔNG dùng tính tồn. */
      delivered: sql<number>`coalesce(sum(${QTY}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`.as("sold_delivered"),
      /** Hoàn theo kết quả đơn — chỉ để đối chiếu. */
      returned: sql<number>`coalesce(sum(${QTY}) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')), 0)`.as("sold_returned"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .groupBy(oi.variantId)
    .as("vsales");
}

/** Tổng các phiếu kho theo mẫu mã, tách theo loại phiếu để theo dõi riêng nhập mới / tái nhập / điều chỉnh / xuất tay. */
export function variantReceiptsSubquery(db: Db) {
  return db
    .select({
      variantId: ri.variantId,
      /** Tổng ròng mọi phiếu (đã tính dấu) — vế "vào kho" của phương trình tồn. */
      received: sql<number>`coalesce(sum(${ri.quantity}), 0)`.as("received"),
      /** Nhập hàng mới từ xưởng / NCC. */
      receiptIn: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${r.kind} = 'RECEIPT'), 0)`.as("receipt_in"),
      /** Tái nhập hàng hoàn — số kho ĐẾM THỰC TẾ, không phải số suy ra từ vận đơn. */
      returnIn: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${r.kind} = 'RETURN'), 0)`.as("return_in"),
      /** Điều chỉnh sau kiểm kê (âm hoặc dương). */
      adjust: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${r.kind} = 'ADJUSTMENT'), 0)`.as("adjust_qty"),
      /** Xuất kho tay không qua ĐVVC (khách tới lấy, ship nội thành) — lưu số âm, đổi dấu để hiển thị. */
      manualOut: sql<number>`coalesce(-sum(${ri.quantity}) filter (where ${r.kind} = 'ISSUE'), 0)`.as("manual_out"),
      receiptCount: sql<number>`count(distinct ${ri.receiptId})`.as("receipt_count"),
      /** Số phiếu NHẬP HÀNG — mẫu mã chưa có phiếu nào thì tồn là THIẾU DỮ LIỆU, không phải 0. */
      receiptDocs: sql<number>`count(distinct ${ri.receiptId}) filter (where ${r.kind} = 'RECEIPT')`.as("receipt_docs"),
    })
    .from(ri)
    .innerJoin(r, eq(r.id, ri.receiptId))
    .groupBy(ri.variantId)
    .as("vreceipts");
}

/** Giá nhập gần nhất ghi trên phiếu (nếu có), dùng thay giá vốn Pancake khi Pancake = 0 */
export const LAST_RECEIPT_COST = sql<number>`(select ri2.unit_cost from stock_receipt_items ri2 join stock_receipts r2 on r2.id = ri2.receipt_id where ri2.variant_id = ${pv.id} and ri2.unit_cost > 0 and r2.kind = 'RECEIPT' order by r2.received_at desc, r2.created_at desc limit 1)`;

/**
 * CÙNG MỘT CON SỐ với `LAST_RECEIPT_COST`, nhưng tính MỘT LẦN CHO MỖI MẪU MÃ thay vì một lần cho
 * mỗi dòng đọc nó.
 *
 * BẰNG CHỨNG (EXPLAIN ANALYZE, bộ dữ liệu 12.894 đơn — xem docs/erp-performance-p0-report.md):
 * dùng ở cấp DÒNG ĐƠN HÀNG, truy vấn con tương quan này chạy 4.260 lần, mỗi lần 4,8 ms, ngốn
 * 10.350.750 khối đệm — 99,3% toàn bộ chi phí của truy vấn "Hiệu quả mẫu mã". Bộ tối ưu chọn quét
 * từ phía PHIẾU KHO nên vòng lặp trong chạy 2.556.000 lượt (600 phiếu × 4.260 dòng): chi phí tăng
 * theo TÍCH của số dòng đơn và số phiếu kho.
 *
 * `distinct on (variant_id)` quét bảng phiếu đúng MỘT LẦN rồi để các truy vấn nối vào. Thứ tự sắp
 * xếp và bộ lọc giữ y nguyên (`unit_cost > 0`, `kind = 'RECEIPT'`, mới nhất trước) nên giá trị
 * từng mẫu mã không đổi một đồng — khoá bằng tests/metric-shape-consistency.test.ts.
 *
 * Nối vào bằng `pv.id` (KHÔNG phải `order_items.variant_id`): mẫu mã đã bị xoá khỏi ERP thì
 * `LAST_RECEIPT_COST` trả NULL, và bản nối phải trả NULL y hệt.
 */
export function variantLastCostSubquery(db: Db) {
  return db
    .selectDistinctOn([ri.variantId], { variantId: ri.variantId, lastCost: ri.unitCost })
    .from(ri)
    .innerJoin(r, eq(r.id, ri.receiptId))
    .where(sql`${ri.unitCost} > 0 and ${r.kind} = 'RECEIPT'`)
    .orderBy(ri.variantId, desc(r.receivedAt), desc(r.createdAt))
    .as("vlastcost");
}

export type VariantLastCost = ReturnType<typeof variantLastCostSubquery>;

export type StockAggregates = ReturnType<typeof variantSalesSubquery>;
export type ReceiptAggregates = ReturnType<typeof variantReceiptsSubquery>;

/**
 * Tồn ERP có ĐÁNG TIN hay không: chỉ khi mẫu mã đã có ít nhất một PHIẾU NHẬP HÀNG.
 * Chưa có phiếu nhập nào thì "nhập = 0" là THIẾU DỮ LIỆU, không phải "nhập 0 cái";
 * lấy 0 trừ đi số đã xuất sẽ ra tồn âm bịa ra và đẩy kế hoạch sản xuất đặt thừa.
 * Những mẫu mã này phải hiển thị "Chưa có phiếu nhập", không hiển thị số.
 */
export function stockKnownExpr(receipts: ReceiptAggregates) {
  return sql<boolean>`coalesce(${receipts.receiptDocs}, 0) > 0`;
}

/**
 * TỒN THỰC TẾ = tổng phiếu kho (nhập mới + tái nhập + điều chỉnh − xuất tay) − đã xuất qua ĐVVC.
 * Hàng hoàn chỉ quay lại tồn khi kho lập PHIẾU TÁI NHẬP với số đếm thực tế.
 */
export function erpStockExpr(sales: StockAggregates, receipts: ReceiptAggregates) {
  return sql<number>`coalesce(${receipts.received}, 0) - coalesce(${sales.shipped}, 0)`;
}

/** TỒN KHẢ DỤNG để bán = tồn thực tế − hàng đã chốt đơn còn nằm trong kho chờ xuất. */
export function availableStockExpr(sales: StockAggregates, receipts: ReceiptAggregates) {
  return sql<number>`coalesce(${receipts.received}, 0) - coalesce(${sales.shipped}, 0) - coalesce(${sales.reserved}, 0)`;
}

/** Hàng hoàn đã lập phiếu nhưng đếm thiếu so với số đã xuất = hàng hụt / hỏng không nhập lại được. */
export function stockShrinkageExpr(sales: StockAggregates, receipts: ReceiptAggregates) {
  return sql<number>`greatest(coalesce(${sales.returnHandled}, 0) - coalesce(${receipts.returnIn}, 0), 0)`;
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

/**
 * TỔNG HỢP NĂM TRẠNG THÁI CỦA HÀNG + RỦI RO HẾT HÀNG.
 *
 * Dùng cho Tổng quan để thay ngưỡng cứng `tồn <= 5`: mẫu mã bán 20 cái/ngày còn 8 cái là sắp
 * cháy hàng, mẫu mã bán 1 cái/tháng còn 3 cái thì vẫn dư. Rủi ro tính theo `days of cover` so với
 * thời gian sản xuất — cùng một bộ máy với trang Kế hoạch SX và cảnh báo vận hành, nên ba nơi
 * không thể ra ba con số khác nhau.
 */
export async function stockRiskSummary() {
  const { getReplenishmentPlan } = await import("@/lib/queries/planning");
  const [plan, db] = await Promise.all([getReplenishmentPlan(), getDb()]);
  const salesAgg = variantSalesSubquery(db);
  const receiptsAgg = variantReceiptsSubquery(db);
  // HÀNG HỤT: đã lập phiếu tái nhập nhưng đếm được ít hơn số đã xuất — hỏng, mất, hoặc không
  // bán lại được. Đây là số ĐO ĐƯỢC từ chênh lệch phiếu, không phải ước lượng.
  const [shrink] = await db
    .select({ n: sql<number>`coalesce(sum(${stockShrinkageExpr(salesAgg, receiptsAgg)}), 0)` })
    .from(pv)
    .leftJoin(salesAgg, eq(salesAgg.variantId, pv.id))
    .leftJoin(receiptsAgg, eq(receiptsAgg.variantId, pv.id));
  const rows = plan.rows;
  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((total, r) => total + pick(r), 0);
  return {
    states: {
      ON_HAND: sum((r) => (r.stockKnown ? r.stock : 0)),
      RESERVED: sum((r) => r.committed),
      AVAILABLE: sum((r) => (r.stockKnown ? r.available : 0)),
      INBOUND: plan.summary.incomingUnits,
      UNSELLABLE: Number(shrink?.n ?? 0),
    },
    /** Mẫu mã hết hàng hoặc sẽ hết TRƯỚC khi lô mới về — việc phải xử lý ngay. */
    atRisk: plan.summary.out + plan.summary.critical,
    out: plan.summary.out,
    critical: plan.summary.critical,
    low: plan.summary.low,
    /** Mẫu mã chưa có phiếu nhập nào ⇒ tồn là CHƯA BIẾT, không phải 0 — không được đếm là hết hàng. */
    unknown: plan.summary.unknown,
    suggestedUnits: plan.summary.suggestedUnits,
    orderCost: plan.summary.orderCost,
  };
}

export type StockRiskSummary = Awaited<ReturnType<typeof stockRiskSummary>>;

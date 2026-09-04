import { sql } from "drizzle-orm";
import { schema } from "@/db";
import { LAST_RECEIPT_COST } from "@/lib/queries/stock";

const i = schema.orderItems;
const pv = schema.productVariants;

/**
 * Giá vốn một sản phẩm trên dòng đơn (cần join product_variants):
 * giá nhập trên phiếu nhập gần nhất (ERP) → giá vốn Pancake ghi trên đơn lúc đồng bộ → giá nhập mẫu mã trên Pancake.
 */
export const LINE_UNIT_COST = sql<number>`coalesce(${LAST_RECEIPT_COST}, nullif(${i.unitCost}, 0), ${pv.lastImportedPrice}, 0)`;

/**
 * Giá vốn cả đơn tính "sống" từ dòng đơn (thay cho orders.cogs — chỉ là ảnh chụp lúc đồng bộ, bằng 0 nếu Pancake chưa có giá vốn).
 * Subquery tương quan theo orders.id, dùng được trong select/sum của mọi truy vấn trên bảng orders.
 */
export const ORDER_COGS = sql<number>`coalesce((
  select sum(oi.quantity * coalesce(
    (select ri2.unit_cost from stock_receipt_items ri2 join stock_receipts r2 on r2.id = ri2.receipt_id
      where ri2.variant_id = oi.variant_id and ri2.unit_cost > 0 order by r2.received_at desc, r2.created_at desc limit 1),
    nullif(oi.unit_cost, 0),
    pv2.last_imported_price,
    0))
  from order_items oi left join product_variants pv2 on pv2.id = oi.variant_id
  where oi.order_id = ${schema.orders.id}
), 0)`;

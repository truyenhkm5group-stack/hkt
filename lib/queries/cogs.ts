import { sql } from "drizzle-orm";
import { schema } from "@/db";
import { CANONICAL_OUTCOME_VERSION } from "@/lib/constants/canonical-outcome";
import { LAST_RECEIPT_COST, type VariantLastCost } from "@/lib/queries/stock";

const i = schema.orderItems;
const pv = schema.productVariants;

/**
 * Giá vốn một sản phẩm trên dòng đơn (cần join product_variants):
 * giá nhập trên phiếu nhập gần nhất (ERP) → giá vốn Pancake ghi trên đơn lúc đồng bộ → giá nhập mẫu mã trên Pancake.
 */
export const LINE_UNIT_COST = sql<number>`coalesce(${LAST_RECEIPT_COST}, nullif(${i.unitCost}, 0), ${pv.lastImportedPrice}, 0)`;

/**
 * ĐÚNG CÙNG công thức `LINE_UNIT_COST`, nhưng lấy giá nhập gần nhất từ bảng đã tính sẵn
 * (`variantLastCostSubquery`) thay vì chạy truy vấn con cho TỪNG dòng đơn hàng.
 *
 * Dùng ở các truy vấn cấp DÒNG ĐƠN (hiệu quả mẫu mã, lợi nhuận theo mã hàng): ở đó số dòng lên tới
 * hàng chục nghìn nên chi phí của truy vấn con nhân lên đúng bấy nhiêu lần. Các truy vấn cấp MẪU MÃ
 * (Sản phẩm & tồn kho, Kế hoạch SX, Hàng bán chậm) vẫn dùng `LINE_UNIT_COST` — ở đó nó chỉ chạy
 * vài trăm lần, và giữ nguyên thì không phải chứng minh lại gì.
 */
export function lineUnitCost(lastCost: VariantLastCost) {
  return sql<number>`coalesce(${lastCost.lastCost}, nullif(${i.unitCost}, 0), ${pv.lastImportedPrice}, 0)`;
}

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

/**
 * Cột giá vốn cả đơn cho BẢNG DẪN XUẤT (xem `OUTCOME_FENCE` trong lib/queries/return-rate.ts).
 * `ORDER_COGS` là truy vấn con tương quan, và cũng bị nội tuyến lại vào từng cột gộp y như
 * `ORDER_OUTCOME` — nên nó phải được tính một lần cho mỗi dòng, ở cùng chỗ.
 *
 * Cố ý đặt ở đây chứ không ở return-rate.ts: return-rate ← cogs ← stock ← return-rate sẽ thành
 * vòng import, và biểu thức SQL dựng ở mức mô-đun trong vòng import thì có thể là `undefined`.
 */
/**
 * Giá vốn đọc từ bảng đã tính sẵn; **thiếu dòng thì tính tại chỗ** bằng chính biểu thức trên.
 *
 * Cùng nguyên tắc với `ORDER_OUTCOME_FAST`: bảng trống, thiếu dòng, hay sai phiên bản thì CHẬM chứ
 * không SAI. Đo được: đọc bảng cho toàn bộ 2.431 dòng mất 48ms, trong khi tính trực tiếp mất vài
 * giây — vì `ORDER_COGS` là truy vấn con lồng hai tầng (mỗi đơn → mỗi dòng hàng → tra phiếu nhập).
 */
/**
 * DỰNG LƯỜI, KHÔNG PHẢI HẰNG SỐ MỨC MÔ-ĐUN.
 *
 * Chú thích ngay trên đã cảnh báo: `return-rate ← cogs ← stock ← return-rate` là một vòng import, và
 * biểu thức SQL dựng ở mức mô-đun trong vòng import có thể là `undefined` lúc nạp. Tôi đã dẫm đúng
 * vào đó: khai `ORDER_COGS_FAST` thành `const` làm phân bổ chi phí xuống mã ra 0 thay vì 700.000đ —
 * không lỗi, không cảnh báo, chỉ là con số sai. Hàm thì chỉ dựng lúc gọi, nên vòng import đã đóng.
 */
export function orderCogsFast() {
  return sql<number>`coalesce(
    (select
       -- ĐƠN ĐÃ GHI NHẬN GIAO THÀNH CÔNG: dùng giá vốn ĐÃ CHỐT tại thời điểm giao.
       --
       -- Đây là chỗ quyết định lợi nhuận kỳ đã qua có tự đổi hay không. Giá vốn lấy "phiếu nhập gần
       -- nhất tính theo hôm nay", nên nếu báo cáo đọc con số hiện tại thì nhập một lô mới sẽ viết
       -- lại lợi nhuận tháng trước. Đặt ở ĐÂY, trong hàm mà mọi báo cáo dùng chung, để Báo cáo lợi
       -- nhuận · Bảng điều khiển · Hiệu quả mẫu mã · Quảng cáo không thể nói ba con số khác nhau.
       coalesce(m.recognized_cogs, m.cogs)
     from canonical_order_outcome m
      where m.order_id = ${schema.orders.id}
        and coalesce(m.shipment_id, '') = coalesce(${schema.shipments.id}, '')
        and m.logic_version = ${CANONICAL_OUTCOME_VERSION}
        and m.computed_at >= ${schema.orders.updatedAt}),
    ${ORDER_COGS}
  )`;
}

export function orderCogsColumn() {
  return orderCogsFast().as("order_cogs");
}

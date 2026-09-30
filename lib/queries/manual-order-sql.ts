/**
 * Vị ngữ SQL "đơn tạo tay trên ERP" — CHỈ MÁY CHỦ. Luật và lý lẽ ở `lib/constants/manual-orders.ts`.
 *
 * Nhận diện bằng TIỀN TỐ ID (`erp-`), không bằng `orders.source` (kênh bán) hay trạng thái. Id Pancake là chuỗi số nên
 * vị ngữ không bao giờ chạm một đơn đồng bộ: ở tổ chức nhà nó luôn đúng với MỌI dòng, số liệu không đổi một đơn nào.
 */
import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { MANUAL_ORDER_ID_PREFIX } from "@/lib/constants/manual-orders";

const PATTERN = `${MANUAL_ORDER_ID_PREFIX}%`;

/** Đơn tạo tay (yêu cầu `orders` trong FROM, tên bảng gốc). */
export const IS_MANUAL_ORDER: SQL = sql`(${schema.orders.id} like ${PATTERN})`;

/**
 * Đơn KHÔNG phải tạo tay — phạm vi của phép so "tổng đơn marketer + Chưa gán = số đơn XÁC NHẬN PANCAKE" (AGENTS 3.9).
 * Đơn tay không có quảng cáo / fanpage / ad_id nào để quy kết, và không phải đơn Pancake: để nó lọt vào là đẩy nó vào
 * "Chưa gán marketer" và làm lệch đúng con số mà luật ấy khoá.
 */
export const NOT_MANUAL_ORDER: SQL = sql`(${schema.orders.id} not like ${PATTERN})`;

/**
 * ═══ ĐƠN TAY ĐÃ GIAO — CÓ PHIẾU GIAO KÝ NHẬN CÒN HIỆU LỰC (G-ORDER, ORDER_OUTCOME.md mục 11) ═══
 *
 * MỘT vị ngữ cho cả hai chiều mà phiếu giao được quyền kết luận:
 *  · LOGISTICS — nhánh đầu của `ORDER_OUTCOME` (đơn tay không vận đơn + vị ngữ này ⇒ `DELIVERED`);
 *  · TỒN KHO — `ORDER_LEFT_WAREHOUSE` (lib/queries/return-rate.ts, dùng ở sổ kho): vào "đã xuất", ra khỏi "chờ xuất / giữ hàng".
 * KHÔNG dùng cho tiền: phiếu giao không chứng minh đã thu (xem `REVENUE_RECOGNIZED_ON_DELIVERY`).
 *
 * Căn cứ là CHỨNG CỨ (dòng phiếu), không phải `orders.stage`: stage là hệ quả do action ghi, còn phiếu là thứ người
 * nhận đã ký. `"orders"."id"` viết tường minh — tham chiếu cột trần trong `exists` sẽ bị hiểu thành `dn.id`.
 */
export const MANUAL_ORDER_DELIVERED: SQL = sql`(${IS_MANUAL_ORDER} and exists (
  select 1 from order_delivery_notes dn where dn.order_id = "orders"."id" and dn.voided_at is null
))`;

/**
 * ═══ CHỨNG TỪ THANH TOÁN CỦA ĐƠN TAY (`order_payments`, 0181 — ORDER_OUTCOME.md mục 11) ═══
 *
 * Bản SQL của bảng chân lý trong `lib/constants/order-payments.ts` (`manualPaymentStatus`). Chỉ phiếu `CONFIRMED`; phiếu
 * THU cộng, phiếu HOÀN TRỪ. Tương quan với `"orders"."id"` viết tường minh (tham chiếu cột trần trong câu con sẽ bị hiểu
 * thành cột của `order_payments`). Đơn Pancake không bao giờ có dòng (CHECK `order_id LIKE 'erp-%'`).
 */
const PAYMENT_SUMS = sql`coalesce(sum(p.amount) filter (where p.kind = 'RECEIPT'), 0) as r, coalesce(sum(p.amount) filter (where p.kind = 'REFUND'), 0) as f`;
const PAYMENTS_OF_ORDER = sql`from order_payments p where p.order_id = "orders"."id" and p.status = 'CONFIRMED'`;

/** Số khách phải trả của đơn tay = tiền hàng sau chiết khấu + phí ship — bản SQL của `manualOrderAmountDue`. */
export const MANUAL_ORDER_AMOUNT_DUE_SQL: SQL = sql`(${schema.orders.totalPriceAfterDiscount} + ${schema.orders.shippingFee})`;

/** Σ thu − Σ hoàn (chứng từ còn hiệu lực) của đơn — 0 khi không có chứng từ nào. */
export const MANUAL_PAYMENT_NET_SQL: SQL = sql`(select coalesce(sum(case when p.kind = 'RECEIPT' then p.amount else -p.amount end), 0) ${PAYMENTS_OF_ORDER})`;

/**
 * Trạng thái thanh toán của đơn: `'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'REFUNDED'` cho đơn tay, NULL (không áp dụng)
 * cho mọi đơn khác. CASE ngoài bảo đảm đơn Pancake không chạy câu con nào.
 */
export const MANUAL_PAYMENT_STATUS_SQL: SQL = sql`(case when ${IS_MANUAL_ORDER} then (
  select case
    when x.r = 0 and x.f = 0 then 'UNPAID'
    when x.f > 0 and x.r - x.f <= 0 then 'REFUNDED'
    when x.r - x.f >= greatest(${MANUAL_ORDER_AMOUNT_DUE_SQL}, 1) then 'PAID'
    else 'PARTIALLY_PAID' end
  from (select ${PAYMENT_SUMS} ${PAYMENTS_OF_ORDER}) x
) end)`;

/**
 * ĐƠN TAY ĐÃ THU ĐỦ theo chứng từ: net ≥ max(số phải trả, 1) — đúng nhánh `PAID` của bảng chân lý. Đây là điều kiện
 * DUY NHẤT để chiều tiền của đơn tay được coi là ĐÃ XÁC MINH (`ORDER_OUTCOME_VERIFIED`). Phiếu giao không tham gia.
 */
export const MANUAL_ORDER_PAID: SQL = sql`(${IS_MANUAL_ORDER} and ${MANUAL_PAYMENT_NET_SQL} >= greatest(${MANUAL_ORDER_AMOUNT_DUE_SQL}, 1))`;

/**
 * ═══ "GIAO THÀNH CÔNG" CÓ KÉO THEO DOANH THU KHÔNG — cửa của MỌI tổng TIỀN dựng trên ORDER_OUTCOME = 'DELIVERED' ═══
 *
 * Ở tổ chức nhà, `ORDER_OUTCOME = 'DELIVERED'` đã mang sẵn chứng cứ tiền (luật 3.2b: COD thực thu / khai báo > 100K,
 * hoặc mã 501 của một kiện COD), nên các báo cáo cộng giá trị đơn DELIVERED làm "doanh thu giao thành công". Đơn tay
 * giao bằng phiếu ký nhận thì KHÔNG: G-ORDER tách hẳn giao hàng khỏi thanh toán — "không tự coi là đã thu tiền". Hôm nay
 * ERP chưa có đường ghi chứng từ thanh toán cho đơn tay, nên đơn tay đứng NGOÀI mọi tổng doanh thu / giá vốn / lợi
 * nhuận / hoa hồng tính theo DELIVERED — giá vốn đi cùng doanh thu, nếu không lợi nhuận kỳ gánh giá vốn của một khoản
 * thu chưa ghi nhận. Nó vẫn nằm trong mọi phép ĐẾM giao thành công (chiều logistics).
 *
 * Từ 0181 ERP ĐÃ có chứng từ thanh toán cho đơn tay (`order_payments`), nhưng vị ngữ này CỐ Ý CHƯA đổi: đổi nó là đổi
 * ~20 báo cáo tiền cùng lúc (lợi nhuận, marketer, lương / hoa hồng, sản phẩm, CRM…) — mỗi báo cáo cộng GIÁ TRỊ ĐƠN theo
 * mốc của nó, trong khi thực thu đơn tay phải cộng Σ CHỨNG TỪ theo `paid_at`; và câu con tương quan chen vào các câu gộp
 * nóng nhất của tổ chức nhà cần đo JIT trước. Thực thu đơn tay hôm nay đi ĐÚNG MỘT đường: dòng «Thực thu đơn tay» của
 * `getFinancialTruth` (theo `paid_at`). Nợ P1: docs/platform/pilot-readiness.md mục 4.
 * Tổ chức nhà: luôn đúng với mọi dòng (id Pancake là chuỗi số), không đổi một đồng nào.
 */
export const REVENUE_RECOGNIZED_ON_DELIVERY: SQL = sql`(${schema.orders.id} not like ${PATTERN})`;

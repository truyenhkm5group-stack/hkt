/**
 * Vị ngữ SQL "đơn tạo tay trên ERP" — CHỈ MÁY CHỦ. Luật và lý lẽ ở `lib/constants/manual-orders.ts`.
 *
 * Nhận diện bằng TIỀN TỐ ID (`erp-`), không bằng `orders.source` (kênh bán) hay trạng thái. Id Pancake là chuỗi số nên
 * vị ngữ không bao giờ chạm một đơn đồng bộ: ở tổ chức nhà nó luôn đúng với MỌI dòng, số liệu không đổi một đơn nào.
 */
import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { ERP_NATIVE_SETTING_KEY, MANUAL_ORDER_ID_PREFIX } from "@/lib/constants/manual-orders";

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
 * ═══ ĐƠN TAY CÓ NẰM TRONG BÁO CÁO TIỀN / BÁO CÁO DANH NGHĨA KHÔNG — theo TỔ CHỨC ═══
 *
 * Chủ shop HSLC chốt 03/10/2026 (ORDER_OUTCOME.md mục 11.3): «doanh thu + giá vốn đơn tay tính KHI ĐÃ GIAO; lợi nhuận
 * tiền thật chỉ phần đã có phiếu thu». Trước đó đơn tay đứng ngoài mọi tổng doanh thu / giá vốn / lợi nhuận (G-ORDER
 * 29/09) ⇒ tổ chức chỉ có đơn tay thấy báo cáo lợi nhuận toàn chi phí, lỗ giả — "nợ P1" của pilot-readiness mục 4.
 *
 * NHƯNG chỉ ở tổ chức KHÔNG đồng bộ đơn. Tổ chức đồng bộ Pancake (nhà) giữ nguyên luật 3.9 (tổng báo cáo = số đơn XÁC NHẬN
 * PANCAKE): một đơn `erp-` lọt vào CSDL ấy vẫn đứng ngoài, không đổi một đồng (`tests/pilot-orders.test.ts`). Câu hỏi "tổ
 * chức này có đồng bộ đơn không" trả lời bằng CHÍNH DỮ LIỆU của CSDL tổ chức: có đơn nào không phải `erp-` không. Câu con
 * KHÔNG tương quan ⇒ Postgres tính MỘT lần mỗi câu (InitPlan), dừng ở dòng đầu tiên — không tốn gì ở câu gộp nóng của nhà.
 */
const ORG_HAS_SYNCED_ORDERS: SQL = sql`exists (select 1 from orders so_sync where so_sync.id not like ${PATTERN})`;

/**
 * Quản trị shop đã TUYÊN BỐ chuyển hẳn sang ERP (`ERP_NATIVE_SETTING_KEY` — ORDER_OUTCOME.md mục 11.3): đơn Pancake trong CSDL
 * chỉ còn là LỊCH SỬ đã nhập, không phải dấu hiệu đang đồng bộ. Câu con KHÔNG tương quan ⇒ InitPlan, tính một lần mỗi câu.
 */
const ORG_DECLARED_ERP_NATIVE: SQL = sql`exists (select 1 from settings st_native where st_native.key = ${ERP_NATIVE_SETTING_KEY})`;

/** Đơn nằm trong báo cáo danh nghĩa / phép so marketer: đơn đồng bộ, hoặc MỌI đơn ở tổ chức không đồng bộ đơn / đã chuyển hẳn sang ERP. */
export const IN_SALES_REPORTS: SQL = sql`(${schema.orders.id} not like ${PATTERN} or not ${ORG_HAS_SYNCED_ORDERS} or ${ORG_DECLARED_ERP_NATIVE})`;

/**
 * "GIAO THÀNH CÔNG" CÓ KÉO THEO DOANH THU KHÔNG — cửa của MỌI tổng TIỀN dựng trên ORDER_OUTCOME = 'DELIVERED'. Cùng phạm
 * vi với `IN_SALES_REPORTS`. Doanh thu ở đây là DANH NGHĨA (giá trị đơn đã giao); chiều TIỀN THẬT của đơn tay vẫn chỉ đi
 * theo chứng từ `order_payments` (`MANUAL_ORDER_PAID`, `ORDER_OUTCOME_VERIFIED`, «Thực thu đơn tay» theo `paid_at`) —
 * phiếu giao không bao giờ là chứng từ thu tiền (ORDER_OUTCOME.md mục 10).
 */
export const REVENUE_RECOGNIZED_ON_DELIVERY: SQL = IN_SALES_REPORTS;

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
 * ═══ "GIAO THÀNH CÔNG" CÓ KÉO THEO DOANH THU KHÔNG — cửa của MỌI tổng TIỀN dựng trên ORDER_OUTCOME = 'DELIVERED' ═══
 *
 * Ở tổ chức nhà, `ORDER_OUTCOME = 'DELIVERED'` đã mang sẵn chứng cứ tiền (luật 3.2b: COD thực thu / khai báo > 100K,
 * hoặc mã 501 của một kiện COD), nên các báo cáo cộng giá trị đơn DELIVERED làm "doanh thu giao thành công". Đơn tay
 * giao bằng phiếu ký nhận thì KHÔNG: G-ORDER tách hẳn giao hàng khỏi thanh toán — "không tự coi là đã thu tiền". Hôm nay
 * ERP chưa có đường ghi chứng từ thanh toán cho đơn tay, nên đơn tay đứng NGOÀI mọi tổng doanh thu / giá vốn / lợi
 * nhuận / hoa hồng tính theo DELIVERED — giá vốn đi cùng doanh thu, nếu không lợi nhuận kỳ gánh giá vốn của một khoản
 * thu chưa ghi nhận. Nó vẫn nằm trong mọi phép ĐẾM giao thành công (chiều logistics).
 *
 * Ngày có chứng từ thanh toán cho đơn tay, vị ngữ này đổi thành "không phải đơn tay HOẶC có chứng từ" — ở ĐÚNG MỘT chỗ.
 * Tổ chức nhà: luôn đúng với mọi dòng (id Pancake là chuỗi số), không đổi một đồng nào.
 */
export const REVENUE_RECOGNIZED_ON_DELIVERY: SQL = sql`(${schema.orders.id} not like ${PATTERN})`;

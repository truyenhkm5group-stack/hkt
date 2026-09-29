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

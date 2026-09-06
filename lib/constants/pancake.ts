import type { OrderStage, ShipmentStage } from "@/db/schema";

/** Bảng trạng thái đơn hàng Pancake POS (theo OpenAPI chính thức) */
export const PANCAKE_ORDER_STATUS: Record<number, { name: string; stage: OrderStage }> = {
  0: { name: "Mới", stage: "NEW" },
  17: { name: "Chờ xác nhận", stage: "NEW" },
  11: { name: "Chờ hàng", stage: "WAITING" },
  20: { name: "Đã đặt hàng", stage: "WAITING" },
  1: { name: "Đã xác nhận", stage: "CONFIRMED" },
  12: { name: "Chờ in", stage: "CONFIRMED" },
  13: { name: "Đã in", stage: "CONFIRMED" },
  8: { name: "Đang đóng hàng", stage: "PACKING" },
  9: { name: "Chờ chuyển hàng", stage: "READY_TO_SHIP" },
  2: { name: "Đã gửi hàng", stage: "SHIPPED" },
  3: { name: "Đã nhận", stage: "DELIVERED" },
  16: { name: "Đã thu tiền", stage: "PAID" },
  4: { name: "Đang hoàn", stage: "RETURNING" },
  15: { name: "Hoàn một phần", stage: "PARTIAL_RETURN" },
  5: { name: "Đã hoàn", stage: "RETURNED" },
  6: { name: "Đã hủy", stage: "CANCELLED" },
  7: { name: "Đã xóa", stage: "DELETED" },
};

export const ORDER_STAGE_LABEL: Record<OrderStage, string> = {
  NEW: "Mới",
  WAITING: "Chờ hàng",
  CONFIRMED: "Đã xác nhận",
  PACKING: "Đang đóng hàng",
  READY_TO_SHIP: "Chờ chuyển hàng",
  SHIPPED: "Đã gửi hàng",
  DELIVERED: "Đã nhận",
  PAID: "Đã thu tiền",
  RETURNING: "Đang hoàn",
  PARTIAL_RETURN: "Hoàn một phần",
  RETURNED: "Đã hoàn",
  CANCELLED: "Đã hủy",
  DELETED: "Đã xóa",
};

export const ORDER_STAGE_ORDER: OrderStage[] = [
  "NEW",
  "WAITING",
  "CONFIRMED",
  "PACKING",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "PAID",
  "RETURNING",
  "PARTIAL_RETURN",
  "RETURNED",
  "CANCELLED",
  "DELETED",
];

/**
 * PHẠM VI ĐƠN DÙNG CHUNG cho mọi KPI quản trị: các trạng thái Pancake đã được chốt
 * (bỏ đơn Mới chưa xác nhận, đơn huỷ, đơn xoá). Tổng quan, Báo cáo lợi nhuận, Lương,
 * Quảng cáo và Chất lượng dữ liệu phải dùng CHUNG danh sách này, nếu không thì cùng một
 * kỳ sẽ ra số đơn khác nhau ở mỗi màn hình.
 */
export const CONFIRMED_STAGES = ["CONFIRMED", "PACKING", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "PAID", "RETURNING", "PARTIAL_RETURN", "RETURNED"] as const;

/** Các giai đoạn tính là "đơn thành công" (đã giao/đã thu tiền) */
export const SUCCESS_STAGES: OrderStage[] = ["DELIVERED", "PAID"];
/** Các giai đoạn tính là "đơn thất bại" */
export const FAILED_STAGES: OrderStage[] = ["RETURNING", "RETURNED", "CANCELLED", "DELETED", "PARTIAL_RETURN"];
/** Đơn đang trong luồng xử lý/giao */
export const ACTIVE_STAGES: OrderStage[] = ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP", "SHIPPED"];

export function pancakeStatusToStage(status: number): OrderStage {
  return PANCAKE_ORDER_STATUS[status]?.stage ?? "NEW";
}

export function pancakeStatusName(status: number) {
  return PANCAKE_ORDER_STATUS[status]?.name ?? `Trạng thái ${status}`;
}

/** Nguồn đơn hàng theo mã (order_sources / marketplace_id) */
export const PANCAKE_ORDER_SOURCES: Record<string, string> = {
  "-1": "Facebook",
  "-2": "Website",
  "-3": "Shopee",
  "-4": "Lazada",
  "-5": "Tiki",
  "-6": "Sendo",
  "-7": "TikTok Shop",
  "-8": "Zalo",
  "-9": "TikTok Shop",
  "-10": "Khác",
  "-16": "WooCommerce",
  "-17": "Shopify",
};

/** partner_status của ĐVVC trong Pancake → mô tả & giai đoạn vận đơn */
export const PANCAKE_PARTNER_STATUS: Record<string, { name: string; stage: ShipmentStage }> = {
  waiting: { name: "Chờ xử lý", stage: "PENDING" },
  request_received: { name: "ĐVVC đã tiếp nhận đơn", stage: "PENDING" },
  processing_picked_up: { name: "Đang xử lý lấy hàng", stage: "PENDING" },
  picking_up: { name: "Đang lấy hàng", stage: "PENDING" },
  delay_pickup: { name: "Trễ lấy hàng", stage: "PENDING" },
  picked_up: { name: "Đã lấy hàng", stage: "PICKED_UP" },
  waiting_on_the_way: { name: "Chờ trung chuyển", stage: "IN_TRANSIT" },
  on_the_way: { name: "Đang trung chuyển", stage: "IN_TRANSIT" },
  contact_delivery_company: { name: "Liên hệ ĐVVC", stage: "IN_TRANSIT" },
  out_for_delivery: { name: "Đang giao hàng", stage: "OUT_FOR_DELIVERY" },
  delay_delivery: { name: "Trễ giao hàng", stage: "OUT_FOR_DELIVERY" },
  inform_recipient: { name: "Thông báo cho người nhận", stage: "OUT_FOR_DELIVERY" },
  undeliverable: { name: "Giao không thành", stage: "DELIVERY_FAILED" },
  waiting_for_return: { name: "Chờ chuyển hoàn", stage: "RETURNING" },
  delivered: { name: "Đã giao hàng", stage: "DELIVERED" },
  delivered_cod: { name: "Đã giao hàng, đã đối soát COD", stage: "DELIVERED" },
  returning: { name: "Đang chuyển hoàn", stage: "RETURNING" },
  returned: { name: "Đã chuyển hoàn", stage: "RETURNED" },
  returned_cod: { name: "Đã chuyển hoàn, đã đối soát COD", stage: "RETURNED" },
  canceled: { name: "Đã hủy vận đơn", stage: "CANCELLED" },
};

export const SOURCE_COLORS: Record<string, string> = {
  Facebook: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Shopee: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  "TikTok Shop": "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  Lazada: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  Website: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  Zalo: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  Instagram: "bg-pink-50 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
};

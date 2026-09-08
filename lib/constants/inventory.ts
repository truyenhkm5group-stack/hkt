/**
 * ───────────────────── NĂM TRẠNG THÁI CỦA HÀNG ─────────────────────
 *
 * Đặt tên để không ai còn nói trống không "tồn kho". Ba con số đầu là ba mức khác nhau, và
 * chúng thường xuyên bị đọc nhầm thành một.
 *
 * Nguồn sự thật của cả năm: PHIẾU KHO và TRẠNG THÁI VẬN ĐƠN (`SHIPMENT_LEFT_WAREHOUSE`).
 * TUYỆT ĐỐI không dùng `ORDER_OUTCOME` — đó là định nghĩa theo tiền thực thu, dành cho doanh thu.
 * Hàng rời kho lúc bưu tá lấy hàng, không phải lúc khách trả tiền.
 */
export type StockState = "ON_HAND" | "RESERVED" | "AVAILABLE" | "INBOUND" | "UNSELLABLE";

export const STOCK_STATE_LABEL: Record<StockState, string> = {
  ON_HAND: "Tồn thực tế",
  RESERVED: "Đã chốt đơn, chưa xuất",
  AVAILABLE: "Khả dụng bán",
  INBOUND: "Đang về kho",
  UNSELLABLE: "Hụt / không bán được",
};

export const STOCK_STATE_HINT: Record<StockState, string> = {
  ON_HAND: "Tổng phiếu kho trừ đi số đã xuất qua ĐVVC. Đây là số hàng đang nằm trong kho.",
  RESERVED: "Đã có khách chốt nhưng bưu tá chưa lấy. Vẫn nằm trong kho nhưng đã hứa cho khách.",
  AVAILABLE: "Tồn thực tế trừ hàng đã chốt đơn. Đây mới là số được phép bán tiếp.",
  INBOUND: "Hàng đang trên đường về kho: đơn sản xuất chưa nhập, cộng hàng hoàn ước tính quay lại được.",
  UNSELLABLE: "Hàng hoàn đã lập phiếu nhưng đếm thiếu so với số đã xuất — hụt, hỏng, hoặc mất trên đường về.",
};

/**
 * Ngưỡng cứng `tồn <= N` KHÔNG được dùng để cảnh báo thiếu hàng.
 *
 * Mẫu mã bán 20 cái/ngày mà còn 8 cái là sắp cháy hàng; mẫu mã bán 1 cái/tháng mà còn 3 cái thì
 * vẫn dư. Cảnh báo phải đi theo RỦI RO: khả dụng ÷ tốc độ bán so với thời gian sản xuất
 * (`lib/constants/planning.ts::computePlan` → `PlanStatus`).
 *
 * Giữ hằng số này để tài liệu hoá điều đã bỏ, và để kiểm thử bất biến chặn việc nó quay lại.
 */
export const REJECTED_HARD_STOCK_THRESHOLD = "tồn <= 5" as const;

/** Nhãn tiếng Việt cho bảng tham chiếu (table_name) trong nhật ký kho Pancake */
export const INVENTORY_TABLE_LABEL: Record<string, string> = {
  orders: "Đơn hàng",
  purchases: "Nhập hàng",
  purchase_orders: "Nhập hàng",
  warehouse_transfers: "Chuyển kho",
  transfers: "Chuyển kho",
  returns: "Trả hàng",
  order_returns: "Trả hàng",
  stocktakings: "Kiểm kho",
  inventory_checks: "Kiểm kho",
  adjustments: "Điều chỉnh",
  none: "Khác",
};

export function inventoryTableLabel(tableName: string | null | undefined) {
  if (!tableName) return INVENTORY_TABLE_LABEL.none;
  return INVENTORY_TABLE_LABEL[tableName] ?? tableName.replace(/_/g, " ");
}

/** Màu nhãn theo bảng tham chiếu */
export const INVENTORY_TABLE_TONE: Record<string, string> = {
  orders: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  purchases: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  purchase_orders: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  warehouse_transfers: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  transfers: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  returns: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  order_returns: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  stocktakings: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};

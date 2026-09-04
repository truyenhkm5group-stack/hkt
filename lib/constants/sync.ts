/** Nhãn tiếng Việt cho tên job nội bộ ghi trong bảng sync_runs */
export const SYNC_JOB_LABEL: Record<string, string> = {
  orders_incremental: "Đơn hàng mới cập nhật",
  orders_backfill: "Đồng bộ lịch sử đơn hàng",
  orders_reconcile: "Đối chiếu lại đơn gần đây",
  warehouses: "Danh sách kho",
  products: "Sản phẩm & tồn kho",
  customers: "Khách hàng",
  customers_full: "Khách hàng (toàn bộ)",
  inventory_histories: "Nhật ký xuất nhập kho",
  order_returns: "Đơn đổi/trả",
  tracking_poll: "Trạng thái vận đơn Viettel Post",
  tracking_selected: "Cập nhật vận đơn được chọn",
  orders_import: "Nhập vận đơn từ Viettel Post",
};

export function syncJobLabel(job: string) {
  return SYNC_JOB_LABEL[job] ?? job;
}

/** Khoá job trong JOB_DEFINITIONS (/api/sync/<job>) → tên job nội bộ trong sync_runs / runningJobKeys (SOURCE:job) */
export const JOB_RUN_KEYS: Record<string, string[]> = {
  "pancake-orders": ["PANCAKE:orders_incremental"],
  "pancake-backfill": ["PANCAKE:orders_backfill"],
  "pancake-reconcile": ["PANCAKE:orders_reconcile"],
  "pancake-products": ["PANCAKE:products"],
  "pancake-warehouses": ["PANCAKE:warehouses"],
  "pancake-customers": ["PANCAKE:customers", "PANCAKE:customers_full"],
  "pancake-inventory": ["PANCAKE:inventory_histories"],
  "pancake-returns": ["PANCAKE:order_returns"],
  "pancake-all": ["PANCAKE:warehouses", "PANCAKE:products", "PANCAKE:orders_backfill", "PANCAKE:orders_incremental", "PANCAKE:customers", "PANCAKE:order_returns", "PANCAKE:inventory_histories"],
  "vtp-tracking": ["VIETTELPOST:tracking_poll", "VIETTELPOST:tracking_selected"],
  "vtp-import": ["VIETTELPOST:orders_import"],
};

export const SYNC_SOURCE_LABEL: Record<string, string> = {
  PANCAKE: "Pancake POS",
  VIETTELPOST: "Viettel Post",
  ALL: "Tất cả",
};

export const SYNC_TRIGGER_LABEL: Record<string, string> = {
  MANUAL: "Thủ công",
  CRON: "Lịch tự động",
  WEBHOOK: "Webhook",
};

export const SYNC_STATUS_ORDER = ["RUNNING", "SUCCESS", "PARTIAL", "FAILED"];
export const WEBHOOK_STATUS_ORDER = ["RECEIVED", "PROCESSED", "IGNORED", "FAILED"];

export const RUN_STATUS_LABEL: Record<string, string> = {
  SUCCESS: "Thành công",
  PARTIAL: "Một phần",
  RUNNING: "Đang chạy",
  FAILED: "Thất bại",
  PROCESSED: "Đã xử lý",
  RECEIVED: "Đã nhận",
  IGNORED: "Bỏ qua",
};

/** Loại webhook Pancake / Viettel Post */
export const WEBHOOK_EVENT_LABEL: Record<string, string> = {
  orders: "Đơn hàng",
  customers: "Khách hàng",
  products: "Sản phẩm",
  variations_warehouses: "Tồn kho",
  unknown: "Không xác định",
  tracking: "Hành trình vận đơn",
};

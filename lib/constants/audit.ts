/** Nhãn hành động trong audit_logs (fallback: mã gốc) */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  LOGIN: "Đăng nhập",
  LOGOUT: "Đăng xuất",
  PASSWORD_CHANGE: "Đổi mật khẩu",
  USER_CREATE: "Tạo người dùng",
  USER_UPDATE: "Sửa người dùng",
  USER_LOCK: "Khoá người dùng",
  USER_UNLOCK: "Mở khoá người dùng",
  USER_RESET_PASSWORD: "Đặt lại mật khẩu",
  EXPENSE_CREATE: "Thêm chi phí",
  EXPENSE_UPDATE: "Sửa chi phí",
  EXPENSE_ALLOCATION_SET: "Khai kỳ hiệu lực cho chi phí",
  EXPENSE_DELETE: "Xoá chi phí",
  AD_SPEND_CREATE: "Thêm chi tiêu QC",
  AD_SPEND_UPDATE: "Sửa chi tiêu QC",
  AD_SPEND_DELETE: "Xoá chi tiêu QC",
  STOCK_RECEIPT_CREATE: "Nhập hàng vào kho",
  STOCK_ADJUST_CREATE: "Điều chỉnh kiểm kê",
  STOCK_RECEIPT_DELETE: "Xoá phiếu kho",
  /** Hệ thống chốt lại giá vốn đã ghi nhận — đúng một lần, khi có chứng từ kho mạnh hơn. */
  COGS_TRUE_UP: "Chốt lại giá vốn theo chứng từ kho",
  COD_PAID: "Ghi nhận COD về ngân hàng",
  COD_RECONCILE: "Đối soát COD",
  /**
   * Chủ shop mở trang Viettel Post, đọc trạng thái rồi chép lại. Chạy một lần cho lịch sử, nhưng
   * PHẢI truy nguyên được: nó ghi thẳng chứng từ vào lịch sử mà không có hệ thống ngoài nào đối
   * chứng, nên đây chính là loại hành động cần nhật ký nhất.
   */
  VTP_MANUAL_VERIFICATION: "Chép tay chứng từ Viettel Post",
  VTP_ORDER_LIST_IMPORT: "Nhập danh sách vận đơn Viettel Post",
  COD_BATCH_CREATE: "Tạo bảng kê COD",
  SHIPMENT_REPUSH: "Yêu cầu VTP gửi lại webhook",
  SYNC_RUN: "Chạy đồng bộ",
  SETTINGS_UPDATE: "Cập nhật cấu hình",
  "reconcile.repair": "Đối soát tự sửa dữ liệu",
  "backfill.canonical-state": "Dựng lại trạng thái từ lịch sử",
  "webhook.replay": "Xử lý lại gói tin",
  "case.assign": "Giao việc cho người xử lý",
  "case.acknowledge": "Tiếp nhận việc",
  "case.resolve": "Đóng việc",
  "case.start": "Bắt đầu làm việc",
  "case.ignore": "Bỏ qua việc (có lý do)",
  "case.unignore": "Bỏ đánh dấu bỏ qua",
  VTP_ORDER_LIST_ROW: "Nhập dòng danh sách vận đơn",
  "return.received": "Xác nhận nhận hàng hoàn",
  "return.received.undo": "Huỷ xác nhận nhận hàng hoàn",
  "return.received.bulk": "Xác nhận nhận hàng hoàn hàng loạt",
};

export const AUDIT_ENTITY_LABEL: Record<string, string> = {
  USER: "Người dùng",
  ORDER: "Đơn hàng",
  SHIPMENT: "Vận đơn",
  EXPENSE: "Chi phí",
  STOCK_RECEIPT: "Phiếu kho",
  AD_SPEND: "Chi tiêu QC",
  COD_BATCH: "Bảng kê COD",
  PRODUCT: "Sản phẩm",
  CUSTOMER: "Khách hàng",
  SETTINGS: "Cấu hình",
  SYNC: "Đồng bộ",
  NOTIFICATION: "Việc cần xử lý",
  WEBHOOK_EVENT: "Gói tin webhook",
  DATA_RULE: "Luật đối soát",
  shipments: "Vận đơn",
};

export function auditActionLabel(action: string) {
  return AUDIT_ACTION_LABEL[action] ?? action;
}

export function auditEntityLabel(entity: string) {
  return AUDIT_ENTITY_LABEL[entity] ?? entity;
}

/** Đường dẫn tới đối tượng (nếu có trang chi tiết) */
export function auditEntityHref(entity: string, entityId: string): string | null {
  if (!entityId) return null;
  switch (entity) {
    case "ORDER":
      return `/orders/${entityId}`;
    case "SHIPMENT":
      return `/shipments/${entityId}`;
    case "CUSTOMER":
      return `/customers/${entityId}`;
    case "USER":
      return "/settings/users";
    case "EXPENSE":
      return "/expenses?period=all";
    case "AD_SPEND":
      return "/ads?period=all";
    default:
      return null;
  }
}

/** Màu nhãn theo nhóm hành động */
export function auditActionTone(action: string) {
  if (/DELETE|LOCK$|FAILED/.test(action)) return "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300";
  if (/CREATE|UNLOCK|PAID|RECONCILE/.test(action)) return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
  if (/UPDATE|CHANGE|RESET/.test(action)) return "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
  if (/LOGIN|LOGOUT/.test(action)) return "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
  return "bg-muted text-muted-foreground";
}

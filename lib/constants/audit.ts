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
  SESSION_REVOKE: "Thu hồi phiên đăng nhập",
  USER_PERMISSIONS: "Đổi quyền người dùng",
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
  RETURN_DISPOSITION_SET: "Ghi kết cục hàng hoàn không tái nhập",
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
  "care.record": "CSKH ghi nhận việc đã làm",
  "care.status": "Đổi trạng thái care nội bộ",
  "care.owner": "Giao kiện cho người care",
  "care.followUp": "Hẹn theo dõi lại kiện",
  "care.note": "Ghi note care",
  "carrier.request": "Gửi yêu cầu tới ĐVVC",
  "carrier.request.result": "ĐVVC trả lời yêu cầu",
  "carrier.manual": "Xác nhận đã làm tay trên ĐVVC",
  // Company OS · Agent C — sản xuất nửa đầu.
  PRODUCTION_TOPIC_CREATE: "Mở topic sản xuất",
  PRODUCTION_TOPIC_MESSAGE: "Ghi trao đổi vào topic sản xuất",
  PRODUCTION_TOPIC_STATUS: "Đổi trạng thái topic sản xuất",
  PRODUCTION_TOPIC_FILE_ADD: "Đính kèm ảnh / video vào topic sản xuất",
  PRODUCTION_TOPIC_FILE_REMOVE: "Gỡ ảnh / video khỏi topic sản xuất",
  MODEL_REGISTER_PROVISIONAL: "Đăng ký mẫu mới chưa có mã (mã tạm)",
  MODEL_CODE_ASSIGN: "Chốt mã chính thức cho mẫu mang mã tạm",
  COST_SHEET_CREATE: "Lập phiên bản giá thành",
  COST_SHEET_UPDATE: "Sửa bảng giá thành nháp",
  COST_SHEET_FINALIZE: "Chốt giá thành",
  SAMPLE_CREATE: "Ghi mẫu xưởng làm",
  SAMPLE_UPDATE: "Sửa mẫu xưởng đang làm",
  SAMPLE_SUBMIT: "Gửi mẫu chờ duyệt",
  SAMPLE_REVIEW: "Ghi phán quyết duyệt mẫu",
  RECOMMENDATION_DECIDED: "Phản ứng với đề xuất (Cần anh quyết)",
  // Company OS · sổ mẫu & vòng đời (lib/actions/models.ts).
  MODEL_STATE_CHANGE: "Khai / chuyển trạng thái vòng đời mẫu",
  MODEL_OWNER_CHANGE: "Đổi người phụ trách mẫu",
  MODEL_REGISTER: "Đăng ký mẫu mới vào sổ",
  MODEL_REGISTRY_SYNC: "Đồng bộ sổ mẫu (bấm tay)",
  // Lệnh đặt xưởng (lib/actions/production.ts).
  PRODUCTION_ORDER_CREATE: "Tạo lệnh đặt xưởng",
  PRODUCTION_ORDER_UPDATE: "Sửa lệnh đặt xưởng",
  PRODUCTION_ORDER_STATUS: "Đổi trạng thái lệnh đặt xưởng",
  PRODUCTION_ORDER_DELETE: "Xoá lệnh đặt xưởng",
  // Bàn nhận hàng hoàn · kiện không mã (lib/actions/returns-unidentified.ts).
  "return.received.scan": "Bắn mã nhận hàng hoàn tại bàn kho",
  "return.unidentified.created": "Ghi kiện hoàn không mã (giữ tạm)",
  "return.unidentified.identified": "Xác định đơn cho kiện hoàn không mã",
  "return.unidentified.unidentifiable": "Chốt kiện hoàn không xác định được đơn",
  "return.unidentified.condition": "Ghi tình trạng kiện hoàn không mã",
  "return.unidentified.restock": "Tái nhập kiện hoàn đã xác định đơn",
  "return.unidentified.restock.override": "Tái nhập kiện hoàn KHÔNG có chứng từ đơn (quản lý quyết)",
  "return.unidentified.variant_identified": "Xác định mẫu mã cho kiện hoàn",
  "return.unidentified.variant_changed": "Đổi mẫu mã đã xác định cho kiện hoàn",
  // Duyệt hai bước (lib/approvals/service.ts). Dạng `approval.<bước>:<việc>` đọc qua `auditActionLabel`.
  "approval.enforce": "Bật / tắt cưỡng chế duyệt hai bước",
  "approval.enforce.apply-legacy": "Áp dụng cấu hình cưỡng chế duyệt cũ",
  "approval.approve": "Duyệt yêu cầu hai bước",
  "approval.reject": "Từ chối yêu cầu hai bước",
  "approval.expire": "Yêu cầu duyệt hết hiệu lực",
  "approval.request": "Xin duyệt hai bước",
  "approval.skip": "Làm không qua duyệt (chưa cưỡng chế / dưới ngưỡng)",
  "approval.execute": "Thực hiện việc đã được duyệt",
  "approval.execute_failed": "Việc đã duyệt thực hiện hỏng — trả lại lời duyệt",
  "approval.blocked": "Chặn: cần duyệt mà chưa có người đủ tư cách duyệt",
  "approval.reservation_released": "Nhả lời duyệt giữ chỗ quá hạn",
};

export const AUDIT_ENTITY_LABEL: Record<string, string> = {
  RECOMMENDATION: "Đề xuất trên buồng lái",
  PRODUCTION_TOPIC: "Topic sản xuất",
  COST_SHEET: "Bảng giá thành",
  SAMPLE: "Mẫu xưởng làm",
  USER: "Người dùng",
  ORDER: "Đơn hàng",
  SHIPMENT: "Vận đơn",
  EXPENSE: "Chi phí",
  STOCK_RECEIPT: "Phiếu kho",
  RETURN_DISPOSITION: "Kết cục hàng hoàn",
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
  PRODUCT_MODEL: "Mẫu (sổ mẫu)",
  PRODUCTION_ORDER: "Lệnh đặt xưởng",
  APPROVAL: "Duyệt hai bước",
  APPROVAL_REQUEST: "Yêu cầu duyệt hai bước",
  return_unidentified: "Kiện hoàn không mã",
};

/**
 * Nhãn hành động. Dạng ghép `<bước>:<việc>` (duyệt hai bước ghi `approval.skip:production.save`) đọc nhãn
 * của BƯỚC rồi kèm việc — mỗi việc được cổng duyệt không cần một dòng nhãn riêng cho từng bước.
 */
export function auditActionLabel(action: string) {
  const exact = AUDIT_ACTION_LABEL[action];
  if (exact) return exact;
  const i = action.indexOf(":");
  if (i > 0) {
    const buoc = AUDIT_ACTION_LABEL[action.slice(0, i)];
    const viec = action.slice(i + 1);
    if (buoc && viec) return `${buoc} · ${AUDIT_ACTION_LABEL[viec] ?? viec}`;
  }
  return action;
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
    case "PRODUCT_MODEL":
      return `/models/${entityId}`;
    case "PRODUCTION_ORDER":
      return `/inventory/planning/orders/${entityId}`;
    default:
      return null;
  }
}

/** Màu nhãn theo nhóm hành động */
export function auditActionTone(action: string) {
  if (/DELETE|LOCK$|FAILED|SESSION_REVOKE/.test(action)) return "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300";
  if (/CREATE|UNLOCK|PAID|RECONCILE/.test(action)) return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
  if (/UPDATE|CHANGE|RESET/.test(action)) return "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
  if (/LOGIN|LOGOUT/.test(action)) return "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
  return "bg-muted text-muted-foreground";
}

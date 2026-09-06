/** Cấu hình cảnh báo vận hành (lưu trong settings "alerts.config"); token Telegram có thể đặt qua env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID */
export type AlertConfig = {
  telegramBotToken: string;
  telegramChatId: string;
  /** Lark Suite: webhook của Custom Bot trong nhóm nhân viên vận đơn */
  larkWebhookUrl: string;
  /** Lark Suite: khoá ký (Signature) nếu bật */
  larkSecret: string;
  /** Lark Suite: webhook nhóm nhận cảnh báo ngưỡng thanh toán tài khoản quảng cáo (trống = dùng webhook chính) */
  larkBillingWebhookUrl: string;
  larkBillingSecret: string;
  /** Cảnh báo khi dư nợ đạt N% ngưỡng thanh toán */
  billingWarnPercent: number;
  /** Đơn rủi ro: khách đã hoàn ≥ N đơn và tỷ lệ hoàn ≥ M% (theo Pancake hoặc lịch sử ERP) → báo CSKH xin cọc */
  riskMinReturned: number;
  riskReturnRatePct: number;
  /** Đơn đã lên nhưng chưa xác nhận / chưa giao ĐVVC quá N giờ → cảnh báo "chờ xử lý" */
  pendingHours: number;
  /** Vận đơn đang giao không cập nhật quá N ngày → cảnh báo "treo lâu" */
  staleDays: number;
  /** Chỉ xét đơn / vận đơn phát sinh trong N ngày gần đây (bỏ qua đơn cũ đã bỏ) */
  lookbackDays: number;
  /** Bật/tắt từng loại */
  enabled: { failed: boolean; pending: boolean; stale: boolean; returning: boolean; cs: boolean; stock: boolean; billing: boolean; risk: boolean; incomplete: boolean };
};

export const ALERT_CONFIG_KEY = "alerts.config";

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  telegramBotToken: "",
  telegramChatId: "",
  larkWebhookUrl: "",
  larkSecret: "",
  larkBillingWebhookUrl: "",
  larkBillingSecret: "",
  billingWarnPercent: 80,
  riskMinReturned: 2,
  riskReturnRatePct: 40,
  pendingHours: 24,
  staleDays: 4,
  lookbackDays: 14,
  enabled: { failed: true, pending: true, stale: true, returning: true, cs: true, stock: true, billing: true, risk: true, incomplete: true },
};

export const NOTIFICATION_KIND_LABEL: Record<string, string> = {
  SHIPMENT_FAILED: "Giao thất bại · chờ phát lại",
  ORDER_PENDING: "Đơn chờ xử lý quá hạn",
  ORDER_INCOMPLETE: "Đơn thiếu SĐT / địa chỉ",
  SHIPMENT_STALE: "Vận đơn treo lâu",
  SHIPMENT_RETURNING: "Đang chuyển hoàn",
  CS_CASE: "Case CSKH mới",
  STOCK_LOW: "Thiếu hàng · cần sản xuất",
  ADS_BILLING: "Tài khoản QC · ngưỡng thanh toán",
  RISKY_ORDER: "Đơn rủi ro · xin cọc",
  SYSTEM: "Hệ thống",
};

export const NOTIFICATION_KIND_ORDER = ["ORDER_INCOMPLETE", "SHIPMENT_FAILED", "ORDER_PENDING", "SHIPMENT_STALE", "SHIPMENT_RETURNING", "CS_CASE", "STOCK_LOW", "ADS_BILLING", "RISKY_ORDER", "SYSTEM"];

export const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  info: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
};

/** Trạng thái tài khoản quảng cáo Facebook (account_status) */
export const FB_ACCOUNT_STATUS_LABEL: Record<number, string> = {
  1: "Hoạt động",
  2: "Bị vô hiệu hoá",
  3: "Chưa thanh toán",
  7: "Chờ xét duyệt rủi ro",
  8: "Chờ thanh toán",
  9: "Ân hạn",
  100: "Chờ đóng",
  101: "Đã đóng",
  201: "Bất kỳ hoạt động",
  202: "Bất kỳ đã đóng",
};

/** Lý do Meta vô hiệu hoá tài khoản (disable_reason) */
export const FB_DISABLE_REASON_LABEL: Record<number, string> = {
  0: "",
  1: "Vi phạm chính sách quảng cáo",
  2: "Đang xét duyệt IP",
  3: "Rủi ro thanh toán / thẻ bị từ chối",
  4: "Tài khoản xám bị đóng",
  5: "Xét duyệt AFC",
  6: "Vi phạm tính toàn vẹn doanh nghiệp",
  7: "Đóng vĩnh viễn",
  8: "Tài khoản đại lý không dùng",
  9: "Tài khoản không dùng",
  10: "Tài khoản ô",
  11: "Vi phạm chính sách Business Manager",
  12: "Khai báo sai tài khoản",
};

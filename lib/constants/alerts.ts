/** Cấu hình cảnh báo vận hành (lưu trong settings "alerts.config"); token Telegram có thể đặt qua env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID */
export type AlertConfig = {
  telegramBotToken: string;
  telegramChatId: string;
  /** Đơn đã lên nhưng chưa xác nhận / chưa giao ĐVVC quá N giờ → cảnh báo "chờ xử lý" */
  pendingHours: number;
  /** Vận đơn đang giao không cập nhật quá N ngày → cảnh báo "treo lâu" */
  staleDays: number;
  /** Bật/tắt từng loại */
  enabled: { failed: boolean; pending: boolean; stale: boolean; returning: boolean };
};

export const ALERT_CONFIG_KEY = "alerts.config";

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  telegramBotToken: "",
  telegramChatId: "",
  pendingHours: 24,
  staleDays: 4,
  enabled: { failed: true, pending: true, stale: true, returning: true },
};

export const NOTIFICATION_KIND_LABEL: Record<string, string> = {
  SHIPMENT_FAILED: "Giao thất bại · chờ phát lại",
  ORDER_PENDING: "Đơn chờ xử lý quá hạn",
  SHIPMENT_STALE: "Vận đơn treo lâu",
  SHIPMENT_RETURNING: "Đang chuyển hoàn",
  SYSTEM: "Hệ thống",
};

export const NOTIFICATION_KIND_ORDER = ["SHIPMENT_FAILED", "ORDER_PENDING", "SHIPMENT_STALE", "SHIPMENT_RETURNING", "SYSTEM"];

export const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  info: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
};

/**
 * ───────────── NGƯỠNG HÀNG BÁN CHẬM / VỐN NẰM CHẾT ─────────────
 *
 * Một chỗ duy nhất. Đây là ngưỡng PHÂN TÍCH, không phải ngưỡng nghiệp vụ về tiền hay kết quả đơn:
 * nó không đổi con số nào trong báo cáo, chỉ quyết định mẫu mã nào được gọi tên ra.
 */
export const SLOW_MOVING_RULES = {
  /** Không bán được cái nào trong ngần này ngày ⇒ hàng chết. */
  deadDays: 60,
  /** Tồn đủ bán quá ngần này ngày ⇒ vốn nằm chết. */
  excessCoverDays: 120,
  /** Tồn đủ bán quá ngần này ngày ⇒ bán chậm. */
  slowCoverDays: 60,
  /**
   * Mức tồn coi là lành mạnh, dùng làm mốc tính PHẦN VỐN VƯỢT MỨC.
   * Giữ hàng đủ bán 45 ngày là bình thường; phần nhiều hơn thế là tiền đáng lẽ không phải nằm đây.
   */
  healthyCoverDays: 45,
} as const;

export type StockRisk = "DEAD" | "EXCESS" | "SLOW" | "HEALTHY";

export const STOCK_RISK_LABEL: Record<StockRisk, string> = {
  DEAD: "Hàng chết",
  EXCESS: "Vốn nằm chết",
  SLOW: "Bán chậm",
  HEALTHY: "Bình thường",
};

export const STOCK_RISK_TONE: Record<StockRisk, string> = {
  DEAD: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  EXCESS: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  SLOW: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  HEALTHY: "bg-muted text-muted-foreground",
};

export const STOCK_RISK_ACTION: Record<StockRisk, string> = {
  DEAD: "Xả giá vốn hoặc gộp thành combo — giữ tiếp chỉ tốn thêm chỗ và vốn.",
  EXCESS: "Ngừng đặt thêm, đẩy bán bằng ưu đãi cho tới khi tồn về mức bán được trong một–hai tháng.",
  SLOW: "Chưa cần xả, nhưng KHÔNG đặt thêm cho tới khi nhịp bán tăng lại.",
  HEALTHY: "Không cần làm gì.",
};

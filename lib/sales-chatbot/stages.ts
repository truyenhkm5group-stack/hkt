/**
 * QUY TRÌNH BÁN 5 BƯỚC (chủ shop 01/10/2026): báo giá + xác định đúng sản phẩm → tư vấn + xử lý phản đối → lấy thông tin
 * khách + kiểm tra khách cũ → upsell / cross-sell → xác nhận / chốt đơn. `DONE` = đã chốt; `DECLINED` = khách từ chối rõ.
 * Bước do AI ghi (`set_sales_stage`) — dùng cho màn hình và cho kịch bản follow-up, KHÔNG quyết định quyền ghi nào.
 */
export const SALES_STAGES = ["QUOTE", "CONSULT", "INFO", "UPSELL", "CONFIRM", "DONE", "DECLINED"] as const;
export type SalesStage = (typeof SALES_STAGES)[number];
export const SALES_STAGE_LABEL: Record<SalesStage, string> = {
  QUOTE: "Báo giá · xác định sản phẩm",
  CONSULT: "Tư vấn · xử lý phản đối",
  INFO: "Lấy thông tin · kiểm tra khách cũ",
  UPSELL: "Upsell / cross-sell",
  CONFIRM: "Xác nhận · chốt đơn",
  DONE: "Đã chốt",
  DECLINED: "Khách từ chối",
};

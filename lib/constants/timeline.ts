/**
 * Năm CHIỀU SỰ THẬT của một đơn hàng. Không chiều nào được suy ra từ chiều nào — đó là luật gốc
 * của ERP này, và dòng thời gian phải giữ nguyên ranh giới đó bằng cách gắn nhãn từng mốc.
 */
export type TimelineDimension = "ORDER" | "SHIPMENT" | "MONEY" | "INVENTORY" | "MANUAL";

export const DIMENSION_LABEL: Record<TimelineDimension, string> = {
  ORDER: "Đơn hàng",
  SHIPMENT: "Giao vận",
  MONEY: "Tiền",
  INVENTORY: "Kho",
  MANUAL: "Người dùng",
};

export const DIMENSION_TONE: Record<TimelineDimension, string> = {
  ORDER: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  SHIPMENT: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  MONEY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  INVENTORY: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  MANUAL: "bg-muted text-muted-foreground",
};

/**
 * SỨC NẶNG BẰNG CHỨNG của từng nguồn — cùng một câu "đã giao" nhưng Viettel Post nói và Pancake
 * nói là hai chuyện hoàn toàn khác nhau. Nhãn này hiện ngay cạnh mốc để người đọc không kết luận
 * sai. Xem docs/business-rules/ORDER_OUTCOME.md.
 */
export const SOURCE_WEIGHT: Record<string, "DECIDES" | "SUPPORTS" | "CONTEXT"> = {
  VTP_WEBHOOK: "DECIDES",
  VTP_POLL: "DECIDES",
  VTP_IMPORT: "DECIDES",
  VTP_UI_MANUAL_VERIFICATION: "DECIDES",
  PANCAKE: "CONTEXT",
  ERP: "CONTEXT",
  MANUAL: "SUPPORTS",
};

export const WEIGHT_LABEL: Record<"DECIDES" | "SUPPORTS" | "CONTEXT", string> = {
  DECIDES: "quyết định kết quả đơn",
  SUPPORTS: "bằng chứng bổ sung",
  CONTEXT: "chỉ là bối cảnh",
};

export function sourceWeight(source: string): "DECIDES" | "SUPPORTS" | "CONTEXT" {
  if (SOURCE_WEIGHT[source]) return SOURCE_WEIGHT[source];
  if (source.startsWith("Bảng kê")) return "DECIDES";
  return "CONTEXT";
}

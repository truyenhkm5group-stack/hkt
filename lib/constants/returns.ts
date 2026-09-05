/** Quy tắc nhận diện đơn hoàn theo dữ liệu vận đơn (do shop quy định). */
export const RETURN_RULE = {
  /**
   * Vận đơn "Giao thành công" nhưng COD = 0 và cước < ngưỡng này thực chất là đơn hoàn
   * (khách không nhận / khách chỉ trả tiền ship). Đơn giao thành công thật có cước ≥ ngưỡng.
   */
  maxFeeForFakeDelivery: 10_000,
  /**
   * Vận đơn Viettel Post "Giao thành công" nhưng COD thu < ngưỡng này (khách không nhận hàng, chỉ trả tiền ship / phí xem hàng
   * 20–30K) → tính là đơn HOÀN trên mọi báo cáo; trừ đơn khách đã chuyển khoản trước (prepaid ≥ ngưỡng).
   */
  maxCodForFakeDelivery: 50_000,
};

export type OrderOutcome = "NOT_SHIPPED" | "IN_TRANSIT" | "DELIVERED" | "RETURNED" | "RETURNED_BY_RULE" | "CANCELLED";

export const OUTCOME_LABEL: Record<OrderOutcome, string> = {
  NOT_SHIPPED: "Chưa gửi",
  IN_TRANSIT: "Đang giao",
  DELIVERED: "Giao thành công thật",
  RETURNED: "Hoàn (theo trạng thái)",
  RETURNED_BY_RULE: "Hoàn (giao nhưng COD < 50K)",
  CANCELLED: "Huỷ",
};

export const OUTCOME_TONE: Record<OrderOutcome, string> = {
  NOT_SHIPPED: "bg-muted text-muted-foreground",
  IN_TRANSIT: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  DELIVERED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  RETURNED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  RETURNED_BY_RULE: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

export const RETURNED_OUTCOMES: OrderOutcome[] = ["RETURNED", "RETURNED_BY_RULE"];

/** Màu chữ theo mức tỷ lệ hoàn (dùng chung server/client) */
export function rateTone(rate: number | null) {
  if (rate === null) return "text-muted-foreground";
  if (rate >= 30) return "text-rose-600 dark:text-rose-400";
  if (rate >= 15) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

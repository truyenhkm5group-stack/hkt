/** Quy tắc nhận diện đơn hoàn theo dữ liệu vận đơn (do shop quy định). */
export const RETURN_RULE = {
  /**
   * Vận đơn "Giao thành công" nhưng COD = 0 và cước < ngưỡng này thực chất là đơn hoàn
   * (khách không nhận / khách chỉ trả tiền ship). Đơn giao thành công thật có cước ≥ ngưỡng.
   */
  maxFeeForFakeDelivery: 10_000,
  /**
   * ĐƠN GIAO THÀNH CÔNG = đơn có doanh thu COD THỰC (tiền thu hộ thực thu / đã về theo bảng kê) > ngưỡng này; chưa có số thực thu
   * thì lấy COD trên vận đơn / đơn khi vận đơn báo giao thành công. COD ≤ ngưỡng (khách không nhận, chỉ trả tiền ship / phí xem
   * hàng 20–50K) → KHÔNG thành công (tính như hoàn) trên mọi báo cáo; trừ đơn khách đã chuyển khoản trước (prepaid > ngưỡng).
   * Tỷ lệ giao thành công = giao thành công / (giao thành công + không thành công) trên đơn đã kết thúc.
   */
  maxCodForFakeDelivery: 100_000,
};

export type OrderOutcome = "NOT_SHIPPED" | "IN_TRANSIT" | "DELIVERED" | "RETURNED" | "RETURNED_BY_RULE" | "CANCELLED";

export const OUTCOME_LABEL: Record<OrderOutcome, string> = {
  NOT_SHIPPED: "Chưa gửi",
  IN_TRANSIT: "Đang giao",
  DELIVERED: "Giao thành công (COD thực > 100K)",
  RETURNED: "Không thành công · hoàn (theo trạng thái)",
  RETURNED_BY_RULE: "Không thành công (giao nhưng COD ≤ 100K)",
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

/** Ngưỡng tỷ lệ giao thành công (%): ≥ tốt = xanh, ≥ khá = vàng, dưới = đỏ */
export const SUCCESS_RATE_GOOD = 70;
export const SUCCESS_RATE_OK = 55;

/** Màu chữ theo mức tỷ lệ GIAO THÀNH CÔNG (dùng chung server/client) */
export function successTone(rate: number | null) {
  if (rate === null) return "text-muted-foreground";
  if (rate >= SUCCESS_RATE_GOOD) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= SUCCESS_RATE_OK) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

/** Màu chữ theo mức tỷ lệ hoàn (dùng chung server/client) */
export function rateTone(rate: number | null) {
  if (rate === null) return "text-muted-foreground";
  if (rate >= 30) return "text-rose-600 dark:text-rose-400";
  if (rate >= 15) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

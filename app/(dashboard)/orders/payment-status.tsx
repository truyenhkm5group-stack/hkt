import { cn } from "@/lib/utils";
import { formatVND } from "@/lib/format";
import { ORDER_PAYMENT_STATUS_LABEL, type ManualPaymentState, type OrderPaymentStatus } from "@/lib/constants/order-payments";

const TONE: Record<OrderPaymentStatus, string> = {
  UNPAID: "text-muted-foreground",
  PARTIALLY_PAID: "text-amber-700 dark:text-amber-300",
  PAID: "text-emerald-700 dark:text-emerald-300",
  REFUNDED: "text-slate-600 dark:text-slate-300",
};

/**
 * Trạng thái thanh toán của ĐƠN TẠO TAY theo chứng từ (`order_payments`) — một dòng chữ nhỏ dùng chung cho danh sách đơn,
 * trang khách và trang đơn. Thu thiếu ⇒ in «còn …»; thu thừa ⇒ in «thu thừa …» để người đọc xử lý, không giấu.
 * Chỉ nhận trạng thái của đơn tay: đơn khác không có trạng thái này (nơi gọi in chữ của chính nó, không in «Chưa thu»).
 */
export function ManualPaymentStatusText({ state, className }: { state: ManualPaymentState | null | undefined; className?: string }) {
  // Đơn tay mà không đọc được trạng thái (không nên xảy ra) ⇒ CHƯA BIẾT, không đoán thành «chưa thu».
  if (!state) return <span className={cn("text-[10.5px] text-muted-foreground", className)}>—</span>;
  const extra = state.status === "PARTIALLY_PAID" ? ` · còn ${formatVND(state.outstanding)}` : state.status === "PAID" && state.overpaid > 0 ? ` · thu thừa ${formatVND(state.overpaid)}` : "";
  return (
    <span className={cn("text-[10.5px] font-medium", TONE[state.status], className)}>
      {ORDER_PAYMENT_STATUS_LABEL[state.status]}
      {extra}
    </span>
  );
}

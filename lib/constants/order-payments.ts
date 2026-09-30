/**
 * ═══════════ CHỨNG TỪ THANH TOÁN CỦA ĐƠN TẠO TAY — THUẦN, CLIENT-SAFE (ORDER_OUTCOME.md mục 11) ═══════════
 *
 * Chiều TIỀN của đơn không qua ĐVVC. Phiếu giao có ký nhận (G-ORDER) chỉ nói hàng đã tới tay khách; tiền đi theo CHỨNG TỪ
 * THANH TOÁN (`order_payments`): phiếu THU (`RECEIPT`) và phiếu HOÀN TIỀN (`REFUND`), mỗi phiếu một số tiền nguyên dương,
 * một phương thức, một mốc tiền đổi tay (`paid_at`), một người ghi (khoá `users.id`). Ghi nhầm ⇒ HUỶ phiếu (bắt buộc lý
 * do), không xoá cứng; phiếu đã huỷ không vào phép tính nào.
 *
 * TRẠNG THÁI THANH TOÁN CỦA ĐƠN — tính lúc đọc, KHÔNG lưu cột. Một hàm thuần (`manualPaymentStatus`, tệp này) và một biểu
 * thức SQL (`MANUAL_PAYMENT_STATUS_SQL`, `lib/queries/manual-order-sql.ts`) cùng một bảng chân lý; bài kiểm chạy cả hai
 * trên cùng dữ liệu. Với R = Σ phiếu THU còn hiệu lực, F = Σ phiếu HOÀN còn hiệu lực, net = R − F, D = số khách phải trả:
 *
 *  · `UNPAID`          — chưa có chứng từ nào còn hiệu lực (R = 0 và F = 0). "Chưa có chứng từ", không phải "khách nợ 0đ".
 *  · `REFUNDED`        — có phiếu hoàn và net ≤ 0 (đã trả lại toàn bộ số đã thu).
 *  · `PAID`            — net ≥ max(D, 1): đã thu đủ. net > D ⇒ vẫn `PAID`, phần dư in riêng là «thu thừa» (`overpaid`) để
 *                        người đọc thấy và xử lý (hoàn lại khách / ghi nhầm) — không giấu, không chặn ghi chứng từ thật.
 *  · `PARTIALLY_PAID`  — 0 < net < D.
 *
 * Đơn KHÔNG tạo tay (Pancake / VNX) KHÔNG có trạng thái này: tiền của nó đi theo bảng kê ĐVVC. Nơi hiển thị in `N/A`
 * (không áp dụng), không bao giờ in `UNPAID` (AGENTS 42).
 *
 * KHÔNG suy tiền từ giao hàng và ngược lại: phiếu giao không làm đơn thành `PAID`; `PAID` không làm đơn thành "đã giao".
 */

export const PAYMENT_KINDS = ["RECEIPT", "REFUND"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "COD", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_RECORD_STATUSES = ["CONFIRMED", "VOIDED"] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];

export const ORDER_PAYMENT_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID", "REFUNDED"] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = { RECEIPT: "Phiếu thu", REFUND: "Hoàn tiền cho khách" };

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  COD: "Thu hộ khi giao (shipper của shop)",
  OTHER: "Khác",
};

export const ORDER_PAYMENT_STATUS_LABEL: Record<OrderPaymentStatus, string> = {
  UNPAID: "Chưa có chứng từ thu",
  PARTIALLY_PAID: "Đã thu một phần",
  PAID: "Đã thu đủ",
  REFUNDED: "Đã hoàn tiền",
};

/** Nhãn khi đơn không phải đơn tạo tay — tiền theo chứng từ ĐVVC, trạng thái này không áp dụng. */
export const ORDER_PAYMENT_NOT_APPLICABLE = "N/A";

/** Trần của một chứng từ — chặn đầu vào vô lý trước khi chạm CSDL. `futureSkewMs`: lệch đồng hồ máy người ghi. */
export const PAYMENT_LIMITS = { maxAmount: 10_000_000_000, referenceMax: 120, noteMax: 1000, reasonMin: 3, reasonMax: 500, futureSkewMs: 5 * 60_000 } as const;

export function isPaymentKind(v: unknown): v is PaymentKind {
  return typeof v === "string" && (PAYMENT_KINDS as readonly string[]).includes(v);
}
export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);
}

/**
 * Số khách phải trả của một đơn tạo tay = tiền hàng sau chiết khấu + phí ship. Cùng công thức `grandTotal` của
 * `manualOrderTotals` và `amountDue` của lượt sửa đơn (phí ship đơn tay là tiền khách trả). Bản SQL:
 * `MANUAL_ORDER_AMOUNT_DUE_SQL`.
 */
export function manualOrderAmountDue(order: { totalPriceAfterDiscount: number; shippingFee: number }): number {
  return Number(order.totalPriceAfterDiscount ?? 0) + Number(order.shippingFee ?? 0);
}

export type PaymentSums = { receipts: number; refunds: number };

export type ManualPaymentState = {
  status: OrderPaymentStatus;
  /** Σ thu − Σ hoàn (chứng từ còn hiệu lực). */
  net: number;
  amountDue: number;
  /** Còn phải thu = max(0, D − net). */
  outstanding: number;
  /** Thu thừa = max(0, net − D) — chỉ > 0 ở `PAID`. */
  overpaid: number;
};

/**
 * Trạng thái thanh toán của MỘT đơn tạo tay từ tổng chứng từ CÒN HIỆU LỰC — hàm THUẦN. Người gọi chịu trách nhiệm chỉ
 * cộng phiếu `CONFIRMED` (bản SQL lọc `status = 'CONFIRMED'`); phiếu hoàn LUÔN trừ.
 */
export function manualPaymentStatus(sums: PaymentSums, amountDue: number): ManualPaymentState {
  const receipts = Math.max(0, Math.trunc(sums.receipts));
  const refunds = Math.max(0, Math.trunc(sums.refunds));
  const due = Math.max(0, Math.trunc(amountDue));
  const net = receipts - refunds;
  const status: OrderPaymentStatus =
    receipts === 0 && refunds === 0 ? "UNPAID" : refunds > 0 && net <= 0 ? "REFUNDED" : net >= Math.max(due, 1) ? "PAID" : "PARTIALLY_PAID";
  return { status, net, amountDue: due, outstanding: Math.max(0, due - net), overpaid: status === "PAID" ? Math.max(0, net - due) : 0 };
}

/** Cộng chứng từ (đã lọc hay chưa) thành R / F — CHỈ phiếu `CONFIRMED`; phiếu đã huỷ không đổi một đồng. */
export function sumConfirmedPayments(rows: readonly { kind: string; amount: number; status: string }[]): PaymentSums {
  let receipts = 0;
  let refunds = 0;
  for (const r of rows) {
    if (r.status !== "CONFIRMED") continue;
    if (r.kind === "RECEIPT") receipts += Number(r.amount);
    else if (r.kind === "REFUND") refunds += Number(r.amount);
  }
  return { receipts, refunds };
}

/**
 * Đơn ở trạng thái nào thì ghi được chứng từ loại nào. Phiếu THU: mọi đơn tay CHƯA HUỶ — kể cả trước khi giao (đặt cọc,
 * trả trước: chiều tiền độc lập chiều logistics). Đơn đã HUỶ: chỉ phiếu HOÀN (trả lại tiền đã thu), không nhận tiền mới.
 */
export function canRecordPayment(kind: PaymentKind, orderStage: string): boolean {
  if (orderStage === "DELETED") return false;
  return kind === "REFUND" || orderStage !== "CANCELLED";
}

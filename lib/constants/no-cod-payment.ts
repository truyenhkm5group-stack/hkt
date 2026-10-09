/**
 * ĐƠN ĐỒNG BỘ KHÔNG CÒN COD PHẢI THU: TIỀN ĐÃ VỀ CHƯA? — hàm thuần, dùng được ở client component.
 *
 * Chỉ trả lời "đã trả trước" khi có thứ mà `VERIFIED_MONEY_SOURCES` (`lib/constants/truth.ts`) đã khai là
 * bằng chứng — `orders.prepaid` / `orders.transfer_money`. `money_to_collect = 0` tự nó KHÔNG phải chứng
 * từ (ORDER_OUTCOME.md mục 8): thiếu bằng chứng thì là CHƯA XÁC MINH, không phải "đã thanh toán"
 * (AGENTS §0.1 · §0.3). `null` ⇒ đơn còn COD, câu hỏi không đặt ra. Đơn tạo tay đi đường chứng từ riêng
 * (`order_payments`) — người gọi rẽ nhánh đó TRƯỚC khi hỏi hàm này.
 */
export type NoCodPaymentState = { kind: "PREPAID"; amount: number } | { kind: "UNVERIFIED" };

export function noCodPaymentState(d: { moneyToCollect: number; prepaid: number; transferMoney: number }): NoCodPaymentState | null {
  if (d.moneyToCollect > 0) return null;
  const prepaid = d.prepaid + d.transferMoney;
  return prepaid > 0 ? { kind: "PREPAID", amount: prepaid } : { kind: "UNVERIFIED" };
}

/** Chú thích khi rê chuột lên ô «Chưa xác minh» — một câu, mọi màn hình in giống nhau. */
export const NO_COD_UNVERIFIED_HINT = "Đơn không còn COD phải thu nhưng ERP chưa thấy chứng từ tiền nào (chuyển khoản trước / bảng kê)";

/**
 * HAI TAB CỦA TRANG CHI PHÍ — SỔ GHI và BÁO CÁO.
 *
 * Khai ở tệp KHÔNG có `"use client"`: hằng số khai trong tệp client, khi Server Component import
 * về gọi `.includes()`, bị Next thay bằng một *client reference proxy* và CẢ TRANG hỏng — sự cố
 * thật, xem `lib/constants/bank.ts::BANK_TABS`. `tests/client-boundary-exports.test.ts` khoá nó.
 *
 * Hai tab cùng đọc bảng `expenses` và CỐ Ý ra hai con số khác nhau:
 *  · `danh-sach` — SỔ GHI. Hiện đủ mọi khoản đã gõ, kể cả khoản bị loại khỏi lợi nhuận. Lọc bớt ở
 *    đây thì người vừa nhập xong thấy khoản của mình biến mất.
 *  · `bao-cao`   — BÁO CÁO. Chỉ con số thật sự vào lợi nhuận: đã phân bổ theo kỳ, đã áp thẩm quyền
 *    nguồn (quảng cáo ở tài khoản QC, tiền hàng ở phiếu kho, cước ở vận đơn).
 */

export const EXPENSE_TABS = ["danh-sach", "bao-cao"] as const;
export type ExpenseTab = (typeof EXPENSE_TABS)[number];

export const EXPENSE_TAB_LABEL: Record<ExpenseTab, string> = {
  "danh-sach": "Danh sách khoản chi",
  "bao-cao": "Báo cáo chi phí",
};

export const EXPENSE_TAB_HINT: Record<ExpenseTab, string> = {
  "danh-sach": "Sổ ghi: đủ mọi khoản đã nhập, đúng số đã gõ vào.",
  "bao-cao": "Khoản nào đang tăng, tăng bao nhiêu, trả cho ai — con số đã phân bổ theo kỳ và đã áp thẩm quyền nguồn.",
};

export function isExpenseTab(value: string): value is ExpenseTab {
  return (EXPENSE_TABS as readonly string[]).includes(value);
}

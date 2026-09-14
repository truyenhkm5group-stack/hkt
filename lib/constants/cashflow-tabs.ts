/**
 * ═══════════ BA TAB CỦA TRANG DÒNG TIỀN ═══════════
 *
 * Khai ở tệp KHÔNG có `"use client"` — cùng lý do với `lib/constants/bank.ts::BANK_TABS`, và lý do
 * đó là một sự cố thật: hằng số khai trong tệp client, khi Server Component import về gọi
 * `.includes()`, bị Next thay bằng một *client reference proxy* và CẢ TRANG hỏng. `tsc`, `eslint`,
 * `next build` đều xanh; chỉ người mở trang mới thấy. `tests/client-boundary-exports.test.ts` khoá
 * điều này cho cả kho mã.
 *
 * ─── VÌ SAO PHẢI LÀ BA TAB CHỨ KHÔNG PHẢI MỘT TRANG ───
 *
 * Ba tab là ba CƠ SỞ ĐO khác nhau, và trộn chúng trên một màn hình là cách chắc chắn nhất để chủ
 * shop đọc một con số ước lượng như một con số chứng từ:
 *
 *   · `thuc-te`  — ĐÃ XẢY RA. Từ sao kê, có đầu kỳ / cuối kỳ do ngân hàng ghi.
 *   · `du-phong` — CHƯA XẢY RA. Suy từ nhịp chi thực tế. Không có chứng từ nào.
 *   · `doi-chieu`— GIẢI THÍCH. Vì sao con số lợi nhuận khác con số tiền.
 *
 * Chúng không bao giờ được cộng với nhau.
 */

export const CASHFLOW_TABS = ["thuc-te", "du-phong", "doi-chieu"] as const;
export type CashflowTab = (typeof CASHFLOW_TABS)[number];

export const CASHFLOW_TAB_LABEL: Record<CashflowTab, string> = {
  "thuc-te": "Tiền thật đã vào ra",
  "du-phong": "Dự phóng kỳ tới",
  "doi-chieu": "Lợi nhuận ≠ tiền",
};

export const CASHFLOW_TAB_HINT: Record<CashflowTab, string> = {
  "thuc-te": "Đã xảy ra, đọc từ sao kê ngân hàng. Có số dư đầu kỳ và cuối kỳ do chính ngân hàng ghi.",
  "du-phong": "Chưa xảy ra. Suy từ nhịp chi thực tế và tiền COD đang chờ về — không có chứng từ nào.",
  "doi-chieu": "Vì sao lãi trên giấy mà tài khoản không dày lên tương ứng.",
};

export function isCashflowTab(value: string): value is CashflowTab {
  return (CASHFLOW_TABS as readonly string[]).includes(value);
}

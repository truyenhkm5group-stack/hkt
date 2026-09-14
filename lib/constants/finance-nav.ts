import { Banknote, BarChart3, HandCoins, Landmark, LayoutDashboard, PackageCheck, ReceiptText } from "lucide-react";
import type { Permission } from "@/lib/auth/permissions";

/**
 * ═══════════ BẢY MÀN HÌNH CỦA NHÓM TIỀN ═══════════
 *
 * Khai ở tệp KHÔNG có `"use client"`, và đó không phải chuyện gu viết mã.
 *
 * `BANK_TABS` từng khai trong `bank-tabs.tsx` — một tệp client. Server Component `bank/page.tsx`
 * import về gọi `.includes()`, và qua ranh giới `"use client"` Next thay module bằng một *client
 * reference proxy*: phía máy chủ nó là một đối tượng tham chiếu chứ không phải mảng, nên `.includes`
 * không tồn tại và CẢ TRANG hỏng. `tsc`, `eslint`, `next build` đều xanh — chỉ người mở trang mới
 * thấy, và người đó là chủ shop. `tests/client-boundary-exports.test.ts` nay khoá điều này.
 *
 * Thứ tự là thứ tự ĐỌC của một người đang quyết định, không phải thứ tự bảng chữ cái:
 * còn bao nhiêu tiền → tiền nằm đâu → ai còn nợ mình → mình đã tiêu gì → lãi bao nhiêu →
 * tiền sẽ đi đâu → phải trả người làm bao nhiêu.
 */

export type FinanceNavItem = {
  key: "overview" | "bank" | "cod" | "expenses" | "profit" | "cashflow" | "payroll";
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Câu trả lời mà màn hình này cho — hiện khi rê chuột. */
  hint: string;
  /** Ý nghĩa của con số trên huy hiệu, nếu màn hình có việc tồn đọng. */
  badgeHint?: string;
  permission: Permission;
  anyOf?: Permission[];
};

export const FINANCE_NAV: FinanceNavItem[] = [
  {
    key: "overview",
    href: "/finance",
    label: "Tổng quan",
    icon: LayoutDashboard,
    hint: "Còn bao nhiêu tiền, nằm ở tài khoản nào, kỳ này vào ra bao nhiêu, và việc tài chính nào cần xử lý ngay.",
    badgeHint: "Việc tài chính cần xử lý",
    permission: "bank:view",
    anyOf: ["bank:view", "reports:cash", "cod:view"],
  },
  {
    key: "bank",
    href: "/bank",
    label: "Sổ ngân hàng",
    icon: Landmark,
    hint: "Từng đồng đã vào / ra tài khoản, theo ngày ngân hàng ghi.",
    badgeHint: "Giao dịch chưa phân loại",
    permission: "bank:view",
  },
  {
    key: "cod",
    href: "/cod",
    label: "Đối soát COD",
    icon: PackageCheck,
    hint: "Viettel Post còn giữ bao nhiêu tiền của shop, và khoản nào đã quá hạn.",
    badgeHint: "Đơn quá hạn chưa thấy tiền",
    permission: "cod:view",
  },
  {
    key: "expenses",
    href: "/expenses",
    label: "Chi phí",
    icon: ReceiptText,
    hint: "Đã chi những gì, khoản nào đang tăng bất thường, trả cho ai nhiều nhất.",
    permission: "expenses:view",
  },
  {
    key: "profit",
    href: "/reports",
    label: "Lợi nhuận",
    icon: BarChart3,
    hint: "Lãi bao nhiêu theo đơn đã giao — đo theo kỳ hưởng lợi ích, không theo ngày tiền về.",
    permission: "reports:delivered",
    anyOf: ["reports:delivered", "reports:cash", "reports:nominal"],
  },
  {
    key: "cashflow",
    href: "/reports/cashflow",
    label: "Dòng tiền",
    icon: Banknote,
    hint: "Tiền thật đã vào ra thế nào, vì sao lợi nhuận khác tiền, và kỳ tới có đủ tiền không.",
    permission: "reports:cash",
  },
  {
    key: "payroll",
    href: "/payroll",
    label: "Lương & hoa hồng",
    icon: HandCoins,
    hint: "Phải trả người làm bao nhiêu, theo lương cứng và theo hoa hồng.",
    permission: "payroll:view-own",
    anyOf: ["payroll:view-own", "payroll:view"],
  },
];

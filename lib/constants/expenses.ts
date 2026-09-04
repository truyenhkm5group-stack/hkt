import type { ExpenseCategory } from "@/db/schema";

export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  ADS: "Quảng cáo",
  SHIPPING: "Phí giao hàng",
  RETURN_FEE: "Phí hoàn",
  SALARY: "Lương",
  RENT: "Mặt bằng",
  SOFTWARE: "Phần mềm",
  PACKAGING: "Đóng gói",
  PURCHASE: "Nhập hàng",
  OTHER: "Khác",
};

export const EXPENSE_CATEGORY_ORDER: ExpenseCategory[] = ["ADS", "SHIPPING", "RETURN_FEE", "SALARY", "RENT", "SOFTWARE", "PACKAGING", "PURCHASE", "OTHER"];

/** Màu nhãn nhóm chi phí */
export const EXPENSE_CATEGORY_TONE: Record<ExpenseCategory, string> = {
  ADS: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  SHIPPING: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  RETURN_FEE: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  SALARY: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  RENT: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SOFTWARE: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  PACKAGING: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  PURCHASE: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  OTHER: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

/** Nền tảng quảng cáo (giá trị lưu trong ad_spends.platform) */
export const AD_PLATFORMS = ["Facebook", "TikTok", "Google", "Shopee", "Lazada", "Khác"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const AD_PLATFORM_COLOR: Record<string, string> = {
  Facebook: "var(--chart-2)",
  TikTok: "var(--chart-1)",
  Google: "var(--chart-4)",
  Shopee: "var(--chart-3)",
  Lazada: "var(--chart-5)",
  Khác: "var(--muted-foreground)",
};

export const AD_PLATFORM_TONE: Record<string, string> = {
  Facebook: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  TikTok: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  Google: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  Shopee: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  Lazada: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
};

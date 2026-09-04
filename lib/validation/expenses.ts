import { z } from "zod";
import { EXPENSE_CATEGORY_ORDER } from "@/lib/constants/expenses";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Chọn ngày");
const vnd = (label: string) => z.number({ error: `Nhập ${label}` }).int(`${label} phải là số nguyên`).min(0, `${label} không được âm`).max(2_000_000_000, `${label} quá lớn`);

export const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORY_ORDER, { error: "Chọn nhóm chi phí" }),
  description: z.string().trim().min(1, "Nhập mô tả").max(500, "Mô tả tối đa 500 ký tự"),
  amount: z.number({ error: "Nhập số tiền" }).int("Số tiền phải là số nguyên").min(1, "Số tiền phải lớn hơn 0").max(2_000_000_000, "Số tiền quá lớn"),
  occurredAt: dateKey,
  reference: z.string().trim().max(200, "Tham chiếu tối đa 200 ký tự"),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const adSpendSchema = z.object({
  platform: z.string().trim().min(1, "Chọn nền tảng").max(50),
  campaign: z.string().trim().max(200, "Tên chiến dịch tối đa 200 ký tự"),
  spend: vnd("chi tiêu"),
  leads: z.number({ error: "Nhập số lead" }).int().min(0, "Không được âm").max(1_000_000),
  orders: z.number({ error: "Nhập số đơn" }).int().min(0, "Không được âm").max(1_000_000),
  revenue: vnd("doanh thu"),
  spendDate: dateKey,
  note: z.string().trim().max(500, "Ghi chú tối đa 500 ký tự"),
});
export type AdSpendInput = z.infer<typeof adSpendSchema>;

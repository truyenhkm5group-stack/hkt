import { z } from "zod";
import { DEPARTMENTS } from "@/lib/constants/payroll";

const pct = (label: string) => z.number({ error: `Nhập ${label}` }).min(0, `${label} không được âm`).max(100, `${label} tối đa 100%`);

export const employeeSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Nhập họ tên").max(120),
  shortName: z.string().trim().max(40),
  department: z.enum(DEPARTMENTS, { error: "Chọn bộ phận" }),
  aliases: z.string().trim().max(500),
  accountIds: z.string().trim().max(500),
  userEmail: z.string().trim().max(160).refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Email không hợp lệ"),
  fixed: z.number({ error: "Nhập lương cứng" }).int().min(0).max(1_000_000_000),
  percentTotal: pct("% lợi nhuận tổng"),
  percentPersonal: pct("% lợi nhuận cá nhân"),
  percentRevenue: pct("% doanh thu cá nhân"),
  active: z.boolean(),
  note: z.string().trim().max(500),
  startedOn: z.string().trim().refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), "Ngày vào làm không hợp lệ"),
  leftOn: z.string().trim().refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), "Ngày nghỉ không hợp lệ"),
  bankBin: z.string().trim().refine((v) => !v || /^\d{6}$/.test(v), "Mã BIN ngân hàng gồm đúng 6 chữ số"),
  bankAccount: z.string().trim().refine((v) => !v || /^[0-9A-Za-z]{4,19}$/.test(v), "Số tài khoản chỉ gồm chữ và số, dài 4–19 ký tự"),
  bankAccountName: z.string().trim().max(80),
})
  // Đã nghỉ thì PHẢI có ngày: "đã nghỉ" không ngày là đúng thứ làm một người biến mất khỏi tháng họ còn làm dở.
  .refine((v) => v.active || Boolean(v.leftOn), { path: ["leftOn"], message: "Đã nghỉ thì nhập ngày làm cuối — để tháng cuối vẫn được trả đủ những ngày còn làm" })
  .refine((v) => !v.startedOn || !v.leftOn || v.leftOn >= v.startedOn, { path: ["leftOn"], message: "Ngày nghỉ phải sau ngày vào làm" })
  // Ba ô ngân hàng đi cùng nhau: thiếu một ô thì lệnh chuyển không dựng được, và điền nửa vời dễ chuyển nhầm.
  .refine((v) => [v.bankBin, v.bankAccount, v.bankAccountName].every(Boolean) || [v.bankBin, v.bankAccount, v.bankAccountName].every((x) => !x), {
    path: ["bankAccount"],
    message: "Khai đủ cả ngân hàng, số tài khoản và tên chủ tài khoản (hoặc để trống cả ba)",
  });
export type EmployeeInput = z.infer<typeof employeeSchema>;

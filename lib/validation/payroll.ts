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
  fixed: z.number({ error: "Nhập lương cứng" }).int().min(0).max(1_000_000_000),
  percentTotal: pct("% lợi nhuận tổng"),
  percentPersonal: pct("% lợi nhuận cá nhân"),
  percentRevenue: pct("% doanh thu cá nhân"),
  active: z.boolean(),
  note: z.string().trim().max(500),
});
export type EmployeeInput = z.infer<typeof employeeSchema>;

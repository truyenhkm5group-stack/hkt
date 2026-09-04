/** Nhân sự và cơ chế lương (lưu trong settings: payroll.employees) */
export type Employee = {
  id: string;
  name: string;
  /** Tên ngắn hiển thị, vd "Quân TA" */
  shortName: string;
  department: string;
  /** Từ khoá trong tên chiến dịch để nhận diện marketer, vd ["QA4", "QUAN TA"] */
  aliases: string[];
  /** Tài khoản quảng cáo (account_id) mặc định thuộc marketer này */
  accountIds: string[];
  /** Lương cứng mỗi tháng (đ) */
  fixed: number;
  /** % lợi nhuận tổng của shop trong kỳ */
  percentTotal: number;
  /** % lợi nhuận cá nhân (lợi nhuận do chính người đó tạo ra qua các chiến dịch của mình) */
  percentPersonal: number;
  /** % doanh thu GTC ước tính cá nhân (tuỳ chọn, cho sale/CSKH) */
  percentRevenue: number;
  active: boolean;
  note: string;
};

export const PAYROLL_EMPLOYEES_KEY = "payroll.employees";

export const DEPARTMENTS = ["Marketing", "Sale / CSKH", "Kho / Đóng gói", "Kế toán", "Quản lý", "Khác"] as const;

/** Lợi nhuận dùng để tính lương: danh nghĩa (đơn lên trong kỳ × tỷ lệ hoàn ước tính) hay dòng tiền thực */
export type PayrollBasis = "nominal" | "cash";
export const PAYROLL_BASIS_LABEL: Record<PayrollBasis, string> = { nominal: "Lợi nhuận danh nghĩa (theo đơn lên trong kỳ)", cash: "Lợi nhuận dòng tiền thực" };

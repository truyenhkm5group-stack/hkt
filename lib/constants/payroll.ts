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

/** Lợi nhuận dùng để tính lương */
export type PayrollBasis = "profit1" | "profit2" | "cash" | "nominal";
export const PAYROLL_BASIS_LABEL: Record<PayrollBasis, string> = {
  profit1: "LN1 · doanh thu GTC − QC − giá vốn hàng giao thành công − vận chuyển − chi phí cố định/vận hành/khác",
  profit2: "LN2 · doanh thu GTC − QC − giá vốn TỔNG hàng nhập trong kỳ − vận chuyển − chi phí cố định/vận hành/khác",
  cash: "Dòng tiền thực (tiền vào − tiền ra trong kỳ), chia theo tỷ trọng LN1",
  nominal: "Danh nghĩa (đơn lên trong kỳ × tỷ lệ hoàn ước tính), tham khảo",
};
export const PAYROLL_BASIS_SHORT: Record<PayrollBasis, string> = { profit1: "LN1 · giá vốn hàng giao TC", profit2: "LN2 · giá vốn hàng nhập", cash: "Dòng tiền thực", nominal: "Danh nghĩa" };
export const PAYROLL_BASES: PayrollBasis[] = ["profit1", "profit2", "cash", "nominal"];
export function parsePayrollBasis(v: string | null | undefined): PayrollBasis {
  return v === "profit2" || v === "cash" || v === "nominal" ? v : "profit1";
}

/** Cấu hình chia lợi nhuận theo mã hàng (settings "payroll.config") */
export type PayrollConfig = {
  /** Marketer phụ trách chính từng mã (productId → employeeId): chịu tồn kho & giá vốn mã đó, hưởng ownerSharePct từ đơn người khác đẩy chéo */
  productOwners: Record<string, string>;
  /** % lợi nhuận chủ mã nhận từ đơn của marketer khác chạy trên mã của mình */
  ownerSharePct: number;
};
export const PAYROLL_CONFIG_KEY = "payroll.config";
export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = { productOwners: {}, ownerSharePct: 5 };

/** Giả định dùng cho báo cáo lợi nhuận danh nghĩa theo mã hàng (lưu trong settings: profit.assumptions) */
export type ProfitAssumptions = {
  /** Cước gửi ĐVVC cho MỌI đơn gửi đi, kể cả đơn sau đó hoàn (đ) — 0 = tự tính bình quân 90 ngày từ dữ liệu */
  shipFeeDelivered: number;
  /** Tổng cước một đơn hoàn = cước gửi + phí hoàn về (đ) — 0 = cước gửi + phí hoàn bình quân (nếu có dữ liệu), không thì gấp đôi cước gửi */
  shipFeeReturned: number;
  /** Chi phí đóng hàng (túi, thùng, in bill…) cho mỗi đơn gửi đi (đ) */
  packingFeePerOrder: number;
  /** Chi phí nhân viên vận đơn cho mỗi đơn xử lý (đ) */
  opsStaffPerOrder: number;
  /** Thưởng nhân viên vận đơn cho mỗi đơn giao thất bại được cứu thành giao thành công (đ) */
  opsStaffPerRescued: number;
  /** Chi phí cố định mỗi tháng: văn phòng, điện nước, internet… (đ), phân bổ theo số ngày trong kỳ và tỷ trọng doanh số */
  fixedCostMonthly: number;
  /** Số ngày lịch sử dùng để ước tính tỷ lệ hoàn của từng mã */
  returnRateWindowDays: number;
  /** Tỷ lệ hoàn mặc định (%) khi mã chưa có đủ lịch sử */
  defaultReturnRate: number;
  /** Số đơn đã có kết quả tối thiểu để dùng tỷ lệ lịch sử của mã */
  minFinishedOrders: number;
  /** Ghi đè tỷ lệ hoàn (%) theo productId */
  overrides: Record<string, number>;
  /** Dự phòng rủi ro tồn kho (% trên TỔNG giá trị hàng nhập trong kỳ theo phiếu nhập): hàng lỗi, tồn lâu phải xả, thất thoát */
  inventoryRiskPercent: number;
  /** Dự trù thuế (% doanh thu GTC ước tính) */
  taxPercent: number;
  /** Chi phí khác theo % chi phí quảng cáo (vd phí thanh toán ngoại tệ khi Meta thu thẻ 1,1%) */
  otherCostPercentOfAds: number;
  /** Xác suất đơn giao thất bại (chờ xử lý / chờ phát lại) cuối cùng thành hoàn (%); 0 = tự học từ lịch sử */
  failedToReturnPercent: number;
};

export const PROFIT_ASSUMPTIONS_KEY = "profit.assumptions";

export const DEFAULT_PROFIT_ASSUMPTIONS: ProfitAssumptions = {
  shipFeeDelivered: 17_000,
  shipFeeReturned: 0,
  packingFeePerOrder: 5_000,
  opsStaffPerOrder: 2_000,
  opsStaffPerRescued: 10_000,
  fixedCostMonthly: 5_000_000,
  returnRateWindowDays: 90,
  defaultReturnRate: 30,
  minFinishedOrders: 10,
  overrides: {},
  inventoryRiskPercent: 10,
  taxPercent: 1.5,
  otherCostPercentOfAds: 1.1,
  failedToReturnPercent: 0,
};

export const FALLBACK_SHIP_FEE_DELIVERED = 17_000;
export const FALLBACK_SHIP_FEE_RETURNED = 34_000;

/** Số ngày bình quân một tháng để quy đổi chi phí cố định theo kỳ */
export const DAYS_PER_MONTH = 365 / 12;

/** Số tháng của kỳ báo cáo (theo số ngày lịch), tối thiểu 1 ngày */
export function periodMonths(from: Date | null | undefined, to: Date | null | undefined): number {
  if (!from || !to) return 0;
  const days = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);
  return days / DAYS_PER_MONTH;
}

export type OpsCostInput = {
  /** Đơn đã xác nhận gửi đi trong kỳ */
  orders: number;
  /** Đơn giao thất bại rồi giao thành công */
  rescued: number;
};

/** Chi phí vận hành theo đơn từ giả định: đóng hàng × đơn, nhân viên vận đơn = đơn × đơn giá + đơn cứu × thưởng */
export function opsCosts(input: OpsCostInput, a: Pick<ProfitAssumptions, "packingFeePerOrder" | "opsStaffPerOrder" | "opsStaffPerRescued">) {
  const orders = Math.max(0, input.orders);
  const rescued = Math.min(Math.max(0, input.rescued), orders);
  const packingCost = Math.round(orders * Math.max(0, a.packingFeePerOrder || 0));
  const opsStaffCost = Math.round(orders * Math.max(0, a.opsStaffPerOrder || 0) + rescued * Math.max(0, a.opsStaffPerRescued || 0));
  return { packingCost, opsStaffCost };
}

/** Chi phí cố định của kỳ = chi phí tháng × số tháng trong kỳ */
export function fixedCostForPeriod(monthly: number, months: number): number {
  return Math.round(Math.max(0, monthly || 0) * Math.max(0, months));
}

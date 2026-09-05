/** Giả định dùng cho báo cáo lợi nhuận danh nghĩa theo mã hàng (lưu trong settings: profit.assumptions) */
export type ProfitAssumptions = {
  /** Cước ĐVVC bình quân cho một đơn giao thành công (đ) — 0 = tự tính từ dữ liệu */
  shipFeeDelivered: number;
  /** Tổng chi phí vận chuyển cho một đơn hoàn (cước đi + phí hoàn) (đ) — 0 = tự tính từ dữ liệu */
  shipFeeReturned: number;
  /** Số ngày lịch sử dùng để ước tính tỷ lệ hoàn của từng mã */
  returnRateWindowDays: number;
  /** Tỷ lệ hoàn mặc định (%) khi mã chưa có đủ lịch sử */
  defaultReturnRate: number;
  /** Số đơn đã có kết quả tối thiểu để dùng tỷ lệ lịch sử của mã */
  minFinishedOrders: number;
  /** Ghi đè tỷ lệ hoàn (%) theo productId */
  overrides: Record<string, number>;
  /** Dự phòng rủi ro tồn kho (% trên giá vốn hàng bán ước tính): hàng lỗi, tồn lâu phải xả, thất thoát */
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
  shipFeeDelivered: 0,
  shipFeeReturned: 0,
  returnRateWindowDays: 90,
  defaultReturnRate: 30,
  minFinishedOrders: 10,
  overrides: {},
  inventoryRiskPercent: 5,
  taxPercent: 1.5,
  otherCostPercentOfAds: 1.1,
  failedToReturnPercent: 0,
};

export const FALLBACK_SHIP_FEE_DELIVERED = 22_000;
export const FALLBACK_SHIP_FEE_RETURNED = 30_000;

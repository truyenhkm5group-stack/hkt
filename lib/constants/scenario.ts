/**
 * Giới hạn của các đòn bẩy mô phỏng. Đổi ở ĐÂY, không rải số vào truy vấn hay giao diện.
 *
 * Có giới hạn vì phép ngoại suy tuyến tính chỉ đúng quanh điểm hiện tại: kéo giá bán lên 300% rồi
 * đọc lợi nhuận như thật là tự lừa mình — ở mức đó số đơn sẽ đổi, và mô hình này KHÔNG mô hình hoá
 * cầu.
 */
export const SCENARIO_LIMIT = {
  /** Tỷ lệ giao thành công đổi bao nhiêu ĐIỂM phần trăm. */
  successRatePoints: 20,
  /** Các đòn bẩy còn lại đổi bao nhiêu phần trăm so với hiện tại. */
  percent: 50,
} as const;

export type ScenarioLeverKey = "successRatePoints" | "pricePercent" | "cogsPercent" | "shippingPercent" | "adSpendPercent" | "opexPercent";

export const SCENARIO_LEVER_LABEL: Record<ScenarioLeverKey, string> = {
  successRatePoints: "Tỷ lệ giao thành công",
  pricePercent: "Giá bán",
  cogsPercent: "Giá vốn",
  shippingPercent: "Cước & phí hoàn",
  adSpendPercent: "Chi quảng cáo",
  opexPercent: "Chi phí vận hành",
};

/** Đơn vị của từng đòn bẩy — điểm phần trăm khác với phần trăm, nhầm là sai một bậc. */
export const SCENARIO_LEVER_UNIT: Record<ScenarioLeverKey, "points" | "percent"> = {
  successRatePoints: "points",
  pricePercent: "percent",
  cogsPercent: "percent",
  shippingPercent: "percent",
  adSpendPercent: "percent",
  opexPercent: "percent",
};

/** Mỗi đòn bẩy phải nói rõ nó KÉO THEO cái gì, nếu không người đọc tưởng mọi thứ khác đứng yên. */
export const SCENARIO_LEVER_NOTE: Record<ScenarioLeverKey, string> = {
  successRatePoints: "Kéo theo doanh thu và giá vốn của đơn giao thành công, và kéo giảm phí hoàn. Số đơn gửi đi giữ nguyên.",
  pricePercent: "Chỉ đổi doanh thu. KHÔNG mô hình hoá phản ứng của khách — tăng giá thật thường làm giảm số đơn.",
  cogsPercent: "Chỉ đổi giá vốn của đơn giao thành công.",
  shippingPercent: "Đổi cả cước chiều đi lẫn phí hoàn.",
  adSpendPercent: "CHỈ đổi phần chi. Cố ý không cho doanh thu tăng theo — xem ghi chú về độ phủ quy kết.",
  opexPercent: "Chi phí vận hành phân bổ trong kỳ.",
};

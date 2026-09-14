/**
 * Hằng số chung của phễu bán hàng — đặc tả: docs/sales-funnel-contract.md.
 * Để ở constants vì giao diện (client) cũng cần nhãn và ngưỡng.
 */

export type AttributionField = "sellerName" | "careName" | "marketerName" | "creatorName" | "editorName";

/**
 * Năm trường người phụ trách, KHÔNG thay thế được cho nhau: chốt đơn, chăm sóc, chạy quảng cáo, tạo
 * đơn và đổi trạng thái là năm vai khác nhau. Chỉ trường cuối có kèm mốc thời gian.
 */
export const ATTRIBUTION_FIELDS: { field: AttributionField; label: string; note: string }[] = [
  { field: "sellerName", label: "Người chốt đơn", note: "Hiệu suất bán" },
  { field: "careName", label: "Người chăm sóc", note: "Hiệu suất CSKH" },
  { field: "marketerName", label: "Người chạy quảng cáo", note: "Báo cáo marketer" },
  { field: "creatorName", label: "Người tạo đơn", note: "Truy vết thao tác" },
  { field: "editorName", label: "Người đổi trạng thái", note: "Nguồn DUY NHẤT có mốc thời gian — ai xác nhận đơn, lúc nào" },
];

/** Dưới ngưỡng này thì mọi chỉ số chia theo trường đó phải kèm cảnh báo độ phủ. */
export const LOW_COVERAGE_PCT = 60;

/** Nhóm không gán được — hiện tường minh, KHÔNG chia đều cho nhân viên để tổng đẹp. */
export const UNASSIGNED_LABEL = "Chưa gán";

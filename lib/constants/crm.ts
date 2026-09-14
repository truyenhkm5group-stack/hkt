/**
 * Ngưỡng và nhãn của phần Giữ chân khách. Đổi ở ĐÂY, không rải số vào truy vấn hay giao diện.
 *
 * Các mốc ngày dưới đây là quy ước kinh doanh cho shop thời trang bán online (vòng đời mua lại
 * ngắn, theo mùa và theo mẫu). Chúng KHÔNG phải hằng số kỹ thuật — đổi phải do chủ shop quyết.
 */
export const CRM_RULE = {
  /** Còn được coi là đang hoạt động nếu đơn GIAO THÀNH CÔNG gần nhất trong bấy nhiêu ngày. */
  activeDays: 120,
  /** Quá mốc này mà chưa quay lại thì coi như đã rời bỏ. */
  churnedDays: 240,
  /** Từ bấy nhiêu đơn giao thành công trở lên thì là khách trung thành. */
  loyalOrders: 3,
  /** Số kỳ (tháng) hiện trên bảng cohort. */
  cohortMonths: 6,
  /** Số khách nguy cơ hiện trong danh sách hành động. */
  atRiskListSize: 25,
} as const;

/**
 * Phân khúc khách. Cố ý tính trên ĐƠN GIAO THÀNH CÔNG, không phải đơn đã đặt: một khách đặt 5 đơn
 * và hoàn cả 5 không phải khách trung thành, đó là khách đang gây lỗ.
 */
export type CrmSegment = "NEW" | "REPEAT" | "LOYAL" | "AT_RISK" | "CHURNED";

export const CRM_SEGMENT_ORDER: CrmSegment[] = ["NEW", "REPEAT", "LOYAL", "AT_RISK", "CHURNED"];

export const CRM_SEGMENT_LABEL: Record<CrmSegment, string> = {
  NEW: "Khách mới",
  REPEAT: "Đã mua lại",
  LOYAL: "Trung thành",
  AT_RISK: "Nguy cơ rời bỏ",
  CHURNED: "Đã rời bỏ",
};

export const CRM_SEGMENT_TONE: Record<CrmSegment, string> = {
  NEW: "bg-info/12 text-info",
  REPEAT: "bg-primary/10 text-primary",
  LOYAL: "bg-success/12 text-success",
  AT_RISK: "bg-warning/15 text-amber-700 dark:text-amber-300",
  CHURNED: "bg-muted text-muted-foreground",
};

/** Mỗi phân khúc phải nói được NÊN LÀM GÌ — đặt tên cho một nhóm mà không có hành động là vô dụng. */
export const CRM_SEGMENT_ACTION: Record<CrmSegment, string> = {
  NEW: "Mới nhận hàng lần đầu — nhắn cảm ơn và gợi ý mẫu đi kèm khi ấn tượng còn mới.",
  REPEAT: "Đã quay lại lần hai — mốc dễ rơi rụng nhất, đưa vào nhóm chăm sóc định kỳ.",
  LOYAL: "Mua đều và nhận hàng thật — ưu tiên báo mẫu mới trước, đừng để nhóm này im lặng.",
  AT_RISK: "Từng mua đều nhưng đang chững — liên hệ trước khi họ quen mua chỗ khác.",
  CHURNED: "Đã lâu không quay lại — chỉ nên gọi lại theo chiến dịch, không nhắn lẻ.",
};

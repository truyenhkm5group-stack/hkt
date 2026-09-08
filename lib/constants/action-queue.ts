/**
 * ───────────── HÀNG ĐỢI VIỆC CẦN XỬ LÝ ─────────────
 *
 * "Cần xử lý" cũ là một danh sách đọc rồi bỏ: không nói việc nào gấp hơn việc nào, không ai cầm
 * việc, và không phân biệt ĐÃ ĐỌC với ĐÃ TIẾP NHẬN với ĐÃ XONG.
 *
 * Ở đây mỗi việc có: loại · đối tượng · MỨC ƯU TIÊN tính được · lý do · thời điểm phát hiện ·
 * tuổi · người nhận · trạng thái · việc nên làm.
 *
 * MỨC ƯU TIÊN LÀ QUY TẮC, KHÔNG PHẢI CẢM TÍNH. Bốn yếu tố, cộng lại:
 *   mức nghiêm trọng + tuổi việc + giá trị tiền liên quan + khả năng cứu được
 * "Khả năng cứu được" là điểm mấu chốt: đơn giao thất bại còn gọi lại được thì phải xử lý trước
 * đơn đã hoàn xong — việc đã không cứu được nữa thì gấp cũng vô ích.
 */

export type CaseType =
  | "NEW_ORDER_UNPROCESSED"
  | "DELIVERY_FAILED"
  | "DELIVERY_STALE"
  | "RETURNING"
  | "COD_OVERDUE"
  | "DATA_ERROR"
  | "LOW_STOCK_RISK"
  | "CS_CASE"
  | "ORDER_INCOMPLETE"
  | "RISKY_ORDER"
  | "ADS_BILLING"
  /** Không biết vận đơn nào thuộc đơn nào — người phải quyết, máy cố ý không đoán. */
  | "AMBIGUOUS_ORDER_SHIPMENT_MAPPING"
  /** Vận đơn có thật nhưng chưa ghép được đơn ERP nào. */
  | "ORPHAN_SHIPMENT"
  | "OTHER";

/** Ánh xạ từ `notifications.kind` sang loại việc. Một chỗ duy nhất. */
export const KIND_TO_CASE: Record<string, CaseType> = {
  ORDER_PENDING: "NEW_ORDER_UNPROCESSED",
  SHIPMENT_FAILED: "DELIVERY_FAILED",
  SHIPMENT_STALE: "DELIVERY_STALE",
  SHIPMENT_RETURNING: "RETURNING",
  COD_OVERDUE: "COD_OVERDUE",
  DATA_ERROR: "DATA_ERROR",
  STOCK_LOW: "LOW_STOCK_RISK",
  CS_CASE: "CS_CASE",
  ORDER_INCOMPLETE: "ORDER_INCOMPLETE",
  RISKY_ORDER: "RISKY_ORDER",
  ADS_BILLING: "ADS_BILLING",
  AMBIGUOUS_MAPPING: "AMBIGUOUS_ORDER_SHIPMENT_MAPPING",
  ORPHAN_SHIPMENT: "ORPHAN_SHIPMENT",
};

export function caseTypeOf(kind: string): CaseType {
  return KIND_TO_CASE[kind] ?? "OTHER";
}

export const CASE_TYPE_LABEL: Record<CaseType, string> = {
  NEW_ORDER_UNPROCESSED: "Đơn mới chưa xử lý",
  DELIVERY_FAILED: "Giao thất bại · còn cứu được",
  DELIVERY_STALE: "Vận đơn treo lâu",
  RETURNING: "Đang chuyển hoàn",
  COD_OVERDUE: "Quá hạn mà tiền chưa về",
  DATA_ERROR: "Dữ liệu sai nghiêm trọng",
  LOW_STOCK_RISK: "Sắp hết hàng",
  CS_CASE: "Case CSKH",
  ORDER_INCOMPLETE: "Đơn thiếu thông tin",
  RISKY_ORDER: "Đơn rủi ro cao",
  ADS_BILLING: "Tài khoản quảng cáo",
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING: "Chưa rõ vận đơn thuộc đơn nào",
  ORPHAN_SHIPMENT: "Vận đơn chưa ghép được đơn",
  OTHER: "Khác",
};

/**
 * KHẢ NĂNG CỨU ĐƯỢC (0–1): hành động bây giờ còn thay đổi được kết quả bao nhiêu.
 * Đây là yếu tố phân biệt hàng đợi việc với danh sách cảnh báo thông thường.
 */
export const RECOVERABILITY: Record<CaseType, number> = {
  // Gọi khách ngay là cứu được nguyên đơn.
  DELIVERY_FAILED: 1,
  ORDER_INCOMPLETE: 1,
  NEW_ORDER_UNPROCESSED: 0.9,
  RISKY_ORDER: 0.9,
  CS_CASE: 0.8,
  // Còn kịp giục ĐVVC phát lại.
  DELIVERY_STALE: 0.7,
  // Sản xuất kịp thì không mất doanh thu.
  LOW_STOCK_RISK: 0.7,
  ADS_BILLING: 0.7,
  // Đòi được tiền, nhưng không thay đổi được kết quả đơn.
  COD_OVERDUE: 0.6,
  // Sửa được số liệu, hàng thì đã đi rồi.
  DATA_ERROR: 0.5,
  // Hàng đang trên đường về — chỉ còn xử lý hậu quả.
  RETURNING: 0.3,
  // Ghép đúng đơn thì số liệu đúng lại ngay, nhưng hàng thì đã xong từ lâu.
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING: 0.4,
  ORPHAN_SHIPMENT: 0.4,
  OTHER: 0.5,
};

export const CASE_ACTION: Record<CaseType, string> = {
  NEW_ORDER_UNPROCESSED: "Xác nhận đơn trên Pancake rồi đẩy sang Viettel Post.",
  DELIVERY_FAILED: "Gọi khách xác nhận rồi báo bưu tá phát lại — đây là nhóm cứu được nhiều tiền nhất.",
  DELIVERY_STALE: "Tra lại trên Viettel Post; nếu vẫn im thì mở khiếu nại.",
  RETURNING: "Chuẩn bị nhận hàng hoàn và lập phiếu tái nhập khi hàng về tới kho.",
  COD_OVERDUE: "Đối chiếu bảng kê và đòi Viettel Post phần còn thiếu.",
  DATA_ERROR: "Mở Chất lượng dữ liệu → Trung tâm điều khiển để xem bằng chứng của từng dòng.",
  LOW_STOCK_RISK: "Đặt sản xuất theo số đề xuất ở trang Kế hoạch SX.",
  CS_CASE: "Trả lời khách trên Pancake và đóng case.",
  ORDER_INCOMPLETE: "Bổ sung số điện thoại / địa chỉ trước khi gửi hàng.",
  RISKY_ORDER: "Xin cọc hoặc xác nhận lại với khách trước khi gửi.",
  ADS_BILLING: "Nạp tiền / kiểm tra ngưỡng thanh toán tài khoản quảng cáo.",
  OTHER: "Xem chi tiết rồi xử lý.",
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING:
    "Mở Chất lượng dữ liệu, đối chiếu vận đơn với đơn theo mã tham chiếu. CHỈ xử lý khi các cách ghép cho ra kết quả khác nhau — mọi cách ghép cùng kết quả thì tổng hợp đã đúng.",
  ORPHAN_SHIPMENT:
    "Tìm đơn tương ứng theo mã tham chiếu trên Viettel Post. Vận đơn chiều hoàn KHÔNG có đơn là bình thường, không cần làm gì.",
};

export type CasePriority = "URGENT" | "HIGH" | "NORMAL" | "LOW";

export const PRIORITY_LABEL: Record<CasePriority, string> = {
  URGENT: "Gấp",
  HIGH: "Cao",
  NORMAL: "Bình thường",
  LOW: "Thấp",
};

export const PRIORITY_TONE: Record<CasePriority, string> = {
  URGENT: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  HIGH: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  NORMAL: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOW: "bg-muted text-muted-foreground",
};

const SEVERITY_WEIGHT: Record<string, number> = { critical: 40, warning: 20, info: 5 };

/**
 * ĐIỂM ƯU TIÊN (0–100). Công thức mở, cố ý đơn giản để người vận hành đọc là hiểu vì sao:
 *
 *   mức nghiêm trọng (0–40) + tuổi việc (0–25) + tiền liên quan (0–20) + khả năng cứu (0–15)
 *
 * Tuổi việc bão hoà ở 7 ngày: việc để 3 tuần không gấp gấp ba lần việc để 1 tuần, nó chỉ nói lên
 * rằng nó đang bị bỏ quên. Tiền bão hoà ở 5 triệu để một đơn lớn không nhấn chìm mọi việc khác.
 */
export function caseScore(input: { severity: string; ageHours: number; amount?: number | null; type: CaseType }): number {
  const severity = SEVERITY_WEIGHT[input.severity] ?? 5;
  const age = Math.min(25, (Math.max(0, input.ageHours) / (7 * 24)) * 25);
  const money = Math.min(20, ((input.amount ?? 0) / 5_000_000) * 20);
  const recoverable = RECOVERABILITY[input.type] * 15;
  return Math.round(severity + age + money + recoverable);
}

export function priorityOf(score: number): CasePriority {
  if (score >= 70) return "URGENT";
  if (score >= 50) return "HIGH";
  if (score >= 30) return "NORMAL";
  return "LOW";
}

export type CaseStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  OPEN: "Chưa ai nhận",
  ACKNOWLEDGED: "Đã tiếp nhận",
  RESOLVED: "Đã xong",
};

/** Tuổi việc dạng chữ, đủ để đọc lướt. */
export function ageLabel(hours: number): string {
  if (hours < 1) return "vừa xong";
  if (hours < 24) return `${Math.floor(hours)} giờ`;
  const days = Math.floor(hours / 24);
  return `${days} ngày`;
}

/**
 * Trung tâm Chất lượng dữ liệu — nhãn & khoá dùng chung giữa máy chủ và trình duyệt.
 * Nguyên tắc: thiếu bằng chứng tiền thì trả UNVERIFIED ("Chưa xác minh"), KHÔNG quy về 0 và không đoán.
 */

/** Kết quả đơn theo quy tắc THỰC TẾ (có thêm UNVERIFIED so với quy tắc legacy). */
export type VerifiedOutcome = "NOT_SHIPPED" | "IN_TRANSIT" | "DELIVERED" | "RETURNED" | "RETURNED_BY_RULE" | "CANCELLED" | "UNVERIFIED";

export const VERIFIED_OUTCOME_LABEL: Record<VerifiedOutcome, string> = {
  NOT_SHIPPED: "Chưa gửi",
  IN_TRANSIT: "Đang giao",
  DELIVERED: "Giao thành công (đối chiếu tạm)",
  RETURNED: "Hoàn (đối chiếu tạm)",
  RETURNED_BY_RULE: "Không thành công (đối chiếu tạm)",
  CANCELLED: "Huỷ",
  UNVERIFIED: "Chưa xác minh (thiếu bằng chứng tiền)",
};

/** Các nhóm vấn đề có drill-down trên trang Chất lượng dữ liệu. */
export const DQ_ISSUES = [
  "unverified",
  "pancake-declared",
  "vtp-low-cash",
  "status-conflict",
  "unlinked-shipment",
  "return-not-received",
] as const;
export type DqIssue = (typeof DQ_ISSUES)[number];

export const DQ_ISSUE_LABEL: Record<DqIssue, string> = {
  unverified: "Đơn chưa đủ dữ liệu xác minh",
  "pancake-declared": "Pancake báo giao nhưng dữ liệu tiền không phù hợp",
  "vtp-low-cash": "Viettel Post báo giao nhưng tiền legacy thấp",
  "status-conflict": "Đơn có xung đột trạng thái",
  "unlinked-shipment": "Vận đơn chưa ghép được với đơn ERP",
  "return-not-received": "Hàng hoàn chưa xác nhận về kho",
};

export const DQ_ISSUE_HINT: Record<DqIssue, string> = {
  unverified: "Có tín hiệu giao xong từ Pancake hoặc Viettel Post nhưng không có số tiền thực thu nào để kết luận. Không được tính là doanh thu.",
  "pancake-declared": "Pancake ghi 'Đã giao'/'Đã thanh toán' nhưng không có vận đơn giao thành công và cũng không có tiền thực thu.",
  "vtp-low-cash": "Viettel Post có thể ghi 'Giao thành công' cho chiều hoàn. Nhóm này dùng số tiền legacy; cần đối chiếu chứng từ và hàng thực nhận trước khi kết luận.",
  "status-conflict": "Trạng thái đơn Pancake và trạng thái vận đơn Viettel Post nói hai điều khác nhau.",
  "unlinked-shipment": "Vận đơn có trên Viettel Post nhưng chưa ghép được với đơn nào trong ERP. Không tính vào doanh thu, lợi nhuận, tồn kho, marketing.",
  "return-not-received": "Vận đơn đã hoàn nhưng kho chưa xác nhận nhận được hàng. Số lượng này chưa được cộng lại tồn kho.",
};

export const DQ_SHIPMENT_SORTABLE = ["vtpOrderNumber", "stage", "codAmount", "codCollected", "updatedAt"];
export const DQ_ORDER_SORTABLE = ["insertedAt", "cash", "declaredRevenue"];

/**
 * ───────────── HỢP ĐỒNG SỰ KIỆN NỘI BỘ ─────────────
 *
 * Một bản khai DUY NHẤT cho mọi sự việc mà nhân sự AI có thể phản ứng. Đây là lớp *chiếu* của
 * miền nghiệp vụ sang nền tảng AI, KHÔNG phải bản sao: sự kiện chỉ mang KHOÁ để tra cứu ngược
 * (mã đơn, mã vận đơn, mã hội thoại) chứ không mang bản sao trạng thái nghiệp vụ. Muốn biết đơn
 * đang ở đâu, tiền đã về chưa, hàng còn không — công cụ ERP đọc lại từ nguồn sự thật lúc chạy.
 *
 * Vì sao không nhét trạng thái vào sự kiện: sự kiện được lưu lại và xử lý lại; một bản sao trạng
 * thái cũ đem ra quyết định hôm nay là đúng cách để một con bot khẳng định điều đã sai từ lâu.
 */

export const AI_EVENT_TYPES = [
  "CUSTOMER_MESSAGE_RECEIVED",
  "ORDER_CREATED",
  "ORDER_CONFIRMED",
  "ORDER_CANCELLED",
  "SHIPMENT_CREATED",
  "SHIPMENT_STATUS_CHANGED",
  "SHIPMENT_DELIVERED",
  "SHIPMENT_RETURNED",
  "INVENTORY_LOW",
] as const;

export type AiEventType = (typeof AI_EVENT_TYPES)[number];

export const AI_EVENT_LABEL: Record<AiEventType, string> = {
  CUSTOMER_MESSAGE_RECEIVED: "Khách nhắn tin",
  ORDER_CREATED: "Đơn được tạo",
  ORDER_CONFIRMED: "Đơn được xác nhận",
  ORDER_CANCELLED: "Đơn bị huỷ",
  SHIPMENT_CREATED: "Có vận đơn",
  SHIPMENT_STATUS_CHANGED: "Vận đơn đổi trạng thái",
  SHIPMENT_DELIVERED: "Vận đơn giao thành công",
  SHIPMENT_RETURNED: "Vận đơn hoàn về",
  INVENTORY_LOW: "Tồn kho xuống thấp",
};

/**
 * Loại đối tượng mà sự kiện trỏ tới. Chỉ có KHOÁ, không có trạng thái —
 * xem ghi chú đầu tệp về lý do.
 */
export const AI_SUBJECT_TYPES = ["CONVERSATION", "ORDER", "SHIPMENT", "VARIANT", "CUSTOMER"] as const;
export type AiSubjectType = (typeof AI_SUBJECT_TYPES)[number];

/** Đối tượng chính của từng loại sự kiện — khai một lần để không nơi nào tự đoán. */
export const AI_EVENT_SUBJECT: Record<AiEventType, AiSubjectType> = {
  CUSTOMER_MESSAGE_RECEIVED: "CONVERSATION",
  ORDER_CREATED: "ORDER",
  ORDER_CONFIRMED: "ORDER",
  ORDER_CANCELLED: "ORDER",
  SHIPMENT_CREATED: "SHIPMENT",
  SHIPMENT_STATUS_CHANGED: "SHIPMENT",
  SHIPMENT_DELIVERED: "SHIPMENT",
  SHIPMENT_RETURNED: "SHIPMENT",
  INVENTORY_LOW: "VARIANT",
};

export const AI_EVENT_STATUSES = ["PENDING", "DISPATCHED", "IGNORED", "FAILED"] as const;
export type AiEventStatus = (typeof AI_EVENT_STATUSES)[number];

export type AiEventInput = {
  type: AiEventType;
  /** Hệ thống sinh ra sự việc: `pancake-chat`, `vtp-webhook`, `job:alerts`… */
  source: string;
  subjectType: AiSubjectType;
  subjectId: string;
  /**
   * Dữ liệu kèm theo, ĐỦ để nhận dạng sự việc và KHÔNG hơn: mã tin nhắn, mã page, mốc thời gian.
   * Không đưa giá, tồn, trạng thái đơn vào đây.
   */
  payload?: Record<string, unknown>;
  occurredAt?: Date | null;
  /** Danh tính nghiệp vụ của sự việc; trùng khoá = cùng một sự việc dù được đẩy lại bao lần. */
  dedupeKey?: string | null;
};

/**
 * Khoá chống trùng chuẩn. Giống `webhookDedupeKey` của tầng tích hợp: cần ít nhất hai mảnh có
 * nghĩa, nếu không thì trả `null` (không nhận dạng được KHÔNG phải lý do để mất sự kiện — dòng
 * vẫn được ghi, chỉ là không chống trùng được).
 */
export function aiEventKey(type: AiEventType, parts: (string | number | null | undefined)[]): string | null {
  const usable = parts.map((p) => (p === null || p === undefined ? "" : String(p).trim())).filter(Boolean);
  return usable.length >= 1 ? [type, ...usable].join("|") : null;
}

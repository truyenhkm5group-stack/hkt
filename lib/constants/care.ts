import type { BucketKey } from "@/lib/constants/delivery-tower";

/**
 * ═══════════ CARE VẬN ĐƠN: TRẠNG THÁI NỘI BỘ, KHÔNG PHẢI TRẠNG THÁI ĐVVC ═══════════
 *
 * `shipments.stage` (chứng từ ĐVVC) trả lời "kiện đang ở đâu". `care_status` trả lời "đội đã làm
 * tới đâu với kiện đó". Không được suy cái này từ cái kia: đội bấm ĐÃ XONG không làm kiện thành đã
 * giao, và kiện được giao không tự đóng việc — nó chỉ RỜI hàng đợi mặc định.
 */
export const CARE_STATUSES = ["NEW", "ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"] as const;
export type CareStatus = (typeof CARE_STATUSES)[number];

/** Trạng thái "đang chờ" — đội đã làm phần mình, kết quả ở phía khách / ĐVVC / bưu tá. */
export const CARE_WAITING_STATUSES: CareStatus[] = ["WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY"];
/** Trạng thái KẾT THÚC của một case. Mở lại chỉ qua `reopen`, không qua đổi trạng thái thường. */
export const CARE_TERMINAL_STATUSES: CareStatus[] = ["RESOLVED", "CANCELLED"];
/** Trạng thái "đang mở, chưa chờ ai": kiện nằm ở Cần care. */
export const CARE_ACTIVE_STATUSES: CareStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS"];

/**
 * VÒNG ĐỜI MỘT CASE — chuyển trạng thái chỉ được đi theo bảng này. Đi sai ⇒ lỗi nghiệp vụ, không ghi.
 *
 *   NEW → ASSIGNED → IN_PROGRESS → WAITING_CUSTOMER | WAITING_CARRIER | WAITING_REDELIVERY
 *                                → RESOLVED | ESCALATED | CANCELLED
 *
 * RESOLVED / CANCELLED là kết thúc: chỉ `reopen` mới đưa case về NEW (hoặc ASSIGNED nếu còn người).
 */
export const CARE_TRANSITIONS: Record<CareStatus, readonly CareStatus[]> = {
  NEW: ["ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  ASSIGNED: ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  IN_PROGRESS: ["ASSIGNED", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  WAITING_CARRIER: ["IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  WAITING_REDELIVERY: ["IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "RESOLVED", "ESCALATED", "CANCELLED"],
  ESCALATED: ["IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
};

export function canTransition(from: CareStatus, to: CareStatus): boolean {
  return from === to || CARE_TRANSITIONS[from].includes(to);
}

export const CARE_STATUS_LABEL: Record<CareStatus, string> = {
  NEW: "Chưa xử lý",
  ASSIGNED: "Đã giao người",
  IN_PROGRESS: "Đang xử lý",
  WAITING_CUSTOMER: "Chờ khách",
  WAITING_CARRIER: "Chờ ĐVVC",
  WAITING_REDELIVERY: "Chờ phát lại",
  RESOLVED: "Đã xong",
  ESCALATED: "Escalate",
  CANCELLED: "Huỷ case",
};

export const CARE_STATUS_HINT: Record<CareStatus, string> = {
  NEW: "Chưa ai động vào. Kiện vẫn đang trong điều kiện cần care.",
  ASSIGNED: "Đã có người nhận, chưa bắt tay làm.",
  IN_PROGRESS: "Có người đang gọi / sửa / nhắn. Vẫn nằm ở Cần care cho tới khi hẹn theo dõi hoặc xong.",
  WAITING_CUSTOMER: "Đã làm phần mình, đang chờ khách trả lời. Tới hạn theo dõi thì tự quay lại Cần care.",
  WAITING_CARRIER: "Đang chờ Viettel Post / bưu cục trả lời. Tới hạn theo dõi thì tự quay lại Cần care.",
  WAITING_REDELIVERY: "Đã hẹn / yêu cầu phát lại, chờ bưu tá đi. Tới hạn theo dõi thì tự quay lại Cần care.",
  RESOLVED: "Đội đã làm xong phần của mình. KHÔNG có nghĩa là kiện đã giao — chiều ĐVVC vẫn theo chứng từ.",
  ESCALATED: "Vượt tay CSKH: đã báo bưu cục / quản lý. Cần người có quyền cao hơn.",
  CANCELLED: "Case không còn ý nghĩa (đơn huỷ, trùng, khách tự xử lý). Kiện vẫn theo chứng từ ĐVVC.",
};

export const CARE_STATUS_TONE: Record<CareStatus, string> = {
  NEW: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  ASSIGNED: "bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  IN_PROGRESS: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  WAITING_CUSTOMER: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  WAITING_CARRIER: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  WAITING_REDELIVERY: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  RESOLVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  ESCALATED: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  CANCELLED: "bg-muted text-muted-foreground",
};

/**
 * NHÓM ĐIỀU KIỆN CẦN CARE — quyết định kiện có vào hàng đợi mặc định hay không.
 *  · CUSTOMER_ACTION — cần gọi / nhắn / sửa thông tin với khách (CS).
 *  · CARRIER_ACTION  — cần thao tác với ĐVVC (phát tiếp, duyệt hoàn, khiếu nại).
 *  · DATA_FRESHNESS  — dữ liệu cũ / thiếu. KHÔNG phải kiện hỏng, KHÔNG tính vào backlog care;
 *                      là việc của giao vận / dữ liệu, trả riêng ở `dataGaps`.
 */
export type CareReasonClass = "CUSTOMER_ACTION" | "CARRIER_ACTION" | "DATA_FRESHNESS";

/** Sự kiện trong lịch sử case — chỉ thêm, không sửa, không xoá. */
export const CARE_EVENT_ACTIONS = ["STATUS", "ASSIGN", "NOTE", "FOLLOW_UP", "RESOLVE", "REOPEN", "CANCEL", "CARRIER_REQUEST", "CARRIER_RESULT", "CARRIER_MANUAL"] as const;
export type CareEventAction = (typeof CARE_EVENT_ACTIONS)[number];
/** Ai / cái gì gây ra sự kiện. */
export const CARE_EVENT_SOURCES = ["UI", "API", "AI", "SYSTEM"] as const;
export type CareEventSource = (typeof CARE_EVENT_SOURCES)[number];

/** Ánh xạ trạng thái cũ (bản 0060) → mới, dùng đúng một lần trong migration 0061. */
export const CARE_STATUS_LEGACY: Record<string, CareStatus> = { WAITING: "WAITING_CUSTOMER", DONE: "RESOLVED" };

/** Năm góc nhìn của bàn làm việc. Chữ giải thích nằm trong tooltip, tiêu đề chỉ là năm từ. */
export const CARE_VIEWS = ["care", "waiting", "escalated", "done", "all"] as const;
export type CareView = (typeof CARE_VIEWS)[number];

export const CARE_VIEW_LABEL: Record<CareView, string> = {
  care: "Cần care",
  waiting: "Đang chờ kết quả",
  escalated: "Escalated",
  done: "Đã xử lý",
  all: "Tất cả vận đơn",
};

export const CARE_VIEW_HINT: Record<CareView, string> = {
  care: "Kiện đang trong điều kiện cần người: giao thất bại, khách không nghe máy, chờ phát lại, im lặng quá ngưỡng, thiếu dữ liệu, sai địa chỉ / SĐT — và chưa xong hoặc đã tới hạn theo dõi.",
  waiting: "Đội đã làm phần của mình, đang chờ khách / ĐVVC. Tới hạn hẹn thì tự quay về Cần care.",
  escalated: "Đã báo bưu cục / quản lý. Người có quyền cao hơn phải theo.",
  done: "Đội đã đóng trong 7 ngày qua. Kiện vẫn có thể còn chạy ở chiều ĐVVC.",
  all: "Toàn bộ vận đơn để tra cứu, có bộ lọc trạng thái ĐVVC / COD / kỳ.",
};

/** Rổ của tháp giao vận là ĐIỀU KIỆN CẦN CARE. Rổ hàng hoàn thuộc đường ống kho, không vào đây. */
export const CARE_BUCKETS: BucketKey[] = ["NO_CONTACT", "DELIVERY_FAILED", "AWAITING_REDELIVERY", "STALE_NO_UPDATE", "DATA_GAP"];

/** Lý do kiện cần care — rổ tháp hoặc case CSKH cần sửa thông tin. */
export type CareReasonKey = BucketKey | "WRONG_INFO";
export const CARE_REASON_LABEL: Record<CareReasonKey, string> = {
  CARE_TODAY: "Cần care",
  NO_CONTACT: "Khách không nghe máy",
  DELIVERY_FAILED: "Giao thất bại",
  AWAITING_REDELIVERY: "Chờ phát lại",
  STALE_NO_UPDATE: "Im lặng quá ngưỡng",
  RETURNING: "Đang chuyển hoàn",
  RETURN_AT_SHOP: "Hoàn đã về shop",
  DATA_GAP: "Thiếu dữ liệu ĐVVC",
  WRONG_INFO: "Cần sửa địa chỉ / SĐT",
};

/**
 * SLA của một kiện cần care, tính từ lúc kiện VÀO điều kiện (sự kiện giao hụt gần nhất / tin cuối).
 * Không phải cảm tính: đo trên dữ liệu, kiện giao hụt để quá 24 giờ rơi thành hoàn nhanh nhất.
 */
export const CARE_SLA = {
  /** Giờ tối đa cho lần phản hồi ĐẦU TIÊN của người. */
  firstResponseHours: 2,
  /** Giờ tối đa để đóng hoặc escalate. */
  resolveHours: 24,
  /** "Đã xử lý" hiện bao nhiêu ngày gần nhất. */
  doneWindowDays: 7,
} as const;

/** Bốn kiểu hẹn theo dõi bấm một phát — không mở lịch. */
export const FOLLOW_UP_PRESETS: { key: string; label: string; hours: number }[] = [
  { key: "2h", label: "+2 giờ", hours: 2 },
  { key: "tomorrow", label: "Sáng mai", hours: -1 },
  { key: "2d", label: "+2 ngày", hours: 48 },
];

/** Hành động gửi ĐVVC — khoá ổn định, dùng làm idempotency và nhãn. */
export const CARRIER_ACTION_KEYS = ["redeliver", "approve-return", "resend", "approve", "cancel", "edit"] as const;
export type CarrierActionKey = (typeof CARRIER_ACTION_KEYS)[number];

export const CARRIER_ACTION_LABEL: Record<CarrierActionKey, string> = {
  redeliver: "Phát tiếp",
  "approve-return": "Duyệt hoàn",
  resend: "Gửi lại",
  approve: "Duyệt đơn",
  cancel: "Huỷ vận đơn",
  edit: "Sửa người nhận / COD",
};

export const CARRIER_REQUEST_STATUSES = ["PENDING", "SENT", "ACKNOWLEDGED", "SUCCESS", "FAILED", "UNSUPPORTED", "MANUAL_REQUIRED", "MANUAL_DONE"] as const;
export type CarrierRequestStatus = (typeof CARRIER_REQUEST_STATUSES)[number];

export const CARRIER_REQUEST_LABEL: Record<CarrierRequestStatus, string> = {
  PENDING: "Đang gửi",
  SENT: "Đã gửi",
  ACKNOWLEDGED: "ĐVVC đã nhận",
  SUCCESS: "ĐVVC xác nhận",
  FAILED: "ĐVVC từ chối",
  UNSUPPORTED: "Không hỗ trợ",
  MANUAL_REQUIRED: "Phải làm tay",
  MANUAL_DONE: "Đã làm tay",
};

export const CARRIER_REQUEST_TONE: Record<CarrierRequestStatus, string> = {
  PENDING: "bg-muted text-muted-foreground",
  SENT: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  ACKNOWLEDGED: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  SUCCESS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNSUPPORTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  MANUAL_REQUIRED: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  MANUAL_DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
};

/**
 * Sự kiện ĐVVC nào XÁC NHẬN một yêu cầu đã có tác dụng — chỉ khi thấy nó mới được ghi SUCCESS.
 * Phản hồi "OK" của API chỉ là ACK: ĐVVC nhận yêu cầu, chưa chắc bưu tá đã đi.
 */
export const CARRIER_ACTION_CONFIRM_STAGES: Record<CarrierActionKey, string[]> = {
  redeliver: ["OUT_FOR_DELIVERY", "DELIVERED"],
  "approve-return": ["RETURNING", "RETURNED"],
  resend: ["PENDING", "PICKED_UP", "IN_TRANSIT"],
  approve: ["PICKED_UP", "IN_TRANSIT"],
  cancel: ["CANCELLED"],
  edit: [],
};

/** Chặng ĐVVC cho phép bấm hành động (lấy đúng luật đã dùng ở trang chi tiết vận đơn). */
export function carrierActionAllowed(key: CarrierActionKey, stage: string): boolean {
  const final = ["DELIVERED", "RETURNED", "CANCELLED"].includes(stage);
  switch (key) {
    case "redeliver":
    case "approve-return":
      return ["DELIVERY_FAILED", "OUT_FOR_DELIVERY", "IN_TRANSIT", "PICKED_UP"].includes(stage);
    case "resend":
      return ["RETURNING", "RETURNED", "CANCELLED", "DELIVERY_FAILED"].includes(stage);
    case "approve":
      return stage === "PENDING";
    case "cancel":
      return !final && stage !== "OUT_FOR_DELIVERY";
    case "edit":
      return !final;
  }
}

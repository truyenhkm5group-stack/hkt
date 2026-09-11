import type { BucketKey } from "@/lib/constants/delivery-tower";

/**
 * ═══════════ CARE VẬN ĐƠN: TRẠNG THÁI NỘI BỘ, KHÔNG PHẢI TRẠNG THÁI ĐVVC ═══════════
 *
 * `shipments.stage` (chứng từ ĐVVC) trả lời "kiện đang ở đâu". `care_status` trả lời "đội đã làm
 * tới đâu với kiện đó". Không được suy cái này từ cái kia: đội bấm ĐÃ XONG không làm kiện thành đã
 * giao, và kiện được giao không tự đóng việc — nó chỉ RỜI hàng đợi mặc định.
 */
export const CARE_STATUSES = ["NEW", "IN_PROGRESS", "WAITING", "ESCALATED", "DONE"] as const;
export type CareStatus = (typeof CARE_STATUSES)[number];

export const CARE_STATUS_LABEL: Record<CareStatus, string> = {
  NEW: "Chưa xử lý",
  IN_PROGRESS: "Đang xử lý",
  WAITING: "Chờ kết quả",
  ESCALATED: "Escalate",
  DONE: "Đã xong",
};

export const CARE_STATUS_HINT: Record<CareStatus, string> = {
  NEW: "Chưa ai động vào. Kiện vẫn đang trong điều kiện cần care.",
  IN_PROGRESS: "Có người đang gọi / sửa / nhắn. Vẫn nằm ở Cần care cho tới khi hẹn theo dõi hoặc xong.",
  WAITING: "Đã làm phần của mình, đang chờ khách hoặc ĐVVC. Tới hạn theo dõi thì tự quay lại Cần care.",
  ESCALATED: "Vượt tay CSKH: đã báo bưu cục / quản lý. Cần người có quyền cao hơn.",
  DONE: "Đội đã làm xong phần của mình. KHÔNG có nghĩa là kiện đã giao — chiều ĐVVC vẫn theo chứng từ.",
};

export const CARE_STATUS_TONE: Record<CareStatus, string> = {
  NEW: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  IN_PROGRESS: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  WAITING: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  ESCALATED: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  DONE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
};

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

export const CARRIER_REQUEST_STATUSES = ["PENDING", "SENT", "ACK", "SUCCESS", "FAILED", "UNSUPPORTED", "MANUAL_REQUIRED", "MANUAL_DONE"] as const;
export type CarrierRequestStatus = (typeof CARRIER_REQUEST_STATUSES)[number];

export const CARRIER_REQUEST_LABEL: Record<CarrierRequestStatus, string> = {
  PENDING: "Đang gửi",
  SENT: "Đã gửi",
  ACK: "ĐVVC đã nhận",
  SUCCESS: "ĐVVC xác nhận",
  FAILED: "ĐVVC từ chối",
  UNSUPPORTED: "Không hỗ trợ",
  MANUAL_REQUIRED: "Phải làm tay",
  MANUAL_DONE: "Đã làm tay",
};

export const CARRIER_REQUEST_TONE: Record<CarrierRequestStatus, string> = {
  PENDING: "bg-muted text-muted-foreground",
  SENT: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  ACK: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
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

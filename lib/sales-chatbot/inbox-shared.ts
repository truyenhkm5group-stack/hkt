/**
 * ═══════════ HỘP THƯ NGƯỜI (M8) — KIỂU + NHÃN DÙNG CHUNG MÁY CHỦ / TRÌNH DUYỆT ═══════════
 *
 * Tệp THUẦN (không CSDL): trang hộp thư (client) chỉ được `import` từ đây; lõi đọc / ghi ở `lib/sales-chatbot/inbox.ts`.
 */

export const INBOX_FILTERS = ["ALL", "UNANSWERED", "NEEDS_HUMAN", "MINE", "UNASSIGNED"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export const INBOX_FILTER_LABEL: Record<InboxFilter, string> = {
  ALL: "Tất cả",
  UNANSWERED: "Chờ trả lời",
  NEEDS_HUMAN: "Cần người",
  MINE: "Của tôi",
  UNASSIGNED: "Chưa ai nhận",
};

export const INBOX_CHANNELS = ["FANPAGE", "ZALO", "WEB"] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];
export const INBOX_CHANNEL_LABEL: Record<InboxChannel, string> = { FANPAGE: "Facebook / Instagram", ZALO: "Zalo OA", WEB: "Chat web" };

export type InboxRow = {
  id: string;
  channel: string;
  status: string;
  handoffReason: string | null;
  customerName: string;
  customerPhone: string | null;
  preview: string;
  previewSide: TimelineSide | null;
  lastActivityAt: string;
  /** Tin khách CHƯA ai trả lời (bot, nhân viên ERP, hay người ngoài ERP) — mốc tin khách đó; `null` = đã được trả lời. */
  waitingSince: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  hasOrder: boolean;
};

/** Ai nói: KHÁCH · BOT · NHÂN VIÊN qua hộp thư ERP (có tên) · PHÍA PAGE ngoài ERP (nhân viên trên Pancake / Hộp thư Meta / Zalo OA, hoặc trả lời tự động). */
export type TimelineSide = "CUSTOMER" | "BOT" | "STAFF" | "PAGE";

export type TimelineItem = {
  key: string;
  at: string;
  side: TimelineSide;
  text: string;
  images: string[];
  author: string | null;
  /** Chỉ tin STAFF: SENDING · SENT · FAILED. */
  status?: "SENDING" | "SENT" | "FAILED";
  error?: string | null;
};

/**
 * Khung gửi của kênh: Messenger / Instagram — 24 giờ từ tin cuối của khách (chính sách Meta); Zalo OA — 48 giờ miễn phí, quá
 * thì là tin TÍNH PHÍ (người bấm phải xác nhận), quá 7 ngày thì Zalo không cho gửi; chat web — luôn gửi được (khách đọc khi mở).
 */
export type SendWindow =
  | { kind: "OPEN"; until: string | null; note: string | null }
  | { kind: "PAID"; note: string }
  | { kind: "CLOSED"; note: string }
  | { kind: "UNKNOWN"; note: string };

export type InboxOrder = { id: string; shortCode: string; stage: string; outcome: string | null; outcomeLabel: string; total: number; insertedAt: string; byBot: boolean };

export type InboxThread = {
  id: string;
  channel: string;
  channelLabel: string;
  status: string;
  handoffReason: string | null;
  botYields: boolean;
  customer: { id: string | null; name: string; phone: string | null; address: string | null; province: string | null };
  assigneeUserId: string | null;
  assigneeName: string | null;
  window: SendWindow;
  items: TimelineItem[];
  orders: InboxOrder[];
  canReply: boolean;
  canManage: boolean;
  replyBlockedReason: string | null;
};

/** Nhãn kết quả đơn theo `ORDER_OUTCOME` (lib/queries/return-rate.ts) — chỉ để HIỆN, không tính gì. */
export const INBOX_OUTCOME_LABEL: Record<string, string> = {
  NOT_SHIPPED: "Chưa gửi",
  AWAITING_PICKUP: "Chờ lấy hàng",
  IN_TRANSIT: "Đang giao",
  DELIVERED: "Giao thành công",
  RETURNED: "Hoàn",
  RETURNED_BY_RULE: "Không thành công",
  CANCELLED: "Huỷ",
};

/** Tin nhân viên tối đa (chia đoạn theo trần từng kênh khi gửi). */
export const STAFF_REPLY_MAX = 4_000;

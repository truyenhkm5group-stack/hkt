/**
 * ═══════════ HỘP THƯ NGƯỜI (M8) — KIỂU + NHÃN DÙNG CHUNG MÁY CHỦ / TRÌNH DUYỆT ═══════════
 *
 * Tệp THUẦN (không CSDL): trang hộp thư (client) chỉ được `import` từ đây; lõi đọc / ghi ở `lib/sales-chatbot/inbox.ts`.
 */
import type { AiHoldView } from "@/lib/sales-chatbot/ai-hold-shared";
import type { AiBlock, MessageTrace } from "@/lib/sales-chatbot/ai-status-shared";
import type { ControlStamp } from "@/lib/sales-chatbot/conversation-control-shared";

import type { CustomerLevel } from "@/lib/sales-chatbot/levels-shared";

export const INBOX_FILTERS = ["ALL", "UNREAD", "UNANSWERED", "NEEDS_HUMAN", "MINE", "UNASSIGNED"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export const INBOX_FILTER_LABEL: Record<InboxFilter, string> = {
  ALL: "Tất cả",
  UNREAD: "Chưa đọc",
  UNANSWERED: "Chờ trả lời",
  NEEDS_HUMAN: "Cần người",
  MINE: "Của tôi",
  UNASSIGNED: "Chưa ai nhận",
};

/**
 * Ai đang trả lời khách (conversation-control-shared.ts): AI = bot đang tự trả lời (không nhường, không ghi đè); HUMAN = đang
 * nhường cho người · Tiếp quản · AI gợi ý (người gửi). Hai nhóm phủ kín, không giao nhau.
 */
export const INBOX_HANDLERS = ["AI", "HUMAN"] as const;
export type InboxHandler = (typeof INBOX_HANDLERS)[number];
export const INBOX_HANDLER_LABEL: Record<InboxHandler, string> = { AI: "AI đang trả lời", HUMAN: "Người đang xử lý" };

/** Lọc theo mốc TIN cuối của hội thoại (giờ Việt Nam). `CUSTOM` = khoảng ngày người chọn. */
export const INBOX_PERIODS = ["TODAY", "YESTERDAY", "7D", "30D", "CUSTOM"] as const;
export type InboxPeriod = (typeof INBOX_PERIODS)[number];
export const INBOX_PERIOD_LABEL: Record<InboxPeriod, string> = { TODAY: "Hôm nay", YESTERDAY: "Hôm qua", "7D": "7 ngày", "30D": "30 ngày", CUSTOM: "Khoảng ngày" };
/** Trần dòng một lần tải danh sách («Xem thêm» nâng dần tới đây). */
export const INBOX_LIST_MAX = 500;

export const INBOX_CHANNELS = ["FANPAGE", "ZALO", "WEB"] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];
export const INBOX_CHANNEL_LABEL: Record<InboxChannel, string> = { FANPAGE: "Facebook / Instagram", ZALO: "Zalo OA", WEB: "Chat web" };

export type InboxRow = {
  id: string;
  channel: string;
  /** Page / tài khoản kênh của hội thoại — hội thoại LUÔN giữ page nó tới từ đó. */
  pageId: string | null;
  pageName: string | null;
  status: string;
  handoffReason: string | null;
  customerName: string;
  customerPhone: string | null;
  preview: string;
  previewSide: TimelineSide | null;
  lastActivityAt: string;
  /** Tin khách CHƯA ai trả lời (bot, nhân viên ERP, hay người ngoài ERP) — mốc tin khách đó; `null` = đã được trả lời. */
  waitingSince: string | null;
  /** Tin khách mới hơn lần cuối một nhân viên mở hội thoại. */
  unread: boolean;
  assigneeUserId: string | null;
  assigneeName: string | null;
  hasOrder: boolean;
  labels: InboxLabel[];
  /** Level khách (job tính — `levels-shared.ts`); `null` = chưa tính. */
  level: CustomerLevel | null;
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
  /** Chỉ tin KHÁCH sống (không phải lịch sử nhập): dấu vết Đã nhận → … → Đã gửi / mã dừng (ai-status.ts). */
  trace?: MessageTrace;
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

/** `placeGap` = đơn ERP còn sống chưa ghép được tỉnh / xã (không gửi được hãng vận chuyển, không tự xác nhận) — `null` = đủ. */
export type InboxOrder = { id: string; shortCode: string; stage: string; outcome: string | null; outcomeLabel: string; total: number; insertedAt: string; byBot: boolean; placeGap: string | null };

/**
 * Lịch sử mua của khách — kết quả đơn theo `ORDER_OUTCOME` (một công thức, AGENTS 0.2) trên đơn ERP cùng khách / cùng SĐT, cộng
 * số Pancake ghi nhận (giao thành công / hoàn) nếu có; `risk` = đánh giá rủi ro dùng chung với trang Đơn hàng.
 */
export type InboxCustomerHistory = {
  total: number;
  delivered: number;
  returned: number;
  inTransit: number;
  notShipped: number;
  cancelled: number;
  pancakeSucceed: number;
  pancakeReturned: number;
  blocked: boolean;
  risk: { severity: "critical" | "warning"; reasons: string[] } | null;
};

/** Góp ý của nhân viên cho AI trên hội thoại (0217). */
export type InboxFeedback = { id: string; userName: string; text: string; lessons: string[]; status: "APPLIED" | "FAILED"; error: string | null; createdAt: string };

export type InboxThread = {
  id: string;
  channel: string;
  channelLabel: string;
  status: string;
  handoffReason: string | null;
  botYields: boolean;
  /** AI_ACTIVE · HUMAN_COOLDOWN (kèm mốc hết hạn + giờ máy chủ để đếm ngược) · HUMAN_TAKEOVER — `ai-hold-shared.ts::aiHoldOf`. */
  aiHold: AiHoldView;
  /** Lý do AI KHÔNG trả lời (cổng page · chế độ vận hành · module · bot tắt · nguồn AI…) — `ai-status-shared.ts`. */
  aiBlocks: AiBlock[];
  /**
   * Bản lọc cho workspace KHÁCH (`lib/saas/visibility.ts::customerInboxThread`): lý do chặn / dấu vết đã thành lời thường, không
   * mã kỹ thuật, không lỗi gốc — màn hình không in mã máy. Vắng = bản đầy đủ (workspace nhà).
   */
  customerView?: boolean;
  /** Chế độ AI của RIÊNG hội thoại (Tiếp quản / AI gợi ý); `null` = theo chế độ của tổ chức (conversation-control-shared.ts). */
  control: ControlStamp | null;
  customer: { id: string | null; name: string; phone: string | null; address: string | null; province: string | null };
  assigneeUserId: string | null;
  assigneeName: string | null;
  window: SendWindow;
  items: TimelineItem[];
  orders: InboxOrder[];
  canReply: boolean;
  /** Có quyền làm việc với hội thoại (gắn nhãn, ghi chú) — không phụ thuộc khung gửi của kênh. */
  canWork: boolean;
  canManage: boolean;
  replyBlockedReason: string | null;
  /** Nhãn đang gắn · bộ nhãn để chọn · ghi chú nội bộ (0211). */
  labels: InboxLabel[];
  allLabels: InboxLabel[];
  notes: InboxNote[];
  /** Level khách hiện tại + gói ngành (để biết level nào hiện). */
  level: CustomerLevel | null;
  history: InboxCustomerHistory | null;
  feedback: InboxFeedback[];
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

// ───────────────────────────── Ảnh · nhãn · ghi chú (0211) ─────────────────────────────

/** Ảnh mỗi tin nhân viên gửi — tối đa 4 ảnh, mỗi ảnh ≤ 5 MB (Zalo: JPG / PNG ≤ 1 MB — kiểm ở máy chủ). */
export const STAFF_IMAGES_MAX = 4;
export const STAFF_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const STAFF_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Bảng màu ĐÓNG của nhãn (CHECK ở CSDL) — không có ô gõ màu tự do. */
export const LABEL_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
export const LABEL_COLOR_CLASS: Record<LabelColor, string> = {
  gray: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100",
  red: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-200",
  amber: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  green: "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-200",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-200",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-950/60 dark:text-pink-200",
};
export const LABEL_NAME_MAX = 40;
export const NOTE_MAX = 1_000;

export type InboxLabel = { id: string; name: string; color: LabelColor };
export type InboxNote = { id: string; text: string; author: string; userId: string; at: string; canDelete: boolean };

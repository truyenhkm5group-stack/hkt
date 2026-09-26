/**
 * ═══════════ GỬI TIN HÀNG LOẠT THEO BỘ LỌC — LUẬT CHỌN NGƯỜI NHẬN ═══════════
 *
 * Chủ shop 26/09/2026: thay bookmarklet bấm tuần tự vị trí 14–16 cột trái Pancake bằng một công cụ
 * trong ERP — tự lọc theo fanpage, ngày, thẻ Pancake, trạng thái; tự đặt số tin; bấm mới gửi.
 *
 * ─── MỘT LUẬT, HAI LẦN ÁP ───
 *
 * `conversationVerdict()` là hàm THUẦN. Nó chạy hai lần trên cùng một khách:
 *   1. lúc XEM TRƯỚC / lúc bấm gửi — trên mốc thời gian `conversation_funnel` (job `cs-chat`, ≤ 15 phút tuổi);
 *   2. ngay TRƯỚC KHI GỬI từng khách — trên tin nhắn thật vừa đọc lại từ Pancake.
 * Lần 2 tồn tại vì một lượt 500 khách chạy hơn 15 phút: trong lúc đó khách có thể vừa nhắn lại (nhân viên
 * phải trả lời chứ không phải máy bắn tin mẫu), hoặc vừa trôi ra ngoài 24 giờ.
 *
 * ─── CỬA SỔ 24 GIỜ LÀ LUẬT CỦA META, KHÔNG PHẢI BỘ LỌC ───
 *
 * Meta chỉ cho trang nhắn trong 24 giờ kể từ tin cuối KHÁCH gửi. Đo 13/09/2026: 25/25 tin bán chéo gửi
 * ngoài cửa sổ đều bị trả `(#10)` (xem `lib/constants/outreach-errors.ts`). Nên đây không phải một lựa chọn
 * trên màn hình: khách ngoài cửa sổ được ĐẾM và IN RA ("Meta không cho nhắn"), không được đưa vào lượt gửi.
 * Không dùng thẻ tin nhắn để lách — gửi khuyến mại dưới thẻ là lạm dụng thẻ, cái giá là khoá trang.
 * Bookmarklet cũ đi qua giao diện Pancake nhưng vẫn đi qua cùng API Meta, nên cũng chịu đúng luật này.
 */
import { z } from "zod";

/** Meta: 24 giờ kể từ tin cuối của khách. */
export const META_WINDOW_HOURS = 24;
/**
 * Biên an toàn trước hạn 24 giờ. Một tin gửi ở phút 23:59 có thể tới Meta ở 24:00:01 — trừ 10 phút để
 * khách được chọn chắc chắn còn nhắn được lúc tin thật sự đi.
 */
export const META_WINDOW_MARGIN_MINUTES = 10;

export const REPLY_STATES = ["SHOP_LAST", "CUSTOMER_LAST", "ANY"] as const;
export type ReplyState = (typeof REPLY_STATES)[number];
export const REPLY_STATE_LABEL: Record<ReplyState, string> = {
  SHOP_LAST: "Khách chưa trả lời shop",
  CUSTOMER_LAST: "Shop chưa trả lời khách",
  ANY: "Tất cả",
};

export const PHONE_FILTERS = ["ANY", "HAS", "NONE"] as const;
export const PHONE_FILTER_LABEL: Record<(typeof PHONE_FILTERS)[number], string> = { ANY: "Tất cả", HAS: "Đã cho SĐT", NONE: "Chưa cho SĐT" };

export const ORDER_FILTERS = ["NO_ORDER", "ANY"] as const;
export const ORDER_FILTER_LABEL: Record<(typeof ORDER_FILTERS)[number], string> = { NO_ORDER: "Chưa có đơn (30 ngày)", ANY: "Tất cả, kể cả đã có đơn" };

/** Lý do một khách KHÔNG vào lượt gửi — lúc xem trước hoặc lúc sắp gửi. */
export const BROADCAST_SKIP_REASONS = ["OUTSIDE_WINDOW", "NO_CUSTOMER_MESSAGE", "CUSTOMER_REPLIED", "SHOP_REPLIED", "NOT_SILENT_YET", "HAS_ORDER", "RECENTLY_BROADCAST", "NO_CUSTOMER_ID", "OVER_LIMIT"] as const;
export type BroadcastSkipReason = (typeof BROADCAST_SKIP_REASONS)[number];
export const BROADCAST_SKIP_LABEL: Record<BroadcastSkipReason, string> = {
  OUTSIDE_WINDOW: "Quá 24 giờ từ tin cuối của khách — Meta không cho nhắn",
  NO_CUSTOMER_MESSAGE: "Khách chưa nhắn tin nào",
  CUSTOMER_REPLIED: "Khách vừa nhắn lại — để nhân viên trả lời",
  SHOP_REPLIED: "Shop đã trả lời",
  NOT_SILENT_YET: "Chưa im đủ số giờ đã đặt",
  HAS_ORDER: "Đã có đơn",
  RECENTLY_BROADCAST: "Đã nhận tin hàng loạt gần đây",
  NO_CUSTOMER_ID: "Thiếu mã khách Pancake — không kiểm lại được trước khi gửi",
  OVER_LIMIT: "Vượt số khách tối đa của lượt",
};

export const BROADCAST_STATUS_LABEL: Record<string, string> = { RUNNING: "Đang gửi", STOPPED: "Đã dừng", DONE: "Xong" };
export const RECIPIENT_STATUS_LABEL: Record<string, string> = { PENDING: "Chờ gửi", SENDING: "Đang gửi", SENT: "Đã gửi", SKIPPED: "Bỏ qua", FAILED: "Lỗi" };

/**
 * Vòng gửi coi như đã chết nếu nhịp tim cũ hơn mức này (deploy / khởi động lại máy chủ). Một khách
 * bình thường mất vài giây, nhưng mỗi lượt gọi Pancake có thể chờ tới 30 giây — 5 tin chờ hết hạn là
 * vài phút, nên ngưỡng phải rộng hơn thế, nếu không một vòng còn sống bị coi là chết.
 */
export const BROADCAST_STALE_MINUTES = 10;
/** Dòng `SENDING` cũ hơn mức này ⇒ tiến trình chết GIỮA lúc gửi: KHÔNG gửi lại (tin có thể đã đi). */
export const SENDING_STALE_MINUTES = 15;

export const MAX_MESSAGES = 5;
export const MAX_MEDIA = 3;
export const MAX_RECIPIENTS = 3000;
/** Giãn cách tối thiểu giữa hai khách. Bookmarklet cũ dùng 0,1 giây — nhịp đó dễ khiến Meta hạn chế trang. */
export const MIN_GAP_SECONDS = 1;

export const broadcastFiltersSchema = z
  .object({
    pageIds: z.array(z.string().trim().min(1)).max(100).default([]),
    /** Ngày (giờ VN, `YYYY-MM-DD`) của tin cuối khách gửi. Rỗng = không giới hạn phía đó. */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default(""),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default(""),
    /** Có ÍT NHẤT MỘT thẻ trong danh sách. Rỗng = không lọc. */
    tagsAny: z.array(z.string().trim().min(1)).max(50).default([]),
    /** KHÔNG có thẻ nào trong danh sách. */
    tagsNone: z.array(z.string().trim().min(1)).max(50).default([]),
    replyState: z.enum(REPLY_STATES).default("SHOP_LAST"),
    /** Im ít nhất N giờ kể từ tin cuối (của bất kỳ bên nào). */
    minSilenceHours: z.number().min(0).max(23).default(1),
    phone: z.enum(PHONE_FILTERS).default("ANY"),
    order: z.enum(ORDER_FILTERS).default("NO_ORDER"),
    /** Bỏ khách đã nhận tin hàng loạt trong N giờ. 0 = không bỏ. */
    skipRecentHours: z.number().int().min(0).max(24 * 30).default(24),
    limit: z.number().int().min(1).max(MAX_RECIPIENTS).default(500),
  })
  .strict();
export type BroadcastFilters = z.infer<typeof broadcastFiltersSchema>;

export const broadcastStartSchema = z
  .object({
    filters: broadcastFiltersSchema,
    messages: z.array(z.string().trim().min(1, "Tin không được để trống").max(2000)).min(1, "Cần ít nhất một tin").max(MAX_MESSAGES),
    mediaUrls: z.array(z.string().trim().url("Đường dẫn ảnh/video không hợp lệ")).max(MAX_MEDIA).default([]),
    gapSeconds: z.number().min(MIN_GAP_SECONDS).max(60).default(2),
  })
  .strict();
export type BroadcastStartInput = z.infer<typeof broadcastStartSchema>;

/** Kết quả "Xem trước" gửi về trình duyệt (đã tuần tự hoá). */
export type BroadcastPreviewRow = { pageName: string; pageId: string; customerName: string; hasPhone: boolean; tags: string[]; lastCustomerAt: string | null; lastShopAt: string | null };
export type BroadcastPreviewResult = {
  total: number;
  sample: BroadcastPreviewRow[];
  excluded: Partial<Record<BroadcastSkipReason, number>>;
  truncatedPages: string[];
  lastScanAt: string | null;
};

export type ConversationTimes = { lastCustomerAt: Date | null; lastShopAt: Date | null };
export type VerdictRule = Pick<BroadcastFilters, "replyState" | "minSilenceHours">;

/**
 * Khách này còn nhắn được và đúng trạng thái người bấm chọn không? `null` = được gửi.
 *
 * Thứ tự kiểm là thứ tự của lý do MẠNH NHẤT: ngoài cửa sổ Meta thì mọi lý do khác không còn nghĩa.
 */
export function conversationVerdict(t: ConversationTimes, rule: VerdictRule, now: Date): BroadcastSkipReason | null {
  if (!t.lastCustomerAt) return "NO_CUSTOMER_MESSAGE";
  const windowMs = META_WINDOW_HOURS * 3_600_000 - META_WINDOW_MARGIN_MINUTES * 60_000;
  if (now.getTime() - t.lastCustomerAt.getTime() >= windowMs) return "OUTSIDE_WINDOW";
  const shopLast = t.lastShopAt !== null && t.lastShopAt.getTime() > t.lastCustomerAt.getTime();
  if (rule.replyState === "SHOP_LAST" && !shopLast) return "CUSTOMER_REPLIED";
  if (rule.replyState === "CUSTOMER_LAST" && shopLast) return "SHOP_REPLIED";
  const latest = Math.max(t.lastCustomerAt.getTime(), t.lastShopAt?.getTime() ?? 0);
  if (now.getTime() - latest < rule.minSilenceHours * 3_600_000) return "NOT_SILENT_YET";
  return null;
}

/** Mốc tin cuối của mỗi bên từ tin nhắn đọc lại — chỉ đếm tin có nội dung (chữ hoặc tệp). */
export function timesFromMessages(messages: readonly { fromPage: boolean; insertedAt: Date | null; text: string; hasAttachment: boolean }[]): ConversationTimes {
  let lastCustomerAt: Date | null = null;
  let lastShopAt: Date | null = null;
  for (const m of messages) {
    if (!m.insertedAt || (!m.text && !m.hasAttachment)) continue;
    if (m.fromPage) {
      if (!lastShopAt || m.insertedAt > lastShopAt) lastShopAt = m.insertedAt;
    } else if (!lastCustomerAt || m.insertedAt > lastCustomerAt) lastCustomerAt = m.insertedAt;
  }
  return { lastCustomerAt, lastShopAt };
}

/** Nhịp tim cũ ⇒ vòng gửi không còn chạy dù trạng thái vẫn ghi RUNNING. */
export function isBroadcastStale(heartbeatAt: Date | null, now: Date) {
  return !heartbeatAt || now.getTime() - heartbeatAt.getTime() > BROADCAST_STALE_MINUTES * 60_000;
}

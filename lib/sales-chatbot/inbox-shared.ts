/**
 * ═══════════ HỘP THƯ NGƯỜI (M8) — KIỂU + NHÃN DÙNG CHUNG MÁY CHỦ / TRÌNH DUYỆT ═══════════
 *
 * Tệp THUẦN (không CSDL): trang hộp thư (client) chỉ được `import` từ đây; lõi đọc / ghi ở `lib/sales-chatbot/inbox.ts`.
 */
import { avatarLinkOf, type AvatarLink, type FacebookIdInput } from "@/lib/sales-chatbot/avatar-profile";
import type { AiHoldState, AiHoldView } from "@/lib/sales-chatbot/ai-hold-shared";
import type { AiBlock, MessageTrace } from "@/lib/sales-chatbot/ai-status-shared";
import { readConversationControl, type ControlStamp } from "@/lib/sales-chatbot/conversation-control-shared";

import type { CustomerLevel } from "@/lib/sales-chatbot/levels-shared";
import type { OrderReviewEntry, OrderReviewResolution } from "@/lib/constants/order-review";

/**
 * Thẻ lọc của hộp thư (chủ shop 07/10/2026): Tất cả · Chưa đọc · AI đang xử lý · Người đang xử lý · Cần người · Đã chốt · Chưa chốt
 * (+ Chờ trả lời · Của tôi · Chưa ai nhận). «AI / Người đang xử lý» đọc ĐÚNG `aiHoldOf` (ai-hold-shared.ts — một nguồn với huy hiệu
 * trên từng hàng và thanh điều khiển trong luồng tin): AI = AI_ACTIVE; Người = HUMAN_COOLDOWN + HUMAN_TAKEOVER. «Đã chốt» = hội
 * thoại có đơn ERP thật (không tính đơn nháp) hoặc level khách «Đã chốt đơn»; «Chưa chốt» là phần bù — hai thẻ phủ kín.
 */
export const INBOX_FILTERS = ["ALL", "UNREAD", "AI", "HUMAN", "NEEDS_HUMAN", "ORDERED", "NOT_ORDERED", "UNANSWERED", "MINE", "UNASSIGNED"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export const INBOX_FILTER_LABEL: Record<InboxFilter, string> = {
  ALL: "Tất cả",
  UNREAD: "Chưa đọc",
  AI: "AI đang xử lý",
  HUMAN: "Người đang xử lý",
  NEEDS_HUMAN: "Cần người",
  ORDERED: "Đã chốt",
  NOT_ORDERED: "Chưa chốt",
  UNANSWERED: "Chờ trả lời",
  MINE: "Của tôi",
  UNASSIGNED: "Chưa ai nhận",
};

/**
 * THẺ LỌC NHANH (INBOX-V2-A, chủ shop 09/10/2026): đầu danh sách chỉ giữ ô tìm + ≤ 5 thẻ việc-cần-làm. Mọi bộ lọc còn lại (thẻ
 * khác của `INBOX_FILTERS`, page, kênh, AI / người, nhân viên, SĐT, level, thời gian, nhãn) nằm trong nút «Lọc ▾» — KHÔNG bộ lọc
 * nào bị bỏ, chỉ đổi chỗ đứng. URL giữ nguyên tham số cũ (`INBOX_URL_PARAMS`) nên link cũ / nút quay lại vẫn đúng.
 */
export const INBOX_QUICK_FILTERS = ["UNREAD", "UNANSWERED", "NEEDS_HUMAN", "MINE"] as const satisfies readonly InboxFilter[];
/**
 * Thẻ của `INBOX_FILTERS` KHÔNG nằm ở hàng nhanh — vào ô «Trạng thái» của «Lọc ▾». «Tất cả» không phải một thẻ: bấm lại thẻ nhanh
 * đang bật là về «Tất cả» (tổng hội thoại in trong ô tìm) — bốn thẻ vừa một hàng ở cột 360 px (số gọn `compactCount`).
 */
export const INBOX_MORE_FILTERS: readonly InboxFilter[] = INBOX_FILTERS.filter((f) => f !== "ALL" && !(INBOX_QUICK_FILTERS as readonly InboxFilter[]).includes(f));

/**
 * MỌI tham số URL của hộp thư — bản khai duy nhất (bài kiểm `tests/inbox-v2-a.test.ts` so với `page.tsx`, để một lượt dọn giao diện
 * không lặng lẽ làm mất một bộ lọc). `quick` = đứng ở hàng đầu; `advanced` = trong «Lọc ▾» (đếm vào huy hiệu «Lọc (n)»);
 * `nav` = không phải bộ lọc (hội thoại đang mở · số dòng đã tải).
 */
export const INBOX_URL_PARAMS = {
  q: { kind: "quick", label: "Tìm tên / SĐT" },
  f: { kind: "quick", label: "Thẻ lọc (hàng nhanh; thẻ khác ở ô «Trạng thái» của «Lọc»)" },
  pg: { kind: "advanced", label: "Page" },
  ch: { kind: "advanced", label: "Kênh" },
  xl: { kind: "advanced", label: "AI / Người xử lý" },
  nv: { kind: "advanced", label: "Nhân viên phụ trách" },
  sdt: { kind: "advanced", label: "Có / chưa SĐT" },
  lv: { kind: "advanced", label: "Level khách" },
  tg: { kind: "advanced", label: "Thời gian tin cuối" },
  tu: { kind: "advanced", label: "Từ ngày" },
  den: { kind: "advanced", label: "Đến ngày" },
  lb: { kind: "advanced", label: "Nhãn" },
  n: { kind: "nav", label: "Số hội thoại đã tải («Xem thêm»)" },
  c: { kind: "nav", label: "Hội thoại đang mở" },
} as const;
export type InboxUrlParam = keyof typeof INBOX_URL_PARAMS;

/** Bộ lọc đang áp (đọc từ URL ở `page.tsx`) — đủ để dựng lại mọi đường dẫn của hộp thư. */
export type InboxFilterState = {
  filter: InboxFilter;
  q: string;
  page: string | null;
  channel: InboxChannel | null;
  handler: InboxHandler | null;
  assignee: string | null;
  phone: "HAS" | "NONE" | null;
  level: CustomerLevel | null;
  period: InboxPeriod | null;
  from: string | null;
  to: string | null;
  label: string | null;
  limit: number;
  selected: string | null;
};

/** Trạng thái lọc ⇒ tham số URL (ĐÚNG tên tham số cũ). `patch` đè từng khoá; `null` = bỏ. HÀM THUẦN. */
export function inboxParams(s: InboxFilterState, patch: Partial<Record<InboxUrlParam, string | null>> = {}): URLSearchParams {
  const cur: Record<InboxUrlParam, string | null> = {
    f: s.filter === "ALL" ? null : s.filter,
    ch: s.channel,
    lb: s.label,
    pg: s.page,
    q: s.q || null,
    sdt: s.phone === "HAS" ? "co" : s.phone === "NONE" ? "khong" : null,
    lv: s.level,
    nv: s.assignee,
    tg: s.period,
    tu: s.from,
    den: s.to,
    n: s.limit > 100 ? String(s.limit) : null,
    xl: s.handler === "AI" ? "ai" : s.handler === "HUMAN" ? "nguoi" : null,
    c: s.selected || null,
    ...patch,
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
  return p;
}
export const INBOX_HREF = "/ai/sales-chatbot/inbox";
export function inboxHref(s: InboxFilterState, patch: Partial<Record<InboxUrlParam, string | null>> = {}): string {
  const q = inboxParams(s, patch).toString();
  return `${INBOX_HREF}${q ? `?${q}` : ""}`;
}

/**
 * Số bộ lọc NÂNG CAO đang bật — huy hiệu «Lọc (n)». Thẻ thuộc hàng nhanh không tính (nó đã hiện ngay trên màn hình); khoảng ngày
 * (`tg` + `tu` / `den`) là MỘT bộ lọc. HÀM THUẦN.
 */
export function inboxAdvancedCount(s: Omit<InboxFilterState, "q" | "limit" | "selected">): number {
  const moreFilter = (INBOX_MORE_FILTERS as readonly string[]).includes(s.filter);
  return [moreFilter, s.page, s.channel, s.handler, s.assignee, s.phone, s.level, s.period || s.from || s.to, s.label].filter(Boolean).length;
}

/**
 * MỘT trạng thái đơn / cần-người trên mỗi hàng (mật độ danh sách): Cần người > Đã chốt > Đơn nháp > không gì. Các huy hiệu khác
 * (page, nguồn, level, SĐT, người nhận, nhãn) chỉ hiện khi rê chuột (title) — chúng vẫn lọc được ở «Lọc ▾». HÀM THUẦN.
 */
export type InboxRowStatus = { kind: "NEEDS_HUMAN" | "CLOSED" | "DRAFT"; label: string } | null;
export function inboxRowStatus(r: Pick<InboxRow, "status" | "closed" | "hasOrder">): InboxRowStatus {
  if (r.status === "HANDOFF") return { kind: "NEEDS_HUMAN", label: "Cần người" };
  if (r.closed) return { kind: "CLOSED", label: "Đã chốt" };
  if (r.hasOrder) return { kind: "DRAFT", label: "Đơn nháp" };
  return null;
}

/**
 * HỘI THOẠI ĐANG MỞ ĐỨNG YÊN (INBOX-V2-A): mở hội thoại = đánh dấu đã đọc, nên ở lượt tải sau nó chuyển sang nhóm «đã đọc» (thứ tự
 * chưa-đọc-trước của máy chủ) hoặc rời hẳn thẻ «Chưa đọc». Hàm này giữ RIÊNG hàng đang mở ở đúng vị trí nó có trong bản danh sách
 * vừa hiện; mọi hàng khác theo đúng thứ tự máy chủ trả (không xếp lại trang). Hàng đã rời bộ lọc thì giữ bản cũ, số chưa đọc về 0.
 * Không có bản trước / hàng không có trong bản trước ⇒ trả nguyên danh sách mới. HÀM THUẦN.
 */
export function keepActiveInPlace(next: readonly InboxRow[], prev: readonly InboxRow[] | null, activeId: string | null): InboxRow[] {
  if (!activeId || !prev) return [...next];
  const prevIdx = prev.findIndex((r) => r.id === activeId);
  if (prevIdx < 0) return [...next];
  const fresh = next.find((r) => r.id === activeId);
  const row: InboxRow = fresh ?? { ...prev[prevIdx], unread: false, unreadCount: 0 };
  const rest = next.filter((r) => r.id !== activeId);
  rest.splice(Math.min(prevIdx, rest.length), 0, row);
  return rest;
}

/**
 * Số trên thẻ lọc nhanh dạng GỌN, kiểu Việt Nam (dấu phẩy thập phân): 0–999 nguyên văn · 1.000–9.999 ⇒ «2,1k» (CẮT, không làm tròn
 * lên — 2.199 in «2,1k» chứ không «2,2k», để số in ra không bao giờ lớn hơn số thật) · 10.000–999.999 ⇒ «21k» · từ 1 triệu ⇒ «1,2tr».
 * Số đủ nằm ở chú thích của thẻ. Âm / không hữu hạn ⇒ «0». HÀM THUẦN.
 */
export function compactCount(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  // Số nguyên suốt (không nhân / chia số thực) để không có lỗi làm tròn dấu phẩy động.
  const cut = (unit: number, suffix: string) => {
    const tenths = Math.floor(v / (unit / 10));
    if (tenths >= 100) return `${Math.floor(tenths / 10)}${suffix}`;
    return `${Math.floor(tenths / 10)}${tenths % 10 ? `,${tenths % 10}` : ""}${suffix}`;
  };
  if (v < 1_000) return String(v);
  if (v < 1_000_000) return cut(1_000, "k");
  return cut(1_000_000, "tr");
}

/** Mốc tin cuối dạng NGẮN cho hàng hội thoại: «vừa xong» · «5 phút» · «3 giờ» · «2 ngày» · «dd/mm» (giờ Việt Nam). HÀM THUẦN. */
export function compactTimeAgo(iso: string | null, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const min = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút`;
  if (min < 24 * 60) return `${Math.round(min / 60)} giờ`;
  if (min < 7 * 24 * 60) return `${Math.round(min / 1440)} ngày`;
  const vn = new Date(t + 7 * 3_600_000).toISOString();
  return `${vn.slice(8, 10)}/${vn.slice(5, 7)}`;
}

/**
 * Bấm ảnh đại diện khách đi đâu — `{ href, external, reason }` (`avatar-profile.ts::avatarLinkOf`, chủ shop 10/10/2026 mục F):
 * link trang Facebook THẬT do nguồn cung cấp / mã công khai đã xác minh ⇒ mở trang Facebook ở tab mới; không có ⇒ hồ sơ khách nội
 * bộ khi đã nối, `reason` nói vì sao không có link Facebook; chưa nối ⇒ ảnh không phải link. PSID / mã luồng / `customers.fb_id` là
 * mã THEO PAGE — không bao giờ thành đường dẫn Facebook (sổ nghĩa `FACEBOOK_ID_SOURCES`). Hôm nay không nguồn nào trả link hồ sơ
 * thật nên `source` để trống ở mọi nơi gọi; nguồn nào trả thì truyền ĐÚNG trường của nguồn đó vào đây. HÀM THUẦN.
 */
export function avatarHrefOf(customerId: string | null | undefined, source: { sourceProfileUrl?: string | null; ids?: readonly FacebookIdInput[] } = {}): AvatarLink {
  return avatarLinkOf({ customerId, ...source });
}

/** Nguồn của hội thoại: Pancake · Meta trực tiếp (Messenger / Instagram) · Zalo OA · chat web. */
export type InboxSource = "PANCAKE" | "DIRECT" | "ZALO" | "WEB";
export const INBOX_SOURCE_LABEL: Record<InboxSource, string> = { PANCAKE: "Pancake", DIRECT: "Direct", ZALO: "Zalo", WEB: "Web" };

/** Số chưa đọc in trên hàng — quá trần in «99+». HÀM THUẦN. */
export function unreadBadge(n: number): string {
  return n > 99 ? "99+" : String(Math.max(0, Math.floor(n)));
}

/** Địa chỉ ảnh đại diện dùng được (https, không mang khoá / token trong URL). Còn lại ⇒ `null` (hiện chữ cái). HÀM THUẦN. */
export function safeAvatarUrl(v: unknown): string | null {
  const url = typeof v === "string" ? v.trim() : "";
  return /^https:\/\/[^\s"'<>]+$/i.test(url) && url.length <= 2000 && !/access_token|[?&](token|key|secret)=/i.test(url) ? url : null;
}

/**
 * Ai đang trả lời khách — lớp PHÂN LOẠI của hộp thư (`inboxHandlingOf`): AI = bot tự trả lời và gửi (`aiHoldOf` = AI_ACTIVE, không ở
 * chế độ AI gợi ý); HUMAN = đang nhường người · Tiếp quản · cần người · AI GỢI Ý (bot soạn, NGƯỜI gửi — của hội thoại hoặc chế độ
 * vận hành của cả tổ chức). Quyết định sản phẩm 07/10/2026: AI gợi ý thuộc nhóm NGƯỜI để nhân viên không bỏ sót khách đang chờ;
 * `aiHoldOf` của đường xử lý KHÔNG đổi (bot vẫn soạn gợi ý). Hai nhóm phủ kín, không giao nhau.
 */
export const INBOX_HANDLERS = ["AI", "HUMAN"] as const;
export type InboxHandler = (typeof INBOX_HANDLERS)[number];
export const INBOX_HANDLER_LABEL: Record<InboxHandler, string> = { AI: "AI đang trả lời", HUMAN: "Người đang xử lý" };

/** Phân loại trên từng hàng: AI · AI gợi ý (người gửi — thuộc nhóm NGƯỜI) · Người. */
export type InboxHandling = "AI" | "COPILOT" | "HUMAN";
export const INBOX_HANDLING_LABEL: Record<InboxHandling, string> = { AI: "AI", COPILOT: "AI gợi ý · người gửi", HUMAN: "Người" };

/**
 * Hộp thư xếp hội thoại vào nhóm nào: AI đang nhường / bị tiếp quản ⇒ HUMAN; AI gợi ý (của hội thoại, hoặc tổ chức đang ở chế độ
 * Copilot) ⇒ COPILOT; còn lại ⇒ AI. HÀM THUẦN — điều kiện SQL của thẻ lọc (`inboxHumanSql`) là bản tương đương, bài kiểm so hai bên.
 */
export function inboxHandlingOf(hold: AiHoldState, state: unknown, orgCopilot: boolean): InboxHandling {
  if (hold !== "AI_ACTIVE") return "HUMAN";
  if (orgCopilot || readConversationControl(state)?.mode === "COPILOT") return "COPILOT";
  return "AI";
}

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
  /** Hồ sơ khách ERP đã nối (`sales_chat_conversations.customer_id`) — ảnh đại diện mở hồ sơ này (`avatarHrefOf`). */
  customerId: string | null;
  preview: string;
  previewSide: TimelineSide | null;
  lastActivityAt: string;
  /** Tin khách CHƯA ai trả lời (bot, nhân viên ERP, hay người ngoài ERP) — mốc tin khách đó; `null` = đã được trả lời. */
  waitingSince: string | null;
  /** Tin khách mới hơn lần cuối một nhân viên mở hội thoại. */
  unread: boolean;
  /** SỐ tin khách chưa đọc (≥ 1 khi `unread`, 0 khi đã đọc). */
  unreadCount: number;
  /** Ảnh đại diện thật (Meta `profile_pic` / Pancake) — `null` ⇒ chữ cái. */
  avatarUrl: string | null;
  /** Trạng thái AI của hội thoại — `aiHoldOf` (đường xử lý). */
  aiHold: AiHoldState;
  /** Nhóm trên hộp thư (`inboxHandlingOf`) — một nguồn với thẻ lọc «AI / Người đang xử lý». */
  handling: InboxHandling;
  /** Đã chốt đơn (đơn ERP thật hoặc level «Đã chốt đơn») — cùng định nghĩa với thẻ «Đã chốt». */
  closed: boolean;
  source: InboxSource;
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

/**
 * `placeGap` = đơn ERP còn sống chưa ghép được tỉnh / xã (không gửi được hãng vận chuyển, không tự xác nhận) — `null` = đủ.
 * `review` = lý do CẦN NGƯỜI KIỂM đang mở (khách báo huỷ · máy chốt khi địa chỉ chưa ghép xã — `lib/constants/order-review.ts`);
 * rỗng = không cờ. `reconfirms` = lời «khách xác nhận lại» ghi SAU lý do «khách huỷ» đang mở (cờ vẫn mở, người quyết).
 * `gaps` = chỗ còn thiếu của đơn tay (`manualOrderGaps`) — còn thiếu thì nút nhanh không chốt, dẫn sang sửa đơn.
 */
export type InboxOrder = { id: string; shortCode: string; stage: string; outcome: string | null; outcomeLabel: string; total: number; insertedAt: string; byBot: boolean; placeGap: string | null; review: OrderReviewEntry[]; reconfirms: OrderReviewResolution[]; gaps: string[] };

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
  /** Ảnh đại diện thật của khách (`safeAvatarUrl`) — `null` ⇒ chữ cái. */
  avatarUrl: string | null;
  /** Số phút AI nhường của workspace (`humanCooldownMinutes()`). */
  cooldownMinutes: number;
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

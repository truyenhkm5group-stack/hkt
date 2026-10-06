/**
 * ═══════════ NHẬP LỊCH SỬ HỘI THOẠI VÀO HỘP THƯ — PHẦN THUẦN (dùng được ở client) ═══════════
 *
 * Phần máy chủ: `lib/sales-chatbot/history.ts`. Tệp này giữ hằng số, kiểu trạng thái lượt nhập (lưu ở `settings`) và câu tiến độ
 * cho màn hình — không đọc CSDL, không gọi mạng.
 */

/** Khoá `settings` giữ trạng thái + CON TRỎ của lượt nhập — mỗi tổ chức một CSDL nên một khoá là một lượt của một tổ chức. */
export const HISTORY_SETTING_KEY = "ai_sales.inbox_history";
/** `sales_chat_inbound.note` của tin KHÁCH nhập từ lịch sử (tin phía page giữ `PAGE_REPLY` để mọi chỗ hiểu «page đã trả lời»). */
export const HISTORY_NOTE = "HISTORY";
/** `sales_chat_conversations.created_by` của hội thoại do LƯỢT NHẬP tạo — số «hội thoại mới» của nền tảng loại chúng ra. */
export const HISTORY_CREATED_BY = "system:history-import";
/** Tên lượt chạy trong `sync_runs`. */
export const HISTORY_SYNC_JOB = "sales-inbox-history";

/**
 * TRẦN TỐC ĐỘ (chủ shop: «không bão request»). Một lượt (một dòng `sync_runs`) chạy tối đa `tickBudgetMs` và `requestsPerTick`
 * lời gọi, cách nhau ít nhất `requestGapMs` (≤ 2,5 lời gọi / giây cho một tổ chức). Pancake trả 429 ⇒ dừng lượt, hẹn lại sau
 * `rateLimitWaitMs` (hoặc `Retry-After` nếu dài hơn). Lỗi mạng / 5xx liền `maxFailures` lượt ⇒ dừng hẳn, báo lỗi.
 * Tin mới hơn `freshMinutes` KHÔNG nhập: đó là việc của webhook / lượt quét lại (`catchUpFanpage` 30 phút) — nhập nó là
 * «ĐÃ XONG» một tin khách mà bot còn phải trả lời.
 */
export const HISTORY_LIMITS = {
  tickBudgetMs: 120_000,
  requestsPerTick: 250,
  requestGapMs: 400,
  rateLimitWaitMs: 60_000,
  transientWaitMs: 30_000,
  maxFailures: 6,
  /** Hỏng liền chừng này HỘI THOẠI (4xx khi đọc tin) ⇒ lỗi hệ thống (token bị thu hồi), không phải một hội thoại lẻ. */
  maxThreadErrorsInRow: 5,
  /** Trang tin tối đa của MỘT hội thoại (Pancake ~25–30 tin / trang). Quá ⇒ cắt, đếm `truncated`. */
  messagePagesPerThread: 200,
  freshMinutes: 60,
  /** Phần quét lại hội thoại ERP: mỗi lô đọc chừng này hội thoại từ CSDL. */
  localBatch: 50,
  /** Lượt RUNNING không có nhịp quá chừng này ⇒ coi như tiến trình đã chết — bấm «Chạy tiếp» được ngay. */
  staleMs: 10 * 60_000,
  phones: 10,
} as const;

export type HistoryStatus = "IDLE" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
export const HISTORY_STATUS_LABEL: Record<HistoryStatus, string> = { IDLE: "Chưa chạy", RUNNING: "Đang chạy", DONE: "Xong", FAILED: "Dừng vì lỗi", CANCELLED: "Đã dừng" };

/**
 * `LIST` = duyệt danh sách hội thoại của Pancake (mới cập nhật → cũ). `LOCAL` = quét lại hội thoại ERP của page chưa được lượt
 * này đọc — danh sách Pancake xếp theo mốc cập nhật nên hội thoại có tin mới GIỮA lúc nhập nhảy lên đầu, sau con trỏ, và trượt
 * khỏi lượt duyệt; webhook đã mở chúng trong ERP nên phần này bắt lại được.
 */
export type HistoryPhase = "LIST" | "LOCAL";

export type HistoryCounts = {
  /** Hội thoại đã đọc xong. */
  conversations: number;
  /** Hội thoại lượt nhập TẠO MỚI trong ERP (khách chưa từng nhắn từ lúc nối page). */
  created: number;
  /** Tin đã ghi (khách + page). */
  messages: number;
  customer: number;
  page: number;
  /** Tin đã có sẵn (webhook đã ghi, lượt trước đã nhập, tiếng vọng của tin bot / nhân viên ERP). */
  duplicates: number;
  /** Tin quá mới — để webhook / lượt quét lại lo. */
  fresh: number;
  /** Tin bỏ qua: đã thu hồi, ghi chú tự động của Pancake, tin phía page không chữ không ảnh. */
  skipped: number;
  /** Hội thoại dài quá `messagePagesPerThread` trang — phần cũ hơn chưa nhập. */
  truncated: number;
  requests: number;
  /** Hội thoại đọc hỏng (bỏ qua, đi tiếp). */
  errors: number;
};

export type PendingThread = { id: string; name: string; phones: string[]; avatarUrl: string | null; updatedAt: string | null };
export type ThreadProgress = { id: string; count: number; pages: number; lastIds: string[]; phones: string[] };

export type HistoryRun = {
  status: HistoryStatus;
  pageId: string | null;
  requestedAt: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastTickAt: string | null;
  phase: HistoryPhase;
  /** `last_conversation_id` của trang danh sách kế tiếp (`null` = trang đầu). */
  listCursor: string | null;
  listDone: boolean;
  /** Hội thoại của trang danh sách hiện tại chưa đọc xong — phần tử đầu là hội thoại đang đọc. */
  pending: PendingThread[];
  /** Tiến độ phân trang tin của `pending[0]` — tiến trình khởi động lại thì đọc tiếp đúng trang đó. */
  thread: ThreadProgress | null;
  /** Mốc cập nhật của hội thoại cũ nhất đã liệt kê — «đã quét tới đâu». */
  oldestReached: string | null;
  localStartedAt: string | null;
  localCursor: { at: string; id: string } | null;
  /** Hội thoại ERP còn phải quét lại (đếm lúc lấy lô). */
  localRemaining: number | null;
  counts: HistoryCounts;
  lastError: string | null;
  /** Đợi tới mốc này mới gọi Pancake tiếp (429 / lỗi mạng). */
  retryAt: string | null;
  failures: number;
  threadErrorsInRow: number;
};

export function emptyHistoryCounts(): HistoryCounts {
  return { conversations: 0, created: 0, messages: 0, customer: 0, page: 0, duplicates: 0, fresh: 0, skipped: 0, truncated: 0, requests: 0, errors: 0 };
}

export function emptyHistoryRun(): HistoryRun {
  return {
    status: "IDLE",
    pageId: null,
    requestedAt: null,
    requestedBy: null,
    startedAt: null,
    finishedAt: null,
    lastTickAt: null,
    phase: "LIST",
    listCursor: null,
    listDone: false,
    pending: [],
    thread: null,
    oldestReached: null,
    localStartedAt: null,
    localCursor: null,
    localRemaining: null,
    counts: emptyHistoryCounts(),
    lastError: null,
    retryAt: null,
    failures: 0,
    threadErrorsInRow: 0,
  };
}

const STATUSES: readonly HistoryStatus[] = ["IDLE", "RUNNING", "DONE", "FAILED", "CANCELLED"];
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Trạng thái đã lưu ⇒ kiểu đủ trường. Dòng hỏng / thiếu ⇒ mặc định, KHÔNG ném (màn hình vẫn mở được). HÀM THUẦN. */
export function parseHistoryRun(raw: unknown): HistoryRun {
  const base = emptyHistoryRun();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const counts = (r.counts && typeof r.counts === "object" ? r.counts : {}) as Record<string, unknown>;
  const th = (r.thread && typeof r.thread === "object" ? r.thread : null) as Record<string, unknown> | null;
  const lc = (r.localCursor && typeof r.localCursor === "object" ? r.localCursor : null) as Record<string, unknown> | null;
  return {
    status: STATUSES.includes(r.status as HistoryStatus) ? (r.status as HistoryStatus) : "IDLE",
    pageId: s(r.pageId),
    requestedAt: s(r.requestedAt),
    requestedBy: s(r.requestedBy),
    startedAt: s(r.startedAt),
    finishedAt: s(r.finishedAt),
    lastTickAt: s(r.lastTickAt),
    phase: r.phase === "LOCAL" ? "LOCAL" : "LIST",
    listCursor: s(r.listCursor),
    listDone: r.listDone === true,
    pending: (Array.isArray(r.pending) ? r.pending : [])
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string")
      .map((p) => ({ id: String(p.id), name: s(p.name) ?? "", phones: strs(p.phones), avatarUrl: s(p.avatarUrl), updatedAt: s(p.updatedAt) })),
    thread: th && typeof th.id === "string" ? { id: th.id, count: n(th.count), pages: n(th.pages), lastIds: strs(th.lastIds), phones: strs(th.phones) } : null,
    oldestReached: s(r.oldestReached),
    localStartedAt: s(r.localStartedAt),
    localCursor: lc && typeof lc.at === "string" && typeof lc.id === "string" ? { at: lc.at, id: lc.id } : null,
    localRemaining: typeof r.localRemaining === "number" ? n(r.localRemaining) : null,
    counts: Object.fromEntries(Object.keys(base.counts).map((k) => [k, n(counts[k])])) as HistoryCounts,
    lastError: s(r.lastError),
    retryAt: s(r.retryAt),
    failures: n(r.failures),
    threadErrorsInRow: n(r.threadErrorsInRow),
  };
}

/** Lượt RUNNING mà quá `staleMs` không có nhịp ⇒ tiến trình đã chết giữa chừng. HÀM THUẦN. */
export function historyRunStale(run: HistoryRun, now: Date): boolean {
  if (run.status !== "RUNNING") return false;
  const at = Date.parse(run.lastTickAt ?? run.startedAt ?? "");
  return !Number.isFinite(at) || now.getTime() - at > HISTORY_LIMITS.staleMs;
}

/** Một dòng «đã làm được gì» cho màn hình. HÀM THUẦN. */
export function historyCountsText(c: HistoryCounts): string {
  const parts = [`${c.conversations.toLocaleString("vi-VN")} hội thoại`, `${c.messages.toLocaleString("vi-VN")} tin mới (khách ${c.customer.toLocaleString("vi-VN")} · page ${c.page.toLocaleString("vi-VN")})`];
  if (c.created) parts.push(`${c.created.toLocaleString("vi-VN")} khách mới vào hộp thư`);
  if (c.duplicates) parts.push(`${c.duplicates.toLocaleString("vi-VN")} tin đã có sẵn`);
  if (c.fresh) parts.push(`${c.fresh.toLocaleString("vi-VN")} tin quá mới (để webhook lo)`);
  if (c.skipped) parts.push(`${c.skipped.toLocaleString("vi-VN")} tin bỏ qua (đã thu hồi / ghi chú tự động)`);
  if (c.truncated) parts.push(`${c.truncated.toLocaleString("vi-VN")} hội thoại quá dài bị cắt`);
  if (c.errors) parts.push(`${c.errors.toLocaleString("vi-VN")} hội thoại đọc hỏng`);
  parts.push(`${c.requests.toLocaleString("vi-VN")} lời gọi Pancake`);
  return parts.join(" · ");
}

/** «Còn bao nhiêu»: Pancake không trả tổng số hội thoại ⇒ nói ĐÃ QUÉT TỚI ĐÂU (mốc cập nhật) và phần quét lại còn mấy. HÀM THUẦN. */
export function historyRemainingText(run: HistoryRun, fmt: (iso: string) => string): string {
  if (run.status === "DONE") return "Đã quét hết danh sách hội thoại của page.";
  if (run.phase === "LOCAL") return `Đã duyệt hết danh sách Pancake · đang quét lại hội thoại ERP chưa đọc${run.localRemaining !== null ? `: còn ${run.localRemaining.toLocaleString("vi-VN")}` : ""}.`;
  const reached = run.oldestReached ? `đã quét tới hội thoại cập nhật lúc ${fmt(run.oldestReached)} (danh sách đi từ mới tới cũ)` : "đang đọc trang danh sách đầu tiên";
  return `Pancake không báo tổng số hội thoại — ${reached}${run.pending.length ? ` · ${run.pending.length} hội thoại của trang này chưa đọc xong` : ""}.`;
}

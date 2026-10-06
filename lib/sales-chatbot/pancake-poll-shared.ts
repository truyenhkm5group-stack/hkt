/**
 * ═══════════ PANCAKE QUA API — KHÔNG CẦN WEBHOOK (docs/messaging-providers.md §4) — HÀM THUẦN ═══════════
 *
 * Webhook của Pancake tốn 2 slot thuê bao. Shop không phải mua thêm slot chỉ để dùng bot: tin mới được ĐỌC qua API công khai
 * của Pancake (danh sách hội thoại theo `updated_at` → tin của hội thoại) ở mỗi lượt job, đi vào ĐÚNG đường nhận của webhook
 * (`receiveFanpageEvent`, khoá chống trùng = mã tin của chính Pancake ⇒ webhook + API cùng một tin chỉ ra MỘT dòng, một câu
 * trả lời). Webhook nếu có chỉ làm tin tới NHANH hơn — đường API luôn chạy.
 *
 *  · MỐC ĐỒNG BỘ (`cursorMs`) lưu theo tổ chức + page, sống qua khởi động lại: lượt sau chỉ đọc hội thoại cập nhật sau mốc
 *    (trừ `overlapMs` chồng lấn), không đọc lại cả 30 phút mỗi lượt. Mốc KHÔNG BAO GIỜ vượt «bây giờ − minAge» (tin quá mới
 *    để webhook lo, lượt sau phải còn thấy) và không vượt hội thoại chưa kịp xử lý vì hết ngân sách ⇒ không bỏ sót.
 *  · NGÂN SÁCH: webhook có tin trong `webhookFreshMs` ⇒ lưới an toàn (ít hội thoại / lượt, như trước); không ⇒ chế độ API.
 *  · LỖI / 429 ⇒ lùi dần có trần; lượt đạt ⇒ xoá bộ đếm. Page yên lâu ⇒ hỏi thưa hơn.
 */

export const PANCAKE_POLL = {
  /** Chồng lấn khi đọc từ mốc — đồng hồ Pancake và ERP lệch nhau, ghi trễ. */
  overlapMs: 2 * 60_000,
  /** Cửa sổ khi chưa có mốc / mốc quá cũ — cũng là tuổi tối đa của tin còn được bot trả lời bù. */
  windowMs: 30 * 60_000,
  /** Tin trẻ hơn mức này để webhook lo (trùng `CATCH_UP_LIMITS.minAgeSeconds`). */
  minAgeMs: 60_000,
  /** Webhook có tin trong 2 giờ qua ⇒ coi là đang chạy. */
  webhookFreshMs: 2 * 3_600_000,
  /** Hội thoại đọc tin mỗi lượt: lưới an toàn (webhook đang chạy) · chế độ API (không webhook). */
  threadsSafetyNet: 5,
  threadsApi: 25,
  /** Lùi khi lỗi: 5 phút × 2^(n−1), trần 60 phút. */
  backoffBaseMs: 5 * 60_000,
  backoffMaxMs: 60 * 60_000,
  /** Page không có hội thoại nào cập nhật trong 6 giờ ⇒ chỉ hỏi mỗi 15 phút. */
  idleAfterMs: 6 * 3_600_000,
  idleEveryMs: 15 * 60_000,
  /** Số hội thoại một lần đọc danh sách — đủ hết mà vẫn đầy ⇒ có thể sót, báo ra. */
  listLimit: 60,
} as const;

export type PancakePollMode = "SAFETY_NET" | "API";

export type PancakePollState = {
  pageId: string | null;
  cursorMs: number | null;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastActivityAt: number | null;
  lastWebhookAt: number | null;
  failures: number;
  nextAllowedAt: number | null;
  lastError: string | null;
  /** Lượt gần nhất đọc đủ `listLimit` hội thoại đều mới hơn mốc ⇒ có thể có hội thoại chưa thấy. */
  truncated: boolean;
};

export const EMPTY_POLL_STATE: PancakePollState = { pageId: null, cursorMs: null, lastRunAt: null, lastOkAt: null, lastActivityAt: null, lastWebhookAt: null, failures: 0, nextAllowedAt: null, lastError: null, truncated: false };

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Đọc trạng thái đã lưu — giá trị lạ bị bỏ; page đổi ⇒ trạng thái của page cũ không dùng cho page mới. HÀM THUẦN. */
export function parsePollState(v: unknown, pageId: string): PancakePollState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (o.pageId !== pageId) return { ...EMPTY_POLL_STATE, pageId };
  return {
    pageId,
    cursorMs: numOrNull(o.cursorMs),
    lastRunAt: numOrNull(o.lastRunAt),
    lastOkAt: numOrNull(o.lastOkAt),
    lastActivityAt: numOrNull(o.lastActivityAt),
    lastWebhookAt: numOrNull(o.lastWebhookAt),
    failures: typeof o.failures === "number" && o.failures > 0 ? Math.min(Math.trunc(o.failures), 50) : 0,
    nextAllowedAt: numOrNull(o.nextAllowedAt),
    lastError: typeof o.lastError === "string" ? o.lastError.slice(0, 300) : null,
    truncated: o.truncated === true,
  };
}

export type PollDecision = { run: false; reason: string } | { run: true; mode: PancakePollMode; threadBudget: number; windowStartMs: number };

/** Lượt này có hỏi Pancake không, ở chế độ nào, đọc từ mốc nào. HÀM THUẦN. */
export function pollDecision(s: PancakePollState, nowMs: number): PollDecision {
  if (s.nextAllowedAt !== null && nowMs < s.nextAllowedAt) return { run: false, reason: `đang lùi sau lỗi (${s.failures} lần) — hỏi lại lúc ${new Date(s.nextAllowedAt).toISOString()}` };
  const idle = s.lastActivityAt === null || nowMs - s.lastActivityAt > PANCAKE_POLL.idleAfterMs;
  if (idle && s.lastOkAt !== null && nowMs - s.lastOkAt < PANCAKE_POLL.idleEveryMs) return { run: false, reason: "page yên lâu — hỏi thưa (15 phút một lần)" };
  const webhookLive = s.lastWebhookAt !== null && nowMs - s.lastWebhookAt < PANCAKE_POLL.webhookFreshMs;
  const floor = nowMs - PANCAKE_POLL.windowMs;
  const windowStartMs = s.cursorMs === null ? floor : Math.max(floor, s.cursorMs - PANCAKE_POLL.overlapMs);
  return { run: true, mode: webhookLive ? "SAFETY_NET" : "API", threadBudget: webhookLive ? PANCAKE_POLL.threadsSafetyNet : PANCAKE_POLL.threadsApi, windowStartMs };
}

export type PollOutcome =
  | { ok: true; listed: number; maxUpdatedMs: number | null; oldestUnprocessedMs: number | null; allNewerThanWindow: boolean }
  | { ok: false; rateLimited: boolean; error: string };

/** Trạng thái sau một lượt. HÀM THUẦN. */
export function afterPoll(s: PancakePollState, out: PollOutcome, nowMs: number): PancakePollState {
  if (!out.ok) {
    const failures = s.failures + 1;
    const wait = Math.min(PANCAKE_POLL.backoffBaseMs * 2 ** (failures - 1), PANCAKE_POLL.backoffMaxMs);
    return { ...s, lastRunAt: nowMs, failures, nextAllowedAt: nowMs + wait, lastError: (out.rateLimited ? "Pancake giới hạn tốc độ (429) — lùi lại. " : "") + out.error.slice(0, 250) };
  }
  // Mốc tiến tới hội thoại mới nhất đã thấy, nhưng không vượt (bây giờ − minAge) và không vượt hội thoại chưa xử lý.
  let cursor = Math.max(s.cursorMs ?? 0, Math.min(out.maxUpdatedMs ?? 0, nowMs - PANCAKE_POLL.minAgeMs));
  if (out.oldestUnprocessedMs !== null) cursor = Math.min(cursor, out.oldestUnprocessedMs - 1);
  const cursorMs = cursor > 0 ? cursor : s.cursorMs;
  return {
    ...s,
    cursorMs,
    lastRunAt: nowMs,
    lastOkAt: nowMs,
    lastActivityAt: Math.max(s.lastActivityAt ?? 0, out.maxUpdatedMs ?? 0) || s.lastActivityAt,
    failures: 0,
    nextAllowedAt: null,
    lastError: null,
    truncated: out.listed >= PANCAKE_POLL.listLimit && out.allNewerThanWindow,
  };
}

/** Webhook vừa có tin ⇒ chỉ GHI khi mốc cũ hơn `everyMs` (không ghi CSDL mỗi gói tin). HÀM THUẦN. */
export function noteWebhook(s: PancakePollState, nowMs: number, everyMs: number = 5 * 60_000): PancakePollState | null {
  if (s.lastWebhookAt !== null && nowMs - s.lastWebhookAt < everyMs) return null;
  return { ...s, lastWebhookAt: nowMs };
}

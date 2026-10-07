import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";

/**
 * ═══════════ AI ĐANG TRẢ LỜI · ĐANG NHƯỜNG NGƯỜI · NGƯỜI TIẾP QUẢN — MỘT HÀM QUYẾT ĐỊNH (sứ mệnh sales-human-takeover) ═══════════
 *
 * Chủ shop 07/10/2026: nhân viên gửi MỘT câu tay ⇒ AI nhường 30 phút (đúng, giữ nguyên), nhưng hộp thư chỉ ghi «AI nhường 30
 * phút» — không biết còn bao lâu, không có cách cho AI chạy lại ngay. Ba trạng thái TƯỜNG MINH, suy ra từ đúng những gì đã lưu:
 *
 *  · AI_ACTIVE       — AI trả lời tin khách kế tiếp (theo chế độ của tổ chức / «AI gợi ý» của hội thoại).
 *  · HUMAN_COOLDOWN  — nhân viên vừa gửi tay (hoặc AI tạm hỏng) ⇒ AI nhường tới `until`, HẾT HẠN TỰ ĐỘNG. Nhân viên gửi thêm
 *                      ⇒ đồng hồ tính lại từ câu mới nhất. «Cho AI tiếp tục ngay» xoá nhường ⇒ AI_ACTIVE.
 *  · HUMAN_TAKEOVER  — người bấm «Tiếp quản» (`state.control.mode = HUMAN`), hoặc hội thoại CẦN NGƯỜI XỬ LÝ (AI / công cụ xin
 *                      người, chat web có nhân viên trả lời) ⇒ AI im KHÔNG THỜI HẠN tới khi người bấm «Trả lại cho AI».
 *
 * HÀM THUẦN, không đọc / ghi CSDL, không đọc đồng hồ (nhận `now`): MỌI đường đọc nó — xử lý tin Pancake / Messenger / Zalo, hộp
 * thư, nút bấm — nên không có hai nơi nói hai điều. Không có cột trạng thái thứ hai để lệch với cột này.
 *
 * ĐỒNG HỒ NHƯỜNG là `human_cooldown_until` (0231), KHÔNG phải `updated_at`: mọi lượt ghi vào hội thoại (mốc tin khách, nhật ký ghi
 * đơn, level khách…) đẩy `updated_at` về «bây giờ», nên đường Pancake — ghi mốc tin khách NGAY TRƯỚC khi hỏi «hết nhường chưa» —
 * đặt đồng hồ về 0 ở mỗi tin khách. Dòng cũ chưa có cột (NULL) đọc `updated_at` như trước — không backfill đoán. AI hỏng vẫn đọc
 * `updated_at` (do engine đặt, đường ấy không đổi trong sứ mệnh này).
 */

/**
 * Nhân viên gửi tay ⇒ AI nhường chừng này phút — MẶC ĐỊNH (ngưỡng cũ; `HUMAN_TAKEOVER_MINUTES` ở fanpage.ts trỏ về đây). Từ sứ mệnh
 * saas-l3-inbox mỗi workspace KHAI được số phút riêng (`HUMAN_COOLDOWN_SETTING_KEY`, đọc qua MỘT hàm `humanCooldownMinutes()` ở
 * conversation-control.ts); chưa khai ⇒ đúng số này. Dòng cũ chưa có mốc tường minh (NULL) và nhánh AI hỏng vẫn đọc số này.
 */
export const HUMAN_COOLDOWN_MINUTES = 30;
export const HUMAN_COOLDOWN_MS = HUMAN_COOLDOWN_MINUTES * 60_000;
/** Ô cài đặt (bảng `settings` của tổ chức) giữ số phút AI tự trả lời lại sau câu tay của nhân viên: `{ "minutes": n }`. */
export const HUMAN_COOLDOWN_SETTING_KEY = "ai.salesChatbot.humanCooldown";
/** Trần / sàn chủ shop khai được: 1 phút — 24 giờ (lâu hơn thì là «Tiếp quản», không phải nhường). */
export const HUMAN_COOLDOWN_MIN_MINUTES = 1;
export const HUMAN_COOLDOWN_MAX_MINUTES = 24 * 60;

/** Số phút đã khai ⇒ số dùng được; thiếu / sai / ngoài trần ⇒ mặc định `HUMAN_COOLDOWN_MINUTES`. HÀM THUẦN. */
export function normalizeCooldownMinutes(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < HUMAN_COOLDOWN_MIN_MINUTES || n > HUMAN_COOLDOWN_MAX_MINUTES) return HUMAN_COOLDOWN_MINUTES;
  return n;
}

/** Lý do «nhân viên đang trả lời» của từng kênh — các tệp kênh trỏ về đây (một nguồn cho chữ mà hàm quyết định so). */
export const FANPAGE_STAFF_REASON = "Nhân viên đang trả lời trên fanpage";
export const ZALO_STAFF_REASON = "Nhân viên đang trả lời trên Zalo OA";
/** AI hỏng ⇒ chuyển người, tự thử lại sau cùng khoảng nhường (engine.ts trỏ về đây). */
export const AI_DOWN_HANDOFF_REASON = "AI tạm không trả lời được — nhân viên liên hệ lại khách";

/** Lý do nhường TỰ HẾT HẠN của nhân viên (mỗi kênh một câu) — hộp thư dựng điều kiện SQL tương đương `aiHoldOf` từ đúng danh sách này. */
export const STAFF_COOLDOWN_REASON_LIST: readonly string[] = [FANPAGE_STAFF_REASON, ZALO_STAFF_REASON];
const STAFF_COOLDOWN_REASONS: ReadonlySet<string> = new Set(STAFF_COOLDOWN_REASON_LIST);

export const AI_HOLD_STATES = ["AI_ACTIVE", "HUMAN_COOLDOWN", "HUMAN_TAKEOVER"] as const;
export type AiHoldState = (typeof AI_HOLD_STATES)[number];

/**
 * Vì sao AI không trả lời: STAFF_REPLY (nhân viên gửi tay) · AI_DOWN (AI hỏng, tự thử lại) · TAKEOVER (người bấm «Tiếp quản») ·
 * NEEDS_HUMAN (AI / công cụ xin người, chat web có nhân viên — chờ người trả lại).
 */
export type AiHoldCause = "STAFF_REPLY" | "AI_DOWN" | "TAKEOVER" | "NEEDS_HUMAN";

export const AI_HOLD_LABEL: Record<AiHoldState, string> = {
  AI_ACTIVE: "AI đang trả lời",
  HUMAN_COOLDOWN: "AI đang nhường người",
  HUMAN_TAKEOVER: "Người tiếp quản — AI im",
};

/**
 * Mã lý do (`reason_code`) của sự kiện `ai.resumed` — tách được ba cách AI quay lại: hết nhường tự động (MÁY, `actor_user_id`
 * NULL), người bấm «Cho AI tiếp tục ngay» trong lúc nhường, người bấm «Trả lại cho AI» sau tiếp quản / cần người.
 */
export const AI_RESUME_REASONS = ["COOLDOWN_EXPIRED", "RESUMED_NOW", "RETURNED"] as const;
export type AiResumeReason = (typeof AI_RESUME_REASONS)[number];

export type AiHoldInput = {
  status: string;
  handoffReason: string | null;
  state: unknown;
  updatedAt: Date;
  humanCooldownUntil: Date | null;
};

export type AiHold = {
  state: AiHoldState;
  cause: AiHoldCause | null;
  /** Mốc AI tự trả lời lại (chỉ HUMAN_COOLDOWN). */
  until: Date | null;
  /**
   * Lần nhường ĐÃ HẾT HẠN mà hội thoại còn mang dấu nhường (`HANDOFF`) — AI_ACTIVE, nhưng đường xử lý tin phải mở lại hội thoại
   * và ghi `ai.resumed` (COOLDOWN_EXPIRED) với mốc này. `null` = không có gì để dọn.
   */
  expired: { cause: "STAFF_REPLY" | "AI_DOWN"; at: Date } | null;
};

/** Mốc hết nhường của lần nhường đang lưu — `null` = hội thoại không ở lý do tự hết hạn. HÀM THUẦN. */
function cooldownOf(conv: AiHoldInput): { cause: "STAFF_REPLY" | "AI_DOWN"; until: Date } | null {
  if (conv.status !== "HANDOFF" || !conv.handoffReason) return null;
  if (STAFF_COOLDOWN_REASONS.has(conv.handoffReason)) return { cause: "STAFF_REPLY", until: new Date((conv.humanCooldownUntil ?? new Date(conv.updatedAt.getTime() + HUMAN_COOLDOWN_MS)).getTime()) };
  if (conv.handoffReason === AI_DOWN_HANDOFF_REASON) return { cause: "AI_DOWN", until: new Date(conv.updatedAt.getTime() + HUMAN_COOLDOWN_MS) };
  return null;
}

/**
 * Trạng thái AI của MỘT hội thoại tại `now`. Thứ tự: «Tiếp quản» thắng mọi thứ (nhân viên gửi tay khi đang tiếp quản KHÔNG biến
 * về nhường 30 phút) → không ở `HANDOFF` ⇒ AI → lý do tự hết hạn ⇒ nhường tới `until` (quá hạn ⇒ AI, kèm `expired`) → lý do khác
 * ⇒ chờ người trả lại. HÀM THUẦN.
 */
export function aiHoldOf(conv: AiHoldInput, now: Date): AiHold {
  if (readConversationControl(conv.state)?.mode === "HUMAN") return { state: "HUMAN_TAKEOVER", cause: "TAKEOVER", until: null, expired: null };
  if (conv.status !== "HANDOFF") return { state: "AI_ACTIVE", cause: null, until: null, expired: null };
  const cd = cooldownOf(conv);
  if (!cd) return { state: "HUMAN_TAKEOVER", cause: "NEEDS_HUMAN", until: null, expired: null };
  if (now.getTime() < cd.until.getTime()) return { state: "HUMAN_COOLDOWN", cause: cd.cause, until: cd.until, expired: null };
  return { state: "AI_ACTIVE", cause: null, until: null, expired: { cause: cd.cause, at: cd.until } };
}

/** Mốc hết nhường cho một câu nhân viên gửi lúc `at`, với số phút của workspace (mặc định ngưỡng cũ). HÀM THUẦN. */
export function cooldownUntilFrom(at: Date, minutes: number = HUMAN_COOLDOWN_MINUTES): Date {
  return new Date(at.getTime() + normalizeCooldownMinutes(minutes) * 60_000);
}

/**
 * Mã lý do của `ai.resumed` khi NGƯỜI bấm cho AI quay lại — đọc từ trạng thái NGAY TRƯỚC khi bấm. `null` = AI đang trả lời rồi
 * (không có gì để ghi). HÀM THUẦN.
 */
export function humanResumeReason(before: AiHold): AiResumeReason | null {
  if (before.state === "HUMAN_COOLDOWN") return "RESUMED_NOW";
  if (before.state === "HUMAN_TAKEOVER") return "RETURNED";
  return null;
}

/**
 * Ảnh chụp cho màn hình. `serverNow` đi kèm để trình duyệt đếm ngược theo ĐỒNG HỒ MÁY CHỦ: lệch = `serverNow` − giờ trình duyệt
 * lúc nhận; còn lại = `until` − (giờ trình duyệt + lệch). Máy nhân viên chạy nhanh / chậm vài phút không làm sai đồng hồ.
 */
export type AiHoldView = {
  state: AiHoldState;
  cause: AiHoldCause | null;
  until: string | null;
  serverNow: string;
};

export function aiHoldView(conv: AiHoldInput, now: Date): AiHoldView {
  const h = aiHoldOf(conv, now);
  return { state: h.state, cause: h.cause, until: h.until ? h.until.toISOString() : null, serverNow: now.toISOString() };
}

/** Số mili giây còn nhường theo đồng hồ máy chủ (`skewMs` = giờ máy chủ − giờ trình duyệt). Không âm. HÀM THUẦN. */
export function cooldownRemainingMs(until: string | null, browserNowMs: number, skewMs: number): number {
  if (!until) return 0;
  const end = new Date(until).getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, end - (browserNowMs + skewMs));
}

/** «mm:ss» (dưới một giờ) cho đồng hồ đếm ngược. HÀM THUẦN. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** «HH:mm» giờ Việt Nam của mốc hết nhường (AGENTS.md mục 1 — hiển thị theo giờ VN). `null` ⇒ «—». HÀM THUẦN. */
export function cooldownClock(until: string | null): string {
  if (!until) return "—";
  const d = new Date(until);
  if (!Number.isFinite(d.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

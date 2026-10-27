/**
 * ═══ CẦU CHÌ KÊNH API TRA CỨU VIETTEL POST (vtp-direct-sync (A), 26/10/2026) ═══
 *
 * Đo production 26/10/2026 (sync_runs VIETTELPOST · tracking_poll — db-query 40351505272 · 40351692719):
 *  · API tra cứu trả HTTP 403 kèm TRANG HTML (máy chủ bị chặn kiểu WAF, không phải JSON lỗi nghiệp vụ) từ 23/09/2026 20:00Z, gần như
 *    mọi lượt từ 26/09;
 *  · job tracking_poll (CRON, 6 lượt / giờ) cập nhật **0 vận đơn mỗi ngày từ 20/09** — kể cả những ngày còn chưa bị chặn (API vốn
 *    mù với vận đơn của shop, đo 21/09) — mà sinh **~3.000–5.000 lượt hỏi lỗi / ngày**;
 *  · mỗi lượt lỗi ghi `vtp_last_error` lên từng kiện ⇒ 2.594 kiện mang câu lỗi này, và hàng đợi đối chiếu xếp 1.797 / 1.802 dòng ở
 *    hạng SYNC_ERROR — chôn mọi lý do khác.
 * Kênh bị chặn là PHÁN QUYẾT CỦA KÊNH, không phải lỗi của từng kiện hàng (cùng lớp với CAPABILITY_SCOPE_ERROR). Nên:
 *  · gặp «403 + thân HTML» ⇒ MỞ cầu chì, KHÔNG ghi lỗi lên kiện, dừng lượt;
 *  · cầu chì mở ⇒ không hỏi từng kiện; cứ `BREAKER_RETRY_HOURS` thử MỘT kiện;
 *  · chỉ ĐÓNG khi lượt thử trả bản ghi vận đơn THẬT (JSON có dữ liệu) — HTTP 200 rỗng / «không thấy» chưa phải kênh sống;
 *  · câu lỗi cũ trên kiện KHÔNG bị xoá: hàng đợi lọc LÚC ĐỌC bằng `isChannelBlockMessage` / `CHANNEL_BLOCK_MESSAGE_SQL` (một luật,
 *    hai bản, bài kiểm so trên cùng chuỗi).
 * Webhook là nguồn tin chính (2.138 / 2.151 vận đơn WEBHOOK_ONLY) — mất kênh này không mất trạng thái nào.
 */

export const VTP_API_BREAKER_KEY = "viettelpost:api-breaker";
/** Lần đầu ERP thấy «403 + trang HTML» (sync_runs tracking_poll, đo 26/10/2026) — băng rôn dùng khi cầu chì chưa từng mở mà kiện còn lỗi cũ. */
export const CHANNEL_BLOCK_FIRST_SEEN = "2026-09-23T20:00:27Z";

/** Cầu chì mở ⇒ thử lại một kiện sau chừng này giờ (lead duyệt 26/10/2026). */
export const BREAKER_RETRY_HOURS = 6;

export type VtpApiBreakerState = {
  /** Mốc mở cầu chì (lần đầu gặp «403 + HTML» của đợt chặn này). `null` = kênh đang dùng được. */
  openSince: string | null;
  /** Lượt thử gần nhất khi cầu chì mở. */
  lastProbeAt: string | null;
  /** Kết quả lượt thử gần nhất. */
  lastProbeResult: "BLOCKED" | "JSON_EMPTY" | "RECORD" | "OTHER_ERROR" | null;
};

export const BREAKER_CLOSED: VtpApiBreakerState = { openSince: null, lastProbeAt: null, lastProbeResult: null };

/** Lỗi này có phải kênh bị chặn không: HTTP 403 VÀ thân phản hồi là trang HTML. HÀM THUẦN. */
export function isChannelBlockError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const status = (e as { status?: unknown }).status;
  const body = (e as { body?: unknown }).body;
  return status === 403 && typeof body === "string" && /^\s*<(?:!doctype|html)/i.test(body);
}

/** Câu lỗi ĐÃ GHI trên kiện (`vtp_last_error`) có phải của kênh bị chặn không. HÀM THUẦN. */
export function isChannelBlockMessage(msg: string | null | undefined): boolean {
  return /^ViettelPost: HTTP 403\s*<(?:!doctype|html)/i.test(String(msg ?? ""));
}

/** Bản SQL của `isChannelBlockMessage` trên một cột chữ. */
export function channelBlockMessageSql(col: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(col)) throw new Error("channelBlockMessageSql: tên cột không hợp lệ");
  return `(coalesce(${col}, '') ~* '^ViettelPost: HTTP 403\\s*<(!doctype|html)')`;
}

export type BreakerDecision = "RUN" | "PROBE_ONE" | "SKIP";

/** Lượt định kỳ này làm gì. HÀM THUẦN. */
export function breakerDecision(state: VtpApiBreakerState | null, now: Date): BreakerDecision {
  if (!state?.openSince) return "RUN";
  const moc = Date.parse(state.lastProbeAt ?? state.openSince);
  if (!Number.isFinite(moc)) return "PROBE_ONE";
  return now.getTime() - moc >= BREAKER_RETRY_HOURS * 3_600_000 ? "PROBE_ONE" : "SKIP";
}

/** Trạng thái sau một lượt (thử hoặc chạy thường). HÀM THUẦN. */
export function nextBreakerState(prev: VtpApiBreakerState | null, outcome: { blocked: boolean; gotRecord: boolean; probed: boolean; otherError?: boolean }, now: Date): VtpApiBreakerState {
  const p = prev ?? BREAKER_CLOSED;
  const at = now.toISOString();
  if (outcome.blocked) return { openSince: p.openSince ?? at, lastProbeAt: at, lastProbeResult: "BLOCKED" };
  if (outcome.gotRecord) return BREAKER_CLOSED;
  if (!p.openSince) return p;
  // Cầu chì đang mở mà lượt thử KHÔNG cho bản ghi thật ⇒ vẫn mở (HTTP 200 rỗng chưa phải kênh sống).
  return outcome.probed ? { ...p, lastProbeAt: at, lastProbeResult: outcome.otherError ? "OTHER_ERROR" : "JSON_EMPTY" } : p;
}

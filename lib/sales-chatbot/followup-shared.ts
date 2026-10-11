/**
 * ═══════════ FOLLOW-UP TỰ ĐỘNG — PHẦN THUẦN (0185) ═══════════
 *
 * Chủ shop 01/10/2026: khách đang ở BẤT KỲ bước nào của quy trình bán (đang tư vấn rồi mất hút · đã cho SĐT nhưng chưa
 * chốt · từ chối upsell rồi chưa xác nhận) mà im lặng ⇒ hội thoại `WAITING`; AI nhắn follow-up theo lịch, DỪNG khi khách
 * nhắn lại / chốt đơn / từ chối rõ ràng / cần người xử lý. Lịch mặc định 1 giờ · 6 giờ · 22 giờ tính từ lúc bắt đầu im lặng.
 *
 * Facebook chỉ cho page nhắn trong 24 GIỜ kể từ tin cuối của khách (ngoài khung là vi phạm chính sách nhắn tin) ⇒ không
 * mốc nào quá 23 giờ, và mỗi lượt gửi kiểm lại khung (`withinMessagingWindow`). Tệp này không đọc CSDL — client import được.
 */
import type { LifecycleSnapshot } from "@/lib/sales-chatbot/lifecycle";

export const FOLLOWUP_SETTING_KEY = "ai.salesChatbot.followup";

/** Khung nhắn của Facebook là 24 giờ; chừa nửa giờ cho trễ hàng đợi / lệch đồng hồ. */
export const MESSAGING_WINDOW_MS = 23.5 * 3_600_000;
export const FOLLOWUP_MAX_STEPS = 3;
/** Mốc muộn nhất (phút) — phải nằm trong khung 24 giờ. */
export const FOLLOWUP_MAX_MINUTES = 23 * 60;

export type FollowupSettings = { enabled: boolean; stepsMinutes: number[] };
export const DEFAULT_FOLLOWUP_SETTINGS: FollowupSettings = { enabled: true, stepsMinutes: [60, 360, 1320] };

/** Lịch hợp lệ: 1–3 mốc, nguyên dương, TĂNG DẦN, không mốc nào quá 23 giờ. Sai ⇒ lỗi tiếng Việt (không sửa hộ). */
export function validateFollowupSteps(raw: unknown): { ok: true; steps: number[] } | { ok: false; error: string } {
  const arr = Array.isArray(raw) ? raw : [];
  const steps = arr.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (steps.length === 0 || steps.length > FOLLOWUP_MAX_STEPS || steps.length !== arr.length) return { ok: false, error: `Lịch follow-up có 1–${FOLLOWUP_MAX_STEPS} mốc (phút).` };
  if (steps.some((s) => !Number.isInteger(s) || s < 5)) return { ok: false, error: "Mỗi mốc là số phút nguyên, ít nhất 5 phút." };
  if (steps.some((s, i) => i > 0 && s <= steps[i - 1])) return { ok: false, error: "Các mốc phải tăng dần." };
  if (steps[steps.length - 1] > FOLLOWUP_MAX_MINUTES) return { ok: false, error: "Facebook chỉ cho nhắn trong 24 giờ kể từ tin cuối của khách — mốc muộn nhất 23 giờ (1380 phút)." };
  return { ok: true, steps };
}

export function parseFollowupSettings(v: unknown): FollowupSettings {
  const o = (v && typeof v === "object" ? v : {}) as { enabled?: unknown; stepsMinutes?: unknown };
  const steps = validateFollowupSteps(o.stepsMinutes);
  return { enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_FOLLOWUP_SETTINGS.enabled, stepsMinutes: steps.ok ? steps.steps : [...DEFAULT_FOLLOWUP_SETTINGS.stepsMinutes] };
}

/** Mốc follow-up KẾ TIẾP sau khi đã gửi `sent` lần — `null` khi hết lịch. HÀM THUẦN. */
export function nextFollowupAt(waitingSince: Date, sent: number, steps: readonly number[]): Date | null {
  const m = steps[sent];
  return m === undefined ? null : new Date(waitingSince.getTime() + m * 60_000);
}

/** Còn trong khung 24 giờ của Facebook (tính từ tin cuối của khách)? Không biết tin cuối ⇒ KHÔNG gửi. HÀM THUẦN. */
export function withinMessagingWindow(lastCustomerAt: Date | null, at: Date): boolean {
  return lastCustomerAt !== null && at.getTime() - lastCustomerAt.getTime() < MESSAGING_WINDOW_MS;
}

/** Nhãn cho màn hình: «1 giờ · 6 giờ · 22 giờ». */
export function followupStepsLabel(steps: readonly number[]): string {
  return steps.map((m) => (m % 60 === 0 ? `${m / 60} giờ` : m > 60 ? `${Math.floor(m / 60)} giờ ${m % 60} phút` : `${m} phút`)).join(" · ");
}

// ═══════════ CỔNG TRƯỚC KHI GỬI (P0 11/10/2026 · mission `followup-lifecycle`) ═══════════
//
// Ca KimThu Le: đơn đã «Đã xác nhận» mà job vẫn nhắn «em xác nhận để gửi đi luôn nhé ạ?» — vì cổng cũ chỉ đọc sổ của bot
// (`state.confirmed`). Cổng mới đọc ẢNH CHỤP VÒNG ĐỜI (`lifecycle.ts` — đơn thật, chứng từ thu, ORDER_OUTCOME) cộng các dấu
// vết của hội thoại, hai lần: TRƯỚC lời gọi AI (khỏi tốn token) và NGAY TRƯỚC KHI GỬI trên dữ liệu đọc LẠI (khách / người /
// nguồn gửi khác có thể đã lên tiếng trong lúc AI soạn). Thứ tự kiểm là luật: điều kiện đầu tiên khớp thắng.

/**
 * Lỗi gửi mà gửi lại cũng không bao giờ được: Pancake không còn hội thoại («conversation_id not found»), khách không nhận tin
 * từ page nữa («Người này hiện không có mặt» — chặn page / khoá tài khoản), Meta từ chối vĩnh viễn (mã 551 / 10 / 200). HÀM THUẦN.
 */
export function followupSendPermanent(error: string): boolean {
  return /conversation_id not found|không có mặt|not available right now|\(#?551\)|\(#?10\)|\(#?200\)|blocked|đã chặn/i.test(error);
}

/** Phiên bản lời nhắc follow-up — vết ghi số này cạnh dấu băm lời nhắc. Đổi `followupSystemPrompt` ⇒ tăng số. */
export const FOLLOWUP_PROMPT_VERSION = "fu2";
/** Phiên bản định nghĩa VẾT quyết định (luật 40). */
export const FOLLOWUP_TRACE_VERSION = 1;
/**
 * Tin BOT_SENT (tiếng vọng mọi tin bot ERP gửi qua fanpage) ghi SAU mốc `last_bot_at` của lượt, vì lượt AI mất vài giây tới
 * hàng chục giây — tin nằm trong chừng này sau mốc vẫn là của chính lượt ấy; muộn hơn là một NGUỒN GỬI KHÁC đã nhắn.
 */
export const BOT_ECHO_GRACE_MS = 10 * 60_000;
/** Hai lần gửi CÙNG một kịch bản cho cùng hội thoại cách nhau ít hơn chừng này ⇒ lần sau là trùng. */
export const FOLLOWUP_SAME_SCRIPT_WINDOW_MS = 30 * 60_000;

/** Kịch bản follow-up. KHÔNG có kịch bản CSKH sau mua — đơn đã có ⇒ CHẶN kèm lý do, không bịa kịch bản mới. */
export const FOLLOWUP_SCRIPTS = ["CONFIRM_REMINDER", "SALES_NUDGE"] as const;
export type FollowupScript = (typeof FOLLOWUP_SCRIPTS)[number];

/** Nháp CỦA BOT chờ khách xác nhận ⇒ nhắc xác nhận; còn lại ⇒ nhắc tư vấn. HÀM THUẦN. */
export function followupScriptOf(lc: Pick<LifecycleSnapshot, "order">): FollowupScript {
  return lc.order === "CREATION_PENDING" ? "CONFIRM_REMINDER" : "SALES_NUDGE";
}

export const FOLLOWUP_REASONS = [
  "NO_ADDRESS",
  "PAGE_NOT_LIVE",
  "STAFF_REPLIED",
  "CUSTOMER_REPLIED",
  "OPTED_OUT",
  "ORDER_CANCELLED",
  "ORDER_RETURNED",
  "PAYMENT_RECORDED",
  "ORDER_EXISTS",
  "LIFECYCLE_UNKNOWN",
  "CUSTOMER_DECLINED",
  "HUMAN_TAKEOVER",
  "STAFF_COOLDOWN",
  "NOT_WAITING",
  "ANOTHER_SENDER",
  "DUPLICATE_SCRIPT",
  "OUTSIDE_MESSAGING_WINDOW",
  "AI_TEXT_REJECTED",
  "CLAIM_BLOCKED",
  "DUPLICATE",
  "AI_UNAVAILABLE",
  "SEND_FAILED",
  "OK",
] as const;
export type FollowupReason = (typeof FOLLOWUP_REASONS)[number];

/** Câu cho người đọc (chi tiết lượt job · vết). Vài câu giữ nguyên chữ cũ — màn hình / bài kiểm đã đọc chúng. */
export const FOLLOWUP_REASON_LABEL: Record<FollowupReason, string> = {
  NO_ADDRESS: "thiếu địa chỉ fanpage",
  PAGE_NOT_LIVE: "page chưa LIVE cho bot Chốt Đơn (workspace nhà)",
  STAFF_REPLIED: "nhân viên / page đã nhắn sau bot",
  CUSTOMER_REPLIED: "khách đã nhắn lại sau tin cuối của bot — huỷ lượt nhắc",
  OPTED_OUT: "khách đã nói không muốn nhận tin",
  ORDER_CANCELLED: "đơn đã huỷ — lịch nhắc cũ vô hiệu",
  ORDER_RETURNED: "đơn đã hoàn — lịch nhắc cũ vô hiệu",
  PAYMENT_RECORDED: "đã có chứng từ thu — không nhắc chốt đơn",
  ORDER_EXISTS: "đã chốt đơn / đã có đơn ERP — không gửi kịch bản chốt đơn (chưa có kịch bản CSKH sau mua)",
  LIFECYCLE_UNKNOWN: "không đọc được đơn của hội thoại — không nhắc (phía hẹp)",
  CUSTOMER_DECLINED: "khách từ chối rõ",
  HUMAN_TAKEOVER: "cần người xử lý",
  STAFF_COOLDOWN: "đang trong cửa sổ nhường người — người vừa trả lời",
  NOT_WAITING: "hội thoại không còn chờ khách",
  ANOTHER_SENDER: "một nguồn gửi khác của ERP đã nhắn sau tin cuối của bot",
  DUPLICATE_SCRIPT: "cùng kịch bản vừa gửi trong cửa sổ chống trùng",
  OUTSIDE_MESSAGING_WINDOW: "ngoài khung 24 giờ của Facebook",
  AI_TEXT_REJECTED: "AI không viết được / AI nêu giá",
  CLAIM_BLOCKED: "câu nhắc khẳng định điều chưa xác minh — claim-guard chặn",
  DUPLICATE: "lượt nhắc này đã được một lượt khác quyết định — không gửi lần hai",
  AI_UNAVAILABLE: "AI tạm không dùng được — hoãn",
  SEND_FAILED: "lỗi gửi",
  OK: "gửi",
};

/** Ảnh chụp các cột hội thoại cổng cần — chụp lúc GIÀNH lượt và đọc LẠI ngay trước khi gửi. */
export type FollowupConvSnap = {
  status: string;
  lastBotAt: Date | null;
  lastCustomerAt: Date | null;
  lastStaffAt: Date | null;
  waitingSince: Date | null;
  humanCooldownUntil: Date | null;
};

export type FollowupGateInput = {
  now: Date;
  hasAddress: boolean;
  /** Ảnh chụp lúc giành lượt (dòng job đọc ra). */
  claimed: FollowupConvSnap;
  /** Ảnh chụp đọc LẠI (bằng `claimed` ở lượt kiểm trước AI). */
  fresh: FollowupConvSnap;
  lifecycle: LifecycleSnapshot;
  /** Có tin phía page KHÔNG phải của bot (nhân viên / tự động Pancake) sau tin cuối của bot. */
  pageReplyAfter: boolean;
  /** Có tin KHÁCH sau tin cuối của bot (kể cả tin chưa kịp đổi trạng thái hội thoại). */
  customerInboundAfter: boolean;
  /** Có tiếng vọng BOT_SENT sau `last_bot_at + BOT_ECHO_GRACE_MS` — nguồn gửi khác của ERP đã nhắn. */
  otherBotSendAfter: boolean;
  /** Cùng kịch bản đã gửi trong `FOLLOWUP_SAME_SCRIPT_WINDOW_MS` và sau tin cuối của khách. */
  sameScriptRecently: boolean;
};

export type FollowupGateDecision = { send: true; reason: "OK" } | { send: false; reason: FollowupReason };

const later = (a: Date | null, b: Date | null) => a !== null && (b === null || a.getTime() > b.getTime());
const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Có gửi lượt nhắc này không. HÀM THUẦN — thứ tự kiểm là luật (điều kiện đầu tiên khớp thắng):
 *  1. địa chỉ fanpage;
 *  2. người lên tiếng sau bot (tin phía page; nhân viên gõ trong hộp thư sau tin cuối của bot / sau lúc giành);
 *  3. khách nhắn lại sau tin cuối của bot (mốc tin khách đổi, hoặc có dòng tin khách mới) ⇒ HUỶ lượt;
 *  4. khách từ chối nhận tin;
 *  5. đơn huỷ / hoàn ⇒ lịch cũ vô hiệu; có chứng từ thu; đơn đã tạo / xác nhận / đang giao / đã giao ⇒ không kịch bản chốt;
 *  6. không đọc được đơn ⇒ không gửi (phía hẹp);
 *  7. khách từ chối mua; hội thoại về tay người (HANDOFF · state.handoff · HUMAN / COPILOT) — đọc trên ảnh chụp MỚI;
 *  8. cửa sổ nhường người còn hiệu lực;
 *  9. hội thoại không còn WAITING;
 * 10. khung 24 giờ của Facebook (tính trên mốc tin khách MỚI);
 * 11. nguồn gửi khác của ERP đã nhắn (mốc tin bot / đợt im lặng đổi sau lúc giành, hoặc tiếng vọng bot muộn); cùng kịch bản đã gửi
 *     trong cửa sổ chống trùng VÀ sau tin cuối của khách (khách nhắn lại là một đợt im lặng mới).
 */
export function decideFollowup(g: FollowupGateInput): FollowupGateDecision {
  const no = (reason: FollowupReason): FollowupGateDecision => ({ send: false, reason });
  const lc = g.lifecycle;
  if (!g.hasAddress) return no("NO_ADDRESS");
  if (g.pageReplyAfter || later(g.fresh.lastStaffAt, g.claimed.lastStaffAt) || later(g.fresh.lastStaffAt, g.claimed.lastBotAt ?? g.claimed.waitingSince)) return no("STAFF_REPLIED");
  if (g.customerInboundAfter || later(g.fresh.lastCustomerAt, g.claimed.lastCustomerAt)) return no("CUSTOMER_REPLIED");
  if (lc.contact === "OPTED_OUT") return no("OPTED_OUT");
  if (lc.order === "CANCELLED") return no("ORDER_CANCELLED");
  if (lc.order === "RETURNED") return no("ORDER_RETURNED");
  if (lc.payment === "PAID" || lc.payment === "PENDING") return no("PAYMENT_RECORDED");
  if (lc.order === "CREATED" || lc.order === "CONFIRMED" || lc.fulfillment === "SHIPPING" || lc.fulfillment === "DELIVERED") return no("ORDER_EXISTS");
  if (lc.order === "UNKNOWN") return no("LIFECYCLE_UNKNOWN");
  if (lc.salesStage === "CUSTOMER_DECLINED") return no("CUSTOMER_DECLINED");
  if (lc.contact === "HUMAN_TAKEOVER") return no("HUMAN_TAKEOVER");
  if (g.fresh.humanCooldownUntil && g.fresh.humanCooldownUntil.getTime() > g.now.getTime()) return no("STAFF_COOLDOWN");
  if (g.fresh.status !== "WAITING") return no("NOT_WAITING");
  if (!withinMessagingWindow(g.fresh.lastCustomerAt, g.now)) return no("OUTSIDE_MESSAGING_WINDOW");
  if (g.otherBotSendAfter || !sameTime(g.fresh.lastBotAt, g.claimed.lastBotAt) || !sameTime(g.fresh.waitingSince, g.claimed.waitingSince)) return no("ANOTHER_SENDER");
  if (g.sameScriptRecently) return no("DUPLICATE_SCRIPT");
  return { send: true, reason: "OK" };
}

/** Khoá chống trùng của MỘT lượt nhắc (đợt im lặng · lần nhắc) — phần riêng của `dedupe_key` sự kiện `followup.decided`. */
export function followupSlotKey(waitingSince: Date | null, attempt: number): string {
  return `followup-decided:${waitingSince?.toISOString() ?? "?"}:${attempt}`;
}

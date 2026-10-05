import type { ReplyGate } from "@/lib/sales-chatbot/operating-mode-shared";

/**
 * ═══════════ AI HAY NGƯỜI — CHẾ ĐỘ CỦA TỪNG HỘI THOẠI (docs/pancake-replacement-gap-analysis.md · slice 1) ═══════════
 *
 * Chế độ vận hành của TỔ CHỨC (`operating-mode-shared.ts`) nói bot làm gì với MỌI hội thoại. Hộp thư cần thêm một tay nắm
 * trên MỘT hội thoại: khách khó / khách sỉ / khiếu nại thì nhân viên TIẾP QUẢN và bot im cho tới khi chính người bấm «Trả lại
 * AI» — không tự hết hạn sau 30 phút như khi nhân viên chỉ trả lời một câu.
 *
 *  · AUTO    — không có ghi đè: hội thoại theo chế độ của tổ chức (mặc định).
 *  · COPILOT — bot chỉ SOẠN gợi ý ở hội thoại bóng, không gửi; nhân viên gửi.
 *  · HUMAN   — bot không gọi AI, không gửi gì.
 *
 * Ghi đè CHỈ THU HẸP: tổ chức đang Quan sát thì một hội thoại không tự bật được Tự động (`applyConversationControl`).
 * Lưu ở `sales_chat_conversations.state.control` (ảnh chụp người bấm — `users.id` + tên máy chủ đọc, luật 34); không có
 * bản ghi ⇒ AUTO. Đổi chế độ là MỘT lượt ghi có điều kiện trên ảnh chụp cũ (hai người bấm cùng lúc ⇒ một người thắng).
 */

export const CONVERSATION_CONTROLS = ["AUTO", "COPILOT", "HUMAN"] as const;
export type ConversationControl = (typeof CONVERSATION_CONTROLS)[number];

export const CONVERSATION_CONTROL_LABEL: Record<ConversationControl, string> = {
  AUTO: "AI tự trả lời",
  COPILOT: "AI gợi ý — người gửi",
  HUMAN: "Người xử lý — AI im",
};

/** Lý do chuyển người khi nhân viên bấm TIẾP QUẢN — KHÔNG thuộc nhóm tự hết hạn 30 phút (khác `STAFF_REASON`). */
export const TAKEOVER_REASON = "Nhân viên tiếp quản hội thoại";
/** Ghi chú trên dòng tin bot bỏ qua vì hội thoại đang ở chế độ người / copilot. */
export const CONTROL_HUMAN_NOTE = "Người đang xử lý hội thoại — bot không trả lời";
export const CONTROL_COPILOT_NOTE = "Hội thoại ở chế độ AI gợi ý — bot soạn, không gửi";
/** Ghi chú khi bot đã soạn xong mà người vừa trả lời / tiếp quản — câu đã soạn KHÔNG gửi. */
export const BOT_YIELDED_NOTE = "Người vừa trả lời hoặc tiếp quản trong lúc bot soạn — bot không gửi câu đã soạn";

export const CONTROL_REASON_MAX = 200;

export type ControlStamp = {
  mode: Exclude<ConversationControl, "AUTO">;
  byUserId: string | null;
  byName: string;
  at: string;
  reason: string | null;
};

/** Ảnh chụp chế độ của hội thoại từ `state` — dữ liệu hỏng / lạ ⇒ `null` (= AUTO). HÀM THUẦN. */
export function readConversationControl(state: unknown): ControlStamp | null {
  const raw = state && typeof state === "object" ? (state as Record<string, unknown>).control : null;
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.mode !== "HUMAN" && v.mode !== "COPILOT") return null;
  return {
    mode: v.mode,
    byUserId: typeof v.byUserId === "string" ? v.byUserId : null,
    byName: typeof v.byName === "string" ? v.byName : "",
    at: typeof v.at === "string" ? v.at : "",
    reason: typeof v.reason === "string" ? v.reason : null,
  };
}

export function controlOf(state: unknown): ConversationControl {
  return readConversationControl(state)?.mode ?? "AUTO";
}

/**
 * Áp chế độ hội thoại lên cổng của tổ chức. CHỈ THU HẸP: HUMAN ⇒ Quan sát; COPILOT ⇒ Copilot nếu tổ chức đang cho bot trả
 * lời (đang Quan sát thì giữ Quan sát). Nhánh thử nghiệm giữ nguyên để báo cáo thử nghiệm không lệch. HÀM THUẦN.
 */
export function applyConversationControl(gate: ReplyGate, control: ConversationControl): ReplyGate {
  if (control === "HUMAN") return { ...gate, mode: "OBSERVE" };
  if (control === "COPILOT" && gate.mode === "AUTOPILOT") return { ...gate, mode: "COPILOT" };
  return gate;
}

/** Ghi chú cho dòng tin khi chế độ HỘI THOẠI (không phải tổ chức) làm bot không gửi; `null` = không do hội thoại. */
export function controlSkipNote(control: ConversationControl): string | null {
  return control === "HUMAN" ? CONTROL_HUMAN_NOTE : control === "COPILOT" ? CONTROL_COPILOT_NOTE : null;
}

/** Ảnh chụp hội thoại đọc lại ngay TRƯỚC khi bot gửi. */
export type SendSnapshot = { status: string; state: unknown; lastStaffAt: Date | null };

/**
 * Bot có được GỬI câu vừa soạn không? So ảnh chụp lúc BẮT ĐẦU lượt với ảnh chụp đọc lại ngay trước khi gửi. Lượt AI mất vài
 * giây; trong lúc đó nhân viên có thể gửi tin từ hộp thư (`last_staff_at` tăng), tiếp quản (chế độ HUMAN / COPILOT), hoặc trả
 * lời ngoài ERP và tiếng vọng đã chuyển hội thoại sang người (`HANDOFF`). Bất kỳ điều nào ⇒ KHÔNG gửi: khách nhận câu của
 * người, không nhận thêm câu của bot đè lên. So bằng giá trị đã lưu, không bằng đồng hồ — hai máy lệch giờ không đổi kết luận.
 * HÀM THUẦN.
 */
export function botSendVerdict(before: SendSnapshot, now: SendSnapshot): { ok: true } | { ok: false; reason: string } {
  if (now.status === "HANDOFF") return { ok: false, reason: BOT_YIELDED_NOTE };
  const control = controlOf(now.state);
  if (control !== "AUTO") return { ok: false, reason: BOT_YIELDED_NOTE };
  const was = before.lastStaffAt?.getTime() ?? null;
  const is = now.lastStaffAt?.getTime() ?? null;
  if (is !== null && (was === null || is > was)) return { ok: false, reason: BOT_YIELDED_NOTE };
  return { ok: true };
}

/** Lý do người nhập khi đổi chế độ: cắt khoảng trắng, rỗng ⇒ `null`, tối đa `CONTROL_REASON_MAX` ký tự. */
export function normalizeControlReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim().slice(0, CONTROL_REASON_MAX);
  return s || null;
}

import { AI_HOLD_LABEL, cooldownClock, HUMAN_COOLDOWN_MINUTES, type AiHoldView } from "@/lib/sales-chatbot/ai-hold-shared";

/**
 * ═══════════ AI CÓ THẬT SỰ TRẢ LỜI KHÁCH NÀY KHÔNG — PHẦN THUẦN, DÙNG ĐƯỢC Ở CLIENT (sứ mệnh sales-human-takeover) ═══════════
 *
 * Sự cố 07/10/2026 (Page Messenger trực tiếp của nhà): thanh hội thoại ghi «AI đang tự trả lời khách này» trong khi MỌI tin khách
 * bị bỏ — cổng page của nhà đang OFF (page-runtime.ts), phía sau còn bot tắt và không nguồn AI nào chạy được. Màn hình đọc chế độ
 * của HỘI THOẠI mà không hỏi những cổng đường xử lý thật sự đi qua.
 *
 * Luật: thêm trạng thái AI_BLOCKED kèm LÝ DO máy đọc được. Lý do do máy chủ tính bằng CHÍNH các hàm / cổng của đường xử lý
 * (`ai-status.ts::conversationAiBlocks` — không viết luật thứ hai); tệp này chỉ gộp lý do với trạng thái nhường người
 * (`aiHoldOf`) và dựng câu hiển thị. KHÔNG BAO GIỜ in «AI đang trả lời» khi còn một lý do chặn.
 *
 * Thứ tự mã = thứ tự đường xử lý đi qua (cổng page → chế độ vận hành → AI theo page → module → công tắc bot → công tắc người
 * vận hành → hạn mức → nguồn AI → chứng cứ lượt gọi gần nhất), nên lý do ĐẦU là lý do khách đang gặp.
 */
export const AI_BLOCK_CODES = ["PAGE_OFF", "PAGE_SHADOW", "ORG_OBSERVE", "PAGE_AI_OFF", "ORG_COPILOT", "MODULE_OFF", "BOT_DISABLED", "KILL_SWITCH", "QUOTA", "NO_AI_SOURCE", "AI_PROVIDER_ERROR"] as const;
export type AiBlockCode = (typeof AI_BLOCK_CODES)[number];

export type AiBlock = { code: AiBlockCode; reason: string; fixHref: string | null; fixLabel: string | null };

/** Chỗ sửa của từng lý do — đường dẫn tới đúng khối trên màn hình (neo `id` ở /ai/sales-chatbot). `null` = không phải việc của shop. */
export const AI_BLOCK_FIX: Record<AiBlockCode, { href: string; label: string } | null> = {
  PAGE_OFF: { href: "/ai/sales-chatbot#page-runtime", label: "Bật page cho bot Chốt Đơn" },
  PAGE_SHADOW: { href: "/ai/sales-chatbot#page-runtime", label: "Đổi chế độ page" },
  ORG_OBSERVE: { href: "/ai/sales-chatbot#operating-mode", label: "Chế độ vận hành" },
  PAGE_AI_OFF: { href: "/ai/sales-chatbot/messenger", label: "Bật AI cho page" },
  ORG_COPILOT: { href: "/ai/sales-chatbot#operating-mode", label: "Chế độ vận hành" },
  MODULE_OFF: { href: "/settings/modules", label: "Bật module AI bán hàng" },
  BOT_DISABLED: { href: "/ai/sales-chatbot#bot-config", label: "Bật bot trong Cấu hình" },
  KILL_SWITCH: null,
  QUOTA: { href: "/ai/sales-chatbot#bot-config", label: "Khoá AI / gói dịch vụ" },
  NO_AI_SOURCE: { href: "/ai/sales-chatbot#bot-config", label: "Cấu hình nguồn AI" },
  AI_PROVIDER_ERROR: { href: "/ai/sales-chatbot#bot-config", label: "Kiểm tra khoá AI" },
};

export function aiBlock(code: AiBlockCode, reason: string): AiBlock {
  const fix = AI_BLOCK_FIX[code];
  return { code, reason, fixHref: fix?.href ?? null, fixLabel: fix?.label ?? null };
}

/** Trạng thái hiển thị: nhường / tiếp quản giữ nguyên (người đang cầm); AI_ACTIVE mà còn lý do chặn ⇒ AI_BLOCKED. HÀM THUẦN. */
export const AI_DISPLAY_STATES = ["AI_ACTIVE", "AI_BLOCKED", "HUMAN_COOLDOWN", "HUMAN_TAKEOVER"] as const;
export type AiDisplayState = (typeof AI_DISPLAY_STATES)[number];

export function displayAiState(hold: Pick<AiHoldView, "state">, blocks: readonly AiBlock[]): AiDisplayState {
  if (hold.state !== "AI_ACTIVE") return hold.state;
  return blocks.length ? "AI_BLOCKED" : "AI_ACTIVE";
}

export type ControlStatusInput = {
  hold: AiHoldView;
  blocks: readonly AiBlock[];
  mode: "AUTO" | "COPILOT" | "HUMAN";
  handoffReason: string | null;
  control: { byName?: string; at?: string; reason?: string | null } | null;
  /** Đồng hồ đếm ngược đã về 0 (chỉ client biết). */
  lapsed: boolean;
  /** Định dạng mốc «dd/mm/yyyy HH:mm» (client truyền `formatDateTime`). */
  formatAt: (iso: string) => string;
  /** Số phút AI nhường của workspace (`humanCooldownMinutes()`); thiếu ⇒ mặc định. */
  cooldownMinutes?: number;
};

/**
 * Câu chính của thanh AI ↔ người + câu phụ (lý do chặn còn lại). Một hàm cho mọi màn hình — bài kiểm gọi chính hàm này nên
 * «UI bỏ qua cổng page» là đỏ. HÀM THUẦN.
 */
export function controlBarStatus(i: ControlStatusInput): { state: AiDisplayState; text: string; note: string | null } {
  const state = displayAiState(i.hold, i.blocks);
  const blockLine = i.blocks.length ? i.blocks.map((b) => b.reason).join(" · ") : null;
  if (state === "HUMAN_TAKEOVER") {
    const text =
      i.hold.cause === "TAKEOVER"
        ? `${AI_HOLD_LABEL.HUMAN_TAKEOVER} cho tới khi trả lại${i.control?.byName ? ` · ${i.control.byName}` : ""}${i.control?.at ? ` · ${i.formatAt(i.control.at)}` : ""}${i.control?.reason ? ` · «${i.control.reason}»` : ""}`
        : `Cần người xử lý — ${i.handoffReason ?? "AI đã chuyển người"}. AI im cho tới khi trả lại.`;
    return { state, text, note: blockLine ? `Kể cả khi trả lại, AI vẫn chưa trả lời được: ${blockLine}` : null };
  }
  if (state === "HUMAN_COOLDOWN") {
    const text = i.lapsed
      ? blockLine
        ? `Hết nhường — nhưng AI KHÔNG trả lời được: ${blockLine}`
        : "Hết nhường — AI trả lời từ tin khách kế tiếp."
      : `${AI_HOLD_LABEL.HUMAN_COOLDOWN}${i.hold.cause === "AI_DOWN" ? " (AI tạm hỏng, tự thử lại)" : " — nhân viên vừa gửi tay"} · tự trả lời lại lúc ${cooldownClock(i.hold.until)}`;
    return { state, text, note: blockLine && !i.lapsed ? `Hết nhường AI vẫn chưa trả lời được: ${blockLine}` : null };
  }
  if (state === "AI_BLOCKED") return { state, text: `AI KHÔNG trả lời khách này — ${i.blocks[0].reason}`, note: i.blocks.length > 1 ? `Còn: ${i.blocks.slice(1).map((b) => b.reason).join(" · ")}` : null };
  if (i.mode === "COPILOT") return { state, text: "AI chỉ soạn gợi ý, không gửi — bạn gửi khách.", note: null };
  return { state, text: `${AI_HOLD_LABEL.AI_ACTIVE}. Bạn gửi tin thì AI nhường ${i.cooldownMinutes ?? HUMAN_COOLDOWN_MINUTES} phút; bấm «Tiếp quản» để AI im hẳn.`, note: null };
}

// ─────────────────────────── Dấu vết từng tin khách ───────────────────────────

export const TRACE_STAGES = ["RECEIVED", "ELIGIBLE", "QUEUED", "COMPOSING", "COMPOSED", "SENDING", "SENT"] as const;
export type TraceStage = (typeof TRACE_STAGES)[number];

export const TRACE_STAGE_LABEL: Record<TraceStage, string> = {
  RECEIVED: "Đã nhận",
  ELIGIBLE: "Đủ điều kiện AI",
  QUEUED: "Xếp hàng",
  COMPOSING: "Đang soạn",
  COMPOSED: "Đã soạn",
  SENDING: "Đang gửi",
  SENT: "Đã gửi",
};

/** DONE · FAILED (dừng ở đây, kèm mã) · CURRENT (đang ở bước này) · NOT_REACHED · NOT_MEASURED (không có dữ liệu để nói — «chưa đo»). */
export type TraceStepState = "DONE" | "FAILED" | "CURRENT" | "NOT_REACHED" | "NOT_MEASURED";

export type TraceStep = {
  stage: TraceStage;
  state: TraceStepState;
  /** Mốc của bước — `null` = không có mốc đã lưu cho bước này («chưa đo»), KHÔNG phải «không xảy ra». */
  at: string | null;
  /** Cột / bảng sinh ra kết luận của bước. */
  source: string;
};

export type MessageTrace = {
  steps: TraceStep[];
  /** Mã dừng / cảnh báo (vd AI_SKIPPED_PAGE_OFF); ghi chú lạ ⇒ «UNKNOWN: <ghi chú>». `null` = đi trọn tới «Đã gửi» không cảnh báo. */
  code: string | null;
  /** Ghi chú / lỗi gốc đã lưu — để người đọc tự đối chiếu. */
  detail: string | null;
  outcome: "SENT" | "STOPPED" | "IN_PROGRESS" | "UNKNOWN";
};

/** Nhãn tiếng Việt của mã dấu vết (mã lạ ⇒ hiện nguyên mã). */
export const TRACE_CODE_LABEL: Record<string, string> = {
  AI_SKIPPED_PAGE_OFF: "Page chưa bật cho bot Chốt Đơn",
  AI_SKIPPED_PAGE_SHADOW: "Page chạy bóng — soạn để so, không gửi",
  AI_SKIPPED_DISABLED: "Bot đang tắt",
  AI_SKIPPED_MODULE_OFF: "Module AI bán hàng chưa bật",
  AI_SKIPPED_HUMAN_COOLDOWN: "Đang nhường người (30 phút)",
  AI_SKIPPED_HUMAN_TAKEOVER: "Người tiếp quản",
  AI_SKIPPED_NEEDS_HUMAN: "Cần người xử lý",
  AI_SKIPPED_AI_DOWN_COOLDOWN: "AI tạm hỏng — chờ thử lại",
  AI_SKIPPED_PAGE_ANSWERED: "Page / nhân viên đã trả lời",
  AI_SKIPPED_ALREADY_REPLIED: "Đã trả lời ở lượt trước",
  AI_SKIPPED_COPILOT: "AI gợi ý — không gửi",
  AI_SKIPPED_ORG_OBSERVE: "Chế độ quan sát",
  AI_SKIPPED_EXPERIMENT_HUMAN_ARM: "Thử nghiệm: nhánh người",
  AI_SKIPPED_PAGE_AI_OFF: "AI tắt cho page",
  AI_SKIPPED_OUTSIDE_WINDOW: "Ngoài khung gửi của kênh",
  AI_SKIPPED_MEDIA_ONLY: "Tin không có chữ — để người xem",
  AI_SKIPPED_KILL_SWITCH: "AI bị người vận hành tắt",
  HISTORY_IMPORTED: "Tin nhập từ lịch sử",
  AI_QUEUE_BUSY: "Hội thoại đang được trả lời — chờ lượt",
  AI_QUEUE_RETRY: "Chờ thử lại",
  AI_QUEUE_FAILED: "Hết lượt thử — bot không trả lời",
  AI_PROVIDER_AUTH_ERROR: "Khoá AI bị từ chối",
  AI_PROVIDER_QUOTA: "Hết hạn mức / credit AI",
  AI_PROVIDER_NOT_CONFIGURED: "Chưa có nguồn AI",
  AI_MODEL_ERROR: "Lỗi model / nhà cung cấp AI",
  AI_CONTEXT_ERROR: "Lỗi ngữ cảnh hội thoại",
  AI_HANDED_OFF: "AI chuyển người — không nhắn",
  AI_EMPTY_RESPONSE: "AI không có câu trả lời",
  AI_YIELDED_TO_HUMAN: "Người trả lời trong lúc AI soạn — không gửi",
  AI_SEND_BLOCKED_PAGE_NOT_LIVE: "Chốt gửi: page chưa LIVE",
  MESSENGER_SEND_FAILED: "Gửi Messenger hỏng",
  PANCAKE_SEND_FAILED: "Gửi qua Pancake hỏng",
  ZALO_SEND_FAILED: "Gửi Zalo hỏng",
  SENT_WITH_WARNING: "Đã gửi, có cảnh báo",
};

export function traceCodeLabel(code: string): string {
  return TRACE_CODE_LABEL[code] ?? code;
}

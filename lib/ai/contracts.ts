import type { AiUsage } from "@/lib/ai/provider";

/**
 * ═══════════ HỢP ĐỒNG KIỂU CỦA AI COPILOT — ĐÃ CHỐT ═══════════
 *
 * UI (Claude Opus) chỉ dùng các kiểu ở đây. Muốn thêm trường thì THÊM (optional), không đổi tên,
 * không đổi nghĩa. Mọi giá trị đi qua Server Action là JSON thuần (ngày giờ = chuỗi ISO).
 *
 * Luồng chuẩn:
 *   1. `askCopilot(CopilotRequest)` → `CopilotResult`: câu trả lời + các hành động GHI mà AI đề nghị
 *      (`pendingActions`). Không hành động ghi nào đã chạy ở bước này.
 *   2. Người bấm xác nhận → `confirmCopilotActions({ interactionId, tokens })` → `CopilotConfirmResult`.
 *      Mỗi token là mã băm (người · tool · input) — sửa input là token vô hiệu.
 */

/** Bối cảnh màn hình đang mở, để AI biết "case này" là case nào. */
export type CopilotContext = {
  /** Đường dẫn đang mở, ví dụ `/shipments`. */
  route: string;
  /** `shipment` · `order` · `customer` · `` (không có đối tượng). */
  entityType: "shipment" | "order" | "customer" | "";
  entityId: string;
};

export type CopilotHistoryTurn = { role: "user" | "assistant"; text: string };

export type CopilotRequest = {
  message: string;
  context: CopilotContext;
  /** Các lượt trước trong cùng cuộc trò chuyện (chỉ văn bản; tool call không lặp lại). Tối đa 12 lượt. */
  history?: CopilotHistoryTurn[];
};

export type CopilotToolKind = "read" | "write";

/** Một lần AI gọi tool — để UI hiện "AI đã tra gì" và để audit. */
export type CopilotToolCall = {
  name: string;
  label: string;
  kind: CopilotToolKind;
  input: unknown;
  /** Tool đọc: đã chạy. Tool ghi: chỉ chạy sau khi người xác nhận. */
  executed: boolean;
  ok: boolean;
  /** Một câu tóm tắt kết quả (không phải toàn bộ dữ liệu). */
  summary: string;
  latencyMs: number;
};

/** Hành động ghi AI đề nghị — CHƯA chạy. */
export type CopilotPendingAction = {
  token: string;
  name: string;
  label: string;
  /** Mô tả bằng lời để người đọc trước khi bấm, ví dụ "Giao kiện VTP123 cho Linh". */
  summary: string;
  input: unknown;
  /** Nhóm rủi ro — UI tô màu / đòi xác nhận mạnh hơn. */
  riskClass: CopilotRiskClass;
};

export type CopilotRiskClass = "general" | "care" | "carrier" | "finance" | "inventory" | "destructive";

export type CopilotStatus = "OK" | "NEEDS_CONFIRMATION" | "REFUSED" | "ERROR" | "DISABLED";

export type CopilotResult = {
  interactionId: string | null;
  status: CopilotStatus;
  /** Câu trả lời cuối bằng tiếng Việt (markdown nhẹ). */
  answer: string;
  toolCalls: CopilotToolCall[];
  pendingActions: CopilotPendingAction[];
  /** Cảnh báo dữ liệu (cũ / thiếu quyền / tool lỗi) — UI hiện riêng, không trộn vào câu trả lời. */
  warnings: string[];
  usage: AiUsage;
  costUsd: number;
  latencyMs: number;
  rounds: number;
  model: string;
  error?: string;
};

export type CopilotExecutedAction = {
  token: string;
  name: string;
  label: string;
  ok: boolean;
  /** Kết quả trả về của tool (đã rút gọn) hoặc thông báo lỗi. */
  summary: string;
  at: string;
};

export type CopilotConfirmResult = { ok: true; data: { interactionId: string; executed: CopilotExecutedAction[] } } | { error: string };

/** Mô tả tool để UI liệt kê "AI làm được gì ở đây". */
export type CopilotToolInfo = { name: string; label: string; kind: CopilotToolKind; riskClass: CopilotRiskClass; description: string; allowed: boolean; reason: string };

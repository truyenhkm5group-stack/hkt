/**
 * Kiểu dùng chung của workflow (Phase 3) — client-safe. Hợp đồng: docs/platform/phase-3-contracts.md mục 2.
 * Tập trigger / điều kiện / hành động là tập ĐÓNG: không eval, không SQL do người khai, không HTTP tới địa chỉ tuỳ ý,
 * không đổi trạng thái HỆ THỐNG (đơn, vận đơn, COD, kho).
 *
 * NGOẠI LỆ CÓ CHỦ ĐÍCH (0180, chủ nền tảng yêu cầu «báo nhóm vận hành» qua bộ máy luật): `send_message` gửi MỘT tin tới
 * nhóm chat của CHÍNH tổ chức qua kết nối nhắn tin ĐANG BẬT của nó (Lark / Telegram / hộp thử) — đích là địa chỉ đã
 * khai + kiểm ở /settings/connections, không phải URL người khai luật gõ (lib/messaging/providers.ts).
 */
import type { FieldRef, ListFilterOp } from "@/lib/metadata/types";

/**
 * `event.objectKey` (Phase 6): chỉ cho sự kiện trên BẢN GHI metadata (`custom_record.*`, `custom_status.changed` —
 * subject `custom_record`) — luật chỉ nghe sự kiện của ĐÚNG đối tượng đó, và điều kiện / `set_custom_value` trỏ được
 * vào field của nó (vd "Hợp đồng tạo mới ⇒ giá trị > 20 triệu").
 */
export type WorkflowTrigger =
  | { kind: "event"; event: string; objectKey?: string }
  | { kind: "custom_status"; objectKey: string; fieldKey: string; to: string[]; from?: string[] };

export type WorkflowCondition = { all: WorkflowCondition[] } | { any: WorkflowCondition[] } | { field: FieldRef; op: ListFilterOp; value?: unknown };

export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export type WorkflowAction =
  | { kind: "create_task"; title: string; summary?: string; departmentCode?: string; priority?: TaskPriority; dueInHours?: number }
  | { kind: "notify"; message: string }
  | { kind: "set_custom_value"; field: string; value: unknown }
  /** Gửi MỘT tin tới nhóm chat qua kết nối nhắn tin của tổ chức. `template` điền `{{khoá}}` từ bản ghi / sự kiện. */
  | { kind: "send_message"; connectorKey: string; destination?: string; template: string };

export type WorkflowGate = { kind: "approval"; reason: string } | null;

export const WORKFLOW_RULE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type WorkflowRuleStatus = (typeof WORKFLOW_RULE_STATUSES)[number];
export const WORKFLOW_MODES = ["DRY_RUN", "LIVE"] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];
export const WORKFLOW_RUN_STATUSES = ["DRY_RUN", "PENDING", "WAITING_APPROVAL", "DONE", "SKIPPED", "FAILED", "REJECTED"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export type WorkflowRule = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: WorkflowRuleStatus;
  mode: WorkflowMode;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition | null;
  actions: WorkflowAction[];
  gate: WorkflowGate;
  version: number;
};

/** Một bước trong lượt chạy — cũng là thứ chạy thử trả về ("SẼ làm gì"). */
export type WorkflowStep = { action: WorkflowAction["kind"]; status: "PLANNED" | "DONE" | "FAILED" | "SKIPPED"; detail: string; ref?: string };

/** Một bước "SẼ làm" của chạy thử (`previewRule`) — cùng hình với bước của lượt chạy, luôn `PLANNED`. */
export type WorkflowStepPreview = WorkflowStep;

export type WorkflowRunRow = {
  id: string;
  ruleId: string;
  ruleVersion: number;
  mode: WorkflowMode;
  triggerKind: WorkflowTrigger["kind"];
  triggerRef: string;
  subjectType: string | null;
  subjectId: string | null;
  status: WorkflowRunStatus;
  steps: WorkflowStep[];
  causationDepth: number;
  approvalRequestId: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** Số lần một tiến trình đã chiếm lượt chạy (0 = chưa ai chiếm). */
  attempt: number;
  /** Hạn giữ của tiến trình đang thực thi — `null` khi lượt không ở giữa lúc thực thi. */
  leaseUntil: Date | null;
  lastHeartbeatAt: Date | null;
};

/** Độ sâu nhân quả tối đa — vượt ⇒ lượt chạy FAILED "vòng lặp" (W7). */
export const WORKFLOW_MAX_CAUSATION_DEPTH = 3;

/**
 * Hạn giữ của một tiến trình đang thực thi lượt chạy (phút). Mỗi bước xong gia hạn lại. Ba hành động của tập đóng
 * đều xong trong vài giây, nên 5 phút là thừa cho lượt khoẻ mà vẫn ngắn hơn nhịp 10 phút của job chở bộ máy — một
 * tiến trình chết được chiếm lại ngay lượt kế tiếp.
 */
export const WORKFLOW_LEASE_MINUTES = 5;
/** Số lần chiếm tối đa. Lượt thứ `MAX + 1` không chạy nữa ⇒ FAILED "treo quá số lần thử". */
export const WORKFLOW_MAX_ATTEMPTS = 3;
/** Câu lỗi của lượt dừng VÌ TREO bắt đầu bằng chữ này — `listStaleRuns` nhận ra chúng theo nó. */
export const WORKFLOW_STUCK_ERROR_PREFIX = "Treo";

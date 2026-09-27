/**
 * Kiểu dùng chung của workflow (Phase 3) — client-safe. Hợp đồng: docs/platform/phase-3-contracts.md mục 2.
 * Tập trigger / điều kiện / hành động là tập ĐÓNG: không eval, không SQL do người khai, không HTTP ra ngoài,
 * không đổi trạng thái HỆ THỐNG (đơn, vận đơn, COD, kho).
 */
import type { FieldRef, ListFilterOp } from "@/lib/metadata/types";

export type WorkflowTrigger =
  | { kind: "event"; event: string }
  | { kind: "custom_status"; objectKey: string; fieldKey: string; to: string[]; from?: string[] };

export type WorkflowCondition = { all: WorkflowCondition[] } | { any: WorkflowCondition[] } | { field: FieldRef; op: ListFilterOp; value?: unknown };

export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export type WorkflowAction =
  | { kind: "create_task"; title: string; summary?: string; departmentCode?: string; priority?: TaskPriority; dueInHours?: number }
  | { kind: "notify"; message: string }
  | { kind: "set_custom_value"; field: string; value: unknown };

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
};

/** Độ sâu nhân quả tối đa — vượt ⇒ lượt chạy FAILED "vòng lặp" (W7). */
export const WORKFLOW_MAX_CAUSATION_DEPTH = 3;

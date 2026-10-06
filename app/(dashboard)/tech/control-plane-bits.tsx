import {
  CANONICAL_TASK_STATE_LABEL,
  MISSION_EXECUTION_LABEL,
  TECH_GOAL_STATUS_LABEL,
  TECH_GOAL_STATUS_TONE,
  TECH_MISSION_STATUS_LABEL,
  TECH_MISSION_STATUS_TONE,
  type CanonicalTaskState,
  type MissionExecution,
  type MissionExecutionState,
  type TechGoalStatus,
  type TechMissionStatus,
} from "@/lib/constants/tech-control-plane";
import { cn } from "@/lib/utils";

/**
 * Nhãn + thanh tiến độ của Goal / Mission. KHÔNG có `"use client"` — chỉ đọc hằng số, nên cả Server
 * Component lẫn component phía trình duyệt import được (cùng luật với `badges.tsx`).
 */
const base = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

export function GoalStatusBadge({ status }: { status: TechGoalStatus }) {
  return <span className={cn(base, TECH_GOAL_STATUS_TONE[status])}>{TECH_GOAL_STATUS_LABEL[status] ?? status}</span>;
}

export function MissionStatusBadge({ status }: { status: TechMissionStatus }) {
  return <span className={cn(base, TECH_MISSION_STATUS_TONE[status])}>{TECH_MISSION_STATUS_LABEL[status] ?? status}</span>;
}

const EXEC_TONE: Record<MissionExecutionState, string> = {
  EMPTY: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  NEEDS_OWNER: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  BLOCKED: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  RUNNING: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  READY: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  BACKLOG: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  COMPLETE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  ALL_CANCELLED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

export function ExecutionBadge({ state }: { state: MissionExecutionState }) {
  return <span className={cn(base, EXEC_TONE[state])}>{MISSION_EXECUTION_LABEL[state]}</span>;
}

const CANON_TONE: Partial<Record<CanonicalTaskState, string>> = {
  NEEDS_OWNER: EXEC_TONE.NEEDS_OWNER,
  FAILED: EXEC_TONE.FAILED,
  BLOCKED: EXEC_TONE.BLOCKED,
  DONE: EXEC_TONE.COMPLETE,
  READY: EXEC_TONE.READY,
  CANCELLED: "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-400",
};

export function CanonicalBadge({ state }: { state: CanonicalTaskState }) {
  return <span className={cn(base, CANON_TONE[state] ?? EXEC_TONE.RUNNING)}>{CANONICAL_TASK_STATE_LABEL[state]}</span>;
}

/**
 * Tiến độ: `null` = CHƯA BIẾT (chưa có việc nào tính được) ⇒ in "—", KHÔNG vẽ thanh 0% (AGENTS.md mục 42).
 * Kèm đếm thô để người đọc thấy mẫu số.
 */
export function ExecutionProgress({ execution }: { execution: MissionExecution }) {
  const pct = execution.progressPct;
  const counted = execution.total - execution.byState.CANCELLED;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {execution.done}/{counted} việc xong
          {execution.byState.CANCELLED ? ` · ${execution.byState.CANCELLED} huỷ` : ""}
        </span>
        <span className="font-semibold text-foreground">{pct === null ? "—" : `${pct}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        {pct === null ? null : <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}

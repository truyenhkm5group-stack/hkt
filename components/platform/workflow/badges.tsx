import { MODE_LABEL, MODE_TONE, RULE_STATUS_LABEL, RULE_STATUS_TONE } from "@/lib/platform-ui/workflow-admin-shared";
import type { WorkflowMode, WorkflowRuleStatus } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/** Trạng thái luật (Nháp / Đang bật / Tạm dừng / Đã lưu trữ) — dùng ở danh sách và trang luật. */
export function RuleStatusBadge({ status }: { status: WorkflowRuleStatus }) {
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium", RULE_STATUS_TONE[status])}>{RULE_STATUS_LABEL[status]}</span>;
}

/** Chế độ luật: CHẠY THỬ (không làm thật) hay CHẠY THẬT — hai màu khác hẳn nhau để không đọc nhầm. */
export function RuleModeBadge({ mode }: { mode: WorkflowMode }) {
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium", MODE_TONE[mode])}>{MODE_LABEL[mode]}</span>;
}

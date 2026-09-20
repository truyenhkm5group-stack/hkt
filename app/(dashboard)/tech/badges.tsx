import {
  TECH_APPROVAL_LABEL,
  TECH_DEPLOY_PROVIDER_LABEL,
  TECH_VERIFICATION_LABEL,
  TECH_VERIFICATION_TONE,
  TECH_APPROVAL_TONE,
  TECH_DEPLOY_STATUS_LABEL,
  TECH_DEPLOY_STATUS_TONE,
  TECH_GATE_RESULT_LABEL,
  TECH_GATE_RESULT_TONE,
  TECH_INCIDENT_SEVERITY_LABEL,
  TECH_INCIDENT_SEVERITY_TONE,
  TECH_INCIDENT_STATUS_LABEL,
  TECH_INCIDENT_STATUS_TONE,
  TECH_CI_STATE_LABEL,
  TECH_CI_STATE_TONE,
  TECH_MERGE_STATE_LABEL,
  TECH_MERGE_STATE_TONE,
  TECH_PR_STATE_LABEL,
  TECH_PR_STATE_TONE,
  TECH_REVIEW_STATE_LABEL,
  TECH_REVIEW_STATE_TONE,
  TECH_PRIORITY_LABEL,
  TECH_PRIORITY_TONE,
  TECH_RISK_LABEL,
  TECH_RISK_TONE,
  TECH_TASK_STATUS_LABEL,
  TECH_TASK_STATUS_TONE,
  type TechApprovalStatus,
  type TechDeployStatus,
  type TechGateResult,
  type TechIncidentSeverity,
  type TechIncidentStatus,
  type TechCiState,
  type TechMergeState,
  type TechPrState,
  type TechPriority,
  type TechReviewState,
  type TechRisk,
  type TechDeployProvider,
  type TechTaskStatus,
  type TechVerification,
} from "@/lib/constants/tech";
import { cn } from "@/lib/utils";

/**
 * Nhãn của Phòng Tech AI. KHÔNG có `"use client"`: tệp này chỉ đọc hằng số nên cả Server Component
 * lẫn cột bảng (`"use client"`) đều import được — đúng luật `tests/client-boundary-exports.test.ts`
 * (qua ranh giới chỉ được mang COMPONENT và KIỂU, không mang hằng số).
 *
 * Mỗi chiều một màu riêng, và cố ý KHÔNG dùng lại bảng màu của trạng thái đơn / vận đơn: bốn chiều
 * nhìn giống nhau là cách người đọc tưởng chúng là một (xem `components/status-badge.tsx`).
 */
const base = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

export function TechStatusBadge({ status, className }: { status: TechTaskStatus; className?: string }) {
  return <span className={cn(base, TECH_TASK_STATUS_TONE[status], className)}>{TECH_TASK_STATUS_LABEL[status]}</span>;
}

export function TechPriorityBadge({ priority, className }: { priority: TechPriority; className?: string }) {
  return <span className={cn(base, TECH_PRIORITY_TONE[priority], className)}>{TECH_PRIORITY_LABEL[priority]}</span>;
}

export function TechRiskBadge({ risk, className }: { risk: TechRisk; className?: string }) {
  return <span className={cn(base, TECH_RISK_TONE[risk], className)}>{TECH_RISK_LABEL[risk]}</span>;
}

export function TechApprovalBadge({ status, className }: { status: TechApprovalStatus; className?: string }) {
  // "Không cần phê duyệt" cố ý KHÔNG hiện: một nhãn xám trên mọi dòng chỉ làm loãng bảng. Thứ đáng
  // nhìn thấy là những việc ĐANG CHỜ một con người bấm.
  if (status === "NOT_REQUIRED") return null;
  return <span className={cn(base, TECH_APPROVAL_TONE[status], className)}>{TECH_APPROVAL_LABEL[status]}</span>;
}

export function TechGateBadge({ result, label, className }: { result: TechGateResult; label: string; className?: string }) {
  return (
    <span className={cn(base, TECH_GATE_RESULT_TONE[result], className)}>
      {label}: {TECH_GATE_RESULT_LABEL[result]}
    </span>
  );
}

export function TechDeployBadge({ status, className }: { status: TechDeployStatus; className?: string }) {
  return <span className={cn(base, TECH_DEPLOY_STATUS_TONE[status], className)}>{TECH_DEPLOY_STATUS_LABEL[status]}</span>;
}

export function TechSeverityBadge({ severity, className }: { severity: TechIncidentSeverity; className?: string }) {
  return <span className={cn(base, TECH_INCIDENT_SEVERITY_TONE[severity], className)}>{TECH_INCIDENT_SEVERITY_LABEL[severity]}</span>;
}

export function TechIncidentStatusBadge({ status, className }: { status: TechIncidentStatus; className?: string }) {
  return <span className={cn(base, TECH_INCIDENT_STATUS_TONE[status], className)}>{TECH_INCIDENT_STATUS_LABEL[status]}</span>;
}

/**
 * Sức khoẻ: bốn mức của `lib/queries/integration-health.ts`.
 *
 * `UNKNOWN` cố ý mang màu XÁM, không phải xanh nhạt: nó phải đọc ra là "chưa biết", không phải
 * "khoẻ nhẹ". Đây là chỗ một bảng điều khiển dễ nói dối nhất.
 */
const HEALTH_TONE_LOCAL: Record<string, string> = {
  HEALTHY: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DEGRADED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  DOWN: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const HEALTH_LABEL_LOCAL: Record<string, string> = {
  HEALTHY: "Đang chạy tốt",
  DEGRADED: "Chạy nhưng có lỗi",
  DOWN: "Không nhận được dữ liệu",
  UNKNOWN: "Chưa xác minh",
};

export function TechHealthBadge({ state, className }: { state: string; className?: string }) {
  return <span className={cn(base, HEALTH_TONE_LOCAL[state] ?? HEALTH_TONE_LOCAL.UNKNOWN, className)}>{HEALTH_LABEL_LOCAL[state] ?? "Chưa xác minh"}</span>;
}

/**
 * XÁC MINH ≠ KẾT QUẢ WORKFLOW. Đây là chiều THỨ BA của một lượt deploy (xem `verifyDeployment`):
 * GitHub nói xong, production đang chạy gì, và hai cái đó có khớp không. Ba chiều ba nhãn — gộp
 * lại thành một ô xanh/đỏ là xoá mất bài học đã phải học bằng một bước kiểm trong `deploy-vps.yml`.
 */
export function TechVerificationBadge({ verification, className }: { verification: TechVerification; className?: string }) {
  return <span className={cn(base, TECH_VERIFICATION_TONE[verification], className)}>{TECH_VERIFICATION_LABEL[verification]}</span>;
}

/** Dòng này do NGƯỜI gõ hay do ERP đọc về — hai mức tin cậy khác nhau, phải nhìn ra được. */
export function TechProviderBadge({ provider, className }: { provider: TechDeployProvider; className?: string }) {
  return (
    <span className={cn(base, provider === "GITHUB_ACTIONS" ? "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", className)}>
      {TECH_DEPLOY_PROVIDER_LABEL[provider]}
    </span>
  );
}

/**
 * ═══════════ BỐN NHÃN PR — CHƯA BIẾT THÌ KHÔNG VẼ GÌ ═══════════
 *
 * Mỗi nhãn tự ẩn khi giá trị là chuỗi rỗng. Một nhãn xám ghi "Chưa biết" trên mọi việc chưa có PR
 * là bốn nhãn xám trên mỗi dòng, và người đọc sẽ học cách không nhìn cả bốn — kể cả lúc một trong
 * chúng chuyển đỏ. Chữ "Chưa biết" vẫn sống trong `TECH_*_LABEL` cho những chỗ PHẢI in ra một giá
 * trị (trang chi tiết, tooltip), nơi ô trống sẽ bị đọc nhầm thành "không có".
 */
export function TechPrStateBadge({ state, className }: { state: TechPrState; className?: string }) {
  if (!state) return null;
  return <span className={cn(base, TECH_PR_STATE_TONE[state], className)}>{TECH_PR_STATE_LABEL[state]}</span>;
}

export function TechCiStateBadge({ state, className }: { state: TechCiState; className?: string }) {
  if (!state) return null;
  return <span className={cn(base, TECH_CI_STATE_TONE[state], className)}>{TECH_CI_STATE_LABEL[state]}</span>;
}

export function TechReviewStateBadge({ state, className }: { state: TechReviewState; className?: string }) {
  if (!state) return null;
  return <span className={cn(base, TECH_REVIEW_STATE_TONE[state], className)}>{TECH_REVIEW_STATE_LABEL[state]}</span>;
}

export function TechMergeStateBadge({ state, className }: { state: TechMergeState; className?: string }) {
  /*
    "Gộp được" KHÔNG hiện, và đó là lựa chọn: nó là trạng thái BÌNH THƯỜNG của mọi PR khoẻ mạnh,
    nên vẽ nó lên là thêm một nhãn xanh vào mỗi dòng để nói "không có gì xảy ra". Thứ đáng nhìn là
    XUNG ĐỘT. `MERGED` vẫn hiện vì nó là một sự kiện, không phải một trạng thái chờ.
  */
  if (!state || state === "MERGEABLE") return null;
  return <span className={cn(base, TECH_MERGE_STATE_TONE[state], className)}>{TECH_MERGE_STATE_LABEL[state]}</span>;
}

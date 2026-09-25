import { COST_SHEET_STATUS_LABEL, SAMPLE_STATUS_LABEL, SAMPLE_STATUS_TONE, TOPIC_STATUS_LABEL, TOPIC_STATUS_TONE, type CostSheetStatus, type SampleStatus, type TopicStatus } from "@/lib/constants/production-os";
import { cn } from "@/lib/utils";

const base = "inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold";

export function TopicStatusBadge({ status }: { status: TopicStatus }) {
  return <span className={cn(base, TOPIC_STATUS_TONE[status])}>{TOPIC_STATUS_LABEL[status] ?? status}</span>;
}

export function SampleStatusBadge({ status }: { status: SampleStatus }) {
  return <span className={cn(base, SAMPLE_STATUS_TONE[status])}>{SAMPLE_STATUS_LABEL[status] ?? status}</span>;
}

export function CostSheetStatusBadge({ status }: { status: CostSheetStatus }) {
  return (
    <span className={cn(base, status === "FINAL" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300")}>
      {COST_SHEET_STATUS_LABEL[status] ?? status}
    </span>
  );
}

import { MODEL_STATE_LABELS, MODEL_STATE_TONE, MODEL_STATE_UNDECLARED_LABEL, type ModelState } from "@/lib/constants/model-lifecycle";
import { cn } from "@/lib/utils";

/**
 * Nhãn trạng thái KHAI. `null` in "Chưa khai" bằng viền đứt — không bao giờ in thành "Đang bán" hay để
 * trống (AGENTS.md mục 42).
 */
export function ModelStateBadge({ state, className }: { state: ModelState | null; className?: string }) {
  if (!state) {
    return <span className={cn("inline-flex items-center rounded-md border border-dashed px-2 py-0.5 text-xs font-medium text-muted-foreground", className)}>{MODEL_STATE_UNDECLARED_LABEL}</span>;
  }
  return <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", MODEL_STATE_TONE[state], className)}>{MODEL_STATE_LABELS[state]}</span>;
}

/** Giai đoạn MÁY quan sát — luôn mang chữ "Ước tính", không cùng hình với trạng thái khai. */
export function ObservedStageBadge({ state, className }: { state: ModelState | null; className?: string }) {
  if (!state) return <span className={cn("text-xs text-muted-foreground", className)}>Máy chưa thấy chứng cứ nào</span>;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs", className)}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Ước tính</span>
      <span className="font-medium">{MODEL_STATE_LABELS[state]}</span>
    </span>
  );
}

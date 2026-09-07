import { InfoHint } from "@/components/info-hint";
import { cn } from "@/lib/utils";

/**
 * Tiêu đề trang. `description` chỉ giữ một câu ngắn; phần giải thích dài (định nghĩa, cách tính,
 * quy ước nghiệp vụ) đưa vào `hint` để hiện trong dấu ⓘ cạnh tiêu đề.
 */
export function PageHeader({ title, description, hint, eyebrow, actions, className }: { title: React.ReactNode; description?: React.ReactNode; hint?: React.ReactNode; eyebrow?: string; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p> : null}
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
          {hint ? <InfoHint>{hint}</InfoHint> : null}
        </div>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

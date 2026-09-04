import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const tones = {
  primary: "bg-primary/10 text-primary",
  green: "bg-success/12 text-success",
  amber: "bg-warning/15 text-amber-700 dark:text-amber-300",
  blue: "bg-info/12 text-info",
  rose: "bg-destructive/10 text-destructive",
  slate: "bg-muted text-muted-foreground",
};

export function MetricCard({
  label,
  value,
  note,
  change,
  changeLabel = "so với kỳ trước",
  icon: Icon,
  tone = "primary",
  className,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  change?: number | null;
  changeLabel?: string;
  icon?: LucideIcon;
  tone?: keyof typeof tones;
  className?: string;
}) {
  const hasChange = typeof change === "number" && Number.isFinite(change);
  return (
    <Card className={cn("gap-0 p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        {Icon ? (
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", tones[tone])}>
            <Icon className="size-[18px]" />
          </span>
        ) : null}
      </div>
      <p className="numeric mt-2 text-2xl font-bold tracking-tight sm:text-[26px]">{value}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {hasChange ? (
          <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold", change >= 0 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
            {change >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {change >= 0 ? "+" : ""}
            {change.toFixed(1)}%
          </span>
        ) : null}
        {hasChange ? <span>{changeLabel}</span> : null}
        {note ? <span className={hasChange ? "basis-full" : ""}>{note}</span> : null}
      </div>
    </Card>
  );
}

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { cn } from "@/lib/utils";

/**
 * ═══════════ THẺ CHỈ SỐ ═══════════
 *
 * Trật tự đọc luôn là: NHÃN → SỐ → bối cảnh → hành động. Không có đoạn văn giải thích nào trên
 * mặt thẻ: ý nghĩa và cách tính nằm trong dấu ⓘ cạnh nhãn, chỉ hiện khi người đọc cần.
 *
 * `href` biến CẢ thẻ thành một liên kết. Trước đây các trang tự bọc `<Link><MetricCard/></Link>`:
 * thẻ không có viền tiêu điểm khi đi bằng bàn phím, không có dấu hiệu bấm được, và mỗi trang tự
 * bọc một kiểu. Nay một chỗ lo cả ba việc đó.
 */

const tones = {
  primary: "bg-primary/10 text-primary",
  green: "bg-success/12 text-success",
  amber: "bg-warning/15 text-amber-700 dark:text-amber-300",
  blue: "bg-info/12 text-info",
  rose: "bg-destructive/10 text-destructive",
  slate: "bg-muted text-muted-foreground",
};

export type MetricTone = keyof typeof tones;

export function MetricCard({
  label,
  value,
  note,
  hint,
  change,
  changeLabel = "so với kỳ trước",
  icon: Icon,
  tone = "primary",
  size = "md",
  href,
  className,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  /** Ý nghĩa và cách tính — hiện trong dấu ⓘ cạnh nhãn, không in thẳng ra màn hình. */
  hint?: React.ReactNode;
  change?: number | null;
  changeLabel?: string;
  icon?: LucideIcon;
  tone?: MetricTone;
  /** `lg` dành cho vài con số dẫn dắt cả trang; `md` cho phần còn lại. */
  size?: "md" | "lg";
  /** Mở đúng tập dữ liệu đã sinh ra con số này. */
  href?: string;
  className?: string;
}) {
  const hasChange = typeof change === "number" && Number.isFinite(change);
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground">
          <span className="truncate">{label}</span>
          {hint ? <InfoHint>{hint}</InfoHint> : null}
        </p>
        {Icon ? (
          <span className={cn("flex shrink-0 items-center justify-center rounded-xl", tones[tone], size === "lg" ? "size-10" : "size-9")}>
            <Icon className={size === "lg" ? "size-5" : "size-[18px]"} />
          </span>
        ) : null}
      </div>
      <p className={cn("numeric mt-2 font-bold tracking-tight", size === "lg" ? "text-[28px] leading-9 sm:text-[32px]" : "text-2xl sm:text-[26px]")}>{value}</p>
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
    </>
  );

  const shell = cn(
    "group/metric relative flex h-full flex-col rounded-xl border bg-card text-card-foreground shadow-[var(--shadow-card)]",
    size === "lg" ? "p-5 sm:p-6" : "p-5",
    className,
  );

  if (!href) return <div className={shell}>{body}</div>;
  return (
    <Link
      href={href}
      className={cn(
        shell,
        "transition-[border-color,box-shadow,transform] hover:border-primary/40 hover:shadow-[var(--shadow-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      {body}
      {/* Mũi tên chỉ hiện khi rê vào: bấm được thì nói ra, nhưng không thêm nhiễu lúc đang đọc số. */}
      <ArrowRight className="absolute bottom-4 right-4 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/metric:opacity-70" aria-hidden />
    </Link>
  );
}

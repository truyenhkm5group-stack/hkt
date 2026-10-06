import { Check, Minus } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { formatDate, formatDateTime, formatVND } from "@/lib/format";
import { QUOTA_SPEC } from "@/lib/pricing/catalog";
import { FEATURE_SPEC } from "@/lib/pricing/features";
import { QUOTA_LEVEL_LABEL, type QuotaLevel } from "@/lib/pricing/guard";
import type { CustomerPlanView } from "@/lib/pricing/customer";
import { cn } from "@/lib/utils";

/**
 * Khung «Hạn mức tháng này» của `/settings/plan` — đơn vị dễ hiểu ("3.245 / 5.000 hội thoại AI"), thanh phần trăm, mức. KHÔNG
 * in token, model hay chi phí AI: đó là số của người vận hành. «—» = chưa đo được, không phải 0.
 */

const BAR: Record<QuotaLevel, string> = {
  UNDECLARED: "bg-muted-foreground/30",
  UNLIMITED: "bg-emerald-500/60",
  UNKNOWN: "bg-muted-foreground/30",
  OK: "bg-emerald-500",
  NOTICE: "bg-sky-500",
  WARN: "bg-amber-500",
  LIMIT: "bg-rose-500",
};
const TEXT: Record<QuotaLevel, string> = {
  UNDECLARED: "text-muted-foreground",
  UNLIMITED: "text-muted-foreground",
  UNKNOWN: "text-muted-foreground",
  OK: "text-emerald-700 dark:text-emerald-400",
  NOTICE: "text-sky-700 dark:text-sky-400",
  WARN: "text-amber-700 dark:text-amber-400",
  LIMIT: "text-rose-700 dark:text-rose-400",
};

export function CustomerUsageSection({ view }: { view: CustomerPlanView }) {
  const granted = view.features.filter((f) => f.granted);
  return (
    <SectionCard
      title="Hạn mức tháng này"
      description={`Gói «${view.planName}»${view.priceVnd !== null ? ` · ${formatVND(view.priceVnd)}/tháng` : ""}${view.yearlyPriceVnd !== null ? ` · trả năm ${formatVND(view.yearlyPriceVnd)} (≈ ${formatVND(view.monthlyOnYearlyVnd)}/tháng)` : ""} · kỳ ${view.periodLabel}, đếm lại từ ${formatDate(view.resetsOn)}${view.paidThrough ? ` · gia hạn trước ${formatDate(view.paidThrough)}` : ""}`}
      hint="Số đếm từ dữ liệu thật của cửa hàng: hội thoại có AI trả lời, tin AI đã gửi, đơn AI tạo, fanpage đang nối. Dùng quá hạn mức thì AI KHÔNG bị ngắt — bạn được mời nâng gói (hoặc tính phần vượt nếu gói có khai). «—» = chưa đo được."
    >
      <div className="space-y-4" data-customer-usage>
        <ul className="grid gap-3 sm:grid-cols-2">
          {view.quotas.map((q) => {
            const width = q.pct === null ? (q.level === "LIMIT" ? 100 : 0) : Math.min(100, Math.max(2, q.pct));
            return (
              <li key={q.key} className="rounded-lg border border-hairline p-3" data-quota={q.key} data-level={q.level}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{QUOTA_SPEC[q.key].label}</span>
                  <span className={cn("text-xs font-medium", TEXT[q.level])}>{QUOTA_LEVEL_LABEL[q.level]}</span>
                </div>
                <div className="numeric mt-1 text-sm">
                  {q.line}
                  {q.pct !== null ? <span className="text-muted-foreground"> · {Math.round(q.pct).toLocaleString("vi-VN")}%</span> : null}
                </div>
                {q.included !== null && q.included !== undefined ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div className={cn("h-full rounded-full", BAR[q.level])} style={{ width: `${width}%` }} />
                  </div>
                ) : null}
                {q.message && q.level !== "OK" ? <p className={cn("mt-1.5 text-xs", TEXT[q.level])}>{q.message}</p> : null}
              </li>
            );
          })}
        </ul>
        <div>
          <h3 className="text-sm font-semibold">Tính năng của gói</h3>
          <ul className="mt-2 grid gap-1.5 text-sm sm:grid-cols-2">
            {view.features.map((f) => (
              <li key={f.key} className={cn("flex items-start gap-2", !f.granted && "text-muted-foreground")} data-feature={f.key} data-granted={f.granted}>
                {f.granted ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />}
                <span>{FEATURE_SPEC[f.key].label}</span>
              </li>
            ))}
          </ul>
          {granted.length === view.features.length ? null : <p className="mt-2 text-xs text-muted-foreground">Tính năng có dấu «–» thuộc gói cao hơn — chọn gói ở khung Thanh toán.</p>}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Đếm lúc {formatDateTime(view.measuredAt)}.{view.errors.length ? ` Một phần số chưa đọc được (${view.errors.length} nguồn) — hiện «—».` : ""}
        </p>
      </div>
    </SectionCard>
  );
}

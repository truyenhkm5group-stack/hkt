import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { FirstValueView } from "@/lib/onboarding/go-live";
import { FIRST_VALUE_STATUS_LABEL, type FirstValueStatus } from "@/lib/onboarding/go-live-shared";
import { cn } from "@/lib/utils";

const ICON: Record<FirstValueStatus, typeof Circle> = { DONE: CheckCircle2, NEEDS_ACTION: Circle, ERROR: AlertTriangle };
const ICON_TONE: Record<FirstValueStatus, string> = { DONE: "text-emerald-600", NEEDS_ACTION: "text-muted-foreground", ERROR: "text-destructive" };

/**
 * DANH SÁCH «GIÁ TRỊ ĐẦU TIÊN» CỦA VỎ CHỐT ĐƠN — MỘT danh sách chín bước thay cho các thẻ rải rác (luật ở
 * lib/onboarding/go-live-shared.ts, số liệu ở `loadFirstValue`). Trên điện thoại, nút chính «Tiếp tục thiết lập» nằm NGAY dưới
 * thanh tiến độ — thấy được mà không cần cuộn — và dẫn tới bước CHƯA xong đầu tiên. Xong cả chín bước ⇒ thu lại thành một thẻ nhỏ
 * «Đã sẵn sàng bán» (danh sách vẫn mở lại được để xem).
 *
 * Thành phần máy chủ, không trạng thái: mọi dấu «xong» đến từ dữ liệu thật, không có ô nào bấm cho xong.
 */
export function FirstValueChecklist({ view, className }: { view: FirstValueView; className?: string }) {
  if (!view.show) return null;
  const list = (
    <ol className="divide-y divide-hairline" data-first-value-steps>
      {view.steps.map((s, i) => {
        const Icon = ICON[s.status];
        return (
          <li key={s.key} className="flex items-start gap-3 px-4 py-3" data-step={s.key} data-status={s.status}>
            <Icon className={cn("mt-0.5 size-5 shrink-0", ICON_TONE[s.status])} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-semibold", s.status === "DONE" && "text-muted-foreground")}>
                {i + 1}. {s.label}
                {s.status === "ERROR" ? <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{FIRST_VALUE_STATUS_LABEL.ERROR}</span> : <span className="sr-only"> — {FIRST_VALUE_STATUS_LABEL[s.status]}</span>}
              </p>
              <p className={cn("mt-0.5 text-[13px] leading-5", s.status === "ERROR" ? "text-destructive" : "text-muted-foreground")}>{s.detail}</p>
              {s.href ? (
                <Link href={s.href} className={cn("mt-1 inline-flex min-h-9 items-center gap-1 text-[13px] font-medium hover:underline", s.status === "DONE" ? "text-muted-foreground" : "text-primary")} data-step-link={s.key}>
                  {s.cta} <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );

  if (view.allDone) {
    return (
      <section className={cn("rounded-2xl bg-card shadow-[var(--shadow-card)]", className)} data-first-value="ready">
        <div className="flex items-center gap-3 p-4">
          <CheckCircle2 className="size-6 shrink-0 text-emerald-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Đã sẵn sàng bán</p>
            <p className="text-[13px] text-muted-foreground">
              {view.done}/{view.total} bước đã xong — bot đang trả lời khách thật.
            </p>
          </div>
        </div>
        <details className="border-t border-hairline">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[13px] font-medium text-primary">Xem lại các bước</summary>
          {list}
        </details>
      </section>
    );
  }

  const pct = view.total ? Math.round((view.done / view.total) * 100) : 0;
  return (
    <section className={cn("rounded-2xl bg-card shadow-[var(--shadow-card)]", className)} data-first-value="checklist" aria-labelledby="first-value-title">
      <div className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="first-value-title" className="text-base font-semibold">
            Thiết lập để bot bắt đầu bán
          </h2>
          <span className="shrink-0 text-sm font-semibold tabular-nums" data-first-value-progress>
            {view.done}/{view.total}
          </span>
        </div>
        <Progress value={pct} aria-label={`Đã xong ${view.done} trên ${view.total} bước`} />
        {view.next?.href ? (
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <Link href={view.next.href} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:opacity-90" data-first-value-cta={view.next.key}>
              Tiếp tục thiết lập <ArrowRight className="size-4" aria-hidden />
            </Link>
            <p className="text-[13px] text-muted-foreground">
              Bước tiếp theo: <span className="font-medium text-foreground">{view.next.label}</span>
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground" data-first-value-cta="none">
            Các bước còn lại cần chủ cửa hàng làm.
          </p>
        )}
      </div>
      <div className="border-t border-hairline">{list}</div>
    </section>
  );
}

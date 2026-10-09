import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SETTINGS_STATE_LABEL, type SettingsState, type SettingsStatus } from "@/lib/sales-chatbot/settings-status";

/**
 * Ô ĐẦU TRANG cấu hình AI Sales: MỘT trạng thái + MỘT câu + MỘT nút chính (luật trạng thái ở `lib/sales-chatbot/settings-status.ts`).
 * Việc chưa làm không phải lỗi (docs/design-system.md §9) ⇒ «Cần cấu hình» / «Hết hạn mức» tô cam, không đỏ; «Đang chuẩn bị» và
 * «Chưa rõ» viền đứt — không phải việc của người đọc, và không được trông giống «Đang chạy».
 * `children` = bảng kiểm chi tiết (thu gọn) do trang dựng.
 */
const TONE: Record<SettingsState, string> = {
  RUNNING: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  NEEDS_SETUP: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  OUT_OF_QUOTA: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  PAUSED: "bg-muted text-foreground/80",
  PREPARING: "border border-dashed border-foreground/25 bg-muted/60 text-muted-foreground",
  UNKNOWN: "border border-dashed border-foreground/25 bg-muted/60 text-muted-foreground",
};

export function SettingsStatusCard({ status, children }: { status: SettingsStatus; children?: React.ReactNode }) {
  const a = status.action;
  return (
    <section className="rounded-2xl bg-card p-4 text-card-foreground shadow-[var(--shadow-card)] sm:p-5" data-testid="ai-settings-status" data-state={status.state} data-reason={status.reason} aria-label="Trạng thái bot">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[status.state])}>{SETTINGS_STATE_LABEL[status.state]}</span>
          <h2 className="text-lg font-semibold leading-snug">{status.title}</h2>
          <p className="text-sm text-muted-foreground">{status.detail}</p>
        </div>
        {a ? (
          a.external ? (
            <a href={a.href} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")} data-testid="ai-settings-primary">
              {a.label}
            </a>
          ) : (
            <Link href={a.href} className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")} data-testid="ai-settings-primary">
              {a.label}
            </Link>
          )
        ) : null}
      </div>
      {children ? <div className="mt-4 border-t pt-3">{children}</div> : null}
    </section>
  );
}

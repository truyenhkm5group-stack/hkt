import { SectionCard } from "@/components/ui-bits";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getWebhookHealth } from "@/lib/queries/webhook-health";
import { cn } from "@/lib/utils";

const TONE = {
  HEALTHY: "border-emerald-300/70 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/20",
  QUIET: "border-amber-300/70 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20",
  SILENT: "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20",
  NO_HISTORY: "border-border bg-muted/30",
} as const;

const NHAN = { HEALTHY: "Đang chạy", QUIET: "Thấp bất thường", SILENT: "Đứt", NO_HISTORY: "Chưa có" } as const;

/**
 * ───────────── SỨC KHOẺ WEBHOOK, TÁCH BA ĐƯỜNG ─────────────
 *
 * Một đèn xanh chung che được cái chết của một đường: hai đường còn sống là đèn vẫn xanh. Mà ba
 * đường này mù ba kiểu khác nhau — mù vị trí hàng khác hẳn mù đơn mới.
 */
export async function WebhookHealthPanel() {
  const h = await getWebhookHealth();
  return (
    <SectionCard
      title="Sức khoẻ webhook · ba đường dữ liệu"
      description="Mỗi đường mang một loại tin khác nhau, nên phải nhìn riêng — một đèn xanh chung sẽ che được cái chết của một đường."
      hint="So sánh với TRUNG BÌNH CÙNG KHUNG GIỜ của 7 ngày trước, không so với giờ liền trước: 3 giờ sáng không ai giao hàng, im lặng lúc đó là đúng chứ không phải hỏng."
    >
      <div className="grid gap-3 lg:grid-cols-3">
        {h.lanes.map((l) => (
          <div key={l.key} className={cn("rounded-xl border p-3", TONE[l.status])}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-[12.5px] font-semibold">{l.label}</div>
              <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10.5px] font-semibold">{NHAN[l.status]}</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{l.what}</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="numeric text-xl font-bold">{formatNumber(l.lastHour)}</span>
              <span className="text-[11.5px] text-muted-foreground">gói / giờ qua · {formatNumber(l.last24h)} trong 24 giờ</span>
            </div>
            <p className="mt-1 text-[11.5px] leading-snug">{l.note}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Gói gần nhất: {l.lastAt ? formatDateTime(l.lastAt) : "chưa có"}</p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

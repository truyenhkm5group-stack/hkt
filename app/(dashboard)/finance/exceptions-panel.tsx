import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleAlert, Info } from "lucide-react";
import type { FinanceException } from "@/lib/queries/finance-overview";
import { formatNumber, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * VIỆC CẦN LÀM ĐẶT TRƯỚC SỐ ĐẸP.
 *
 * Khối này nằm NGAY DƯỚI tiêu đề, trên mọi con số. Một giao dịch chưa phân loại không phải chuyện
 * dọn dẹp cuối tháng: nó nghĩa là có tiền thật đã vào hoặc ra mà không báo cáo nào biết xếp vào
 * đâu — mọi con số bên dưới đều đang thiếu đúng khoản đó. Đặt nó ở cuối trang là mời người đọc tin
 * vào một con số mà chính trang này biết là chưa đủ.
 *
 * Mỗi mục nói ba điều, không hơn: VIỆC GÌ · ẢNH HƯỞNG BAO NHIÊU TIỀN · BẤM VÀO ĐÂU ĐỂ XỬ LÝ.
 */

const TONE = {
  high: {
    icon: CircleAlert,
    wrap: "border-destructive/30 bg-destructive/5",
    badge: "bg-destructive/10 text-destructive",
    label: "Cần xử lý",
  },
  medium: {
    icon: AlertTriangle,
    wrap: "border-warning/40 bg-warning/5",
    badge: "bg-warning/15 text-amber-700 dark:text-amber-300",
    label: "Nên xem",
  },
  low: {
    icon: Info,
    wrap: "border-border bg-surface-sunken/40",
    badge: "bg-muted text-muted-foreground",
    label: "Ghi nhận",
  },
} as const;

export function ExceptionsPanel({ exceptions }: { exceptions: FinanceException[] }) {
  if (!exceptions.length) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/5 px-4 py-3">
        <CheckCircle2 className="size-4 shrink-0 text-success" />
        <p className="text-[13px] font-medium">
          Không có việc tài chính nào đang tồn đọng.
          <span className="ml-1.5 font-normal text-muted-foreground">Mọi giao dịch đã phân loại, mọi tài khoản đã xác nhận, không có khoản COD nào quá hạn.</span>
        </p>
      </div>
    );
  }

  const nang = exceptions.filter((e) => e.severity === "high").length;

  return (
    <section className="rounded-xl border bg-card shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline px-5 py-3">
        <h2 className="text-[13.5px] font-bold">
          Việc tài chính cần xử lý
          <span className="ml-1.5 font-normal text-muted-foreground">
            {formatNumber(exceptions.length)} mục{nang > 0 ? ` · ${formatNumber(nang)} cần xử lý ngay` : ""}
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">Mỗi mục dưới đây đang làm sai lệch một con số ở phần bên dưới.</p>
      </div>
      <ul className="divide-y divide-hairline">
        {exceptions.map((e) => {
          const tone = TONE[e.severity];
          const Icon = tone.icon;
          return (
            <li key={e.key}>
              <Link
                href={e.href}
                className={cn(
                  "group/exc flex items-start gap-3 px-5 py-3 transition-colors hover:bg-muted/50",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                )}
              >
                <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg", tone.badge)}>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <p className="text-[13px] font-semibold">{e.title}</p>
                    {e.count > 0 ? <span className="numeric text-xs text-muted-foreground">{formatNumber(e.count)} mục</span> : null}
                    {/* Số tiền đang bị ảnh hưởng là thứ quyết định làm mục nào trước. */}
                    {e.amount !== null && e.amount > 0 ? (
                      <span className="numeric rounded-md bg-muted px-1.5 py-0.5 text-xs font-semibold">{formatVND(e.amount)}</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{e.impact}</p>
                </div>
                <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/exc:opacity-70" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

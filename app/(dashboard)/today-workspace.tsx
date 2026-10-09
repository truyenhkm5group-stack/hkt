import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, ClipboardCheck, PackageX, ShoppingBag, Truck, Warehouse } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ HÔM NAY = CHỖ LÀM VIỆC, KHÔNG PHẢI BẢNG TRANG TRÍ (chủ shop 09/10/2026) ═══════════
 *
 * Trang chủ từng mở đầu bằng ba thẻ doanh thu cỡ lớn; danh sách việc nằm dưới hai màn cuộn. Người mở ERP buổi sáng cần biết
 * "hôm nay làm gì trước" — nên dải này đứng NGAY dưới tiêu đề: mỗi ô là MỘT loại việc, một con số, và bấm vào mở ĐÚNG danh
 * sách đã lọc (không phải trang chung rồi tự lọc lại).
 *
 * Không tính số mới nào: mọi con số đến từ truy vấn trang chủ đã chạy (`getDashboardData`) hoặc từ đúng hàm đếm của trang
 * đích (`orderNeedsReviewCount`), nên ô và danh sách nó mở ra không bao giờ nói hai số khác nhau. `null` = CHƯA BIẾT ⇒ "—",
 * không in 0 (AGENTS 42). Ô có số 0 vẫn hiện, ở dạng "xong" — để người đọc biết đã kiểm, không phải bị giấu.
 */
export type WorkspaceTile = { key: string; label: string; count: number | null; href: string; action: string; icon: LucideIcon; urgent?: boolean };

export const WORKSPACE_ICONS = { review: ClipboardCheck, newOrders: ShoppingBag, notShipped: Warehouse, failed: PackageX, stale: Truck, stock: AlertTriangle } as const;

export function TodayWorkspace({ tiles }: { tiles: WorkspaceTile[] }) {
  if (!tiles.length) return null;
  const open = tiles.filter((t) => t.count !== null && t.count > 0).length;
  return (
    <section aria-labelledby="today-title" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="today-title" className="text-base font-bold">
          Việc cần làm ngay
        </h2>
        <p className="text-xs text-muted-foreground">{open ? `${open} loại việc đang chờ · bấm để mở đúng danh sách` : "Không có gì cần xử lý 🎉"}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => {
          const pending = t.count !== null && t.count > 0;
          // CHƯA BIẾT (`null`) không phải "xong": vòng nét đứt, không dấu tích xanh.
          const Icon = pending ? t.icon : t.count === null ? CircleDashed : CheckCircle2;
          return (
            <Link
              key={t.key}
              href={t.href}
              className={cn(
                "group flex min-h-[104px] flex-col justify-between rounded-2xl border bg-card p-3.5 shadow-[var(--shadow-card)] transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                pending && t.urgent && "border-rose-300 dark:border-rose-900",
                pending && !t.urgent && "border-amber-300/80 dark:border-amber-900",
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="text-[13px] font-medium leading-5 text-muted-foreground">{t.label}</span>
                <Icon className={cn("size-4 shrink-0", pending ? (t.urgent ? "text-rose-600" : "text-amber-600") : t.count === null ? "text-muted-foreground" : "text-success")} aria-hidden />
              </span>
              <span className="flex items-end justify-between gap-2">
                <span className={cn("numeric text-[26px] font-extrabold leading-8 tracking-[-0.02em]", !pending && "text-muted-foreground")}>{t.count === null ? "—" : formatNumber(t.count)}</span>
                <span className="flex items-center gap-0.5 text-xs font-semibold text-primary opacity-80 group-hover:opacity-100">
                  {pending ? t.action : "Xem"} <ArrowRight className="size-3.5" />
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

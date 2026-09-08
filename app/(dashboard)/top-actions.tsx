import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CASE_STATUS_LABEL, PRIORITY_LABEL, PRIORITY_TONE } from "@/lib/constants/action-queue";
import { formatVND } from "@/lib/format";
import { getDashboardActionQueue } from "@/lib/queries/dashboard-queue";
import { cn } from "@/lib/utils";

/**
 * ───────────── VIỆC CẦN LÀM HÔM NAY ─────────────
 *
 * Trước đây ô này liệt kê các NHÓM việc kèm số đếm: "12 đơn mới", "5 vận đơn giao thất bại". Đọc
 * xong vẫn phải mở từng trang để biết bắt đầu từ đâu, nên trên thực tế không ai bắt đầu từ đây.
 *
 * Nay hiện đúng những VIỆC CỤ THỂ đứng đầu hàng đợi, xếp theo cùng một công thức ưu tiên của toàn
 * ERP — kèm vì sao nó gấp, bao nhiêu tiền đang treo, ai đang cầm và đã trễ hạn chưa. Chủ shop mở
 * trang là biết ngay việc đầu tiên phải làm.
 */
export async function TopActions({ limit = 6 }: { limit?: number }) {
  const queue = await getDashboardActionQueue();
  // Việc đã có người ĐANG LÀM không cần chen lên đầu bảng điều khiển của chủ shop.
  const top = queue.cases.filter((c) => c.status === "OPEN" || c.status === "ACKNOWLEDGED").slice(0, limit);

  if (!top.length) {
    return <p className="px-5 py-8 text-center text-sm text-muted-foreground">Không còn việc nào đang chờ. Hàng đợi sạch.</p>;
  }

  return (
    <div className="divide-y">
      {top.map((c) => (
        <Link key={c.id} href={c.href || "/alerts"} className="flex items-start gap-3 px-5 py-3 hover:bg-muted/50">
          <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap", PRIORITY_TONE[c.priority])}>
            {PRIORITY_LABEL[c.priority]}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{c.title}</p>
            <p className="truncate text-xs text-muted-foreground">{c.recommendedAction}</p>
            <p className="truncate text-[10.5px] text-muted-foreground/80">
              {/* Bốn thông tin quyết định có làm ngay hay không, và không cái nào thay được cái nào. */}
              {c.ageLabel} trước
              {c.financialImpact > 0 ? ` · ${formatVND(c.financialImpact, { compact: true })} đang treo` : ""}
              {c.owner ? ` · ${c.owner.name}` : ` · ${CASE_STATUS_LABEL.OPEN}`}
              {c.sla?.breached ? <span className="font-semibold text-rose-600 dark:text-rose-400"> · {c.sla.label}</span> : ""}
            </p>
          </div>
          <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
      <Link href="/alerts" className="flex items-center justify-between px-5 py-2.5 text-xs font-semibold text-primary hover:bg-muted/50">
        <span>
          Xem toàn bộ {queue.total} việc
          {queue.breached ? ` · ${queue.breached} trễ hạn` : ""}
          {queue.unassigned ? ` · ${queue.unassigned} chưa ai nhận` : ""}
        </span>
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

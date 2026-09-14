import { CheckCircle2, TriangleAlert } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber } from "@/lib/format";
import type { ReturnDataQuality } from "@/lib/queries/return-exceptions";
import { cn } from "@/lib/utils";

/**
 * ═══════════ SÁU LỖ HỔNG CÓ TÊN — VÀ HAI CON SỐ PHẢI LUÔN BẰNG 0 ═══════════
 *
 * Bảng này cố ý in cả những con số bằng 0, ngược với luật "khối rỗng thì không hiện" ở nơi khác.
 * Lý do: `OVER_QTY` và `DUPLICATE_RECEIPT` là hai BẤT BIẾN. Một bất biến chỉ có giá trị khi người
 * ta nhìn thấy nó đang đúng — một con số luôn bằng 0 mà không ai đếm là con số không ai biết vào
 * ngày nó thôi bằng 0.
 *
 * Bốn con số còn lại là việc phải làm, và mỗi con số nói rõ nhóm nào ở khối ngoại lệ phía trên xử
 * lý nó. Một bảng chỉ in số mà không nói ai làm gì là bảng không ai mở lần thứ hai
 * (AGENTS.md mục 45).
 */
export function ReturnQualityCounters({ rows }: { rows: ReturnDataQuality }) {
  if (!rows.length) return null;
  const batBien = rows.filter((r) => !r.queue);
  const viec = rows.filter((r) => r.queue);
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <TriangleAlert className="size-4" /> Chất lượng dữ liệu hàng hoàn
        </span>
      }
      description="Bốn lỗ hổng cần người xử lý, hai bất biến phải luôn bằng 0"
      hint="CHƯA BIẾT không bao giờ được in thành 0 (AGENTS.md mục 42). Các con số ở đây đếm dòng CHƯA có người gỡ — gỡ xong thì dòng rời khỏi bộ đếm nhưng vẫn tra được kèm lý do."
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {viec.map((r) => (
          <div key={r.key} className={cn("rounded-md border px-3 py-2", r.count ? "border-amber-300 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20" : "bg-muted/30")}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium">{r.label}</span>
              <b className={cn("numeric text-lg", r.count ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>{formatNumber(r.count)}</b>
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{r.why}</p>
          </div>
        ))}
        {batBien.map((r) => (
          <div key={r.key} className={cn("rounded-md border px-3 py-2", r.count ? "border-rose-400 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30" : "bg-muted/30")}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1 text-xs font-medium">
                {r.count ? <TriangleAlert className="size-3 text-rose-600" /> : <CheckCircle2 className="size-3 text-emerald-600" />} {r.label}
              </span>
              <b className={cn("numeric text-lg", r.count ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-400")}>{formatNumber(r.count)}</b>
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{r.why}</p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

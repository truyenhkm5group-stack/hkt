"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Money } from "@/components/ui-bits";
import { rateTone } from "@/lib/constants/returns";
import { formatNumber } from "@/lib/format";
import type { ReturnRateRow } from "@/lib/queries/return-rate";
import { cn } from "@/lib/utils";

function RateBar({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-xs text-muted-foreground">chưa có kết quả</span>;
  const width = Math.max(2, Math.min(100, rate));
  return (
    <div className="flex min-w-[140px] items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", rate >= 30 ? "bg-rose-500" : rate >= 15 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${width}%` }} />
      </div>
      <span className={cn("numeric w-14 text-right text-sm font-bold", rateTone(rate))}>{rate.toFixed(1)}%</span>
    </div>
  );
}

export const returnRateColumns: ColumnDef<ReturnRateRow, unknown>[] = [
  {
    id: "sku",
    header: "Mã hàng",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex min-w-[220px] items-center gap-3">
          {r.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.image} alt="" className="size-10 shrink-0 rounded-md border object-cover" loading="lazy" />
          ) : (
            <div className="size-10 shrink-0 rounded-md border bg-muted" />
          )}
          <div className="min-w-0">
            <div className="truncate font-semibold">{r.sku || "(không có SKU)"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {r.productName}
              {r.variationDetail ? ` · ${r.variationDetail}` : ""}
            </div>
          </div>
        </div>
      );
    },
  },
  { id: "shipped", header: "Đã gửi", meta: { align: "right" }, cell: ({ row }) => <span className="numeric">{formatNumber(row.original.shipped)}</span> },
  { id: "delivered", header: "Giao thật", meta: { align: "right" }, cell: ({ row }) => <span className="numeric font-medium text-emerald-700 dark:text-emerald-400">{formatNumber(row.original.delivered)}</span> },
  {
    id: "returned",
    header: "Hoàn",
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <span className="numeric font-semibold text-rose-600 dark:text-rose-400">{formatNumber(row.original.returned)}</span>
        {row.original.returnedByRule ? <div className="text-[10.5px] text-muted-foreground">{formatNumber(row.original.returnedByRule)} theo quy tắc COD/cước</div> : null}
      </div>
    ),
  },
  {
    id: "inTransit",
    header: "Đang giao",
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="numeric text-muted-foreground">
        {formatNumber(row.original.inTransit)}
        {row.original.failed ? <span className="ml-1 rounded bg-amber-50 px-1 text-[10.5px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" title="Giao thất bại, chờ phát lại">↻ {formatNumber(row.original.failed)}</span> : null}
      </span>
    ),
  },
  { id: "rate", header: "Tỷ lệ hoàn (đã kết thúc)", cell: ({ row }) => <RateBar rate={row.original.rate} /> },
  {
    id: "expectedRate",
    header: "Dự kiến (tính cả chờ phát lại)",
    meta: { align: "right" },
    cell: ({ row }) => {
      const r = row.original;
      if (r.expectedRate === null) return <span className="text-xs text-muted-foreground">—</span>;
      const up = r.rate !== null && r.expectedRate > r.rate + 0.05;
      return (
        <span className={cn("numeric text-sm font-semibold", rateTone(r.expectedRate))} title={`(${r.returned} hoàn + ${r.failed} chờ phát lại × xác suất) ÷ (${r.delivered} giao thật + ${r.returned} hoàn + ${r.failed} chờ phát lại)`}>
          {r.expectedRate.toFixed(1)}%{up ? " ↑" : ""}
        </span>
      );
    },
  },
  {
    id: "lostRevenue",
    header: "Doanh thu hoàn",
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <Money value={row.original.lostRevenue} className={row.original.lostRevenue ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground"} />
        <div className="text-[10.5px] text-muted-foreground">{formatNumber(row.original.returnedQty)} sp</div>
      </div>
    ),
  },
];

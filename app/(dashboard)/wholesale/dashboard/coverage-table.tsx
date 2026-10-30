import { formatDate, formatNumber } from "@/lib/format";
import type { CoverageProvince } from "@/lib/queries/wholesale";
import { cn } from "@/lib/utils";

/** Độ phủ theo tỉnh, mở từng tỉnh để xem khu vực. Server component — chỉ hiển thị. */
export function CoverageTable({ provinces }: { provinces: CoverageProvince[] }) {
  return (
    <div className="space-y-1.5">
      {provinces.map((p) => (
        <details key={p.key} className="rounded-md border">
          <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
            <span className="w-40 shrink-0 font-medium">{p.label}</span>
            <span className="relative h-2 flex-1 overflow-hidden rounded bg-muted">
              <span className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${Math.min(100, p.pct ?? 0)}%` }} />
            </span>
            <span className="w-16 text-right tabular-nums font-semibold">{p.pct == null ? "—" : `${p.pct.toLocaleString("vi-VN")}%`}</span>
            <span className="hidden w-40 text-right text-xs text-muted-foreground sm:block">
              {formatNumber(p.scanned)}/{formatNumber(p.total)} ô · {formatNumber(p.newLeads)} lead
            </span>
          </summary>
          <table className="w-full border-t text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-3 py-1 text-left font-medium">Khu vực</th>
                <th className="px-3 py-1 text-right font-medium">Từ khoá đã quét</th>
                <th className="px-3 py-1 text-right font-medium">Lead mới</th>
                <th className="px-3 py-1 text-right font-medium">Quét gần nhất</th>
              </tr>
            </thead>
            <tbody>
              {p.areas.map((a) => (
                <tr key={a.code} className="border-t">
                  <td className="px-3 py-1">{a.name}</td>
                  <td className={cn("px-3 py-1 text-right tabular-nums", a.scanned === 0 && "text-muted-foreground")}>
                    {a.scanned}/{a.total}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">{formatNumber(a.newLeads)}</td>
                  <td className="px-3 py-1 text-right">{a.lastScannedAt ? formatDate(a.lastScannedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

import { NAV_TITLES } from "@/components/app-sidebar";
import { EmptyState } from "@/components/ui-bits";
import { MODULE_GROUPS } from "@/lib/constants/department-modules";
import type { PageUsageSummary } from "@/lib/constants/page-usage";
import { formatDate, formatNumber } from "@/lib/format";

const GROUP_OF: Record<string, string> = Object.fromEntries(MODULE_GROUPS.flatMap((g) => g.items.map((i) => [i.href, g.label])));

/**
 * Bảng lượt mở trang — ÍT DÙNG NHẤT LÊN ĐẦU. Chỉ in số, không kết luận: một trang chốt lương mở
 * mỗi tháng một lần vẫn là trang cần có (`lib/constants/page-usage.ts`).
 */
export function PageUsageTable({ summary }: { summary: PageUsageSummary }) {
  if (summary.measuredDays === 0) {
    return <EmptyState title="Chưa có số đo" description="Bộ đếm bắt đầu từ lần triển khai này. Quay lại sau vài ngày — trước ngày đầu tiên có số, lượt mở là CHƯA BIẾT chứ không phải 0." />;
  }
  return (
    <div className="max-h-[520px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
          <tr className="border-b border-hairline text-left">
            <th className="px-3 py-2 font-medium">Trang</th>
            <th className="px-3 py-2 font-medium">Nhóm menu</th>
            <th className="px-3 py-2 text-right font-medium">Lượt mở</th>
            <th className="px-3 py-2 text-right font-medium">Ngày có lượt</th>
            <th className="px-3 py-2 text-right font-medium">Lần cuối</th>
          </tr>
        </thead>
        <tbody>
          {summary.lines.map((l) => (
            <tr key={l.key} className="border-b border-hairline/60 last:border-0">
              <td className="px-3 py-1.5">
                <a href={l.key} className="hover:underline">
                  {NAV_TITLES[l.key] ?? l.key}
                </a>
                <span className="ml-2 text-xs text-muted-foreground">{l.key}</span>
              </td>
              <td className="px-3 py-1.5 text-muted-foreground">{GROUP_OF[l.key] ?? "Trang vào từ trang cha"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(l.visits)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatNumber(l.activeDays)}/{summary.measuredDays}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{l.lastDay ? formatDate(l.lastDay) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

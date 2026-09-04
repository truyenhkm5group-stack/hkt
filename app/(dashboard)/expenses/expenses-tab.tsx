import { Layers, ReceiptText } from "lucide-react";
import { ExpensesTable } from "@/app/(dashboard)/expenses/expenses-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { formatNumber, formatVND, pct } from "@/lib/format";
import { EXPENSE_SORTABLE, expenseFacets, expenseSummary, listExpenses } from "@/lib/queries/expenses";
import { parseListParams, type Period, type SearchParams } from "@/lib/search-params";

function change(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export async function ExpensesTab({ raw, period, canWrite }: { raw: SearchParams; period: Period; canWrite: boolean }) {
  const params = parseListParams(raw, { defaultSort: "occurredAt", filterKeys: ["category"], sortable: EXPENSE_SORTABLE, defaultPeriod: "month" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listExpenses(params), expenseFacets(params), expenseSummary(period)]);
  const top = summary.byCategory.slice(0, 3);
  const tones = ["blue", "amber", "slate"] as const;

  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={`Tổng chi phí · ${period.label.toLowerCase()}`} value={formatVND(summary.total, { compact: true })} change={change(summary.total, summary.previousTotal)} note={`${formatNumber(summary.totalCount)} khoản chi · ${summary.byCategory.length} nhóm`} icon={ReceiptText} tone="rose" />
        {top.map((row, i) => (
          <MetricCard key={row.category} label={row.label} value={formatVND(row.amount, { compact: true })} note={`${pct(row.amount, summary.total).toFixed(1)}% tổng chi phí · ${formatNumber(row.count)} khoản`} icon={Layers} tone={tones[i]} />
        ))}
        {[...Array(Math.max(0, 3 - top.length)).keys()].map((i) => (
          <MetricCard key={`empty-${i}`} label="Nhóm chi phí" value={<span className="text-muted-foreground">—</span>} note="Chưa có dữ liệu trong kỳ" icon={Layers} tone="slate" />
        ))}
      </section>

      <DataTableToolbar
        searchPlaceholder="Mô tả, tham chiếu, người tạo…"
        period={{ defaultKey: "month" }}
        facets={[{ key: "category", label: "Nhóm chi phí", options: facets.categories }]}
        resultLabel={`${formatNumber(total)} khoản chi phù hợp`}
      />
      <ExpensesTable rows={rows} pageCount={pageCount} total={total} canWrite={canWrite} />
    </div>
  );
}

import { CircleDollarSign, Megaphone, ShoppingBag, Target, TrendingUp } from "lucide-react";
import { AdSpendsTable } from "@/app/(dashboard)/expenses/expenses-table";
import { AdsChart } from "@/components/charts/ads-chart";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatVND } from "@/lib/format";
import { AD_SORTABLE, adDailyByPlatform, adFacets, adSummary, listAdSpends } from "@/lib/queries/expenses";
import { parseListParams, type Period, type SearchParams } from "@/lib/search-params";

function change(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export async function AdsTab({ raw, period, canWrite }: { raw: SearchParams; period: Period; canWrite: boolean }) {
  const params = parseListParams(raw, { defaultSort: "spendDate", filterKeys: ["platform"], sortable: AD_SORTABLE, defaultPeriod: "month" });
  const [{ rows, total, pageCount }, facets, summary, daily] = await Promise.all([listAdSpends(params), adFacets(params), adSummary(period), adDailyByPlatform(period)]);
  const prev = summary.previous;

  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label={`Tổng chi QC · ${period.label.toLowerCase()}`} value={formatVND(summary.spend, { compact: true })} change={change(summary.spend, prev?.spend)} note={`${formatNumber(summary.rows)} dòng · ${formatNumber(summary.leads)} leads`} icon={Megaphone} tone="rose" />
        <MetricCard label="Đơn từ quảng cáo" value={formatNumber(summary.orders)} change={change(summary.orders, prev?.orders)} note={summary.leads ? `Tỷ lệ chốt ${((summary.orders / summary.leads) * 100).toFixed(1)}% trên lead` : "Chưa ghi nhận lead"} icon={ShoppingBag} tone="blue" />
        <MetricCard label="Doanh thu ghi nhận" value={formatVND(summary.revenue, { compact: true })} change={change(summary.revenue, prev?.revenue)} note="Doanh thu do nền tảng quảng cáo báo cáo" icon={CircleDollarSign} tone="green" />
        <MetricCard label="ROAS" value={summary.roas ? `${summary.roas.toFixed(2)}×` : "—"} change={prev && prev.roas ? change(summary.roas, prev.roas) : null} note="Doanh thu ÷ chi tiêu" icon={TrendingUp} tone={summary.roas >= 3 ? "green" : summary.roas >= 1.5 || !summary.roas ? "primary" : "rose"} />
        <MetricCard label="CPO (chi phí / đơn)" value={summary.cpo ? formatVND(summary.cpo, { compact: true }) : "—"} note={summary.orders ? `${formatVND(summary.cpo)} mỗi đơn${prev?.cpo ? ` · kỳ trước ${formatVND(prev.cpo, { compact: true })}` : ""}` : "Chi tiêu ÷ số đơn · chưa có đơn"} icon={Target} tone="amber" />
      </section>

      <SectionCard title="Chi tiêu theo ngày" description="Cột chồng theo nền tảng quảng cáo" actions={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{period.label}</span>}>
        <AdsChart data={daily.data} platforms={daily.platforms} />
      </SectionCard>

      <DataTableToolbar
        searchPlaceholder="Chiến dịch, ghi chú, nền tảng…"
        period={{ defaultKey: "month" }}
        facets={[{ key: "platform", label: "Nền tảng", options: facets.platforms }]}
        resultLabel={`${formatNumber(total)} dòng chi tiêu phù hợp`}
      />
      <AdSpendsTable rows={rows} pageCount={pageCount} total={total} canWrite={canWrite} />
    </div>
  );
}

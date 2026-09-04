import { CircleDollarSign, Megaphone, ShoppingBag, Target, TrendingUp } from "lucide-react";
import { CampaignMapping } from "@/app/(dashboard)/expenses/campaign-mapping";
import { EmployeeDialog } from "@/app/(dashboard)/payroll/employee-dialog";
import { AdSpendsTable } from "@/app/(dashboard)/expenses/expenses-table";
import { SyncButton } from "@/components/sync-button";
import { loadAdsMapping } from "@/lib/integrations/facebook/mapping";
import { listCampaignsForMapping, listProductsForMapping } from "@/lib/queries/ads-mapping";
import { listAdAccounts, listEmployees } from "@/lib/queries/payroll";
import { integrationStatus } from "@/lib/env";
import { AdsChart } from "@/components/charts/ads-chart";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatVND } from "@/lib/format";
import { AD_FILTER_NONE, AD_FILTER_TEST, AD_SORTABLE, adDailyByPlatform, adFacets, adSummary, listAdSpends } from "@/lib/queries/expenses";
import { parseListParams, type Period, type SearchParams } from "@/lib/search-params";

function change(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export async function AdsTab({ raw, period, canWrite, canManageEmployees }: { raw: SearchParams; period: Period; canWrite: boolean; canManageEmployees: boolean }) {
  const params = parseListParams(raw, { defaultSort: "spendDate", filterKeys: ["platform", "account", "marketer", "product"], sortable: AD_SORTABLE, defaultPeriod: "month" });
  const [{ rows, total, pageCount }, facets, summary, daily, campaigns, products, mapping, employees, accounts] = await Promise.all([listAdSpends(params), adFacets(params), adSummary(period, params.filters), adDailyByPlatform(period, params.filters), listCampaignsForMapping(period, params.filters), listProductsForMapping(), loadAdsMapping(), listEmployees(), listAdAccounts()]);
  const prev = summary.previous;
  const fb = integrationStatus().facebook;
  const activeMarketers = employees.filter((e) => e.active);
  const hasFilter = Object.values(params.filters).some((v) => v.length) || Boolean(params.q);
  const toolbar = (
    <DataTableToolbar
      searchPlaceholder="Chiến dịch, ghi chú, nền tảng…"
      period={{ defaultKey: "month" }}
      facets={[
        { key: "account", label: "Tài khoản QC", options: accounts.map((a) => ({ value: a.id, label: a.name })) },
        { key: "marketer", label: "Marketer", options: [...activeMarketers.map((e) => ({ value: e.id, label: e.shortName || e.name })), { value: AD_FILTER_NONE, label: "Chưa gán marketer" }] },
        { key: "product", label: "Mã hàng", options: [...products.map((p) => ({ value: p.id, label: p.code ? `${p.code} · ${p.name}` : p.name })), { value: AD_FILTER_TEST, label: "Chi phí test (không thuộc mã)" }] },
        { key: "platform", label: "Nền tảng", options: facets.platforms },
      ]}
      resultLabel={`${period.label} · ${formatNumber(total)} dòng chi tiêu phù hợp${hasFilter ? " · KPI, biểu đồ và bảng ghép chiến dịch bên dưới đang tính theo bộ lọc" : ""}`}
    />
  );

  return (
    <div className="space-y-5">
      {toolbar}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label={`Tổng chi QC · ${period.label.toLowerCase()}`} value={formatVND(summary.spend, { compact: true })} change={change(summary.spend, prev?.spend)} note={`${formatNumber(summary.rows)} dòng · ${formatNumber(summary.leads)} leads`} icon={Megaphone} tone="rose" />
        <MetricCard label="Đơn từ quảng cáo" value={formatNumber(summary.orders)} change={change(summary.orders, prev?.orders)} note={summary.leads ? `Tỷ lệ chốt ${((summary.orders / summary.leads) * 100).toFixed(1)}% trên lead` : "Chưa ghi nhận lead"} icon={ShoppingBag} tone="blue" />
        <MetricCard label="Doanh thu ghi nhận" value={formatVND(summary.revenue, { compact: true })} change={change(summary.revenue, prev?.revenue)} note="Doanh thu do nền tảng quảng cáo báo cáo" icon={CircleDollarSign} tone="green" />
        <MetricCard label="ROAS" value={summary.roas ? `${summary.roas.toFixed(2)}×` : "—"} change={prev && prev.roas ? change(summary.roas, prev.roas) : null} note="Doanh thu ÷ chi tiêu" icon={TrendingUp} tone={summary.roas >= 3 ? "green" : summary.roas >= 1.5 || !summary.roas ? "primary" : "rose"} />
        <MetricCard label="CPO (chi phí / đơn)" value={summary.cpo ? formatVND(summary.cpo, { compact: true }) : "—"} note={summary.orders ? `${formatVND(summary.cpo)} mỗi đơn${prev?.cpo ? ` · kỳ trước ${formatVND(prev.cpo, { compact: true })}` : ""}` : "Chi tiêu ÷ số đơn · chưa có đơn"} icon={Target} tone="amber" />
      </section>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-[13px]">
        <div className="flex-1 text-muted-foreground">
          {integrationStatus().facebook ? (
            <>
              <b className="text-foreground">Facebook Ads tự động:</b> chi tiêu theo ngày × chiến dịch của mọi tài khoản trong Business Manager được kéo mỗi giờ và đối chiếu lại 30 ngày lúc 04:00. Tên chiến dịch chứa mã hàng (VD “Q002”) sẽ được ghép vào báo cáo lợi nhuận theo mã.
            </>
          ) : (
            <>
              <b className="text-foreground">Chưa kết nối Facebook Ads.</b> Thêm <code>FACEBOOK_ACCESS_TOKEN</code> (token System User của Business Manager, quyền ads_read + business_management) vào cấu hình để tự động kéo chi tiêu. Trong lúc chờ, nhập tay bằng nút “Thêm chi tiêu”.
            </>
          )}
        </div>
      </div>

      <SectionCard title="Chi tiêu theo ngày" description="Cột chồng theo nền tảng quảng cáo" actions={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{period.label}</span>}>
        <AdsChart data={daily.data} platforms={daily.platforms} />
      </SectionCard>

      <SectionCard
        title="Ghép chiến dịch Facebook → mã hàng"
        description={fb ? "Chi tiêu được tự kéo từ Business Manager mỗi giờ. Ghép từng chiến dịch với mã hàng và marketer để tính lợi nhuận theo mã / theo người; chiến dịch không thuộc mã nào = chi phí test; chiến dịch của shop khác chọn “Không tính”." : "Chưa cấu hình FACEBOOK_ACCESS_TOKEN — xem Kết nối dữ liệu."}
        actions={
          <div className="flex flex-wrap gap-2">
            {canManageEmployees ? <EmployeeDialog accounts={accounts} preset={{}} triggerLabel="Thêm marketer" /> : null}
            {fb ? <SyncButton job="facebook-ads" label="Đồng bộ Facebook Ads" /> : null}
          </div>
        }
      >
        <CampaignMapping rows={campaigns} products={products} aliases={mapping.aliases} marketers={activeMarketers.map((e) => ({ id: e.id, name: e.shortName || e.name }))} canWrite={canWrite} periodLabel={period.label} />
      </SectionCard>

      <AdSpendsTable rows={rows} pageCount={pageCount} total={total} canWrite={canWrite} />
    </div>
  );
}

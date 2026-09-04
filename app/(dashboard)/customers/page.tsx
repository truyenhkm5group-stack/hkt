import { Repeat, RotateCcw, UserPlus, Users } from "lucide-react";
import { CustomersTable } from "@/app/(dashboard)/customers/customers-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { formatNumber, formatVND, pct } from "@/lib/format";
import { customerFacets, customerSummary, CUSTOMER_SORTABLE, listCustomers } from "@/lib/queries/customers";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Khách hàng" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("customers:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "lastOrderAt", filterKeys: ["province", "tier"], sortable: CUSTOMER_SORTABLE, defaultPeriod: "all" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listCustomers(params), customerFacets(params), customerSummary(params)]);
  const returnRate = pct(summary.returned, summary.orders);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Khách hàng"
        description={`${formatNumber(summary.total)} khách · ${formatNumber(summary.withOrders)} khách đã mua · tổng mua ${formatVND(summary.amount, { compact: true })} · số liệu Pancake kết hợp đơn hàng trong ERP`}
        actions={<SyncButton job="pancake-customers" label="Đồng bộ khách hàng" />}
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Tổng khách hàng" value={formatNumber(summary.total)} note={`${formatNumber(summary.withOrders)} khách có đơn · ${formatNumber(summary.orders)} đơn`} icon={Users} tone="blue" />
        <MetricCard label="Khách mới" value={formatNumber(summary.newInPeriod)} note={`Tạo trên Pancake ${summary.newLabel}`} icon={UserPlus} tone="green" />
        <MetricCard label="Khách mua lại" value={formatNumber(summary.repeat)} note={`Từ 2 đơn trở lên · ${pct(summary.repeat, summary.withOrders).toFixed(1)}% khách đã mua`} icon={Repeat} tone="primary" />
        <MetricCard label="Tỷ lệ hoàn" value={`${returnRate.toFixed(1)}%`} note={`${formatNumber(summary.returned)} đơn hoàn / ${formatNumber(summary.orders)} đơn`} icon={RotateCcw} tone={returnRate >= 10 ? "rose" : "amber"} />
      </section>

      <DataTableToolbar
        searchPlaceholder="Tên khách, số điện thoại…"
        period={{ defaultKey: "all" }}
        facets={[
          { key: "tier", label: "Nhóm khách", options: facets.tiers, single: true },
          { key: "province", label: "Tỉnh/TP", options: facets.provinces },
        ]}
        resultLabel={`${formatNumber(total)} khách phù hợp`}
      />
      <CustomersTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

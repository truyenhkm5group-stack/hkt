import { Percent, ReceiptText, RotateCcw } from "lucide-react";
import { ReturnsTable } from "@/app/(dashboard)/returns/returns-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { formatNumber, formatVND } from "@/lib/format";
import { listReturns, returnFacets, returnSummary, RETURN_SORTABLE } from "@/lib/queries/returns";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Đổi / trả hàng" };

export default async function ReturnsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("returns:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "insertedAt", filterKeys: ["type"], sortable: RETURN_SORTABLE, defaultPeriod: "30d" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listReturns(params), returnFacets(params), returnSummary(params)]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bán hàng"
        title="Đổi / trả hàng"
        description={`Phiếu đổi/trả ghi nhận trên Pancake POS · ${params.period.label.toLowerCase()} · ${formatNumber(summary.total)} phiếu trên ${formatNumber(summary.orders)} đơn`}
        actions={<SyncButton job="pancake-returns" label="Đồng bộ đổi/trả" />}
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Số phiếu đổi/trả" value={formatNumber(summary.total)} note={`${formatNumber(summary.exchanges)} đổi hàng · ${formatNumber(summary.total - summary.exchanges)} trả hàng`} icon={RotateCcw} tone="amber" />
        <MetricCard label="Tổng phí hoàn" value={formatVND(summary.returnedFee, { compact: true })} note={`Giảm giá trên phiếu ${formatVND(summary.discount, { compact: true })}`} icon={ReceiptText} tone="rose" />
        <MetricCard label="Tỷ lệ hoàn" value={`${summary.rate.toFixed(1)}%`} note={`${formatNumber(summary.total)} phiếu / ${formatNumber(summary.orders)} đơn tạo trong kỳ (không tính đơn huỷ)`} icon={Percent} tone={summary.rate > 10 ? "rose" : "slate"} />
      </section>

      <DataTableToolbar
        searchPlaceholder="Số phiếu, mã đơn, SĐT, tên khách…"
        period={{ defaultKey: "30d" }}
        facets={[{ key: "type", label: "Loại", options: facets.types, single: true }]}
        resultLabel={`${formatNumber(total)} phiếu phù hợp · phí hoàn ${formatVND(summary.returnedFee)}`}
      />
      <ReturnsTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

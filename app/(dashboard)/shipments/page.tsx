import { ShipmentsTable } from "@/app/(dashboard)/shipments/shipments-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { formatNumber, formatVND } from "@/lib/format";
import { listShipments, shipmentFacets, shipmentSummary, SHIPMENT_SORTABLE } from "@/lib/queries/shipments";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Vận đơn" };

export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("shipments:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["stage", "carrier", "cod", "final", "linked"], sortable: SHIPMENT_SORTABLE, defaultPeriod: "30d" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listShipments(params), shipmentFacets(params), shipmentSummary(params)]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận chuyển"
        title="Vận đơn"
        description={`${formatNumber(summary.total)} vận đơn · COD chưa thu ${formatVND(summary.codPending, { compact: true })} (${formatNumber(summary.codPendingCount)} đơn) · ${formatNumber(summary.delivering)} đang giao · ${formatNumber(summary.failed)} giao thất bại`}
        actions={
          <>
            <SyncButton job="vtp-import" label="Nhập từ tài khoản Viettel Post" params={{ days: "30" }} />
            <SyncButton job="vtp-tracking" label="Cập nhật vận đơn đang giao" />
          </>
        }
      />
      <DataTableToolbar
        searchPlaceholder="Mã vận đơn, mã VTP, SĐT, tên người nhận, mã đơn…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "stage", label: "Trạng thái", options: facets.stages },
          { key: "carrier", label: "ĐVVC", options: facets.carriers },
          { key: "cod", label: "COD", options: facets.codStatuses },
          { key: "final", label: "Theo dõi", options: facets.finals, single: true },
          { key: "linked", label: "Nguồn đơn", options: facets.linked, single: true },
        ]}
        resultLabel={`${formatNumber(total)} vận đơn phù hợp · ${formatNumber(summary.delivered)} giao thành công (COD thực > 100K) · ${formatNumber(summary.returning)} hoàn / không thu được tiền`}
      />
      <ShipmentsTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

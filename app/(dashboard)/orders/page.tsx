import { Download } from "lucide-react";
import { OrdersTable } from "@/app/(dashboard)/orders/orders-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { Button } from "@/components/ui/button";
import { formatNumber, formatVND } from "@/lib/format";
import { listOrders, orderFacets, orderSummary, ORDER_SORTABLE } from "@/lib/queries/orders";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Đơn hàng" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "carrier", "seller", "payment", "tag"], sortable: ORDER_SORTABLE, defaultPeriod: "30d" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listOrders(params), orderFacets(params), orderSummary(params)]);
  const exportQuery = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : []))).toString();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bán hàng"
        title="Đơn hàng"
        description={`${formatNumber(summary.orders)} đơn · doanh thu ${formatVND(summary.revenue)} · ${formatNumber(summary.success)} giao thành công · COD ${formatVND(summary.cod, { compact: true })}`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/export/orders?${exportQuery}`}>
                <Download className="size-4" /> Xuất CSV
              </a>
            </Button>
            <SyncButton job="pancake-orders" label="Đồng bộ đơn" />
          </>
        }
      />
      <DataTableToolbar
        searchPlaceholder="Mã đơn, SĐT, tên khách, mã vận đơn, SKU…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "stage", label: "Trạng thái", options: facets.stages },
          { key: "source", label: "Kênh bán", options: facets.sources },
          { key: "carrier", label: "ĐVVC", options: facets.carriers },
          { key: "payment", label: "Thanh toán", options: [{ value: "cod", label: "Thu hộ COD" }, { value: "prepaid", label: "Đã thanh toán trước" }], single: true },
          ...(facets.sellers.length ? [{ key: "seller", label: "Nhân viên", options: facets.sellers }] : []),
        ]}
        resultLabel={`${formatNumber(total)} đơn phù hợp · ${formatNumber(summary.quantity)} sản phẩm`}
      />
      <OrdersTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

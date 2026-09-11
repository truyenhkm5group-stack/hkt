import { Download } from "lucide-react";
import { OrdersTable } from "@/app/(dashboard)/orders/orders-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { SyncButton } from "@/components/sync-button";
import { Button } from "@/components/ui/button";
import { formatNumber, formatVND } from "@/lib/format";
import { listOrders, orderFacets, orderSummary, ORDER_SORTABLE } from "@/lib/queries/orders";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Đơn hàng" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("orders:read");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "carrier", "seller", "payment", "tag", "address"], sortable: ORDER_SORTABLE, defaultPeriod: "30d" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listOrders(params), orderFacets(params), orderSummary(params)]);
  const exportQuery = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : []))).toString();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bán hàng"
        title="Đơn hàng"
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
      {/*
        BỐN CON SỐ CỦA BỘ LỌC HIỆN TẠI, ĐỌC ĐƯỢC BẰNG MẮT LƯỚT.
        Trước đây cùng bốn số này nằm trong một câu chữ xám dưới tiêu đề — "1.234 đơn · doanh thu
        … · 900 giao thành công · COD …" — muốn lấy một số phải đọc cả câu. Dải ô cho mỗi số một
        chỗ đứng, và số đơn không còn bị nhắc lại lần nữa ở dòng kết quả bên dưới.
      */}
      <StatStrip
        items={[
          { label: "Đơn trong bộ lọc", value: formatNumber(summary.orders), note: `${formatNumber(summary.quantity)} sản phẩm` },
          { label: "Doanh thu lên đơn", value: formatVND(summary.revenue, { compact: true }), hint: "Tiền khách chốt lúc lên đơn, chưa nói gì về việc giao được hay thu được tiền." },
          { label: "Giao thành công", value: formatNumber(summary.success), tone: "green", hint: "Kết luận theo chứng từ Viettel Post rồi tới COD thực thu — không theo trạng thái Pancake." },
          { label: "COD", value: formatVND(summary.cod, { compact: true }), hint: "Tổng tiền thu hộ khai báo trên các đơn đang lọc. Đã thu được bao nhiêu thì xem Đối soát COD." },
        ]}
      />
      <DataTableToolbar
        searchPlaceholder="Mã đơn, SĐT, tên khách, mã vận đơn, SKU…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "stage", label: "Trạng thái", options: facets.stages },
          { key: "source", label: "Kênh bán", options: facets.sources },
          { key: "carrier", label: "ĐVVC", options: facets.carriers },
          { key: "payment", label: "Thanh toán", options: [{ value: "cod", label: "Thu hộ COD" }, { value: "prepaid", label: "Đã thanh toán trước" }], single: true },
          { key: "address", label: "Địa chỉ", options: [{ value: "unnormalized", label: `Chưa chuẩn hoá · không giao được (${formatNumber(summary.unnormalizedAddress)})` }, { value: "normalized", label: "Đã chuẩn hoá" }], single: true },
          ...(facets.sellers.length ? [{ key: "seller", label: "Nhân viên", options: facets.sellers }] : []),
        ]}
        resultLabel={total === summary.orders ? undefined : `${formatNumber(total)} đơn phù hợp`}
      />
      <OrdersTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

import Link from "next/link";
import { AlertTriangle, Boxes, Download, Info, PackagePlus, PackageX, ShoppingBag, Warehouse } from "lucide-react";
import { ProductsTable } from "@/app/(dashboard)/products/products-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { Button } from "@/components/ui/button";
import { formatNumber, formatVND } from "@/lib/format";
import { listProducts, listWarehouses, productFacets, productSummary, PRODUCT_SORTABLE } from "@/lib/queries/products";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Sản phẩm & tồn kho" };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("products:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "erpStock", defaultDir: "asc", filterKeys: ["stock", "category", "warehouse", "status"], sortable: PRODUCT_SORTABLE, defaultPeriod: "all" });
  const [{ rows, total, pageCount }, facets, summary, warehouses] = await Promise.all([listProducts(params), productFacets(params), productSummary(params), listWarehouses()]);
  const exportQuery = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : []))).toString();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Sản phẩm & tồn kho"
        description={`${formatNumber(summary.products)} sản phẩm · ${formatNumber(summary.selling)} mẫu mã đang bán · ${formatNumber(summary.stockUnits)} sản phẩm trong kho · ${warehouses.length} kho`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/export/products?${exportQuery}`}>
                <Download className="size-4" /> Xuất CSV
              </a>
            </Button>
            <Button asChild size="sm">
              <Link href="/inventory/receipts">
                <PackagePlus className="size-4" /> Nhập hàng / kiểm kê
              </Link>
            </Button>
            <SyncButton job="pancake-products" label="Đồng bộ sản phẩm" />
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Mẫu mã đang bán" value={formatNumber(summary.selling)} note={`${formatNumber(summary.products)} sản phẩm`} icon={Boxes} tone="blue" />
        <MetricCard label="Sắp hết hàng" value={formatNumber(summary.low)} note="Tồn khả dụng ERP từ 1 đến 5" icon={AlertTriangle} tone="amber" />
        <MetricCard
          label="Hết hàng"
          value={formatNumber(summary.out)}
          note={summary.unknownStock ? `Tồn ≤ 0, vẫn đang bán · ${formatNumber(summary.unknownStock)} mẫu mã CHƯA tính được tồn (chưa có phiếu nhập)` : "Tồn ≤ 0, vẫn đang bán"}
          icon={PackageX}
          tone={summary.out > 0 ? "rose" : "slate"}
        />
        <MetricCard label="Giá trị tồn kho" value={formatVND(summary.stockValue, { compact: true })} note={`${formatNumber(summary.stockUnits)} sản phẩm × giá nhập gần nhất`} icon={Warehouse} tone="primary" />
        <MetricCard label="Đã xuất kho" value={formatNumber(summary.shipped)} note={`Nhập mới ${formatNumber(summary.receiptIn)} · tái nhập ${formatNumber(summary.returnIn)} · hoàn chờ nhận ${formatNumber(summary.awaitingReturn)}${summary.shrinkage ? ` · hụt ${formatNumber(summary.shrinkage)}` : ""}`} icon={ShoppingBag} tone="green" />
      </section>

      <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-3.5 text-[13px] text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div>
          <b className="text-foreground">Sổ kho</b>: <b className="text-foreground">Tồn thực tế</b> = Nhập mới + Tái nhập + Điều chỉnh − Xuất tay − <b className="text-foreground">Đã xuất</b>; <b className="text-foreground">Khả dụng bán</b> = Tồn thực tế − hàng đã chốt đơn chờ xuất. “Đã xuất” đếm theo xác nhận <b className="text-foreground">lấy hàng của Viettel Post</b>, không theo trạng thái Pancake và không theo tiền COD. Hàng hoàn chỉ quay lại tồn khi kho lập <Link href="/inventory/receipts" className="font-semibold text-primary hover:underline">phiếu tái nhập</Link> với số đếm thực tế — ĐVVC báo “đã hoàn” mới chỉ là hàng đang trên đường về. Mẫu mã chưa có phiếu nhập thì ERP báo “Chưa có phiếu nhập” thay vì hiện số bịa.</div>
      </div>

      <DataTableToolbar
        searchPlaceholder="Tên sản phẩm, SKU, barcode, màu, size…"
        period={false}
        facets={[
          { key: "stock", label: "Tồn kho", options: facets.stock, single: true },
          { key: "category", label: "Danh mục", options: facets.categories },
          { key: "warehouse", label: "Kho", options: facets.warehouses },
          { key: "status", label: "Trạng thái", options: facets.status, single: true },
        ]}
        resultLabel={`${formatNumber(total)} mẫu mã phù hợp`}
      />
      <ProductsTable rows={rows} pageCount={pageCount} total={total} warehouses={warehouses} />
    </div>
  );
}

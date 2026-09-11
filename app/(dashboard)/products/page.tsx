import Link from "next/link";
import { AlertTriangle, Boxes, Download, PackagePlus, PackageX, ShoppingBag, Warehouse } from "lucide-react";
import { ProductsTable } from "@/app/(dashboard)/products/products-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
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
        description={`${formatNumber(warehouses.length)} kho`}
        hint={
          <>
            <b>SỔ KHO.</b> <b>Tồn thực tế</b> = Nhập mới + Tái nhập + Điều chỉnh − Xuất tay −{" "}
            <b>Đã xuất</b>; <b>Khả dụng bán</b> = Tồn thực tế − hàng đã chốt đơn chờ xuất.
            &ldquo;Đã xuất&rdquo; đếm theo xác nhận <b>lấy hàng của Viettel Post</b>, không theo
            trạng thái Pancake và không theo tiền COD. Hàng hoàn chỉ quay lại tồn khi kho lập{" "}
            <b>phiếu tái nhập</b> với số đếm thực tế — ĐVVC báo &ldquo;đã hoàn&rdquo; mới chỉ là
            hàng đang trên đường về. Mẫu mã chưa có phiếu nhập thì ERP báo &ldquo;Chưa có phiếu
            nhập&rdquo; thay vì hiện số bịa.
          </>
        }
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

      {/*
        TRANG KHO MỞ RA LÀ THẤY VIỆC, KHÔNG PHẢI THẤY BÀI GIẢNG.
        Trước đây năm thẻ bằng nhau — "mẫu mã đang bán" (thông tin nền) to ngang "hết hàng" (việc
        phải làm hôm nay) — và ngay dưới là năm dòng văn xuôi giảng công thức sổ kho, chiếm chỗ mọi
        lúc dù chỉ cần đọc một lần. Nay hai câu hỏi hành động đứng trước ở cỡ lớn và BẤM ĐƯỢC (mở
        thẳng danh sách mẫu mã tương ứng), phần nền gom vào dải mảnh, còn công thức sổ kho chuyển
        nguyên văn vào dấu ⓘ cạnh tiêu đề — vẫn tra được bất cứ lúc nào, không còn chắn màn hình.
      */}
      <section className="grid gap-4 lg:grid-cols-3">
        <MetricCard
          size="lg"
          label="Hết hàng"
          value={formatNumber(summary.out)}
          note={summary.unknownStock ? `Tồn ≤ 0, vẫn đang bán · ${formatNumber(summary.unknownStock)} mẫu mã CHƯA tính được tồn (chưa có phiếu nhập)` : "Tồn ≤ 0, vẫn đang bán"}
          hint="Mẫu mã vẫn đang bày bán mà tồn khả dụng đã về 0 hoặc âm — mỗi đơn chốt thêm là một đơn có nguy cơ phải huỷ. Mẫu mã chưa có phiếu nhập nào KHÔNG nằm ở đây: chúng là CHƯA BIẾT tồn, không phải hết hàng."
          icon={PackageX}
          tone={summary.out > 0 ? "rose" : "slate"}
          href="/products?stock=out"
        />
        <MetricCard
          size="lg"
          label="Sắp hết hàng"
          value={formatNumber(summary.low)}
          note="Tồn khả dụng ERP từ 1 đến 5"
          hint="Còn hàng nhưng chỉ đủ vài đơn nữa. Đây là danh sách cần đặt sản xuất hoặc nhập bổ sung trước khi nó rơi xuống nhóm hết hàng."
          icon={AlertTriangle}
          tone={summary.low > 0 ? "amber" : "slate"}
          href="/products?stock=low"
        />
        <MetricCard
          size="lg"
          label="Giá trị tồn kho"
          value={formatVND(summary.stockValue, { compact: true })}
          note={`${formatNumber(summary.stockUnits)} sản phẩm × giá nhập gần nhất`}
          hint="Vốn đang nằm trong kho, tính theo giá nhập gần nhất của từng mẫu mã. Không gồm hàng hoàn đang trên đường về vì hàng đó chưa được kho đếm."
          icon={Warehouse}
          tone="primary"
        />
      </section>

      <StatStrip
        columns={3}
        items={[
          { label: "Mẫu mã đang bán", value: formatNumber(summary.selling), note: `trong ${formatNumber(summary.products)} sản phẩm`, icon: Boxes, href: "/products?status=selling" },
          {
            label: "Đã xuất kho",
            value: formatNumber(summary.shipped),
            note: `nhập mới ${formatNumber(summary.receiptIn)} · tái nhập ${formatNumber(summary.returnIn)}${summary.shrinkage ? ` · hụt ${formatNumber(summary.shrinkage)}` : ""}`,
            hint: "Đếm theo xác nhận LẤY HÀNG của Viettel Post — không theo trạng thái Pancake, không theo tiền COD.",
            icon: ShoppingBag,
          },
          {
            label: "Hoàn chờ kho nhận",
            value: formatNumber(summary.awaitingReturn),
            note: "chưa cộng vào tồn",
            hint: "Viettel Post báo đã hoàn nhưng kho chưa lập phiếu tái nhập với số đếm thực tế. Hàng này CHƯA nằm trong tồn khả dụng, và cố ý như vậy.",
            icon: PackagePlus,
            tone: summary.awaitingReturn ? ("amber" as const) : ("muted" as const),
            href: "/inventory/returns",
          },
        ]}
      />

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

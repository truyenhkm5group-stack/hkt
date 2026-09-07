import { notFound } from "next/navigation";
import { ProductionEditor } from "@/app/(dashboard)/inventory/planning/orders/production-editor";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { buildMatrixForProduct } from "@/lib/queries/production";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Bảng chốt đặt hàng" };

export default async function NewProductionOrderPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("planning:write");
  const raw = await searchParams;
  const productId = typeof raw.product === "string" ? raw.product : "";
  // Giữ đúng tham số của bảng kế hoạch vừa xem: số ngày muốn đủ bán và có trừ hàng sắp về hay không.
  const soNgay = Number(typeof raw.ngay === "string" ? raw.ngay : "");
  const m = productId
    ? await buildMatrixForProduct(productId, {
        coverDays: Number.isFinite(soNgay) && soNgay >= 0 ? soNgay : undefined,
        countIncoming: raw.hoan !== "0",
      })
    : null;
  if (!m) notFound();
  const due = new Date(Date.now() + m.leadTimeDays * 86_400_000).toISOString().slice(0, 10);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Kho" title={`Bảng chốt đặt hàng · ${m.product.code ? `${m.product.code} · ` : ""}${m.product.name}`} description={`Số lượng khởi tạo theo đề xuất của ERP cho ${m.coverDays} ngày bán — sửa rồi bấm Chốt.`}
 hint={`Số lượng khởi tạo theo đề xuất của ERP: tồn khả dụng${m.countIncoming ? " cộng hàng đang ở ngoài / chờ hoàn về sắp quay lại kho" : ""}, tốc độ bán, thời gian sản xuất ${m.leadTimeDays} ngày và ${m.coverDays} ngày muốn đủ bán sau khi hàng về. Sửa từng ô rồi bấm Chốt để lưu và in / gửi xưởng.`} />
      <ProductionEditor init={{ product: m.product, colors: m.colors, sizes: m.sizes, cells: m.cells, detail: m.detail, images: m.images, unitCost: m.unitCost, supplier: "", note: "", dueDate: due }} />
    </div>
  );
}

import { notFound } from "next/navigation";
import { ProductionEditor } from "@/app/(dashboard)/inventory/planning/orders/production-editor";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { buildMatrixForProduct } from "@/lib/queries/production";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Bảng chốt đặt hàng" };

export default async function NewProductionOrderPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("inventory:write");
  const raw = await searchParams;
  const productId = typeof raw.product === "string" ? raw.product : "";
  const m = productId ? await buildMatrixForProduct(productId) : null;
  if (!m) notFound();
  const due = new Date(Date.now() + m.leadTimeDays * 86_400_000).toISOString().slice(0, 10);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Kho & tài chính" title={`Bảng chốt đặt hàng · ${m.product.code ? `${m.product.code} · ` : ""}${m.product.name}`} description="Số lượng khởi tạo theo đề xuất của ERP (tồn khả dụng, tốc độ bán, thời gian sản xuất). Sửa từng ô rồi bấm Chốt để lưu và in / gửi xưởng." />
      <ProductionEditor init={{ product: m.product, colors: m.colors, sizes: m.sizes, cells: m.cells, detail: m.detail, images: m.images, unitCost: m.unitCost, supplier: "", note: "", dueDate: due }} />
    </div>
  );
}

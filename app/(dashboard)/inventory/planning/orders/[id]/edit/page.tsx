import { notFound } from "next/navigation";
import { ProductionEditor } from "@/app/(dashboard)/inventory/planning/orders/production-editor";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { buildMatrixForProduct, getProductionOrder } from "@/lib/queries/production";

export default async function EditProductionOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("planning:write");
  const { id } = await params;
  const o = await getProductionOrder(id);
  if (!o) notFound();
  const m = o.productId ? await buildMatrixForProduct(o.productId) : null;
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Kho & tài chính" title={`Sửa ${o.code} · ${o.productName}`} description="Sửa số lượng, ảnh, ghi chú rồi lưu. Bản in và văn bản sao chép sẽ theo số mới." />
      <ProductionEditor init={{ id: o.id, code: o.code, product: { id: o.productId ?? "", name: o.productName, code: o.productCode }, colors: o.colors, sizes: o.sizes, cells: o.cells, detail: m?.detail, images: o.images, unitCost: o.unitCost, supplier: o.supplier, note: o.note, dueDate: o.dueDate ? new Date(o.dueDate).toISOString().slice(0, 10) : "" }} />
    </div>
  );
}

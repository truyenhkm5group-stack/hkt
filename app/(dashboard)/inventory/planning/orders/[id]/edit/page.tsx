import { notFound } from "next/navigation";
import { activeSupplierNames } from "@/lib/queries/suppliers";
import { ProductionEditor } from "@/app/(dashboard)/inventory/planning/orders/production-editor";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { buildMatrixForProduct, getProductionOrder } from "@/lib/queries/production";
import { designOptionsForPo, requireApprovedDesignFlag } from "@/lib/queries/production-os";

export default async function EditProductionOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("planning:write");
  const { id } = await params;
  const o = await getProductionOrder(id);
  if (!o) notFound();
  const [m, designOptions, requireApprovedDesign] = await Promise.all([o.productId ? buildMatrixForProduct(o.productId) : null, designOptionsForPo(o.productId), requireApprovedDesignFlag()]);
  // `unitCost ?? 0`: ô nhập của trình sửa coi 0 là "để trống" — giá NULL (CHƯA BIẾT, vd nháp MOQ §5h) hiện ô trống.
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Kho" title={`Sửa ${o.code} · ${o.productName}`} description="Sửa số lượng, ảnh, ghi chú rồi lưu. Bản in và văn bản sao chép sẽ theo số mới." />
      <ProductionEditor
        init={{
          id: o.id,
          code: o.code,
          product: { id: o.productId ?? "", name: o.productName, code: o.productCode },
          colors: o.colors,
          sizes: o.sizes,
          cells: o.cells,
          detail: m?.detail,
          images: o.images,
          unitCost: o.unitCost ?? 0,
          supplier: o.supplier,
          note: o.note,
          dueDate: o.dueDate ? new Date(o.dueDate).toISOString().slice(0, 10) : "",
          // Lệnh đã có: so với gợi ý ĐÃ LƯU; bấm "Điền theo đề xuất" thì máy chủ tính lại theo căn cứ dưới đây.
          storedSuggestion: o.suggestedCells?.cells ?? null,
          initialFromSuggestion: false,
          suggestionBasis: m ? { coverDays: m.coverDays, countIncoming: m.countIncoming } : undefined,
          overrideReason: o.overrideReason ?? "",
          designOptions,
          designVersionId: o.designVersionId,
          requireApprovedDesign,
        }}
        supplierOptions={await activeSupplierNames()}
      />
    </div>
  );
}

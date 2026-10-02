import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { PriceListEditor } from "@/components/trade/price-list-editor";
import { can, requirePermission } from "@/lib/auth/session";
import { getPriceList } from "@/lib/queries/price-lists";
import { manualOrderFormOptions } from "@/lib/records/order-create";

export const metadata = { title: "Bảng giá" };

/** Tạo (`/products/price-lists/new`) hoặc sửa một bảng giá. Không có `products:write` ⇒ xem các bậc, không sửa. */
export default async function PriceListPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("products:view");
  const { id } = await params;
  const isNew = id === "new";
  const list = isNew ? null : await getPriceList(id);
  if (!isNew && !list) notFound();
  const canEdit = can(user, "products:write");
  if (isNew && !canEdit) notFound();
  const { variants } = await manualOrderFormOptions();
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bảng giá sỉ"
        title={isNew ? "Tạo bảng giá" : list!.name}
        description={list ? `${list.tiers.length} bậc${list.isDefault ? " · mặc định" : ""}${list.active ? "" : " · ngừng dùng"}` : "Đặt tên, chọn mẫu mã và giá theo bậc số lượng"}
      />
      <SectionCard>
        {canEdit ? (
          <PriceListEditor id={isNew ? null : id} active={list?.active ?? true} variants={variants} initial={{ name: list?.name ?? "", note: list?.note ?? "", isDefault: list?.isDefault ?? false, tiers: list?.tiers ?? [] }} />
        ) : (
          <ul className="space-y-1 text-sm">
            {list!.tiers.map((t) => (
              <li key={`${t.variantId}-${t.minQuantity}`}>
                {variants.find((v) => v.id === t.variantId)?.label ?? t.variantId} · từ {t.minQuantity}: {t.unitPrice.toLocaleString("vi-VN")} ₫
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

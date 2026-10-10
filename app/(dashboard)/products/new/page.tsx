import { notFound } from "next/navigation";
import { ProductForm } from "@/app/(dashboard)/products/product-form";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { productCreateGate } from "@/lib/records/product-create";
import { readExperienceProfile } from "@/lib/experience/profile";

export const metadata = { title: "Tạo sản phẩm" };

/**
 * Tạo sản phẩm + mẫu mã TẠO TAY. Trang KHÔNG TỒN TẠI (404) khi tổ chức đang bật `connector_pancake` (sản phẩm do đồng
 * bộ tạo) hoặc người xem thiếu `products:write` — cùng một cổng với nút trên /products và server action
 * (`productCreateGate`), để nút, trang và lượt ghi không nói ba điều khác nhau.
 */
export default async function NewProductPage() {
  const user = await requirePermission("products:view");
  const gate = await productCreateGate(user);
  if (!gate.allowed) notFound();
  // Ô của mẫu mã theo hồ sơ ngành: thời trang Size / Màu · thực phẩm Quy cách / Khối lượng (lib/constants/experience-profile.ts).
  const { profile } = await readExperienceProfile();
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader eyebrow="Kho · Sản phẩm" title="Tạo sản phẩm" description="Mã hàng tạo trên ERP — sau khi tạo, lập phiếu Nhập hàng để có tồn" />
      <SectionCard>
        <ProductForm mode="create" profile={profile} />
      </SectionCard>
    </div>
  );
}

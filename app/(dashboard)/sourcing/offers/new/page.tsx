import { CreateOfferForm } from "@/components/sourcing/offer-forms";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Thêm mẫu nguồn" };

/** Thêm một mẫu vào kho bằng tay (SRC-3): dán link ⇒ ERP đọc nền tảng + mã từ CHỮ của link; bậc giá / MOQ / nhà cung cấp gõ tay. */
export default async function NewSourcingOfferPage() {
  await requirePermission("sourcing:write");
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Tìm hàng nguồn" title="Thêm mẫu" description="Dán link sản phẩm rồi gõ bậc giá, MOQ, nhà cung cấp như trên trang nguồn hôm nay. Mẫu đã có (cùng mã hoặc cùng link) sẽ không bị tạo lần hai." />
      <SectionCard title="Mẫu mới">
        <CreateOfferForm />
      </SectionCard>
    </div>
  );
}

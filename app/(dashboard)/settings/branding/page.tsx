import { BrandingForm } from "@/components/onboarding/branding-form";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { getBranding, getOrgBrand } from "@/lib/branding/service";

export const metadata = { title: "Thương hiệu" };

/**
 * THƯƠNG HIỆU CỦA TỔ CHỨC (Phase 10 · §4) — luôn là tổ chức CỦA NGƯỜI XEM (phiên), không tham số URL nào đổi được.
 * Tổ chức nhà giữ nguyên giao diện hiện tại: trang chỉ nói điều đó, không có ô sửa.
 */
export default async function BrandingPage() {
  const user = await requirePermission("settings:manage");
  const org = user.organization;
  if (!org || org.isHome) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title="Thương hiệu" />
        <EmptyState title="Tổ chức nhà giữ giao diện hiện tại" description="Tên, logo và màu nhấn chỉ đặt được cho tổ chức khác trên nền tảng." />
      </div>
    );
  }
  const [branding, brand] = await Promise.all([getBranding(), getOrgBrand(user)]);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Hệ thống" title="Thương hiệu" description={org.name} />
      <SectionCard title="Tên, màu nhấn và logo" description="Hiện trên thanh đầu và tiêu đề tab cho mọi người trong tổ chức">
        <BrandingForm orgName={org.name} displayName={branding.displayName} accent={branding.accent} logoUrl={brand?.logoUrl ?? null} />
      </SectionCard>
    </div>
  );
}

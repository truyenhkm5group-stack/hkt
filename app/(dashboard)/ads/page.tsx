import { AdSpendDialog } from "@/app/(dashboard)/expenses/ad-spend-dialog";
import { AdsTab } from "@/app/(dashboard)/expenses/ads-tab";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Quảng cáo" };

/** Module Quảng cáo: hiệu suất quảng cáo theo mã hàng & theo marketer (chi tiêu, ROAS, CPO, LN sau QC), tách khỏi kê khai chi phí vận hành. */
export default async function AdsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("expenses:view");
  const canWrite = can(user, "expenses:write");
  const canManageEmployees = can(user, "payroll:manage");
  const period = resolvePeriod(raw, "month");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Quảng cáo"
        description="Hiệu suất quảng cáo theo mã hàng và theo marketer: chi tiêu, đơn đã xác nhận, ROAS, CPO, lợi nhuận sau QC. Chi tiêu Facebook tự kéo mỗi giờ; ghép chiến dịch → mã hàng / marketer ở cuối trang."
        actions={canWrite ? <AdSpendDialog /> : null}
      />
      <AdsTab raw={raw} period={period} canWrite={canWrite} canManageEmployees={canManageEmployees} />
    </div>
  );
}

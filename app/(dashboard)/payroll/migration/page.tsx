import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { MigrationTable } from "@/app/(dashboard)/payroll/migration/migration-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { EmptyState } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { PAYROLL_BASIS_NAME, parsePayrollBasis, type PayrollBasis } from "@/lib/constants/payroll";
import { previewLegacyMigration } from "@/lib/queries/payroll-migration";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Xem trước chuyển đổi lương" };

/**
 * ═══ ĐỌC · TÍNH · SO · RỒI DỪNG LẠI ═══
 *
 * Trang này KHÔNG ghi gì cho tới khi người bấm xác nhận từng người một. Đó là cách giữ lời hứa
 * "không tự động gán chính sách cho toàn bộ nhân sự production" mà vẫn không bắt ai gõ lại bốn ô
 * lương của hai chục người bằng tay.
 */
export default async function PayrollMigrationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  if (!can(user, "payroll:manage")) redirect("/payroll?forbidden=1");
  const period = resolvePeriod(raw, "month");
  const basis: PayrollBasis = parsePayrollBasis(param(raw, "basis"));

  if (!period.from || !period.to || !period.fromKey) {
    return (
      <div className="space-y-5">
        <PageHeader title="Xem trước chuyển đổi lương" description="Chọn một kỳ có mốc đầu và mốc cuối để đối chiếu." />
        <PayrollTabs canManage />
        <DataTableToolbar period={{ defaultKey: "month" }} />
        <EmptyState
          title="Kỳ “Toàn bộ” không đối chiếu được"
          description="Đối chiếu cũ/mới phải đứng trên MỘT kỳ cụ thể: lương cứng chia theo số ngày của kỳ, và lợi nhuận cá nhân cũng là con số của kỳ. Kỳ không có mốc đầu/cuối thì cả hai đều là CHƯA BIẾT. Chọn một tháng ở thanh trên."
        />
      </div>
    );
  }

  const rows = await previewLegacyMigration(period, basis);
  const daChuyen = rows.filter((r) => r.alreadyMigrated).length;
  const lech = rows.filter((r) => r.recon?.hasUnexplained).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Xem trước chuyển đổi lương"
        description={`${period.label} · cơ sở “${PAYROLL_BASIS_NAME[basis]}” · ${rows.length} nhân sự · ${daChuyen} đã chuyển · ${lech} còn lệch chưa giải thích được. Trang này KHÔNG ghi gì cho tới khi bạn xác nhận từng người.`}
      />
      <PayrollTabs canManage />
      <DataTableToolbar period={{ defaultKey: "month" }} />

      <MigrationTable
        rows={rows.map((r) => ({ proposal: r.proposal, recon: r.recon, alreadyMigrated: r.alreadyMigrated, hasEmployment: r.hasEmployment }))}
        effectiveFrom={period.fromKey}
      />
    </div>
  );
}

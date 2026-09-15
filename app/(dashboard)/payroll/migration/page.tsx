import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { MigrationTable } from "@/app/(dashboard)/payroll/migration/migration-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { EmptyState } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { PAYROLL_BASIS_NAME, parsePayrollBasis, type PayrollBasis } from "@/lib/constants/payroll";
import { MIGRATION_STATUS_LABEL, migrationStatus, type MigrationStatus } from "@/lib/payroll/migration-preview";
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
  /* Đếm bằng ĐÚNG hàm mà nhãn trên từng người dùng — hai phép đếm khác nhau thì đầu trang và thân trang nói hai điều. */
  const trangThai = rows.map((r) =>
    migrationStatus({
      alreadyMigrated: r.alreadyMigrated,
      blockers: r.proposal.blockers,
      componentCount: r.proposal.components.length,
      hasUnexplainedDiff: Boolean(r.recon?.hasUnexplained),
    }),
  );
  const dem = (s: MigrationStatus) => trangThai.filter((t) => t === s).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Xem trước chuyển đổi lương"
        description={`${period.label} · cơ sở “${PAYROLL_BASIS_NAME[basis]}” · ${rows.length} nhân sự · ${dem("MIGRATED")} ${MIGRATION_STATUS_LABEL.MIGRATED.toLowerCase()} · ${dem("READY")} ${MIGRATION_STATUS_LABEL.READY.toLowerCase()} · ${dem("DIFF")} ${MIGRATION_STATUS_LABEL.DIFF.toLowerCase()} · ${dem("BLOCKED")} ${MIGRATION_STATUS_LABEL.BLOCKED.toLowerCase()} · ${dem("LEGACY")} ${MIGRATION_STATUS_LABEL.LEGACY.toLowerCase()}. Trang này KHÔNG ghi gì cho tới khi bạn xác nhận từng người.`}
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

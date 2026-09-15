import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { AdjustmentManager } from "@/app/(dashboard)/payroll/adjustments/adjustment-manager";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { EmptyState } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { payrollPeriodKey } from "@/lib/constants/payroll";
import { listEmployees } from "@/lib/queries/payroll";
import { periodFinalized } from "@/lib/queries/payroll-engine";
import { loadAdjustments, loadManualInputs } from "@/lib/queries/payroll-policies";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Đầu vào & điều chỉnh lương" };

/**
 * ═══ CHỖ NHẬP NHỮNG THỨ ERP KHÔNG TỰ ĐO ĐƯỢC ═══
 *
 * Chấm công, KPI và sản lượng theo người không có bảng nào trong ERP. Thay vì viết một truy vấn gần
 * đúng rồi gọi nó là số đo (AGENTS.md mục 20 · 45), chúng được nhập ở đây — có người nhập, có mốc
 * thời gian, có căn cứ. Thành phần lương thiếu chúng hiện CHƯA BIẾT, không hiện 0 ₫.
 */
export default async function PayrollAdjustmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  if (!can(user, "payroll:manage")) redirect("/payroll?forbidden=1");
  const period = resolvePeriod(raw, "month");
  const key = payrollPeriodKey(period.from, period.to);

  if (!key) {
    return (
      <div className="space-y-5">
        <PageHeader title="Đầu vào & điều chỉnh lương" description="Chọn một kỳ có mốc đầu và mốc cuối." />
        <PayrollTabs canManage />
        <DataTableToolbar />
        <EmptyState
          title="Kỳ “Toàn bộ” không có danh tính để gắn số liệu"
          description="Đầu vào và khoản điều chỉnh đều thuộc về MỘT kỳ cụ thể. Kỳ không có mốc đầu/cuối thì không có khoá nào để ghi vào, và ghi bừa là để cùng một khoản tiền xuất hiện ở nhiều kỳ. Chọn một tháng ở thanh trên."
        />
      </div>
    );
  }

  const [employees, inputs, adjustments, locked] = await Promise.all([listEmployees(), loadManualInputs(key), loadAdjustments(key), periodFinalized(key)]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Đầu vào & điều chỉnh lương"
        description="Hai thứ khác nhau: ĐẦU VÀO là một đại lượng được nhân với đơn giá trong chính sách (giờ công, % KPI, số sản phẩm); ĐIỀU CHỈNH là một số tiền cụ thể cho riêng kỳ này (thưởng nóng, tạm ứng, khấu trừ)."
      />
      <PayrollTabs canManage />
      <DataTableToolbar />

      <AdjustmentManager
        employees={employees.filter((e) => e.active).map((e) => ({ id: e.id, name: e.shortName || e.name }))}
        periodKey={key}
        periodLabel={period.label}
        locked={locked}
        adjustments={adjustments.rows.map((r) => ({
          id: r.id,
          employeeId: r.employeeId,
          kind: r.kind,
          label: r.label,
          amount: r.amount,
          reason: r.reason,
          createdByName: r.createdByName,
        }))}
        inputs={inputs.rows.map((r) => ({
          employeeId: r.employeeId,
          inputKey: r.inputKey,
          value: Number(r.value),
          unit: r.unit,
          evidence: r.evidence,
          status: r.status,
          enteredByName: r.enteredByName,
          enteredAt: r.createdAt ? r.createdAt.toISOString() : null,
          approvedByName: r.approvedByName,
          approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
        }))}
        canApprove
      />
    </div>
  );
}

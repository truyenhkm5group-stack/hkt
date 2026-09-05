import { redirect } from "next/navigation";
import { BankImportDialog } from "@/app/(dashboard)/expenses/bank-import-dialog";
import { ExpenseDialog } from "@/app/(dashboard)/expenses/expense-dialog";
import { ExpensesTab } from "@/app/(dashboard)/expenses/expenses-tab";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Chi phí vận hành" };

/** Module Chi phí: kê khai chi phí vận hành kinh doanh (lương, mặt bằng, phần mềm, đóng gói, nhập hàng, sao kê ngân hàng…). Quảng cáo tách sang /ads. */
export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  if (param(raw, "tab") === "ads") {
    // link cũ /expenses?tab=ads → module Quảng cáo, giữ nguyên kỳ lọc
    const q = new URLSearchParams();
    for (const k of ["period", "from", "to"]) {
      const v = param(raw, k);
      if (v) q.set(k, v);
    }
    redirect(`/ads${q.size ? `?${q.toString()}` : ""}`);
  }
  const user = await requirePermission("expenses:view");
  const canWrite = can(user, "expenses:write");
  const period = resolvePeriod(raw, "month");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Chi phí vận hành"
        description="Kê khai chi phí vận hành kinh doanh ngoài Pancake: lương, mặt bằng, điện nước, phần mềm, đóng gói, nhập hàng… Nhập tay hoặc từ sao kê ngân hàng; số liệu đưa vào Báo cáo lợi nhuận (dòng tiền & danh nghĩa)."
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              <BankImportDialog />
              <ExpenseDialog />
            </div>
          ) : null
        }
      />
      <ExpensesTab raw={raw} period={period} canWrite={canWrite} />
    </div>
  );
}

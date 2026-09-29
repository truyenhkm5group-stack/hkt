import { redirect } from "next/navigation";
import { ExpenseDialog } from "@/app/(dashboard)/expenses/expense-dialog";
import { ExpenseReportTab } from "@/app/(dashboard)/expenses/report-tab";
import { ExpenseTabs } from "@/app/(dashboard)/expenses/expense-tabs";
import { ExpensesTab } from "@/app/(dashboard)/expenses/expenses-tab";
import { FinanceNav } from "@/components/finance-nav";
import { PageHeader } from "@/components/page-header";
import { can,  } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { getBrandCopy } from "@/lib/branding/service";
import { ScopeDenied } from "@/components/scope-denied";
import { isExpenseTab, type ExpenseTab } from "@/lib/constants/expense-tabs";
import { getExpenseReport } from "@/lib/queries/expense-report";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Chi phí vận hành" };

/**
 * Module Chi phí: kê khai chi phí vận hành kinh doanh (lương, mặt bằng, phần mềm, đóng gói…). Quảng cáo
 * tách sang /ads. KHÔNG còn nút "Nhập sao kê" ở đây (AGENTS.md mục 3.17: sao kê không tạo chi phí) —
 * sao kê đi vào Sổ ngân hàng (/bank?tab=nhap-sao-ke), phân loại, rồi NỐI với khoản chi để đối chiếu.
 */
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
  const { user, decision } = await requireResource("FINANCE", "expenses:view");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  if (decision.allow === "NONE") return <ScopeDenied title="Chi phí" reason={decision.reason} fix={decision.fix} />;
  const canWrite = can(user, "expenses:write");
  const period = resolvePeriod(raw, "month");
  const requested = param(raw, "tab", "danh-sach");
  const tab = (isExpenseTab(requested) ? requested : "danh-sach") as ExpenseTab;
  /*
    Con số trên tab đọc từ CÙNG báo cáo mà tab kia sẽ hiển thị, nên nó không tốn thêm truy vấn nào:
    `getExpenseReport` có lớp đệm riêng 90 giây và cả hai lượt gọi trúng cùng một khoá.
  */
  const [chuaPhanLoai, copy] = await Promise.all([getExpenseReport(period).then((r) => r.unclassifiedOutflow.count), getBrandCopy(user)]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Chi phí vận hành"
        description={copy.text("expenses.description")}
        hint={copy.text("expenses.hint")}
        actions={canWrite ? <ExpenseDialog description={copy.text("expenses.dialog")} /> : null}
      />
      <FinanceNav badges={{ expenses: chuaPhanLoai }} />
      <ExpenseTabs active={tab} unclassified={chuaPhanLoai} />

      {tab === "danh-sach" ? <ExpensesTab raw={raw} period={period} canWrite={canWrite} /> : null}
      {tab === "bao-cao" ? <ExpenseReportTab period={period} /> : null}
    </div>
  );
}

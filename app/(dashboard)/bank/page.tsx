import { BankTabs } from "@/app/(dashboard)/bank/bank-tabs";
import { BankAccountsTab } from "@/app/(dashboard)/bank/accounts-tab";
import { BankImportTab } from "@/app/(dashboard)/bank/import-tab";
import { BankMatchTab } from "@/app/(dashboard)/bank/match-tab";
import { BankReconcileTab } from "@/app/(dashboard)/bank/reconcile-tab";
import { BankRulesTab } from "@/app/(dashboard)/bank/rules-tab";
import { BankTransactionsTab } from "@/app/(dashboard)/bank/transactions-tab";
import { FinanceNav } from "@/components/finance-nav";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { BANK_TABS, type BankTab } from "@/lib/constants/bank";
import { listBankAccounts, listBankRules, sepayLastReconciliation, unclassifiedBankCount, unconfirmedBankAccountCount } from "@/lib/queries/bank";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Sổ ngân hàng" };

/**
 * Module Sổ ngân hàng: dòng tiền THU / CHI THỰC từ sao kê.
 *
 * Khác biệt cốt lõi với module Chi phí: ở đây ghi MỌI giao dịch của tài khoản (kể cả tiền vào,
 * chuyển nội bộ, trả nợ gốc) để sổ khớp với số dư ngân hàng. Chỉ khoản nào được gán nhóm chi phí mà
 * bảng Chi phí có thẩm quyền mới được đẩy sang lợi nhuận — quảng cáo, tiền hàng, cước ĐVVC đã có
 * nguồn riêng nên không được trừ lần thứ hai.
 */
export default async function BankPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("bank:view");
  const canWrite = can(user, "bank:write");
  // Quyền RIÊNG: xác nhận tài khoản là quyết định "tiền của tài khoản này vào sổ shop",
  // cao hơn hẳn việc gán nhãn một dòng đã có.
  const canManageAccounts = can(user, "bank:accounts");
  const period = resolvePeriod(raw, "month");
  const requested = param(raw, "tab", "giao-dich");
  const tab = (BANK_TABS.includes(requested as BankTab) ? requested : "giao-dich") as BankTab;

  // Số tài khoản chờ xác nhận luôn được đếm: nó là con số trên tab, phải đúng ở mọi tab.
  const [unclassified, unconfirmedAccounts, rules, accounts, lastReconciliation] = await Promise.all([
    unclassifiedBankCount(),
    unconfirmedBankAccountCount(),
    tab === "quy-tac" ? listBankRules() : Promise.resolve([]),
    tab === "tai-khoan" ? listBankAccounts() : Promise.resolve([]),
    tab === "tai-khoan" ? sepayLastReconciliation() : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Sổ ngân hàng"
        description="Dòng tiền thu / chi thực trên tài khoản"
        hint="Nhập sao kê ngân hàng, phân loại từng giao dịch vào nhóm kế toán, và đưa khoản chi hợp lệ sang Báo cáo lợi nhuận. Nhóm nào đã có nguồn chuyên biệt (quảng cáo, tiền hàng, cước ĐVVC) chỉ dùng để đối chiếu, không trừ lần thứ hai."
      />
      <FinanceNav badges={{ bank: unclassified }} />
      <BankTabs active={tab} unclassified={unclassified} unconfirmedAccounts={unconfirmedAccounts} />

      {tab === "giao-dich" ? <BankTransactionsTab raw={raw} period={period} canWrite={canWrite} /> : null}
      {tab === "tai-khoan" ? <BankAccountsTab accounts={accounts} canManage={canManageAccounts} lastReconciliation={lastReconciliation} /> : null}
      {tab === "doi-khop" ? <BankMatchTab canWrite={canWrite} /> : null}
      {tab === "nhap-sao-ke" ? <BankImportTab canWrite={canWrite} /> : null}
      {tab === "quy-tac" ? <BankRulesTab rules={rules} canWrite={canWrite} /> : null}
      {tab === "doi-chieu" ? <BankReconcileTab period={period} /> : null}
    </div>
  );
}

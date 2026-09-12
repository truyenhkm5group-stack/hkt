import {
  BankUnclassifiedSection,
  CodMatchSection,
  ExpenseNoPaymentSection,
  InternalTransferSection,
  PaymentNoExpenseSection,
  PayrollUnmatchedSection,
  UnconfirmedAccountsSection,
} from "@/app/(dashboard)/finance-ops/sections";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Hàng đợi tác vụ tài chính" };

/**
 * ═══════ HÀNG ĐỢI TÁC VỤ TÀI CHÍNH ═══════
 *
 * Sổ ngân hàng giờ nhận giao dịch REALTIME qua SePay. Chủ shop / kế toán không nên phải gõ lại CÙNG
 * một khoản tiền vào Chi phí, COD, Lương — trang này biến một dòng sao kê thành ĐIỂM BẮT ĐẦU của
 * đúng một trong các luồng đó, thay vì bắt mở năm trang để biết hôm nay còn việc gì treo.
 *
 * KHÔNG tính lại lợi nhuận, KHÔNG coi tiền ngân hàng là doanh thu/chi phí, KHÔNG tạo bảng dữ liệu
 * mới. Mọi hành động ghi đi qua ĐÚNG Server Action đã có ở Sổ ngân hàng / Chi phí / Đối soát COD /
 * Tài khoản ngân hàng — xem chi tiết ở `lib/queries/finance-ops.ts`.
 */
export default async function FinanceOpsPage() {
  const user = await requirePermission("bank:view");
  const canBank = can(user, "bank:write");
  const canExpense = can(user, "expenses:write");
  const canAccounts = can(user, "bank:accounts");
  const canPayroll = can(user, "payroll:view");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Hàng đợi tác vụ tài chính"
        description="Mỗi giao dịch ngân hàng còn dở việc, gom về một chỗ để xử lý ngay trên dòng."
        hint="Phân loại một dòng sao kê không tự tạo doanh thu hay chi phí — chi phí chỉ được ghi nhận khi có khoản chi thật ở bảng Chi phí, và nối chứng từ chỉ là ĐỐI CHIẾU. Nhóm nào đã có nguồn chuyên biệt (quảng cáo, tiền hàng, cước ĐVVC) không hiện chi phí thứ hai ở đây."
      />

      <BankUnclassifiedSection canWrite={canBank} canExpense={canExpense} />
      <CodMatchSection canWrite={canBank} />
      <PaymentNoExpenseSection canWrite={canBank} />
      {canPayroll ? <PayrollUnmatchedSection canWrite={canBank} /> : null}
      <InternalTransferSection canWrite={canBank} />
      <ExpenseNoPaymentSection />
      {canAccounts ? <UnconfirmedAccountsSection /> : null}
    </div>
  );
}

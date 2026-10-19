import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { CodeBookManager } from "@/app/(dashboard)/payroll/codes/assignments/code-book-manager";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { formatVND, vnDateKey } from "@/lib/format";
import { listEmployees } from "@/lib/queries/payroll";
import { adSpendSuggestions, listCodeBook, listCodeOptions } from "@/lib/queries/payroll-code-ledger";
import { getProfitGateConfig } from "@/lib/queries/payroll-profit-gate";
import { addDays, todayVN, vnStartOfDay } from "@/lib/format";
import type { Suggestion } from "@/app/(dashboard)/payroll/codes/assignments/code-book-manager";

export const metadata = { title: "Phân công MKTer ↔ mã" };

const METHOD: Record<string, string> = { MANUAL: "trọng số tay", AD_SPEND: "theo chi phí QC", ATTRIBUTED_REVENUE: "theo doanh thu quy kết" };

/**
 * ═══ AI ĐƯỢC CHIA THƯỞNG CỦA MÃ NÀO, TỶ LỆ NÀO, TỪ BAO GIỜ ═══
 *
 * Đặc tả `docs/payroll-code-ledger.md`. Bảng này KHÔNG đổi cách quy kết đơn / lợi nhuận của trang
 * Hiệu quả marketer — nó chỉ quyết ai chia phần thưởng của lợi nhuận mã đã tính.
 */
export default async function PayrollCodeAssignmentsPage() {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) redirect("/payroll?forbidden=1");
  /*
    LỊCH SỬ GỢI Ý: từ tháng mở sổ của quy chế cổng (lũy kế mã bắt đầu từ đó), chưa khai thì 12 tháng gần
    nhất — đủ để khai phân công cho mọi tháng còn mở mà không quét toàn bộ lịch sử QC.
  */
  const gateCfg = await getProfitGateConfig();
  const tuNgay = gateCfg.active ? vnStartOfDay(`${gateCfg.active.openingMonth}-01`) : vnStartOfDay(addDays(todayVN(), -365).slice(0, 8) + "01");
  const [employees, book, codes, goiY] = await Promise.all([listEmployees(), listCodeBook(), listCodeOptions(), adSpendSuggestions(tuNgay)]);
  const nameOf = (id: string | null) => {
    const e = employees.find((x) => x.id === id);
    return e ? e.shortName || e.name : (id ?? "—");
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Phân công MKTer ↔ mã"
        description="Nhiều MKTer trên một mã, một MKTer trên nhiều mã. Mỗi dòng có mốc hiệu lực và người duyệt; đổi là kết thúc dòng cũ + thêm dòng mới, lịch sử không bị viết lại."
      />
      <PayrollTabs canManage />
      <p className="text-sm">
        <Link href="/payroll/codes" className="text-primary hover:underline">
          ← Sổ lợi nhuận theo mã
        </Link>
      </p>
      <CodeBookManager
        suggestions={goiY.map((s): Suggestion => {
          const den = new Date(Date.UTC(Number(s.monthKey.slice(0, 4)), Number(s.monthKey.slice(5, 7)), 0)).getUTCDate();
          const dau = vnStartOfDay(`${s.monthKey}-01`).getTime();
          const cuoi = vnStartOfDay(`${s.monthKey}-${String(den).padStart(2, "0")}`).getTime() + 86_399_999;
          const dang = book.find((r) => r.kind === "ASSIGNMENT" && r.status === "APPROVED" && r.productId === s.productId && r.employeeId === s.marketerId && r.effectiveFrom.getTime() <= cuoi && (!r.effectiveTo || r.effectiveTo.getTime() >= dau));
          return {
            ...s,
            marketerName: s.marketerId ? nameOf(s.marketerId) : "",
            existingRole: dang?.role ?? "",
            adsHref: `/ads?period=custom&from=${s.monthKey}-01&to=${s.monthKey}-${String(den).padStart(2, "0")}&product=${encodeURIComponent(s.productId)}&marketer=${encodeURIComponent(s.marketerId ?? "__none__")}`,
          };
        })}
        employees={employees.filter((e) => e.active).map((e) => ({ id: e.id, name: e.shortName || e.name }))}
        codes={codes}
        rows={book.map((r) => ({
          kind: r.kind,
          id: r.id,
          code: r.code,
          employeeName: nameOf(r.employeeId),
          role: r.role,
          detail:
            r.kind === "TERMS"
              ? `Y = ${(r.supportPoolBp ?? 0) / 100}% · trần ${r.maxBonusAmount === null ? "không" : formatVND(r.maxBonusAmount)}`
              : r.role === "OWNER"
                ? `X = ${(r.ownerRateBp ?? 0) / 100}%`
                : `${METHOD[r.weightMethod ?? ""] ?? "—"}${r.weightBp !== null ? ` ${r.weightBp / 100}%` : ""}`,
          from: vnDateKey(r.effectiveFrom),
          to: r.effectiveTo ? vnDateKey(r.effectiveTo) : null,
          policyRef: r.policyRef,
          status: r.status,
          approvedByName: r.approvedByName,
        }))}
      />
    </div>
  );
}

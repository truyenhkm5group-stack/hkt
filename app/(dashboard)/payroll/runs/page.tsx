import Link from "next/link";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canSeeAllPayroll, resolvePayrollScope } from "@/lib/auth/payroll-scope";
import { PAYROLL_BASIS_NAME, type PayrollBasis } from "@/lib/constants/payroll";
import { PAYROLL_RUN_STATUS_HINT, PAYROLL_RUN_STATUS_LABEL, normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
import { formatDateTime } from "@/lib/format";
import { listPayrollRuns } from "@/lib/queries/payroll-period";
import { cn } from "@/lib/utils";

export const metadata = { title: "Lịch sử kỳ lương" };

const TONE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  CALCULATED: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  UNDER_REVIEW: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  APPROVED: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  LOCKED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  PAID: "bg-emerald-200 text-emerald-950 dark:bg-emerald-900 dark:text-emerald-100",
};

/**
 * ═══ LỊCH SỬ KỲ LƯƠNG: SHOP ĐÃ TRẢ BAO NHIÊU, THEO CƠ SỞ NÀO, AI DUYỆT ═══
 *
 * Liệt kê MỌI kỳ có bản ghi, kể cả bản nháp — khác với danh sách cũ chỉ hiện kỳ đã chốt. Một kỳ
 * đang soát mà không hiện ở đâu là một kỳ không ai nhớ ra để đi duyệt.
 */
export default async function PayrollRunsPage() {
  const user = await requireUser();
  /*
    LỊCH SỬ KỲ LƯƠNG LÀ SỐ CỦA CẢ CÔNG TY (tổng chi lương từng kỳ, ai duyệt, ai khoá) — không có
    bản "chỉ của mình" cho màn hình này. Nên nó đòi đúng quyền xem toàn công ty.
  */
  if (!canSeeAllPayroll(resolvePayrollScope(user))) redirect("/payroll?forbidden=1");
  const runs = await listPayrollRuns(60);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Lịch sử kỳ lương"
        description="Mọi kỳ có bản ghi, kể cả bản nháp và kỳ đang soát. Một kỳ đang chờ duyệt mà không hiện ở đâu là một kỳ không ai nhớ ra để đi duyệt."
      />
      <PayrollTabs canManage={can(user, "payroll:manage")} />

      <SectionCard title={`${runs.length} kỳ`} padded={false}>
        {runs.length === 0 ? (
          <EmptyState
            title="Chưa có kỳ lương nào"
            description="Chưa ai bấm “Tính & chụp ảnh kỳ”. Một lượt nâng cấp KHÔNG tự tạo kỳ nào — con số của một kỳ chỉ tồn tại khi có người quyết định chụp nó lại."
          />
        ) : (
          <>
            <TableToolsFor tableId="payroll-runs-page" />
            <div className="overflow-x-auto">
              <table id="payroll-runs-page" className="w-full min-w-[980px] text-[13px]">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-2 font-medium">Kỳ</th>
                    <th className="px-3 py-2 font-medium">Cơ sở</th>
                    <th className="px-3 py-2 font-medium">Trạng thái</th>
                    <th className="px-3 py-2 text-right font-medium">Tổng lương</th>
                    <th className="px-3 py-2 text-right font-medium">Số người</th>
                    <th className="px-3 py-2 text-right font-medium">Lượt tính</th>
                    <th className="px-3 py-2 font-medium">Duyệt</th>
                    <th className="px-3 py-2 font-medium">Khoá / Trả</th>
                    <th className="px-3 py-2 font-medium">Ghi chú</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const st = normalizePayrollStatus(r.status);
                    const [from, to] = r.periodKey.split("..");
                    return (
                      <tr key={`${r.periodKey}:${r.basis}`} className="border-b last:border-b-0">
                        <td className="px-3 py-2">
                          <Link href={`/payroll?period=custom&from=${from}&to=${to}&basis=${r.basis}`} className="font-medium hover:underline">
                            {r.periodKey}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{PAYROLL_BASIS_NAME[r.basis as PayrollBasis] ?? r.basis}</td>
                        <td className="px-3 py-2">
                          <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", TONE[st])} title={PAYROLL_RUN_STATUS_HINT[st]}>
                            {PAYROLL_RUN_STATUS_LABEL[st].split(" — ")[0]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <Money value={r.totalSalary} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.people ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.calcRuns}</td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">
                          {r.approvedAt ? (
                            <>
                              {formatDateTime(r.approvedAt)}
                              {r.approvedByEmail ? <div>{r.approvedByEmail}</div> : null}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">
                          {r.lockedAt ? <div>khoá {formatDateTime(r.lockedAt)}</div> : null}
                          {r.paidAt ? <div>trả {formatDateTime(r.paidAt)}</div> : null}
                          {!r.lockedAt && !r.paidAt ? "—" : null}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">
                          {r.note}
                          {r.statusReason ? <div className="text-amber-700 dark:text-amber-400">{r.statusReason}</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}

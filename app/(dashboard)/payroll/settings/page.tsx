import { redirect } from "next/navigation";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { PayrollSettingsForm } from "@/app/(dashboard)/payroll/settings/settings-form";
import { SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { COMPENSATION_PROFIT_LABEL, COMPENSATION_PROFIT_RULES } from "@/lib/constants/compensation-profit";
import { COST_COMPONENTS } from "@/lib/constants/cost-authority";
import { DEFAULT_STATUTORY, STATUTORY_DEDUCTION_KEY, type StatutoryConfig } from "@/lib/constants/payroll-statutory";
import { getCarryoverConfig } from "@/lib/queries/payroll-carryover";
import { getRecognizedPayrollCost } from "@/lib/queries/payroll-cost";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";
import { cn } from "@/lib/utils";

export const metadata = { title: "Cấu hình lương" };

/**
 * ═══ CẤU HÌNH LƯƠNG ═══
 *
 * Hai công tắc đổi số tiền của người thật, và một BẢNG KHAI chỉ để đọc: thành phần chi phí nào
 * nằm trong cơ sở tính lương và vì sao. Bảng ấy không có nút nào — nó là lời khai của kho mã
 * (`lib/constants/compensation-profit.ts`), không phải một ô cấu hình. Cho sửa nó trên màn hình là
 * mở đường để ai đó loại một khoản chi thật ra khỏi cơ sở trả tiền bằng một lượt bấm.
 */
export default async function PayrollSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  /*
    QUẢN TRỊ LƯƠNG = QUYỀN KHAI BÁO **VÀ** PHẠM VI TOÀN CÔNG TY. Màn hình này in ra tiền của mọi
    người, nên riêng `payroll:manage` là chưa đủ — xem `lib/auth/payroll-scope.ts`.
  */
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) redirect("/payroll?forbidden=1");
  const period = resolvePeriod(raw, "month");
  const [carryover, recognition, statutory] = await Promise.all([
    getCarryoverConfig(),
    getRecognizedPayrollCost(period),
    getSettingJson<StatutoryConfig>(STATUTORY_DEDUCTION_KEY, DEFAULT_STATUTORY),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Cấu hình lương"
        description="Hai công tắc dưới đây đổi số tiền của người thật, nên mỗi lượt đổi cần người thứ hai duyệt và để lại một dòng nhật ký."
      />
      <PayrollTabs canManage />

      <PayrollSettingsForm
        carryover={carryover}
        recognitionMode={recognition.mode}
        recognitionReasons={recognition.reasons}
        payrollCovered={recognition.coverage === "COMPLETE"}
        statutory={statutory}
      />

      <SectionCard
        title={`Khoản nào nằm trong “${COMPENSATION_PROFIT_LABEL}”`}
        description="Lời khai của kho mã, chỉ để ĐỌC. Không có nút nào ở đây — cho sửa nó trên màn hình là mở đường để ai đó loại một khoản chi thật ra khỏi cơ sở trả tiền bằng một lượt bấm."
      >
        <TableToolsFor tableId="payroll-settings-page" />
        <div className="overflow-x-auto">
          <table id="payroll-settings-page" className="w-full min-w-[720px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Khoản chi</th>
                <th className="py-1 pr-3 font-medium">Trong cơ sở?</th>
                <th className="py-1 font-medium">Vì sao</th>
              </tr>
            </thead>
            <tbody>
              {COST_COMPONENTS.map((k) => {
                const r = COMPENSATION_PROFIT_RULES[k];
                return (
                  <tr key={k} className="border-t align-top">
                    <td className="py-1.5 pr-3 font-medium">{k}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px] font-medium",
                          r.included
                            ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                            : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
                        )}
                      >
                        {r.included ? "Trừ vào cơ sở" : "NGOÀI cơ sở"}
                      </span>
                    </td>
                    <td className="py-1.5 text-muted-foreground">{r.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[12px] text-muted-foreground">
          Hoa hồng là khoản DUY NHẤT nằm ngoài, và vì nó là hàm của chính cơ sở này — đưa vào là định nghĩa vòng tròn. Nó vẫn bị trừ, nhưng ở BƯỚC SAU: lợi nhuận kế toán = cơ sở − hoa hồng.
        </p>
      </SectionCard>
    </div>
  );
}

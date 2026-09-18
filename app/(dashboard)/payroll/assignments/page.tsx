import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { AssignmentManager } from "@/app/(dashboard)/payroll/assignments/assignment-manager";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { EMPLOYMENT_STATUS_LABEL, EMPLOYMENT_TYPE_LABEL, WORK_MODE_LABEL, type EmploymentStatus, type EmploymentType, type WorkMode } from "@/lib/constants/payroll-components";
import { formatDate } from "@/lib/format";
import { listEmployees } from "@/lib/queries/payroll";
import { listOrgOptions, listSalaryPolicies, loadAssignmentBook } from "@/lib/queries/payroll-policies";

export const metadata = { title: "Phân công & gán chính sách" };

/**
 * ═══ AI LÀM GÌ, Ở ĐÂU, TỪ BAO GIỜ — VÀ ĂN LƯƠNG THEO CHÍNH SÁCH NÀO ═══
 *
 * Mọi dòng ở đây đều CÓ MỐC HIỆU LỰC. Đó là thứ làm "đổi chính sách hôm nay" không viết lại bảng
 * lương tháng trước, và làm "vào làm giữa tháng" tính đúng phần ngày của nó.
 */
export default async function PayrollAssignmentsPage() {
  const user = await requireUser();
  /*
    QUẢN TRỊ LƯƠNG = QUYỀN KHAI BÁO **VÀ** PHẠM VI TOÀN CÔNG TY. Màn hình này in ra tiền của mọi
    người, nên riêng `payroll:manage` là chưa đủ — xem `lib/auth/payroll-scope.ts`.
  */
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) redirect("/payroll?forbidden=1");
  const [employees, policies, org, book] = await Promise.all([listEmployees(), listSalaryPolicies(), listOrgOptions(), loadAssignmentBook()]);
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.shortName || employees.find((e) => e.id === id)?.name || id;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Phân công & gán chính sách"
        description="Ba chiều không suy ra lẫn nhau: PHÂN CÔNG nói người đó làm gì ở đâu, CHÍNH SÁCH nói shop trả tiền thế nào, và cả hai đều đi theo MỐC HIỆU LỰC nên lịch sử không bao giờ bị viết lại."
      />
      <PayrollTabs canManage />

      <AssignmentManager
        employees={employees.filter((e) => e.active).map((e) => ({ id: e.id, name: e.shortName || e.name }))}
        policies={policies.filter((p) => p.active).map((p) => ({ id: p.id, name: `${p.name} (${p.code})` }))}
        departments={org.departments}
        positions={org.positions}
        users={org.users}
      />

      <SectionCard title="Phân công đang có" description="Mỗi lần đổi là một dòng MỚI có mốc, không sửa dòng cũ.">
        {book.employments.length === 0 ? (
          <EmptyState title="Chưa có dòng phân công nào" description="Chưa khai phân công thì máy tính lương chung coi như người đó không đi làm ngày nào trong kỳ, và sẽ nói thẳng điều đó thay vì ghi 0 ₫." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Nhân sự</th>
                  <th className="py-1 pr-3 font-medium">Phòng ban</th>
                  <th className="py-1 pr-3 font-medium">Chức danh</th>
                  <th className="py-1 pr-3 font-medium">Hình thức</th>
                  <th className="py-1 pr-3 font-medium">Nơi làm</th>
                  <th className="py-1 pr-3 font-medium">Trạng thái</th>
                  <th className="py-1 font-medium">Hiệu lực</th>
                </tr>
              </thead>
              <tbody>
                {book.employments
                  .slice()
                  .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())
                  .map((e) => (
                    <tr key={e.id} className="border-t">
                      <td className="py-1.5 pr-3 font-medium">{nameOf(e.employeeId)}</td>
                      <td className="py-1.5 pr-3">{e.departmentName || "—"}</td>
                      <td className="py-1.5 pr-3">{e.positionName || "—"}</td>
                      <td className="py-1.5 pr-3">{EMPLOYMENT_TYPE_LABEL[e.employmentType as EmploymentType]}</td>
                      <td className="py-1.5 pr-3">{WORK_MODE_LABEL[e.workMode as WorkMode]}</td>
                      <td className="py-1.5 pr-3">{EMPLOYMENT_STATUS_LABEL[e.status as EmploymentStatus]}</td>
                      <td className="py-1.5 whitespace-nowrap">
                        {formatDate(e.effectiveFrom)} → {e.effectiveTo ? formatDate(e.effectiveTo) : "còn hiệu lực"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Chính sách đang gán" description="Người không có dòng nào ở đây vẫn tính lương bằng đường cũ — không con số nào của họ đổi.">
        {book.policyAssignments.length === 0 ? (
          <EmptyState
            title="Chưa gán chính sách cho ai"
            description="Đây là trạng thái đúng ngay sau khi phát hành: máy tính lương chung đã sẵn sàng nhưng chưa chạm vào tiền của ai. Gán từng người một, có mốc hiệu lực, và đối chiếu số trước khi chốt kỳ."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Nhân sự</th>
                  <th className="py-1 pr-3 font-medium">Chính sách</th>
                  <th className="py-1 pr-3 font-medium">Hiệu lực</th>
                  <th className="py-1 font-medium">Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {book.policyAssignments
                  .slice()
                  .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())
                  .map((a) => (
                    <tr key={a.id} className="border-t">
                      <td className="py-1.5 pr-3 font-medium">{nameOf(a.employeeId)}</td>
                      <td className="py-1.5 pr-3">
                        {a.policyName} <code className="rounded bg-muted px-1 text-[11px]">{a.policyCode}</code>
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {formatDate(a.effectiveFrom)} → {a.effectiveTo ? formatDate(a.effectiveTo) : "còn hiệu lực"}
                      </td>
                      <td className="py-1.5 text-muted-foreground">—</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

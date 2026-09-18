import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { PolicyManager } from "@/app/(dashboard)/payroll/policies/policy-manager";
import { SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { PAYROLL_INPUTS } from "@/lib/constants/payroll-components";
import { listOrgOptions, listSalaryPolicies } from "@/lib/queries/payroll-policies";

export const metadata = { title: "Chính sách lương" };

/**
 * ═══ KHAI CÁCH TRẢ TIỀN, KHÔNG SỬA MÃ NGUỒN ═══
 *
 * Đây là màn hình trả lời yêu cầu "thêm một chức danh mới không được đụng tới lõi tính lương":
 * một chính sách = một danh sách thành phần, và mỗi thành phần là một phép tính có tham số khai rõ.
 */
export default async function PayrollPoliciesPage() {
  const user = await requireUser();
  /*
    QUẢN TRỊ LƯƠNG = QUYỀN KHAI BÁO **VÀ** PHẠM VI TOÀN CÔNG TY. Màn hình này in ra tiền của mọi
    người, nên riêng `payroll:manage` là chưa đủ — xem `lib/auth/payroll-scope.ts`.
  */
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) redirect("/payroll?forbidden=1");
  const [policies, org] = await Promise.all([listSalaryPolicies(), listOrgOptions()]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Chính sách lương"
        description="Cách trả tiền là DỮ LIỆU, không phải mã nguồn. Mỗi chính sách gồm các thành phần (lương cứng · theo giờ · KPI · hoa hồng · chia lợi nhuận · khoán sản phẩm…), và mỗi phiên bản có mốc hiệu lực riêng nên đổi tỷ lệ tháng này không viết lại tháng trước."
      />
      <PayrollTabs canManage />

      <PolicyManager
        policies={policies.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          description: p.description,
          departmentId: p.departmentId,
          departmentName: p.departmentName,
          active: p.active,
          sortOrder: p.sortOrder,
          assignedCount: p.assignedCount,
          versions: p.versions.map((v) => ({
            id: v.id,
            version: v.version,
            effectiveFrom: v.effectiveFrom,
            effectiveTo: v.effectiveTo,
            status: v.status,
            note: v.note,
            components: v.components,
          })),
        }))}
        departments={org.departments}
      />

      <SectionCard
        title="Sổ đăng ký đầu vào"
        description="Một thành phần lương chỉ được nhân với đại lượng mà ERP THẬT SỰ đọc được. Cái nào chưa đo được thì phải nhập tay, có tên người nhập và mốc thời gian — không thay bằng một truy vấn gần đúng rồi gọi nó là số đo."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Đại lượng</th>
                <th className="py-1 pr-3 font-medium">Mức sẵn có</th>
                <th className="py-1 font-medium">Nguồn</th>
              </tr>
            </thead>
            <tbody>
              {PAYROLL_INPUTS.map((i) => (
                <tr key={i.key} className="border-t align-top">
                  <td className="py-1.5 pr-3 font-medium">{i.label}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {i.availability === "MEASURED" ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">ERP đo được</span>
                    ) : (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">Phải nhập tay</span>
                    )}
                  </td>
                  <td className="py-1.5 text-muted-foreground">{i.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

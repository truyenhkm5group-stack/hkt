"use server";

import { revalidatePath } from "next/cache";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { PAYROLL_CONFIG_KEY, PAYROLL_EMPLOYEES_KEY } from "@/lib/constants/payroll";
import { reapplyAdsMapping } from "@/lib/integrations/facebook/mapping";
import { listEmployees } from "@/lib/queries/payroll";
import { setSettingJson } from "@/lib/settings";
import { employeeSchema } from "@/lib/validation/payroll";
import { saveEmployeeAs } from "@/lib/payroll/employee-service";

export type ActionResult = { ok: true; id?: string } | { error: string };

function revalidate() {
  for (const path of ["/payroll", "/ads", "/expenses", "/reports"]) revalidatePath(path);
}

/** Lưu hồ sơ một nhân sự. Lõi: `lib/payroll/employee-service.ts::saveEmployeeAs`. */
export async function saveEmployee(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Chỉ Quản trị mới được sửa nhân sự và cơ chế lương" };
  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const kq = await saveEmployeeAs({ id: user.id, email: user.email }, parsed.data, {});
  revalidate();
  return kq;
}

export async function deleteEmployee(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Chỉ Quản trị mới được xoá nhân sự" };
  const list = await listEmployees();
  if (!list.some((e) => e.id === id)) return { error: "Không tìm thấy nhân sự" };
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: list.filter((e) => e.id !== id) });
  await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PAYROLL_EMPLOYEES_KEY, detail: { deleted: id } });
  revalidate();
  return { ok: true };
}

const payrollConfigSchema = z.object({
  ownerSharePct: z.number().min(0).max(100),
  productOwners: z.record(z.string(), z.string()).default({}),
  pageMarketers: z.record(z.string(), z.string()).default({}),
  productShares: z.record(z.string(), z.object({ ownerPct: z.number().min(0).max(100), crossPct: z.number().min(0).max(100) })).default({}),
});

/** Lưu người phụ trách chính từng mã và % chủ mã nhận từ đơn đẩy chéo */
export async function savePayrollConfig(input: unknown): Promise<ActionResult> {
  return withApprovalExecution(async () => {
    const user = await requireUser();
    if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Không có quyền" };
    const parsed = payrollConfigSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const productOwners = Object.fromEntries(Object.entries(parsed.data.productOwners).filter(([, v]) => Boolean(v)));
    const pageMarketers = Object.fromEntries(Object.entries(parsed.data.pageMarketers).filter(([k, v]) => Boolean(k) && Boolean(v)));
    const next = { ownerSharePct: parsed.data.ownerSharePct, productOwners, pageMarketers, productShares: parsed.data.productShares };
    {
      // Đổi cơ chế trả công là đổi TIỀN TRẢ CHO NGƯỜI, và người đó có thể chính là người đang sửa.
      const cong = await guardSecondApproval({
        group: "PAYROLL_EDIT",
        action: "payroll.config",
        entity: "SETTINGS",
        entityId: PAYROLL_CONFIG_KEY,
        summary: `Đổi cơ chế trả công · chia chủ mã ${parsed.data.ownerSharePct}% · ${Object.keys(productOwners).length} mã · ${Object.keys(pageMarketers).length} fanpage`,
        amount: null,
        payload: next,
      });
      if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
      if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    }
    await setSettingJson(PAYROLL_CONFIG_KEY, next);
    await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PAYROLL_CONFIG_KEY, detail: { ownerSharePct: parsed.data.ownerSharePct, owners: Object.keys(productOwners).length, pages: Object.keys(pageMarketers).length, shares: Object.keys(parsed.data.productShares).length } });
    revalidate();
    return { ok: true };
  });
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { PAYROLL_CONFIG_KEY, PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { reapplyAdsMapping } from "@/lib/integrations/facebook/mapping";
import { listEmployees } from "@/lib/queries/payroll";
import { setSettingJson } from "@/lib/settings";
import { employeeSchema } from "@/lib/validation/payroll";

export type ActionResult = { ok: true; id?: string } | { error: string };

function splitList(text: string) {
  return [...new Set(text.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean))].slice(0, 30);
}

function revalidate() {
  for (const path of ["/payroll", "/expenses", "/reports"]) revalidatePath(path);
}

export async function saveEmployee(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: "Chỉ Quản trị mới được sửa nhân sự và cơ chế lương" };
  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const data = parsed.data;
  const list = await listEmployees();
  const id = data.id && list.some((e) => e.id === data.id) ? data.id : crypto.randomUUID();
  const employee: Employee = {
    id,
    name: data.name,
    shortName: data.shortName || data.name,
    department: data.department,
    aliases: splitList(data.aliases),
    accountIds: splitList(data.accountIds).map((a) => a.replace(/^act_/, "")),
    fixed: data.fixed,
    percentTotal: data.percentTotal,
    percentPersonal: data.percentPersonal,
    percentRevenue: data.percentRevenue,
    active: data.active,
    note: data.note,
  };
  const next = list.some((e) => e.id === id) ? list.map((e) => (e.id === id ? employee : e)) : [...list, employee];
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: next });
  await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PAYROLL_EMPLOYEES_KEY, detail: { employee } });
  revalidate();
  return { ok: true, id };
}

export async function deleteEmployee(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: "Chỉ Quản trị mới được xoá nhân sự" };
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
});

/** Lưu người phụ trách chính từng mã và % chủ mã nhận từ đơn đẩy chéo */
export async function savePayrollConfig(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: "Không có quyền" };
  const parsed = payrollConfigSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const productOwners = Object.fromEntries(Object.entries(parsed.data.productOwners).filter(([, v]) => Boolean(v)));
  await setSettingJson(PAYROLL_CONFIG_KEY, { ownerSharePct: parsed.data.ownerSharePct, productOwners });
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PAYROLL_CONFIG_KEY, detail: { ownerSharePct: parsed.data.ownerSharePct, owners: Object.keys(productOwners).length } });
  revalidatePath("/payroll");
  revalidatePath("/expenses");
  return { ok: true };
}

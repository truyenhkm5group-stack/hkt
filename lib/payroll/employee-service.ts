/**
 * ═══ HỒ SƠ NHÂN SỰ BẢNG LƯƠNG — LÕI GHI DÙNG CHUNG CỦA MÀN HÌNH VÀ JOB ═══
 *
 * `lib/actions/payroll.ts::saveEmployee` (hộp thoại nhân sự ở /payroll) và `scripts/payroll-owner-apply.ts` đi qua
 * ĐÚNG hàm này. KHÔNG phải server action: chỗ gọi đã kiểm quyền và đã chạy `employeeSchema`. Luật và câu chữ y như
 * bản trước khi tách (22/10/2026) — kể cả dòng nhật ký riêng khi đổi tài khoản nhận lương.
 */
import type { z } from "zod";
import { audit } from "@/lib/audit";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { reapplyAdsMapping } from "@/lib/integrations/facebook/mapping";
import { listEmployees } from "@/lib/queries/payroll";
import { normalizeAccountName } from "@/lib/payroll/vietqr";
import { setSettingJson } from "@/lib/settings";
import type { employeeSchema } from "@/lib/validation/payroll";

export type EmployeeActor = { id: string | null; email: string };

function splitList(text: string) {
  return [...new Set(text.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean))].slice(0, 30);
}

export async function saveEmployeeAs(user: EmployeeActor, data: z.infer<typeof employeeSchema>, opts: { auditNote?: string }): Promise<{ ok: true; id: string }> {
  const list = await listEmployees();
  const id = data.id && list.some((e) => e.id === data.id) ? data.id : crypto.randomUUID();
  const employee: Employee = {
    id,
    name: data.name,
    shortName: data.shortName || data.name,
    department: data.department,
    aliases: splitList(data.aliases),
    accountIds: splitList(data.accountIds).map((a) => a.replace(/^act_/, "")),
    userEmail: (data.userEmail ?? "").trim().toLowerCase(),
    fixed: data.fixed,
    percentTotal: data.percentTotal,
    percentPersonal: data.percentPersonal,
    percentRevenue: data.percentRevenue,
    active: data.active,
    note: data.note,
    ...(data.startedOn ? { startedOn: data.startedOn } : {}),
    ...(data.leftOn ? { leftOn: data.leftOn } : {}),
    ...(data.bankAccount
      ? { bankBin: data.bankBin, bankAccount: data.bankAccount.toUpperCase(), bankAccountName: normalizeAccountName(data.bankAccountName) }
      : {}),
  };
  const before = list.find((e) => e.id === id) ?? null;
  const next = list.some((e) => e.id === id) ? list.map((e) => (e.id === id ? employee : e)) : [...list, employee];
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: next });
  await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PAYROLL_EMPLOYEES_KEY, detail: { employee }, ...(opts.auditNote ? { reason: opts.auditNote } : {}) });
  /*
    ĐỔI TÀI KHOẢN NHẬN LƯƠNG LÀ MỘT DÒNG NHẬT KÝ RIÊNG.

    Đổi số tài khoản là cách gian lận lương phổ biến nhất: sửa một ô trong hồ sơ, và tháng sau tiền
    của một người đi vào tài khoản của người khác. Dòng riêng này để tra được "ai đổi, lúc nào, từ đâu
    sang đâu" mà không phải lục trong khối `detail` của mọi lượt lưu hồ sơ. Lệnh chuyển còn tự in
    "STK khác lần trả trước" (`payroll_payout_lines.account_changed`) để người bấm chuyển nhìn thấy.
  */
  const taiKhoan = (e: Employee | null) => (e?.bankAccount ? `${e.bankBin}:${e.bankAccount}:${e.bankAccountName ?? ""}` : "");
  if (before && taiKhoan(before) !== taiKhoan(employee)) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "PAYROLL_BANK_ACCOUNT_CHANGE",
      entity: "PAYROLL_EMPLOYEE",
      entityId: id,
      before: { bankBin: before.bankBin ?? "", bankAccount: before.bankAccount ?? "", bankAccountName: before.bankAccountName ?? "" },
      after: { bankBin: employee.bankBin ?? "", bankAccount: employee.bankAccount ?? "", bankAccountName: employee.bankAccountName ?? "" },
    });
  }
  return { ok: true, id };
}

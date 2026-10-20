"use server";

/**
 * ═══════ KÝ XÁC NHẬN ĐỐI SOÁT LỢI NHUẬN THÁNG — CẤP 1 CỦA DUYỆT HAI CẤP ═══════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9.3. Trình tự: `requireUser` → quyền khai báo lương + phạm vi
 * toàn công ty → zod → duyệt người thứ hai (`PAYROLL_EDIT`, khi nhóm bật cưỡng chế) → service
 * (`lib/payroll/recon-signoff.ts`, ghi dưới khoá tên) → `audit()` → `revalidatePath`.
 *
 * Chữ ký ký trên ẢNH CHỤP kỳ đã tính (không trên số sống) — xem chú thích của service.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { revokeProfitReconAs, signProfitReconAs } from "@/lib/payroll/recon-signoff";

export type ReconActionResult = { ok: true; id?: string } | { error: string };

const SURFACES = ["/payroll", "/payroll/reconciliation", "/payroll/reconciliation/center", "/payroll/codes"] as const;
function revalidate() {
  for (const p of SURFACES) revalidatePath(p);
}

type SessionUser = Awaited<ReturnType<typeof requireUser>>;

async function requireManage(): Promise<SessionUser | { error: string }> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Việc này cần quyền khai báo lương VÀ phạm vi xem lương toàn công ty." };
  return user;
}

const signSchema = z.object({
  monthKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng phải dạng YYYY-MM"),
  /** Khoá dấu vân tay bảng đối soát trong ẢNH CHỤP mà người bấm đã thấy. */
  fingerprintKey: z.string().min(1),
  reason: z.string().trim().min(10, "Ghi rõ đã đối chiếu những gì (ít nhất 10 ký tự)").max(800),
  /** Bảng còn khoản chưa đối soát ⇒ người ký phải đánh dấu đã xem từng khoản. */
  acknowledgeIssues: z.boolean().default(false),
});
const revokeSchema = z.object({ id: z.string().min(1), reason: z.string().trim().min(10, "Ghi rõ vì sao huỷ (ít nhất 10 ký tự)").max(500) });

const tuChoi = (cong: { mode: string; reason?: string }): ReconActionResult | null =>
  cong.mode === "NEEDS_APPROVAL"
    ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo. Duyệt xong, gửi lại ĐÚNG nội dung này.` }
    : cong.mode === "BLOCKED_NO_APPROVER"
      ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` }
      : null;

/** KÝ (cấp 1) bảng đối soát trong ảnh chụp kỳ lương của một tháng. */
export async function signProfitReconciliation(input: unknown): Promise<ReconActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = signSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const id = `${d.fingerprintKey}-${d.monthKey}`;
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.profit.reconcile.sign",
      entity: "PAYROLL_PROFIT_RECON",
      entityId: id,
      summary: `Ký đối soát lợi nhuận tháng ${d.monthKey} (ảnh chụp ${d.fingerprintKey}). Lý do: ${d.reason}`,
      amount: null,
      payload: d,
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const kq = await signProfitReconAs({ id: guard.id, email: guard.email ?? "" }, d);
    if ("error" in kq) return kq;
    if (kq.created) await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_PROFIT_RECON_SIGN", entity: "PAYROLL_PROFIT_RECON", entityId: kq.id, after: { monthKey: d.monthKey, fingerprintKey: d.fingerprintKey, acknowledgeIssues: d.acknowledgeIssues }, reason: d.reason });
    revalidate();
    return { ok: true, id: kq.id };
  });
}

/** HUỶ một chữ ký đối soát (đánh dấu, không xoá). */
export async function revokeProfitReconciliation(input: unknown): Promise<ReconActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = revokeSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.profit.reconcile.revoke",
      entity: "PAYROLL_PROFIT_RECON",
      entityId: d.id,
      summary: `Huỷ chữ ký đối soát lợi nhuận: ${d.reason}`,
      amount: null,
      payload: d,
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const kq = await revokeProfitReconAs({ id: guard.id, email: guard.email ?? "" }, d);
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_PROFIT_RECON_REVOKE", entity: "PAYROLL_PROFIT_RECON", entityId: d.id, before: { revokedAt: null }, after: { revokedAt: "now" }, reason: d.reason });
    revalidate();
    return { ok: true, id: d.id };
  });
}

"use server";

/**
 * ═══════════ NÚT BẤM CỦA TRANG "TRẢ LƯƠNG TỰ ĐỘNG" ═══════════
 *
 * Mọi hàm ở đây đều: xác định NGƯỜI (`requireUser`) → kiểm QUYỀN lương (`can` + `canAdministerPayroll`)
 * → gọi đúng lõi mà máy cũng dùng → nhật ký → làm mới trang. Không nút nào đi đường riêng:
 *   · "Duyệt & khoá" = HAI lượt `movePayrollRun` nối nhau (APPROVE rồi LOCK), qua đủ cổng người thứ hai;
 *   · "Gửi phiếu" = `deliverPayslips`, cùng hàm mà bước chuyển soát tự gọi;
 *   · "Khớp tay" vẫn đòi một dòng sao kê có thật, đúng số tiền.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { PAYROLL_AUTOPILOT_BASIS, targetMonth } from "@/lib/constants/payroll-autopilot";
import { movePayrollRun } from "@/lib/actions/payroll-run";
import { applySettlement, runPayrollAutopilot, setAutopilotEnabled } from "@/lib/payroll/autopilot";
import { deliverPayslips, payslipOwnerGate, recordPayslipResponse } from "@/lib/payroll/payslip-delivery";
import { matchPayoutLineManually, payoutTxnCandidates } from "@/lib/payroll/payout";

type Result = { ok: true; message?: string } | { error: string };

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;
const periodSchema = z.object({ periodKey: z.string().regex(PERIOD_RE, "Khoá kỳ không hợp lệ") });

function refresh() {
  for (const path of ["/payroll", "/payroll/runs", "/payroll/autopilot", "/my-payslip"]) revalidatePath(path);
}

/** Bật / tắt lương tự động. Trao cho máy quyền tính và gửi phiếu thay người ⇒ đòi quyền DUYỆT. */
export async function togglePayrollAutopilot(enabled: boolean): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "payroll:approve") || !canAdministerPayroll(user, true)) return { error: "Bật / tắt lương tự động cần quyền DUYỆT lương và phạm vi toàn công ty." };
  await setAutopilotEnabled(Boolean(enabled), { id: user.id, email: user.email });
  refresh();
  return { ok: true, message: enabled ? "Đã bật lương tự động" : "Đã tắt lương tự động" };
}

/** Chạy ngay một lượt — đúng những việc job mỗi giờ sẽ làm, không hơn. */
export async function runPayrollAutopilotNow(): Promise<Result> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Cần quyền khai báo lương và phạm vi toàn công ty." };
  const r = await runPayrollAutopilot();
  await audit({ userId: user.id, userEmail: user.email, action: "PAYROLL_AUTOPILOT_RUN", entity: "PAYROLL_PERIOD", entityId: r.monthKey, detail: { did: r.did, notes: r.notes } });
  refresh();
  const msg = [...r.did, ...r.notes].join(" · ");
  return { ok: true, message: msg || "Không có việc gì phải làm lúc này." };
}

/**
 * DUYỆT & KHOÁ trong một lần bấm — nhưng vẫn là HAI chữ ký trong nhật ký, và mỗi bước qua đủ cổng
 * của nó (quyền duyệt, người thứ hai nếu nhóm PAYROLL_EDIT bật cưỡng chế). Khoá xong thì lệnh chuyển
 * được lập ngay (việc đi kèm của bước LOCK).
 */
export async function approveAndLockPayroll(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "payroll:approve") || !canAdministerPayroll(user, true)) return { error: "Duyệt lương cần quyền DUYỆT và phạm vi toàn công ty." };
  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const base = { periodKey: parsed.data.periodKey, basis: PAYROLL_AUTOPILOT_BASIS, reason: "" };
  const duyet = await movePayrollRun({ ...base, action: "APPROVE" });
  if ("error" in duyet) return duyet;
  const khoa = await movePayrollRun({ ...base, action: "LOCK" });
  if ("error" in khoa) return { error: `Đã DUYỆT nhưng chưa KHOÁ được: ${khoa.error}` };
  refresh();
  return { ok: true, message: ["Đã duyệt và khoá kỳ.", ...khoa.sideEffects].join(" ") };
}

/** Gửi lại phiếu của lượt hiện tại — tin đã gửi thì không gửi trùng (khoá chống trùng ở CSDL). */
export async function resendPayslips(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Cần quyền khai báo lương và phạm vi toàn công ty." };
  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  try {
    const r = await deliverPayslips({ periodKey: parsed.data.periodKey, basis: PAYROLL_AUTOPILOT_BASIS, actor: { id: user.id, email: user.email } });
    refresh();
    return { ok: true, message: r.summary };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Tính lại quyết toán kỳ trước vào kỳ đang lo (vd sau khi nhập thêm bảng kê COD muộn). */
export async function rerunSettlement(): Promise<Result> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Cần quyền khai báo lương và phạm vi toàn công ty." };
  const r = await applySettlement(targetMonth(new Date()), { id: user.id, email: user.email });
  refresh();
  if ("skipped" in r) return { ok: true, message: r.skipped };
  return { ok: true, message: `Đã quyết toán: ${r.written} dòng điều chỉnh.` };
}

/** Dòng sao kê có thể khớp tay cho một dòng lệnh — chỉ để chọn, không ghi gì. */
export async function listPayoutCandidates(lineId: string): Promise<{ ok: true; items: { id: string; txnAt: string; amount: number; description: string; counterparty: string }[] } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "payroll:approve") || !canAdministerPayroll(user, true)) return { error: "Cần quyền DUYỆT lương." };
  const rows = await payoutTxnCandidates(String(lineId));
  return { ok: true, items: rows.map((r) => ({ ...r, txnAt: r.txnAt.toISOString() })) };
}

/** Khớp tay: người chọn dòng sao kê chứng minh đã chuyển. "Đã trả" không bao giờ đi mà thiếu chứng từ. */
export async function matchPayoutManually(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "payroll:approve") || !canAdministerPayroll(user, true)) return { error: "Đánh dấu đã trả cần quyền DUYỆT lương." };
  const parsed = z.object({ lineId: z.string().min(1), txnId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await matchPayoutLineManually({ ...parsed.data, actor: { id: user.id, email: user.email } });
  if ("error" in r) return r;
  refresh();
  return { ok: true, message: "Đã khớp — dòng lương chuyển sang Đã trả." };
}

const responseSchema = z.object({
  confirmationId: z.string().min(1),
  decision: z.enum(["CONFIRMED", "DISPUTED"]),
  note: z.string().max(1000).default(""),
});

/**
 * NHÂN VIÊN TRẢ LỜI PHIẾU LƯƠNG CỦA CHÍNH MÌNH.
 *
 * Cổng ở đây KHÔNG phải một khoá quyền lương mà là QUYỀN SỞ HỮU DÒNG PHIẾU (`payslipOwnerGate`): người
 * được gửi phiếu thì trả lời được đúng phiếu ấy, và không gì khác. Cấp `payroll:view-own` cho cả vai
 * trò Kho / CSKH chỉ để họ bấm "xác nhận" là mở rộng quyền rộng hơn thứ đang cần.
 */
export async function respondMyPayslip(input: unknown): Promise<Result> {
  const user = await requireUser();
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const gate = await payslipOwnerGate(user, parsed.data.confirmationId);
  if (!gate.ok) return { error: gate.error };
  const r = await recordPayslipResponse({ userId: user.id, userEmail: user.email, confirmationId: parsed.data.confirmationId, decision: parsed.data.decision, note: parsed.data.note });
  if ("error" in r) return r;
  refresh();
  return { ok: true, message: parsed.data.decision === "CONFIRMED" ? "Đã xác nhận phiếu lương." : "Đã gửi khiếu nại tới người phụ trách lương." };
}

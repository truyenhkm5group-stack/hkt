"use server";

/**
 * ═══════ KÝ XÁC NHẬN ĐỐI SOÁT LỢI NHUẬN THÁNG — CẤP 1 CỦA DUYỆT HAI CẤP ═══════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9 · hằng số `lib/constants/payroll-reconciliation.ts`.
 * Trình tự: `requireUser` → quyền khai báo lương + phạm vi toàn công ty → zod → duyệt người thứ hai
 * (`PAYROLL_EDIT`, khi nhóm bật cưỡng chế) → ghi dưới khoá tên → `audit()` → `revalidatePath`.
 *
 * Chữ ký áp cho ĐÚNG bảng đối soát người bấm đã thấy: trang gửi dấu vân tay đang hiện, server đo lại và
 * chỉ nhận khi bằng nhau. Không ký cho tháng đã khoá (ảnh chụp đã mang con số của nó).
 */
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { periodFinalized } from "@/lib/queries/payroll-engine";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";
import { getMonthReconciliation, loadProfitSignoffs } from "@/lib/queries/payroll-reconciliation";
import { reconFingerprintKey } from "@/lib/payroll/profit-reconciliation";
import { PAYROLL_PROFIT_SIGNOFF_KEY, type ProfitReconSignoff } from "@/lib/constants/payroll-reconciliation";

export type ReconActionResult = { ok: true; id?: string } | { error: string };

const SURFACES = ["/payroll", "/payroll/reconciliation", "/payroll/codes"] as const;
function revalidate() {
  for (const p of SURFACES) revalidatePath(p);
}

type SessionUser = Awaited<ReturnType<typeof requireUser>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function requireManage(): Promise<SessionUser | { error: string }> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Việc này cần quyền khai báo lương VÀ phạm vi xem lương toàn công ty." };
  return user;
}

const thang = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng phải dạng YYYY-MM");
const signSchema = z.object({
  monthKey: thang,
  /** Khoá dấu vân tay bảng đối soát NGƯỜI BẤM ĐÃ THẤY (`reconFingerprintKey`). */
  fingerprintKey: z.string().min(1),
  reason: z.string().trim().min(10, "Ghi rõ đã đối chiếu những gì (ít nhất 10 ký tự)").max(800),
});
const revokeSchema = z.object({ id: z.string().min(1), reason: z.string().trim().min(10, "Ghi rõ vì sao huỷ (ít nhất 10 ký tự)").max(500) });

const tuChoi = (cong: { mode: string; reason?: string }): ReconActionResult | null =>
  cong.mode === "NEEDS_APPROVAL"
    ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo. Duyệt xong, gửi lại ĐÚNG nội dung này.` }
    : cong.mode === "BLOCKED_NO_APPROVER"
      ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` }
      : null;

async function docSo(tx: Tx): Promise<ProfitReconSignoff[] | { error: string }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-profit-signoff'))`);
  const [row] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_SIGNOFF_KEY)).limit(1);
  try {
    const cur = row ? (JSON.parse(row.value) as unknown) : [];
    return Array.isArray(cur) ? (cur as ProfitReconSignoff[]) : { error: "Ô lưu chữ ký đối soát không đúng dạng — không ghi đè lên nó." };
  } catch {
    return { error: "Ô lưu chữ ký đối soát không đọc được — không ghi đè lên nó." };
  }
}
const ghiSo = (tx: Tx, list: ProfitReconSignoff[]) => {
  const text = JSON.stringify(list);
  return tx.insert(schema.settings).values({ key: PAYROLL_PROFIT_SIGNOFF_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
};

/** KÝ (cấp 1) bảng đối soát lợi nhuận của một tháng. */
export async function signProfitReconciliation(input: unknown): Promise<ReconActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = signSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    if (await periodFinalized(monthPeriod(d.monthKey).periodKey)) return { error: `Tháng ${d.monthKey} đã khoá lương — ảnh chụp đã mang con số của nó, không ký lại.` };
    const recon = await getMonthReconciliation(d.monthKey);
    const key = reconFingerprintKey(recon.fingerprint);
    if (key !== d.fingerprintKey) return { error: `Số liệu đối soát tháng ${d.monthKey} đã đổi kể từ lúc mở trang — tải lại trang, xem lại rồi mới ký.` };
    const id = `${key}-${d.monthKey}`;
    const tomTat = recon.issues.length ? `${recon.issues.length} khoản chưa đối soát: ${recon.issues.map((i) => i.label).join("; ")}` : "mọi dòng đã khớp nguồn";
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.profit.reconcile.sign",
      entity: "PAYROLL_PROFIT_RECON",
      entityId: id,
      summary: `Ký đối soát lợi nhuận tháng ${d.monthKey} (${tomTat}). Lý do: ${d.reason}`,
      amount: null,
      payload: { ...d, status: recon.status, issues: recon.issues },
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const db = await getDb();
    const kq = await db.transaction(async (tx) => {
      const cur = await docSo(tx);
      if ("error" in cur) return cur;
      if (cur.some((c) => !c.revokedAt && c.monthKey === d.monthKey && c.fingerprint === recon.fingerprint)) return { ok: true as const, moi: false, recordId: id };
      const ban: ProfitReconSignoff = {
        id: `${id}-${Date.now()}`,
        monthKey: d.monthKey,
        fingerprint: recon.fingerprint,
        fingerprintKey: key,
        status: recon.status,
        issues: recon.issues.map((i) => ({ code: i.code, label: i.label, amount: i.amount, count: i.count })),
        reason: d.reason,
        signedById: guard.id,
        signedByEmail: guard.email ?? "",
        signedAt: new Date().toISOString(),
        revokedAt: null,
      };
      await ghiSo(tx, [...cur, ban]);
      return { ok: true as const, moi: true, recordId: ban.id };
    });
    if ("error" in kq) return kq;
    if (kq.moi) await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_PROFIT_RECON_SIGN", entity: "PAYROLL_PROFIT_RECON", entityId: kq.recordId, after: { monthKey: d.monthKey, fingerprintKey: key, status: recon.status, issues: recon.issues }, reason: d.reason });
    revalidate();
    return { ok: true, id: kq.recordId };
  });
}

/** HUỶ một chữ ký đối soát (đánh dấu, không xoá). Không cho tháng đã khoá. */
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
    const truoc = (await loadProfitSignoffs()).find((c) => c.id === d.id);
    if (!truoc) return { error: "Không tìm thấy chữ ký đang hiệu lực" };
    if (await periodFinalized(monthPeriod(truoc.monthKey).periodKey)) return { error: `Tháng ${truoc.monthKey} đã khoá lương — chữ ký đã nằm trong ảnh chụp.` };
    const db = await getDb();
    const kq = await db.transaction(async (tx) => {
      const cur = await docSo(tx);
      if ("error" in cur) return cur;
      if (!cur.some((c) => c.id === d.id && !c.revokedAt)) return { error: "Chữ ký vừa bị huỷ bởi người khác." };
      await ghiSo(tx, cur.map((c) => (c.id === d.id ? { ...c, revokedAt: new Date().toISOString(), revokedReason: d.reason, revokedById: guard.id } : c)));
      return { ok: true as const };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_PROFIT_RECON_REVOKE", entity: "PAYROLL_PROFIT_RECON", entityId: d.id, before: { revokedAt: null }, after: { revokedAt: "now" }, reason: d.reason });
    revalidate();
    return { ok: true, id: d.id };
  });
}

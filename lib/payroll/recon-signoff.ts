/**
 * ═══════════ KÝ / HUỶ CHỮ KÝ ĐỐI SOÁT CẤP 1 — SERVICE (nhận người thao tác, không đọc phiên) ═══════════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9.3. Server action (`lib/actions/payroll-reconciliation.ts`) kiểm
 * quyền + duyệt người thứ hai rồi gọi vào đây; bài kiểm gọi thẳng.
 *
 * CHỮ KÝ KÝ TRÊN ẢNH CHỤP KỲ, KHÔNG TRÊN SỐ SỐNG (review vòng 1): số sống đổi theo từng webhook / từng
 * khoản COD về, nên ký → tính → duyệt có thể không bao giờ khớp nhau, và kỳ có thưởng đủ điều kiện sẽ kẹt
 * — kéo theo cả lương cứng. Nên: TÍNH kỳ trước (ảnh chụp mang bảng đối soát), cấp 1 ký đúng ảnh ấy khi kỳ
 * đang `CALCULATED` / `UNDER_REVIEW`, cấp 2 duyệt. Tính lại kỳ ⇒ ảnh mới ⇒ chữ ký cũ không còn áp.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";
import { normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
import { PAYROLL_PROFIT_SIGNOFF_KEY, type ProfitReconSignoff } from "@/lib/constants/payroll-reconciliation";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { parseSignoffs } from "@/lib/queries/payroll-reconciliation";

export type ReconActor = { id: string | null; email: string };
export type ReconServiceResult = { ok: true; id: string; created: boolean } | { error: string };

const KY_DUOC = new Set(["CALCULATED", "UNDER_REVIEW"]);

async function kyLuongThang(monthKey: string) {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const [row] = await db
    .select({ status: p.status, snapshot: p.snapshot })
    .from(p)
    .where(and(eq(p.periodKey, monthPeriod(monthKey).periodKey), eq(p.basis, "profit1")))
    .limit(1);
  return row ? { status: normalizePayrollStatus(row.status), snapshot: row.snapshot as PayrollSnapshot | null } : null;
}

/** KÝ (cấp 1) bảng đối soát trong ảnh chụp kỳ lương tháng `monthKey`. */
export async function signProfitReconAs(actor: ReconActor, input: { monthKey: string; fingerprintKey: string; reason: string; acknowledgeIssues: boolean }): Promise<ReconServiceResult> {
  if (actor.id === null) return { error: "Máy không ký đối soát — đó là chữ ký của người." };
  const ky = await kyLuongThang(input.monthKey);
  if (!ky) return { error: `Tháng ${input.monthKey} chưa tính kỳ lương. Bấm “Tính & chụp ảnh kỳ” trước — chữ ký ký trên ảnh chụp, không trên số sống.` };
  if (!KY_DUOC.has(ky.status)) {
    return { error: ky.status === "APPROVED" ? `Kỳ tháng ${input.monthKey} đã duyệt. Muốn ký lại thì trả kỳ về để sửa trước.` : `Kỳ tháng ${input.monthKey} đang ở trạng thái “${ky.status}” — không ký được.` };
  }
  const rc = ky.snapshot?.profitRecon;
  if (!rc) return { error: `Ảnh chụp kỳ tháng ${input.monthKey} không mang bảng đối soát (chụp trước Payroll V2 vận hành) — bấm “Tính lại”.` };
  if (rc.fingerprintKey !== input.fingerprintKey) return { error: `Ảnh chụp kỳ tháng ${input.monthKey} đã được tính lại kể từ lúc mở trang — tải lại trang, xem lại rồi mới ký.` };
  if (rc.status === "UNRECONCILED" && !input.acknowledgeIssues) {
    return { error: `Bảng đối soát tháng ${input.monthKey} còn ${rc.issues.length} khoản chưa đối soát — phải đánh dấu đã xem từng khoản và ghi rõ vì sao vẫn chấp nhận.` };
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-profit-signoff'))`);
    const [row] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_SIGNOFF_KEY)).limit(1);
    const cur = parseSignoffs(row?.value ?? null);
    if (row?.value && cur.length === 0 && row.value.trim() !== "[]") return { error: "Ô lưu chữ ký đối soát không đọc được — không ghi đè lên nó." };
    const daCo = cur.find((c) => !c.revokedAt && c.monthKey === input.monthKey && c.fingerprint === rc.fingerprint);
    if (daCo) return { ok: true as const, id: daCo.id, created: false };
    const ban: ProfitReconSignoff = {
      id: `${rc.fingerprintKey}-${input.monthKey}-${Date.now()}`,
      monthKey: input.monthKey,
      fingerprint: rc.fingerprint,
      fingerprintKey: rc.fingerprintKey,
      status: rc.status,
      issues: rc.issues.map((i) => ({ code: i.code, label: i.label, amount: i.amount, count: i.count })),
      reason: input.reason,
      signedById: actor.id,
      signedByEmail: actor.email,
      signedAt: new Date().toISOString(),
      revokedAt: null,
    };
    const text = JSON.stringify([...cur, ban]);
    await tx.insert(schema.settings).values({ key: PAYROLL_PROFIT_SIGNOFF_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
    return { ok: true as const, id: ban.id, created: true };
  });
}

/**
 * HUỶ một chữ ký (đánh dấu, không xoá). Kỳ đã khoá thì không — chữ ký đã nằm trong lượt khoá. Huỷ khi kỳ
 * đã DUYỆT vẫn được: bước KHOÁ kiểm lại chữ ký còn hiệu lực, nên kỳ ấy phải trả về và ký lại.
 */
export async function revokeProfitReconAs(actor: ReconActor, input: { id: string; reason: string }): Promise<ReconServiceResult> {
  if (actor.id === null) return { error: "Máy không huỷ chữ ký đối soát." };
  const db = await getDb();
  const [row0] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_SIGNOFF_KEY)).limit(1);
  const truoc = parseSignoffs(row0?.value ?? null).find((c) => c.id === input.id && !c.revokedAt);
  if (!truoc) return { error: "Không tìm thấy chữ ký đang hiệu lực" };
  const ky = await kyLuongThang(truoc.monthKey);
  if (ky && (ky.status === "LOCKED" || ky.status === "PAID")) return { error: `Kỳ tháng ${truoc.monthKey} đã khoá lương — chữ ký đã nằm trong lượt khoá, không huỷ.` };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-profit-signoff'))`);
    // Đọc LẠI trạng thái kỳ TRONG giao dịch, dưới khoá tên mà bước KHOÁ cũng lấy: một lượt khoá lọt vào giữa
    // lượt kiểm ở trên và lượt ghi này sẽ để lại kỳ đã khoá mang chữ ký "đã huỷ" (review vòng 2).
    const p = schema.payrollPeriods;
    const [kyNay] = await tx.select({ status: p.status }).from(p).where(and(eq(p.periodKey, monthPeriod(truoc.monthKey).periodKey), eq(p.basis, "profit1"))).limit(1);
    const st = kyNay ? normalizePayrollStatus(kyNay.status) : null;
    if (st === "LOCKED" || st === "PAID") return { error: `Kỳ tháng ${truoc.monthKey} vừa được khoá — chữ ký đã nằm trong lượt khoá, không huỷ.` };
    const [row] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_SIGNOFF_KEY)).limit(1);
    const cur = parseSignoffs(row?.value ?? null);
    if (!cur.some((c) => c.id === input.id && !c.revokedAt)) return { error: "Chữ ký vừa bị huỷ bởi người khác." };
    const text = JSON.stringify(cur.map((c) => (c.id === input.id ? { ...c, revokedAt: new Date().toISOString(), revokedReason: input.reason, revokedById: actor.id } : c)));
    await tx.insert(schema.settings).values({ key: PAYROLL_PROFIT_SIGNOFF_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
    return { ok: true as const, id: input.id, created: false };
  });
}

"use server";

/**
 * ═══════ PHÂN CÔNG MKTer ↔ MÃ VÀ ĐIỀU KHOẢN THƯỞNG THEO MÃ — ĐƯỜNG GHI DUY NHẤT ═══════
 *
 * Đặc tả: `docs/payroll-code-ledger.md`. Trình tự: `requireUser` → quyền khai báo lương + phạm vi toàn
 * công ty → zod → duyệt người thứ hai (`PAYROLL_EDIT`) → drizzle dưới khoá tên của mã → `audit()` →
 * `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`.
 *
 * ─── KHÔNG GHI ĐÈ ───
 *
 * Đổi người / tỷ lệ = KẾT THÚC dòng cũ + THÊM dòng mới; không có đường sửa tỷ lệ của một dòng. Mốc
 * hiệu lực không được rơi vào tháng đã khoá: tháng ấy đọc ảnh chụp, và một dòng lùi ngày sẽ làm sổ
 * nói một đằng còn tiền đã trả một nẻo.
 *
 * ─── MỘT OWNER MỘT LÚC ───
 *
 * Kiểm dưới `pg_advisory_xact_lock` theo mã: hai người cùng bấm "giao OWNER" thì người sau thấy dòng
 * của người trước. Thêm OWNER mới khi OWNER cũ bắt đầu SỚM HƠN ⇒ dòng cũ tự đóng ở ngày liền trước
 * (bàn giao); OWNER cũ bắt đầu cùng ngày hoặc muộn hơn ⇒ từ chối, vì không có cách đọc nào đúng.
 */
import { and, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { listEmployees } from "@/lib/queries/payroll";
import { monthsBetween } from "@/lib/queries/payroll-profit-gate";
import { periodFinalized } from "@/lib/queries/payroll-engine";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";

export type CodeActionResult = { ok: true; id?: string } | { error: string };

const SURFACES = ["/payroll", "/payroll/codes", "/payroll/codes/assignments"] as const;
function revalidate() {
  for (const p of SURFACES) revalidatePath(p);
}

type SessionUser = Awaited<ReturnType<typeof requireUser>>;

async function requireManage(): Promise<SessionUser | { error: string }> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Việc này cần quyền khai báo lương VÀ phạm vi xem lương toàn công ty." };
  return user;
}

const ngay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải có dạng YYYY-MM-DD");
const phanTram = z.coerce.number().min(0, "Tỷ lệ không được âm").max(100, "Tỷ lệ tối đa 100%");

const assignmentSchema = z
  .object({
    productId: z.string().min(1, "Chọn mã sản phẩm"),
    employeeId: z.string().min(1, "Chọn MKTer"),
    role: z.enum(["OWNER", "SUPPORT"]),
    ownerRatePercent: phanTram.optional(),
    weightMethod: z.enum(["MANUAL", "AD_SPEND", "ATTRIBUTED_REVENUE"]).optional(),
    weightPercent: phanTram.optional(),
    effectiveFrom: ngay,
    effectiveTo: ngay.optional().or(z.literal("")),
    policyRef: z.string().trim().min(1, "Ghi số hiệu quy chế / hợp đồng mà phân công này áp theo"),
    note: z.string().trim().max(500).default(""),
  })
  .superRefine((d, ctx) => {
    if (d.role === "OWNER" && d.ownerRatePercent === undefined) ctx.addIssue({ code: "custom", message: "OWNER phải có X% (tỷ lệ thưởng trên lợi nhuận đủ điều kiện của mã)" });
    if (d.role === "SUPPORT" && !d.weightMethod) ctx.addIssue({ code: "custom", message: "SUPPORT phải chọn cách tính trọng số" });
    if (d.role === "SUPPORT" && d.weightMethod === "MANUAL" && d.weightPercent === undefined) ctx.addIssue({ code: "custom", message: "Trọng số tay phải có % đã duyệt" });
    if (d.effectiveTo && d.effectiveTo < d.effectiveFrom) ctx.addIssue({ code: "custom", message: "Ngày kết thúc phải sau ngày bắt đầu" });
  });

const termsSchema = z
  .object({
    productId: z.string().optional().or(z.literal("")),
    supportPoolPercent: phanTram,
    maxBonusAmount: z.coerce.number().int().min(0).optional().or(z.literal("")),
    effectiveFrom: ngay,
    effectiveTo: ngay.optional().or(z.literal("")),
    policyRef: z.string().trim().min(1, "Ghi số hiệu quy chế / hợp đồng mà điều khoản này áp theo"),
    note: z.string().trim().max(500).default(""),
  })
  .superRefine((d, ctx) => {
    if (d.effectiveTo && d.effectiveTo < d.effectiveFrom) ctx.addIssue({ code: "custom", message: "Ngày kết thúc phải sau ngày bắt đầu" });
  });

const bp = (pct: number) => Math.round(pct * 100);

/** Tháng đã khoá đầu tiên mà khoảng [from, to] chạm tới (`to` rỗng = tới hôm nay). */
async function lockedMonthIn(fromKey: string, toKey: string | null): Promise<string | null> {
  const end = (toKey ?? vnDateKey(new Date())).slice(0, 7);
  for (const m of monthsBetween(fromKey.slice(0, 7), end)) {
    if (await periodFinalized(monthPeriod(m).periodKey)) return m;
  }
  return null;
}

/** Giao một MKTer vào một mã (OWNER hoặc SUPPORT). */
export async function saveCodeAssignment(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = assignmentSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const db = await getDb();
    const [sp0] = await db.select({ id: schema.products.id, customId: schema.products.customId, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, d.productId)).limit(1);
    if (!sp0) return { error: "Không tìm thấy mã sản phẩm" };
    const sp = { code: sp0.customId || sp0.name };
    const nv = (await listEmployees()).find((e) => e.id === d.employeeId);
    if (!nv) return { error: "MKTer này không có trong danh sách nhân sự của bảng lương" };
    const khoa = await lockedMonthIn(d.effectiveFrom, null);
    if (khoa) return { error: `Tháng ${khoa} đã khoá lương — phân công mới chỉ được bắt đầu sau tháng đã khoá cuối cùng. Kỳ đã khoá không tính lại.` };

    const from = vnStartOfDay(d.effectiveFrom);
    const to = d.effectiveTo ? vnEndOfDay(d.effectiveTo) : null;
    const id = randomUUID();
    const values = {
      productId: d.productId,
      employeeId: d.employeeId,
      role: d.role,
      ownerRateBp: d.role === "OWNER" ? bp(d.ownerRatePercent ?? 0) : null,
      weightMethod: d.role === "SUPPORT" ? (d.weightMethod ?? null) : null,
      weightBp: d.role === "SUPPORT" && d.weightMethod === "MANUAL" ? bp(d.weightPercent ?? 0) : null,
      effectiveFrom: from,
      effectiveTo: to,
      policyRef: d.policyRef,
      note: d.note,
    };
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.code.assign",
      entity: "PRODUCT_MARKETER_ASSIGNMENT",
      entityId: id,
      summary: `Giao ${nv.shortName || nv.name} làm ${d.role} mã ${sp.code} từ ${d.effectiveFrom}${d.role === "OWNER" ? ` (X = ${d.ownerRatePercent}%)` : ""}`,
      amount: null,
      payload: values,
    });
    if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
    if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };

    const a = schema.productMarketerAssignments;
    const chong = (role: string, employeeId?: string): SQL => {
      const conds: SQL[] = [eq(a.productId, d.productId), eq(a.status, "APPROVED"), eq(a.role, role), or(isNull(a.effectiveTo), sql`${a.effectiveTo} >= ${from}`) as SQL];
      if (to) conds.push(lte(a.effectiveFrom, to));
      if (employeeId) conds.push(eq(a.employeeId, employeeId));
      return and(...conds) as SQL;
    };
    const kq = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp:payroll-code:${d.productId}`}))`);
      const trung = await tx.select({ id: a.id }).from(a).where(chong(d.role, d.employeeId)).limit(1);
      if (trung.length) return { error: `${nv.shortName || nv.name} đã là ${d.role} của mã ${sp.code} trong khoảng này — kết thúc dòng cũ trước khi đổi tỷ lệ.` };
      const dong: string[] = [];
      if (d.role === "OWNER") {
        const cu = await tx.select({ id: a.id, from: a.effectiveFrom }).from(a).where(chong("OWNER"));
        if (cu.some((c) => c.from.getTime() >= from.getTime())) return { error: `Mã ${sp.code} đã có OWNER bắt đầu cùng ngày hoặc muộn hơn — mỗi mã tối đa một OWNER một lúc. Kết thúc / huỷ dòng ấy trước.` };
        const dongTai = new Date(from.getTime() - 1);
        for (const c of cu) {
          await tx.update(a).set({ effectiveTo: dongTai, updatedAt: new Date() }).where(eq(a.id, c.id));
          dong.push(c.id);
        }
      }
      await tx.insert(a).values({ id, ...values, status: "APPROVED", createdBy: guard.id, approvedBy: guard.id, approvedAt: new Date() });
      return { ok: true as const, dong };
    });
    if ("error" in kq) return kq;
    await audit({
      userId: guard.id,
      userEmail: guard.email,
      action: "PAYROLL_CODE_ASSIGN",
      entity: "PRODUCT_MARKETER_ASSIGNMENT",
      entityId: id,
      after: values,
      reason: kq.dong.length ? `Bàn giao OWNER: đóng ${kq.dong.length} dòng OWNER cũ (${kq.dong.join(", ")}) ở ngày liền trước. Sổ lợi nhuận của mã KHÔNG reset.` : undefined,
    });
    revalidate();
    return { ok: true, id };
  });
}

/** Kết thúc một phân công tại một ngày (không xoá, không sửa tỷ lệ). */
export async function endCodeAssignment(id: string, effectiveTo: string): Promise<CodeActionResult> {
  return endRow("ASSIGNMENT", id, effectiveTo);
}

/** Kết thúc một điều khoản thưởng theo mã tại một ngày. */
export async function endCodeTerms(id: string, effectiveTo: string): Promise<CodeActionResult> {
  return endRow("TERMS", id, effectiveTo);
}

async function endRow(kind: "ASSIGNMENT" | "TERMS", id: string, effectiveTo: string): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    if (!ngay.safeParse(effectiveTo).success) return { error: "Ngày phải có dạng YYYY-MM-DD" };
    const db = await getDb();
    const t = kind === "ASSIGNMENT" ? schema.productMarketerAssignments : schema.productBonusTerms;
    const [row] = await db.select({ id: t.id, from: t.effectiveFrom, to: t.effectiveTo, status: t.status }).from(t).where(eq(t.id, id)).limit(1);
    if (!row || row.status !== "APPROVED") return { error: "Không tìm thấy dòng đang hiệu lực" };
    const to = vnEndOfDay(effectiveTo);
    if (to.getTime() < row.from.getTime()) return { error: "Ngày kết thúc phải sau ngày bắt đầu" };
    if (row.to && to.getTime() > row.to.getTime()) return { error: "Chỉ được rút ngắn hiệu lực — muốn kéo dài thì thêm dòng mới" };
    const khoa = await lockedMonthIn(effectiveTo, row.to ? vnDateKey(row.to) : null);
    if (khoa) return { error: `Tháng ${khoa} đã khoá lương — không đổi được hiệu lực trong tháng ấy.` };
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: kind === "ASSIGNMENT" ? "payroll.code.assign.end" : "payroll.code.terms.end",
      entity: kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS",
      entityId: id,
      summary: `Kết thúc hiệu lực ngày ${effectiveTo}`,
      amount: null,
      payload: { id, effectiveTo },
    });
    if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
    if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    await db.update(t).set({ effectiveTo: to, updatedAt: new Date() }).where(eq(t.id, id));
    await audit({ userId: guard.id, userEmail: guard.email, action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN_END" : "PAYROLL_CODE_TERMS_END", entity: kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS", entityId: id, before: { effectiveTo: row.to }, after: { effectiveTo: to } });
    revalidate();
    return { ok: true, id };
  });
}

/**
 * Huỷ một dòng NHẬP NHẦM (`REVOKED`). Chỉ khi hiệu lực của nó chưa chạm tháng đã khoá — dòng đã
 * dùng cho một kỳ đã khoá thì chỉ được KẾT THÚC.
 */
export async function revokeCodeRow(kind: "ASSIGNMENT" | "TERMS", id: string, reason: string): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    if (!reason.trim()) return { error: "Ghi lý do huỷ" };
    const db = await getDb();
    const t = kind === "ASSIGNMENT" ? schema.productMarketerAssignments : schema.productBonusTerms;
    const [row] = await db.select({ id: t.id, from: t.effectiveFrom, to: t.effectiveTo, status: t.status }).from(t).where(eq(t.id, id)).limit(1);
    if (!row || row.status !== "APPROVED") return { error: "Không tìm thấy dòng đang hiệu lực" };
    const khoa = await lockedMonthIn(vnDateKey(row.from), row.to ? vnDateKey(row.to) : null);
    if (khoa) return { error: `Dòng này đã hiệu lực trong tháng ${khoa} (đã khoá lương) — chỉ được kết thúc, không huỷ.` };
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: kind === "ASSIGNMENT" ? "payroll.code.assign.revoke" : "payroll.code.terms.revoke",
      entity: kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS",
      entityId: id,
      summary: `Huỷ dòng nhập nhầm: ${reason.trim()}`,
      amount: null,
      payload: { id, reason },
    });
    if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
    if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    await db.update(t).set({ status: "REVOKED", updatedAt: new Date() }).where(eq(t.id, id));
    await audit({ userId: guard.id, userEmail: guard.email, action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN_REVOKE" : "PAYROLL_CODE_TERMS_REVOKE", entity: kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS", entityId: id, before: { status: "APPROVED" }, after: { status: "REVOKED" }, reason: reason.trim() });
    revalidate();
    return { ok: true, id };
  });
}

/** Khai điều khoản Y% quỹ hỗ trợ + trần thưởng — cho một mã, hoặc mặc định công ty (`productId` rỗng). */
export async function saveCodeTerms(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = termsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const productId = d.productId ? d.productId : null;
    const db = await getDb();
    let code = "mặc định công ty";
    if (productId) {
      const [sp0] = await db.select({ customId: schema.products.customId, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
      if (!sp0) return { error: "Không tìm thấy mã sản phẩm" };
      code = `mã ${sp0.customId || sp0.name}`;
    }
    const khoa = await lockedMonthIn(d.effectiveFrom, null);
    if (khoa) return { error: `Tháng ${khoa} đã khoá lương — điều khoản mới chỉ được bắt đầu sau tháng đã khoá cuối cùng.` };
    const from = vnStartOfDay(d.effectiveFrom);
    const to = d.effectiveTo ? vnEndOfDay(d.effectiveTo) : null;
    const id = randomUUID();
    const values = {
      productId,
      supportPoolBp: bp(d.supportPoolPercent),
      maxBonusAmount: d.maxBonusAmount === "" || d.maxBonusAmount === undefined ? null : d.maxBonusAmount,
      effectiveFrom: from,
      effectiveTo: to,
      policyRef: d.policyRef,
      note: d.note,
    };
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.code.terms",
      entity: "PRODUCT_BONUS_TERMS",
      entityId: id,
      summary: `Điều khoản thưởng ${code}: Y = ${d.supportPoolPercent}%, trần ${values.maxBonusAmount ?? "không"} — từ ${d.effectiveFrom}`,
      amount: values.maxBonusAmount,
      payload: values,
    });
    if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
    if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    const t = schema.productBonusTerms;
    const kq = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp:payroll-code:${productId ?? "*"}`}))`);
      const conds: SQL[] = [productId ? eq(t.productId, productId) : isNull(t.productId), eq(t.status, "APPROVED"), or(isNull(t.effectiveTo), sql`${t.effectiveTo} >= ${from}`) as SQL];
      if (to) conds.push(lte(t.effectiveFrom, to));
      const cu = await tx.select({ id: t.id, from: t.effectiveFrom }).from(t).where(and(...conds));
      if (cu.some((c) => c.from.getTime() >= from.getTime())) return { error: `Điều khoản ${code} đã có dòng bắt đầu cùng ngày hoặc muộn hơn — kết thúc / huỷ dòng ấy trước.` };
      const dongTai = new Date(from.getTime() - 1);
      for (const c of cu) await tx.update(t).set({ effectiveTo: dongTai, updatedAt: new Date() }).where(eq(t.id, c.id));
      await tx.insert(t).values({ id, ...values, status: "APPROVED", createdBy: guard.id, approvedBy: guard.id, approvedAt: new Date() });
      return { ok: true as const, dong: cu.map((c) => c.id) };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_CODE_TERMS", entity: "PRODUCT_BONUS_TERMS", entityId: id, after: values, reason: kq.dong.length ? `Đóng ${kq.dong.length} điều khoản cũ ở ngày liền trước.` : undefined });
    revalidate();
    return { ok: true, id };
  });
}

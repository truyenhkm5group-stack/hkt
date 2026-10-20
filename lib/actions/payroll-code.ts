"use server";

/**
 * ═══════ PHÂN CÔNG MKTer ↔ MÃ VÀ ĐIỀU KHOẢN THƯỞNG THEO MÃ — ĐƯỜNG GHI DUY NHẤT ═══════
 *
 * Đặc tả: `docs/payroll-code-ledger.md`. Trình tự: `requireUser` → quyền khai báo lương + phạm vi toàn
 * công ty → zod (`lib/validation/payroll-code.ts`) → duyệt người thứ hai (`PAYROLL_EDIT`) → drizzle dưới
 * khoá tên của mã → `audit()` → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`.
 *
 * ─── KHÔNG GHI ĐÈ ───
 *
 * Đổi người / tỷ lệ = KẾT THÚC dòng cũ + THÊM dòng mới; không có đường sửa tỷ lệ của một dòng. Mốc
 * hiệu lực không được rơi vào tháng đã khoá: tháng ấy đọc ảnh chụp, và một dòng lùi ngày sẽ làm sổ
 * nói một đằng còn tiền đã trả một nẻo. Kiểm tháng khoá ĐỌC TRONG CÙNG giao dịch, sau khoá tên.
 *
 * ─── MỘT OWNER MỘT LÚC ───
 *
 * `planOwnerHandover` (hàm thuần) quyết, dưới `pg_advisory_xact_lock` theo mã. OWNER mới có ngày kết
 * thúc mà chồng lên OWNER đang có ⇒ TỪ CHỐI — đóng người cũ là cắt luôn quyền của họ sau ngày ấy.
 *
 * ─── KHAI ≠ DUYỆT (Payroll V2, chủ shop 20/10/2026) ───
 *
 * "Chưa có phê duyệt thì giữ trạng thái chờ, không tự mặc định tỷ lệ." Lưu một phân công / điều khoản
 * chỉ tạo dòng `PENDING` — `loadCodeBook` chỉ đọc `APPROVED`, nên dòng chờ KHÔNG chạm một đồng lương
 * nào. `approveCodeRow` là đường DUY NHẤT đưa dòng sang `APPROVED`: nó đi qua duyệt người thứ hai
 * (`PAYROLL_EDIT`) và người khai không tự duyệt dòng của mình (trừ chủ shop — vai trò `ADMIN`). Bàn
 * giao OWNER / đóng điều khoản cũ xảy ra LÚC DUYỆT, không lúc khai: khai chưa được quyền cắt ai.
 *
 * ─── KHOÁ DÒNG THEO NỘI DUNG ───
 *
 * `codeRowId` băm nội dung: lần gửi lại sau khi người thứ hai duyệt mang ĐÚNG khoá đã được duyệt.
 * Người duyệt ghi vào dòng là người QUYẾT yêu cầu (`approval_requests.decided_by`), không phải người gửi.
 */
import { and, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { getPayrollReport, listEmployees, monthReportPeriod } from "@/lib/queries/payroll";
import { monthsBetween } from "@/lib/queries/payroll-profit-gate";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";
import { isFrozen, normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
import { codeApproveSchema, codeAssignmentSchema, codeEndSchema, codeRevokeSchema, codeRowId, codeTermsSchema, codeWeightConfirmSchema, codeWeightRevokeSchema, endChangesFromKey, planOwnerHandover } from "@/lib/validation/payroll-code";
import { PAYROLL_CODE_WEIGHT_CONFIRM_KEY, type CodeWeightConfirmation } from "@/lib/constants/payroll-code";
import { describeFingerprint } from "@/lib/payroll/code-ledger";

export type CodeActionResult = { ok: true; id?: string } | { error: string };

const SURFACES = ["/payroll", "/payroll/codes", "/payroll/codes/assignments", "/payroll/reconciliation/center"] as const;
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

const bp = (pct: number) => Math.round(pct * 100);
const tuChoi = (cong: { mode: string; reason?: string }): CodeActionResult | null =>
  cong.mode === "NEEDS_APPROVAL"
    ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo. Duyệt xong, gửi lại ĐÚNG nội dung này.` }
    : cong.mode === "BLOCKED_NO_APPROVER"
      ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` }
      : null;

/**
 * Người QUYẾT yêu cầu duyệt vừa được tiêu thụ; không có lượt duyệt (nhóm chưa cưỡng chế) ⇒ chính người
 * làm. Gọi TRƯỚC `db.transaction` — trên PGlite (một kết nối) một câu `getDb()` trong giao dịch tự khoá.
 */
async function nguoiDuyet(cong: { consumed?: boolean; requestId?: string }, guard: SessionUser): Promise<{ id: string | null; email: string }> {
  if (!cong.consumed || !cong.requestId) return { id: guard.id, email: guard.email ?? "" };
  const db = await getDb();
  const [r] = await db
    .select({ by: schema.approvalRequests.decidedBy, email: schema.approvalRequests.decidedByEmail })
    .from(schema.approvalRequests)
    .where(eq(schema.approvalRequests.id, cong.requestId))
    .limit(1);
  return { id: r?.by ?? null, email: r?.email ?? "" };
}

/** Tháng đã khoá đầu tiên mà khoảng [fromKey, toKey] chạm tới (`toKey` rỗng = tới hôm nay). Đọc qua `tx`. */
async function lockedMonthIn(tx: Tx, fromKey: string, toKey: string | null): Promise<string | null> {
  const months = monthsBetween(fromKey.slice(0, 7), (toKey ?? vnDateKey(new Date())).slice(0, 7));
  if (!months.length) return null;
  const keys = new Map(months.map((m) => [monthPeriod(m).periodKey, m] as const));
  const p = schema.payrollPeriods;
  const rows = await tx.select({ key: p.periodKey, status: p.status }).from(p).where(inArray(p.periodKey, [...keys.keys()]));
  const khoa = rows.filter((r) => isFrozen(normalizePayrollStatus(r.status))).map((r) => keys.get(r.key) ?? r.key);
  return khoa.sort()[0] ?? null;
}

const khoaMa = (tx: Tx, productId: string | null) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp:payroll-code:${productId ?? "*"}`}))`);

/** Giao một MKTer vào một mã (OWNER hoặc SUPPORT). */
export async function saveCodeAssignment(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeAssignmentSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const db = await getDb();
    const [sp0] = await db.select({ customId: schema.products.customId, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, d.productId)).limit(1);
    if (!sp0) return { error: "Không tìm thấy mã sản phẩm" };
    const code = sp0.customId || sp0.name;
    const nv = (await listEmployees()).find((e) => e.id === d.employeeId);
    if (!nv) return { error: "MKTer này không có trong danh sách nhân sự của bảng lương" };

    const from = vnStartOfDay(d.effectiveFrom);
    const to = d.effectiveTo ? vnEndOfDay(d.effectiveTo) : null;
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
    const id = codeRowId("ASSIGNMENT", values);
    const a = schema.productMarketerAssignments;
    const kq = await db.transaction(async (tx) => {
      await khoaMa(tx, d.productId);
      const khoa = await lockedMonthIn(tx, d.effectiveFrom, null);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — phân công mới chỉ được bắt đầu sau tháng đã khoá cuối cùng. Kỳ đã khoá không tính lại.` };
      const [daCo] = await tx.select({ status: a.status }).from(a).where(eq(a.id, id)).limit(1);
      if (daCo) return { error: daCo.status === "REVOKED" ? "Một dòng GIỐNG HỆT đã bị huỷ trước đó. Ghi lại thì đổi ghi chú (vd «ghi lại sau khi huỷ nhầm») để thành một dòng mới có dấu vết." : daCo.status === "PENDING" ? "Đúng phân công này đang chờ duyệt." : "Đúng phân công này đã được ghi rồi." };
      const trung = await tx.select({ id: a.id, status: a.status }).from(a).where(assignmentOverlap(d.productId, d.role, from, to, ["APPROVED", "PENDING"], d.employeeId)).limit(1);
      if (trung.length) return { error: `${nv.shortName || nv.name} đã ${trung[0].status === "PENDING" ? "có một dòng CHỜ DUYỆT" : "là"} ${d.role} của mã ${code} trong khoảng này — ${trung[0].status === "PENDING" ? "duyệt hoặc huỷ dòng ấy trước" : "kết thúc dòng cũ trước khi đổi tỷ lệ"}.` };
      await tx.insert(a).values({ id, ...values, status: "PENDING", createdBy: guard.id, approvedBy: null, approvedAt: null });
      return { ok: true as const };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_CODE_ASSIGN_PROPOSE", entity: "PRODUCT_MARKETER_ASSIGNMENT", entityId: id, after: { ...values, status: "PENDING" }, reason: "Khai phân công — CHỜ DUYỆT, chưa áp vào lương." });
    revalidate();
    return { ok: true, id };
  });
}

/** Phân công cùng mã · cùng vai trò · chồng khoảng `[from, to]`, ở các trạng thái cho trước. */
function assignmentOverlap(productId: string, role: string, from: Date, to: Date | null, statuses: readonly string[], employeeId?: string): SQL {
  const a = schema.productMarketerAssignments;
  const conds: SQL[] = [eq(a.productId, productId), inArray(a.status, [...statuses]), eq(a.role, role), or(isNull(a.effectiveTo), sql`${a.effectiveTo} >= ${from}`) as SQL];
  if (to) conds.push(lte(a.effectiveFrom, to));
  if (employeeId) conds.push(eq(a.employeeId, employeeId));
  return and(...conds) as SQL;
}

/** Điều khoản cùng phạm vi (mã / mặc định công ty) chồng khoảng `[from, to]`. */
function termsOverlap(productId: string | null, from: Date, to: Date | null, statuses: readonly string[]): SQL {
  const t = schema.productBonusTerms;
  const conds: SQL[] = [productId ? eq(t.productId, productId) : isNull(t.productId), inArray(t.status, [...statuses]), or(isNull(t.effectiveTo), sql`${t.effectiveTo} >= ${from}`) as SQL];
  if (to) conds.push(lte(t.effectiveFrom, to));
  return and(...conds) as SQL;
}

/**
 * DUYỆT một dòng đang chờ (`PENDING` → `APPROVED`). Đường DUY NHẤT làm một phân công / điều khoản có
 * hiệu lực. Người khai không tự duyệt (trừ chủ shop); duyệt người thứ hai theo nhóm `PAYROLL_EDIT`.
 * Bàn giao OWNER / đóng điều khoản cũ làm ở ĐÂY, dưới khoá tên của mã, với tháng khoá đọc lại.
 */
export async function approveCodeRow(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeApproveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const { kind, id } = parsed.data;
    const db = await getDb();
    const a = schema.productMarketerAssignments;
    const t = schema.productBonusTerms;
    const entity = kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS";
    const tbl = kind === "ASSIGNMENT" ? a : t;
    const [row] = await db.select({ productId: tbl.productId, from: tbl.effectiveFrom, to: tbl.effectiveTo, status: tbl.status, createdBy: tbl.createdBy }).from(tbl).where(eq(tbl.id, id)).limit(1);
    if (!row || row.status !== "PENDING") return { error: "Không tìm thấy dòng đang chờ duyệt" };
    const [asg] = kind === "ASSIGNMENT" ? await db.select({ role: a.role, employeeId: a.employeeId, ownerRateBp: a.ownerRateBp, weightMethod: a.weightMethod, weightBp: a.weightBp }).from(a).where(eq(a.id, id)).limit(1) : [];
    const [trm] = kind === "TERMS" ? await db.select({ supportPoolBp: t.supportPoolBp, maxBonusAmount: t.maxBonusAmount }).from(t).where(eq(t.id, id)).limit(1) : [];
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: kind === "ASSIGNMENT" ? "payroll.code.assign" : "payroll.code.terms",
      entity,
      entityId: id,
      summary:
        kind === "ASSIGNMENT"
          ? `Duyệt phân công ${asg?.role ?? ""} (${asg?.role === "OWNER" ? `X = ${(asg.ownerRateBp ?? 0) / 100}%` : asg?.weightMethod ?? ""}) từ ${vnDateKey(row.from)}${row.to ? ` tới ${vnDateKey(row.to)}` : ""}`
          : `Duyệt điều khoản thưởng Y = ${(trm?.supportPoolBp ?? 0) / 100}% từ ${vnDateKey(row.from)}`,
      amount: kind === "TERMS" ? (trm?.maxBonusAmount ?? null) : null,
      payload: { kind, id },
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const duyet = await nguoiDuyet(cong, guard);
    if (!duyet.id) return { error: "Không đọc được người duyệt của yêu cầu — không duyệt một dòng mà không ghi được ai đã duyệt." };
    if (duyet.id && duyet.id === row.createdBy && !(duyet.id === guard.id && guard.role === "ADMIN")) {
      return { error: "Người khai không tự duyệt dòng của chính mình — cần một người quản trị lương khác, hoặc chủ shop duyệt." };
    }
    const kq = await db.transaction(async (tx) => {
      await khoaMa(tx, row.productId);
      const khoa = await lockedMonthIn(tx, vnDateKey(row.from), null);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — dòng này bắt đầu trước tháng đã khoá nên không duyệt được. Huỷ và khai lại với ngày bắt đầu sau tháng khoá.` };
      let dong: { id: string; before: Date | null; after: Date }[] = [];
      if (kind === "ASSIGNMENT" && asg && row.productId) {
        const trung = await tx.select({ id: a.id }).from(a).where(assignmentOverlap(row.productId, asg.role, row.from, row.to, ["APPROVED"], asg.employeeId)).limit(1);
        if (trung.length) return { error: `MKTer này đã là ${asg.role} của mã trong khoảng này — kết thúc dòng cũ trước khi duyệt dòng mới.` };
        if (asg.role === "OWNER") {
          const cu = await tx.select({ id: a.id, from: a.effectiveFrom, to: a.effectiveTo }).from(a).where(assignmentOverlap(row.productId, "OWNER", row.from, row.to, ["APPROVED"]));
          const plan = planOwnerHandover(cu, row.from, row.to);
          if ("error" in plan) return { error: plan.error };
          for (const c of plan.close) await tx.update(a).set({ effectiveTo: c.after, updatedAt: new Date() }).where(eq(a.id, c.id));
          dong = plan.close;
        }
      } else if (kind === "TERMS") {
        const cu = await tx.select({ id: t.id, from: t.effectiveFrom, to: t.effectiveTo }).from(t).where(termsOverlap(row.productId, row.from, row.to, ["APPROVED"]));
        const plan = planOwnerHandover(cu, row.from, row.to, "điều khoản");
        if ("error" in plan) return { error: plan.error };
        for (const c of plan.close) await tx.update(t).set({ effectiveTo: c.after, updatedAt: new Date() }).where(eq(t.id, c.id));
        dong = plan.close;
      }
      const sua = await tx.update(tbl).set({ status: "APPROVED", approvedBy: duyet.id, approvedAt: new Date(), updatedAt: new Date() }).where(and(eq(tbl.id, id), eq(tbl.status, "PENDING"))).returning({ id: tbl.id });
      if (!sua.length) return { error: "Dòng này vừa được người khác duyệt hoặc huỷ." };
      return { ok: true as const, dong };
    });
    if ("error" in kq) return kq;
    await audit({
      userId: guard.id,
      userEmail: guard.email,
      action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN" : "PAYROLL_CODE_TERMS",
      entity,
      entityId: id,
      before: { status: "PENDING", ...(kq.dong.length ? { closed: kq.dong.map((c) => ({ id: c.id, effectiveTo: c.before })) } : {}) },
      after: { status: "APPROVED", approvedBy: duyet.id, closed: kq.dong.map((c) => ({ id: c.id, effectiveTo: c.after })) },
      reason: kq.dong.length ? `Duyệt và đóng ${kq.dong.length} dòng cũ ở ngày liền trước. Sổ lợi nhuận của mã KHÔNG reset.` : "Duyệt dòng chờ.",
    });
    revalidate();
    return { ok: true, id };
  });
}

/** Kết thúc một phân công / điều khoản tại một ngày (chỉ rút ngắn — không xoá, không sửa tỷ lệ). */
export async function endCodeRow(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeEndSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const { kind, id, effectiveTo } = parsed.data;
    const db = await getDb();
    const t = kind === "ASSIGNMENT" ? schema.productMarketerAssignments : schema.productBonusTerms;
    const entity = kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS";
    const [row] = await db.select({ productId: t.productId, from: t.effectiveFrom, to: t.effectiveTo, status: t.status }).from(t).where(eq(t.id, id)).limit(1);
    if (!row || row.status !== "APPROVED") return { error: "Không tìm thấy dòng đang hiệu lực" };
    const to = vnEndOfDay(effectiveTo);
    if (to.getTime() < row.from.getTime()) return { error: "Ngày kết thúc phải sau ngày bắt đầu" };
    if (row.to && to.getTime() >= row.to.getTime()) return { error: "Chỉ được rút ngắn hiệu lực — muốn kéo dài thì thêm dòng mới" };
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: kind === "ASSIGNMENT" ? "payroll.code.assign.end" : "payroll.code.terms.end",
      entity,
      entityId: id,
      summary: `Kết thúc hiệu lực ngày ${effectiveTo}`,
      amount: null,
      payload: { id, effectiveTo },
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const kq = await db.transaction(async (tx) => {
      await khoaMa(tx, row.productId);
      const khoa = await lockedMonthIn(tx, endChangesFromKey(effectiveTo), row.to ? vnDateKey(row.to) : null);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — không đổi được hiệu lực trong tháng ấy.` };
      await tx.update(t).set({ effectiveTo: to, updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.status, "APPROVED")));
      return { ok: true as const };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN_END" : "PAYROLL_CODE_TERMS_END", entity, entityId: id, before: { effectiveTo: row.to }, after: { effectiveTo: to } });
    revalidate();
    return { ok: true, id };
  });
}

/**
 * Huỷ một dòng NHẬP NHẦM (`REVOKED`). Chỉ khi hiệu lực của nó chưa chạm tháng đã khoá — dòng đã
 * dùng cho một kỳ đã khoá thì chỉ được KẾT THÚC. Huỷ KHÔNG tự mở lại OWNER đã bị bàn giao: đó là một
 * quyết định mới, đi bằng một dòng mới.
 */
export async function revokeCodeRow(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeRevokeSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const { kind, id, reason } = parsed.data;
    const db = await getDb();
    const t = kind === "ASSIGNMENT" ? schema.productMarketerAssignments : schema.productBonusTerms;
    const entity = kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS";
    const [row] = await db.select({ productId: t.productId, from: t.effectiveFrom, to: t.effectiveTo, status: t.status }).from(t).where(eq(t.id, id)).limit(1);
    if (!row || (row.status !== "APPROVED" && row.status !== "PENDING")) return { error: "Không tìm thấy dòng đang hiệu lực hoặc đang chờ duyệt" };
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: kind === "ASSIGNMENT" ? "payroll.code.assign.revoke" : "payroll.code.terms.revoke",
      entity,
      entityId: id,
      summary: `Huỷ dòng nhập nhầm: ${reason}`,
      amount: null,
      payload: { id, reason },
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const kq = await db.transaction(async (tx) => {
      await khoaMa(tx, row.productId);
      // Dòng CHỜ DUYỆT chưa từng vào một kỳ nào ⇒ từ chối được bất kể tháng khoá.
      const khoa = row.status === "APPROVED" ? await lockedMonthIn(tx, vnDateKey(row.from), row.to ? vnDateKey(row.to) : null) : null;
      if (khoa) return { error: `Dòng này đã hiệu lực trong tháng ${khoa} (đã khoá lương) — chỉ được kết thúc, không huỷ.` };
      await tx.update(t).set({ status: "REVOKED", updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.status, row.status)));
      return { ok: true as const };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN_REVOKE" : "PAYROLL_CODE_TERMS_REVOKE", entity, entityId: id, before: { status: row.status }, after: { status: "REVOKED" }, reason });
    revalidate();
    return { ok: true, id };
  });
}

/** Khai điều khoản Y% quỹ hỗ trợ + trần thưởng — cho một mã, hoặc mặc định công ty (`productId` rỗng). */
export async function saveCodeTerms(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeTermsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const productId = d.productId ?? null;
    const db = await getDb();
    let code = "mặc định công ty";
    if (productId) {
      const [sp0] = await db.select({ customId: schema.products.customId, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
      if (!sp0) return { error: "Không tìm thấy mã sản phẩm" };
      code = `mã ${sp0.customId || sp0.name}`;
    }
    const from = vnStartOfDay(d.effectiveFrom);
    const to = d.effectiveTo ? vnEndOfDay(d.effectiveTo) : null;
    const values = {
      productId,
      supportPoolBp: bp(d.supportPoolPercent),
      maxBonusAmount: d.maxBonusAmount ?? null,
      effectiveFrom: from,
      effectiveTo: to,
      policyRef: d.policyRef,
      note: d.note,
    };
    const id = codeRowId("TERMS", values);
    const t = schema.productBonusTerms;
    const kq = await db.transaction(async (tx) => {
      await khoaMa(tx, productId);
      const khoa = await lockedMonthIn(tx, d.effectiveFrom, null);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — điều khoản mới chỉ được bắt đầu sau tháng đã khoá cuối cùng.` };
      const [daCo] = await tx.select({ status: t.status }).from(t).where(eq(t.id, id)).limit(1);
      if (daCo) return { error: daCo.status === "REVOKED" ? "Một điều khoản GIỐNG HỆT đã bị huỷ trước đó. Ghi lại thì đổi ghi chú để thành một dòng mới có dấu vết." : daCo.status === "PENDING" ? "Đúng điều khoản này đang chờ duyệt." : "Đúng điều khoản này đã được ghi rồi." };
      const cho = await tx.select({ id: t.id }).from(t).where(termsOverlap(productId, from, to, ["PENDING"])).limit(1);
      if (cho.length) return { error: `Đã có một điều khoản ${code} CHỜ DUYỆT chồng khoảng này — duyệt hoặc huỷ dòng ấy trước.` };
      await tx.insert(t).values({ id, ...values, status: "PENDING", createdBy: guard.id, approvedBy: null, approvedAt: null });
      return { ok: true as const };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_CODE_TERMS_PROPOSE", entity: "PRODUCT_BONUS_TERMS", entityId: id, after: { ...values, status: "PENDING" }, reason: "Khai điều khoản — CHỜ DUYỆT, chưa áp vào lương." });
    revalidate();
    return { ok: true, id };
  });
}

/** Đọc ô xác nhận trọng số trong giao dịch, dưới khoá tên. Ô hỏng ⇒ KHÔNG ghi đè. */
async function docXacNhan(tx: Tx): Promise<CodeWeightConfirmation[] | { error: string }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-code-weights'))`);
  const [row] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_CODE_WEIGHT_CONFIRM_KEY)).limit(1);
  try {
    const cur = row ? (JSON.parse(row.value) as unknown) : [];
    return Array.isArray(cur) ? (cur as CodeWeightConfirmation[]) : { error: "Ô lưu xác nhận trọng số không đúng dạng — không ghi đè lên nó." };
  } catch {
    return { error: "Ô lưu xác nhận trọng số không đọc được — không ghi đè lên nó." };
  }
}
const ghiXacNhan = (tx: Tx, list: CodeWeightConfirmation[]) => {
  const text = JSON.stringify(list);
  return tx.insert(schema.settings).values({ key: PAYROLL_CODE_WEIGHT_CONFIRM_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
};

/**
 * XÁC NHẬN TRỌNG SỐ của một mã × một tháng (`lib/constants/payroll-code.ts`): gỡ ĐÚNG những khoản chờ
 * loại "thiếu một phần trọng số" đang có lúc bấm — lời xác nhận mang dấu vân tay số đo của từng đoạn
 * ấy, nên số đo đổi sau đó thì khoản quay lại chờ. Không có khoản chờ nào ⇒ không có gì để xác nhận
 * (không xác nhận trước được). Không cho tháng đã khoá.
 */
export async function confirmCodeWeights(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeWeightConfirmSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const db = await getDb();
    const [sp0] = await db.select({ customId: schema.products.customId, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, d.productId)).limit(1);
    if (!sp0) return { error: "Không tìm thấy mã sản phẩm" };
    const code = sp0.customId || sp0.name;
    const r = await getPayrollReport(monthReportPeriod(d.monthKey), "profit1");
    const fingerprints = [...new Set(r.profitGate.codeLedger.pending.filter((p) => p.kind === "WEIGHT_PARTIAL" && p.productId === d.productId && p.fingerprint).map((p) => p.fingerprint as string))].sort();
    if (!fingerprints.length) return { error: `Mã ${code} không có khoản chờ "thiếu một phần trọng số" nào trong tháng ${d.monthKey} — không có gì để xác nhận.` };
    /*
      Xác nhận ĐÚNG thứ người bấm đã thấy: số đo trên trang (lúc mở) phải bằng số đo đo lại bây giờ. Tab mở
      lâu trong lúc người khác thêm SUPPORT / có thêm tiền chưa gán ⇒ từ chối, không ký thay họ.
    */
    const daThay = [...new Set(d.fingerprints)].sort();
    if (daThay.length !== fingerprints.length || daThay.some((f, i) => f !== fingerprints[i])) {
      return { error: `Số đo của mã ${code} đã đổi kể từ lúc mở trang — tải lại trang, xem lại rồi mới xác nhận.` };
    }
    const tenNv = new Map((await listEmployees()).map((e) => [e.id, e.shortName || e.name] as const));
    const chiTiet = fingerprints.map((f) => describeFingerprint(f, (x) => tenNv.get(x) ?? x)).join(" | ");
    const id = codeRowId("TERMS", { confirm: "WEIGHTS", monthKey: d.monthKey, productId: d.productId, fingerprints });
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.code.weights.confirm",
      entity: "PRODUCT_CODE_WEIGHTS",
      entityId: id,
      summary: `Xác nhận trọng số SUPPORT của mã ${code} tháng ${d.monthKey}: ${chiTiet}. Lý do: ${d.reason}`,
      amount: null,
      payload: { ...d, fingerprints, chiTiet },
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const duyet = await nguoiDuyet(cong, guard);
    const kq = await db.transaction(async (tx) => {
      const cur = await docXacNhan(tx);
      if ("error" in cur) return cur;
      const khoa = await lockedMonthIn(tx, `${d.monthKey}-01`, `${d.monthKey}-01`);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — không xác nhận lại được.` };
      const dang = new Set(cur.filter((c) => c.monthKey === d.monthKey && c.productId === d.productId && !c.revokedAt).flatMap((c) => c.fingerprints ?? []));
      if (fingerprints.every((f) => dang.has(f))) return { ok: true as const, moi: false, recordId: id };
      // Khoá bản ghi gồm MỐC GHI: xác nhận lại sau khi huỷ là một bản ghi MỚI — bản đã huỷ vẫn tra được.
      const moi: CodeWeightConfirmation = {
        id: `${id}-${Date.now()}`,
        contentId: id,
        monthKey: d.monthKey,
        productId: d.productId,
        fingerprints,
        reason: d.reason,
        requestedById: guard.id,
        requestedByEmail: guard.email ?? "",
        approvedById: duyet.id,
        approvedByEmail: duyet.email,
        confirmedAt: new Date().toISOString(),
        revokedAt: null,
      };
      await ghiXacNhan(tx, [...cur, moi]);
      return { ok: true as const, moi: true, recordId: moi.id };
    });
    if ("error" in kq) return kq;
    // Nhật ký mang khoá BẢN GHI — cùng khoá với lượt huỷ về sau, để nối được xác nhận ↔ huỷ.
    if (kq.moi) await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_CODE_WEIGHTS_CONFIRM", entity: "PRODUCT_CODE_WEIGHTS", entityId: kq.recordId, after: { ...d, contentId: id, fingerprints, chiTiet, approvedById: duyet.id }, reason: d.reason });
    revalidate();
    return { ok: true, id: kq.moi ? kq.recordId : id };
  });
}

/** HUỶ một lời xác nhận trọng số (đánh dấu, không xoá — vẫn tra được). Không cho tháng đã khoá. */
export async function revokeCodeWeights(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeWeightRevokeSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const d = parsed.data;
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.code.weights.revoke",
      entity: "PRODUCT_CODE_WEIGHTS",
      entityId: d.id,
      summary: `Huỷ lời xác nhận trọng số: ${d.reason}`,
      amount: null,
      payload: d,
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const duyet = await nguoiDuyet(cong, guard);
    const db = await getDb();
    const kq = await db.transaction(async (tx) => {
      const cur = await docXacNhan(tx);
      if ("error" in cur) return cur;
      const x = cur.find((c) => c.id === d.id && !c.revokedAt);
      if (!x) return { error: "Không tìm thấy lời xác nhận đang hiệu lực" };
      const khoa = await lockedMonthIn(tx, `${x.monthKey}-01`, `${x.monthKey}-01`);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — lời xác nhận của tháng ấy đã nằm trong ảnh chụp.` };
      await ghiXacNhan(
        tx,
        cur.map((c) => (c.id === d.id ? { ...c, revokedAt: new Date().toISOString(), revokedReason: d.reason, revokedById: guard.id, revokedByEmail: guard.email ?? "", revokeApprovedById: duyet.id, revokeApprovedByEmail: duyet.email } : c)),
      );
      return { ok: true as const };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_CODE_WEIGHTS_REVOKE", entity: "PRODUCT_CODE_WEIGHTS", entityId: d.id, before: { revokedAt: null }, after: { revokedAt: "now" }, reason: d.reason });
    revalidate();
    return { ok: true, id: d.id };
  });
}

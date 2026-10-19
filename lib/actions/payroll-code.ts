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
import { codeAssignmentSchema, codeEndSchema, codeRevokeSchema, codeRowId, codeTermsSchema, codeWeightConfirmSchema, codeWeightRevokeSchema, endChangesFromKey, planOwnerHandover } from "@/lib/validation/payroll-code";
import { PAYROLL_CODE_WEIGHT_CONFIRM_KEY, type CodeWeightConfirmation } from "@/lib/constants/payroll-code";
import { describeFingerprint } from "@/lib/payroll/code-ledger";

export type CodeActionResult = { ok: true; id?: string } | { error: string };

const SURFACES = ["/payroll", "/payroll/codes", "/payroll/codes/assignments"] as const;
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
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.code.assign",
      entity: "PRODUCT_MARKETER_ASSIGNMENT",
      entityId: id,
      summary: `Giao ${nv.shortName || nv.name} làm ${d.role} mã ${code} từ ${d.effectiveFrom}${d.effectiveTo ? ` tới ${d.effectiveTo}` : ""}${d.role === "OWNER" ? ` (X = ${d.ownerRatePercent}%)` : ""}`,
      amount: null,
      payload: values,
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const approvedBy = (await nguoiDuyet(cong, guard)).id;

    const a = schema.productMarketerAssignments;
    const chong = (role: string, employeeId?: string): SQL => {
      const conds: SQL[] = [eq(a.productId, d.productId), eq(a.status, "APPROVED"), eq(a.role, role), or(isNull(a.effectiveTo), sql`${a.effectiveTo} >= ${from}`) as SQL];
      if (to) conds.push(lte(a.effectiveFrom, to));
      if (employeeId) conds.push(eq(a.employeeId, employeeId));
      return and(...conds) as SQL;
    };
    const kq = await db.transaction(async (tx) => {
      await khoaMa(tx, d.productId);
      const khoa = await lockedMonthIn(tx, d.effectiveFrom, null);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — phân công mới chỉ được bắt đầu sau tháng đã khoá cuối cùng. Kỳ đã khoá không tính lại.` };
      const [daCo] = await tx.select({ status: a.status }).from(a).where(eq(a.id, id)).limit(1);
      if (daCo) return { error: daCo.status === "REVOKED" ? "Một dòng GIỐNG HỆT đã bị huỷ trước đó. Ghi lại thì đổi ghi chú (vd «ghi lại sau khi huỷ nhầm») để thành một dòng mới có dấu vết." : "Đúng phân công này đã được ghi rồi." };
      const trung = await tx.select({ id: a.id }).from(a).where(chong(d.role, d.employeeId)).limit(1);
      if (trung.length) return { error: `${nv.shortName || nv.name} đã là ${d.role} của mã ${code} trong khoảng này — kết thúc dòng cũ trước khi đổi tỷ lệ.` };
      let dong: { id: string; before: Date | null; after: Date }[] = [];
      if (d.role === "OWNER") {
        const cu = await tx.select({ id: a.id, from: a.effectiveFrom, to: a.effectiveTo }).from(a).where(chong("OWNER"));
        // Đóng OWNER cũ ở `from − 1 ms` chỉ đổi hiệu lực TỪ `from` — đã kiểm ở trên, không kiểm lại ngày liền trước.
        const plan = planOwnerHandover(cu, from, to);
        if ("error" in plan) return { error: `Mã ${code}: ${plan.error}` };
        for (const c of plan.close) await tx.update(a).set({ effectiveTo: c.after, updatedAt: new Date() }).where(eq(a.id, c.id));
        dong = plan.close;
      }
      await tx.insert(a).values({ id, ...values, status: "APPROVED", createdBy: guard.id, approvedBy, approvedAt: new Date() });
      return { ok: true as const, dong };
    });
    if ("error" in kq) return kq;
    await audit({
      userId: guard.id,
      userEmail: guard.email,
      action: "PAYROLL_CODE_ASSIGN",
      entity: "PRODUCT_MARKETER_ASSIGNMENT",
      entityId: id,
      before: kq.dong.length ? { closedOwners: kq.dong.map((c) => ({ id: c.id, effectiveTo: c.before })) } : undefined,
      after: { ...values, approvedBy, closedOwners: kq.dong.map((c) => ({ id: c.id, effectiveTo: c.after })) },
      reason: kq.dong.length ? `Bàn giao OWNER: đóng ${kq.dong.length} dòng OWNER cũ ở ngày liền trước. Sổ lợi nhuận của mã KHÔNG reset.` : undefined,
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
    if (!row || row.status !== "APPROVED") return { error: "Không tìm thấy dòng đang hiệu lực" };
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
      const khoa = await lockedMonthIn(tx, vnDateKey(row.from), row.to ? vnDateKey(row.to) : null);
      if (khoa) return { error: `Dòng này đã hiệu lực trong tháng ${khoa} (đã khoá lương) — chỉ được kết thúc, không huỷ.` };
      await tx.update(t).set({ status: "REVOKED", updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.status, "APPROVED")));
      return { ok: true as const };
    });
    if ("error" in kq) return kq;
    await audit({ userId: guard.id, userEmail: guard.email, action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN_REVOKE" : "PAYROLL_CODE_TERMS_REVOKE", entity, entityId: id, before: { status: "APPROVED" }, after: { status: "REVOKED" }, reason });
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
    const cong = await guardSecondApproval({
      group: "PAYROLL_EDIT",
      action: "payroll.code.terms",
      entity: "PRODUCT_BONUS_TERMS",
      entityId: id,
      summary: `Điều khoản thưởng ${code}: Y = ${d.supportPoolPercent}%, trần ${values.maxBonusAmount === null ? "không có" : `${values.maxBonusAmount.toLocaleString("vi-VN")} ₫`} — từ ${d.effectiveFrom}`,
      amount: values.maxBonusAmount,
      payload: values,
    });
    const chan = tuChoi(cong);
    if (chan) return chan;
    const approvedBy = (await nguoiDuyet(cong, guard)).id;
    const t = schema.productBonusTerms;
    const kq = await db.transaction(async (tx) => {
      await khoaMa(tx, productId);
      const khoa = await lockedMonthIn(tx, d.effectiveFrom, null);
      if (khoa) return { error: `Tháng ${khoa} đã khoá lương — điều khoản mới chỉ được bắt đầu sau tháng đã khoá cuối cùng.` };
      const [daCo] = await tx.select({ status: t.status }).from(t).where(eq(t.id, id)).limit(1);
      if (daCo) return { error: daCo.status === "REVOKED" ? "Một điều khoản GIỐNG HỆT đã bị huỷ trước đó. Ghi lại thì đổi ghi chú để thành một dòng mới có dấu vết." : "Đúng điều khoản này đã được ghi rồi." };
      const conds: SQL[] = [productId ? eq(t.productId, productId) : isNull(t.productId), eq(t.status, "APPROVED"), or(isNull(t.effectiveTo), sql`${t.effectiveTo} >= ${from}`) as SQL];
      if (to) conds.push(lte(t.effectiveFrom, to));
      const cu = await tx.select({ id: t.id, from: t.effectiveFrom, to: t.effectiveTo }).from(t).where(and(...conds));
      // Cùng luật bàn giao như OWNER: điều khoản có hạn không được cắt điều khoản không hạn đang chạy.
      const plan = planOwnerHandover(cu, from, to, `điều khoản (${code})`);
      if ("error" in plan) return { error: plan.error };
      for (const c of plan.close) await tx.update(t).set({ effectiveTo: c.after, updatedAt: new Date() }).where(eq(t.id, c.id));
      await tx.insert(t).values({ id, ...values, status: "APPROVED", createdBy: guard.id, approvedBy, approvedAt: new Date() });
      return { ok: true as const, dong: plan.close };
    });
    if ("error" in kq) return kq;
    await audit({
      userId: guard.id,
      userEmail: guard.email,
      action: "PAYROLL_CODE_TERMS",
      entity: "PRODUCT_BONUS_TERMS",
      entityId: id,
      before: kq.dong.length ? { closedTerms: kq.dong.map((c) => ({ id: c.id, effectiveTo: c.before })) } : undefined,
      after: { ...values, approvedBy },
      reason: kq.dong.length ? `Đóng ${kq.dong.length} điều khoản cũ ở ngày liền trước.` : undefined,
    });
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
      if (fingerprints.every((f) => dang.has(f))) return { ok: true as const, moi: false };
      // Khoá bản ghi gồm MỐC GHI: xác nhận lại sau khi huỷ là một bản ghi MỚI — bản đã huỷ vẫn tra được.
      const moi: CodeWeightConfirmation = {
        id: `${id}-${Date.now()}`,
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
      return { ok: true as const, moi: true };
    });
    if ("error" in kq) return kq;
    if (kq.moi) await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_CODE_WEIGHTS_CONFIRM", entity: "PRODUCT_CODE_WEIGHTS", entityId: id, after: { ...d, fingerprints, approvedById: duyet.id }, reason: d.reason });
    revalidate();
    return { ok: true, id };
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

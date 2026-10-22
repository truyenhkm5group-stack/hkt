/**
 * ═══ SỔ PHÂN CÔNG MKTer ↔ MÃ — LÕI GHI DÙNG CHUNG CỦA MÀN HÌNH VÀ JOB ═══
 *
 * `lib/actions/payroll-code.ts` (người bấm) và `scripts/payroll-owner-apply.ts` (Tech Lead thực hiện theo ủy
 * quyền của chủ shop) đi qua ĐÚNG các hàm ở đây — hai đường ghi là hai luật (tháng khoá, chồng khoảng, bàn giao
 * OWNER, người khai không tự duyệt) sẽ lệch nhau. Tệp này KHÔNG phải server action: mọi hàm xuất ở tệp server
 * action là một điểm trình duyệt gọi được, còn lõi nhận NGƯỜI THAO TÁC và CỔNG DUYỆT từ chỗ gọi đã kiểm quyền.
 * Đặc tả: `docs/payroll-code-ledger.md`. Trình tự, luật và câu chữ y như bản trước khi tách (22/10/2026).
 */
import { and, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { listEmployees } from "@/lib/queries/payroll";
import { monthsBetween } from "@/lib/queries/payroll-profit-gate";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";
import { isFrozen, normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
import { codeRowId, planOwnerHandover, type codeApproveSchema, type codeAssignmentSchema, type codeRevokeSchema } from "@/lib/validation/payroll-code";
import type { GuardInput, GuardResult } from "@/lib/approvals/service";
import type { z } from "zod";

export type CodeActionResult = { ok: true; id?: string } | { error: string };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Người thao tác: tài khoản ERP (id · email · vai trò) — chỗ gọi đã kiểm quyền. */
export type CodeBookActor = { id: string; email: string; role: string };
/** Cổng duyệt người thứ hai. Màn hình truyền `guardSecondApproval` (phiên đăng nhập); job truyền cổng lõi với chính người thao tác. */
export type CodeBookGuard = (input: GuardInput) => Promise<GuardResult>;
export type CodeBookOptions = { guard: CodeBookGuard; /** Thêm vào lý do của dòng nhật ký (vd «Chủ shop ủy quyền …»). */ auditNote?: string };

const ghiChu = (goc: string | undefined, them: string | undefined) => [goc, them].filter((x) => x && x.trim()).join(" · ") || undefined;

export const bp = (pct: number) => Math.round(pct * 100);

export const tuChoi = (cong: { mode: string; reason?: string }): CodeActionResult | null =>
  cong.mode === "NEEDS_APPROVAL"
    ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo. Duyệt xong, gửi lại ĐÚNG nội dung này.` }
    : cong.mode === "BLOCKED_NO_APPROVER"
      ? { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` }
      : null;

/**
 * Người QUYẾT yêu cầu duyệt vừa được tiêu thụ; không có lượt duyệt (nhóm chưa cưỡng chế) ⇒ chính người
 * làm. Gọi TRƯỚC `db.transaction` — trên PGlite (một kết nối) một câu `getDb()` trong giao dịch tự khoá.
 */
export async function nguoiDuyet(cong: { consumed?: boolean; requestId?: string }, actor: { id: string; email?: string | null }): Promise<{ id: string | null; email: string }> {
  if (!cong.consumed || !cong.requestId) return { id: actor.id, email: actor.email ?? "" };
  const db = await getDb();
  const [r] = await db
    .select({ by: schema.approvalRequests.decidedBy, email: schema.approvalRequests.decidedByEmail })
    .from(schema.approvalRequests)
    .where(eq(schema.approvalRequests.id, cong.requestId))
    .limit(1);
  return { id: r?.by ?? null, email: r?.email ?? "" };
}

/** Tháng đã khoá đầu tiên mà khoảng [fromKey, toKey] chạm tới (`toKey` rỗng = tới hôm nay). Đọc qua `tx`. */
export async function lockedMonthIn(tx: Tx, fromKey: string, toKey: string | null): Promise<string | null> {
  const months = monthsBetween(fromKey.slice(0, 7), (toKey ?? vnDateKey(new Date())).slice(0, 7));
  if (!months.length) return null;
  const keys = new Map(months.map((m) => [monthPeriod(m).periodKey, m] as const));
  const p = schema.payrollPeriods;
  const rows = await tx.select({ key: p.periodKey, status: p.status }).from(p).where(inArray(p.periodKey, [...keys.keys()]));
  const khoa = rows.filter((r) => isFrozen(normalizePayrollStatus(r.status))).map((r) => keys.get(r.key) ?? r.key);
  return khoa.sort()[0] ?? null;
}

export const khoaMa = (tx: Tx, productId: string | null) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp:payroll-code:${productId ?? "*"}`}))`);

/** Phân công cùng mã · cùng vai trò · chồng khoảng `[from, to]`, ở các trạng thái cho trước. */
export function assignmentOverlap(productId: string, role: string, from: Date, to: Date | null, statuses: readonly string[], employeeId?: string): SQL {
  const a = schema.productMarketerAssignments;
  const conds: SQL[] = [eq(a.productId, productId), inArray(a.status, [...statuses]), eq(a.role, role), or(isNull(a.effectiveTo), sql`${a.effectiveTo} >= ${from}`) as SQL];
  if (to) conds.push(lte(a.effectiveFrom, to));
  if (employeeId) conds.push(eq(a.employeeId, employeeId));
  return and(...conds) as SQL;
}

/** Điều khoản cùng phạm vi (mã / mặc định công ty) chồng khoảng `[from, to]`. */
export function termsOverlap(productId: string | null, from: Date, to: Date | null, statuses: readonly string[]): SQL {
  const t = schema.productBonusTerms;
  const conds: SQL[] = [productId ? eq(t.productId, productId) : isNull(t.productId), inArray(t.status, [...statuses]), or(isNull(t.effectiveTo), sql`${t.effectiveTo} >= ${from}`) as SQL];
  if (to) conds.push(lte(t.effectiveFrom, to));
  return and(...conds) as SQL;
}

/** Giao một MKTer vào một mã (OWNER hoặc SUPPORT) — dòng CHỜ DUYỆT. `d` đã qua `codeAssignmentSchema`. */
export async function saveCodeAssignmentAs(actor: CodeBookActor, d: z.infer<typeof codeAssignmentSchema>, opts: Omit<CodeBookOptions, "guard">): Promise<CodeActionResult> {
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
    await tx.insert(a).values({ id, ...values, status: "PENDING", createdBy: actor.id, approvedBy: null, approvedAt: null });
    return { ok: true as const };
  });
  if ("error" in kq) return kq;
  await audit({ userId: actor.id, userEmail: actor.email, action: "PAYROLL_CODE_ASSIGN_PROPOSE", entity: "PRODUCT_MARKETER_ASSIGNMENT", entityId: id, after: { ...values, status: "PENDING" }, reason: ghiChu("Khai phân công — CHỜ DUYỆT, chưa áp vào lương.", opts.auditNote) });
  return { ok: true, id };
}

/**
 * DUYỆT một dòng đang chờ (`PENDING` → `APPROVED`). Đường DUY NHẤT làm một phân công / điều khoản có
 * hiệu lực. Người khai không tự duyệt (trừ chủ shop); duyệt người thứ hai theo nhóm `PAYROLL_EDIT`.
 * Bàn giao OWNER / đóng điều khoản cũ làm ở ĐÂY, dưới khoá tên của mã, với tháng khoá đọc lại.
 */
export async function approveCodeRowAs(actor: CodeBookActor, input: z.infer<typeof codeApproveSchema>, opts: CodeBookOptions): Promise<CodeActionResult> {
  const { kind, id } = input;
  const db = await getDb();
  const a = schema.productMarketerAssignments;
  const t = schema.productBonusTerms;
  const entity = kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS";
  const tbl = kind === "ASSIGNMENT" ? a : t;
  const [row] = await db.select({ productId: tbl.productId, from: tbl.effectiveFrom, to: tbl.effectiveTo, status: tbl.status, createdBy: tbl.createdBy }).from(tbl).where(eq(tbl.id, id)).limit(1);
  if (!row || row.status !== "PENDING") return { error: "Không tìm thấy dòng đang chờ duyệt" };
  const [asg] = kind === "ASSIGNMENT" ? await db.select({ role: a.role, employeeId: a.employeeId, ownerRateBp: a.ownerRateBp, weightMethod: a.weightMethod, weightBp: a.weightBp }).from(a).where(eq(a.id, id)).limit(1) : [];
  const [trm] = kind === "TERMS" ? await db.select({ supportPoolBp: t.supportPoolBp, maxBonusAmount: t.maxBonusAmount }).from(t).where(eq(t.id, id)).limit(1) : [];
  const cong = await opts.guard({
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
  const duyet = await nguoiDuyet(cong, actor);
  if (!duyet.id) return { error: "Không đọc được người duyệt của yêu cầu — không duyệt một dòng mà không ghi được ai đã duyệt." };
  if (duyet.id && duyet.id === row.createdBy && !(duyet.id === actor.id && actor.role === "ADMIN")) {
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
    userId: actor.id,
    userEmail: actor.email,
    action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN" : "PAYROLL_CODE_TERMS",
    entity,
    entityId: id,
    before: { status: "PENDING", ...(kq.dong.length ? { closed: kq.dong.map((c) => ({ id: c.id, effectiveTo: c.before })) } : {}) },
    after: { status: "APPROVED", approvedBy: duyet.id, closed: kq.dong.map((c) => ({ id: c.id, effectiveTo: c.after })) },
    reason: ghiChu(kq.dong.length ? `Duyệt và đóng ${kq.dong.length} dòng cũ ở ngày liền trước. Sổ lợi nhuận của mã KHÔNG reset.` : "Duyệt dòng chờ.", opts.auditNote),
  });
  return { ok: true, id };
}

/**
 * Huỷ một dòng NHẬP NHẦM (`REVOKED`). Chỉ khi hiệu lực của nó chưa chạm tháng đã khoá — dòng đã
 * dùng cho một kỳ đã khoá thì chỉ được KẾT THÚC. Huỷ KHÔNG tự mở lại OWNER đã bị bàn giao: đó là một
 * quyết định mới, đi bằng một dòng mới.
 */
export async function revokeCodeRowAs(actor: CodeBookActor, input: z.infer<typeof codeRevokeSchema>, opts: CodeBookOptions): Promise<CodeActionResult> {
  const { kind, id, reason } = input;
  const db = await getDb();
  const t = kind === "ASSIGNMENT" ? schema.productMarketerAssignments : schema.productBonusTerms;
  const entity = kind === "ASSIGNMENT" ? "PRODUCT_MARKETER_ASSIGNMENT" : "PRODUCT_BONUS_TERMS";
  const [row] = await db.select({ productId: t.productId, from: t.effectiveFrom, to: t.effectiveTo, status: t.status }).from(t).where(eq(t.id, id)).limit(1);
  if (!row || (row.status !== "APPROVED" && row.status !== "PENDING")) return { error: "Không tìm thấy dòng đang hiệu lực hoặc đang chờ duyệt" };
  const cong = await opts.guard({
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
  await audit({ userId: actor.id, userEmail: actor.email, action: kind === "ASSIGNMENT" ? "PAYROLL_CODE_ASSIGN_REVOKE" : "PAYROLL_CODE_TERMS_REVOKE", entity, entityId: id, before: { status: row.status }, after: { status: "REVOKED" }, reason: ghiChu(reason, opts.auditNote) });
  return { ok: true, id };
}

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
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { getPayrollReport, listEmployees, monthReportPeriod } from "@/lib/queries/payroll";
import { codeApproveSchema, codeAssignmentSchema, codeEndSchema, codeRevokeSchema, codeRowId, codeTermsSchema, codeWeightConfirmSchema, codeWeightRevokeSchema, endChangesFromKey } from "@/lib/validation/payroll-code";
import { PAYROLL_CODE_WEIGHT_CONFIRM_KEY, type CodeWeightConfirmation } from "@/lib/constants/payroll-code";
import { describeFingerprint } from "@/lib/payroll/code-ledger";
import {
  approveCodeRowAs,
  bp,
  khoaMa,
  lockedMonthIn,
  nguoiDuyet,
  revokeCodeRowAs,
  saveCodeAssignmentAs,
  termsOverlap,
  tuChoi,
  type CodeActionResult,
  type Tx,
} from "@/lib/payroll/code-book-service";

export type { CodeActionResult } from "@/lib/payroll/code-book-service";

const SURFACES = ["/payroll", "/payroll/codes", "/payroll/codes/assignments", "/payroll/reconciliation/center"] as const;
function revalidate() {
  for (const p of SURFACES) revalidatePath(p);
}

type SessionUser = Awaited<ReturnType<typeof requireUser>>;

async function requireManage(): Promise<SessionUser | { error: string }> {
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Việc này cần quyền khai báo lương VÀ phạm vi xem lương toàn công ty." };
  return user;
}





/** Giao một MKTer vào một mã (OWNER hoặc SUPPORT). Lõi: `lib/payroll/code-book-service.ts`. */
export async function saveCodeAssignment(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeAssignmentSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const kq = await saveCodeAssignmentAs({ id: guard.id, email: guard.email, role: guard.role }, parsed.data, {});
    if ("error" in kq) return kq;
    revalidate();
    return kq;
  });
}



/** DUYỆT một dòng đang chờ (`PENDING` → `APPROVED`). Lõi: `lib/payroll/code-book-service.ts::approveCodeRowAs`. */
export async function approveCodeRow(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeApproveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const kq = await approveCodeRowAs({ id: guard.id, email: guard.email, role: guard.role }, parsed.data, { guard: guardSecondApproval });
    if ("error" in kq) return kq;
    revalidate();
    return kq;
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

/** Huỷ một dòng NHẬP NHẦM (`REVOKED`). Lõi: `lib/payroll/code-book-service.ts::revokeCodeRowAs`. */
export async function revokeCodeRow(input: unknown): Promise<CodeActionResult> {
  return withApprovalExecution(async () => {
    const guard = await requireManage();
    if ("error" in guard) return guard;
    const parsed = codeRevokeSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const kq = await revokeCodeRowAs({ id: guard.id, email: guard.email, role: guard.role }, parsed.data, { guard: guardSecondApproval });
    if ("error" in kq) return kq;
    revalidate();
    return kq;
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

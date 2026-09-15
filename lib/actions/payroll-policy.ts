"use server";

/**
 * ═══════ KHAI BÁO CHÍNH SÁCH LƯƠNG — ĐƯỜNG GHI DUY NHẤT ═══════
 *
 * Mọi hàm ở đây theo cùng một trình tự: `requireUser` → `can('payroll:manage')` → zod → drizzle →
 * `audit()` → `revalidatePath` (docs/CONVENTIONS.md). Lỗi nghiệp vụ trả `{ error }`, không throw.
 *
 * ─── VÌ SAO PHIÊN BẢN ĐÃ DÙNG KHÔNG SỬA ĐƯỢC ───
 *
 * Sửa tỷ lệ của một phiên bản ĐANG HIỆU LỰC là viết lại cách trả tiền của những tháng đã đi qua nó
 * — kể cả tháng đã trả. Nên đường duy nhất để đổi là TẠO PHIÊN BẢN MỚI và đóng bản cũ lại tại một
 * mốc. Bản `DRAFT` thì sửa thoải mái: nó chưa bao giờ tính ra một đồng nào.
 */
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { componentBasisKey, type PayrollCalcParams } from "@/lib/constants/payroll-components";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { getPolicyVersion, nextVersionNumber, overlappingActiveVersions, userNamesByIds } from "@/lib/queries/payroll-policies";
import {
  adjustmentSchema,
  employmentSchema,
  payrollInputSchema,
  policyAssignmentSchema,
  policySchema,
  versionSchema,
} from "@/lib/validation/payroll-policy";

export type PolicyActionResult = { ok: true; id?: string } | { error: string };

/** Các màn hình đọc chính sách lương — không action nào được tự liệt kê chỗ khác. */
const PAYROLL_SURFACES = ["/payroll", "/payroll/policies", "/payroll/assignments", "/payroll/adjustments", "/reports"] as const;
function revalidate() {
  for (const p of PAYROLL_SURFACES) revalidatePath(p);
}

type SessionUser = Awaited<ReturnType<typeof requireUser>>;

/** Trả về NGƯỜI, hoặc một lời từ chối đọc được. Không có trạng thái thứ ba. */
async function requireManage(): Promise<SessionUser | { error: string }> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: "Chỉ người có quyền khai báo lương mới làm được việc này" };
  return user;
}

const dayOrNull = (v: string | undefined) => (v ? vnEndOfDay(v) : null);

// ═════════════════════════ CHÍNH SÁCH ═════════════════════════

export async function saveSalaryPolicy(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const p = schema.salaryPolicies;
  const values = {
    code: d.code,
    name: d.name,
    description: d.description,
    departmentId: d.departmentId || null,
    active: d.active,
    sortOrder: d.sortOrder,
  };
  try {
    if (d.id) {
      const [before] = await db.select().from(p).where(eq(p.id, d.id)).limit(1);
      if (!before) return { error: "Không tìm thấy chính sách" };
      await db.update(p).set(values).where(eq(p.id, d.id));
      await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_POLICY_UPDATE", entity: "SALARY_POLICY", entityId: d.id, before, after: values });
      revalidate();
      return { ok: true, id: d.id };
    }
    const id = crypto.randomUUID();
    await db.insert(p).values({ id, ...values, createdBy: guard.id });
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_POLICY_CREATE", entity: "SALARY_POLICY", entityId: id, after: values });
    revalidate();
    return { ok: true, id };
  } catch (e) {
    // Mã chính sách là khoá duy nhất — nói thẳng ra thay vì trả một lỗi CSDL thô.
    if (/unique|duplicate/i.test(String(e))) return { error: `Mã “${d.code}” đã có chính sách khác dùng. Mã là khoá, nên nó phải là duy nhất.` };
    throw e;
  }
}

// ═════════════════════════ PHIÊN BẢN + THÀNH PHẦN ═════════════════════════

/**
 * LƯU MỘT PHIÊN BẢN NHÁP CÙNG TOÀN BỘ THÀNH PHẦN CỦA NÓ.
 *
 * Thành phần ghi theo kiểu THAY THẾ TRỌN BỘ trong một giao dịch: xoá hết rồi ghi lại. Ghi từng
 * dòng một thì một lượt lưu nửa chừng để lại một phiên bản mang nửa bộ thành phần cũ và nửa bộ mới
 * — và không ai nhìn ra được điều đó cho tới lúc chốt lương.
 */
export async function saveSalaryPolicyVersion(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = versionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const from = vnStartOfDay(d.effectiveFrom);
  const to = dayOrNull(d.effectiveTo || undefined);
  if (to && to < from) return { error: "Mốc kết thúc phải từ mốc bắt đầu trở đi" };

  // Hai thành phần cùng khoá sẽ bị máy tính GỘP thành một dòng — chặn ngay ở đây, đọc được hơn lỗi CSDL.
  const codes = d.components.map((c) => c.code);
  const trung = codes.find((c, i) => codes.indexOf(c) !== i);
  if (trung) return { error: `Khoá thành phần “${trung}” bị lặp trong cùng một phiên bản` };

  const db = await getDb();
  const v = schema.salaryPolicyVersions;
  const c = schema.salaryPolicyComponents;

  if (d.id) {
    const [existing] = await db.select().from(v).where(eq(v.id, d.id)).limit(1);
    if (!existing) return { error: "Không tìm thấy phiên bản" };
    if (existing.status !== "DRAFT") {
      return {
        error:
          "Phiên bản đã phát hành là BẤT BIẾN — sửa nó là viết lại cách trả tiền của những tháng đã đi qua nó, kể cả tháng đã trả. Hãy nhân bản thành một phiên bản mới và đặt mốc hiệu lực.",
      };
    }
  }

  const versionId = d.id ?? crypto.randomUUID();
  const versionNo = d.id ? undefined : await nextVersionNumber(d.policyId);
  await db.transaction(async (tx) => {
    if (d.id) {
      await tx.update(v).set({ effectiveFrom: from, effectiveTo: to, note: d.note }).where(eq(v.id, versionId));
    } else {
      await tx.insert(v).values({ id: versionId, policyId: d.policyId, version: versionNo!, effectiveFrom: from, effectiveTo: to, status: "DRAFT", note: d.note, createdBy: guard.id });
    }
    await tx.delete(c).where(eq(c.versionId, versionId));
    if (d.components.length) {
      await tx.insert(c).values(
        d.components.map((comp) => ({
          versionId,
          code: comp.code,
          label: comp.label,
          kind: comp.kind,
          calcType: comp.calc.type,
          // Đại lượng suy ra TỪ tham số, không nhận riêng — hai ô nói hai điều khác nhau là chuyện
          // sớm muộn, và lúc ấy máy tính đọc ô nào cũng sai một nửa.
          basisKey: componentBasisKey(comp.calc as PayrollCalcParams),
          calc: comp.calc,
          prorate: comp.prorate,
          rounding: comp.rounding,
          minAmount: comp.minAmount,
          maxAmount: comp.maxAmount,
          carryForward: comp.carryForward,
          sortOrder: comp.sortOrder,
          note: comp.note,
        })),
      );
    }
  });
  await audit({
    userId: guard.id,
    userEmail: guard.email,
    action: d.id ? "PAYROLL_POLICY_VERSION_UPDATE" : "PAYROLL_POLICY_VERSION_CREATE",
    entity: "SALARY_POLICY_VERSION",
    entityId: versionId,
    after: { policyId: d.policyId, effectiveFrom: d.effectiveFrom, effectiveTo: d.effectiveTo, components: d.components },
  });
  revalidate();
  return { ok: true, id: versionId };
}

/**
 * PHÁT HÀNH MỘT PHIÊN BẢN — từ `DRAFT` sang `ACTIVE`.
 *
 * Đây là lúc một lời khai trở thành cách trả tiền cho người thật, nên nó đi qua cửa "người thứ hai
 * duyệt" như mọi thay đổi cơ chế lương khác (`guardSecondApproval`): người sửa có thể chính là
 * người được hưởng.
 *
 * Phiên bản trước đó tự ĐÓNG LẠI tại ngày liền trước mốc hiệu lực mới. Không đóng thì hai bản cùng
 * phủ một ngày, và `resolveSegments` lấy bản có `effective_from` muộn hơn — đúng, nhưng im lặng.
 * Đóng tường minh để người đọc sổ thấy được đường phân chia.
 */
export async function activateSalaryPolicyVersion(versionId: string): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const loaded = await getPolicyVersion(versionId);
  if (!loaded) return { error: "Không tìm thấy phiên bản" };
  const { version, components } = loaded;
  if (version.status === "ACTIVE") return { error: "Phiên bản này đã phát hành rồi" };
  if (version.status === "RETIRED") return { error: "Phiên bản đã rút thì không phát hành lại — hãy nhân bản thành bản mới" };
  if (!components.length) {
    return { error: "Phiên bản chưa có thành phần nào. Phát hành nó là gán cho người một chính sách trả 0 đồng mà không ai thấy." };
  }

  const chongLan = await overlappingActiveVersions(version.policyId, version.effectiveFrom, version.effectiveTo);
  const cong = await guardSecondApproval({
    group: "PAYROLL_EDIT",
    action: "payroll.policy.activate",
    entity: "SALARY_POLICY_VERSION",
    entityId: versionId,
    summary: `Phát hành phiên bản ${version.version} của chính sách lương, hiệu lực từ ${version.effectiveFrom.toLocaleDateString("vi-VN")} · ${components.length} thành phần`,
    amount: null,
    payload: { versionId, components },
  });
  if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
  if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };

  const db = await getDb();
  const v = schema.salaryPolicyVersions;
  const luc = new Date();
  // Ngày liền trước mốc hiệu lực mới, tính bằng mili giây để không lệch múi giờ.
  const dongTai = new Date(version.effectiveFrom.getTime() - 1);
  await db.transaction(async (tx) => {
    for (const cu of chongLan) {
      if (cu.id === versionId) continue;
      if (cu.effectiveFrom >= version.effectiveFrom) {
        // Bản cũ bắt đầu SAU bản mới: rút hẳn, vì bản mới đã phủ từ mốc sớm hơn.
        await tx.update(v).set({ status: "RETIRED" }).where(eq(v.id, cu.id));
        continue;
      }
      await tx.update(v).set({ effectiveTo: dongTai, status: "RETIRED" }).where(eq(v.id, cu.id));
    }
    await tx.update(v).set({ status: "ACTIVE", activatedAt: luc, activatedBy: guard.id }).where(eq(v.id, versionId));
  });
  await audit({
    userId: guard.id,
    userEmail: guard.email,
    action: "PAYROLL_POLICY_VERSION_ACTIVATE",
    entity: "SALARY_POLICY_VERSION",
    entityId: versionId,
    after: { version: version.version, effectiveFrom: version.effectiveFrom, components: components.length },
    reason: `Đóng ${chongLan.filter((x) => x.id !== versionId).length} phiên bản chồng lấn`,
  });
  revalidate();
  return { ok: true, id: versionId };
}

/** Nhân bản một phiên bản thành bản NHÁP mới — đường duy nhất để đổi một chính sách đã phát hành. */
export async function cloneSalaryPolicyVersion(versionId: string, effectiveFrom: string): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return { error: "Mốc hiệu lực phải dạng YYYY-MM-DD" };
  const loaded = await getPolicyVersion(versionId);
  if (!loaded) return { error: "Không tìm thấy phiên bản" };
  return saveSalaryPolicyVersion({
    policyId: loaded.version.policyId,
    effectiveFrom,
    effectiveTo: "",
    note: `Nhân bản từ phiên bản ${loaded.version.version}`,
    components: loaded.components,
  });
}

// ═════════════════════════ PHÂN CÔNG ═════════════════════════

export async function saveEmploymentAssignment(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = employmentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const t = schema.employmentAssignments;
  const values = {
    employeeId: d.employeeId,
    userId: d.userId || null,
    departmentId: d.departmentId || null,
    positionId: d.positionId || null,
    managerUserId: d.managerUserId || null,
    employmentType: d.employmentType,
    workMode: d.workMode,
    status: d.status,
    standardWorkDays: d.standardWorkDays,
    costCenter: d.costCenter,
    effectiveFrom: vnStartOfDay(d.effectiveFrom),
    effectiveTo: dayOrNull(d.effectiveTo || undefined),
    note: d.note,
  };
  const id = d.id ?? crypto.randomUUID();
  if (d.id) {
    const [before] = await db.select().from(t).where(eq(t.id, d.id)).limit(1);
    if (!before) return { error: "Không tìm thấy dòng phân công" };
    await db.update(t).set(values).where(eq(t.id, d.id));
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_EMPLOYMENT_UPDATE", entity: "EMPLOYMENT_ASSIGNMENT", entityId: id, before, after: values });
  } else {
    await db.insert(t).values({ id, ...values, createdBy: guard.id });
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_EMPLOYMENT_CREATE", entity: "EMPLOYMENT_ASSIGNMENT", entityId: id, after: values });
  }
  revalidate();
  return { ok: true, id };
}

/**
 * GÁN CHÍNH SÁCH CHO MỘT NGƯỜI.
 *
 * Dòng gán TRƯỚC ĐÓ còn để mở sẽ tự đóng lại tại ngày liền trước mốc mới — nếu không thì hai chính
 * sách cùng phủ một ngày và tiền của ngày ấy phụ thuộc vào thứ tự dòng, thứ không ai đọc ra được
 * từ màn hình.
 */
export async function saveEmployeePolicyAssignment(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = policyAssignmentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const from = vnStartOfDay(d.effectiveFrom);
  const to = dayOrNull(d.effectiveTo || undefined);
  const db = await getDb();
  const t = schema.employeePolicyAssignments;
  const id = d.id ?? crypto.randomUUID();
  const values = { employeeId: d.employeeId, policyId: d.policyId, effectiveFrom: from, effectiveTo: to, note: d.note };

  const cong = await guardSecondApproval({
    group: "PAYROLL_EDIT",
    action: "payroll.policy.assign",
    entity: "EMPLOYEE_POLICY_ASSIGNMENT",
    entityId: id,
    summary: `Gán chính sách lương cho nhân sự ${d.employeeId}, hiệu lực từ ${d.effectiveFrom}`,
    amount: null,
    payload: values,
  });
  if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
  if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };

  const dongTai = new Date(from.getTime() - 1);
  await db.transaction(async (tx) => {
    if (d.id) await tx.update(t).set(values).where(eq(t.id, d.id));
    else await tx.insert(t).values({ id, ...values, createdBy: guard.id });
    // Đóng các dòng còn mở của CHÍNH người này bắt đầu trước mốc mới.
    await tx
      .update(t)
      .set({ effectiveTo: dongTai })
      .where(
        and(
          eq(t.employeeId, d.employeeId),
          sql`${t.id} <> ${id}`,
          lte(t.effectiveFrom, from),
          or(isNull(t.effectiveTo), sql`${t.effectiveTo} > ${dongTai}`),
        ),
      );
  });
  await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_POLICY_ASSIGN", entity: "EMPLOYEE_POLICY_ASSIGNMENT", entityId: id, after: values });
  revalidate();
  return { ok: true, id };
}

// ═════════════════════════ ĐẦU VÀO NHẬP TAY ═════════════════════════

/**
 * NHẬP MỘT ĐẠI LƯỢNG (ngày công · giờ công · KPI · sản lượng) CHO MỘT NGƯỜI TRONG MỘT KỲ.
 *
 * `onConflictDoUpdate` theo khoá tự nhiên: nhập lại là SỬA. Thêm dòng thứ hai sẽ làm mỗi lượt tính
 * lại cộng dồn, và lương tăng mỗi lần ai đó mở trang.
 *
 * TÊN NGƯỜI NHẬP do MÁY CHỦ đọc từ `users`, không nhận từ client (AGENTS.md mục 34): client gửi
 * tên khác với khoá thì dòng dữ liệu nói một đằng còn quy kết một nẻo.
 */
export async function savePayrollInput(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = payrollInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const chot = await periodIsFinal(d.periodKey);
  if (chot) return { error: chot };
  const db = await getDb();
  const t = schema.payrollInputs;
  const ten = (await userNamesByIds([guard.id])).get(guard.id) ?? "";
  await db
    .insert(t)
    .values({ employeeId: d.employeeId, periodKey: d.periodKey, inputKey: d.inputKey, value: d.value, evidence: d.evidence, enteredBy: guard.id, enteredByName: ten })
    .onConflictDoUpdate({
      target: [t.employeeId, t.periodKey, t.inputKey],
      set: { value: d.value, evidence: d.evidence, enteredBy: guard.id, enteredByName: ten, updatedAt: new Date() },
    });
  await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_INPUT_SAVE", entity: "PAYROLL_INPUT", entityId: `${d.employeeId}:${d.periodKey}:${d.inputKey}`, after: d });
  revalidate();
  return { ok: true };
}

// ═════════════════════════ ĐIỀU CHỈNH ═════════════════════════

/**
 * KỲ ĐÃ CHỐT LÀ BẤT BIẾN.
 *
 * Thêm một khoản điều chỉnh vào một kỳ đã chốt là sửa một con số đã trả tiền, im lặng. Chứng từ về
 * sau đi vào kỳ SAU (yêu cầu mục 24) — và câu trả lời phải nói rõ điều đó, chứ không phải một chữ
 * "không được".
 */
async function periodIsFinal(periodKey: string): Promise<string | null> {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const rows = await db.select({ basis: p.basis }).from(p).where(and(eq(p.periodKey, periodKey), eq(p.status, "FINAL")));
  if (!rows.length) return null;
  return `Kỳ ${periodKey} đã CHỐT (cơ sở ${rows.map((r) => r.basis).join(", ")}). Kỳ đã chốt là bất biến — ghi khoản này vào kỳ SAU, nó vẫn được trả đủ và vẫn có dấu vết.`;
}

export async function savePayrollAdjustment(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = adjustmentSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const chot = await periodIsFinal(d.periodKey);
  if (chot) return { error: chot };
  const db = await getDb();
  const t = schema.payrollAdjustments;
  const ten = (await userNamesByIds([guard.id])).get(guard.id) ?? "";
  const id = d.id ?? crypto.randomUUID();
  const values = {
    employeeId: d.employeeId,
    periodKey: d.periodKey,
    kind: d.kind,
    label: d.label,
    amount: d.amount,
    reason: d.reason,
    reference: d.reference,
  };
  if (d.id) {
    const [before] = await db.select().from(t).where(eq(t.id, d.id)).limit(1);
    if (!before) return { error: "Không tìm thấy khoản điều chỉnh" };
    await db.update(t).set(values).where(eq(t.id, d.id));
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_ADJUSTMENT_UPDATE", entity: "PAYROLL_ADJUSTMENT", entityId: id, before, after: values, reason: d.reason });
  } else {
    await db.insert(t).values({ id, ...values, createdBy: guard.id, createdByName: ten });
    await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_ADJUSTMENT_CREATE", entity: "PAYROLL_ADJUSTMENT", entityId: id, after: values, reason: d.reason });
  }
  revalidate();
  return { ok: true, id };
}

export async function deletePayrollAdjustment(id: string): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const db = await getDb();
  const t = schema.payrollAdjustments;
  const [before] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  if (!before) return { error: "Không tìm thấy khoản điều chỉnh" };
  const chot = await periodIsFinal(before.periodKey);
  if (chot) return { error: chot };
  await db.delete(t).where(eq(t.id, id));
  await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_ADJUSTMENT_DELETE", entity: "PAYROLL_ADJUSTMENT", entityId: id, before });
  revalidate();
  return { ok: true };
}

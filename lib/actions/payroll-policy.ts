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
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { componentBasisKey, payrollInput, type PayrollCalcParams } from "@/lib/constants/payroll-components";
import { policyActivationBlockers } from "@/lib/payroll/policy-validation";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { DEFAULT_PAYROLL_CARRYOVER, PAYROLL_CARRYOVER_KEY, type PayrollCarryoverConfig } from "@/lib/constants/payroll-carryover";
import { DEFAULT_STATUTORY, STATUTORY_DEDUCTION_KEY, STATUTORY_STATES, type StatutoryConfig } from "@/lib/constants/payroll-statutory";
import { DEFAULT_PAYROLL_RECOGNITION, PAYROLL_RECOGNITION_KEY, type PayrollRecognitionConfig } from "@/lib/queries/payroll-cost";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { getPolicyVersion, nextVersionNumber, overlappingActiveVersions, userNamesByIds } from "@/lib/queries/payroll-policies";
import { frozenPeriodRuns } from "@/lib/queries/payroll-engine";
import { PAYROLL_RUN_STATUS_LABEL } from "@/lib/constants/payroll-lifecycle";
import {
  adjustmentSchema,
  componentSchema,
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
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) return { error: "Việc này cần quyền khai báo lương VÀ phạm vi xem lương toàn công ty — không được phép NHÌN bảng lương thì cũng không sửa được nó." };
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
  const chongLan = await overlappingActiveVersions(version.policyId, version.effectiveFrom, version.effectiveTo);

  /*
    ═══ CỔNG PHÁT HÀNH: KIỂM MỌI THỨ TRƯỚC KHI LỜI KHAI THÀNH TIỀN ═══

    Kiểm ở ĐÂY chứ không ở bước lưu nháp: bản nháp là chỗ để viết dở, và bắt nó hoàn chỉnh ngay từ
    ô đầu tiên là bắt người khai phải nghĩ xong toàn bộ chính sách trước khi gõ chữ nào.

    `policyActivationBlockers` là hàm THUẦN và màn hình gọi CHÍNH nó, nên không còn cảnh nút hiện
    rồi server từ chối.
  */
  const [policyRow] = await (await getDb())
    .select({ code: schema.salaryPolicies.code })
    .from(schema.salaryPolicies)
    .where(eq(schema.salaryPolicies.id, version.policyId))
    .limit(1);
  const blockers = policyActivationBlockers({
    policyCode: policyRow?.code ?? version.policyId,
    version: version.version,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    components,
    otherActiveVersions: chongLan.filter((v) => v.id !== versionId).map((v) => ({ version: v.version, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo })),
  });
  if (blockers.length) {
    return { error: `Chưa phát hành được phiên bản này:\n· ${blockers.map((b) => b.message).join("\n· ")}` };
  }

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
  const spec = payrollInput(d.inputKey);
  if (!spec) return { error: `Đại lượng ${d.inputKey} không có trong sổ đăng ký đầu vào` };
  if (spec.availability !== "MANUAL") {
    return { error: `${spec.label} là đại lượng ERP TỰ ĐO (${spec.availability}) — gõ tay một con số đè lên số đo được là tạo ra nguồn thứ hai cho cùng một đại lượng` };
  }
  const db = await getDb();
  const t = schema.payrollInputs;
  const ten = (await userNamesByIds([guard.id])).get(guard.id) ?? "";
  await db
    .insert(t)
    .values({
      employeeId: d.employeeId,
      periodKey: d.periodKey,
      inputKey: d.inputKey,
      value: d.value,
      // ĐƠN VỊ do MÁY CHỦ đọc từ sổ đăng ký, không nhận từ client: client gửi đơn vị khác với khoá
      // thì dòng dữ liệu nói một đằng còn phép tính đọc một nẻo (AGENTS.md mục 34).
      unit: spec.unit,
      evidence: d.evidence,
      status: "ENTERED",
      enteredBy: guard.id,
      enteredByName: ten,
    })
    .onConflictDoUpdate({
      target: [t.employeeId, t.periodKey, t.inputKey],
      /*
        SỬA GIÁ TRỊ LÀ HUỶ CHỮ KÝ CŨ.

        Người duyệt đã duyệt MỘT CON SỐ, không phải một ô. Giữ nguyên `APPROVED` sau khi con số đổi
        là mượn chữ ký của họ cho một con số họ chưa từng nhìn thấy.
      */
      set: {
        value: d.value,
        unit: spec.unit,
        evidence: d.evidence,
        status: "ENTERED",
        approvedBy: null,
        approvedByName: "",
        approvedAt: null,
        enteredBy: guard.id,
        enteredByName: ten,
        updatedAt: new Date(),
      },
    });
  await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_INPUT_SAVE", entity: "PAYROLL_INPUT", entityId: `${d.employeeId}:${d.periodKey}:${d.inputKey}`, after: { ...d, unit: spec.unit } });
  revalidate();
  return { ok: true };
}

/**
 * DUYỆT MỘT SỐ LIỆU NHẬP TAY.
 *
 * Tách hẳn khỏi đường ghi: người duyệt xác nhận một con số ĐÃ CÓ, nên hàm này không nhận giá trị.
 * Nếu nó nhận, thì "duyệt" và "sửa rồi tự duyệt" là cùng một lượt bấm.
 */
export async function approvePayrollInput(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = z
    .object({
      employeeId: z.string().min(1),
      periodKey: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/, "Khoá kỳ không hợp lệ"),
      inputKey: z.string().min(1),
    })
    .safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const chot = await periodIsFinal(d.periodKey);
  if (chot) return { error: chot };
  const db = await getDb();
  const t = schema.payrollInputs;
  const rows = await db
    .select({ id: t.id, value: t.value, enteredBy: t.enteredBy })
    .from(t)
    .where(and(eq(t.employeeId, d.employeeId), eq(t.periodKey, d.periodKey), eq(t.inputKey, d.inputKey)));
  const row = rows[0];
  if (!row) return { error: "Không tìm thấy số liệu này để duyệt" };
  /*
    NGƯỜI NHẬP KHÔNG TỰ DUYỆT SỐ CỦA MÌNH.

    Một chữ ký của chính người gõ không thêm một lượt soát nào — nó chỉ làm cột `status` nói dối.
  */
  if (row.enteredBy && row.enteredBy === guard.id) {
    return { error: "Người nhập không tự duyệt số của mình — cần một người thứ hai soát lại" };
  }
  const ten = (await userNamesByIds([guard.id])).get(guard.id) ?? "";
  await db
    .update(t)
    .set({ status: "APPROVED", approvedBy: guard.id, approvedByName: ten, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(t.id, row.id));
  await audit({
    userId: guard.id,
    userEmail: guard.email,
    action: "PAYROLL_INPUT_APPROVE",
    entity: "PAYROLL_INPUT",
    entityId: `${d.employeeId}:${d.periodKey}:${d.inputKey}`,
    after: { value: row.value, approvedBy: guard.id },
  });
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
  /*
    ĐỌC QUA `frozenPeriodRuns` — KHÔNG SO CHUỖI VỚI 'FINAL' Ở ĐÂY.

    Vòng đời sáu trạng thái ghi `LOCKED` / `PAID`; `FINAL` chỉ là giá trị CŨ còn trên production.
    Bản trước hỏi đúng chữ `'FINAL'` nên một kỳ vừa khoá vẫn nhận thêm số liệu nhập tay và khoản
    điều chỉnh mới — ảnh chụp đã đóng băng và tiền đã trả theo nó, còn dữ liệu nguồn vẫn đổi.
  */
  const dongBang = await frozenPeriodRuns(periodKey);
  if (!dongBang.length) return null;
  const mo = dongBang.map((r) => `${r.basis} · ${PAYROLL_RUN_STATUS_LABEL[r.status]}`).join(", ");
  return `Kỳ ${periodKey} đã ĐÓNG BĂNG (${mo}). Kỳ đã đóng băng là bất biến — ghi khoản này vào kỳ SAU, nó vẫn được trả đủ và vẫn có dấu vết.`;
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

// ═════════════════════════ CHUYỂN MỘT NGƯỜI SANG MÁY TÍNH CHUNG ═════════════════════════

/**
 * ÁP BẢN ĐỀ XUẤT CHO ĐÚNG MỘT NGƯỜI — sau khi người bấm đã XEM bảng đối chiếu.
 *
 * ─── VÌ SAO MỘT NGƯỜI MỘT LƯỢT, KHÔNG CÓ NÚT "CHUYỂN TẤT CẢ" ───
 *
 * Một nút chuyển hàng loạt là một lượt đổi cách trả tiền cho tất cả mọi người bằng một cú bấm mà
 * không ai kịp đọc bảng đối chiếu của từng người. Bảng đối chiếu chỉ có giá trị khi có người THẬT
 * SỰ nhìn nó, và người ta chỉ nhìn khi mỗi lần bấm ứng với một người.
 *
 * ─── CHẶN KHI CÒN LỆCH CHƯA GIẢI THÍCH ĐƯỢC ───
 *
 * `acknowledgedDiff` là lối ra có chủ ý cho trường hợp lệch là một SỬA ĐÚNG: chủ shop biết số cũ
 * sai và muốn số mới. Nhưng nó đòi một LÝ DO, và lý do ấy đi vào nhật ký — khác hẳn một lượt bấm
 * qua cảnh báo.
 */
const migrateSchema = z.object({
  employeeId: z.string().min(1),
  policyCode: z.string().min(2).max(40),
  policyName: z.string().min(1).max(120),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Mốc hiệu lực phải dạng YYYY-MM-DD"),
  components: z.array(componentSchema).min(1, "Bản đề xuất không có thành phần nào để áp"),
  /** Người bấm đã đọc và chấp nhận phần lệch chưa giải thích được, kèm lý do. */
  acknowledgedDiff: z.string().trim().max(500).default(""),
  hasUnexplainedDiff: z.boolean().default(false),
});

export async function migrateEmployeeToPolicy(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = migrateSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  if (d.hasUnexplainedDiff && d.acknowledgedDiff.length < 5) {
    return {
      error:
        "Bảng đối chiếu còn khoản lệch CHƯA giải thích được. Không kích hoạt chính sách khi còn chênh chưa rõ nguyên nhân — trừ khi đó là một sửa ĐÚNG có chủ ý, và khi ấy phải ghi rõ lý do để nó đi vào nhật ký.",
    };
  }

  const db = await getDb();
  const from = vnStartOfDay(d.effectiveFrom);

  // Đã gán chính sách rồi thì thôi — chuyển hai lần sinh hai dòng gán chồng lấn, và tiền của những
  // ngày ấy sẽ do thứ tự dòng quyết định.
  const [daCo] = await db
    .select({ id: schema.employeePolicyAssignments.id })
    .from(schema.employeePolicyAssignments)
    .where(eq(schema.employeePolicyAssignments.employeeId, d.employeeId))
    .limit(1);
  if (daCo) return { error: "Nhân sự này đã được gán chính sách rồi. Muốn đổi thì gán một chính sách khác ở tab “Phân công & gán chính sách”, có mốc hiệu lực riêng." };

  const policyId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const luc = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.salaryPolicies).values({
        id: policyId,
        code: d.policyCode,
        name: d.policyName,
        description: "Sinh từ hồ sơ nhân sự cũ (bốn ô lương) qua công cụ Xem trước chuyển đổi.",
        createdBy: guard.id,
      });
      /*
        PHÁT HÀNH LUÔN, KHÔNG để ở bản nháp.

        Bản nháp không tính ra đồng nào, nên một lượt "chuyển" kết thúc bằng bản nháp sẽ làm lương
        người ấy về 0 cho tới khi có ai đó nhớ ra phải bấm phát hành. Ở đây người bấm đã xem bảng
        đối chiếu — đó chính là bước soát mà trạng thái nháp sinh ra để phục vụ.
      */
      await tx.insert(schema.salaryPolicyVersions).values({
        id: versionId,
        policyId,
        version: 1,
        effectiveFrom: from,
        status: "ACTIVE",
        note: "Phát hành cùng lượt chuyển đổi, sau khi người bấm đã xem bảng đối chiếu cũ/mới.",
        activatedAt: luc,
        activatedBy: guard.id,
        createdBy: guard.id,
      });
      await tx.insert(schema.salaryPolicyComponents).values(
        d.components.map((c) => ({
          versionId,
          code: c.code,
          label: c.label,
          kind: c.kind,
          calcType: c.calc.type,
          basisKey: componentBasisKey(c.calc as PayrollCalcParams),
          calc: c.calc,
          prorate: c.prorate,
          rounding: c.rounding,
          minAmount: c.minAmount,
          maxAmount: c.maxAmount,
          carryForward: c.carryForward,
          sortOrder: c.sortOrder,
          note: c.note,
        })),
      );
      await tx.insert(schema.employeePolicyAssignments).values({
        employeeId: d.employeeId,
        policyId,
        effectiveFrom: from,
        note: d.acknowledgedDiff ? `Chuyển từ hồ sơ cũ. Chấp nhận lệch: ${d.acknowledgedDiff}` : "Chuyển từ hồ sơ cũ, không lệch.",
        createdBy: guard.id,
      });
    });
  } catch (e) {
    if (/unique|duplicate/i.test(String(e))) return { error: `Mã chính sách “${d.policyCode}” đã có. Đổi mã rồi thử lại.` };
    throw e;
  }

  await audit({
    userId: guard.id,
    userEmail: guard.email,
    action: "PAYROLL_LEGACY_MIGRATE",
    entity: "EMPLOYEE_POLICY_ASSIGNMENT",
    entityId: d.employeeId,
    after: { policyCode: d.policyCode, effectiveFrom: d.effectiveFrom, components: d.components.length },
    reason: d.acknowledgedDiff || "Đối chiếu cũ/mới không lệch.",
  });
  revalidate();
  return { ok: true, id: policyId };
}

// ═════════════════════════ CẤU HÌNH LƯƠNG ═════════════════════════

/**
 * ═══ HAI CÔNG TẮC ĐỔI SỐ TIỀN CỦA NGƯỜI THẬT ═══
 *
 * Trước bản này, cả hai chỉ đặt được bằng script `set-setting` chạy tay trên máy chủ. Nghĩa là
 * chúng hoặc không bao giờ được bật, hoặc được bật bởi người duy nhất biết cách chạy script — và
 * không ai khác biết nó đã đổi. Cả hai đều là quyết định kinh doanh, nên chúng phải có một cái nút,
 * một cảnh báo đọc được, và một dòng nhật ký.
 *
 *  · **Sổ lỗ lũy kế** — bật lên là đổi cơ sở tính hoa hồng của mọi MKTer.
 *  · **Nguồn ghi nhận chi phí nhân sự** — đổi sang bảng Lương mà bảng Chi phí vẫn đang ghi lương
 *    là trừ hai lần; đổi khi bảng Lương chưa phủ đủ là làm lương biến mất khỏi lợi nhuận. Máy chi
 *    phí đã có lá chắn `coverage` cho cả hai chiều, nhưng người bấm vẫn phải biết mình đang bấm gì.
 */
const carryoverConfigSchema = z
  .object({
    enabled: z.boolean(),
    startMonth: z.union([z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng mở sổ phải dạng YYYY-MM"), z.literal("")]),
    startNote: z.string().trim().max(500).default(""),
  })
  .refine((v) => !v.enabled || Boolean(v.startMonth), {
    message: "Bật sổ lỗ thì phải khai THÁNG MỞ SỔ. Không có mốc bắt đầu thì không có gì để bắt đầu chuỗi số dư, và máy sẽ phải đoán.",
    path: ["startMonth"],
  })
  .refine((v) => !v.enabled || v.startNote.trim().length >= 5, {
    message: "Khai rõ VÌ SAO chọn mốc ấy. Sáu tháng sau phải giải thích được vì sao chuỗi số dư bắt đầu từ đó.",
    path: ["startNote"],
  });

export async function savePayrollCarryoverConfig(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = carryoverConfigSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const truoc = await getSettingJson<PayrollCarryoverConfig>(PAYROLL_CARRYOVER_KEY, DEFAULT_PAYROLL_CARRYOVER);
  const sau: PayrollCarryoverConfig = { enabled: d.enabled, startMonth: d.startMonth || null, startNote: d.startNote };

  const cong = await guardSecondApproval({
    group: "PAYROLL_EDIT",
    action: "payroll.carryover.config",
    entity: "SETTINGS",
    entityId: PAYROLL_CARRYOVER_KEY,
    summary: d.enabled ? `BẬT sổ lỗ lũy kế từ tháng ${d.startMonth} — đổi cơ sở tính hoa hồng của mọi MKTer` : "TẮT sổ lỗ lũy kế",
    amount: null,
    payload: sau,
  });
  if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
  if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };

  await setSettingJson(PAYROLL_CARRYOVER_KEY, sau);
  await audit({
    userId: guard.id,
    userEmail: guard.email,
    action: "PAYROLL_CARRYOVER_CONFIG",
    entity: "SETTINGS",
    entityId: PAYROLL_CARRYOVER_KEY,
    before: truoc,
    after: sau,
    reason: d.startNote,
  });
  revalidate();
  return { ok: true };
}

const recognitionSchema = z.object({ mode: z.enum(["LEGACY_EXPENSES", "PAYROLL"]) });

export async function savePayrollRecognitionMode(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = recognitionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const truoc = await getSettingJson<PayrollRecognitionConfig>(PAYROLL_RECOGNITION_KEY, DEFAULT_PAYROLL_RECOGNITION);

  const cong = await guardSecondApproval({
    group: "PAYROLL_EDIT",
    action: "payroll.recognition.mode",
    entity: "SETTINGS",
    entityId: PAYROLL_RECOGNITION_KEY,
    summary:
      parsed.data.mode === "PAYROLL"
        ? "Chuyển nguồn ghi nhận chi phí nhân sự sang BẢNG LƯƠNG — nhóm “Lương” ở bảng Chi phí sẽ bị loại khỏi lợi nhuận"
        : "Đưa nguồn ghi nhận chi phí nhân sự về BẢNG CHI PHÍ",
    amount: null,
    payload: parsed.data,
  });
  if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
  if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };

  await setSettingJson(PAYROLL_RECOGNITION_KEY, parsed.data);
  await audit({
    userId: guard.id,
    userEmail: guard.email,
    action: "PAYROLL_RECOGNITION_MODE",
    entity: "SETTINGS",
    entityId: PAYROLL_RECOGNITION_KEY,
    before: truoc,
    after: parsed.data,
  });
  revalidate();
  return { ok: true };
}

// ═════════════════════════ KHẤU TRỪ THEO LUẬT ═════════════════════════

/**
 * KHAI TRẠNG THÁI KHẤU TRỪ THEO LUẬT — KHÔNG KHAI TỶ LỆ.
 *
 * Hàm này cố ý KHÔNG nhận một con số phần trăm nào. Tỷ lệ thuế / BHXH đổi theo năm, theo vùng và
 * theo loại hợp đồng; ERP nhận một tỷ lệ gõ tay là in ra một khoản khấu trừ trông hợp lệ mà không
 * ai đi kiểm. Khi chủ shop khai xong luật, phép tính vào máy bằng một THÀNH PHẦN `DEDUCTION` trong
 * chính sách — cùng cửa với lương cứng và hoa hồng.
 *
 * Rời khỏi `NOT_CONFIGURED` là một khẳng định về tiền của người lao động (`EXEMPT` làm phiếu lương
 * in "0 ₫" ở dòng ấy), nên nó đi qua cổng người thứ hai và bắt buộc có CĂN CỨ PHÁP LÝ.
 */
const statutorySchema = z
  .object({
    state: z.enum(STATUTORY_STATES),
    legalBasis: z.string().trim().max(500).default(""),
    note: z.string().trim().max(1000).default(""),
  })
  .refine((v) => v.state === "NOT_CONFIGURED" || v.legalBasis.length >= 3, {
    message: "Ghi rõ căn cứ pháp lý (nghị định / thông tư / quyết định của chủ shop) — một khẳng định về thuế không có căn cứ thì không ai kiểm lại được",
    path: ["legalBasis"],
  });

export async function savePayrollStatutoryConfig(input: unknown): Promise<PolicyActionResult> {
  const guard = await requireManage();
  if ("error" in guard) return guard;
  const parsed = statutorySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const truoc = await getSettingJson<StatutoryConfig>(STATUTORY_DEDUCTION_KEY, DEFAULT_STATUTORY);
  if (truoc.state === parsed.data.state && truoc.legalBasis === parsed.data.legalBasis && truoc.note === parsed.data.note) {
    return { ok: true };
  }

  const cong = await guardSecondApproval({
    group: "PAYROLL_EDIT",
    action: "payroll.statutory.state",
    entity: "SETTINGS",
    entityId: STATUTORY_DEDUCTION_KEY,
    summary:
      parsed.data.state === "EXEMPT"
        ? "Khai KHÔNG ÁP DỤNG khấu trừ theo luật — phiếu lương sẽ in 0 ₫ ở dòng thuế / bảo hiểm"
        : parsed.data.state === "CONFIGURED"
          ? "Khai ĐÃ CẤU HÌNH khấu trừ theo luật — số tiền do thành phần trong chính sách lương tính"
          : "Đưa khấu trừ theo luật về CHƯA CẤU HÌNH",
    amount: null,
    payload: parsed.data,
  });
  if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
  if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };

  const ten = (await userNamesByIds([guard.id])).get(guard.id) ?? guard.email;
  const sau: StatutoryConfig = {
    state: parsed.data.state,
    legalBasis: parsed.data.legalBasis,
    note: parsed.data.note,
    declaredBy: parsed.data.state === "NOT_CONFIGURED" ? "" : ten,
    declaredAt: parsed.data.state === "NOT_CONFIGURED" ? null : new Date().toISOString(),
  };
  await setSettingJson(STATUTORY_DEDUCTION_KEY, sau);
  await audit({ userId: guard.id, userEmail: guard.email, action: "PAYROLL_STATUTORY_STATE", entity: "SETTINGS", entityId: STATUTORY_DEDUCTION_KEY, before: truoc, after: sau });
  revalidatePath("/payroll/payslip");
  revalidate();
  return { ok: true };
}

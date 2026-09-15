/**
 * ═══════ ĐỌC CHÍNH SÁCH LƯƠNG — PHẦN CHẠM CSDL ═══════
 *
 * Phép tính nằm ở `lib/payroll/engine.ts` (hàm thuần). File này chỉ làm hai việc: đọc lời khai ra
 * khỏi CSDL, và dựng đầu vào cho máy tính. Không một phép nhân tiền nào được xuất hiện ở đây —
 * hai nơi cùng tính một khoản là hai nơi sẽ nói hai con số khác nhau.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  type PayrollCalcParams,
  type PayrollComponentKind,
  type PayrollProrateRule,
  type PayrollRoundingRule,
  type PolicyComponent,
} from "@/lib/constants/payroll-components";
import type { EmploymentRow, PolicyAssignmentRow, PolicyVersionRow } from "@/lib/payroll/policy-resolve";
import { validatePolicyBook, type PolicyIssue } from "@/lib/payroll/policy-validation";

export type PolicyRow = typeof schema.salaryPolicies.$inferSelect;

export type PolicyWithVersions = PolicyRow & {
  departmentName: string;
  versions: (typeof schema.salaryPolicyVersions.$inferSelect & { components: PolicyComponent[] })[];
  /** Số người đang gán chính sách này — để màn hình biết tắt nó ảnh hưởng tới ai. */
  assignedCount: number;
};

/** Một dòng thành phần trong CSDL → hình dạng mà máy tính nhận. */
function toComponent(r: typeof schema.salaryPolicyComponents.$inferSelect): PolicyComponent {
  return {
    code: r.code,
    label: r.label,
    kind: r.kind as PayrollComponentKind,
    calc: r.calc as PayrollCalcParams,
    prorate: r.prorate as PayrollProrateRule,
    rounding: r.rounding as PayrollRoundingRule,
    minAmount: r.minAmount,
    maxAmount: r.maxAmount,
    carryForward: r.carryForward,
    sortOrder: r.sortOrder,
    note: r.note,
  };
}

/** Toàn bộ sổ chính sách, kèm phiên bản và thành phần. Một lượt đọc, không N+1. */
export async function listSalaryPolicies(): Promise<PolicyWithVersions[]> {
  const db = await getDb();
  const p = schema.salaryPolicies;
  const v = schema.salaryPolicyVersions;
  const c = schema.salaryPolicyComponents;
  const [policies, versions, components, assigns] = await Promise.all([
    db
      .select({ policy: p, departmentName: schema.departments.name })
      .from(p)
      .leftJoin(schema.departments, eq(schema.departments.id, p.departmentId))
      .orderBy(asc(p.sortOrder), asc(p.name)),
    db.select().from(v).orderBy(desc(v.version)),
    db.select().from(c).orderBy(asc(c.sortOrder), asc(c.code)),
    db.select({ policyId: schema.employeePolicyAssignments.policyId, employeeId: schema.employeePolicyAssignments.employeeId }).from(schema.employeePolicyAssignments),
  ]);
  const byVersion = new Map<string, PolicyComponent[]>();
  for (const row of components) {
    const list = byVersion.get(row.versionId) ?? [];
    list.push(toComponent(row));
    byVersion.set(row.versionId, list);
  }
  const assignedByPolicy = new Map<string, Set<string>>();
  for (const a of assigns) {
    const set = assignedByPolicy.get(a.policyId) ?? new Set<string>();
    set.add(a.employeeId);
    assignedByPolicy.set(a.policyId, set);
  }
  return policies.map(({ policy, departmentName }) => ({
    ...policy,
    departmentName: departmentName ?? "",
    versions: versions.filter((x) => x.policyId === policy.id).map((x) => ({ ...x, components: byVersion.get(x.id) ?? [] })),
    assignedCount: assignedByPolicy.get(policy.id)?.size ?? 0,
  }));
}

export type AssignmentBook = {
  employments: EmploymentRow[];
  policyAssignments: PolicyAssignmentRow[];
  policyVersions: PolicyVersionRow[];
  /** Thành phần theo `versionId` — máy tính cần chúng cho từng đoạn. */
  componentsByVersion: Map<string, PolicyComponent[]>;
};

/**
 * TOÀN BỘ LỜI KHAI CẦN ĐỂ TÍNH LƯƠNG MỘT KỲ — MỘT LƯỢT ĐỌC CHO CẢ CÔNG TY.
 *
 * Cố ý KHÔNG lọc theo khoảng thời gian của kỳ ở SQL. Một dòng phân công bắt đầu từ 2024 và chưa
 * kết thúc vẫn phủ kỳ tháng 9/2026; viết mệnh đề chồng lấn cho `effective_to IS NULL` ở SQL thì dễ
 * sót đúng những dòng ấy. Số dòng ở đây là số dòng phân công của cả shop — hàng chục, không phải
 * hàng triệu — nên đọc hết rồi cắt đoạn bằng hàm thuần là vừa đúng vừa kiểm thử được.
 */
export async function loadAssignmentBook(): Promise<AssignmentBook> {
  const db = await getDb();
  const e = schema.employmentAssignments;
  const a = schema.employeePolicyAssignments;
  const v = schema.salaryPolicyVersions;
  const c = schema.salaryPolicyComponents;
  const [employments, assignments, versions, components] = await Promise.all([
    db
      .select({ row: e, departmentName: schema.departments.name, positionName: schema.positions.name })
      .from(e)
      .leftJoin(schema.departments, eq(schema.departments.id, e.departmentId))
      .leftJoin(schema.positions, eq(schema.positions.id, e.positionId)),
    db
      .select({ row: a, policyCode: schema.salaryPolicies.code, policyName: schema.salaryPolicies.name })
      .from(a)
      .innerJoin(schema.salaryPolicies, eq(schema.salaryPolicies.id, a.policyId)),
    db.select().from(v),
    db.select().from(c).orderBy(asc(c.sortOrder), asc(c.code)),
  ]);
  const componentsByVersion = new Map<string, PolicyComponent[]>();
  for (const row of components) {
    const list = componentsByVersion.get(row.versionId) ?? [];
    list.push(toComponent(row));
    componentsByVersion.set(row.versionId, list);
  }
  return {
    employments: employments.map(({ row, departmentName, positionName }) => ({
      id: row.id,
      employeeId: row.employeeId,
      departmentId: row.departmentId,
      departmentName: departmentName ?? "",
      positionId: row.positionId,
      positionName: positionName ?? "",
      managerUserId: row.managerUserId,
      employmentType: row.employmentType as EmploymentRow["employmentType"],
      workMode: row.workMode as EmploymentRow["workMode"],
      status: row.status as EmploymentRow["status"],
      standardWorkDays: row.standardWorkDays,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    })),
    policyAssignments: assignments.map(({ row, policyCode, policyName }) => ({
      id: row.id,
      employeeId: row.employeeId,
      policyId: row.policyId,
      policyCode,
      policyName,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    })),
    policyVersions: versions.map((x) => ({
      id: x.id,
      policyId: x.policyId,
      version: x.version,
      effectiveFrom: x.effectiveFrom,
      effectiveTo: x.effectiveTo,
      status: x.status as PolicyVersionRow["status"],
    })),
    componentsByVersion,
  };
}

/** Đại lượng nhập tay của một kỳ: `employeeId → inputKey → giá trị`, kèm chứng cứ để in ra vết. */
export async function loadManualInputs(periodKey: string) {
  const db = await getDb();
  const t = schema.payrollInputs;
  const rows = await db.select().from(t).where(eq(t.periodKey, periodKey));
  const values = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = values.get(r.employeeId) ?? new Map<string, number>();
    m.set(r.inputKey, Number(r.value));
    values.set(r.employeeId, m);
  }
  return { rows, values };
}

/** Khoản điều chỉnh của một kỳ, theo từng người. */
export async function loadAdjustments(periodKey: string) {
  const db = await getDb();
  const t = schema.payrollAdjustments;
  const rows = await db.select().from(t).where(eq(t.periodKey, periodKey)).orderBy(asc(t.createdAt));
  const byEmployee = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byEmployee.get(r.employeeId) ?? [];
    list.push(r);
    byEmployee.set(r.employeeId, list);
  }
  return { rows, byEmployee };
}

/** Phòng ban và chức danh còn bật — để màn hình khai phân công chọn được. */
export async function listOrgOptions() {
  const db = await getDb();
  const [depts, pos, users] = await Promise.all([
    db.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.active, true)).orderBy(asc(schema.departments.sortOrder)),
    db.select({ id: schema.positions.id, name: schema.positions.name }).from(schema.positions).where(eq(schema.positions.active, true)).orderBy(asc(schema.positions.sortOrder)),
    db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.active, true)).orderBy(asc(schema.users.name)),
  ]);
  return { departments: depts, positions: pos, users };
}

/** Tên do MÁY CHỦ đọc từ `users` — không nhận từ client (AGENTS.md mục 34). */
export async function userNamesByIds(ids: readonly string[]): Promise<Map<string, string>> {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return new Map();
  const db = await getDb();
  const rows = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, clean));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Nhân sự nào đã được gán chính sách (bất kỳ mốc nào) — màn hình dùng để phân biệt hai đường tính. */
export async function employeesOnPolicyEngine(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select({ employeeId: schema.employeePolicyAssignments.employeeId }).from(schema.employeePolicyAssignments);
  return new Set(rows.map((r) => r.employeeId));
}

/** Phiên bản kế tiếp của một chính sách (đánh số liên tục, không lấp chỗ trống). */
export async function nextVersionNumber(policyId: string): Promise<number> {
  const db = await getDb();
  const v = schema.salaryPolicyVersions;
  const [row] = await db.select({ version: v.version }).from(v).where(eq(v.policyId, policyId)).orderBy(desc(v.version)).limit(1);
  return (row?.version ?? 0) + 1;
}

/** Một phiên bản kèm thành phần — để màn hình sửa và để nhân bản. */
export async function getPolicyVersion(versionId: string) {
  const db = await getDb();
  const v = schema.salaryPolicyVersions;
  const [version] = await db.select().from(v).where(eq(v.id, versionId)).limit(1);
  if (!version) return null;
  const components = await db
    .select()
    .from(schema.salaryPolicyComponents)
    .where(eq(schema.salaryPolicyComponents.versionId, versionId))
    .orderBy(asc(schema.salaryPolicyComponents.sortOrder));
  return { version, components: components.map(toComponent) };
}

/** Các phiên bản ĐANG HIỆU LỰC chồng lấn với một khoảng — để cảnh báo khi khai trùng. */
export async function overlappingActiveVersions(policyId: string, from: Date, to: Date | null) {
  const db = await getDb();
  const v = schema.salaryPolicyVersions;
  const rows = await db.select().from(v).where(and(eq(v.policyId, policyId), eq(v.status, "ACTIVE")));
  return rows.filter((r) => {
    const rTo = r.effectiveTo ? r.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
    const qTo = to ? to.getTime() : Number.POSITIVE_INFINITY;
    return r.effectiveFrom.getTime() <= qTo && rTo >= from.getTime();
  });
}

/**
 * KIỂM SỔ KHAI CHO MỘT KỲ — một lượt đọc, rồi chạy phép kiểm THUẦN.
 *
 * Đây là cửa mà cả màn hình lẫn cổng chốt kỳ gọi, nên hai nơi không thể nói hai điều khác nhau về
 * cùng một sổ khai.
 */
export async function validatePolicyBookForPeriod(
  from: Date,
  to: Date,
  employees: readonly { id: string; name: string }[],
): Promise<PolicyIssue[]> {
  const book = await loadAssignmentBook();
  const policyCodeByVersion = new Map<string, string>();
  for (const v of book.policyVersions) {
    const code = book.policyAssignments.find((a) => a.policyId === v.policyId)?.policyCode ?? v.policyId;
    policyCodeByVersion.set(v.id, code);
  }
  return validatePolicyBook({
    from,
    to,
    employees,
    employments: book.employments,
    policyAssignments: book.policyAssignments,
    policyVersions: book.policyVersions,
    componentsByVersion: book.componentsByVersion,
    policyCodeByVersion,
  });
}

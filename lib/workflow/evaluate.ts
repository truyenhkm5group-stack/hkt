/**
 * ═══════════ ĐÁNH GIÁ ĐIỀU KIỆN CỦA LUẬT (W3) — HÀM THUẦN ═══════════
 *
 * Hợp đồng: docs/platform/phase-3-contracts.md mục 4. Không đọc CSDL, không `eval`, không SQL do người khai:
 * cây AND/OR của các lá `{ field, op, value }` với tập phép ĐÓNG của `ListFilterOp` (Phase 2).
 *
 * `subject` là ảnh chụp bản ghi do máy chủ dựng: khoá `system:<k>` (cột thật theo sổ đối tượng, hoặc thông tin
 * sự kiện) và `custom:<k>` (field custom ACTIVE). Mọi field BIẾT được đều có mặt — thiếu giá trị thì `null`.
 * Vì vậy "ref lạ" (khoá không có trong subject) khác hẳn "field rỗng": ref lạ ⇒ `false` với MỌI phép, kể cả
 * `empty` — một luật trỏ tới field đã bị lưu trữ không được lặng lẽ khớp mọi bản ghi.
 *
 * SO SÁNH AN TOÀN KIỂU: không ép kiểu ngầm. Số so với số, chữ so với chữ, ngày ISO so theo mốc thời gian;
 * hai vế khác kiểu ⇒ không khớp (một chuỗi "10" không bằng số 10 — ép ngầm là cách một luật tiền chạy nhầm).
 * `null` / vắng là CHƯA BIẾT: không lớn hơn, không nhỏ hơn, không bằng bất kỳ giá trị nào (AGENTS.md mục 0.3).
 * Hàm KHÔNG BAO GIỜ ném — cây sai hình ⇒ `false`.
 */
import type { ListFilterOp } from "@/lib/metadata/types";
import type { WorkflowCondition } from "@/lib/workflow/types";

/** Độ sâu tối đa của cây điều kiện (gốc = 1). Sâu hơn ⇒ không khớp (và `saveRule` từ chối). */
export const WORKFLOW_CONDITION_MAX_DEPTH = 5;

export const WORKFLOW_CONDITION_OPS: readonly ListFilterOp[] = ["eq", "neq", "contains", "gte", "lte", "in", "empty", "not_empty"];

/** Chuỗi trông như ngày / ngày giờ ISO (`2026-09-27`, `2026-09-27T07:30:00.000Z`, có hoặc không múi giờ). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

type Scalar = string | number | boolean;

/** Chuẩn hoá một giá trị của subject / của luật: `Date` ⇒ ISO; số không hữu hạn ⇒ CHƯA BIẾT. */
function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  if (typeof v === "bigint") return Number(v);
  return v;
}

function isScalar(v: unknown): v is Scalar {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isEmpty(v: unknown): boolean {
  return v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

/** Bằng nhau CÙNG KIỂU. Ngày ISO so theo mốc (hai cách viết cùng một thời điểm là bằng). */
function sameScalar(a: Scalar, b: Scalar): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a === "string" && typeof b === "string" && ISO_DATE.test(a) && ISO_DATE.test(b)) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb;
  }
  return a === b;
}

/** `eq`: vô hướng ⇒ bằng cùng kiểu; mảng (chọn nhiều) ⇒ "có chứa" — cùng nghĩa với lọc SQL của Phase 2. */
function equals(actual: unknown, expected: unknown): boolean {
  if (!isScalar(expected)) return false;
  if (Array.isArray(actual)) return actual.some((x) => isScalar(x) && sameScalar(x, expected));
  return isScalar(actual) && sameScalar(actual, expected);
}

/** So thứ tự: -1 / 0 / 1, hoặc `null` khi hai vế không so được (khác kiểu, chưa biết). */
function order(actual: unknown, expected: unknown): number | null {
  if (typeof actual === "number" && typeof expected === "number") return actual === expected ? 0 : actual < expected ? -1 : 1;
  if (typeof actual === "string" && typeof expected === "string") {
    if (ISO_DATE.test(actual) && ISO_DATE.test(expected)) {
      const ta = Date.parse(actual);
      const tb = Date.parse(expected);
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb ? 0 : ta < tb ? -1 : 1;
      return null;
    }
    return actual === expected ? 0 : actual < expected ? -1 : 1;
  }
  return null;
}

function leaf(field: unknown, op: unknown, rawValue: unknown, subject: Record<string, unknown>): boolean {
  if (typeof field !== "string" || !(field.startsWith("system:") || field.startsWith("custom:"))) return false;
  if (!Object.prototype.hasOwnProperty.call(subject, field)) return false;
  const actual = norm(subject[field]);
  const value = Array.isArray(rawValue) ? rawValue.map(norm) : norm(rawValue);
  switch (op as ListFilterOp) {
    case "eq":
      return equals(actual, value);
    case "neq":
      // Chưa biết ≠ bằng: bản ghi chưa có giá trị KHÔNG bằng giá trị luật (cùng nghĩa với lọc SQL Phase 2).
      return isScalar(value) && !equals(actual, value);
    case "in":
      return Array.isArray(value) && value.length > 0 && value.some((v) => equals(actual, v));
    case "contains":
      if (Array.isArray(actual)) return equals(actual, value);
      return typeof actual === "string" && typeof value === "string" && value.length > 0 && actual.toLocaleLowerCase("vi").includes(value.toLocaleLowerCase("vi"));
    case "gte": {
      const o = order(actual, value);
      return o !== null && o >= 0;
    }
    case "lte": {
      const o = order(actual, value);
      return o !== null && o <= 0;
    }
    case "empty":
      return isEmpty(actual);
    case "not_empty":
      return !isEmpty(actual);
    default:
      return false;
  }
}

function walk(cond: unknown, subject: Record<string, unknown>, depth: number): boolean {
  if (depth > WORKFLOW_CONDITION_MAX_DEPTH) return false;
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return false;
  const c = cond as Record<string, unknown>;
  if ("all" in c) return Array.isArray(c.all) && c.all.every((x) => walk(x, subject, depth + 1));
  if ("any" in c) return Array.isArray(c.any) && c.any.some((x) => walk(x, subject, depth + 1));
  if ("field" in c) return leaf(c.field, c.op, c.value, subject);
  return false;
}

/**
 * Điều kiện có khớp subject không. `null` / vắng ⇒ luật không có điều kiện ⇒ khớp.
 * `{ all: [] }` ⇒ khớp (không có vế nào sai); `{ any: [] }` ⇒ KHÔNG khớp (không có vế nào đúng).
 */
export function evaluateCondition(cond: WorkflowCondition | null, subject: Record<string, unknown>): boolean {
  if (cond === null || cond === undefined) return true;
  try {
    return walk(cond, subject ?? {}, 1);
  } catch {
    return false;
  }
}

/** Độ sâu của một cây điều kiện (lá = 1). Dùng lúc lưu luật để từ chối cây quá sâu với lời giải thích. */
export function conditionDepth(cond: unknown): number {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return 1;
  const c = cond as Record<string, unknown>;
  const kids = Array.isArray(c.all) ? c.all : Array.isArray(c.any) ? c.any : null;
  if (!kids) return 1;
  return 1 + kids.reduce<number>((m, k) => Math.max(m, conditionDepth(k)), 0);
}

/** Mọi ref field trong cây — để kiểm lúc lưu rằng chúng trỏ tới field có thật. */
export function conditionRefs(cond: unknown, out: string[] = []): string[] {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return out;
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.all)) for (const k of c.all) conditionRefs(k, out);
  else if (Array.isArray(c.any)) for (const k of c.any) conditionRefs(k, out);
  else if (typeof c.field === "string") out.push(c.field);
  return out;
}

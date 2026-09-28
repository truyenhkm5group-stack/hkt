/**
 * BĂM ỔN ĐỊNH (Phase 7 · §3) — cùng một nội dung luôn ra cùng một băm, bất kể thứ tự khoá.
 *
 * `JSON.stringify` giữ thứ tự chèn khoá: hai đối tượng bằng nhau về nghĩa (một cái đọc từ jsonb của Postgres —
 * khoá đã bị sắp lại — một cái dựng trong mã) cho hai chuỗi khác nhau, và phép so ba chiều sẽ báo "tổ chức đã sửa"
 * cho một thứ không ai động vào. Nên khoá được SẮP trước khi băm; mảng giữ nguyên thứ tự (thứ tự cột, thứ tự
 * khối CÓ nghĩa). `undefined` bị bỏ như JSON làm — `{ a: undefined }` và `{}` là một.
 */
import { createHash } from "node:crypto";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** sha256 hex (rút 32 ký tự — đủ phân biệt, gọn trên màn hình và trong sổ). */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32);
}

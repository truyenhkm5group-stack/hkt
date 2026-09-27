/**
 * Giá trị custom ⇒ chữ để HIỂN THỊ / XUẤT CSV — thuần, client-safe.
 *
 * Khoá vắng mặt ⇒ `""` trong CSV và `—` trên màn hình (qua `lib/format.ts` ở nơi vẽ): CHƯA BIẾT, không
 * bao giờ in thành 0 hay "Không" (luật 42). `false` THẬT của field có/không thì in "Không".
 */
import type { CustomFieldDef } from "@/lib/metadata/types";

export function customValueText(def: CustomFieldDef, value: unknown): string {
  if (value === undefined || value === null) return "";
  const label = (v: unknown) => (typeof v === "string" ? (def.options.find((o) => o.value === v)?.label ?? v) : String(v));
  switch (def.type) {
    case "boolean":
      return value === true ? "Có" : value === false ? "Không" : "";
    case "select":
    case "status":
      return label(value);
    case "multi_select":
      return Array.isArray(value) ? value.map(label).join("; ") : label(value);
    case "number":
    case "currency":
      // Số nguyên VND in THÔ (không dấu phân cách) để bảng tính đọc được thành số.
      return typeof value === "number" ? String(value) : "";
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

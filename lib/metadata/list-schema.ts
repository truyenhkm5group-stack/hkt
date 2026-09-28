/**
 * ═══════════ DANH SÁCH METADATA — DỰNG MẶC ĐỊNH, CHUẨN HOÁ, KIỂM LƯỢC ĐỒ (M9) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Cùng mô hình với form (`form-schema.ts`). Luật chuẩn hoá:
 *  · cột chỉ nhận field `listable` (hệ thống: khai trong sổ; custom: cờ `listable` + ACTIVE); ref lạ bị bỏ;
 *  · sắp xếp mặc định phải trỏ vào một field còn tồn tại, nếu không ⇒ `null` (không sắp);
 *  · bộ lọc mặc định chỉ nhận field `filterable` và giá trị đúng hình của phép (`in` là mảng ≤ 100 phần tử,
 *    `empty`/`not_empty` không mang giá trị) — bộ lọc sai hình bị bỏ, vì một bộ lọc hỏng mà vẫn chạy thì
 *    danh sách trả RỖNG và người đọc tưởng "không có bản ghi nào".
 *
 * Danh sách MẶC ĐỊNH (tổ chức chưa xuất bản): cột hệ thống `listable` HIỆN, cột custom có mặt nhưng ẨN —
 * "chưa cấu hình ⇒ cột của mã nguồn y như cũ" (M9). Field custom mới KHÔNG tự hiện trong danh sách đã
 * xuất bản (cùng lý do với form); bản nháp nối nó vào cuối ở trạng thái ẩn.
 */
import { z } from "zod";
import { objectDef, type AnyObjectDef } from "@/lib/constants/object-registry";
import { activeCustom, fieldRefZ, parseRef } from "@/lib/metadata/form-schema";
import type { CustomFieldDef, FieldError, FieldRef, ListColumnConfig, ListFilter, ListFilterOp, ListViewSchema, SystemFieldDef } from "@/lib/metadata/types";

export const LIST_FILTER_OPS: readonly ListFilterOp[] = ["eq", "neq", "contains", "gte", "lte", "in", "empty", "not_empty"];
export const LIST_MAX_COLUMNS = 100;
export const LIST_MAX_FILTERS = 20;
export const FILTER_IN_MAX = 100;

const scalarZ = z.union([z.string().max(2_000), z.number(), z.boolean()]);

export const listViewSchemaZ = z.object({
  version: z.literal(1),
  columns: z.array(z.object({ ref: fieldRefZ, visible: z.boolean() })).max(LIST_MAX_COLUMNS),
  defaultSort: z.object({ ref: fieldRefZ, dir: z.enum(["asc", "desc"]) }).nullable(),
  defaultFilters: z
    .array(z.object({ ref: fieldRefZ, op: z.enum(LIST_FILTER_OPS as [ListFilterOp, ...ListFilterOp[]]), value: z.union([scalarZ, z.array(scalarZ).max(FILTER_IN_MAX)]).optional() }))
    .max(LIST_MAX_FILTERS),
});

type Known = { listable: boolean; filterable: boolean };

function known(ref: string, system: readonly SystemFieldDef[], custom: readonly CustomFieldDef[]): Known | null {
  const p = parseRef(ref);
  if (!p) return null;
  if (p.kind === "system") {
    const d = system.find((s) => s.key === p.key);
    return d ? { listable: d.listable, filterable: d.filterable } : null;
  }
  const d = custom.find((c) => c.key === p.key && c.status === "ACTIVE");
  return d ? { listable: d.listable, filterable: d.filterable } : null;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** Bộ lọc đúng hình (không kiểm field) — dùng chung cho chuẩn hoá và cho `customValuesFilterSql`. */
export function filterShapeOk(f: ListFilter): boolean {
  if (!LIST_FILTER_OPS.includes(f.op)) return false;
  if (f.op === "empty" || f.op === "not_empty") return true;
  if (f.op === "in") return Array.isArray(f.value) && f.value.length > 0 && f.value.length <= FILTER_IN_MAX && f.value.every(isScalar);
  if (f.op === "contains") return typeof f.value === "string" && f.value.length > 0;
  if (f.op === "gte" || f.op === "lte") return typeof f.value === "string" || (typeof f.value === "number" && Number.isFinite(f.value));
  return isScalar(f.value);
}

/** `object`: khoá của sổ tĩnh, HOẶC định nghĩa đã phân giải (đối tượng tuỳ biến — Phase 6). */
export function defaultListView(object: string | AnyObjectDef, _viewKey: string, customDefs: readonly CustomFieldDef[]): ListViewSchema {
  const def = typeof object === "string" ? objectDef(object) : object;
  const columns: ListColumnConfig[] = [
    ...(def?.fields ?? []).filter((f) => f.listable).map((f) => ({ ref: `system:${f.key}` as FieldRef, visible: true })),
    ...activeCustom(customDefs)
      .filter((c) => c.listable)
      // Đối tượng hệ thống: cột custom có mặt nhưng ẨN ("cột của mã nguồn y như cũ", M9). Đối tượng tuỳ biến (Phase 6)
      // không có "mã nguồn cũ" nào — field của nó LÀ nội dung, nên hiện ngay.
      .map((c) => ({ ref: `custom:${c.key}` as FieldRef, visible: def?.system === false })),
  ];
  return { version: 1, columns, defaultSort: null, defaultFilters: [] };
}

export function normalizeListView(
  schema: ListViewSchema,
  system: readonly SystemFieldDef[],
  custom: readonly CustomFieldDef[],
  opts: { appendMissing?: boolean } = {},
): ListViewSchema {
  const seen = new Set<string>();
  const columns: ListColumnConfig[] = [];
  for (const col of schema?.columns ?? []) {
    if (!col || typeof col.ref !== "string" || seen.has(col.ref)) continue;
    if (!known(col.ref, system, custom)?.listable) continue;
    seen.add(col.ref);
    columns.push({ ref: col.ref, visible: col.visible === true });
  }
  if (opts.appendMissing) {
    for (const f of system) if (f.listable && !seen.has(`system:${f.key}`)) columns.push({ ref: `system:${f.key}`, visible: false });
    for (const c of activeCustom(custom)) if (c.listable && !seen.has(`custom:${c.key}`)) columns.push({ ref: `custom:${c.key}`, visible: false });
  }
  const sort = schema?.defaultSort;
  const defaultSort = sort && typeof sort.ref === "string" && known(sort.ref, system, custom) && (sort.dir === "asc" || sort.dir === "desc") ? { ref: sort.ref, dir: sort.dir } : null;
  const defaultFilters: ListFilter[] = [];
  for (const f of schema?.defaultFilters ?? []) {
    if (!f || typeof f.ref !== "string" || !known(f.ref, system, custom)?.filterable || !filterShapeOk(f)) continue;
    defaultFilters.push(f.op === "empty" || f.op === "not_empty" ? { ref: f.ref, op: f.op } : { ref: f.ref, op: f.op, value: f.value });
  }
  return { version: 1, columns, defaultSort, defaultFilters };
}

export function listRefProblems(schema: ListViewSchema, system: readonly SystemFieldDef[], custom: readonly CustomFieldDef[]): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  for (const col of schema.columns) {
    if (seen.has(col.ref)) errors.push({ field: col.ref, message: `Cột "${col.ref}" xuất hiện hai lần.` });
    seen.add(col.ref);
    const k = known(col.ref, system, custom);
    if (!k) errors.push({ field: col.ref, message: `Field "${col.ref}" không tồn tại hoặc đã lưu trữ.` });
    else if (!k.listable) errors.push({ field: col.ref, message: `Field "${col.ref}" không hiển thị được thành cột.` });
  }
  if (schema.defaultSort && !known(schema.defaultSort.ref, system, custom)) errors.push({ field: schema.defaultSort.ref, message: `Không sắp xếp được theo "${schema.defaultSort.ref}".` });
  for (const f of schema.defaultFilters) {
    const k = known(f.ref, system, custom);
    if (!k?.filterable) errors.push({ field: f.ref, message: `Field "${f.ref}" không lọc được.` });
    else if (!filterShapeOk(f)) errors.push({ field: f.ref, message: `Bộ lọc "${f.op}" trên "${f.ref}" thiếu hoặc sai giá trị.` });
  }
  return errors;
}

/**
 * ═══════════ NGƯỜI NÀY XEM / GHI ĐƯỢC BẢN GHI NÀY KHÔNG (Phase 6 · mục 3–4) — CHỈ MÁY CHỦ ═══════════
 *
 * Một câu trả lời cho ba nơi hỏi: đọc / ghi bản ghi tuỳ biến (`lib/objects/records.ts`), ghi giá trị custom qua
 * dịch vụ chung (`saveCustomValues` — cửa action chung không được là lối vòng qua phạm vi), và field QUAN HỆ (đích
 * phải tồn tại, chưa xoá, và NGƯỜI GHI xem được; tên đích chỉ hiện khi NGƯỜI XEM xem được).
 *
 * Thứ tự hỏi đúng như `requireResource` / cổng nguồn của trang (quyền trước, phạm vi sau):
 *  1. module của đối tượng bật cho TỔ CHỨC HIỆN HÀNH (kể cả nhóm menu của đối tượng tuỳ biến);
 *  2. người xem có ĐỦ khoá xem (`objectAccess`) — ADMIN vẫn qua `can()` nên khoá của module tắt vẫn chặn (P8);
 *  3. phạm vi dữ liệu (`decideScope`): bản ghi tuỳ biến theo `CUSTOM_RECORDS` (chủ dòng = `owner_id`); đối tượng hệ
 *     thống theo loại dữ liệu mà TRANG CŨ của nó dùng (`OBJECT_SCOPE_RESOURCE` — cùng bảng với trang động Phase 4).
 *     `NONE` ⇒ không; `ROWS` ⇒ hỏi mệnh đề trên CHÍNH dòng đó, và chỉ khi sổ phạm vi nói về đúng bảng của đối tượng.
 * Mọi nhánh lỗi rơi về phía HẸP HƠN (luật 31). `getDb()` là CSDL của tổ chức hiện hành: id của tổ chức khác không có.
 */
import { and, getTableName, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { Permission } from "@/lib/auth/permissions";
import { andScope, decideScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { SCOPE_RESOURCE_BY_KEY } from "@/lib/constants/data-scope-policy";
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { idColumnOf, objectModuleOff, recordScopeSql } from "@/lib/metadata/common";
import { objectAccess, RECORDS_VIEW_PERMISSION, RECORDS_WRITE_PERMISSION } from "@/lib/metadata/permissions";
import { OBJECT_SCOPE_RESOURCE } from "@/lib/pages/runtime-common";

/** Loại dữ liệu của sổ phạm vi cho bản ghi tuỳ biến. */
export const CUSTOM_RECORDS_SCOPE = "CUSTOM_RECORDS";

type Viewer = SessionUser;

export function canViewObject(viewer: Viewer, def: AnyObjectDef): boolean {
  return objectAccess(def).view.every((p) => can(viewer, p as Permission));
}

export function canWriteObject(viewer: Viewer, def: AnyObjectDef): boolean {
  return canViewObject(viewer, def) && objectAccess(def).edit.every((p) => can(viewer, p as Permission));
}

/** Loại dữ liệu phạm vi của đối tượng — `null` ⇒ trang cũ không qua sổ phạm vi (chỉ cổng quyền). */
export function scopeResourceOf(def: AnyObjectDef): string | null {
  return def.system ? (OBJECT_SCOPE_RESOURCE[def.key] ?? null) : CUSTOM_RECORDS_SCOPE;
}

const OPEN: ScopeDecision = { allow: "ALL", explain: "Đối tượng không qua sổ phạm vi — cùng cổng với trang cũ." };

/** Quyết định phạm vi của người này trên đối tượng này (xem hay ghi). */
export async function objectScope(viewer: Viewer, def: AnyObjectDef, mode: "view" | "write" = "view"): Promise<ScopeDecision> {
  const resource = scopeResourceOf(def);
  if (!resource) return OPEN;
  const permission = def.system ? objectAccess(def).view[0] : mode === "write" ? RECORDS_WRITE_PERMISSION : RECORDS_VIEW_PERMISSION;
  return decideScope(resource, viewer, permission);
}

/** Mệnh đề phạm vi có nói về ĐÚNG bảng của đối tượng không — hỏi mệnh đề của bảng khác trên bảng này là hỏi sai câu. */
function scopeFitsTable(def: AnyObjectDef): boolean {
  const resource = scopeResourceOf(def);
  const res = resource ? SCOPE_RESOURCE_BY_KEY[resource] : null;
  const table = (schema as unknown as Record<string, unknown>)[def.table] as PgTable | undefined;
  return Boolean(res && table && res.table === getTableName(table));
}

/**
 * Trong `ids`, những id người này XEM được: đối tượng bật + đủ quyền xem + tồn tại (bản ghi tuỳ biến: đúng đối tượng,
 * chưa xoá) + nằm trong phạm vi. Một câu truy vấn cho cả lô.
 */
export async function visibleRecordIds(viewer: Viewer, def: AnyObjectDef, ids: readonly string[], mode: "view" | "write" = "view"): Promise<Set<string>> {
  const clean = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 200))];
  if (clean.length === 0) return new Set();
  if (await objectModuleOff(def)) return new Set();
  if (!(mode === "write" ? canWriteObject(viewer, def) : canViewObject(viewer, def))) return new Set();
  const decision = await objectScope(viewer, def, mode);
  if (decision.allow === "NONE") return new Set();
  if (decision.allow === "ROWS" && !scopeFitsTable(def)) return new Set();
  const table = (schema as unknown as Record<string, unknown>)[def.table] as PgTable;
  const col = idColumnOf(def);
  const db = await getDb();
  const out = new Set<string>();
  for (let i = 0; i < clean.length; i += 500) {
    const chunk = clean.slice(i, i + 500);
    const rows = await db
      .select({ id: sql<string>`${col}::text` })
      .from(table)
      .where(andScope(and(inArray(col, chunk), recordScopeSql(def)), decision));
    for (const r of rows) out.add(String(r.id));
  }
  return out;
}

export async function canViewRecord(viewer: Viewer, def: AnyObjectDef, id: string): Promise<boolean> {
  return (await visibleRecordIds(viewer, def, [id])).has(id);
}

export async function canWriteRecord(viewer: Viewer, def: AnyObjectDef, id: string): Promise<boolean> {
  return (await visibleRecordIds(viewer, def, [id], "write")).has(id);
}

/** Tên hiển thị của các bản ghi — CHỈ bản ghi người xem xem được (id khác vắng mặt ⇒ nơi vẽ in "—"). */
export async function recordTitles(viewer: Viewer, def: AnyObjectDef, ids: readonly string[]): Promise<Map<string, string>> {
  const visible = await visibleRecordIds(viewer, def, ids);
  const out = new Map<string, string>();
  if (visible.size === 0) return out;
  const table = (schema as unknown as Record<string, unknown>)[def.table] as PgTable;
  const col = idColumnOf(def);
  const titleColName = def.fields.find((f) => f.key === def.titleField)?.column ?? def.idColumn;
  const titleCol = (table as unknown as Record<string, unknown>)[titleColName] ?? col;
  const db = await getDb();
  const rows = await db
    .select({ id: sql<string>`${col}::text`, title: sql<string | null>`${titleCol}::text` })
    .from(table)
    .where(inArray(col, [...visible]));
  for (const r of rows) out.set(String(r.id), r.title?.trim() ? r.title : String(r.id));
  return out;
}

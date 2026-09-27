/**
 * ═══════════ GIÁ TRỊ CUSTOM (M3, M6, M11, M12) — CHỈ MÁY CHỦ ═══════════
 *
 * Một dòng `custom_values` cho mỗi bản ghi. Đồng bộ từ đối tác (Pancake…) KHÔNG BAO GIỜ chạm bảng này.
 *
 * HÀNG RÀO GHI (theo thứ tự, lỗi ở bước nào thì 0 dòng được ghi):
 *  1. đối tượng có trong sổ, có năng lực field custom, module đang bật (M14);
 *  2. người ghi có quyền ghi của đối tượng (`OBJECT_RECORD_PERMISSIONS`) và `editPermission` của TỪNG field gửi lên;
 *  3. bản ghi TỒN TẠI trong bảng thật của đối tượng trong CSDL CỦA TỔ CHỨC HIỆN HÀNH — id của tổ chức khác
 *     không có ở đây, nên tấn công theo id chéo tổ chức dừng ở bước này;
 *  4. `validateCustomValues` (ép kiểu, bắt buộc, giới hạn, mẫu, chuyển trạng thái, khoá lạ ⇒ lỗi);
 *  5. `user` / `relation` / `file` trỏ id CÓ THẬT trong CSDL tổ chức;
 *  6. ghi theo PHIÊN BẢN (khoá lạc quan): người khác vừa ghi ⇒ `CONFLICT`, không đè im lặng.
 * Sau khi ghi: `audit()` entity `CUSTOM_VALUES`, trước/sau CHỈ của các khoá đổi. Không đổi gì ⇒ không ghi,
 * không tăng phiên bản, không thêm nhật ký.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import type { Permission } from "@/lib/auth/permissions";
import { objectDef, type ObjectDef } from "@/lib/constants/object-registry";
import { auditActor, checkObject, existingRecordIds, idColumnOf, loadCustomDefs, recordExists, requireObject } from "@/lib/metadata/common";
import { customValueText } from "@/lib/metadata/display";
import { fail, MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { writableCustomKeys } from "@/lib/metadata/form-schema";
import { getPublishedForm } from "@/lib/metadata/forms";
import { filterShapeOk } from "@/lib/metadata/list-schema";
import { OBJECT_RECORD_PERMISSIONS } from "@/lib/metadata/permissions";
import { FIELD_KEY_PATTERN, type CustomFieldDef, type CustomValues, type FieldError, type ListFilter } from "@/lib/metadata/types";
import { validateCustomValues } from "@/lib/metadata/validate";

export const CUSTOM_FILE_MAX_BYTES = 5 * 1024 * 1024;

type Viewer = SessionUser;

function perms(def: ObjectDef) {
  return OBJECT_RECORD_PERMISSIONS[def.key];
}

export function canViewObjectValues(viewer: Viewer, def: ObjectDef): boolean {
  return can(viewer, perms(def).view as Permission);
}

export function canViewField(viewer: Viewer, obj: ObjectDef, field: CustomFieldDef): boolean {
  return canViewObjectValues(viewer, obj) && (!field.viewPermission || can(viewer, field.viewPermission as Permission));
}

export function canEditField(viewer: Viewer, obj: ObjectDef, field: CustomFieldDef): boolean {
  return canViewField(viewer, obj, field) && can(viewer, perms(obj).edit as Permission) && (!field.editPermission || can(viewer, field.editPermission as Permission));
}

function visibleOnly(values: CustomValues, visible: Set<string>): CustomValues {
  const out: CustomValues = {};
  for (const [k, v] of Object.entries(values ?? {})) if (visible.has(k)) out[k] = v;
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ─────────────────────────── Đọc ───────────────────────────

/** Giá trị custom của các bản ghi — chỉ field ACTIVE người xem được. Bản ghi chưa có dòng nào thì không có mặt trong Map. */
export async function getCustomValues(objectKey: string, recordIds: string[], viewer: Viewer): Promise<Map<string, CustomValues>> {
  const obj = await requireObject(objectKey, "customFields");
  const out = new Map<string, CustomValues>();
  if (!canViewObjectValues(viewer, obj)) return out;
  const defs = await loadCustomDefs(objectKey, false);
  const visible = new Set(defs.filter((d) => canViewField(viewer, obj, d)).map((d) => d.key));
  const ids = [...new Set(recordIds.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 200))];
  if (ids.length === 0) return out;
  const db = await getDb();
  const t = schema.customValues;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ recordId: t.recordId, values: t.values })
      .from(t)
      .where(and(eq(t.objectKey, objectKey), inArray(t.recordId, ids.slice(i, i + 500))));
    for (const r of rows) out.set(r.recordId, visibleOnly(r.values, visible));
  }
  return out;
}

// ─────────────────────────── Ghi ───────────────────────────

export type SaveValuesResult = { ok: true; values: CustomValues; version: number; changed: string[] } | MetaFailure;

async function checkReferences(obj: ObjectDef, recordId: string, defs: CustomFieldDef[], input: CustomValues, merged: CustomValues): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const db = await getDb();
  for (const key of Object.keys(input)) {
    const def = defs.find((d) => d.key === key);
    const value = merged[key];
    if (!def || value === undefined) continue;
    if (def.type === "user") {
      const found = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, String(value))).limit(1);
      if (found.length === 0) errors.push({ field: key, message: `${def.label}: tài khoản không tồn tại trong tổ chức này.` });
    } else if (def.type === "relation") {
      const target = def.relationObject ? objectDef(def.relationObject) : null;
      if (!target || !(await recordExists(target, String(value)))) errors.push({ field: key, message: `${def.label}: bản ghi liên kết không tồn tại.` });
    } else if (def.type === "file") {
      const t = schema.customFiles;
      const found = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.id, String(value)), eq(t.objectKey, obj.key), eq(t.recordId, recordId), eq(t.fieldKey, key)))
        .limit(1);
      if (found.length === 0) errors.push({ field: key, message: `${def.label}: tệp không tồn tại cho bản ghi này.` });
    }
  }
  return errors;
}

/**
 * Lưu giá trị custom của MỘT bản ghi. `input` chỉ gồm các khoá muốn đổi (khoá không gửi giữ nguyên);
 * rỗng / `null` ⇒ xoá khoá. `opts.formKey`: lượt ghi đi qua một form ⇒ chỉ nhận field HIỆN và KHÔNG chỉ
 * đọc trong bản ĐÃ XUẤT BẢN của form đó ("field ẩn không nhận ghi").
 */
export async function saveCustomValues(objectKey: string, recordId: string, input: CustomValues, viewer: Viewer, opts: { formKey?: string } = {}): Promise<SaveValuesResult> {
  const checked = await checkObject(objectKey, "customFields");
  if (!checked.ok) return checked;
  const obj = checked.def;
  if (!can(viewer, perms(obj).edit as Permission)) return fail("FORBIDDEN", `Bạn không có quyền sửa dữ liệu bổ sung của ${obj.label}.`);
  if (!(await recordExists(obj, recordId))) return fail("NOT_FOUND", `Bản ghi không tồn tại (${obj.label} "${String(recordId).slice(0, 80)}").`, "record");

  const defs = await loadCustomDefs(objectKey, true);
  const inputKeys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  const denied: FieldError[] = [];
  for (const key of inputKeys) {
    const def = defs.find((d) => d.key === key && d.status === "ACTIVE");
    if (def && !canEditField(viewer, obj, def)) denied.push({ field: key, message: `Bạn không có quyền sửa "${def.label}".` });
  }
  if (denied.length > 0) return fail("FORBIDDEN", denied);
  if (opts.formKey) {
    const form = await getPublishedForm(objectKey, opts.formKey);
    const writable = writableCustomKeys(form.schema);
    const hidden = inputKeys.filter((k) => !writable.has(k) && defs.some((d) => d.key === k && d.status === "ACTIVE"));
    if (hidden.length > 0) return fail("FORBIDDEN", hidden.map((k) => ({ field: k, message: `Field "${k}" không nhận ghi qua form này (ẩn hoặc chỉ đọc).` })));
  }

  const db = await getDb();
  const t = schema.customValues;
  const [prevRow] = await db
    .select({ values: t.values, version: t.version })
    .from(t)
    .where(and(eq(t.objectKey, objectKey), eq(t.recordId, recordId)))
    .limit(1);
  const previous = prevRow?.values ?? null;

  // Field người này không sửa được thì không bắt họ điền: bắt buộc chỉ áp cho field họ sửa được.
  const effective = defs.map((d) => (d.required && d.status === "ACTIVE" && !canEditField(viewer, obj, d) ? { ...d, required: false } : d));
  const { values: merged, errors } = validateCustomValues(effective, input, previous);
  if (errors.length > 0) return fail("INVALID", errors);
  const refErrors = await checkReferences(obj, recordId, defs, input, merged);
  if (refErrors.length > 0) return fail("INVALID", refErrors);

  const before = previous ?? {};
  const changed = [...new Set([...Object.keys(before), ...Object.keys(merged)])].filter((k) => !sameValue(before[k], merged[k])).sort();
  const visible = new Set(defs.filter((d) => d.status === "ACTIVE" && canViewField(viewer, obj, d)).map((d) => d.key));
  if (changed.length === 0) return { ok: true, values: visibleOnly(merged, visible), version: prevRow?.version ?? 0, changed: [] };

  let version: number;
  if (prevRow) {
    const updated = await db
      .update(t)
      .set({ values: merged, version: prevRow.version + 1, updatedBy: viewer.id, updatedAt: new Date() })
      .where(and(eq(t.objectKey, objectKey), eq(t.recordId, recordId), eq(t.version, prevRow.version)))
      .returning({ version: t.version });
    if (updated.length === 0) return fail("CONFLICT", "Dữ liệu vừa được người khác sửa — tải lại rồi lưu lại.");
    version = updated[0].version;
  } else {
    const inserted = await db.insert(t).values({ objectKey, recordId, values: merged, version: 1, updatedBy: viewer.id }).onConflictDoNothing().returning({ version: t.version });
    if (inserted.length === 0) return fail("CONFLICT", "Dữ liệu vừa được người khác sửa — tải lại rồi lưu lại.");
    version = inserted[0].version;
  }
  const pick = (src: CustomValues) => Object.fromEntries(changed.map((k) => [k, src[k] ?? null]));
  await audit({
    ...auditActor({ id: viewer.id, email: viewer.email }),
    action: "CUSTOM_VALUES_SAVE",
    entity: "CUSTOM_VALUES",
    entityId: `${objectKey}:${recordId}`,
    before: pick(before),
    after: pick(merged),
    detail: { objectKey, recordId, version, ...(opts.formKey ? { formKey: opts.formKey } : {}) },
  });
  return { ok: true, values: visibleOnly(merged, visible), version, changed };
}

// ─────────────────────────── Lọc danh sách ───────────────────────────

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Điều kiện SQL lọc bản ghi theo field custom — ghép vào `where` của truy vấn danh sách trên BẢNG THẬT của
 * đối tượng (cột id lấy từ sổ). Chỉ xét ref `custom:`; ref `system:` là việc của truy vấn gốc. Mọi giá trị
 * đi qua tham số (không nội suy chuỗi người dùng); khoá field kiểm theo mẫu khoá. Bộ lọc sai hình ⇒ NÉM
 * (`INVALID`) — một bộ lọc hỏng mà vẫn chạy thì danh sách rỗng và người đọc tưởng "không có bản ghi".
 *
 * Nghĩa của phép: `eq` trên field chọn-nhiều = "có chứa giá trị"; `neq` / `empty` GỒM cả bản ghi chưa có
 * dòng giá trị nào (chưa biết ≠ bằng); `gte`/`lte` với số so theo số, với chuỗi (ngày ISO) so theo chuỗi.
 */
export function customValuesFilterSql(objectKey: string, filters: ListFilter[]): SQL | undefined {
  const def = objectDef(objectKey);
  if (!def) throw new MetadataError("OBJECT_UNKNOWN", `Đối tượng "${objectKey}" không có trong sổ đối tượng.`);
  const idCol = idColumnOf(def);
  const parts: SQL[] = [];
  const exists = (cond: SQL) =>
    sql`exists (select 1 from ${schema.customValues} cv where cv.object_key = ${objectKey} and cv.record_id = ${idCol}::text and ${cond})`;
  const has = (key: string, v: unknown): SQL => {
    const scalar = sql`cv.values @> jsonb_build_object(${key}::text, ${JSON.stringify(v)}::jsonb)`;
    return typeof v === "string" ? sql`(${scalar} or cv.values @> jsonb_build_object(${key}::text, jsonb_build_array(${v}::text)))` : scalar;
  };
  for (const f of filters ?? []) {
    if (!f || typeof f.ref !== "string" || !f.ref.startsWith("custom:")) continue;
    const key = f.ref.slice("custom:".length);
    if (!FIELD_KEY_PATTERN.test(key)) throw new MetadataError("INVALID", `Bộ lọc trỏ khoá field không hợp lệ: "${f.ref}".`);
    if (!filterShapeOk(f)) throw new MetadataError("INVALID", `Bộ lọc "${f.op}" trên "${f.ref}" thiếu hoặc sai giá trị.`);
    const present = sql`(cv.values -> ${key}::text) is not null`;
    switch (f.op) {
      case "eq":
        parts.push(exists(has(key, f.value)));
        break;
      case "neq":
        parts.push(sql`not ${exists(has(key, f.value))}`);
        break;
      case "in": {
        const items = (f.value as unknown[]).map((v) => has(key, v));
        parts.push(exists(sql`(${sql.join(items, sql` or `)})`));
        break;
      }
      case "contains":
        parts.push(exists(sql`(cv.values ->> ${key}::text) ilike ${`%${escapeLike(String(f.value))}%`}`));
        break;
      case "gte":
      case "lte": {
        const op = f.op === "gte" ? sql`>=` : sql`<=`;
        parts.push(
          typeof f.value === "number"
            ? exists(sql`(case when jsonb_typeof(cv.values -> ${key}::text) = 'number' then (cv.values ->> ${key}::text)::numeric end) ${op} ${f.value}::numeric`)
            : exists(sql`(case when jsonb_typeof(cv.values -> ${key}::text) = 'string' then cv.values ->> ${key}::text end) ${op} ${String(f.value)}::text`),
        );
        break;
      }
      case "empty":
        parts.push(sql`not ${exists(present)}`);
        break;
      case "not_empty":
        parts.push(exists(present));
        break;
    }
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` and `)})`;
}

// ─────────────────────────── Tệp ───────────────────────────

export type CustomFileInput = { filename: string; mime: string; data: Buffer };
export type SaveFileResult = { ok: true; file: { id: string; filename: string; mime: string; size: number }; values: CustomValues; version: number } | MetaFailure;

function cleanFilename(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || "tep";
}

/** Tải một tệp lên field kiểu `file` rồi gán id tệp vào giá trị field (qua ĐÚNG đường ghi giá trị). */
export async function saveCustomFile(objectKey: string, recordId: string, fieldKey: string, file: CustomFileInput, viewer: Viewer): Promise<SaveFileResult> {
  const checked = await checkObject(objectKey, "customFields");
  if (!checked.ok) return checked;
  const obj = checked.def;
  if (!(await recordExists(obj, recordId))) return fail("NOT_FOUND", `Bản ghi không tồn tại (${obj.label}).`, "record");
  const def = (await loadCustomDefs(objectKey, false)).find((d) => d.key === fieldKey);
  if (!def || def.type !== "file") return fail("NOT_FOUND", `Field tệp "${fieldKey}" không tồn tại.`, fieldKey);
  if (!canEditField(viewer, obj, def)) return fail("FORBIDDEN", `Bạn không có quyền sửa "${def.label}".`, fieldKey);
  const data = file?.data;
  if (!Buffer.isBuffer(data) || data.length === 0) return fail("INVALID", "Tệp rỗng.", fieldKey);
  if (data.length > CUSTOM_FILE_MAX_BYTES) return fail("INVALID", `Tệp vượt ${CUSTOM_FILE_MAX_BYTES / 1024 / 1024} MB.`, fieldKey);
  const mime = /^[\w.+-]{1,60}\/[\w.+-]{1,60}$/.test(String(file.mime ?? "")) ? String(file.mime) : "application/octet-stream";
  const filename = cleanFilename(file.filename);

  const db = await getDb();
  const [row] = await db
    .insert(schema.customFiles)
    .values({ objectKey, recordId, fieldKey, filename, mime, size: data.length, data, createdBy: viewer.id })
    .returning({ id: schema.customFiles.id });
  const saved = await saveCustomValues(objectKey, recordId, { [fieldKey]: row.id }, viewer);
  if (!saved.ok) {
    await db.delete(schema.customFiles).where(eq(schema.customFiles.id, row.id));
    return saved;
  }
  await audit({
    ...auditActor({ id: viewer.id, email: viewer.email }),
    action: "CUSTOM_FILE_UPLOAD",
    entity: "CUSTOM_FILE",
    entityId: row.id,
    after: { objectKey, recordId, fieldKey, filename, mime, size: data.length },
  });
  return { ok: true, file: { id: row.id, filename, mime, size: data.length }, values: saved.values, version: saved.version };
}

/** Đọc một tệp — `null` khi không tồn tại TRONG CSDL TỔ CHỨC NÀY, bản ghi đã mất, field đã lưu trữ hoặc người xem không có quyền. */
export async function readCustomFile(id: string, viewer: Viewer): Promise<{ filename: string; mime: string; size: number; data: Buffer } | null> {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  const db = await getDb();
  const t = schema.customFiles;
  const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  if (!row) return null;
  const checked = await checkObject(row.objectKey, "customFields");
  if (!checked.ok) return null;
  const def = (await loadCustomDefs(row.objectKey, false)).find((d) => d.key === row.fieldKey);
  if (!def || !canViewField(viewer, checked.def, def)) return null;
  if (!(await recordExists(checked.def, row.recordId))) return null;
  return { filename: row.filename, mime: row.mime, size: row.size, data: row.data };
}

// ─────────────────────────── Xuất CSV ───────────────────────────

/**
 * Cột theo field ACTIVE người xem được (thứ tự `position`), chữ đã dịch nhãn. Ô trống = CHƯA BIẾT.
 * Lệch hợp đồng có chủ đích: nhận thêm `viewer` — xuất mà không lọc `viewPermission` là lối vòng qua quyền xem.
 */
export async function exportCustomValues(
  objectKey: string,
  recordIds: string[],
  viewer: Viewer,
): Promise<{ columns: { key: string; label: string }[]; rows: Map<string, Record<string, string>> }> {
  const obj = await requireObject(objectKey, "customFields");
  const defs = (await loadCustomDefs(objectKey, false)).filter((d) => canViewField(viewer, obj, d));
  const values = await getCustomValues(objectKey, recordIds, viewer);
  const rows = new Map<string, Record<string, string>>();
  const live = await existingRecordIds(obj, recordIds);
  for (const id of recordIds) {
    if (!live.has(id)) continue;
    const v = values.get(id) ?? {};
    rows.set(id, Object.fromEntries(defs.map((d) => [d.key, customValueText(d, v[d.key])])));
  }
  return { columns: defs.map((d) => ({ key: d.key, label: d.label })), rows };
}

/**
 * Phần dùng chung của lớp dịch vụ metadata — CHỈ MÁY CHỦ (đọc CSDL qua `getDb()`).
 *
 * `getDb()` tự chọn CSDL của tổ chức theo ngữ cảnh (silo): không hàm nào ở đây thêm cột hay điều kiện tổ
 * chức vào truy vấn, và không hàm nào đệm kết quả trong tiến trình (M13) — định nghĩa field đọc thẳng
 * mỗi lần, nên xuất bản / thêm field có hiệu lực ở lần tải kế tiếp của MỌI tiến trình.
 */
import { and, asc, eq, getTableColumns, is, sql } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { objectDef, type ObjectCapabilities, type ObjectDef } from "@/lib/constants/object-registry";
import { canUseModule } from "@/lib/platform/capabilities";
import { fail, MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { FIELD_TYPES, type CustomFieldDef, type FieldOption, type FieldType, type FieldValidation, type MetadataActor } from "@/lib/metadata/types";

type Capability = Exclude<keyof ObjectCapabilities, "create">;

const CAPABILITY_LABEL: Record<Capability, string> = {
  customFields: "field custom",
  forms: "form",
  lists: "danh sách cấu hình được",
  statuses: "trạng thái cấu hình được",
};

/** Kiểm đối tượng + năng lực + module. Lượt ĐỌC: ném `MetadataError`. */
export async function requireObject(objectKey: string, capability?: Capability): Promise<ObjectDef> {
  const def = objectDef(objectKey);
  if (!def) throw new MetadataError("OBJECT_UNKNOWN", `Đối tượng "${objectKey}" không có trong sổ đối tượng.`);
  if (capability && (!def.capabilities[capability] || (capability === "customFields" && !def.customizable))) {
    throw new MetadataError("NOT_SUPPORTED", `${def.label} chưa hỗ trợ ${CAPABILITY_LABEL[capability]}.`);
  }
  if (!(await canUseModule(def.module))) throw new MetadataError("MODULE_DISABLED", `Module "${def.module}" của ${def.label} chưa được bật cho tổ chức này.`);
  return def;
}

/** Như `requireObject` nhưng cho lượt GHI: trả `MetaFailure` thay vì ném. */
export async function checkObject(objectKey: string, capability?: Capability): Promise<{ ok: true; def: ObjectDef } | MetaFailure> {
  try {
    return { ok: true, def: await requireObject(objectKey, capability) };
  } catch (error) {
    if (error instanceof MetadataError) return fail(error.code, error.message, "object");
    throw error;
  }
}

function asOptions(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null && typeof (o as { value?: unknown }).value === "string")
    .map((o, i) => ({
      value: String(o.value),
      label: typeof o.label === "string" ? o.label : String(o.value),
      ...(typeof o.color === "string" ? { color: o.color } : {}),
      active: o.active !== false,
      position: typeof o.position === "number" ? o.position : i,
    }))
    .sort((a, b) => a.position - b.position);
}

function asRecord<T>(raw: unknown): T {
  return (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as T;
}

type FieldRow = typeof schema.metaCustomFields.$inferSelect;

export function toFieldDef(row: FieldRow): CustomFieldDef {
  return {
    id: row.id,
    objectKey: row.objectKey,
    key: row.fieldKey,
    label: row.label,
    type: (FIELD_TYPES as readonly string[]).includes(row.fieldType) ? (row.fieldType as FieldType) : "text",
    required: row.required,
    defaultValue: row.defaultValue ?? null,
    options: asOptions(row.options),
    validation: asRecord<FieldValidation>(row.validation),
    transitions: asRecord<Record<string, string[]>>(row.transitions),
    relationObject: row.relationObject ?? null,
    helpText: row.helpText ?? null,
    viewPermission: row.viewPermission ?? null,
    editPermission: row.editPermission ?? null,
    listable: row.listable,
    filterable: row.filterable,
    position: row.position,
    status: row.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
  };
}

/** Định nghĩa field custom của một đối tượng trong CSDL tổ chức hiện hành — KHÔNG kiểm module (nơi gọi đã kiểm). */
export async function loadCustomDefs(objectKey: string, includeArchived: boolean): Promise<CustomFieldDef[]> {
  const db = await getDb();
  const t = schema.metaCustomFields;
  const rows = await db
    .select()
    .from(t)
    .where(includeArchived ? eq(t.objectKey, objectKey) : and(eq(t.objectKey, objectKey), eq(t.status, "ACTIVE")))
    .orderBy(asc(t.position), asc(t.fieldKey));
  return rows.map(toFieldDef);
}

/** Cột id của bảng thật của đối tượng (drizzle), dẫn xuất từ sổ. */
export function idColumnOf(def: ObjectDef): PgColumn {
  const table = (schema as unknown as Record<string, unknown>)[def.table];
  if (!is(table, PgTable)) throw new MetadataError("OBJECT_UNKNOWN", `Sổ đối tượng trỏ bảng "${def.table}" không có trong lược đồ.`);
  const col = getTableColumns(table)[def.idColumn];
  if (!col) throw new MetadataError("OBJECT_UNKNOWN", `Bảng "${def.table}" không có cột "${def.idColumn}".`);
  return col;
}

/**
 * Bản ghi có tồn tại trong BẢNG THẬT của đối tượng, trong CSDL CỦA TỔ CHỨC HIỆN HÀNH không.
 *
 * Đây là hàng rào chống tấn công theo id chéo tổ chức: phiên của B gửi id khách của A thì `getDb()` là
 * CSDL của B, nơi không có dòng nào mang id đó ⇒ `false` ⇒ không ghi gì.
 */
export async function recordExists(def: ObjectDef, recordId: string): Promise<boolean> {
  if (typeof recordId !== "string" || recordId.length === 0 || recordId.length > 200) return false;
  const table = (schema as unknown as Record<string, unknown>)[def.table] as PgTable;
  const col = idColumnOf(def);
  const db = await getDb();
  const rows = await db.select({ one: sql<number>`1` }).from(table).where(eq(col, recordId)).limit(1);
  return rows.length > 0;
}

/** Tập id (trong `ids`) có thật trong bảng của đối tượng. */
export async function existingRecordIds(def: ObjectDef, ids: readonly string[]): Promise<Set<string>> {
  const clean = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 200))];
  if (clean.length === 0) return new Set();
  const table = (schema as unknown as Record<string, unknown>)[def.table] as PgTable;
  const col = idColumnOf(def);
  const db = await getDb();
  const out = new Set<string>();
  for (let i = 0; i < clean.length; i += 500) {
    const chunk = clean.slice(i, i + 500);
    const rows = await db
      .select({ id: sql<string>`${col}::text` })
      .from(table)
      .where(sql`${col} in (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)})`);
    for (const r of rows) out.add(String(r.id));
  }
  return out;
}

/** Tham số `audit()` chung: khoá tài khoản + ảnh chụp email (luật 34 — `id: null` = máy làm). */
export function auditActor(actor: MetadataActor): { userId: string | null; userEmail: string } {
  return { userId: actor.id, userEmail: actor.email };
}

export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "23505";
}

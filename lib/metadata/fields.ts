/**
 * ═══════════ ĐỊNH NGHĨA FIELD CUSTOM (M4, M5, M11, M12) — CHỈ MÁY CHỦ ═══════════
 *
 * Một cửa duy nhất ghi `meta_custom_fields`. Mỗi lượt ghi ⇒ `audit()` entity `META_FIELD` kèm TRƯỚC/SAU.
 *
 * Luật không thương lượng:
 *  · khoá `^[a-z][a-z0-9_]{1,40}$`, không trùng field hệ thống, không trùng field ĐÃ CÓ — kể cả field đã
 *    ARCHIVED (giá trị của nó vẫn nằm trong `custom_values`; dùng lại khoá là gán dữ liệu cũ cho nghĩa mới);
 *  · KHÔNG đổi khoá / kiểu / đối tượng liên kết khi đã có bản ghi mang giá trị (đếm thật trong `custom_values`);
 *  · KHÔNG xoá tuỳ chọn đã khai — chỉ tắt (`active: false`): xoá là biến giá trị đang lưu thành rác không ai đọc được;
 *  · không xoá field — `archiveCustomField` (giá trị giữ nguyên, không hiện, không nhận ghi).
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { isObjectKey, type ObjectDef } from "@/lib/constants/object-registry";
import { auditActor, checkObject, isUniqueViolation, loadCustomDefs, requireObject, toFieldDef } from "@/lib/metadata/common";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import { FIELD_KEY_PATTERN, FIELD_TYPES, FIELD_TYPE_LABEL, type CustomFieldDef, type FieldError, type FieldOption, type FieldType, type MetadataActor, type SystemFieldDef } from "@/lib/metadata/types";
import { coerceFieldValue, compilePattern, TEXTAREA_MAX_LENGTH } from "@/lib/metadata/validate";

export type FieldResult = { ok: true; field: CustomFieldDef } | MetaFailure;

const OPTION_TYPES: readonly FieldType[] = ["select", "multi_select", "status"];
const STRING_TYPES: readonly FieldType[] = ["text", "textarea", "email", "phone", "url"];
const NUMBER_TYPES: readonly FieldType[] = ["number", "currency"];
const REFERENCE_TYPES: readonly FieldType[] = ["user", "relation", "file"];

const optionZ = z.object({
  value: z.string().trim().min(1, "giá trị tuỳ chọn không được rỗng").max(100),
  label: z.string().trim().min(1, "nhãn tuỳ chọn không được rỗng").max(100),
  color: z.string().max(30).optional(),
  active: z.boolean().optional(),
  position: z.number().int().optional(),
});

const validationZ = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    minLength: z.number().int().min(0).max(TEXTAREA_MAX_LENGTH).optional(),
    maxLength: z.number().int().min(1).max(TEXTAREA_MAX_LENGTH).optional(),
    pattern: z.string().max(200, "mẫu kiểm tối đa 200 ký tự").optional(),
    patternMessage: z.string().max(200).optional(),
  })
  .strict();

const baseShape = {
  label: z.string().trim().min(1, "field phải có nhãn").max(100),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  options: z.array(optionZ).max(200).optional(),
  validation: validationZ.optional(),
  transitions: z.record(z.string(), z.array(z.string()).max(200)).optional(),
  relationObject: z.string().nullable().optional(),
  helpText: z.string().max(500).nullable().optional(),
  viewPermission: z.string().nullable().optional(),
  editPermission: z.string().nullable().optional(),
  listable: z.boolean().optional(),
  filterable: z.boolean().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
};

const createZ = z.object({ key: z.string(), type: z.string(), ...baseShape }).strict();
const patchZ = z.object({ key: z.string().optional(), type: z.string().optional(), ...baseShape, label: baseShape.label.optional() }).strict();

export type CustomFieldInput = z.input<typeof createZ>;
export type CustomFieldPatch = z.input<typeof patchZ>;

/** Lỗi zod ⇒ `FieldError`. Thông báo tự viết (tiếng Việt) được giữ; thông báo mặc định của zod thay bằng câu chung. */
export function zodFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => {
    const field = i.path.map(String).join(".") || "_";
    const vietnamese = /[À-ỹ]/.test(i.message);
    return { field, message: vietnamese ? i.message : i.code === "unrecognized_keys" ? `Trường không được hỗ trợ: ${field === "_" ? i.message : field}.` : `Giá trị "${field}" không hợp lệ.` };
  });
}

function normalizeOptions(raw: z.output<typeof optionZ>[] | undefined): FieldOption[] {
  return (raw ?? []).map((o, i) => ({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), active: o.active !== false, position: o.position ?? i }));
}

/** Kiểm một định nghĩa đầy đủ (sau khi gộp bản vá). `takenKeys`: khoá đã có của đối tượng (trừ chính nó). */
function checkDefinition(obj: ObjectDef, def: CustomFieldDef, takenKeys: Set<string>): FieldError[] {
  const errors: FieldError[] = [];
  if (!FIELD_KEY_PATTERN.test(def.key)) errors.push({ field: "key", message: "Khoá chỉ gồm chữ thường không dấu, số, gạch dưới; bắt đầu bằng chữ; 2–41 ký tự." });
  else if (obj.fields.some((f: SystemFieldDef) => f.key === def.key)) errors.push({ field: "key", message: `Khoá "${def.key}" trùng field hệ thống của ${obj.label}.` });
  else if (takenKeys.has(def.key)) errors.push({ field: "key", message: `Khoá "${def.key}" đã có (kể cả field đã lưu trữ) — khoá không dùng lại được.` });

  if (!(FIELD_TYPES as readonly string[]).includes(def.type)) {
    errors.push({ field: "type", message: `Kiểu "${def.type}" không hỗ trợ.` });
    return errors;
  }
  const typeLabel = FIELD_TYPE_LABEL[def.type];

  if (OPTION_TYPES.includes(def.type)) {
    if (def.options.length === 0) errors.push({ field: "options", message: `Kiểu "${typeLabel}" cần ít nhất một tuỳ chọn.` });
    const seen = new Set<string>();
    for (const o of def.options) {
      if (seen.has(o.value)) errors.push({ field: "options", message: `Giá trị tuỳ chọn "${o.value}" bị trùng.` });
      seen.add(o.value);
    }
    if (def.options.length > 0 && !def.options.some((o) => o.active)) errors.push({ field: "options", message: "Phải còn ít nhất một tuỳ chọn đang dùng." });
  } else if (def.options.length > 0) errors.push({ field: "options", message: `Kiểu "${typeLabel}" không có tuỳ chọn.` });

  const transitionKeys = Object.keys(def.transitions);
  if (def.type === "status") {
    const values = new Set(def.options.map((o) => o.value));
    for (const from of transitionKeys) {
      if (!values.has(from)) errors.push({ field: "transitions", message: `Chuyển trạng thái từ "${from}" — giá trị không có trong tuỳ chọn.` });
      for (const to of def.transitions[from] ?? []) if (!values.has(to)) errors.push({ field: "transitions", message: `Chuyển trạng thái tới "${to}" — giá trị không có trong tuỳ chọn.` });
    }
  } else if (transitionKeys.length > 0) errors.push({ field: "transitions", message: "Chỉ field trạng thái nghiệp vụ mới có chuyển trạng thái." });

  if (def.type === "relation") {
    if (!def.relationObject || !isObjectKey(def.relationObject)) errors.push({ field: "relationObject", message: "Field liên kết phải trỏ một đối tượng có trong sổ." });
  } else if (def.relationObject) errors.push({ field: "relationObject", message: "Chỉ field liên kết mới có đối tượng liên kết." });

  for (const k of ["viewPermission", "editPermission"] as const) {
    const p = def[k];
    if (p !== null && !(ALL_PERMISSIONS as readonly string[]).includes(p)) errors.push({ field: k, message: `Khoá quyền "${p}" không tồn tại.` });
  }

  const v = def.validation;
  if ((v.min !== undefined || v.max !== undefined) && !NUMBER_TYPES.includes(def.type)) errors.push({ field: "validation", message: "min / max chỉ áp cho kiểu số và tiền." });
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) errors.push({ field: "validation", message: "min phải ≤ max." });
  if (def.type === "currency" && ((v.min !== undefined && !Number.isInteger(v.min)) || (v.max !== undefined && !Number.isInteger(v.max)))) errors.push({ field: "validation", message: "Giới hạn của tiền phải là số nguyên VND." });
  if ((v.minLength !== undefined || v.maxLength !== undefined || v.pattern !== undefined) && !STRING_TYPES.includes(def.type)) errors.push({ field: "validation", message: "Độ dài / mẫu kiểm chỉ áp cho kiểu chữ." });
  if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) errors.push({ field: "validation", message: "Độ dài tối thiểu phải ≤ tối đa." });
  if (v.pattern !== undefined && v.pattern !== "") {
    const c = compilePattern(v.pattern);
    if (!c.ok) errors.push({ field: "validation.pattern", message: `Mẫu kiểm: ${c.message}.` });
  }
  return errors;
}

/** Giá trị mặc định: chuẩn hoá bằng CHÍNH bộ kiểm giá trị; kiểu tham chiếu không có mặc định (không chứng minh được id tồn tại ở mọi lúc). */
function checkDefault(def: CustomFieldDef): { value: unknown } | { error: FieldError } {
  const dv = def.defaultValue;
  if (dv === undefined || dv === null || (typeof dv === "string" && dv.trim() === "")) return { value: null };
  if (REFERENCE_TYPES.includes(def.type)) return { error: { field: "defaultValue", message: `Kiểu "${FIELD_TYPE_LABEL[def.type]}" không có giá trị mặc định.` } };
  const r = coerceFieldValue({ ...def, status: "ACTIVE" }, dv, undefined);
  if ("error" in r) return { error: { field: "defaultValue", message: `Giá trị mặc định: ${r.error}` } };
  return { value: r.value ?? null };
}

/** Số bản ghi đang mang giá trị của field (đếm THẬT trong `custom_values`). */
export async function countFieldValues(objectKey: string, fieldKey: string): Promise<number> {
  const db = await getDb();
  const t = schema.customValues;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.objectKey, objectKey), sql`(${t.values} -> ${fieldKey}) is not null`));
  return Number(row?.n ?? 0);
}

function rowValues(def: CustomFieldDef) {
  return {
    objectKey: def.objectKey,
    fieldKey: def.key,
    label: def.label,
    fieldType: def.type,
    required: def.required,
    defaultValue: def.defaultValue ?? null,
    options: def.options,
    validation: def.validation,
    transitions: def.transitions,
    relationObject: def.relationObject,
    helpText: def.helpText,
    viewPermission: def.viewPermission,
    editPermission: def.editPermission,
    listable: def.listable,
    filterable: def.filterable,
    position: def.position,
  };
}

// ─────────────────────────── API ───────────────────────────

export async function listFields(objectKey: string, opts: { includeArchived?: boolean } = {}): Promise<{ system: SystemFieldDef[]; custom: CustomFieldDef[] }> {
  const def = await requireObject(objectKey);
  const custom = def.capabilities.customFields && def.customizable ? await loadCustomDefs(objectKey, opts.includeArchived === true) : [];
  return { system: [...def.fields], custom };
}

export async function createCustomField(objectKey: string, input: unknown, actor: MetadataActor): Promise<FieldResult> {
  const obj = await checkObject(objectKey, "customFields");
  if (!obj.ok) return obj;
  const parsed = createZ.safeParse(input);
  if (!parsed.success) return fail("INVALID", zodFieldErrors(parsed.error));
  const p = parsed.data;
  const existing = await loadCustomDefs(objectKey, true);
  const candidate: CustomFieldDef = {
    id: "",
    objectKey,
    key: p.key.trim(),
    label: p.label,
    type: p.type as FieldType,
    required: p.required === true,
    defaultValue: p.defaultValue ?? null,
    options: normalizeOptions(p.options),
    validation: p.validation ?? {},
    transitions: p.transitions ?? {},
    relationObject: p.relationObject ?? null,
    helpText: p.helpText?.trim() || null,
    viewPermission: p.viewPermission || null,
    editPermission: p.editPermission || null,
    listable: p.listable !== false,
    filterable: p.filterable === true,
    position: p.position ?? existing.reduce((m, d) => Math.max(m, d.position + 1), 0),
    status: "ACTIVE",
  };
  const errors = checkDefinition(obj.def, candidate, new Set(existing.map((d) => d.key)));
  if (errors.length === 0) {
    const dv = checkDefault(candidate);
    if ("error" in dv) errors.push(dv.error);
    else candidate.defaultValue = dv.value;
  }
  if (errors.length > 0) return fail("INVALID", errors);

  const db = await getDb();
  let row: typeof schema.metaCustomFields.$inferSelect;
  try {
    [row] = await db
      .insert(schema.metaCustomFields)
      .values({ ...rowValues(candidate), status: "ACTIVE", createdBy: actor.id })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) return fail("CONFLICT", `Khoá "${candidate.key}" vừa được tạo bởi người khác.`, "key");
    throw error;
  }
  const field = toFieldDef(row);
  await audit({ ...auditActor(actor), action: "META_FIELD_CREATE", entity: "META_FIELD", entityId: `${objectKey}.${field.key}`, before: null, after: field });
  return { ok: true, field };
}

export async function updateCustomField(objectKey: string, key: string, patch: unknown, actor: MetadataActor): Promise<FieldResult> {
  const obj = await checkObject(objectKey, "customFields");
  if (!obj.ok) return obj;
  const parsed = patchZ.safeParse(patch);
  if (!parsed.success) return fail("INVALID", zodFieldErrors(parsed.error));
  const p = parsed.data;
  const all = await loadCustomDefs(objectKey, true);
  const current = all.find((d) => d.key === key);
  if (!current) return fail("NOT_FOUND", `Field "${key}" không tồn tại trong ${obj.def.label}.`, "key");
  if (current.status === "ARCHIVED") return fail("INVALID", `Field "${current.label}" đã lưu trữ — không sửa được.`, "key");

  const next: CustomFieldDef = {
    ...current,
    ...(p.key !== undefined ? { key: p.key.trim() } : {}),
    ...(p.type !== undefined ? { type: p.type as FieldType } : {}),
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.required !== undefined ? { required: p.required } : {}),
    ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
    ...(p.options !== undefined ? { options: normalizeOptions(p.options) } : {}),
    ...(p.validation !== undefined ? { validation: p.validation } : {}),
    ...(p.transitions !== undefined ? { transitions: p.transitions } : {}),
    ...(p.relationObject !== undefined ? { relationObject: p.relationObject } : {}),
    ...(p.helpText !== undefined ? { helpText: p.helpText?.trim() || null } : {}),
    ...(p.viewPermission !== undefined ? { viewPermission: p.viewPermission || null } : {}),
    ...(p.editPermission !== undefined ? { editPermission: p.editPermission || null } : {}),
    ...(p.listable !== undefined ? { listable: p.listable } : {}),
    ...(p.filterable !== undefined ? { filterable: p.filterable } : {}),
    ...(p.position !== undefined ? { position: p.position } : {}),
  };
  // Đổi kiểu mà không gửi lại tuỳ chọn: tuỳ chọn cũ không còn nghĩa với kiểu không có tuỳ chọn.
  if (next.type !== current.type && p.options === undefined && !OPTION_TYPES.includes(next.type)) next.options = [];
  if (next.type !== current.type && p.transitions === undefined && next.type !== "status") next.transitions = {};

  const errors: FieldError[] = [];
  const identityChanged = next.key !== current.key || next.type !== current.type || (next.relationObject ?? null) !== (current.relationObject ?? null);
  if (identityChanged) {
    const n = await countFieldValues(objectKey, current.key);
    if (n > 0) {
      const what = [next.key !== current.key ? "khoá" : null, next.type !== current.type ? "kiểu" : null, (next.relationObject ?? null) !== (current.relationObject ?? null) ? "đối tượng liên kết" : null].filter(Boolean).join(" / ");
      errors.push({ field: next.key !== current.key ? "key" : "type", message: `Không đổi được ${what} khi đã có ${n} bản ghi mang giá trị của field này.` });
    }
  }
  if (next.type === current.type && OPTION_TYPES.includes(current.type)) {
    const kept = new Set(next.options.map((o) => o.value));
    const removed = current.options.filter((o) => !kept.has(o.value)).map((o) => o.value);
    if (removed.length > 0) errors.push({ field: "options", message: `Không xoá được tuỳ chọn đã khai (${removed.join(", ")}) — tắt nó (ngừng dùng) thay vì xoá.` });
  }
  errors.push(...checkDefinition(obj.def, next, new Set(all.filter((d) => d.id !== current.id).map((d) => d.key))));
  if (errors.length === 0) {
    const dv = checkDefault(next);
    if ("error" in dv) errors.push(dv.error);
    else next.defaultValue = dv.value;
  }
  if (errors.length > 0) return fail("INVALID", errors);

  if (JSON.stringify(rowValues(next)) === JSON.stringify(rowValues(current))) return { ok: true, field: current };

  const db = await getDb();
  let row: typeof schema.metaCustomFields.$inferSelect | undefined;
  try {
    [row] = await db
      .update(schema.metaCustomFields)
      .set({ ...rowValues(next), updatedAt: new Date() })
      .where(and(eq(schema.metaCustomFields.id, current.id), eq(schema.metaCustomFields.status, "ACTIVE")))
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) return fail("CONFLICT", `Khoá "${next.key}" vừa được tạo bởi người khác.`, "key");
    throw error;
  }
  if (!row) return fail("CONFLICT", "Field vừa bị lưu trữ bởi người khác — tải lại.", "key");
  const field = toFieldDef(row);
  await audit({ ...auditActor(actor), action: "META_FIELD_UPDATE", entity: "META_FIELD", entityId: `${objectKey}.${field.key}`, before: current, after: field });
  return { ok: true, field };
}

export async function archiveCustomField(objectKey: string, key: string, actor: MetadataActor): Promise<FieldResult> {
  const obj = await checkObject(objectKey, "customFields");
  if (!obj.ok) return obj;
  const all = await loadCustomDefs(objectKey, true);
  const current = all.find((d) => d.key === key);
  if (!current) return fail("NOT_FOUND", `Field "${key}" không tồn tại trong ${obj.def.label}.`, "key");
  // Lưu trữ một field đã lưu trữ: không ghi gì, không thêm dòng nhật ký (cùng tinh thần luật 61).
  if (current.status === "ARCHIVED") return { ok: true, field: current };
  const db = await getDb();
  const [row] = await db
    .update(schema.metaCustomFields)
    .set({ status: "ARCHIVED", updatedAt: new Date() })
    .where(and(eq(schema.metaCustomFields.id, current.id), eq(schema.metaCustomFields.status, "ACTIVE")))
    .returning();
  if (!row) {
    const again = (await loadCustomDefs(objectKey, true)).find((d) => d.id === current.id);
    return again ? { ok: true, field: again } : fail("NOT_FOUND", `Field "${key}" không còn tồn tại.`, "key");
  }
  const field = toFieldDef(row);
  await audit({ ...auditActor(actor), action: "META_FIELD_ARCHIVE", entity: "META_FIELD", entityId: `${objectKey}.${field.key}`, before: current, after: field });
  return { ok: true, field };
}

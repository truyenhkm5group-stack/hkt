import { OBJECT_REGISTRY, type ObjectDef, type ObjectKey } from "@/lib/constants/object-registry";
import { moduleOn, type ModuleViewer } from "@/lib/platform-ui/module-visibility";
import {
  FIELD_KEY_PATTERN,
  type CustomFieldDef,
  type FieldError,
  type FieldOption,
  type FieldRef,
  type FieldType,
  type FieldValidation,
  type FormSchema,
  type ListFilterOp,
  type ListViewSchema,
  type SystemFieldDef,
} from "@/lib/metadata/types";

/**
 * ═══════════ GIAO DIỆN QUẢN TRỊ METADATA — PHẦN THUẦN, DÙNG CHUNG MÁY CHỦ + TRÌNH DUYỆT ═══════════
 *
 * Bốn màn hình `/settings/{data-model,forms,lists,statuses}` và lõi action
 * (`lib/platform-ui/metadata-admin.ts`) cùng đọc tệp này. Không đọc CSDL, không import gì chỉ-máy-chủ.
 *
 * Kiểm ở đây chỉ để UX (báo sớm, trước khi bấm lưu). Kiểm THẬT chạy ở máy chủ
 * (`validateCustomValues` + dịch vụ `lib/metadata/*`, hợp đồng M6) — lỗi máy chủ trả về được in
 * NGUYÊN VĂN theo từng field, giao diện không viết lại câu.
 */

/** Năng lực mà một màn hình quản trị cần ở đối tượng (khớp `ObjectCapabilities`). */
export type AdminCapability = "customFields" | "forms" | "lists" | "statuses";

export type AdminObjectOption = {
  key: ObjectKey;
  label: string;
  forms: ObjectDef["forms"];
  lists: ObjectDef["lists"];
  statusFields: string[];
};

/**
 * Đối tượng người xem được cấu hình ở một màn hình: chỉ đối tượng `customizable`, có năng lực đó, VÀ
 * module của nó đang bật với tổ chức người xem (`user.modules`). Module tắt ⇒ đối tượng biến mất khỏi ô
 * chọn — dịch vụ cũng từ chối nó (`MODULE_DISABLED`, M14), ẩn chỉ để không ai bấm vào một lỗi.
 */
export function adminObjects(viewer: ModuleViewer, capability: AdminCapability): AdminObjectOption[] {
  return OBJECT_REGISTRY.filter((o) => o.customizable && o.capabilities[capability] && moduleOn(viewer, o.module))
    .filter((o) => (capability === "forms" ? o.forms.length > 0 : capability === "lists" ? o.lists.length > 0 : capability === "statuses" ? o.statusFields.length > 0 : true))
    .map((o) => ({ key: o.key, label: o.label, forms: o.forms, lists: o.lists, statusFields: o.statusFields }));
}

// ═══════════ KHOÁ FIELD ═══════════

/** Bỏ dấu tiếng Việt (kể cả đ/Đ) — NFD rồi gỡ dấu kết hợp. */
export function stripVietnamese(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/**
 * Gợi ý khoá từ nhãn: bỏ dấu, chữ thường, ký tự lạ ⇒ `_`, không bắt đầu bằng số, tối đa 41 ký tự, không
 * trùng khoá đã có (thêm `_2`, `_3`…). Chỉ là GỢI Ý khi tạo — khoá bất biến (M4), người tạo vẫn sửa được
 * trước khi lưu.
 */
export function suggestFieldKey(label: string, taken: ReadonlySet<string> = new Set()): string {
  let base = stripVietnamese(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `f_${base}`.replace(/_+$/, "");
  if (base.length < 2) base = "truong_moi";
  base = base.slice(0, 41).replace(/_+$/, "");
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const tail = `_${i}`;
    const candidate = `${base.slice(0, 41 - tail.length).replace(/_+$/, "")}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

// ═══════════ ĐẦU VÀO FIELD CUSTOM ═══════════

/** Kiểu có danh sách tuỳ chọn. */
export const OPTION_TYPES: readonly FieldType[] = ["select", "multi_select", "status"];
/** Kiểu nhận min/max. */
export const NUMERIC_TYPES: readonly FieldType[] = ["number", "currency"];
/** Kiểu nhận độ dài + biểu thức chính quy. */
export const TEXTUAL_TYPES: readonly FieldType[] = ["text", "textarea", "email", "phone", "url"];
/** Kiểu không đặt được giá trị mặc định ở màn hình cấu hình (tham chiếu bản ghi / tệp). */
export const NO_DEFAULT_TYPES: readonly FieldType[] = ["user", "relation", "file"];

/** Đầu vào tạo field custom — cùng hình `CustomFieldDef` trừ phần máy chủ tự gán. */
export type CustomFieldInput = Pick<
  CustomFieldDef,
  "key" | "label" | "type" | "required" | "defaultValue" | "options" | "validation" | "transitions" | "relationObject" | "helpText" | "viewPermission" | "editPermission" | "listable" | "filterable"
>;
/** Sửa field: KHÔNG có `key` (bất biến, M4) và KHÔNG có `type` (đổi kiểu làm giá trị cũ sai nghĩa). */
export type CustomFieldPatch = Partial<Omit<CustomFieldInput, "key" | "type">> & { position?: number };

export type AdminWriteResult = { ok: true } | { ok: false; errors: FieldError[] };

/** Một field đã có ⇒ đầu vào của form sửa. */
export function fieldToInput(f: CustomFieldDef): CustomFieldInput {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    defaultValue: f.defaultValue ?? null,
    options: [...f.options].sort((a, b) => a.position - b.position),
    validation: { ...f.validation },
    transitions: { ...f.transitions },
    relationObject: f.relationObject,
    helpText: f.helpText,
    viewPermission: f.viewPermission,
    editPermission: f.editPermission,
    listable: f.listable,
    filterable: f.filterable,
  };
}

export function blankFieldInput(): CustomFieldInput {
  return { key: "", label: "", type: "text", required: false, defaultValue: null, options: [], validation: {}, transitions: {}, relationObject: null, helpText: null, viewPermission: null, editPermission: null, listable: true, filterable: false };
}

/**
 * Chuẩn hoá trước khi gửi: bỏ phần không thuộc kiểu (tuỳ chọn của field chữ, min/max của field chữ…),
 * đánh lại `position` theo thứ tự đang thấy, chuyển trạng thái chỉ giữ giá trị còn tồn tại.
 */
export function normalizeFieldInput(input: CustomFieldInput): CustomFieldInput {
  const hasOptions = OPTION_TYPES.includes(input.type);
  const options = hasOptions ? input.options.map((o, i) => ({ ...o, value: o.value.trim(), label: o.label.trim(), position: i, ...(o.color ? { color: o.color } : {}) })) : [];
  const values = new Set(options.map((o) => o.value));
  const transitions: Record<string, string[]> = {};
  if (input.type === "status") {
    for (const [from, tos] of Object.entries(input.transitions)) if (values.has(from)) transitions[from] = tos.filter((t) => values.has(t) && t !== from);
  }
  const v: FieldValidation = {};
  const src = input.validation;
  if (NUMERIC_TYPES.includes(input.type)) {
    if (isNum(src.min)) v.min = src.min;
    if (isNum(src.max)) v.max = src.max;
  }
  if (TEXTUAL_TYPES.includes(input.type)) {
    if (isNum(src.minLength)) v.minLength = src.minLength;
    if (isNum(src.maxLength)) v.maxLength = src.maxLength;
    if (src.pattern?.trim()) {
      v.pattern = src.pattern.trim();
      if (src.patternMessage?.trim()) v.patternMessage = src.patternMessage.trim();
    }
  }
  const text = (s: string | null) => (s?.trim() ? s.trim() : null);
  return {
    ...input,
    key: input.key.trim(),
    label: input.label.trim(),
    options,
    transitions,
    validation: v,
    defaultValue: NO_DEFAULT_TYPES.includes(input.type) || input.defaultValue === "" ? null : input.defaultValue,
    relationObject: input.type === "relation" ? input.relationObject : null,
    helpText: text(input.helpText),
    viewPermission: text(input.viewPermission),
    editPermission: text(input.editPermission),
  };
}

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Kiểm sớm để UX — máy chủ vẫn kiểm lại (M6) và lỗi của nó mới là lời cuối. Khoá lỗi dùng cùng tên
 * thuộc tính với đầu vào (`key`, `label`, `options`, `validation.pattern`…) để màn hình đặt câu báo
 * dưới đúng ô.
 */
export function checkFieldInput(input: CustomFieldInput, opts: { creating: boolean; takenKeys: ReadonlySet<string>; systemKeys: ReadonlySet<string> }): FieldError[] {
  const errors: FieldError[] = [];
  if (opts.creating) {
    if (!FIELD_KEY_PATTERN.test(input.key)) errors.push({ field: "key", message: "Khoá chỉ gồm chữ thường không dấu, số và «_», bắt đầu bằng chữ, 2–41 ký tự." });
    else if (opts.systemKeys.has(input.key)) errors.push({ field: "key", message: `Khoá «${input.key}» trùng một field hệ thống.` });
    else if (opts.takenKeys.has(input.key)) errors.push({ field: "key", message: `Khoá «${input.key}» đã có (kể cả field đã lưu trữ — khoá không dùng lại được).` });
  }
  if (!input.label.trim()) errors.push({ field: "label", message: "Nhãn không được để trống." });
  if (OPTION_TYPES.includes(input.type)) {
    if (input.options.length === 0) errors.push({ field: "options", message: "Kiểu này cần ít nhất một tuỳ chọn." });
    const seen = new Set<string>();
    input.options.forEach((o, i) => {
      const value = o.value.trim();
      if (!value) errors.push({ field: `options.${i}.value`, message: "Giá trị không được để trống." });
      else if (seen.has(value)) errors.push({ field: `options.${i}.value`, message: `Giá trị «${value}» bị trùng.` });
      seen.add(value);
      if (!o.label.trim()) errors.push({ field: `options.${i}.label`, message: "Nhãn tuỳ chọn không được để trống." });
    });
  }
  const v = input.validation;
  if (isNum(v.min) && isNum(v.max) && v.min > v.max) errors.push({ field: "validation.max", message: "Tối đa phải ≥ tối thiểu." });
  if (isNum(v.minLength) && isNum(v.maxLength) && v.minLength > v.maxLength) errors.push({ field: "validation.maxLength", message: "Độ dài tối đa phải ≥ độ dài tối thiểu." });
  if (v.pattern) {
    if (v.pattern.length > 200) errors.push({ field: "validation.pattern", message: "Biểu thức tối đa 200 ký tự." });
    else {
      try {
        new RegExp(v.pattern);
      } catch {
        errors.push({ field: "validation.pattern", message: "Biểu thức chính quy không hợp lệ." });
      }
    }
  }
  if (input.type === "relation" && !input.relationObject) errors.push({ field: "relationObject", message: "Chọn đối tượng được liên kết." });
  return errors;
}

/** Lỗi thuộc về một ô: đúng tên, hoặc tên con (`options.2.value` thuộc `options`). */
export function errorsFor(errors: readonly FieldError[], name: string): FieldError[] {
  return errors.filter((e) => e.field === name || e.field.startsWith(`${name}.`) || e.field.startsWith(`${name}[`));
}

// ═══════════ DANH MỤC FIELD CHO TRÌNH SOẠN FORM / DANH SÁCH ═══════════

/** Một field nhìn từ trình soạn: hệ thống hay custom, và các ràng buộc KHÔNG nới được. */
export type CatalogField = {
  ref: FieldRef;
  label: string;
  type: FieldType;
  system: boolean;
  /** Field bắt buộc theo định nghĩa (hệ thống hoặc custom) ⇒ ô «bắt buộc» luôn bật và bị khoá (luật form: chỉ làm CHẶT hơn). */
  lockedRequired: boolean;
  /** `editable: false` ⇒ luôn chỉ đọc trong form. */
  lockedReadOnly: boolean;
  listable: boolean;
  filterable: boolean;
  options: FieldOption[];
};

export function buildCatalog(system: readonly SystemFieldDef[], custom: readonly CustomFieldDef[]): CatalogField[] {
  return [
    ...system.map<CatalogField>((f) => ({
      ref: `system:${f.key}`,
      label: f.label,
      type: f.type,
      system: true,
      lockedRequired: f.required,
      lockedReadOnly: !f.editable,
      listable: f.listable,
      filterable: f.filterable,
      options: f.options ?? [],
    })),
    ...custom
      .filter((f) => f.status === "ACTIVE")
      .map<CatalogField>((f) => ({
        ref: `custom:${f.key}`,
        label: f.label,
        type: f.type,
        system: false,
        // Field custom khai «bắt buộc» ở định nghĩa thì form chỉ làm chặt hơn, không nới được (normalizeFormSchema).
        lockedRequired: f.required,
        lockedReadOnly: false,
        listable: f.listable,
        filterable: f.filterable,
        options: f.options.filter((o) => o.active),
      })),
  ];
}

/** Hoán vị phần tử `index` với láng giềng theo `delta` (±1). Ra ngoài biên ⇒ trả nguyên mảng (bản sao). */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...list];
  const to = index + delta;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** So hai cấu hình theo NỘI DUNG (khoá object sắp xếp) — «Nháp khác bản đã xuất bản». */
export function sameConfig(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/**
 * «Nháp khác bản đã xuất bản?» theo điều NGƯỜI DÙNG THẤY. Trình soạn nối field chưa có vào cuối ở trạng thái
 * ẨN (`appendMissing`), bản đã xuất bản thì không — so thẳng hai bản sẽ luôn báo «khác» ngay khi có một field
 * mới dù xuất bản lại không đổi được gì trên màn hình. Nên bỏ ô ẨN mà bên kia không có, rồi mới so.
 */
export function sameFormLayout(a: FormSchema, b: FormSchema): boolean {
  const refs = (s: FormSchema) => new Set(s.sections.flatMap((x) => x.fields.map((f) => f.ref)));
  const strip = (s: FormSchema, other: Set<string>): FormSchema => ({ ...s, sections: s.sections.map((x) => ({ ...x, fields: x.fields.filter((f) => f.visible || other.has(f.ref)) })) });
  return sameConfig(strip(a, refs(b)), strip(b, refs(a)));
}

/** Như `sameFormLayout` cho danh sách: cột ẩn mà bên kia không có không làm hai bản «khác». */
export function sameListLayout(a: ListViewSchema, b: ListViewSchema): boolean {
  const refs = (s: ListViewSchema) => new Set(s.columns.map((c) => c.ref));
  const strip = (s: ListViewSchema, other: Set<string>): ListViewSchema => ({ ...s, columns: s.columns.filter((c) => c.visible || other.has(c.ref)) });
  return sameConfig(strip(a, refs(b)), strip(b, refs(a)));
}

/** Field chưa nằm trong section nào của form. */
export function unplacedFields(schema: FormSchema, catalog: readonly CatalogField[]): CatalogField[] {
  const placed = new Set(schema.sections.flatMap((s) => s.fields.map((f) => f.ref)));
  return catalog.filter((c) => !placed.has(c.ref));
}

/**
 * Cột của trình soạn danh sách: thứ tự của bản nháp, rồi field `listable` còn thiếu nối cuối ở trạng
 * thái ẨN (field mới tạo không tự chen vào danh sách người khác đang xem). Cột trỏ field không còn
 * (đã lưu trữ) bị bỏ.
 */
export function mergeListColumns(schema: ListViewSchema, catalog: readonly CatalogField[]): ListViewSchema["columns"] {
  const listable = catalog.filter((c) => c.listable);
  const known = new Set(listable.map((c) => c.ref));
  const cols = schema.columns.filter((c) => known.has(c.ref));
  const present = new Set(cols.map((c) => c.ref));
  return [...cols, ...listable.filter((c) => !present.has(c.ref)).map((c) => ({ ref: c.ref, visible: false }))];
}

export const FILTER_OP_LABEL: Record<ListFilterOp, string> = {
  eq: "bằng",
  neq: "khác",
  contains: "có chứa",
  gte: "từ (≥)",
  lte: "tới (≤)",
  in: "thuộc một trong",
  empty: "đang trống",
  not_empty: "có giá trị",
};

/** Phép so hợp với kiểu field — không cho «có chứa» trên số hay «≥» trên chữ. */
export function filterOpsFor(type: FieldType): ListFilterOp[] {
  if (NUMERIC_TYPES.includes(type) || type === "date" || type === "datetime") return ["eq", "neq", "gte", "lte", "empty", "not_empty"];
  if (OPTION_TYPES.includes(type)) return ["eq", "neq", "in", "empty", "not_empty"];
  if (type === "boolean") return ["eq", "empty", "not_empty"];
  return ["eq", "neq", "contains", "empty", "not_empty"];
}

/** Người đọc thấy gì ở dòng «Đang xuất bản». */
export type PublishInfo = {
  version: number;
  /** Chưa xuất bản lần nào ⇒ người dùng đang thấy bản MẶC ĐỊNH dựng từ sổ. */
  isDefault: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
};

/** Một dòng của bảng nhãn trạng thái HỆ THỐNG (M10): giá trị gốc do Core sở hữu, tổ chức chỉ đổi phần hiển thị. */
export type StatusOverrideRow = {
  value: string;
  systemLabel: string;
  /** `null` = dùng nhãn gốc. */
  label: string | null;
  position: number;
  /** Hiện trong bộ lọc. */
  active: boolean;
};

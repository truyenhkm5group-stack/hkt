/**
 * Kiểu dùng chung của lớp metadata (Phase 2) — client-safe, không import gì.
 * Hợp đồng: docs/platform/phase-2-contracts.md mục 3.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "currency",
  "boolean",
  "date",
  "datetime",
  "select",
  "multi_select",
  "status",
  "user",
  "relation",
  "relation_many",
  "file",
  "email",
  "phone",
  "url",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Nhãn tiếng Việt của từng kiểu — màn hình cấu hình và thông báo lỗi dùng chung. */
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Chữ một dòng",
  textarea: "Đoạn văn",
  number: "Số",
  currency: "Tiền (VND)",
  boolean: "Có / không",
  date: "Ngày",
  datetime: "Ngày giờ",
  select: "Chọn một",
  multi_select: "Chọn nhiều",
  status: "Trạng thái nghiệp vụ",
  user: "Người dùng",
  relation: "Liên kết bản ghi",
  relation_many: "Liên kết nhiều bản ghi",
  file: "Tệp",
  email: "Email",
  phone: "Số điện thoại",
  url: "Đường dẫn",
};

/** `system:<khoá>` trỏ field hệ thống (cột thật); `custom:<khoá>` trỏ field custom của tổ chức. */
export type FieldRef = `system:${string}` | `custom:${string}`;

export type FieldOption = { value: string; label: string; color?: string; active: boolean; position: number };

/** `unique` (Phase 6 · chỉ kiểu `relation`): mỗi bản ghi đích được tối đa MỘT bản ghi trỏ tới ⇒ quan hệ một-một. */
export type FieldValidation = { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string; patternMessage?: string; unique?: boolean };

export type FieldStatus = "ACTIVE" | "ARCHIVED";

export type CustomFieldDef = {
  id: string;
  objectKey: string;
  /** BẤT BIẾN: `^[a-z][a-z0-9_]{1,40}$`, duy nhất theo (tổ chức, đối tượng), không trùng field hệ thống. */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  defaultValue: unknown;
  options: FieldOption[];
  validation: FieldValidation;
  /** Chỉ kiểu `status`: `{ "<từ>": ["<tới>", …] }`. Rỗng = mọi chuyển đều được. */
  transitions: Record<string, string[]>;
  relationObject: string | null;
  helpText: string | null;
  viewPermission: string | null;
  editPermission: string | null;
  listable: boolean;
  filterable: boolean;
  position: number;
  status: FieldStatus;
};

export type SystemFieldDef = {
  key: string;
  label: string;
  type: FieldType;
  /** Tên cột THẬT trong bảng của đối tượng (drizzle: tên thuộc tính của bảng). */
  column: string;
  required: boolean;
  /** `false` ⇒ luôn chỉ đọc trong form metadata (vd số liệu tính ra, dữ liệu đồng bộ từ đối tác). */
  editable: boolean;
  listable: boolean;
  filterable: boolean;
  options?: FieldOption[];
  /**
   * Field SỐ cộng / trung bình / min / max được trong khối tổng hợp của trang (Phase 5). Mặc định KHÔNG: phải khai
   * tường minh. Field tiền của đơn / vận đơn / hàng hoàn không bao giờ khai — doanh thu chỉ có MỘT công thức
   * (ORDER_OUTCOME, qua sổ chỉ số của trang), cộng thẳng một cột tiền là công thức thứ hai.
   */
  aggregatable?: boolean;
};

export type FormFieldConfig = { ref: FieldRef; visible: boolean; readOnly: boolean; required: boolean; defaultValue?: unknown };
export type FormSection = { key: string; label: string; fields: FormFieldConfig[] };
export type FormSchema = { version: 1; sections: FormSection[] };

export type ListColumnConfig = { ref: FieldRef; visible: boolean };
export type ListFilterOp = "eq" | "neq" | "contains" | "gte" | "lte" | "in" | "empty" | "not_empty";
export type ListFilter = { ref: FieldRef; op: ListFilterOp; value?: unknown };
export type ListViewSchema = {
  version: 1;
  columns: ListColumnConfig[];
  defaultSort: { ref: FieldRef; dir: "asc" | "desc" } | null;
  defaultFilters: ListFilter[];
};

export type CustomValues = Record<string, unknown>;

/** Lỗi theo field — `field` là khoá field (custom) hoặc `system:<khoá>`; `message` tiếng Việt. */
export type FieldError = { field: string; message: string };

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

/** Người thao tác trên metadata — cùng hình `Actor` của kho (id bắt buộc, `null` = máy). */
export type MetadataActor = { id: string | null; email: string; permissions?: readonly string[]; isAdmin?: boolean };

// ═══════════ PHASE 6 — ĐỐI TƯỢNG TUỲ BIẾN (docs/platform/phase-6-contracts.md) ═══════════

/** Khoá đối tượng tuỳ biến — tiền tố `x_` ⇒ không bao giờ trùng khoá hệ thống. Cùng biểu thức với CHECK của `meta_objects`. */
export const CUSTOM_OBJECT_KEY_PATTERN = /^x_[a-z][a-z0-9_]{1,40}$/;

export function isCustomObjectKey(key: unknown): key is string {
  return typeof key === "string" && CUSTOM_OBJECT_KEY_PATTERN.test(key);
}

/** Trần số id của một field `relation_many`. */
export const RELATION_MANY_MAX = 50;

/** Kiểu field trỏ tới bản ghi của một đối tượng (`relationObject` là đích). */
export const RELATION_TYPES: readonly FieldType[] = ["relation", "relation_many"];

/** Phần của một đối tượng tuỳ biến đọc từ `meta_objects` — gắn vào `ObjectDef.custom`. */
export type CustomObjectInfo = {
  icon: string;
  /** Nhóm menu (khoá module). Module đó tắt ⇒ đối tượng ẩn và bị từ chối. */
  menuModule: string;
  titleLabel: string;
  description: string | null;
  /** Khoá quyền SIẾT thêm (mặc định `records:view` / `records:write`) — luôn đi CÙNG `records:*`, không thay. */
  viewPermission: string;
  writePermission: string;
  status: FieldStatus;
  origin: string | null;
};

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
  file: "Tệp",
  email: "Email",
  phone: "Số điện thoại",
  url: "Đường dẫn",
};

/** `system:<khoá>` trỏ field hệ thống (cột thật); `custom:<khoá>` trỏ field custom của tổ chức. */
export type FieldRef = `system:${string}` | `custom:${string}`;

export type FieldOption = { value: string; label: string; color?: string; active: boolean; position: number };

export type FieldValidation = { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string; patternMessage?: string };

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

/**
 * ═══════════ ĐỐI TƯỢNG TUỲ BIẾN ⇒ `ObjectDef` (Phase 6 · X5) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Hợp đồng: docs/platform/phase-6-contracts.md mục 2. Một dòng `meta_objects` ⇒ MỘT `AnyObjectDef` cùng hình với
 * đối tượng của sổ tĩnh, để mọi dịch vụ Phase 2–4 (field, form, danh sách, luật) chạy trên nó KHÔNG nhánh riêng.
 * Bảng là `custom_records` (khoá drizzle `customRecords`), cột id `id`, tên bản ghi `title`; field hệ thống là
 * CỘT HỆ THỐNG của bản ghi (tên · người phụ trách · lúc tạo · lúc sửa) — mọi field khác là field tuỳ biến.
 *
 * Không đọc CSDL: `lib/metadata/object-resolver.ts` đọc dòng rồi gọi hàm này; trang và bài kiểm gọi thẳng được.
 */
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import type { CustomObjectInfo, SystemFieldDef } from "@/lib/metadata/types";

/** Module của MỌI đối tượng tuỳ biến — tắt ⇒ mọi đối tượng ẩn và bị từ chối ở máy chủ. */
export const CUSTOM_OBJECTS_MODULE: ModuleKey = "apps";
/** Khoá drizzle (`schema.customRecords`) của bảng bản ghi — `ObjectDef.table` là khoá trong `schema`. */
export const CUSTOM_RECORD_TABLE = "customRecords";
/** Tên bảng SQL — sổ phạm vi (`CUSTOM_RECORDS`) nói theo tên này. */
export const CUSTOM_RECORD_SQL_TABLE = "custom_records";
export const CUSTOM_RECORD_FORM_CREATE = "create";
export const CUSTOM_RECORD_FORM_EDIT = "edit";
export const CUSTOM_RECORD_LIST = "default";
/** Tiền tố tuyến của ứng dụng tuỳ biến (`app/(dashboard)/o/*`). */
export const CUSTOM_OBJECT_ROUTE = "/o";

export const TITLE_MAX_LENGTH = 300;

/** Khoá field hệ thống của bản ghi tuỳ biến — field tuỳ biến không được trùng. */
export const CUSTOM_RECORD_SYSTEM_KEYS = ["title", "owner", "created_at", "updated_at"] as const;

export function customObjectHref(objectKey: string, recordId?: string): string {
  return recordId ? `${CUSTOM_OBJECT_ROUTE}/${objectKey}/${encodeURIComponent(recordId)}` : `${CUSTOM_OBJECT_ROUTE}/${objectKey}`;
}

/** Dòng `meta_objects` (đã đọc) — hình tối thiểu hàm dựng cần. */
export type MetaObjectRow = {
  key: string;
  label: string;
  labelPlural: string;
  icon: string;
  moduleKey: string;
  titleLabel: string;
  description: string | null;
  viewPermission: string;
  writePermission: string;
  status: string;
  origin: string | null;
};

export function customRecordSystemFields(titleLabel: string): SystemFieldDef[] {
  return [
    { key: "title", label: titleLabel || "Tên", type: "text", column: "title", required: true, editable: true, listable: true, filterable: true },
    { key: "owner", label: "Người phụ trách", type: "user", column: "ownerId", required: false, editable: true, listable: true, filterable: true },
    { key: "created_at", label: "Tạo lúc", type: "datetime", column: "createdAt", required: false, editable: false, listable: true, filterable: false },
    { key: "updated_at", label: "Sửa lúc", type: "datetime", column: "updatedAt", required: false, editable: false, listable: true, filterable: false },
  ];
}

export function customObjectInfo(row: MetaObjectRow): CustomObjectInfo {
  return {
    icon: row.icon,
    menuModule: row.moduleKey || CUSTOM_OBJECTS_MODULE,
    titleLabel: row.titleLabel,
    description: row.description ?? null,
    viewPermission: row.viewPermission,
    writePermission: row.writePermission,
    status: row.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
    origin: row.origin ?? null,
  };
}

/** Một dòng `meta_objects` ⇒ `AnyObjectDef` (cùng hình đối tượng của sổ tĩnh). */
export function customObjectDef(row: MetaObjectRow): AnyObjectDef {
  return {
    key: row.key,
    label: row.label,
    labelPlural: row.labelPlural,
    module: CUSTOM_OBJECTS_MODULE,
    table: CUSTOM_RECORD_TABLE,
    idColumn: "id",
    titleField: "title",
    scope: "TENANT",
    system: false,
    customizable: true,
    capabilities: { customFields: true, forms: true, lists: true, statuses: false, create: {} },
    forms: [
      { key: CUSTOM_RECORD_FORM_CREATE, label: `Tạo ${row.label.toLocaleLowerCase("vi")}`, purpose: "create" },
      { key: CUSTOM_RECORD_FORM_EDIT, label: `Chi tiết ${row.label.toLocaleLowerCase("vi")}`, purpose: "edit" },
    ],
    lists: [{ key: CUSTOM_RECORD_LIST, label: `Danh sách ${row.labelPlural.toLocaleLowerCase("vi")}`, route: customObjectHref(row.key) }],
    statusFields: [],
    fields: customRecordSystemFields(row.titleLabel),
    why: row.description?.trim() || `Đối tượng tổ chức tự tạo (${row.key}) — bản ghi ở custom_records, giá trị ở custom_values.`,
    custom: customObjectInfo(row),
  };
}

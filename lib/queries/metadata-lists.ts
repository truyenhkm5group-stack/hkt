import type { SQL } from "drizzle-orm";
import type { SessionUser } from "@/lib/auth/session";
import { customDefaultFilters, visibleCustomKeys } from "@/components/metadata/runtime-core";
import { objectDef } from "@/lib/constants/object-registry";
import { MetadataError } from "@/lib/metadata/errors";
import { listFields } from "@/lib/metadata/fields";
import { getPublishedListView } from "@/lib/metadata/lists";
import { resolveStatusOptions } from "@/lib/metadata/statuses";
import type { CustomFieldDef, CustomValues, FieldOption, ListFilter, ListViewSchema } from "@/lib/metadata/types";
import { canViewField, customValuesFilterSql, getCustomValues } from "@/lib/metadata/values";
import { userLabelsByIds } from "@/lib/queries/users";

/**
 * ═══════════ DANH SÁCH THEO METADATA — PHẦN MÁY CHỦ (M9) ═══════════
 *
 * Đọc qua đúng một cửa dịch vụ (`lib/metadata/*`, M14) — không chạm bảng `meta_*` / `custom_values`.
 *
 * `null` ⇒ danh sách CHƯA XUẤT BẢN (hoặc lớp metadata từ chối đọc): trang chạy y như trước Phase 2.
 *
 * BỘ LỌC MẶC ĐỊNH CHỈ ÁP LÊN FIELD NGƯỜI XEM ĐƯỢC XEM. `customValuesFilterSql` không nhận người xem;
 * lọc theo một field người này không được xem thì chính việc một khách CÓ hay KHÔNG có mặt trong kết quả
 * đã nói ra giá trị của field ấy. Bộ lọc bị bỏ vì lẽ đó được ĐẾM để màn hình nói ra, không lặng lẽ biến mất.
 */
export type ListMetadata = {
  schema: ListViewSchema;
  version: number;
  /** Field custom ACTIVE người này xem được — chỉ chúng có cột. */
  customFields: CustomFieldDef[];
  /** Bộ lọc mặc định (field custom) sẽ áp — đã lọc theo quyền xem. */
  filters: ListFilter[];
  /** Số bộ lọc mặc định bị bỏ vì người xem không xem được field. */
  filtersSkipped: number;
};

export async function getListMetadata(objectKey: string, viewKey: string, user: SessionUser): Promise<ListMetadata | null> {
  const obj = objectDef(objectKey);
  if (!obj) return null;
  try {
    const [view, fields] = await Promise.all([getPublishedListView(objectKey, viewKey), listFields(objectKey)]);
    if (view.isDefault) return null;
    const customFields = fields.custom.filter((f) => f.status === "ACTIVE" && canViewField(user, obj, f));
    const viewable = new Set(customFields.map((f) => `custom:${f.key}`));
    const all = customDefaultFilters(view.schema);
    const filters = all.filter((f) => viewable.has(f.ref));
    return { schema: view.schema, version: view.version, customFields, filters, filtersSkipped: all.length - filters.length };
  } catch (error) {
    if (error instanceof MetadataError) return null;
    throw error;
  }
}

/** Điều kiện SQL của bộ lọc mặc định, ghép vào `where` của truy vấn danh sách. */
export function listMetadataFilterSql(objectKey: string, meta: ListMetadata | null): SQL | undefined {
  return meta?.filters.length ? customValuesFilterSql(objectKey, meta.filters) : undefined;
}

/**
 * Giá trị custom của ĐÚNG các dòng đang hiện — MỘT lượt `getCustomValues(ids)`; chỉ đọc khi danh sách có
 * cột custom đang hiện. Kèm tên người cho field kiểu `user`.
 */
export async function listCustomValuesFor(objectKey: string, meta: ListMetadata | null, ids: string[], user: SessionUser): Promise<{ customValues: Record<string, CustomValues>; userNames: Record<string, string> }> {
  if (!meta || !ids.length) return { customValues: {}, userNames: {} };
  const shown = new Set(visibleCustomKeys(meta.schema));
  const columns = meta.customFields.filter((f) => shown.has(f.key));
  if (!columns.length) return { customValues: {}, userNames: {} };
  const map = await getCustomValues(objectKey, ids, user);
  const customValues = Object.fromEntries(map);
  const userKeys = columns.filter((f) => f.type === "user").map((f) => f.key);
  const userIds = userKeys.length ? [...map.values()].flatMap((v) => userKeys.map((k) => v[k]).filter((x): x is string => typeof x === "string")) : [];
  return { customValues, userNames: await userLabelsByIds(userIds) };
}

/**
 * Nhãn / thứ tự / bật-tắt của một trạng thái HỆ THỐNG (M10) theo cấu hình tổ chức. Lỗi đọc ⇒ `null`
 * (hiển thị như cũ). Chỉ đổi CHỮ hiển thị — không đụng giá trị, màu, luật.
 */
export async function getSystemStatusOptions(objectKey: string, fieldKey: string): Promise<FieldOption[] | null> {
  try {
    return await resolveStatusOptions(objectKey, fieldKey);
  } catch (error) {
    if (error instanceof MetadataError) return null;
    throw error;
  }
}

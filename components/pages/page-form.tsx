"use client";

import { DynamicForm, type DynamicFormPayload, type DynamicFormProps, type DynamicFormResult } from "@/components/metadata/dynamic-form";
import { saveCustomValuesAction } from "@/lib/actions/metadata";
import { createCustomerAction } from "@/lib/actions/metadata-records";
import { createRecordAction, updateRecordAction } from "@/lib/actions/objects";
import { isCustomObjectKey, type CustomValues } from "@/lib/metadata/types";
import type { BlockDataByType } from "@/lib/pages/types";

/**
 * ═══════════ KHỐI FORM CỦA TRANG ĐỘNG (Phase 4 + đối tượng tuỳ biến Phase 6) ═══════════
 *
 * Dùng lại `DynamicForm` của Phase 2 với props máy chủ đã dựng (`resolveForm` — schema đã xuất bản, field người
 * xem được xem, giá trị của bản ghi). Hàm LƯU không đi trong dữ liệu khối: nó được gắn Ở ĐÂY bằng đúng server
 * action của trang gốc — không có đường ghi thứ hai cho trang động:
 *  · khách hàng: tạo qua `createCustomerAction` (cùng cổng `/customers/new`), sửa field bổ sung qua
 *    `saveCustomValuesAction` với `formKey` (máy chủ chỉ nhận field hiện và không chỉ đọc của form đã xuất bản);
 *  · đối tượng tuỳ biến `x_…`: tạo / sửa qua `createRecordAction` / `updateRecordAction` — CÙNG action của `/o/<khoá>/new`
 *    và `/o/<khoá>/<id>` (cổng bản ghi, form đã xuất bản, phạm vi ghi).
 */
type FormData = BlockDataByType["form"];

const VIEW_ONLY: DynamicFormResult = { ok: false, error: "Form này chỉ để xem." };

function hasFormShape(p: Record<string, unknown>): boolean {
  return typeof p.schema === "object" && p.schema !== null && Array.isArray(p.system) && Array.isArray(p.custom) && typeof p.values === "object" && p.values !== null;
}

export function PageForm({ data }: { data: FormData }) {
  if (!hasFormShape(data.props)) return <p className="text-sm text-muted-foreground">Chưa có form để hiển thị.</p>;
  const props = data.props as Omit<DynamicFormProps, "onSubmitAction">;
  const recordId = data.recordId;
  const custom = isCustomObjectKey(data.objectKey);
  const submit = async (payload: DynamicFormPayload): Promise<DynamicFormResult> => {
    if (custom) {
      if (data.mode === "create") return createRecordAction(data.objectKey, { system: payload.system, custom: payload.custom as CustomValues });
      if (data.mode === "edit" && recordId) return updateRecordAction(data.objectKey, recordId, { system: payload.system, custom: payload.custom as CustomValues });
      return VIEW_ONLY;
    }
    if (data.mode === "create") return createCustomerAction(payload);
    if (data.mode === "edit" && recordId) return saveCustomValuesAction({ objectKey: data.objectKey, recordId, values: payload.custom as CustomValues, formKey: data.formKey });
    return VIEW_ONLY;
  };
  return <DynamicForm {...props} onSubmitAction={submit} />;
}

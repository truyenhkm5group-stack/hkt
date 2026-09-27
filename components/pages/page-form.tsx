"use client";

import { DynamicForm, type DynamicFormPayload, type DynamicFormProps, type DynamicFormResult } from "@/components/metadata/dynamic-form";
import { saveCustomValuesAction } from "@/lib/actions/metadata";
import { createCustomerAction } from "@/lib/actions/metadata-records";
import type { CustomValues } from "@/lib/metadata/types";
import type { BlockDataByType } from "@/lib/pages/types";

/**
 * ═══════════ KHỐI FORM CỦA TRANG ĐỘNG (Phase 4) ═══════════
 *
 * Dùng lại `DynamicForm` của Phase 2 với props máy chủ đã dựng (`resolveForm` — schema đã xuất bản, field người
 * xem được xem, giá trị của bản ghi). Hàm LƯU không đi trong dữ liệu khối: nó được gắn Ở ĐÂY bằng đúng server
 * action của trang gốc — tạo khách qua `createCustomerAction` (cùng cổng `/customers/new`), sửa field bổ sung
 * qua `saveCustomValuesAction` với `formKey` (máy chủ chỉ nhận field hiện và không chỉ đọc của form đã xuất bản).
 * Không có đường ghi thứ hai cho trang động.
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
  const submit = async (payload: DynamicFormPayload): Promise<DynamicFormResult> => {
    if (data.mode === "create") return createCustomerAction(payload);
    if (data.mode === "edit" && recordId) return saveCustomValuesAction({ objectKey: data.objectKey, recordId, values: payload.custom as CustomValues, formKey: data.formKey });
    return VIEW_ONLY;
  };
  return <DynamicForm {...props} onSubmitAction={submit} />;
}

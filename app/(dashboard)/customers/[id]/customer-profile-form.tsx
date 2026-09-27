"use client";

import { DynamicForm, type DynamicFormPayload } from "@/components/metadata/dynamic-form";
import type { PickOption } from "@/components/metadata/field-input";
import { saveCustomValuesAction } from "@/lib/actions/metadata";
import { uploadCustomerFileAction } from "@/lib/actions/metadata-records";
import type { CustomFieldDef, CustomValues, FormSchema, SystemFieldDef } from "@/lib/metadata/types";

/**
 * Khối "Hồ sơ bổ sung" của một khách: form `profile` đã xuất bản. CHỈ phần custom lên đường truyền —
 * field hệ thống của khách chỉ đọc ở Phase 2 (khách đồng bộ từ Pancake: sửa ở ERP thì lượt đồng bộ kế
 * tiếp ghi đè lại, người sửa tưởng đã lưu mà dữ liệu tự quay về).
 */
export function CustomerProfileForm({ recordId, schema, system, custom, values, users, customEditable, syncedFromPancake }: { recordId: string; schema: FormSchema; system: SystemFieldDef[]; custom: CustomFieldDef[]; values: DynamicFormPayload; users?: PickOption[]; customEditable: string[]; syncedFromPancake: boolean }) {
  return (
    <DynamicForm
      schema={schema}
      system={system}
      custom={custom}
      values={values}
      customEditable={customEditable}
      users={users}
      /*
        Lý do CHỈ ĐỌC phải đúng với tổ chức đang xem: tổ chức không bật Pancake tự tạo khách trên ERP, nói với
        họ "đồng bộ từ Pancake" là nói sai (bắt được ở bài chạy thử trình duyệt 27/09/2026).
      */
      systemReadOnlyReason={syncedFromPancake ? "Đồng bộ từ Pancake — sửa ở Pancake, không sửa ở đây" : "Thông tin cơ bản chưa sửa được ở form này — chỉ field bổ sung sửa được"}
      onSubmitAction={(payload) => saveCustomValuesAction({ objectKey: "customer", recordId, values: payload.custom as CustomValues, formKey: "profile" })}
      uploadAction={(fd) => {
        fd.set("recordId", recordId);
        return uploadCustomerFileAction(fd);
      }}
      submitLabel="Lưu hồ sơ bổ sung"
    />
  );
}

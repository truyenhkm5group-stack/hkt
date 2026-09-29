"use client";

import { DynamicForm, type DynamicFormPayload } from "@/components/metadata/dynamic-form";
import type { PickOption } from "@/components/metadata/field-input";
import { saveCustomValuesAction } from "@/lib/actions/metadata";
import { saveCustomerProfileAction, uploadCustomerFileAction } from "@/lib/actions/metadata-records";
import type { CustomFieldDef, CustomValues, FormSchema, SystemFieldDef } from "@/lib/metadata/types";

/**
 * Khối "Hồ sơ bổ sung" của một khách: form `profile` đã xuất bản. Khách đồng bộ từ Pancake: CHỈ phần custom lên đường
 * truyền — field hệ thống chỉ đọc (sửa ở ERP thì lượt đồng bộ kế tiếp ghi đè lại, người sửa tưởng đã lưu mà dữ liệu tự
 * quay về). Khách TẠO TAY ở tổ chức không bật Pancake (`basicsEditable`, máy chủ quyết bằng `customerBasicsGate`): tên ·
 * SĐT · địa chỉ · tỉnh sửa được ngay ở form này (pilot P1 #11) — máy chủ kiểm lại cổng ở mỗi lượt lưu.
 */
export function CustomerProfileForm({
  recordId,
  schema,
  system,
  custom,
  values,
  users,
  fileNames,
  customEditable,
  syncedFromPancake,
  basicsEditable = false,
}: {
  recordId: string;
  schema: FormSchema;
  system: SystemFieldDef[];
  custom: CustomFieldDef[];
  values: DynamicFormPayload;
  users?: PickOption[];
  fileNames?: Record<string, string>;
  customEditable: string[];
  syncedFromPancake: boolean;
  basicsEditable?: boolean;
}) {
  return (
    <DynamicForm
      schema={schema}
      system={system}
      custom={custom}
      values={values}
      customEditable={customEditable}
      users={users}
      fileNames={fileNames}
      /*
        Lý do CHỈ ĐỌC phải đúng với tổ chức đang xem: tổ chức không bật Pancake tự tạo khách trên ERP, nói với
        họ "đồng bộ từ Pancake" là nói sai (bắt được ở bài chạy thử trình duyệt 27/09/2026).
      */
      systemReadOnlyReason={basicsEditable ? null : syncedFromPancake ? "Đồng bộ từ Pancake — sửa ở Pancake, không sửa ở đây" : "Thông tin cơ bản chưa sửa được ở form này — chỉ field bổ sung sửa được"}
      onSubmitAction={(payload) =>
        basicsEditable
          ? saveCustomerProfileAction({ recordId, system: payload.system, custom: payload.custom })
          : saveCustomValuesAction({ objectKey: "customer", recordId, values: payload.custom as CustomValues, formKey: "profile" })
      }
      uploadAction={(fd) => {
        fd.set("recordId", recordId);
        return uploadCustomerFileAction(fd);
      }}
      submitLabel={basicsEditable ? "Lưu hồ sơ" : "Lưu hồ sơ bổ sung"}
    />
  );
}

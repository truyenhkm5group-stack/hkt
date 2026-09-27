"use client";

import { DynamicForm } from "@/components/metadata/dynamic-form";
import type { PickOption } from "@/components/metadata/field-input";
import { createCustomerAction } from "@/lib/actions/metadata-records";
import type { CustomFieldDef, FormSchema, SystemFieldDef } from "@/lib/metadata/types";

/**
 * Form tạo khách (`create` đã xuất bản). Field `file` chưa tải được ở đây — tệp gắn vào MỘT bản ghi, mà
 * bản ghi chưa có; trang lọc chúng thành chỉ đọc kèm lý do, tải ở trang khách sau khi tạo.
 */
export function CustomerCreateForm({ schema, system, custom, users, customEditable, customLockedReason }: { schema: FormSchema; system: SystemFieldDef[]; custom: CustomFieldDef[]; users?: PickOption[]; customEditable: string[]; customLockedReason?: Record<string, string> }) {
  return (
    <DynamicForm
      schema={schema}
      system={system}
      custom={custom}
      values={{ system: {}, custom: {} }}
      customEditable={customEditable}
      customLockedReason={customLockedReason}
      users={users}
      onSubmitAction={(payload) => createCustomerAction(payload)}
      submitLabel="Tạo khách hàng"
    />
  );
}

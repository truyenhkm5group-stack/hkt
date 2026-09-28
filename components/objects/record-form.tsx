"use client";

/**
 * Form tạo / sửa bản ghi tuỳ biến (Phase 6 · mục 5) — MỘT renderer của Phase 2 (`DynamicForm`, M8) đọc form ĐÃ XUẤT
 * BẢN + định nghĩa field. Không sinh mã, không tệp React riêng cho đối tượng nào. Máy chủ (`lib/objects/records.ts`)
 * là chỗ chặn thật: form đã xuất bản, quyền theo field, phạm vi, tham chiếu có thật.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DynamicForm, type DynamicFormPayload } from "@/components/metadata/dynamic-form";
import type { PickOption } from "@/components/metadata/field-input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { createRecordAction, deleteRecordAction, updateRecordAction, uploadRecordFileAction } from "@/lib/actions/objects";
import type { CustomFieldDef, CustomValues, FormSchema, SystemFieldDef } from "@/lib/metadata/types";

type Common = {
  objectKey: string;
  schema: FormSchema;
  system: SystemFieldDef[];
  custom: CustomFieldDef[];
  users?: PickOption[];
  relationOptions?: Record<string, PickOption[]>;
  customEditable: string[];
  customLockedReason?: Record<string, string>;
};

export function RecordCreateForm({ objectKey, schema, system, custom, users, relationOptions, customEditable, customLockedReason, label, ownerId }: Common & { label: string; ownerId: string }) {
  return (
    <DynamicForm
      schema={schema}
      system={system}
      custom={custom}
      values={{ system: { owner: ownerId }, custom: {} }}
      users={users}
      relationOptions={relationOptions}
      customEditable={customEditable}
      customLockedReason={customLockedReason}
      onSubmitAction={(payload) => createRecordAction(objectKey, payload)}
      submitLabel={`Tạo ${label}`}
    />
  );
}

export function RecordEditForm({ objectKey, recordId, version, schema, system, custom, values, users, relationOptions, customEditable, fileNames, canWrite }: Common & { recordId: string; version: number; values: DynamicFormPayload; fileNames?: Record<string, string>; canWrite: boolean }) {
  return (
    <DynamicForm
      schema={schema}
      system={system}
      custom={custom}
      values={values}
      users={users}
      relationOptions={relationOptions}
      customEditable={canWrite ? customEditable : []}
      systemReadOnlyReason={canWrite ? null : "Bạn chỉ có quyền xem bản ghi này"}
      fileNames={fileNames}
      onSubmitAction={(payload) => updateRecordAction(objectKey, recordId, { system: payload.system, custom: payload.custom as CustomValues, version })}
      uploadAction={
        canWrite
          ? (fd) => {
              fd.set("objectKey", objectKey);
              fd.set("recordId", recordId);
              return uploadRecordFileAction(fd);
            }
          : undefined
      }
      submitLabel="Lưu"
    />
  );
}

/** Xoá (mềm) — hỏi lại một lần; không dùng `useTransition` + điều hướng (luật khung chờ điều hướng). */
export function DeleteRecordButton({ objectKey, recordId, title }: { objectKey: string; recordId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await deleteRecordAction(objectKey, recordId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã xoá bản ghi");
      setOpen(false);
      router.push(r.redirectTo);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} disabled={busy}>
        <Trash2 className="size-4" /> Xoá
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá «{title}»?</AlertDialogTitle>
            <AlertDialogDescription>Bản ghi thôi hiện ở danh sách và không nhận sửa nữa. Dữ liệu và nhật ký vẫn giữ nguyên để truy vết.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Huỷ</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void confirm(); }} disabled={busy}>
              {busy ? "Đang xoá…" : "Xoá"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

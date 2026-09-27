"use client";

/**
 * ═══════════ RENDERER FORM DUY NHẤT (M8) ═══════════
 *
 * Đọc schema ĐÃ XUẤT BẢN + định nghĩa field ⇒ vẽ section → field bằng component UI sẵn có. Không
 * sinh mã, không tệp React riêng cho tổ chức nào.
 *
 * `onSubmitAction` là SERVER ACTION do trang máy chủ truyền xuống (tham chiếu tuần tự hoá được —
 * khác hẳn truyền một hàm thường, thứ AGENTS.md mục 2 cấm). Form chỉ gửi ô SỬA ĐƯỢC: ô chỉ đọc và ô
 * ẩn không bao giờ lên đường truyền — máy chủ vẫn chặn lại lần nữa (M6).
 *
 * Kiểm phía trình duyệt CHỈ để UX; lỗi máy chủ trả về hiện đúng dưới ô của nó. KHÔNG
 * `router.refresh()`: action đã `revalidatePath` — gọi thêm là dựng trang hai lần.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FieldInput, type PickOption, type UploadAction } from "@/components/metadata/field-input";
import { buildFormLayout, fieldErrorKey, initialFormValues, validateFormClient, type FormLayoutOptions } from "@/components/metadata/runtime-core";
import { Button } from "@/components/ui/button";
import type { CustomFieldDef, CustomValues, FieldError, FormSchema, SystemFieldDef } from "@/lib/metadata/types";

export type DynamicFormPayload = { system: Record<string, unknown>; custom: CustomValues };
/** Hình kết quả của action metadata (`MetaActionResult`): thành công `ok: true`; lỗi `{ error, errors, code }`. */
export type DynamicFormResult = { ok: true; values?: CustomValues; redirectTo?: string; message?: string } | { ok?: undefined | false; error?: string; errors?: FieldError[]; code?: string };

export type DynamicFormProps = {
  schema: FormSchema;
  system: SystemFieldDef[];
  custom: CustomFieldDef[];
  values: DynamicFormPayload;
  onSubmitAction: (payload: DynamicFormPayload) => Promise<DynamicFormResult>;
  systemReadOnlyReason?: string | null;
  customEditable?: FormLayoutOptions["customEditable"];
  customLockedReason?: FormLayoutOptions["customLockedReason"];
  users?: PickOption[];
  /** Lựa chọn cho ô `relation`, theo khoá field. Không có ⇒ ô nhập mã. */
  relationOptions?: Record<string, PickOption[]>;
  uploadAction?: UploadAction;
  /** Tên tệp theo id cho ô `file` (`customFileNames` ở máy chủ). */
  fileNames?: Readonly<Record<string, string>>;
  submitLabel?: string;
};

export function DynamicForm({ schema, system, custom, values, onSubmitAction, systemReadOnlyReason, customEditable, customLockedReason, users, relationOptions, uploadAction, fileNames, submitLabel = "Lưu" }: DynamicFormProps) {
  const router = useRouter();
  const sections = React.useMemo(() => buildFormLayout(schema, system, custom, { systemReadOnlyReason, customEditable, customLockedReason }), [schema, system, custom, systemReadOnlyReason, customEditable, customLockedReason]);
  const [stored, setStored] = React.useState<DynamicFormPayload>(values);
  const [form, setForm] = React.useState<DynamicFormPayload>(() => initialFormValues(sections, values));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const editable = sections.some((s) => s.fields.some((f) => !f.readOnly));

  if (!sections.length) return <p className="text-sm text-muted-foreground">Form chưa có trường nào đang hiện.</p>;

  function setValue(kind: "system" | "custom", key: string, v: unknown) {
    setForm((prev) => ({ ...prev, [kind]: { ...prev[kind], [key]: v } }));
    const errKey = kind === "system" ? `system:${key}` : key;
    setErrors((prev) => {
      if (!(errKey in prev)) return prev;
      const next = { ...prev };
      delete next[errKey];
      return next;
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Chỉ ô SỬA ĐƯỢC lên đường truyền.
    const payload: DynamicFormPayload = { system: {}, custom: {} };
    for (const s of sections) for (const f of s.fields) if (!f.readOnly) payload[f.kind][f.key] = form[f.kind][f.key] ?? null;
    const clientErrors = validateFormClient(sections, form, custom, stored.custom);
    if (clientErrors.length) {
      setErrors(toMap(clientErrors));
      setFormError("Còn trường chưa hợp lệ — xem dòng đỏ dưới từng ô.");
      return;
    }
    setFormError(null);
    startTransition(async () => {
      const res = await onSubmitAction(payload);
      if (res.ok !== true) {
        setErrors(toMap(res.errors ?? []));
        setFormError(res.error ?? (res.errors?.length ? "Máy chủ từ chối một số trường — xem dòng đỏ dưới từng ô." : "Không lưu được"));
        return;
      }
      setErrors({});
      if (res.values) {
        // Máy chủ trả TOÀN BỘ giá trị người này xem được sau khi lưu (đã chuẩn hoá) — đó là bản đã lưu mới.
        const next = { system: stored.system, custom: res.values };
        setStored(next);
        setForm((prev) => ({ ...prev, custom: { ...prev.custom, ...res.values } }));
      }
      toast.success(res.message ?? "Đã lưu");
      if (res.redirectTo) router.push(res.redirectTo);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {sections.map((s) => (
        <fieldset key={s.key} className="space-y-3">
          {sections.length > 1 || s.label ? <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.label}</legend> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            {s.fields.map((f) => (
              <div key={f.ref} className={f.type === "textarea" || f.type === "multi_select" ? "sm:col-span-2" : undefined}>
                <FieldInput
                  field={f}
                  value={form[f.kind][f.key]}
                  storedValue={stored[f.kind][f.key]}
                  onChange={(v) => setValue(f.kind, f.key, v)}
                  error={errors[fieldErrorKey(f)]}
                  users={users}
                  relationOptions={relationOptions?.[f.key]}
                  uploadAction={uploadAction}
                  fileNames={fileNames}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      {formError ? <p className="text-sm font-medium text-destructive">{formError}</p> : null}
      {editable ? (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Đang lưu…" : submitLabel}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function toMap(errors: readonly FieldError[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors) if (!(e.field in out)) out[e.field] = e.message;
  return out;
}

"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { PublishLine } from "@/components/platform/metadata/admin-picker";
import { FieldErrors, MoveButtons, SELECT_CLASS, Tick } from "@/components/platform/metadata/bits";
import { DefaultValueInput } from "@/components/platform/metadata/custom-field-manager";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publishFormAdminAction, saveFormDraftAdminAction } from "@/lib/actions/metadata-admin";
import { FIELD_TYPE_LABEL, type FieldError, type FieldRef, type FormFieldConfig, type FormSchema } from "@/lib/metadata/types";
import { moveItem, sameConfig, sameFormLayout, unplacedFields, type CatalogField, type PublishInfo } from "@/lib/platform-ui/metadata-admin-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TRÌNH SOẠN FORM — NHÁP → XEM TRƯỚC → XUẤT BẢN ═══════════
 *
 * Người dùng CHỈ thấy bản đã xuất bản (M7). Ở đây sửa bản NHÁP: section (thêm / đổi tên / xoá / lên /
 * xuống), field trong section (thêm từ field còn lại, lên / xuống, chuyển section, hiện, chỉ đọc, bắt
 * buộc, giá trị mặc định). Luật form khoá sẵn ở giao diện và máy chủ ép lại: field hệ thống bắt buộc
 * thì ô «bắt buộc» không tắt được; field hệ thống không sửa được thì luôn chỉ đọc.
 *
 * «Xuất bản» chỉ bấm được khi nháp đã lưu — xuất bản thứ đang thấy trên màn hình mà chưa lưu là xuất
 * bản một thứ không có trong CSDL.
 */

type Props = {
  objectKey: string;
  formKey: string;
  formLabel: string;
  catalog: CatalogField[];
  draft: FormSchema;
  published: PublishInfo & { schema: FormSchema };
};

function sectionKey(schema: FormSchema): string {
  const used = new Set(schema.sections.map((s) => s.key));
  for (let i = schema.sections.length + 1; ; i++) if (!used.has(`section_${i}`)) return `section_${i}`;
}

export function FormDesigner({ objectKey, formKey, formLabel, catalog, draft, published }: Props) {
  const [schema, setSchema] = useState<FormSchema>(draft);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const byRef = new Map(catalog.map((c) => [c.ref, c]));
  const dirty = !sameConfig(schema, draft);
  const draftDiffers = !sameFormLayout(draft, published.schema);
  const remaining = unplacedFields(schema, catalog);

  const setSections = (fn: (s: FormSchema["sections"]) => FormSchema["sections"]) => setSchema((p) => ({ ...p, sections: fn(p.sections) }));
  const patchField = (si: number, fi: number, patch: Partial<FormFieldConfig>) =>
    setSections((ss) => ss.map((s, i) => (i === si ? { ...s, fields: s.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)) } : s)));
  const moveToSection = (si: number, fi: number, target: number) =>
    setSections((ss) => {
      const f = ss[si]?.fields[fi];
      if (!f || target === si) return ss;
      return ss.map((s, i) => (i === si ? { ...s, fields: s.fields.filter((_, j) => j !== fi) } : i === target ? { ...s, fields: [...s.fields, f] } : s));
    });
  const addField = (si: number, ref: FieldRef) => {
    const c = byRef.get(ref);
    if (!c) return;
    setSections((ss) => ss.map((s, i) => (i === si ? { ...s, fields: [...s.fields, { ref, visible: true, readOnly: c.lockedReadOnly, required: c.lockedRequired }] } : s)));
  };

  const save = () =>
    startTransition(async () => {
      const early = schema.sections.flatMap((s, i) => (s.label.trim() ? [] : [{ field: `sections.${i}.label`, message: "Tên nhóm không được để trống." }]));
      setErrors(early);
      if (early.length) return;
      try {
        const r = await saveFormDraftAdminAction(objectKey, formKey, schema);
        if (r.ok) toast.success("Đã lưu nháp — xem trước bên dưới; người dùng chưa thấy gì cho tới khi xuất bản.");
        else setErrors(r.errors);
      } catch {
        setErrors([{ field: "", message: "Không lưu được — thử lại." }]);
      }
    });

  const publish = () =>
    startTransition(async () => {
      try {
        const r = await publishFormAdminAction(objectKey, formKey);
        if (r.ok) {
          toast.success(`Đã xuất bản «${formLabel}» — có hiệu lực ở lần tải trang kế tiếp.`);
          setConfirming(false);
        } else {
          setErrors(r.errors);
          setConfirming(false);
        }
      } catch {
        setErrors([{ field: "", message: "Không xuất bản được — thử lại." }]);
      }
    });

  const sectionErrors = (i: number) => errors.filter((e) => e.field === `sections.${i}.label` || e.field === `sections.${i}`);
  const fieldErrors = (si: number, fi: number) => errors.filter((e) => e.field.startsWith(`sections.${si}.fields.${fi}`) || e.field === schema.sections[si]?.fields[fi]?.ref);
  const matched = new Set(schema.sections.flatMap((s, si) => [...sectionErrors(si), ...s.fields.flatMap((_, fi) => fieldErrors(si, fi))]));
  const general = errors.filter((e) => !matched.has(e));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PublishLine version={published.version} isDefault={published.isDefault} publishedAt={published.publishedAt} publishedBy={published.publishedBy} draftDiffers={draftDiffers} />
        <div className="flex items-center gap-2">
          {dirty ? <span className="text-xs text-amber-700 dark:text-amber-400">Có thay đổi chưa lưu</span> : null}
          <Button variant="outline" size="sm" onClick={() => setSchema(draft)} disabled={!dirty || pending}>
            Bỏ thay đổi
          </Button>
          <Button variant="outline" size="sm" onClick={save} disabled={!dirty || pending}>
            Lưu nháp
          </Button>
          <Button
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={pending || dirty || (!published.isDefault && !draftDiffers)}
            title={dirty ? "Lưu nháp trước khi xuất bản" : !published.isDefault && !draftDiffers ? "Nháp giống bản đang xuất bản" : undefined}
          >
            Xuất bản
          </Button>
        </div>
      </div>
      <FieldErrors errors={general} />

      <div className={cn("space-y-3", pending && "opacity-70")}>
        {schema.sections.map((s, si) => (
          <section key={s.key} className="rounded-xl border bg-surface">
            <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
              <Input className="h-8 max-w-xs font-semibold" value={s.label} maxLength={80} aria-label="Tên nhóm" onChange={(e) => setSections((ss) => ss.map((x, i) => (i === si ? { ...x, label: e.target.value } : x)))} />
              <MoveButtons index={si} count={schema.sections.length} label={`nhóm ${s.label}`} onMove={(d) => setSections((ss) => moveItem(ss, si, d))} />
              <span className="text-xs text-muted-foreground">{s.fields.length} field</span>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                disabled={schema.sections.length <= 1}
                title={schema.sections.length <= 1 ? "Form cần ít nhất một nhóm" : "Xoá nhóm — field trong nhóm quay về danh sách «còn lại»"}
                onClick={() => setSections((ss) => ss.filter((_, i) => i !== si))}
              >
                <Trash2 /> Xoá nhóm
              </Button>
              <FieldErrors errors={sectionErrors(si)} className="basis-full" />
            </header>
            <div className="overflow-x-auto">
              {s.fields.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">Chưa có field nào trong nhóm này.</p>
              ) : (
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5">Field</th>
                      <th className="px-2 py-1.5">Hiện</th>
                      <th className="px-2 py-1.5">Chỉ đọc</th>
                      <th className="px-2 py-1.5">Bắt buộc</th>
                      <th className="px-2 py-1.5">Mặc định</th>
                      <th className="px-2 py-1.5">Thứ tự</th>
                      <th className="px-2 py-1.5">Nhóm</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {s.fields.map((f, fi) => {
                      const c = byRef.get(f.ref);
                      return (
                        <tr key={f.ref} className="border-t border-hairline align-top">
                          <td className="px-3 py-1.5">
                            <div className="font-medium">{c?.label ?? f.ref}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {c ? `${c.system ? "Hệ thống" : "Tuỳ biến"} · ${FIELD_TYPE_LABEL[c.type]}` : "Field không còn — bỏ khỏi form"}
                            </div>
                            <FieldErrors errors={fieldErrors(si, fi)} />
                          </td>
                          <td className="px-2 py-2">
                            <Tick checked={f.visible} label={`Hiện ${c?.label ?? f.ref}`} onChange={(v) => patchField(si, fi, { visible: v })} disabled={c?.lockedRequired} title={c?.lockedRequired ? "Field bắt buộc — không ẩn được" : undefined} />
                          </td>
                          <td className="px-2 py-2">
                            <Tick checked={f.readOnly || Boolean(c?.lockedReadOnly)} disabled={c?.lockedReadOnly} label={`Chỉ đọc ${c?.label ?? f.ref}`} title={c?.lockedReadOnly ? "Field hệ thống không sửa được — luôn chỉ đọc" : undefined} onChange={(v) => patchField(si, fi, { readOnly: v })} />
                          </td>
                          <td className="px-2 py-2">
                            <Tick checked={f.required || Boolean(c?.lockedRequired)} disabled={c?.lockedRequired} label={`Bắt buộc ${c?.label ?? f.ref}`} title={c?.lockedRequired ? "Field bắt buộc theo định nghĩa — không nới được" : undefined} onChange={(v) => patchField(si, fi, { required: v })} />
                          </td>
                          <td className="w-44 px-2 py-1">
                            {c && !c.lockedReadOnly ? (
                              <DefaultValueInput type={c.type} options={c.options} value={f.defaultValue ?? null} onChange={(v) => patchField(si, fi, { defaultValue: v === null ? undefined : v })} />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <MoveButtons index={fi} count={s.fields.length} label={c?.label ?? f.ref} onMove={(d) => setSections((ss) => ss.map((x, i) => (i === si ? { ...x, fields: moveItem(x.fields, fi, d) } : x)))} />
                          </td>
                          <td className="px-2 py-1.5">
                            <select className={SELECT_CLASS} value={si} aria-label="Chuyển sang nhóm" onChange={(e) => moveToSection(si, fi, Number(e.target.value))}>
                              {schema.sections.map((x, i) => (
                                <option key={x.key} value={i}>
                                  {x.label || `Nhóm ${i + 1}`}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Bỏ khỏi form"
                              title={c?.lockedRequired ? "Field bắt buộc — phải có trong form" : "Bỏ khỏi form"}
                              disabled={c?.lockedRequired}
                              onClick={() => setSections((ss) => ss.map((x, i) => (i === si ? { ...x, fields: x.fields.filter((_, j) => j !== fi) } : x)))}
                            >
                              <X />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {remaining.length ? (
              <footer className="border-t border-hairline px-3 py-2">
                <select
                  className={SELECT_CLASS}
                  value=""
                  aria-label={`Thêm field vào nhóm ${s.label}`}
                  onChange={(e) => {
                    if (e.target.value) addField(si, e.target.value as FieldRef);
                  }}
                >
                  <option value="">+ Thêm field vào nhóm này ({remaining.length} còn lại)</option>
                  {remaining.map((c) => (
                    <option key={c.ref} value={c.ref}>
                      {c.label} · {c.system ? "hệ thống" : "tuỳ biến"}
                    </option>
                  ))}
                </select>
              </footer>
            ) : null}
          </section>
        ))}
        <Button variant="outline" size="sm" onClick={() => setSchema((p) => ({ ...p, sections: [...p.sections, { key: sectionKey(p), label: "Nhóm mới", fields: [] }] }))}>
          <Plus /> Thêm nhóm
        </Button>
      </div>

      <div className="rounded-xl border border-dashed bg-surface-sunken/40 p-4">
        <h3 className="mb-3 text-sm font-semibold">
          Xem trước bản nháp đã lưu {dirty ? <span className="font-normal text-amber-700 dark:text-amber-400">— chưa gồm thay đổi chưa lưu</span> : null}
        </h3>
        <FormPreview schema={draft} catalog={catalog} />
      </div>

      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xuất bản «{formLabel}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Người dùng thấy bản này NGAY ở lần tải trang kế tiếp — không cần deploy. {published.version > 0 ? `Bản đang xuất bản (phiên bản ${published.version}) được giữ trong lịch sử phiên bản.` : "Đây là lần xuất bản đầu tiên; trước đó người dùng thấy form mặc định."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                publish();
              }}
            >
              Xuất bản
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Bản xem trước chỉ đọc: vẽ đúng thứ tự nhóm/field, bỏ field ẩn, đánh dấu bắt buộc và chỉ đọc. */
export function FormPreview({ schema, catalog }: { schema: FormSchema; catalog: CatalogField[] }) {
  const byRef = new Map(catalog.map((c) => [c.ref, c]));
  const sections = schema.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => f.visible && byRef.has(f.ref)) })).filter((s) => s.fields.length > 0);
  if (sections.length === 0) return <p className="text-xs text-muted-foreground">Không có field nào đang hiện — form trống.</p>;
  return (
    <div className="space-y-4">
      {sections.map((s) => (
        <fieldset key={s.key} className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.label}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {s.fields.map((f) => {
              const c = byRef.get(f.ref);
              if (!c) return null;
              const readOnly = f.readOnly || c.lockedReadOnly;
              const required = f.required || c.lockedRequired;
              return (
                <div key={f.ref} className="grid gap-1">
                  <span className="text-sm font-medium">
                    {c.label}
                    {required ? <span className="text-destructive"> *</span> : null}
                    {readOnly ? <span className="ml-1 text-[11px] font-normal text-muted-foreground">(chỉ đọc)</span> : null}
                  </span>
                  <div className={cn("flex h-9 items-center rounded-md border px-3 text-sm text-muted-foreground", readOnly && "bg-muted/50")}>
                    {f.defaultValue !== undefined && f.defaultValue !== null ? String(Array.isArray(f.defaultValue) ? f.defaultValue.join(", ") : f.defaultValue) : FIELD_TYPE_LABEL[c.type]}
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

"use client";

import { useMemo, useState, useTransition } from "react";
import { Archive, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FieldErrors, MoveButtons, SELECT_CLASS, Tick } from "@/components/platform/metadata/bits";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { archiveFieldAction, createFieldAction, moveFieldAction, updateFieldAction } from "@/lib/actions/metadata-admin";
import { PERMISSION_GROUPS } from "@/lib/auth/permissions";
import { FIELD_TYPE_LABEL, FIELD_TYPES, type CustomFieldDef, type FieldError, type FieldOption, type FieldType } from "@/lib/metadata/types";
import {
  blankFieldInput,
  checkFieldInput,
  errorsFor,
  fieldToInput,
  moveItem,
  normalizeFieldInput,
  NO_DEFAULT_TYPES,
  NUMERIC_TYPES,
  OPTION_TYPES,
  RELATION_FIELD_TYPES,
  suggestFieldKey,
  TEXTUAL_TYPES,
  type AdminWriteResult,
  type CustomFieldInput,
  type CustomFieldPatch,
} from "@/lib/platform-ui/metadata-admin-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ FIELD TUỲ BIẾN CỦA MỘT ĐỐI TƯỢNG ═══════════
 *
 * Bảng field custom + khung tạo/sửa. Khoá chỉ nhập lúc TẠO (bất biến — M4), gợi ý từ nhãn bằng bỏ dấu.
 * Kiểu cũng khoá sau khi tạo: đổi kiểu làm giá trị đã nhập sai nghĩa. Không có nút xoá — LƯU TRỮ giữ
 * nguyên giá trị cũ, chỉ thôi hiện và thôi nhận ghi.
 *
 * Lỗi: kiểm sớm ở trình duyệt để báo nhanh, nhưng câu của MÁY CHỦ mới là lời cuối và được in nguyên
 * văn dưới đúng ô (khoá lỗi = tên thuộc tính đầu vào: `key`, `options.2.value`, `validation.pattern`…);
 * lỗi không khớp ô nào in ở đầu khung.
 */

const COLORS: { value: string; label: string; swatch: string }[] = [
  { value: "", label: "Không màu", swatch: "bg-transparent" },
  { value: "slate", label: "Xám", swatch: "bg-slate-400" },
  { value: "sky", label: "Xanh dương", swatch: "bg-sky-500" },
  { value: "emerald", label: "Xanh lá", swatch: "bg-emerald-500" },
  { value: "amber", label: "Vàng", swatch: "bg-amber-500" },
  { value: "rose", label: "Đỏ", swatch: "bg-rose-500" },
  { value: "violet", label: "Tím", swatch: "bg-violet-500" },
];

type EditorMode = { kind: "create" } | { kind: "edit"; field: CustomFieldDef } | null;

export function CustomFieldManager({ objectKey, objectLabel, fields, systemKeys, relationTargets }: { objectKey: string; objectLabel: string; fields: CustomFieldDef[]; systemKeys: string[]; relationTargets: { key: string; label: string }[] }) {
  const [mode, setMode] = useState<EditorMode>(null);
  const [archiving, setArchiving] = useState<CustomFieldDef | null>(null);
  const [pending, startTransition] = useTransition();
  const active = fields.filter((f) => f.status === "ACTIVE");
  const archived = fields.filter((f) => f.status === "ARCHIVED");

  const run = (fn: () => Promise<AdminWriteResult>, success: string, after?: () => void) =>
    startTransition(async () => {
      try {
        const r = await fn();
        if (r.ok) {
          toast.success(success);
          after?.();
        } else toast.error(r.errors.map((e) => e.message).join(" · ") || "Không lưu được.");
      } catch {
        toast.error("Không lưu được — thử lại.");
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {active.length} field đang dùng{archived.length ? ` · ${archived.length} đã lưu trữ` : ""}
        </p>
        <Button size="sm" onClick={() => setMode({ kind: "create" })} disabled={mode !== null}>
          <Plus /> Thêm field
        </Button>
      </div>

      {mode ? (
        <FieldEditor
          key={mode.kind === "edit" ? mode.field.key : "create"}
          objectKey={objectKey}
          objectLabel={objectLabel}
          mode={mode}
          takenKeys={new Set(fields.map((f) => f.key))}
          systemKeys={new Set(systemKeys)}
          relationTargets={relationTargets}
          onClose={() => setMode(null)}
        />
      ) : null}

      <div className={cn("overflow-x-auto rounded-xl border", pending && "opacity-70")}>
        {fields.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Chưa có field tuỳ biến nào cho {objectLabel.toLowerCase()} — bấm «Thêm field» để tạo field đầu tiên.</p>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Khoá</th>
                <th className="px-3 py-2">Nhãn</th>
                <th className="px-3 py-2">Kiểu</th>
                <th className="px-3 py-2">Bắt buộc</th>
                <th className="px-3 py-2">Trạng thái</th>
                <th className="px-3 py-2">Vị trí</th>
                <th className="px-3 py-2 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {[...active, ...archived].map((f) => {
                const idx = active.indexOf(f);
                const isArchived = f.status === "ARCHIVED";
                return (
                  <tr key={f.key} className={cn("border-t border-hairline", isArchived && "text-muted-foreground")}>
                    <td className="px-3 py-2 font-mono text-[12.5px]">{f.key}</td>
                    <td className="px-3 py-2">{f.label}</td>
                    <td className="px-3 py-2">{FIELD_TYPE_LABEL[f.type]}</td>
                    <td className="px-3 py-2">{f.required ? "Có" : "—"}</td>
                    <td className="px-3 py-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11.5px]", isArchived ? "bg-muted" : "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200")}>{isArchived ? "Đã lưu trữ" : "Đang dùng"}</span>
                    </td>
                    <td className="px-3 py-2">
                      {isArchived ? (
                        "—"
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <span className="numeric w-5 text-right text-xs">{idx + 1}</span>
                          <MoveButtons index={idx} count={active.length} label={f.label} disabled={pending} onMove={(d) => run(() => moveFieldAction(objectKey, f.key, d), "Đã đổi vị trí")} />
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isArchived ? null : (
                        <span className="inline-flex gap-1">
                          <Button variant="ghost" size="xs" onClick={() => setMode({ kind: "edit", field: f })} disabled={mode !== null}>
                            <Pencil /> Sửa
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setArchiving(f)} disabled={pending}>
                            <Archive /> Lưu trữ
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <AlertDialog open={archiving !== null} onOpenChange={(o) => !o && setArchiving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lưu trữ field «{archiving?.label}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Giá trị đã nhập được GIỮ NGUYÊN trong CSDL, nhưng field thôi hiện ở form và danh sách, và không nhận ghi mới. Khoá «{archiving?.key}» không dùng lại được cho field khác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                const f = archiving;
                if (f) run(() => archiveFieldAction(objectKey, f.key), `Đã lưu trữ «${f.label}»`, () => setArchiving(null));
              }}
            >
              Lưu trữ
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Row({ label, children, errors, hint }: { label: string; children: React.ReactNode; errors?: FieldError[]; hint?: string }) {
  return (
    <div className="grid gap-1 text-sm" role="group" aria-label={label}>
      <span className="text-xs font-medium text-muted-foreground" title={hint}>
        {label}
      </span>
      {children}
      <FieldErrors errors={errors ?? []} />
    </div>
  );
}

function numOrUndef(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function FieldEditor({ objectKey, objectLabel, mode, takenKeys, systemKeys, relationTargets, onClose }: { objectKey: string; objectLabel: string; mode: Exclude<EditorMode, null>; takenKeys: Set<string>; systemKeys: Set<string>; relationTargets: { key: string; label: string }[]; onClose: () => void }) {
  const creating = mode.kind === "create";
  const [input, setInput] = useState<CustomFieldInput>(() => (mode.kind === "edit" ? fieldToInput(mode.field) : blankFieldInput()));
  const [keyTouched, setKeyTouched] = useState(!creating);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [pending, startTransition] = useTransition();
  const savedValues = useMemo(() => new Set(mode.kind === "edit" ? mode.field.options.map((o) => o.value) : []), [mode]);

  const set = <K extends keyof CustomFieldInput>(k: K, v: CustomFieldInput[K]) => setInput((p) => ({ ...p, [k]: v }));
  const setLabel = (label: string) => setInput((p) => ({ ...p, label, key: keyTouched ? p.key : suggestFieldKey(label, new Set([...takenKeys, ...systemKeys])) }));
  const setOption = (i: number, patch: Partial<FieldOption>) => set("options", input.options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const hasOptions = OPTION_TYPES.includes(input.type);

  // Ô nào đang HIỆN trên khung này (theo kiểu) — lỗi không rơi vào ô nào in ở đầu khung, không biến mất.
  const shown = [
    "key",
    "label",
    "type",
    "defaultValue",
    "viewPermission",
    "editPermission",
    "helpText",
    ...(hasOptions ? ["options"] : []),
    ...(input.type === "status" && input.options.length > 0 ? ["transitions"] : []),
    ...(RELATION_FIELD_TYPES.includes(input.type) ? ["relationObject", "validation"] : []),
    ...(NUMERIC_TYPES.includes(input.type) ? ["validation.min", "validation.max"] : []),
    ...(TEXTUAL_TYPES.includes(input.type) ? ["validation.minLength", "validation.maxLength", "validation.pattern", "validation.patternMessage"] : []),
  ];
  const orphanErrors = errors.filter((e) => !shown.some((name) => errorsFor([e], name).length > 0));

  const submit = () => {
    const normalized = normalizeFieldInput(input);
    const early = checkFieldInput(normalized, { creating, takenKeys, systemKeys });
    setErrors(early);
    if (early.length) return;
    startTransition(async () => {
      try {
        let r: AdminWriteResult;
        if (creating) r = await createFieldAction(objectKey, normalized);
        else {
          const { key, type, ...rest } = normalized;
          void type;
          const patch: CustomFieldPatch = rest;
          r = await updateFieldAction(objectKey, key, patch);
        }
        if (r.ok) {
          toast.success(creating ? `Đã tạo field «${normalized.label}»` : `Đã lưu «${normalized.label}»`);
          onClose();
        } else setErrors(r.errors);
      } catch {
        setErrors([{ field: "", message: "Không lưu được — thử lại." }]);
      }
    });
  };

  return (
    <div className="space-y-4 rounded-xl border border-primary/40 bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{creating ? `Field mới cho ${objectLabel.toLowerCase()}` : `Sửa field «${mode.field.label}»`}</h3>
        <span className="font-mono text-xs text-muted-foreground">{input.key || "—"}</span>
      </div>
      <FieldErrors errors={orphanErrors} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Row label="Nhãn" errors={errorsFor(errors, "label")}>
          <Input value={input.label} onChange={(e) => setLabel(e.target.value)} maxLength={120} autoFocus />
        </Row>
        <Row label={creating ? "Khoá (không đổi được sau khi tạo)" : "Khoá (bất biến)"} errors={errorsFor(errors, "key")} hint="Chữ thường không dấu, số và «_». Khoá nằm trong dữ liệu đã lưu, form và danh sách đã xuất bản.">
          <Input
            value={input.key}
            disabled={!creating}
            className="font-mono"
            maxLength={41}
            onChange={(e) => {
              setKeyTouched(true);
              set("key", e.target.value);
            }}
          />
        </Row>
        <Row label={creating ? "Kiểu" : "Kiểu (không đổi sau khi tạo)"} errors={errorsFor(errors, "type")}>
          <select className={cn(SELECT_CLASS, "h-9")} value={input.type} disabled={!creating} onChange={(e) => setInput((p) => ({ ...p, type: e.target.value as FieldType, defaultValue: null }))}>
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label className="inline-flex items-center gap-2">
          <Tick checked={input.required} onChange={(v) => set("required", v)} label="Bắt buộc" /> Bắt buộc
        </label>
        <label className="inline-flex items-center gap-2">
          <Tick checked={input.listable} onChange={(v) => set("listable", v)} label="Cho phép làm cột danh sách" /> Làm cột danh sách được
        </label>
        <label className="inline-flex items-center gap-2">
          <Tick checked={input.filterable} onChange={(v) => set("filterable", v)} label="Cho phép lọc" /> Lọc được
        </label>
      </div>

      {hasOptions ? <OptionsEditor input={input} savedValues={savedValues} errors={errors} setOption={setOption} setOptions={(o) => set("options", o)} /> : null}
      {input.type === "status" && input.options.length > 0 ? <TransitionMatrix input={input} onChange={(t) => set("transitions", t)} errors={errorsFor(errors, "transitions")} /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Row label="Giá trị mặc định" errors={errorsFor(errors, "defaultValue")}>
          <DefaultValueInput type={input.type} options={input.options} value={input.defaultValue} onChange={(v) => set("defaultValue", v)} />
        </Row>
        {RELATION_FIELD_TYPES.includes(input.type) ? (
          <Row label="Liên kết tới đối tượng" errors={errorsFor(errors, "relationObject")}>
            <select className={cn(SELECT_CLASS, "h-9")} value={input.relationObject ?? ""} onChange={(e) => set("relationObject", e.target.value || null)}>
              <option value="">— chọn —</option>
              {relationTargets.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </Row>
        ) : null}
        {input.type === "relation" ? (
          <Row label="Một-một" errors={errorsFor(errors, "validation")}>
            <label className="inline-flex h-9 items-center gap-2 text-sm">
              <Tick checked={input.validation.unique === true} onChange={(v) => set("validation", { ...input.validation, unique: v || undefined })} label="Mỗi bản ghi đích chỉ được một bản ghi trỏ tới" /> Mỗi bản ghi đích chỉ một
            </label>
          </Row>
        ) : null}
      </div>

      {NUMERIC_TYPES.includes(input.type) || TEXTUAL_TYPES.includes(input.type) ? (
        <fieldset className="grid gap-3 rounded-lg border border-hairline p-3 sm:grid-cols-4">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Kiểm hợp lệ (máy chủ kiểm lại khi ghi)</legend>
          {NUMERIC_TYPES.includes(input.type) ? (
            <>
              <Row label="Tối thiểu" errors={errorsFor(errors, "validation.min")}>
                <Input type="number" value={input.validation.min ?? ""} onChange={(e) => set("validation", { ...input.validation, min: numOrUndef(e.target.value) })} />
              </Row>
              <Row label="Tối đa" errors={errorsFor(errors, "validation.max")}>
                <Input type="number" value={input.validation.max ?? ""} onChange={(e) => set("validation", { ...input.validation, max: numOrUndef(e.target.value) })} />
              </Row>
            </>
          ) : (
            <>
              <Row label="Độ dài tối thiểu" errors={errorsFor(errors, "validation.minLength")}>
                <Input type="number" min={0} value={input.validation.minLength ?? ""} onChange={(e) => set("validation", { ...input.validation, minLength: numOrUndef(e.target.value) })} />
              </Row>
              <Row label="Độ dài tối đa" errors={errorsFor(errors, "validation.maxLength")}>
                <Input type="number" min={0} value={input.validation.maxLength ?? ""} onChange={(e) => set("validation", { ...input.validation, maxLength: numOrUndef(e.target.value) })} />
              </Row>
              <Row label="Mẫu (biểu thức chính quy)" errors={errorsFor(errors, "validation.pattern")} hint="Tối đa 200 ký tự. Để trống nếu không cần.">
                <Input value={input.validation.pattern ?? ""} className="font-mono" maxLength={200} onChange={(e) => set("validation", { ...input.validation, pattern: e.target.value })} />
              </Row>
              <Row label="Câu báo khi sai mẫu" errors={errorsFor(errors, "validation.patternMessage")}>
                <Input value={input.validation.patternMessage ?? ""} maxLength={200} onChange={(e) => set("validation", { ...input.validation, patternMessage: e.target.value })} />
              </Row>
            </>
          )}
        </fieldset>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Row label="Quyền để XEM (tuỳ chọn)" errors={errorsFor(errors, "viewPermission")} hint="Để trống = ai xem được bản ghi thì xem được field. Máy chủ lọc khi đọc.">
          <PermissionSelect value={input.viewPermission} onChange={(v) => set("viewPermission", v)} />
        </Row>
        <Row label="Quyền để SỬA (tuỳ chọn)" errors={errorsFor(errors, "editPermission")} hint="Để trống = ai sửa được bản ghi thì sửa được field. Máy chủ chặn khi ghi.">
          <PermissionSelect value={input.editPermission} onChange={(v) => set("editPermission", v)} />
        </Row>
        <Row label="Trợ giúp (hiện dưới ô nhập)" errors={errorsFor(errors, "helpText")}>
          <Textarea rows={1} value={input.helpText ?? ""} maxLength={500} onChange={(e) => set("helpText", e.target.value)} />
        </Row>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
          Huỷ
        </Button>
        <Button size="sm" onClick={submit} disabled={pending}>
          {creating ? "Tạo field" : "Lưu thay đổi"}
        </Button>
      </div>
    </div>
  );
}

function PermissionSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <select className={cn(SELECT_CLASS, "h-9")} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— không giới hạn —</option>
      {PERMISSION_GROUPS.map((g) => (
        <optgroup key={g.module} label={g.module}>
          {g.items.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function OptionsEditor({ input, savedValues, errors, setOption, setOptions }: { input: CustomFieldInput; savedValues: Set<string>; errors: FieldError[]; setOption: (i: number, p: Partial<FieldOption>) => void; setOptions: (o: FieldOption[]) => void }) {
  const opts = input.options;
  return (
    <fieldset className="rounded-lg border border-hairline p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">Tuỳ chọn</legend>
      <FieldErrors errors={errors.filter((e) => e.field === "options")} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">Giá trị (lưu vào dữ liệu)</th>
              <th className="py-1 pr-2">Nhãn</th>
              <th className="py-1 pr-2">Màu</th>
              <th className="py-1 pr-2">Đang dùng</th>
              <th className="py-1 pr-2">Thứ tự</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {opts.map((o, i) => {
              const saved = savedValues.has(o.value);
              return (
                <tr key={i} className="align-top">
                  <td className="py-1 pr-2">
                    <Input className="h-8 font-mono" value={o.value} disabled={saved} title={saved ? "Giá trị đã lưu — đổi là làm bản ghi cũ mất nhãn. Đổi NHÃN thay vì giá trị." : undefined} onChange={(e) => setOption(i, { value: e.target.value })} maxLength={64} />
                    <FieldErrors errors={errorsFor(errors, `options.${i}.value`)} />
                  </td>
                  <td className="py-1 pr-2">
                    <Input className="h-8" value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} maxLength={120} />
                    <FieldErrors errors={errorsFor(errors, `options.${i}.label`)} />
                  </td>
                  <td className="py-1 pr-2">
                    <select className={SELECT_CLASS} value={o.color ?? ""} onChange={(e) => setOption(i, { color: e.target.value || undefined })}>
                      {COLORS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 pr-2 pt-2.5">
                    <Tick checked={o.active} onChange={(v) => setOption(i, { active: v })} label={`Đang dùng: ${o.label || o.value}`} />
                  </td>
                  <td className="py-1 pr-2">
                    <MoveButtons index={i} count={opts.length} label={o.label || o.value || "tuỳ chọn"} onMove={(d) => setOptions(moveItem(opts, i, d))} />
                  </td>
                  <td className="py-1 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={saved}
                      aria-label="Xoá tuỳ chọn"
                      title={saved ? "Giá trị đã lưu — tắt «Đang dùng» thay vì xoá để bản ghi cũ vẫn đọc được nhãn." : "Xoá tuỳ chọn"}
                      onClick={() => setOptions(opts.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Button type="button" variant="outline" size="xs" className="mt-2" onClick={() => setOptions([...opts, { value: "", label: "", active: true, position: opts.length }])}>
        <Plus /> Thêm tuỳ chọn
      </Button>
    </fieldset>
  );
}

function TransitionMatrix({ input, onChange, errors }: { input: CustomFieldInput; onChange: (t: Record<string, string[]>) => void; errors: FieldError[] }) {
  const values = input.options.map((o) => o.value.trim()).filter(Boolean);
  const restricted = Object.keys(input.transitions).length > 0;
  const toggle = (from: string, to: string, on: boolean) => {
    const cur = new Set(input.transitions[from] ?? []);
    if (on) cur.add(to);
    else cur.delete(to);
    onChange({ ...input.transitions, [from]: values.filter((v) => cur.has(v)) });
  };
  return (
    <fieldset className="rounded-lg border border-hairline p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">Chuyển trạng thái</legend>
      <label className="inline-flex items-center gap-2 text-sm">
        <Tick
          checked={restricted}
          label="Giới hạn chuyển trạng thái"
          onChange={(on) => onChange(on ? Object.fromEntries(values.map((v) => [v, values.filter((x) => x !== v)])) : {})}
        />
        Giới hạn chuyển trạng thái {restricted ? "" : "(đang tắt: mọi chuyển đều được)"}
      </label>
      <FieldErrors errors={errors} />
      {restricted ? (
        <div className="mt-2 overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left text-[11px] font-medium text-muted-foreground">Từ ↓ · Tới →</th>
                {input.options.map((o) => (
                  <th key={o.value} className="px-2 py-1 text-[11.5px] font-medium">
                    {o.label || o.value}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {input.options.map((from) => (
                <tr key={from.value} className="border-t border-hairline">
                  <th className="px-2 py-1 text-left text-[12px] font-medium">{from.label || from.value}</th>
                  {input.options.map((to) => (
                    <td key={to.value} className="px-2 py-1 text-center">
                      {from.value === to.value ? (
                        <span className="text-muted-foreground">·</span>
                      ) : (
                        <Tick checked={(input.transitions[from.value] ?? []).includes(to.value)} label={`${from.label} → ${to.label}`} onChange={(on) => toggle(from.value, to.value, on)} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </fieldset>
  );
}

export function DefaultValueInput({ type, options, value, onChange }: { type: FieldType; options: FieldOption[]; value: unknown; onChange: (v: unknown) => void }) {
  if (NO_DEFAULT_TYPES.includes(type)) return <p className="py-2 text-xs text-muted-foreground">Kiểu này không đặt giá trị mặc định.</p>;
  if (type === "boolean")
    return (
      <select className={cn(SELECT_CLASS, "h-9")} value={value === true ? "true" : value === false ? "false" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}>
        <option value="">— không đặt —</option>
        <option value="true">Có</option>
        <option value="false">Không</option>
      </select>
    );
  if (type === "select" || type === "status")
    return (
      <select className={cn(SELECT_CLASS, "h-9")} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— không đặt —</option>
        {options
          .filter((o) => o.value.trim())
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label || o.value}
            </option>
          ))}
      </select>
    );
  if (type === "multi_select") {
    const cur = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 py-1.5 text-sm">
        {options.filter((o) => o.value.trim()).length === 0 ? <span className="text-xs text-muted-foreground">Thêm tuỳ chọn trước.</span> : null}
        {options
          .filter((o) => o.value.trim())
          .map((o) => (
            <label key={o.value} className="inline-flex items-center gap-1.5">
              <Tick checked={cur.includes(o.value)} label={o.label || o.value} onChange={(on) => onChange(on ? [...cur, o.value] : cur.filter((x) => x !== o.value))} />
              {o.label || o.value}
            </label>
          ))}
      </div>
    );
  }
  if (NUMERIC_TYPES.includes(type)) return <Input type="number" step={type === "currency" ? 1000 : "any"} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(numOrUndef(e.target.value) ?? null)} />;
  if (type === "date") return <Input type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
  if (type === "datetime") return <Input type="datetime-local" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
  return <Input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} maxLength={2000} />;
}

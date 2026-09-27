"use client";

/**
 * MỘT Ô NHẬP CHO MỘT FIELD theo `FieldType` (docs/platform/phase-2-contracts.md M5, M8).
 *
 * Component THUẦN: nhận field đã phân giải + giá trị + `onChange`, không gọi dịch vụ nào. Danh sách
 * người dùng / bản ghi liên kết và hành động tải tệp đều do trang truyền vào. Kiểm hợp lệ thật chạy ở
 * máy chủ (M6); ô chỉ hiện lỗi được đưa tới.
 */
import * as React from "react";
import { Paperclip } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isoToVnLocalInput, parseCurrencyInput, statusTargets, vnLocalInputToIso, formatCustomValue, type ResolvedFormField } from "@/components/metadata/runtime-core";
import { cn } from "@/lib/utils";

export type PickOption = { id: string; label: string };
export type UploadResult = { ok: true; id: string; filename?: string } | { ok: false; error: string };
/** Server action tải tệp — nhận `FormData` có `file` + `field`, trả id tệp đã lưu. */
export type UploadAction = (formData: FormData) => Promise<UploadResult>;

export type FieldInputProps = {
  field: ResolvedFormField;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string | null;
  /** Giá trị ĐÃ LƯU — ô `status` tính đích chuyển từ đây, không từ giá trị đang gõ dở. */
  storedValue?: unknown;
  users?: readonly PickOption[];
  relationOptions?: readonly PickOption[];
  uploadAction?: UploadAction;
  id?: string;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30";

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function FieldInput({ field, value, onChange, error, storedValue, users, relationOptions, uploadAction, id }: FieldInputProps) {
  const inputId = id ?? `f-${field.ref.replace(":", "-")}`;
  const invalid = error ? true : undefined;
  const disabled = field.readOnly;
  const common = { id: inputId, "aria-invalid": invalid, disabled };

  let control: React.ReactNode;
  switch (field.type) {
    case "textarea":
      control = <Textarea {...common} value={str(value)} onChange={(e) => onChange(e.target.value)} maxLength={field.validation.maxLength} />;
      break;
    case "number":
      control = (
        <Input
          {...common}
          type="number"
          inputMode="decimal"
          value={str(value)}
          min={field.validation.min}
          max={field.validation.max}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
      break;
    case "currency":
      control = (
        <div className="relative">
          <Input
            {...common}
            inputMode="numeric"
            className="pr-8 text-right numeric"
            value={typeof value === "number" ? new Intl.NumberFormat("vi-VN").format(value) : ""}
            onChange={(e) => onChange(parseCurrencyInput(e.target.value))}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">₫</span>
        </div>
      );
      break;
    case "boolean":
      control = (
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox id={inputId} aria-invalid={invalid} disabled={disabled} checked={value === true} onCheckedChange={(c) => onChange(c === true)} />
          <span>{value === true ? "Có" : value === false ? "Không" : "Chưa chọn"}</span>
        </label>
      );
      break;
    case "date":
      control = <Input {...common} type="date" value={str(value).slice(0, 10)} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "datetime":
      control = <Input {...common} type="datetime-local" value={isoToVnLocalInput(value)} onChange={(e) => onChange(vnLocalInputToIso(e.target.value))} />;
      break;
    case "select":
    case "status": {
      const opts = field.type === "status" ? statusTargets(field.options, field.transitions, storedValue ?? null) : field.options.filter((o) => o.active || o.value === value);
      control = (
        <select {...common} className={selectClass} value={str(value)} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Chưa chọn —</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.active ? "" : " (đã tắt)"}
            </option>
          ))}
        </select>
      );
      break;
    }
    case "multi_select": {
      const current = Array.isArray(value) ? value.map(String) : [];
      control = (
        <div id={inputId} aria-invalid={invalid} className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-md border border-input px-3 py-2">
          {field.options.filter((o) => o.active || current.includes(o.value)).map((o) => (
            <label key={o.value} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                disabled={disabled}
                checked={current.includes(o.value)}
                onCheckedChange={(c) => onChange(c === true ? [...current, o.value] : current.filter((x) => x !== o.value))}
              />
              {o.label}
            </label>
          ))}
          {field.options.length === 0 ? <span className="text-xs text-muted-foreground">Chưa khai lựa chọn nào</span> : null}
        </div>
      );
      break;
    }
    case "user":
      control = (
        <select {...common} className={selectClass} value={str(value)} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Chưa chọn —</option>
          {(users ?? []).map((u) => (
            <option key={u.id} value={u.id}>{u.label}</option>
          ))}
          {value && !(users ?? []).some((u) => u.id === value) ? <option value={str(value)}>{str(value)}</option> : null}
        </select>
      );
      break;
    case "relation":
      control = relationOptions && relationOptions.length ? (
        <select {...common} className={selectClass} value={str(value)} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Chưa chọn —</option>
          {relationOptions.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      ) : (
        <Input {...common} className="font-mono" placeholder={field.relationObject ? `Mã ${field.relationObject}` : "Mã bản ghi"} value={str(value)} onChange={(e) => onChange(e.target.value.trim() || null)} />
      );
      break;
    case "file":
      control = <FileControl inputId={inputId} field={field} value={value} onChange={onChange} uploadAction={uploadAction} invalid={invalid} />;
      break;
    case "email":
      control = <Input {...common} type="email" value={str(value)} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "phone":
      control = <Input {...common} type="tel" inputMode="tel" className="font-mono" value={str(value)} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "url":
      control = <Input {...common} type="url" placeholder="https://" value={str(value)} onChange={(e) => onChange(e.target.value)} />;
      break;
    default:
      control = <Input {...common} value={str(value)} onChange={(e) => onChange(e.target.value)} maxLength={field.validation.maxLength} />;
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="flex items-center gap-1 text-sm font-medium">
        {field.label}
        {field.required ? <span className="text-destructive" aria-label="bắt buộc">*</span> : null}
      </label>
      {control}
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
      {!error && field.readOnlyReason ? <p className="text-xs text-muted-foreground">{field.readOnlyReason}</p> : null}
      {!error && !field.readOnlyReason && field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
    </div>
  );
}

function FileControl({ inputId, field, value, onChange, uploadAction, invalid }: { inputId: string; field: ResolvedFormField; value: unknown; onChange: (v: unknown) => void; uploadAction?: UploadAction; invalid?: boolean }) {
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  const current = value ? String(value) : null;
  if (field.readOnly || !uploadAction) {
    return (
      <div className={cn("flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm", !current && "text-muted-foreground")}>
        <Paperclip className="size-4 shrink-0" />
        <span className="truncate font-mono text-xs">{current ?? formatCustomValue({ type: "file", options: [] }, null)}</span>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Input
        id={inputId}
        type="file"
        aria-invalid={invalid}
        disabled={pending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const fd = new FormData();
          fd.set("file", file);
          fd.set("field", field.key);
          setMessage(null);
          startTransition(async () => {
            const res = await uploadAction(fd);
            if (res.ok) {
              onChange(res.id);
              setMessage(`Đã tải lên ${res.filename ?? file.name}`);
            } else setMessage(res.error);
          });
        }}
      />
      <p className="text-xs text-muted-foreground">{pending ? "Đang tải lên…" : (message ?? (current ? `Tệp hiện tại: ${current}` : "Chưa có tệp"))}</p>
    </div>
  );
}

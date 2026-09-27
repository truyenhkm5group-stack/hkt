"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FieldError } from "@/lib/metadata/types";
import { cn } from "@/lib/utils";

/** Nút lên / xuống thay cho kéo-thả: bấm được bằng bàn phím, không lệch trên màn cảm ứng. */
export function MoveButtons({ index, count, onMove, disabled, label }: { index: number; count: number; onMove: (delta: -1 | 1) => void; disabled?: boolean; label: string }) {
  return (
    <span className="inline-flex gap-0.5">
      <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || index === 0} aria-label={`Đưa ${label} lên`} title="Lên" onClick={() => onMove(-1)}>
        <ArrowUp />
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || index >= count - 1} aria-label={`Đưa ${label} xuống`} title="Xuống" onClick={() => onMove(1)}>
        <ArrowDown />
      </Button>
    </span>
  );
}

/** Câu lỗi NGUYÊN VĂN của máy chủ (hoặc của lượt kiểm sớm) dưới đúng ô. */
export function FieldErrors({ errors, className }: { errors: readonly FieldError[]; className?: string }) {
  if (errors.length === 0) return null;
  return (
    <ul className={cn("mt-1 space-y-0.5 text-xs text-destructive", className)} role="alert">
      {errors.map((e, i) => (
        <li key={`${e.field}-${i}`}>{e.message}</li>
      ))}
    </ul>
  );
}

/** Ô tích gọn dùng native checkbox — đủ cho bảng dày, đọc được bằng trình đọc màn hình qua `label`. */
export function Tick({ checked, onChange, disabled, label, title }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; title?: string }) {
  return (
    <input
      type="checkbox"
      className="size-4 cursor-pointer accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export const SELECT_CLASS = "h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-60";

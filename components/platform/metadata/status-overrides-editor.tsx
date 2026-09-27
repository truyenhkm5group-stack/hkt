"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FieldErrors, MoveButtons, Tick } from "@/components/platform/metadata/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveStatusOverridesAdminAction } from "@/lib/actions/metadata-admin";
import type { FieldError } from "@/lib/metadata/types";
import { moveItem, sameConfig, type StatusOverrideRow } from "@/lib/platform-ui/metadata-admin-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ NHÃN / THỨ TỰ / ẨN KHỎI BỘ LỌC CỦA MỘT TRẠNG THÁI HỆ THỐNG ═══════════
 *
 * Giá trị gốc do Core sở hữu (M10): không thêm, không xoá, không đổi chuyển trạng thái, không động tới
 * logistics / COD / ORDER_OUTCOME. Tổ chức chỉ đổi PHẦN HIỂN THỊ. Nhãn để trống = dùng nhãn gốc.
 * Lưu là có hiệu lực ngay (không có nháp — đổi nhãn không đổi dữ liệu nào).
 */
export function StatusOverridesEditor({ objectKey, fieldKey, rows: saved }: { objectKey: string; fieldKey: string; rows: StatusOverrideRow[] }) {
  const [rows, setRows] = useState<StatusOverrideRow[]>(saved);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [pending, startTransition] = useTransition();
  const normalize = (rs: StatusOverrideRow[]) => rs.map((r, i) => ({ value: r.value, label: r.label?.trim() && r.label.trim() !== r.systemLabel ? r.label.trim() : null, position: i, active: r.active }));
  const dirty = !sameConfig(normalize(rows), normalize(saved));
  const patch = (i: number, p: Partial<StatusOverrideRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const save = () =>
    startTransition(async () => {
      try {
        const r = await saveStatusOverridesAdminAction(objectKey, fieldKey, normalize(rows));
        if (r.ok) {
          setErrors([]);
          toast.success("Đã lưu — nhãn mới hiện ở lần tải trang kế tiếp.");
        } else setErrors(r.errors);
      } catch {
        setErrors([{ field: "", message: "Không lưu được — thử lại." }]);
      }
    });

  const rowErrors = (value: string) => errors.filter((e) => e.field === value || e.field.endsWith(`.${value}`));
  const general = errors.filter((e) => !rows.some((r) => rowErrors(r.value).includes(e)));

  return (
    <div className="space-y-3">
      <FieldErrors errors={general} />
      <div className={cn("overflow-x-auto rounded-xl border", pending && "opacity-70")}>
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Giá trị gốc</th>
              <th className="px-3 py-2">Nhãn gốc</th>
              <th className="px-3 py-2">Nhãn hiển thị</th>
              <th className="px-3 py-2">Thứ tự</th>
              <th className="px-3 py-2">Hiện trong bộ lọc</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.value} className="border-t border-hairline align-top">
                <td className="px-3 py-2 font-mono text-[12.5px]">{r.value}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.systemLabel}</td>
                <td className="px-3 py-1.5">
                  <Input className="h-8 max-w-64" value={r.label ?? ""} placeholder={r.systemLabel} maxLength={60} aria-label={`Nhãn hiển thị của ${r.value}`} onChange={(e) => patch(i, { label: e.target.value })} />
                  <FieldErrors errors={rowErrors(r.value)} />
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-flex items-center gap-1">
                    <span className="numeric w-5 text-right text-xs">{i + 1}</span>
                    <MoveButtons index={i} count={rows.length} label={r.value} onMove={(d) => setRows((rs) => moveItem(rs, i, d))} />
                  </span>
                </td>
                <td className="px-3 py-2">
                  <Tick checked={r.active} label={`Hiện ${r.value} trong bộ lọc`} onChange={(v) => patch(i, { active: v })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-2">
        {dirty ? <span className="text-xs text-amber-700 dark:text-amber-400">Có thay đổi chưa lưu</span> : null}
        <Button variant="outline" size="sm" onClick={() => setRows(saved)} disabled={!dirty || pending}>
          Bỏ thay đổi
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || pending}>
          Lưu
        </Button>
      </div>
    </div>
  );
}

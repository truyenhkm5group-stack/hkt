"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";
import { SLA_HOURS_MAX, SLA_HOURS_MIN } from "@/lib/constants/work-sla";
import { setOwnershipRule, setSlaRule } from "@/lib/actions/work";
import { cn } from "@/lib/utils";

/**
 * ═══════════ MỘT LOẠI VIỆC, MỘT DÒNG: AI LÀM · TRONG BAO LÂU ═══════════
 *
 * Hai bảng cấu hình (phòng ban chịu trách nhiệm, hạn xử lý) được ghép thành MỘT lưới vì người đọc
 * chỉ có một câu hỏi: *"việc loại này ai làm và trong bao lâu?"*. Tách hai màn hình thì trưởng
 * phòng phải nhớ mình đã sửa cái nào — và sửa hạn mà quên đổi phòng là cách chắc chắn nhất để một
 * hàng đợi đỏ rực mà không ai trong phòng đó biết.
 *
 * ─── HIỆN CẢ MẶC ĐỊNH LẪN LÝ DO, KHÔNG CHỈ Ô NHẬP ───
 *
 * Mỗi dòng nói rõ con số mặc định là bao nhiêu và VÌ SAO. Một ngưỡng không kèm lý do thì không ai
 * dám sửa, và một ngưỡng đã sửa mà không thấy mặc định cũ thì không ai dám sửa lại.
 */

export type RuleRow = {
  key: string;
  label: string;
  why: string;
  alsoShownOn: string;
  hours: number | null;
  defaultHours: number | null;
  hoursOverridden: boolean;
  /** `null` = loại việc này không gán phòng ở đây (việc tay đi theo người giao). */
  department: DepartmentCode | null;
  defaultDepartment: DepartmentCode | null;
  departmentOverridden: boolean;
};

function HoursCell({ row, disabled, onSave, onReset }: { row: RuleRow; disabled: boolean; onSave: (h: number | null) => void; onReset: () => void }) {
  const [text, setText] = useState(row.hours === null ? "" : String(row.hours));
  const dirty = text.trim() !== (row.hours === null ? "" : String(row.hours));
  const parsed = text.trim() === "" ? null : Number(text);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < SLA_HOURS_MIN || parsed > SLA_HOURS_MAX);

  return (
    <div className="flex items-center gap-1">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        inputMode="numeric"
        placeholder="không đặt"
        aria-label={`Hạn xử lý (giờ) của ${row.label}`}
        className={cn("h-8 w-[92px] text-xs tabular-nums", invalid && "border-destructive")}
      />
      <span className="text-[11px] text-muted-foreground">giờ</span>
      {dirty && !invalid ? (
        <Button size="sm" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => onSave(parsed === null ? null : Math.round(parsed))}>
          Lưu
        </Button>
      ) : null}
      {row.hoursOverridden && !dirty ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-1.5 text-xs"
          disabled={disabled}
          title={`Trả về mặc định: ${row.defaultHours === null ? "không đặt hạn" : `${row.defaultHours} giờ`}`}
          onClick={() => {
            setText(row.defaultHours === null ? "" : String(row.defaultHours));
            onReset();
          }}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export function WorkRulesPanel({ rows }: { rows: RuleRow[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(ok);
      router.refresh();
    });

  // Nhóm theo phòng ban đang hiệu lực: trưởng phòng mở màn hình này để xem PHẦN CỦA MÌNH trước.
  const groups = [
    ...DEPARTMENT_ORDER.map((code) => ({ code: code as DepartmentCode | null, label: DEPARTMENT_LABEL[code], rows: rows.filter((r) => r.department === code) })),
    { code: null, label: "Không gán phòng cố định", rows: rows.filter((r) => r.department === null) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="divide-y">
      {groups.map((g) => (
        <div key={g.label} className="overflow-x-auto">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[46%]">{g.label}</TableHead>
                <TableHead className="w-[190px]">Phòng chịu trách nhiệm</TableHead>
                <TableHead className="w-[210px]">Hạn xử lý</TableHead>
                <TableHead>Mặc định</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="align-top">
                    <p className="text-sm font-medium">{r.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.why}</p>
                    {r.alsoShownOn ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Màn hình <strong>{r.alsoShownOn}</strong> cũng hiện một hạn cho việc này — nó dùng hằng số của module đó, đổi ở đây không đổi nhãn bên ấy.
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">
                    {r.department === null ? (
                      <span className="text-xs text-muted-foreground" title="Việc tay và việc định kỳ đi theo phòng mà người giao chọn">
                        theo người giao
                      </span>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Select
                          value={r.department}
                          onValueChange={(v) => run(() => setOwnershipRule({ key: r.key, department: v as DepartmentCode }), "Đã đổi phòng chịu trách nhiệm")}
                        >
                          <SelectTrigger className="h-8 w-[150px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DEPARTMENT_ORDER.map((c) => (
                              <SelectItem key={c} value={c}>
                                {DEPARTMENT_LABEL[c]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {r.departmentOverridden ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5 text-xs"
                            disabled={pending}
                            title={`Trả về mặc định: ${r.defaultDepartment ? DEPARTMENT_LABEL[r.defaultDepartment] : "—"}`}
                            onClick={() => run(() => setOwnershipRule({ key: r.key, department: null, reset: true }), "Đã trả về mặc định")}
                          >
                            <RotateCcw className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <HoursCell
                      key={`${r.key}:${r.hours ?? "null"}`}
                      row={r}
                      disabled={pending}
                      onSave={(h) => run(() => setSlaRule({ key: r.key, hours: h }), h === null ? "Đã bỏ hạn cho loại việc này" : `Đã đặt hạn ${h} giờ`)}
                      onReset={() => run(() => setSlaRule({ key: r.key, hours: null, reset: true }), "Đã trả về mặc định")}
                    />
                  </TableCell>
                  <TableCell className="align-top text-xs text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="tabular-nums">{r.defaultHours === null ? "không đặt hạn" : `${r.defaultHours} giờ`}</span>
                      {r.hoursOverridden || r.departmentOverridden ? (
                        <Badge variant="secondary" className="text-[10px]">
                          đã sửa
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}

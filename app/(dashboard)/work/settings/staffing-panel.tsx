"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { DEFAULT_WIP_LIMIT } from "@/lib/constants/workforce";
import { patchStaffing } from "@/lib/actions/workforce";
import { cn } from "@/lib/utils";

/**
 * ═══════════ SỨC CHỨA, KỸ NĂNG, NGÀY NGHỈ ═══════════
 *
 * Ba thứ máy phân việc cần mà CSDL nghiệp vụ không biết. Mỗi ô nói rõ mặc định là gì và điều gì
 * xảy ra khi để trống — bỏ trống ô kỹ năng KHÔNG phải là "không làm được gì", nó là "nhận mọi
 * loại việc của phòng", và hai cách đọc đó ngược hẳn nhau.
 */

export type StaffRow = {
  userId: string;
  name: string;
  email: string;
  departments: DepartmentCode[];
  load: number;
  limit: number;
  limitIsOwn: boolean;
  skills: WorkSource[];
  away: { until: string; reason: string } | null;
};

export function StaffingPanel({
  rows,
  departmentWip,
  autoAssign,
  escalationOff,
  sources,
}: {
  rows: StaffRow[];
  departmentWip: Partial<Record<DepartmentCode, number>>;
  autoAssign: Partial<Record<DepartmentCode, boolean>>;
  escalationOff: Partial<Record<DepartmentCode, boolean>>;
  sources: WorkSource[];
}) {
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

  return (
    <div className="divide-y">
      {/* ───── Mức phòng: trần chung + hai công tắc ───── */}
      <div className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Phòng ban</TableHead>
              <TableHead className="w-[170px]">Trần việc mỗi người</TableHead>
              <TableHead className="w-[200px]">Phân việc tự động</TableHead>
              <TableHead className="w-[170px]">Leo thang SLA</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {DEPARTMENT_ORDER.map((d) => (
              <TableRow key={d}>
                <TableCell className="font-medium">{DEPARTMENT_LABEL[d]}</TableCell>
                <TableCell>
                  <WipInput
                    value={departmentWip[d] ?? null}
                    disabled={pending}
                    placeholder={String(DEFAULT_WIP_LIMIT)}
                    ariaLabel={`Trần việc mỗi người của ${DEPARTMENT_LABEL[d]}`}
                    onSave={(n) => run(() => patchStaffing({ departmentWip: { [d]: n } }), `Đã đặt trần ${n} việc cho ${DEPARTMENT_LABEL[d]}`)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={autoAssign[d] === true}
                      disabled={pending}
                      onCheckedChange={(v) => run(() => patchStaffing({ autoAssign: { [d]: v } }), v ? "Đã bật phân việc tự động" : "Đã tắt phân việc tự động")}
                    />
                    <span className="text-xs text-muted-foreground">{autoAssign[d] === true ? "chạy nền" : "chỉ khi bấm nút"}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={escalationOff[d] !== true}
                      disabled={pending}
                      onCheckedChange={(v) => run(() => patchStaffing({ escalationOff: { [d]: !v } }), v ? "Đã bật leo thang" : "Đã tắt leo thang")}
                    />
                    <span className="text-xs text-muted-foreground">{escalationOff[d] !== true ? "bật" : "tắt"}</span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ───── Mức người: trần riêng, kỹ năng, ngày nghỉ ───── */}
      <div className="overflow-x-auto">
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow>
              <TableHead>Người</TableHead>
              <TableHead className="w-[150px]">Đang cầm / trần</TableHead>
              <TableHead className="w-[150px]">Trần riêng</TableHead>
              <TableHead className="w-[190px]">Nhận loại việc</TableHead>
              <TableHead className="w-[180px]">Nghỉ tới</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  Chưa ai được xếp vào phòng ban nào — xếp người ở thẻ bên trên trước.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.userId}>
                  <TableCell>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-[11px] text-muted-foreground">{r.departments.map((d) => DEPARTMENT_LABEL[d]).join(", ") || "chưa xếp phòng"}</p>
                  </TableCell>
                  <TableCell>
                    <span className={cn("tabular-nums", r.load > r.limit && "font-semibold text-destructive")}>
                      {r.load}/{r.limit}
                    </span>
                    <span className="ml-1 text-[11px] text-muted-foreground">{r.limitIsOwn ? "trần riêng" : "theo phòng"}</span>
                  </TableCell>
                  <TableCell>
                    <WipInput
                      value={r.limitIsOwn ? r.limit : null}
                      disabled={pending}
                      placeholder={String(r.limit)}
                      ariaLabel={`Trần việc riêng của ${r.name}`}
                      onSave={(n) => run(() => patchStaffing({ userWip: { [r.userId]: n } }), `Đã đặt trần riêng ${n} việc cho ${r.name}`)}
                    />
                  </TableCell>
                  <TableCell>
                    <SkillPicker
                      name={r.name}
                      selected={r.skills}
                      sources={sources}
                      disabled={pending}
                      onSave={(next) => run(() => patchStaffing({ skills: { [r.userId]: next } }), next.length ? `${r.name} nhận ${next.length} loại việc` : `${r.name} nhận mọi loại việc của phòng`)}
                    />
                  </TableCell>
                  <TableCell>
                    <AwayInput
                      value={r.away}
                      disabled={pending}
                      onSave={(until, reason) => run(() => patchStaffing({ away: { [r.userId]: { until, reason } } }), until ? `Đã ghi ${r.name} nghỉ tới ${until}` : `Đã bỏ đăng ký nghỉ của ${r.name}`)}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function WipInput({ value, placeholder, disabled, ariaLabel, onSave }: { value: number | null; placeholder: string; disabled: boolean; ariaLabel: string; onSave: (n: number) => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const n = Number(text);
  const dirty = text.trim() !== (value === null ? "" : String(value));
  const ok = text.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= 500;
  return (
    <div className="flex items-center gap-1">
      <Input value={text} onChange={(e) => setText(e.target.value)} inputMode="numeric" placeholder={placeholder} aria-label={ariaLabel} className={cn("h-8 w-[78px] text-xs tabular-nums", dirty && !ok && text.trim() !== "" && "border-destructive")} />
      {dirty && ok ? (
        <Button size="sm" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => onSave(Math.round(n))}>
          Lưu
        </Button>
      ) : null}
    </div>
  );
}

function SkillPicker({ name, selected, sources, disabled, onSave }: { name: string; selected: WorkSource[]; sources: WorkSource[]; disabled: boolean; onSave: (next: WorkSource[]) => void }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<WorkSource[]>(selected);
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) setSel(selected); }}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 w-full justify-start text-xs" disabled={disabled}>
          {selected.length ? `${selected.length} loại` : "mọi loại của phòng"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 p-2.5" align="start">
        <p className="text-xs text-muted-foreground">
          Bỏ trống = <strong>{name} nhận mọi loại việc của phòng mình</strong>. Chọn loại cụ thể chỉ để THU HẸP — không bao giờ mở rộng sang phòng khác.
        </p>
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {sources.map((s) => (
            <label key={s} className="flex items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={sel.includes(s)}
                onChange={(e) => setSel((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
              />
              <span>{WORK_SOURCE_SPEC[s]?.label ?? s}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" className="flex-1 text-xs" onClick={() => { onSave(sel); setOpen(false); }}>
            Lưu
          </Button>
          <Button size="sm" variant="ghost" className="text-xs" title="Trả về: nhận mọi loại việc của phòng" onClick={() => { onSave([]); setOpen(false); }}>
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AwayInput({ value, disabled, onSave }: { value: { until: string; reason: string } | null; disabled: boolean; onSave: (until: string, reason: string) => void }) {
  const [until, setUntil] = useState(value?.until?.slice(0, 10) ?? "");
  // Lý do nghỉ giữ nguyên khi sửa ngày: ô ngày là thứ người ta đổi, lý do thì gõ một lần.
  const reason = value?.reason ?? "";
  const dirty = until !== (value?.until?.slice(0, 10) ?? "");
  return (
    <div className="flex items-center gap-1">
      <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Nghỉ tới ngày" className="h-8 w-[130px] text-xs" />
      {dirty ? (
        <Button size="sm" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => onSave(until, reason)}>
          Lưu
        </Button>
      ) : value ? (
        <Badge variant="secondary" className="text-[10px]">đang nghỉ</Badge>
      ) : null}
    </div>
  );
}

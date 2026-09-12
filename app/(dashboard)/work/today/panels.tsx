"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PlayCircle, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { autoAssign, bulkAssign, reassignWork } from "@/lib/actions/workforce";
import { formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ PHÂN VIỆC: NHÌN TRƯỚC RỒI MỚI BẤM ═══════════
 *
 * Nút "Phân việc tự động" KHÔNG ghi gì ở lần bấm đầu. Nó chạy thử và mở ra đúng thứ sẽ xảy ra:
 * ai nhận việc nào, vì sao là người đó, sau khi áp thì mỗi người cầm bao nhiêu so với trần, và
 * bao nhiêu việc KHÔNG xếp được kèm lý do. Chỉ nút thứ hai mới ghi.
 *
 * Phần "không xếp được" quan trọng ngang phần xếp được: nó là chỗ duy nhất trưởng phòng đọc ra
 * "phòng tôi thiếu người", chứ không phải "máy phân việc chạy chưa hết".
 */

type PlanRow = { key: string; title: string; userId: string; userName: string; why: string; overdue: boolean; moneyAtRisk: number | null };
type AfterRow = { userId: string; name: string; before: number; added: number; after: number; limit: number };
type UnplacedSummary = { reason: string; count: number; label: string; fix: string };

export function AutoAssignButton({ department, unassigned }: { department: DepartmentCode; unassigned: number }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [after, setAfter] = useState<AfterRow[]>([]);
  const [unplaced, setUnplaced] = useState<UnplacedSummary[]>([]);
  const [considered, setConsidered] = useState(0);
  const router = useRouter();

  const chayThu = () =>
    start(async () => {
      const r = await autoAssign({ department });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setRows(r.plan.assignments);
      setAfter(r.plan.after);
      setUnplaced(r.summary);
      setConsidered(r.plan.considered);
      setOpen(true);
    });

  const apDung = () =>
    start(async () => {
      const r = await autoAssign({ department, apply: true });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã giao ${r.applied} việc${r.failed ? ` · ${r.failed} việc không ghi được` : ""}`);
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="outline" disabled={pending || unassigned === 0} onClick={chayThu} title={unassigned === 0 ? "Không còn việc nào chưa ai nhận" : "Chạy thử — chưa ghi gì cả"}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />} Phân việc tự động
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Xem trước · {DEPARTMENT_LABEL[department]}</DialogTitle>
            <DialogDescription>
              Đã xét {considered} việc chưa ai nhận. <strong>Chưa ghi gì cả</strong> — bấm &ldquo;Áp dụng&rdquo; mới giao thật. Việc khó nhất được chọn người trước,
              lúc mọi người còn chỗ trống.
            </DialogDescription>
          </DialogHeader>

          {unplaced.length ? (
            <div className="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {unplaced.map((u) => (
                <div key={u.reason}>
                  <p className="font-medium">
                    {u.count} việc không xếp được — {u.label}
                  </p>
                  <p className="text-xs">{u.fix}</p>
                </div>
              ))}
            </div>
          ) : null}

          {after.length ? (
            <div className="rounded-lg border p-2.5">
              <p className="mb-1.5 text-xs font-medium">Sau khi áp dụng</p>
              <div className="flex flex-wrap gap-2">
                {after.map((a) => (
                  <Badge key={a.userId} variant="secondary" className={cn("text-[11px]", a.after > a.limit && "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300")}>
                    {a.name}: {a.before} → <strong className="mx-0.5">{a.after}</strong>/{a.limit} (+{a.added})
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {rows.length ? (
            <div className="max-h-[40vh] overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Việc</TableHead>
                    <TableHead className="w-[170px]">Giao cho</TableHead>
                    <TableHead className="w-[240px]">Vì sao người này</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell>
                        <p className="line-clamp-1 text-sm" title={r.title}>{r.title}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {r.overdue ? <span className="font-medium text-destructive">quá hạn</span> : "trong hạn"}
                          {r.moneyAtRisk !== null ? ` · ${formatVND(r.moneyAtRisk, { compact: true })}` : " · chưa tra được tiền"}
                        </p>
                      </TableCell>
                      <TableCell className="text-sm font-medium">{r.userName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.why}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Không việc nào xếp được. Xem lý do ở trên.</p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Đóng</Button>
            <Button disabled={pending || rows.length === 0} onClick={apDung}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Áp dụng · giao {rows.length} việc
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Chuyển một việc sang người khác, hoặc trả lại hàng đợi phòng. */
export function ReassignSelect({ workKey, current, people }: { workKey: string; current: string; people: { id: string; name: string; free: number; limit: number; away: boolean }[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Select
      value=""
      onValueChange={(v) =>
        start(async () => {
          const r = await reassignWork({ key: workKey, userId: v === "__none" ? null : v });
          if ("error" in r) {
            toast.error(r.error);
            return;
          }
          toast.success(v === "__none" ? "Đã trả về hàng đợi phòng" : "Đã chuyển việc");
          router.refresh();
        })
      }
    >
      <SelectTrigger className="h-7 w-[150px] text-xs" disabled={pending}>
        <span className="flex items-center gap-1 truncate">
          <Users className="size-3 shrink-0" /> {current || "chưa ai nhận"}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">— trả về hàng đợi phòng</SelectItem>
        {people.map((p) => (
          <SelectItem key={p.id} value={p.id} disabled={p.away}>
            {p.name} · {p.away ? "đang nghỉ" : `còn ${p.free}/${p.limit}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Giao một loạt việc đang chọn cho một người. Chặn vượt trần trừ khi người bấm khai rõ. */
export function BulkAssignBar({ keys, people, onDone }: { keys: string[]; people: { id: string; name: string; free: number; limit: number; away: boolean }[]; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [force, setForce] = useState(false);
  const router = useRouter();
  if (!keys.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2.5 text-sm">
      <span className="font-medium">{keys.length} việc đang chọn</span>
      <Select
        value=""
        onValueChange={(v) =>
          start(async () => {
            const r = await bulkAssign({ keys, userId: v, force });
            if ("error" in r) {
              toast.error(r.error);
              return;
            }
            toast.success(`Đã giao ${r.assigned} việc${r.skipped ? ` · ${r.skipped} việc không ghi được` : ""}`);
            onDone();
            router.refresh();
          })
        }
      >
        <SelectTrigger className="h-8 w-[200px] text-xs" disabled={pending}>
          <SelectValue placeholder="Giao cho…" />
        </SelectTrigger>
        <SelectContent>
          {people.map((p) => (
            <SelectItem key={p.id} value={p.id} disabled={p.away && !force}>
              {p.name} · {p.away ? "đang nghỉ" : `còn ${p.free}/${p.limit}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        giao vượt trần (ghi vào nhật ký)
      </label>
      <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={onDone}>
        Bỏ chọn
      </Button>
    </div>
  );
}

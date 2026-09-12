"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Plus, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEPARTMENT_ROLE_LABEL } from "@/lib/constants/departments";
import { WORK_PRIORITIES, WORK_PRIORITY_LABEL } from "@/lib/constants/work";
import { deleteRecurrence, removeDepartmentMember, runRecurrenceNow, saveDepartment, saveRecurrence, setDepartmentMember } from "@/lib/actions/work";

type Member = { userId: string; name: string; roleInDept: string; active: boolean };
type Dept = { id: string; code: string; name: string; leadUserId: string | null; active: boolean; members: Member[] };

const CADENCES = [
  { value: "DAILY", label: "Hằng ngày" },
  { value: "WEEKDAYS", label: "Thứ Hai → thứ Sáu" },
  { value: "WEEKLY", label: "Hằng tuần" },
  { value: "MONTHLY", label: "Hằng tháng" },
];
const WEEKDAYS = ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ nhật"];

export function DepartmentsPanel({ departments, people }: { departments: Dept[]; people: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");

  const run = (fn: () => Promise<{ ok: true } | { error: string } | { ok: true; id: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) { toast.error(r.error); return; }
      toast.success(ok);
      router.refresh();
    });

  return (
    <div className="divide-y">
      {departments.map((d) => (
        <div key={d.id} className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.name}</span>
            <Badge variant="outline" className="text-[11px]">{d.code}</Badge>
            {!d.active ? <Badge variant="secondary" className="text-[11px]">ngừng dùng</Badge> : null}
            <div className="ml-auto flex items-center gap-2">
              <Select
                value={d.leadUserId ?? "none"}
                onValueChange={(v) => run(() => saveDepartment({ id: d.id, code: d.code, name: d.name, leadUserId: v === "none" ? null : v, active: d.active }), "Đã đổi trưởng phòng")}
              >
                <SelectTrigger className="h-8 w-[190px] text-xs"><SelectValue placeholder="Chưa có trưởng phòng" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Chưa có trưởng phòng</SelectItem>
                  {people.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Switch checked={d.active} disabled={pending} onCheckedChange={(v) => run(() => saveDepartment({ id: d.id, code: d.code, name: d.name, leadUserId: d.leadUserId, active: v }), v ? "Đã bật lại phòng" : "Đã ngừng dùng phòng")} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {d.members.filter((m) => m.active).map((m) => (
              <Badge key={m.userId} variant="secondary" className="gap-1 pr-1 text-[11px]">
                {m.name}
                <span className="text-muted-foreground">· {DEPARTMENT_ROLE_LABEL[m.roleInDept as "LEAD" | "MEMBER"]}</span>
                <button type="button" aria-label={`Bỏ ${m.name} khỏi phòng`} className="rounded p-0.5 hover:bg-background" onClick={() => run(() => removeDepartmentMember({ departmentId: d.id, userId: m.userId }), "Đã bỏ khỏi phòng")}>
                  <UserMinus className="size-3" />
                </button>
              </Badge>
            ))}
            <Select value="" onValueChange={(v) => run(() => setDepartmentMember({ departmentId: d.id, userId: v, roleInDept: "MEMBER" }), "Đã thêm thành viên")}>
              <SelectTrigger className="h-7 w-[150px] text-xs"><span className="flex items-center gap-1"><UserPlus className="size-3" /> Thêm người</span></SelectTrigger>
              <SelectContent>
                {people.filter((p) => !d.members.some((m) => m.active && m.userId === p.id)).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-end gap-2 bg-muted/30 p-3">
        <div className="grid gap-1">
          <Label htmlFor="d-code" className="text-xs">Mã phòng</Label>
          <Input id="d-code" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} placeholder="DESIGN" className="h-8 w-[140px]" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="d-name" className="text-xs">Tên hiển thị</Label>
          <Input id="d-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Thiết kế" className="h-8 w-[200px]" />
        </div>
        <Button size="sm" disabled={pending || newCode.length < 2 || newName.length < 2} onClick={() => run(async () => { const r = await saveDepartment({ code: newCode, name: newName }); if (!("error" in r)) { setNewCode(""); setNewName(""); } return r; }, "Đã thêm phòng ban")}>
          <Plus className="size-4" /> Thêm phòng
        </Button>
      </div>
    </div>
  );
}

type Rec = { id: string; title: string; cadence: string; cadenceDay: number | null; hourOfDay: number; dueInHours: number; active: boolean; departmentId: string | null; assigneeId: string | null; lastGeneratedKey: string };

export function RecurrencePanel({ rows, departments, people }: { rows: Rec[]; departments: { id: string; code: string; name: string }[]; people: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState(departments[0]?.code ?? "MANAGEMENT");
  const [cadence, setCadence] = useState("DAILY");
  const [cadenceDay, setCadenceDay] = useState("1");
  const [hourOfDay, setHourOfDay] = useState("8");
  const [priority, setPriority] = useState("NORMAL");
  const [assigneeId, setAssigneeId] = useState("");

  const run = (fn: () => Promise<{ ok: true } | { error: string } | { ok: true; id: string } | { ok: true; created: number; skipped: number }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("created" in r ? `Đã sinh ${r.created} việc (bỏ qua ${r.skipped})` : ok);
      router.refresh();
    });

  return (
    <div>
      <div className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Việc</TableHead>
              <TableHead className="w-[170px]">Nhịp</TableHead>
              <TableHead className="w-[90px]">Giờ</TableHead>
              <TableHead className="w-[110px]">Hạn sau</TableHead>
              <TableHead className="w-[120px]">Kỳ gần nhất</TableHead>
              <TableHead className="w-[130px] text-right">Bật</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">Chưa có việc định kỳ nào.</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.title}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {CADENCES.find((c) => c.value === r.cadence)?.label}
                  {r.cadence === "WEEKLY" && r.cadenceDay ? ` · ${WEEKDAYS[r.cadenceDay - 1]}` : ""}
                  {r.cadence === "MONTHLY" && r.cadenceDay ? ` · ngày ${r.cadenceDay}` : ""}
                </TableCell>
                <TableCell className="tabular-nums">{String(r.hourOfDay).padStart(2, "0")}:00</TableCell>
                <TableCell className="tabular-nums">{r.dueInHours} giờ</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.lastGeneratedKey || "chưa sinh lần nào"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Switch checked={r.active} disabled={pending} onCheckedChange={() => run(() => saveRecurrence({ id: r.id, title: r.title, department: departments.find((d) => d.id === r.departmentId)?.code ?? "MANAGEMENT", cadence: r.cadence, cadenceDay: r.cadenceDay, hourOfDay: r.hourOfDay, dueInHours: r.dueInHours, assigneeId: r.assigneeId, active: !r.active }), "Đã cập nhật")} />
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => run(() => deleteRecurrence(r.id), "Đã xoá định nghĩa — việc đã sinh vẫn giữ nguyên")}>Xoá</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-end gap-2 border-t bg-muted/30 p-3">
        <div className="grid gap-1">
          <Label htmlFor="r-title" className="text-xs">Việc lặp</Label>
          <Input id="r-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Đối soát COD hằng ngày" className="h-8 w-[230px]" />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">Phòng</Label>
          <Select value={department} onValueChange={setDepartment}>
            <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{departments.map((d) => <SelectItem key={d.code} value={d.code}>{d.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">Nhịp</Label>
          <Select value={cadence} onValueChange={setCadence}>
            <SelectTrigger className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{CADENCES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {cadence === "WEEKLY" || cadence === "MONTHLY" ? (
          <div className="grid gap-1">
            <Label className="text-xs">{cadence === "WEEKLY" ? "Thứ" : "Ngày (1–28)"}</Label>
            <Select value={cadenceDay} onValueChange={setCadenceDay}>
              <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(cadence === "WEEKLY" ? WEEKDAYS.map((w, i) => ({ v: String(i + 1), l: w })) : Array.from({ length: 28 }, (_, i) => ({ v: String(i + 1), l: `Ngày ${i + 1}` }))).map((o) => (
                  <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="grid gap-1">
          <Label htmlFor="r-hour" className="text-xs">Giờ sinh</Label>
          <Input id="r-hour" type="number" min={0} max={23} value={hourOfDay} onChange={(e) => setHourOfDay(e.target.value)} className="h-8 w-[80px]" />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">Mức ưu tiên</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{WORK_PRIORITIES.map((p) => <SelectItem key={p} value={p}>{WORK_PRIORITY_LABEL[p]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">Giao cho</Label>
          <Select value={assigneeId || "none"} onValueChange={(v) => setAssigneeId(v === "none" ? "" : v)}>
            <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue placeholder="Chưa giao ai" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Chưa giao ai</SelectItem>
              {people.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" disabled={pending || title.trim().length < 2} onClick={() => run(async () => { const r = await saveRecurrence({ title, department, cadence, cadenceDay: cadence === "WEEKLY" || cadence === "MONTHLY" ? Number(cadenceDay) : null, hourOfDay: Number(hourOfDay), priority, assigneeId: assigneeId || null }); if (!("error" in r)) setTitle(""); return r; }, "Đã thêm việc định kỳ")}>
          <Plus className="size-4" /> Thêm
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => runRecurrenceNow(), "")}>
          <Play className="size-4" /> Sinh việc kỳ này
        </Button>
      </div>
    </div>
  );
}

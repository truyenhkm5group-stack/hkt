"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";
import { WORK_PRIORITIES, WORK_PRIORITY_LABEL } from "@/lib/constants/work";
import { saveManualTask } from "@/lib/actions/work";

/**
 * Giao việc tay. Cố ý NHỎ: tiêu đề, mô tả, phòng, người, mức ưu tiên, hạn.
 *
 * Không có ước lượng giờ, không có phụ thuộc giữa các việc, không có sprint. V1 phải dùng được
 * hằng ngày chứ không phải thay Jira — và mỗi ô thừa là một ô người ta bỏ trống rồi thấy phiền.
 */
export function ManualTaskDialog({ members, defaultDepartment }: { members: { id: string; name: string; departments: string[] }[]; defaultDepartment?: DepartmentCode }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [department, setDepartment] = useState<DepartmentCode>(defaultDepartment ?? "MANAGEMENT");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [priority, setPriority] = useState<string>("NORMAL");
  const [dueAt, setDueAt] = useState("");
  const router = useRouter();

  const submit = () =>
    startTransition(async () => {
      const r = await saveManualTask({
        title,
        summary,
        department,
        assigneeId: assigneeId || null,
        priority,
        // `datetime-local` không mang múi giờ; trình duyệt của nhân viên ở Việt Nam nên `new Date`
        // diễn giải đúng giờ họ gõ, rồi `toISOString` đưa về UTC để lưu.
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã tạo việc");
      setOpen(false);
      setTitle("");
      setSummary("");
      setDueAt("");
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="size-4" /> Giao việc</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Giao việc tay</DialogTitle>
          <DialogDescription>Việc không sinh ra từ sự kiện nghiệp vụ nào — bạn tự đặt và tự đóng.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="mt-title">Tiêu đề</Label>
            <Input id="mt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Gọi xưởng chốt ngày giao lô áo thun" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mt-summary">Chi tiết</Label>
            <Textarea id="mt-summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Cần gì để coi là xong?" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Phòng ban</Label>
              <Select value={department} onValueChange={(v) => setDepartment(v as DepartmentCode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEPARTMENT_ORDER.map((d) => <SelectItem key={d} value={d}>{DEPARTMENT_LABEL[d]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Giao cho</Label>
              <Select value={assigneeId || "none"} onValueChange={(v) => setAssigneeId(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="Chưa giao ai" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Chưa giao ai</SelectItem>
                  {members.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}{m.departments.length ? ` · ${m.departments[0]}` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Mức ưu tiên</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WORK_PRIORITIES.map((p) => <SelectItem key={p} value={p}>{WORK_PRIORITY_LABEL[p]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mt-due">Hạn</Label>
              <Input id="mt-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
          <Button disabled={pending || title.trim().length < 2} onClick={submit}>Tạo việc</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

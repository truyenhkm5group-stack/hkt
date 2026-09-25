"use client";

import { Loader2, Plus } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTechTaskAction } from "@/lib/actions/tech";
import {
  TECH_MODULES,
  TECH_MODULE_LABEL,
  TECH_PRIORITIES,
  TECH_PRIORITY_LABEL,
  TECH_RISK_HINT,
  TECH_RISK_LABEL,
  TECH_TASK_SOURCES,
  TECH_TASK_SOURCE_LABEL,
  TECH_TASK_TYPES,
  TECH_TASK_TYPE_LABEL,
  type TechModule,
  type TechPriority,
  type TechTaskSource,
  type TechTaskType,
} from "@/lib/constants/tech";
import { classifyTechRisk, techRiskEmptyReason } from "@/lib/constants/tech-risk";

/**
 * Biểu mẫu ghi việc Tech.
 *
 * ĐIỂM QUAN TRỌNG: mức rủi ro được xếp NGAY TRONG LÚC GÕ, và lý do hiện ra ngay bên dưới. Máy xếp
 * bằng `classifyTechRisk` — một hàm THUẦN, client-safe, và là CÙNG hàm mà máy chủ chạy lại khi lưu.
 * Người gõ nhìn thấy cổng phê duyệt trước khi bấm Lưu, thay vì bị nó chặn sau đó mà không hiểu vì
 * sao. Kết quả hiện ở đây KHÔNG phải là thứ được lưu: máy chủ tự tính lại (không tin client).
 */
export function TechTaskForm() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<TechTaskType>("BUGFIX");
  const [module, setModule] = useState<TechModule>("PLATFORM");
  const [priority, setPriority] = useState<TechPriority>("P2");
  const [source, setSource] = useState<TechTaskSource>("OWNER");
  const [branch, setBranch] = useState("");
  const [pending, start] = useTransition();

  const xep = useMemo(() => classifyTechRisk({ taskType, module, title, description }), [taskType, module, title, description]);

  const dong = () => {
    setOpen(false);
    setTitle("");
    setDescription("");
    setBranch("");
    setTaskType("BUGFIX");
    setModule("PLATFORM");
    setPriority("P2");
    setSource("OWNER");
  };

  const gui = () => {
    start(async () => {
      const res = await createTechTaskAction({ title, description, taskType, module, priority, source, branch });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã ghi việc ${res.code}`);
      dong();
    });
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Ghi việc Tech
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Ghi một việc Tech</DialogTitle>
            <DialogDescription>Mức rủi ro do luật xếp trong lúc gõ. Đổi được sau, nhưng phải kèm lý do.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tech-title">Tiêu đề</Label>
              <Input id="tech-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Bảng lương tháng 9 lệch 240.000đ so với sổ ngân hàng" />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Loại việc</Label>
                <Select value={taskType} onValueChange={(v) => setTaskType(v as TechTaskType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_TASK_TYPES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {TECH_TASK_TYPE_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Module bị chạm</Label>
                <Select value={module} onValueChange={(v) => setModule(v as TechModule)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_MODULES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {TECH_MODULE_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Mức ưu tiên</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as TechPriority)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_PRIORITIES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {TECH_PRIORITY_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Nguồn</Label>
                <Select value={source} onValueChange={(v) => setSource(v as TechTaskSource)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_TASK_SOURCES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {TECH_TASK_SOURCE_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tech-desc">Mô tả</Label>
              <Textarea
                id="tech-desc"
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Hiện tượng · số đo · nơi nhìn thấy · điều gì phải đúng sau khi sửa"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tech-branch">Nhánh git (nếu đã có)</Label>
              <Input id="tech-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="claude/ten-viec" />
            </div>

            <div className="rounded-lg border bg-surface-sunken/40 p-3 text-xs">
              <p className="font-semibold">
                Máy xếp: {TECH_RISK_LABEL[xep.risk]}
                {xep.requiresApproval ? " — cần chủ shop phê duyệt trước khi deploy" : ""}
              </p>
              <p className="mt-0.5 text-muted-foreground">{TECH_RISK_HINT[xep.risk]}</p>
              <ul className="mt-1.5 space-y-1 text-muted-foreground">
                {xep.reasons.length ? xep.reasons.map((r) => <li key={r}>· {r}</li>) : <li>· {techRiskEmptyReason(module)}</li>}
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={dong} disabled={pending}>
              Huỷ
            </Button>
            <Button onClick={gui} disabled={pending || title.trim().length < 5}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu việc
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

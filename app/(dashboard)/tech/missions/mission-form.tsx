"use client";

import { Flag, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTechMissionAction } from "@/lib/actions/tech-control-plane";
import { TECH_PRIORITIES, TECH_PRIORITY_LABEL, type TechPriority } from "@/lib/constants/tech";

/**
 * Một sứ mệnh = một nhóm việc giao được, có định nghĩa XONG kiểm được. Sinh ra ở "Đang lập kế hoạch":
 * worker chưa nhận việc của nó cho tới khi người bấm "Bắt đầu".
 */
export function MissionForm({ goalId, goalCode, projects }: { goalId?: string; goalCode?: string; projects: { key: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [definitionOfDone, setDefinitionOfDone] = useState("");
  const [priority, setPriority] = useState<TechPriority>("P2");
  const [project, setProject] = useState("");
  const [pending, start] = useTransition();

  const dong = () => {
    setOpen(false);
    setTitle("");
    setObjective("");
    setDefinitionOfDone("");
    setPriority("P2");
    setProject("");
  };

  const gui = () =>
    start(async () => {
      const res = await createTechMissionAction({ title, objective, definitionOfDone, priority, goalId: goalId ?? null, project: project || null });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã tạo sứ mệnh ${res.code}`);
      dong();
    });

  return (
    <>
      <Button size="sm" variant={goalId ? "outline" : "default"} onClick={() => setOpen(true)}>
        <Flag className="size-4" /> Thêm sứ mệnh
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Thêm sứ mệnh{goalCode ? ` cho ${goalCode}` : ""}</DialogTitle>
            <DialogDescription>Sứ mệnh mới ở trạng thái “Đang lập kế hoạch” — chưa worker nào nhận việc của nó cho tới khi bạn bấm Bắt đầu.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mis-title">Tên sứ mệnh</Label>
              <Input id="mis-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Thu phí gói đầu tiên qua chuyển khoản" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
                <Label>Dự án</Label>
                <Select value={project} onValueChange={setProject}>
                  <SelectTrigger>
                    <SelectValue placeholder={goalId ? "Theo mục tiêu" : "Chọn dự án"} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mis-obj">Mục đích</Label>
              <Textarea id="mis-obj" rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mis-dod">Xong nghĩa là gì (kiểm được)</Label>
              <Textarea id="mis-dod" rows={3} value={definitionOfDone} onChange={(e) => setDefinitionOfDone(e.target.value)} placeholder="Ví dụ: khách chuyển khoản → gói tự gia hạn trong 5 phút; có bài kiểm" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={dong} disabled={pending}>
              Huỷ
            </Button>
            <Button onClick={gui} disabled={pending || title.trim().length < 5}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu sứ mệnh
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

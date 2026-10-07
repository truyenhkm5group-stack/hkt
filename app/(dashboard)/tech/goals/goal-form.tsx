"use client";

import { Loader2, Target } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTechGoalAction, seedTechProjectsAction } from "@/lib/actions/tech-control-plane";
import { TECH_PRIORITIES, TECH_PRIORITY_LABEL, type TechPriority } from "@/lib/constants/tech";

/** Chưa có dự án nào ⇒ một nút gieo bốn dự án mặc định (người bấm — không migration nào tự gieo). */
export function SeedProjects() {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await seedTechProjectsAction();
          if ("error" in res) toast.error(res.error);
          else toast.success(`Đã thêm ${res.created} dự án`);
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : null} Khởi tạo dự án (ERP · ChotDonTuDong · HSLC · SaaS)
    </Button>
  );
}

/**
 * Chủ shop đặt MỤC TIÊU bằng lời thường ("ChotDonTuDong sẵn sàng cho 10 khách trả tiền đầu tiên"). Không
 * hỏi nhánh, PR hay agent — chia mục tiêu thành sứ mệnh và việc là việc của Planner / Tech Lead.
 */
export function GoalForm({ projects }: { projects: { key: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [priority, setPriority] = useState<TechPriority>("P1");
  const [project, setProject] = useState(projects[0]?.key ?? "");
  const [activate, setActivate] = useState(true);
  const [pending, start] = useTransition();

  const dong = () => {
    setOpen(false);
    setTitle("");
    setDescription("");
    setSuccessCriteria("");
    setPriority("P1");
    setActivate(true);
  };

  const gui = () =>
    start(async () => {
      const res = await createTechGoalAction({ title, description, successCriteria, priority, project: project || null, activate });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã tạo mục tiêu ${res.code}`);
      dong();
    });

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Target className="size-4" /> Đặt mục tiêu
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Đặt một mục tiêu</DialogTitle>
            <DialogDescription>Viết bằng lời thường. Mục tiêu được chia thành sứ mệnh → việc; bạn chỉ quay lại khi có việc “Cần chủ shop”.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="goal-title">Mục tiêu</Label>
              <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: ChotDonTuDong sẵn sàng bán cho 10 khách trả tiền đầu tiên" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Dự án</Label>
                <Select value={project} onValueChange={setProject}>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn dự án" />
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
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-desc">Bối cảnh</Label>
              <Textarea id="goal-desc" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Vì sao cần, ai dùng, hạn chót nếu có" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-success">Đạt được nghĩa là gì</Label>
              <Textarea id="goal-success" rows={3} value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} placeholder="Đo bằng gì — ví dụ: 10 tổ chức trả tiền gói Growth, 0 sự cố SEV1 trong 14 ngày" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
              Bắt đầu theo đuổi ngay (bỏ chọn = lưu nháp)
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={dong} disabled={pending}>
              Huỷ
            </Button>
            <Button onClick={gui} disabled={pending || title.trim().length < 5}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu mục tiêu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

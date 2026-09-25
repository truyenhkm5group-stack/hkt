"use client";

import { Loader2, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTechIncidentAction } from "@/lib/actions/tech";
import {
  TECH_INCIDENT_SEVERITIES,
  TECH_INCIDENT_SEVERITY_LABEL,
  TECH_MODULES,
  TECH_MODULE_LABEL,
  type TechIncidentSeverity,
  type TechModule,
} from "@/lib/constants/tech";

/**
 * Mở một sự cố.
 *
 * Ô "bằng chứng" đứng ngay trong biểu mẫu, không phải một trường thêm vào sau: một sự cố không có
 * bằng chứng là một linh cảm, và linh cảm thì không xếp mức nặng nhẹ được. Ô "nguyên nhân gốc" cố
 * ý KHÔNG có ở đây — lúc mở sự cố thì chưa ai biết, và một ô trống hỏi lúc đó chỉ đẻ ra phỏng đoán.
 */
export function TechIncidentForm() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<TechIncidentSeverity>("SEV2");
  const [module, setModule] = useState<TechModule>("PLATFORM");
  const [evidence, setEvidence] = useState("");
  const [pending, start] = useTransition();

  const dong = () => {
    setOpen(false);
    setTitle("");
    setEvidence("");
    setSeverity("SEV2");
    setModule("PLATFORM");
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Mở sự cố
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Mở một sự cố</DialogTitle>
            <DialogDescription>Ghi thứ ĐÃ QUAN SÁT ĐƯỢC. Nguyên nhân gốc để sau — lúc này chưa ai biết, và đoán bây giờ là đoán mãi mãi.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="inc-title">Tiêu đề</Label>
              <Input id="inc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Trang Vận đơn trả lỗi 500 từ 14:10" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Mức nặng</Label>
                <Select value={severity} onValueChange={(v) => setSeverity(v as TechIncidentSeverity)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_INCIDENT_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {TECH_INCIDENT_SEVERITY_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Module bị ảnh hưởng</Label>
                <Select value={module} onValueChange={(v) => setModule(v as TechModule)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_MODULES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {TECH_MODULE_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inc-evidence">Bằng chứng</Label>
              <Textarea id="inc-evidence" rows={4} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Log, số đo, ảnh màn hình, câu truy vấn — thứ người khác kiểm lại được" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={dong} disabled={pending}>
              Huỷ
            </Button>
            <Button
              disabled={pending || title.trim().length < 5}
              onClick={() =>
                start(async () => {
                  const res = await createTechIncidentAction({ title, severity, module, evidence, source: "STAFF" });
                  if ("error" in res) {
                    toast.error(res.error);
                    return;
                  }
                  toast.success(`Đã mở sự cố ${res.code}`);
                  dong();
                })
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Mở sự cố
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

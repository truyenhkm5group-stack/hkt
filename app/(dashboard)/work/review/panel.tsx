"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { finalizeReview, openReview, saveReviewNotes } from "@/lib/actions/okr";

const KINDS = [
  { value: "WEEKLY", label: "Review tuần" },
  { value: "MONTHLY", label: "Review tháng" },
  { value: "QUARTERLY", label: "Review quý" },
];

export function ReviewToolbar({ departments }: { departments: { code: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [kind, setKind] = useState("WEEKLY");
  const [department, setDepartment] = useState("");
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><CalendarPlus className="size-4" /> Mở kỳ review</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mở kỳ review</DialogTitle>
          <DialogDescription>Kỳ được suy từ hôm nay theo giờ Việt Nam. Mở lại cùng một kỳ thì trả về đúng kỳ đã có, không tạo bản trùng.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Loại kỳ</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Phạm vi</Label>
            <Select value={department || "none"} onValueChange={(v) => setDepartment(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Toàn shop</SelectItem>
                {departments.map((d) => <SelectItem key={d.code} value={d.code}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await openReview({ kind, department: department || null });
                if ("error" in r) { toast.error(r.error); return; }
                toast.success("Đã mở kỳ review");
                setOpen(false);
                router.push(`/work/review?id=${r.id}`);
                router.refresh();
              })
            }
          >
            Mở kỳ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ba ô nhận xét và nút chốt.
 *
 * Kỳ đã chốt thì ô chuyển sang chỉ đọc — nhận xét cũng là một phần của biên bản đã chốt, sửa được
 * sau khi chốt thì "chốt" không còn nghĩa gì.
 */
export function ReviewPanel({ id, frozen, canManage, highlights, issues, nextActions }: { id: string; frozen: boolean; canManage: boolean; highlights: string; issues: string; nextActions: string }) {
  const [h, setH] = useState(highlights);
  const [i, setI] = useState(issues);
  const [n, setN] = useState(nextActions);
  const [pending, start] = useTransition();
  const router = useRouter();
  const readOnly = frozen || !canManage;

  return (
    <SectionCard
      title="Biên bản"
      description={frozen ? "Kỳ đã chốt — biên bản không sửa được nữa." : "Ghi lại điều đã làm được, điểm nghẽn, và việc tiếp theo."}
      actions={
        !frozen && canManage ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await saveReviewNotes({ id, highlights: h, issues: i, nextActions: n }); if ("error" in r) toast.error(r.error); else { toast.success("Đã lưu biên bản"); router.refresh(); } })}>
              Lưu
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const save = await saveReviewNotes({ id, highlights: h, issues: i, nextActions: n });
                  if ("error" in save) { toast.error(save.error); return; }
                  const r = await finalizeReview(id);
                  if ("error" in r) { toast.error(r.error); return; }
                  toast.success("Đã chốt kỳ — số liệu của kỳ này từ nay đọc từ ảnh chụp");
                  router.refresh();
                })
              }
            >
              <Lock className="size-4" /> Chốt kỳ
            </Button>
          </div>
        ) : null
      }
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Làm được gì</Label>
          <Textarea rows={5} value={h} onChange={(e) => setH(e.target.value)} readOnly={readOnly} placeholder="Kết quả nổi bật trong kỳ" />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Điểm nghẽn</Label>
          <Textarea rows={5} value={i} onChange={(e) => setI(e.target.value)} readOnly={readOnly} placeholder="Việc gì đang kẹt, vì sao" />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Việc tiếp theo</Label>
          <Textarea rows={5} value={n} onChange={(e) => setN(e.target.value)} readOnly={readOnly} placeholder="Ai làm gì trước kỳ sau" />
        </div>
      </div>
    </SectionCard>
  );
}

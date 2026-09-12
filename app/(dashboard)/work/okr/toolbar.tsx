"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Target } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createScorecard, saveObjective } from "@/lib/actions/okr";
import { OKR_LEVELS, OKR_LEVEL_LABEL } from "@/lib/constants/okr";

/**
 * Thanh công cụ của trang Mục tiêu: chọn kỳ, thêm Objective, dựng thẻ điểm.
 *
 * Mẫu BSC gợi ý chỉ áp khi người dùng TÍCH Ô — không bao giờ ngầm. Một bộ chỉ số mặc định được áp
 * lặng lẽ sẽ được đọc như thể nó có căn cứ (xem `DEFAULT_TEMPLATES` ở `lib/queries/bsc.ts`).
 */
export function OkrToolbar({ periods, period, departments, canManage }: { periods: string[]; period: string; departments: { code: string; name: string }[]; canManage: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();

  const setPeriod = (p: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set("period", p);
    router.push(`/work/okr?${next.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={period} onValueChange={setPeriod}>
        <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
        <SelectContent>{periods.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
      </Select>
      {canManage ? <ObjectiveDialog period={period} departments={departments} /> : null}
      {canManage ? <ScorecardDialog period={period} departments={departments} /> : null}
    </div>
  );
}

function ObjectiveDialog({ period, departments }: { period: string; departments: { code: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState<string>("COMPANY");
  const [department, setDepartment] = useState<string>("");
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Target className="size-4" /> Thêm mục tiêu</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mục tiêu mới · {period}</DialogTitle>
          <DialogDescription>Objective là ĐỊNH TÍNH — câu nói về điều muốn đạt. Số liệu thuộc về Key Result, thêm sau khi tạo.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ob-title">Mục tiêu</Label>
            <Input id="ob-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Giao hàng đáng tin hơn trong mắt khách" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ob-desc">Vì sao mục tiêu này</Label>
            <Textarea id="ob-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Cấp</Label>
              <Select value={level} onValueChange={setLevel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{OKR_LEVELS.map((l) => <SelectItem key={l} value={l}>{OKR_LEVEL_LABEL[l]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Phòng ban</Label>
              <Select value={department || "none"} onValueChange={(v) => setDepartment(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="Toàn shop" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Toàn shop</SelectItem>
                  {departments.map((d) => <SelectItem key={d.code} value={d.code}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
          <Button
            disabled={pending || title.trim().length < 3}
            onClick={() =>
              start(async () => {
                const r = await saveObjective({ title, description, level, department: department || null, period, status: "ACTIVE" });
                if ("error" in r) { toast.error(r.error); return; }
                toast.success("Đã tạo mục tiêu. Thêm Key Result để nó đo được.");
                setOpen(false);
                setTitle("");
                setDescription("");
                router.refresh();
              })
            }
          >
            Tạo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScorecardDialog({ period, departments }: { period: string; departments: { code: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [scope, setScope] = useState<"COMPANY" | "DEPARTMENT">("COMPANY");
  const [department, setDepartment] = useState<string>(departments[0]?.code ?? "");
  const [useTemplate, setUseTemplate] = useState(true);
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Plus className="size-4" /> Thẻ điểm mới</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Thẻ điểm cân bằng · {period}</DialogTitle>
          <DialogDescription>Bốn góc nhìn là cố định. Chỉ số và trọng số do bạn khai — mẫu bên dưới chỉ là gợi ý khởi động.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Phạm vi</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as "COMPANY" | "DEPARTMENT")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="COMPANY">Toàn shop</SelectItem>
                <SelectItem value="DEPARTMENT">Một phòng ban</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scope === "DEPARTMENT" ? (
            <div className="grid gap-1.5">
              <Label>Phòng ban</Label>
              <Select value={department} onValueChange={setDepartment}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{departments.map((d) => <SelectItem key={d.code} value={d.code}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} className="mt-0.5" />
            <span>
              Dựng sẵn bộ chỉ số gợi ý
              <span className="block text-xs text-muted-foreground">Gợi ý khởi động, không phải chân lý — sửa hoặc xoá thoải mái sau khi tạo.</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const name = scope === "COMPANY" ? `Thẻ điểm toàn shop ${period}` : `${departments.find((d) => d.code === department)?.name ?? department} ${period}`;
                const r = await createScorecard({ scope, department: scope === "DEPARTMENT" ? department : null, period, name, useTemplate });
                if ("error" in r) { toast.error(r.error); return; }
                toast.success("Đã dựng thẻ điểm");
                setOpen(false);
                router.refresh();
              })
            }
          >
            Dựng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

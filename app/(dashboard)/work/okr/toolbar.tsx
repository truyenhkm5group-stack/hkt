"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutTemplate, Plus, Target } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { applyOkrTemplate, createScorecard, saveObjective } from "@/lib/actions/okr";
import { OKR_LEVELS, OKR_LEVEL_LABEL } from "@/lib/constants/okr";
import { OKR_TEMPLATES, templatesOf } from "@/lib/constants/okr-templates";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";

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
      {canManage ? <TemplateDialog period={period} departments={departments} /> : null}
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

/**
 * ═══════ DÙNG MẪU: BẮT BUỘC ĐI QUA Ô ĐÍCH ═══════
 *
 * Mẫu bày sẵn CÂU HỎI ("đo cái gì, vì sao đo cái đó"), không bày sẵn CÂU TRẢ LỜI. Ô đích mở ra
 * với số gợi ý điền sẵn nhưng người bấm phải nhìn và xác nhận từng ô; ô nào xoá trắng thì KR đó
 * không được tạo, và hộp thoại nói rõ điều đó trước khi bấm.
 *
 * Kết quả luôn là một mục tiêu NHÁP. Bật thành "đang chạy" là một hành động riêng, do người phụ
 * trách làm sau khi đọc lại — vì từ lúc đó nó chảy vào mọi bảng tổng hợp và vào thẻ điểm của họ.
 */
function TemplateDialog({ period, departments }: { period: string; departments: { code: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [department, setDepartment] = useState<string>(departments[0]?.code ?? "SALES");
  const [templateKey, setTemplateKey] = useState<string>(templatesOf((departments[0]?.code ?? "SALES") as DepartmentCode)[0]?.key ?? OKR_TEMPLATES[0].key);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const router = useRouter();

  const danhSach = templatesOf(department as DepartmentCode);
  const tpl = danhSach.find((t) => t.key === templateKey) ?? danhSach[0] ?? null;

  const chonPhong = (code: string) => {
    setDepartment(code);
    const dau = templatesOf(code as DepartmentCode)[0];
    setTemplateKey(dau?.key ?? "");
    setTargets({});
  };

  const oDich = (i: number, kr: { suggestedTarget: number | null }) => targets[`${templateKey}:${i}`] ?? (kr.suggestedTarget === null ? "" : String(kr.suggestedTarget));
  const soKrSeTao = tpl ? tpl.krs.filter((kr, i) => oDich(i, kr).trim() !== "" && Number.isFinite(Number(oDich(i, kr)))).length : 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><LayoutTemplate className="size-4" /> Dùng mẫu</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mẫu mục tiêu · {period}</DialogTitle>
          <DialogDescription>
            Mẫu bày sẵn câu hỏi, không bày sẵn câu trả lời. Bạn phải đặt đích cho từng Key Result; ô để trống thì KR đó không được tạo.
            Mục tiêu sinh ra ở trạng thái <strong>Nháp</strong> — đọc lại rồi tự bật.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Phòng ban</Label>
              <Select value={department} onValueChange={chonPhong}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{departments.map((d) => <SelectItem key={d.code} value={d.code}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Mẫu</Label>
              <Select value={tpl?.key ?? ""} onValueChange={(v) => { setTemplateKey(v); setTargets({}); }}>
                <SelectTrigger><SelectValue placeholder="Phòng này chưa có mẫu" /></SelectTrigger>
                <SelectContent>{danhSach.map((t) => <SelectItem key={t.key} value={t.key}>{t.title}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          {tpl ? (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">{tpl.title}</p>
              <p className="text-xs text-muted-foreground">{tpl.description}</p>
              <div className="space-y-2 pt-1">
                {tpl.krs.map((kr, i) => (
                  <div key={kr.title} className="grid gap-1.5 border-t pt-2 first:border-0 first:pt-0 sm:grid-cols-[1fr_130px] sm:items-start sm:gap-3">
                    <div>
                      <p className="text-sm">{kr.title}</p>
                      <p className="text-xs text-muted-foreground">{kr.why}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {kr.metricSource === "MANUAL" ? "Nhập tay — ERP chưa đo được chỉ số này" : `Chỉ số: ${kr.metricSource}`}
                      </p>
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`kr-${i}`} className="text-xs">Đích</Label>
                      <Input
                        id={`kr-${i}`}
                        inputMode="decimal"
                        value={oDich(i, kr)}
                        placeholder="bỏ trống = bỏ qua"
                        onChange={(e) => setTargets((t) => ({ ...t, [`${templateKey}:${i}`]: e.target.value }))}
                        className="h-8 text-xs tabular-nums"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Phòng {DEPARTMENT_LABEL[department as DepartmentCode] ?? department} chưa có mẫu nào.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
          <Button
            disabled={pending || !tpl || soKrSeTao === 0}
            onClick={() =>
              start(async () => {
                if (!tpl) return;
                const ds = tpl.krs.map((kr, i) => {
                  const v = oDich(i, kr).trim();
                  const n = Number(v);
                  return v === "" || !Number.isFinite(n) ? null : n;
                });
                const r = await applyOkrTemplate({ templateKey: tpl.key, period, targets: ds });
                if ("error" in r) { toast.error(r.error); return; }
                toast.success(`Đã tạo mục tiêu NHÁP với ${r.created} Key Result${r.skipped ? ` (bỏ qua ${r.skipped} KR chưa đặt đích)` : ""}`);
                setOpen(false);
                router.refresh();
              })
            }
          >
            Tạo bản nháp{soKrSeTao ? ` · ${soKrSeTao} KR` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

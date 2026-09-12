"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { METRIC_BINDINGS, METRIC_TRUST_LABEL, METRIC_UNIT_LABEL, METRIC_UNITS } from "@/lib/constants/metric-bindings";
import { KR_CONFIDENCES, KR_CONFIDENCE_LABEL } from "@/lib/constants/okr";
import { checkinKeyResult, deleteKeyResult, deleteObjective, saveKeyResult } from "@/lib/actions/okr";

/**
 * Sửa Key Result ngay trên trang Mục tiêu.
 *
 * Ô "Chỉ số" chỉ liệt kê khoá CÓ THẬT trong sổ đăng ký cộng lựa chọn "Nhập tay" — người dùng không
 * gõ được một khoá tưởng tượng, nên không tạo ra được một KR mãi mãi "chưa đo được" mà không ai
 * hiểu vì sao. Mỗi lựa chọn hiện kèm MỨC TIN CẬY để người đặt mục tiêu biết mình đang dựa vào gì.
 */
export function AddKeyResult({ objectiveId }: { objectiveId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [metricSource, setMetricSource] = useState("MANUAL");
  const [unit, setUnit] = useState("NUMBER");
  const [direction, setDirection] = useState("UP");
  const [baseline, setBaseline] = useState("");
  const [target, setTarget] = useState("");
  const router = useRouter();

  const pick = (key: string) => {
    setMetricSource(key);
    const b = METRIC_BINDINGS[key];
    if (b) {
      // Chỉ số đã khai đơn vị và chiều tốt — điền sẵn để người dùng không khai ngược với sổ.
      setUnit(b.unit);
      setDirection(b.direction);
      if (!title.trim()) setTitle(b.label);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"><Plus className="size-3.5" /> Thêm Key Result</Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 space-y-2.5 p-3" align="end">
        <div className="grid gap-1.5">
          <Label className="text-xs">Chỉ số</Label>
          <Select value={metricSource} onValueChange={pick}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="MANUAL">Nhập tay — ERP chưa đo được</SelectItem>
              {Object.values(METRIC_BINDINGS).map((b) => (
                <SelectItem key={b.key} value={b.key}>{b.label} · {METRIC_TRUST_LABEL[b.trust].toLowerCase()}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{METRIC_BINDINGS[metricSource]?.basis ?? "Người phụ trách tự nhập số mỗi kỳ. Trung thực hơn một truy vấn gần đúng."}</p>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Tên Key Result</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="GTC đạt 92%" className="h-8" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label className="text-xs">Xuất phát</Label>
            <Input type="number" value={baseline} onChange={(e) => setBaseline(e.target.value)} placeholder="để trống nếu chưa đo" className="h-8" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Đích</Label>
            <Input type="number" value={target} onChange={(e) => setTarget(e.target.value)} className="h-8" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Đơn vị</Label>
            <Select value={unit} onValueChange={setUnit}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{METRIC_UNITS.map((u) => <SelectItem key={u} value={u}>{METRIC_UNIT_LABEL[u]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Chiều tốt</Label>
            <Select value={direction} onValueChange={setDirection}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="UP">Càng cao càng tốt</SelectItem>
                <SelectItem value="DOWN">Càng thấp càng tốt</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          size="sm"
          className="w-full"
          disabled={pending || title.trim().length < 3 || target === ""}
          onClick={() =>
            start(async () => {
              const r = await saveKeyResult({ objectiveId, title, metricSource, unit, direction, baseline: baseline === "" ? null : Number(baseline), target: Number(target) });
              if ("error" in r) { toast.error(r.error); return; }
              toast.success("Đã thêm Key Result");
              setOpen(false);
              setTitle("");
              setTarget("");
              setBaseline("");
              router.refresh();
            })
          }
        >
          Thêm
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** Chấm một KR: mức tự tin luôn chấm được; GIÁ TRỊ chỉ nhập được với KR nhập tay. */
export function CheckinKeyResult({ id, manual, current }: { id: string; manual: boolean; current: number | null }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [confidence, setConfidence] = useState("ON_TRACK");
  const [note, setNote] = useState("");
  const router = useRouter();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]"><Check className="size-3" /> Chấm</Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2 p-2.5" align="end">
        {manual ? (
          <div className="grid gap-1.5">
            <Label className="text-xs">Giá trị hiện tại</Label>
            <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} className="h-8" />
          </div>
        ) : (
          // KR nối chỉ số đọc sống mỗi lần mở trang. Cho nhập tay đè lên là tạo hai sự thật.
          <p className="text-[11px] text-muted-foreground">Chỉ số này đọc thẳng từ ERP nên số không nhập tay được. Bạn vẫn chấm được mức tự tin và ghi nhận định.</p>
        )}
        <div className="grid gap-1.5">
          <Label className="text-xs">Mức tự tin</Label>
          <Select value={confidence} onValueChange={setConfidence}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{KR_CONFIDENCES.map((c) => <SelectItem key={c} value={c}>{KR_CONFIDENCE_LABEL[c]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vì sao chấm như vậy?" className="text-sm" />
        <Button
          size="sm"
          className="w-full"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await checkinKeyResult({ keyResultId: id, value: manual && value !== "" ? Number(value) : null, confidence, note });
              if ("error" in r) { toast.error(r.error); return; }
              toast.success("Đã chấm");
              setOpen(false);
              router.refresh();
            })
          }
        >
          Lưu
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function DeleteKeyResult({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-1.5 text-[11px] text-muted-foreground"
      disabled={pending}
      title="Xoá Key Result"
      onClick={() => start(async () => { const r = await deleteKeyResult(id); if ("error" in r) toast.error(r.error); else { toast.success("Đã xoá"); router.refresh(); } })}
    >
      <Trash2 className="size-3" />
    </Button>
  );
}

export function DeleteObjective({ id, title }: { id: string; title: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-xs text-muted-foreground"
      disabled={pending}
      title={`Xoá mục tiêu "${title}" cùng mọi Key Result của nó`}
      onClick={() => start(async () => { const r = await deleteObjective(id); if ("error" in r) toast.error(r.error); else { toast.success("Đã xoá mục tiêu"); router.refresh(); } })}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}

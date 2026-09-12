"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BSC_PERSPECTIVES, BSC_PERSPECTIVE_LABEL } from "@/lib/constants/bsc";
import { METRIC_BINDINGS, METRIC_TRUST_LABEL, METRIC_UNITS, METRIC_UNIT_LABEL } from "@/lib/constants/metric-bindings";
import { deleteBscMetric, saveBscMetric } from "@/lib/actions/okr";

/**
 * Thêm / sửa một ô của thẻ điểm.
 *
 * TRỌNG SỐ chỉ phân biệt các ô BÊN TRONG một góc nhìn — bốn góc nhìn cân bằng nhau ở cấp thẻ, đó
 * là ý nghĩa của chữ "cân bằng". Tổng trọng số không cần bằng 100; phép tính tự chuẩn hoá.
 */
export function AddBscMetric({ scorecardId }: { scorecardId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [perspective, setPerspective] = useState<string>("FINANCIAL");
  const [label, setLabel] = useState("");
  const [metricSource, setMetricSource] = useState("MANUAL");
  const [unit, setUnit] = useState("NUMBER");
  const [direction, setDirection] = useState("UP");
  const [target, setTarget] = useState("");
  const [manualValue, setManualValue] = useState("");
  const [weight, setWeight] = useState("1");
  const router = useRouter();

  const pick = (key: string) => {
    setMetricSource(key);
    const b = METRIC_BINDINGS[key];
    if (b) {
      setUnit(b.unit);
      setDirection(b.direction);
      if (!label.trim()) setLabel(b.label);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"><Plus className="size-3.5" /> Thêm chỉ số</Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 space-y-2.5 p-3" align="end">
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label className="text-xs">Góc nhìn</Label>
            <Select value={perspective} onValueChange={setPerspective}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{BSC_PERSPECTIVES.map((p) => <SelectItem key={p} value={p}>{BSC_PERSPECTIVE_LABEL[p]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Trọng số trong góc nhìn</Label>
            <Input type="number" min={0.1} step={0.5} value={weight} onChange={(e) => setWeight(e.target.value)} className="h-8" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Chỉ số</Label>
          <Select value={metricSource} onValueChange={pick}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="MANUAL">Nhập tay — ERP chưa đo được</SelectItem>
              {Object.values(METRIC_BINDINGS).map((b) => <SelectItem key={b.key} value={b.key}>{b.label} · {METRIC_TRUST_LABEL[b.trust].toLowerCase()}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{METRIC_BINDINGS[metricSource]?.basis ?? "Người phụ trách tự nhập số mỗi kỳ."}</p>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Nhãn hiển thị</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8" />
        </div>
        <div className="grid grid-cols-3 gap-2">
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
                <SelectItem value="UP">Cao là tốt</SelectItem>
                <SelectItem value="DOWN">Thấp là tốt</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {metricSource === "MANUAL" ? (
          <div className="grid gap-1.5">
            <Label className="text-xs">Giá trị hiện tại (nhập tay)</Label>
            <Input type="number" value={manualValue} onChange={(e) => setManualValue(e.target.value)} placeholder="để trống = chưa đo" className="h-8" />
          </div>
        ) : null}
        <Button
          size="sm"
          className="w-full"
          disabled={pending || label.trim().length < 2}
          onClick={() =>
            start(async () => {
              const r = await saveBscMetric({ scorecardId, perspective, label, metricSource, unit, direction, target: target === "" ? null : Number(target), manualValue: manualValue === "" ? null : Number(manualValue), weight: Number(weight) || 1 });
              if ("error" in r) { toast.error(r.error); return; }
              toast.success("Đã thêm chỉ số");
              setOpen(false);
              setLabel("");
              setTarget("");
              setManualValue("");
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

export function DeleteBscMetric({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label="Xoá chỉ số"
      disabled={pending}
      className="rounded p-0.5 text-muted-foreground hover:bg-accent"
      onClick={() => start(async () => { const r = await deleteBscMetric(id); if ("error" in r) toast.error(r.error); else { toast.success("Đã xoá"); router.refresh(); } })}
    >
      <Trash2 className="size-3" />
    </button>
  );
}

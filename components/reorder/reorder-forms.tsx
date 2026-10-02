"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recordTouchpointAction, setReorderSettingAction } from "@/lib/actions/touchpoints";
import { TOUCH_KINDS, TOUCH_KIND_LABEL, TOUCH_OUTCOMES, TOUCH_OUTCOME_LABEL, type TouchKind, type TouchOutcome } from "@/lib/constants/reorder";

const SELECT = "h-8 rounded-md border bg-background px-2 text-sm";

/** Ghi MỘT lượt liên hệ ngay trên dòng của khách. Hẹn ngày ⇒ khách rời danh sách gọi tới ngày đó. */
export function TouchpointForm({ customerId, compact = false }: { customerId: string; compact?: boolean }) {
  const [kind, setKind] = useState<TouchKind>("CALL");
  const [outcome, setOutcome] = useState<TouchOutcome>("WILL_ORDER");
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [open, setOpen] = useState(!compact);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Ghi liên hệ
      </Button>
    );
  const save = () =>
    start(async () => {
      const r = await recordTouchpointAction(customerId, { kind, outcome, note, nextContactOn: next || null });
      if (r.ok) {
        toast.success(r.message);
        setNote("");
        setNext("");
        if (compact) setOpen(false);
      } else toast.error(r.errors[0]?.message ?? "Không ghi được.");
    });
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs" data-touchpoint-form={customerId}>
      <select aria-label="Cách liên hệ" className={SELECT} value={kind} onChange={(e) => setKind(e.target.value as TouchKind)}>
        {TOUCH_KINDS.map((k) => (
          <option key={k} value={k}>
            {TOUCH_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <select aria-label="Kết quả" className={SELECT} value={outcome} onChange={(e) => setOutcome(e.target.value as TouchOutcome)}>
        {TOUCH_OUTCOMES.map((k) => (
          <option key={k} value={k}>
            {TOUCH_OUTCOME_LABEL[k]}
          </option>
        ))}
      </select>
      <Input aria-label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú" maxLength={1000} className="h-8 w-44" />
      <div className="flex items-center gap-1">
        <Label htmlFor={`next-${customerId}`} className="text-xs">
          Hẹn lại
        </Label>
        <Input id={`next-${customerId}`} type="date" value={next} onChange={(e) => setNext(e.target.value)} className="h-8 w-36" />
      </div>
      <Button type="button" size="sm" onClick={save} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu
      </Button>
    </div>
  );
}

/** Chu kỳ mua lại MẶC ĐỊNH (cho khách mới mua một lần) + cửa sổ sắp đến hạn. Trống = chưa khai — không đoán. */
export function ReorderSettingForm({ current }: { current: { defaultCycleDays: number | null; dueSoonDays: number } }) {
  const [cycle, setCycle] = useState(current.defaultCycleDays === null ? "" : String(current.defaultCycleDays));
  const [soon, setSoon] = useState(String(current.dueSoonDays));
  const [pending, start] = useTransition();
  const save = () => {
    const c = cycle.trim() === "" ? null : Number(cycle);
    const s = Number(soon);
    if ((c !== null && (!Number.isInteger(c) || c < 1 || c > 365)) || !Number.isInteger(s) || s < 0 || s > 30) return toast.error("Chu kỳ 1–365 ngày (trống = chưa khai); sắp đến hạn 0–30 ngày.");
    start(async () => {
      const r = await setReorderSettingAction({ defaultCycleDays: c, dueSoonDays: s });
      if (r.ok) toast.success(r.message);
      else toast.error(r.errors[0]?.message ?? "Không lưu được.");
    });
  };
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm" data-reorder-setting>
      <div className="space-y-1">
        <Label htmlFor="rs-cycle">Chu kỳ mặc định (ngày)</Label>
        <Input id="rs-cycle" inputMode="numeric" value={cycle} onChange={(e) => setCycle(e.target.value)} placeholder="Trống = chưa khai" className="w-40" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rs-soon">Nhắc trước (ngày)</Label>
        <Input id="rs-soon" inputMode="numeric" value={soon} onChange={(e) => setSoon(e.target.value)} className="w-28" />
      </div>
      <Button type="button" variant="outline" onClick={save} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu
      </Button>
    </div>
  );
}

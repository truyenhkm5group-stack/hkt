"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { savePlanningAssumptions } from "@/lib/actions/planning";
import type { PlanningAssumptions } from "@/lib/constants/planning";

export function PlanningForm({ assumptions, products, canWrite }: { assumptions: PlanningAssumptions; products: { id: string; name: string; code: string }[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...assumptions });
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const num = (v: string, d: number) => (v.trim() === "" ? d : Number(v));
  const save = () =>
    startTransition(async () => {
      const r = await savePlanningAssumptions(form);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu giả định đặt hàng");
        setOpen(false);
        router.refresh();
      }
    });
  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Giả định:</span>
        <span>Thời gian sản xuất <b>{assumptions.leadTimeDays} ngày</b></span>
        <span>Đủ bán thêm <b>{assumptions.coverDays} ngày</b> sau khi hàng về</span>
        <span>Tốc độ bán tính theo <b>{assumptions.velocityWindowDays} ngày</b> gần nhất</span>
        <span>Tồn an toàn <b>{assumptions.safetyDays} ngày</b> bán</span>
        {assumptions.roundTo > 1 ? <span>Làm tròn bội số <b>{assumptions.roundTo}</b></span> : null}
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-4" /> {open ? "Đóng" : "Sửa giả định"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-4 space-y-3 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-5">
            <div className="space-y-1"><Label>Thời gian SX (ngày)</Label><Input type="number" min={1} value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: num(e.target.value, 7) })} /></div>
            <div className="space-y-1"><Label>Đủ bán thêm (ngày)</Label><Input type="number" min={0} value={form.coverDays} onChange={(e) => setForm({ ...form, coverDays: num(e.target.value, 14) })} /></div>
            <div className="space-y-1"><Label>Cửa sổ tốc độ bán (ngày)</Label><Input type="number" min={3} value={form.velocityWindowDays} onChange={(e) => setForm({ ...form, velocityWindowDays: num(e.target.value, 14) })} /></div>
            <div className="space-y-1"><Label>Tồn an toàn (ngày bán)</Label><Input type="number" min={0} value={form.safetyDays} onChange={(e) => setForm({ ...form, safetyDays: num(e.target.value, 3) })} /></div>
            <div className="space-y-1"><Label>Làm tròn bội số</Label><Input type="number" min={1} value={form.roundTo} onChange={(e) => setForm({ ...form, roundTo: num(e.target.value, 1) })} /></div>
          </div>
          <div>
            <Label className="mb-1 block">Thời gian SX riêng theo mã hàng (để trống = dùng chung)</Label>
            <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {products.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <span className="w-36 shrink-0 truncate text-xs" title={p.name}>{p.code ? `${p.code} · ` : ""}{p.name}</span>
                  <Input type="number" min={1} className="h-8" placeholder={String(form.leadTimeDays)} value={form.leadTimeOverrides[p.id] ?? ""} onChange={(e) => { const next = { ...form.leadTimeOverrides }; if (e.target.value.trim() === "") delete next[p.id]; else next[p.id] = Number(e.target.value); setForm({ ...form, leadTimeOverrides: next }); }} />
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Đề xuất đặt = tốc độ bán × (thời gian SX + số ngày đủ bán) + tồn an toàn − (tồn ERP − đơn đã chốt chưa gửi). Tốc độ bán = số lượng bán ròng (không huỷ, không hoàn) trong cửa sổ ÷ số ngày.</p>
            <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { savePayrollConfig } from "@/lib/actions/payroll";
import type { PayrollConfig } from "@/lib/constants/payroll";

type Product = { id: string; name: string; code: string };
type Marketer = { id: string; name: string };

export function ProductOwnersForm({ config, products, marketers, canWrite }: { config: PayrollConfig; products: Product[]; marketers: Marketer[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [owners, setOwners] = useState<Record<string, string>>({ ...config.productOwners });
  const [pct, setPct] = useState(config.ownerSharePct);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const assigned = products.filter((p) => config.productOwners[p.id]).length;
  const save = () =>
    startTransition(async () => {
      const r = await savePayrollConfig({ ownerSharePct: pct, productOwners: owners });
      if ("error" in r) toast.error(r.error);
      else { toast.success("Đã lưu người phụ trách mã hàng"); setOpen(false); router.refresh(); }
    });
  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Người phụ trách chính mã hàng:</span>
        <span>{assigned}/{products.length} mã đã gán · chủ mã chịu tồn kho & giá vốn, nhận <b>{config.ownerSharePct}%</b> lợi nhuận từ đơn marketer khác đẩy chéo</span>
        {products.length - assigned > 0 ? <span className="text-amber-700">Mã chưa gán: lợi nhuận chia theo tỷ trọng QC, không ai chịu giá vốn hàng nhập (LN2)</span> : null}
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-4" /> {open ? "Đóng" : "Gán người phụ trách"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-4 space-y-3 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {products.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <span className="w-40 shrink-0 truncate text-xs font-medium" title={p.name}>{p.code ? `${p.code} · ` : ""}{p.name}</span>
                <Select value={owners[p.id] ?? "__none__"} onValueChange={(v) => setOwners((o) => { const n = { ...o }; if (v === "__none__") delete n[p.id]; else n[p.id] = v; return n; })}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="Chưa gán" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Chưa gán</SelectItem>
                    {marketers.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label>% chủ mã nhận từ đơn đẩy chéo</Label><Input type="number" min={0} max={100} className="w-28" value={pct} onChange={(e) => setPct(Number(e.target.value) || 0)} /></div>
            <Button onClick={save} disabled={pending}><Save className="size-4" /> Lưu</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

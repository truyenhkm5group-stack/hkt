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
import { shareFor, type PayrollConfig, type ProductShare } from "@/lib/constants/payroll";
import { formatNumber, formatVND } from "@/lib/format";

type Product = { id: string; name: string; code: string };
type Marketer = { id: string; name: string };
type PageOpt = { pageId: string; name: string; orders: number; sales: number };

/**
 * Khai báo: (1) fanpage → marketer (đơn & doanh thu phát sinh trên page ghi nhận cho người đó),
 * (2) mã hàng → chủ mã + % LN chủ mã hưởng từ đơn của mình (X) và % người chạy cùng hưởng từ đơn mình tạo (Y), phần còn lại về chủ mã.
 */
export function ProductOwnersForm({ config, products, marketers, pages, canWrite }: { config: PayrollConfig; products: Product[]; marketers: Marketer[]; pages: PageOpt[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [owners, setOwners] = useState<Record<string, string>>({ ...config.productOwners });
  const [pageMap, setPageMap] = useState<Record<string, string>>({ ...config.pageMarketers });
  const [shares, setShares] = useState<Record<string, ProductShare>>(() => Object.fromEntries(products.map((p) => [p.id, shareFor(config, p.id)])));
  const [pct, setPct] = useState(config.ownerSharePct);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const assigned = products.filter((p) => config.productOwners[p.id]).length;
  const pagesMapped = pages.filter((p) => config.pageMarketers[p.pageId]).length;
  const nameOf = (id: string) => marketers.find((m) => m.id === id)?.name ?? "?";
  const save = () =>
    startTransition(async () => {
      const r = await savePayrollConfig({ ownerSharePct: pct, productOwners: owners, pageMarketers: pageMap, productShares: shares });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu người phụ trách mã hàng, % lợi nhuận và fanpage");
        setOpen(false);
        router.refresh();
      }
    });
  const setShare = (pid: string, key: keyof ProductShare, v: string) => setShares((s) => ({ ...s, [pid]: { ...(s[pid] ?? shareFor(config, pid)), [key]: Math.min(100, Math.max(0, Number(v) || 0)) } }));
  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Ghi nhận đơn & chia lợi nhuận:</span>
        <span>
          Fanpage <b>{pagesMapped}/{pages.length}</b> đã gán marketer · mã hàng <b>{assigned}/{products.length}</b> đã có chủ mã
        </span>
        <span className="text-muted-foreground">Đơn & doanh thu ghi nhận theo thứ tự: ad_id của đơn (quảng cáo tạo ra đơn → chiến dịch → marketer, đúng từng đơn kể cả chạy chung page) → fanpage phát sinh đơn → tỷ trọng QC. Chủ mã hưởng X% LN đơn của mình, người chạy cùng hưởng Y% LN đơn mình tạo, phần còn lại về chủ mã.</span>
        {pages.length - pagesMapped > 0 ? <span className="text-amber-700">{pages.length - pagesMapped} fanpage chưa gán → đơn trên page đó đang chia theo QC</span> : null}
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-4" /> {open ? "Đóng" : "Khai báo"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-4 space-y-5 border-t pt-4">
          <section className="space-y-2">
            <div className="font-semibold">1. Fanpage → marketer (đơn trong 90 ngày)</div>
            <p className="text-xs text-muted-foreground">Mỗi fanpage một marketer: đơn lên từ page mà không nhận diện được qua ad_id sẽ ghi nhận cho người này. Gán theo người chạy quảng cáo & ra đơn nhiều nhất trên page.</p>
            {pages.length === 0 ? <p className="text-xs text-muted-foreground">Chưa có đơn nào kèm page_id.</p> : null}
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {pages.map((p) => (
                <div key={p.pageId} className="flex items-center gap-2">
                  <span className="w-48 shrink-0 truncate text-xs" title={`${p.name || p.pageId} · ${p.pageId}`}>
                    <span className="font-medium">{p.name || p.pageId}</span>
                    <span className="block text-[10.5px] text-muted-foreground">{formatNumber(p.orders)} đơn · {formatVND(p.sales, { compact: true })}{p.name ? ` · ${p.pageId}` : ""}</span>
                  </span>
                  <Select value={pageMap[p.pageId] ?? "__none__"} onValueChange={(v) => setPageMap((m) => { const n = { ...m }; if (v === "__none__") delete n[p.pageId]; else n[p.pageId] = v; return n; })}>
                    <SelectTrigger className="h-8"><SelectValue placeholder="Chưa gán" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Chưa gán (chia theo QC)</SelectItem>
                      {marketers.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </section>
          <section className="space-y-2">
            <div className="font-semibold">2. Mã hàng → chủ mã & % lợi nhuận</div>
            <p className="text-xs text-muted-foreground">X% = phần LN chủ mã được hưởng từ đơn do chính mình tạo (còn lại shop giữ). Y% = phần LN người chạy cùng được hưởng từ đơn mình tạo trên mã của người khác; (100 − Y)% về chủ mã. LN âm thì người tạo đơn chịu.</p>
            <div className="grid gap-2 lg:grid-cols-2">
              {products.map((p) => {
                const sh = shares[p.id] ?? shareFor(config, p.id);
                return (
                  <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5">
                    <span className="w-40 shrink-0 truncate text-xs font-medium" title={p.name}>{p.code ? `${p.code} · ` : ""}{p.name}</span>
                    <Select value={owners[p.id] ?? "__none__"} onValueChange={(v) => setOwners((o) => { const n = { ...o }; if (v === "__none__") delete n[p.id]; else n[p.id] = v; return n; })}>
                      <SelectTrigger className="h-8 w-36"><SelectValue placeholder="Chưa gán" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Chưa gán</SelectItem>
                        {marketers.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-1 text-xs">Chủ mã <Input type="number" min={0} max={100} className="h-8 w-16" value={sh.ownerPct} onChange={(e) => setShare(p.id, "ownerPct", e.target.value)} />%</label>
                    <label className="flex items-center gap-1 text-xs">Chạy cùng <Input type="number" min={0} max={100} className="h-8 w-16" value={sh.crossPct} onChange={(e) => setShare(p.id, "crossPct", e.target.value)} />%</label>
                    {owners[p.id] ? <span className="text-[10.5px] text-muted-foreground">{nameOf(owners[p.id])} nhận {100 - sh.crossPct}% LN đơn người khác</span> : null}
                  </div>
                );
              })}
            </div>
          </section>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label>% chủ mã nhận từ đơn chạy cùng (mặc định cho mã chưa khai Y)</Label><Input type="number" min={0} max={100} className="w-28" value={pct} onChange={(e) => setPct(Number(e.target.value) || 0)} /></div>
            <Button onClick={save} disabled={pending}><Save className="size-4" /> Lưu</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

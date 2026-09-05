"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { previewOutreachTemplate, saveOutreachConfig } from "@/lib/actions/outreach";
import type { OutreachConfig } from "@/lib/constants/outreach";

type Product = { id: string; name: string; code: string };

export function OutreachConfigForm({ config, products, canWrite }: { config: OutreachConfig; products: Product[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<OutreachConfig>({ ...config });
  const [preview, setPreview] = useState<{ nurture?: string; cross?: string }>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const num = (v: string, d: number) => (v.trim() === "" ? d : Number(v));
  const byId = new Map(products.map((p) => [p.id, p]));
  const codeOf = (id: string) => byId.get(id)?.code || byId.get(id)?.name || id;
  const idsFromCodes = (text: string) =>
    text.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean).map((c) => products.find((p) => p.code.toLowerCase() === c || p.name.toLowerCase() === c)?.id).filter((x): x is string => Boolean(x));
  const [mapText, setMapText] = useState<Record<string, string>>(Object.fromEntries(Object.entries(config.crossSellMap).map(([k, v]) => [k, v.map(codeOf).join(", ")])));

  const save = () =>
    startTransition(async () => {
      const crossSellMap: Record<string, string[]> = {};
      for (const [pid, text] of Object.entries(mapText)) { const ids = idsFromCodes(text); if (ids.length) crossSellMap[pid] = ids; }
      const r = await saveOutreachConfig({ ...form, crossSellMap });
      if ("error" in r) toast.error(r.error);
      else { toast.success("Đã lưu cấu hình chăm sóc khách"); setOpen(false); router.refresh(); }
    });
  const doPreview = (seg: "NURTURE" | "CROSS_SELL") =>
    startTransition(async () => {
      const r = await previewOutreachTemplate(seg, seg === "NURTURE" ? form.nurtureTemplate : form.crossSellTemplate);
      if ("error" in r) toast.error(r.error);
      else setPreview((p) => ({ ...p, [seg === "NURTURE" ? "nurture" : "cross"]: r.text }));
    });

  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Cấu hình:</span>
        <span>Băn khoăn: khách nhắn trong <b>{config.nurtureDays} ngày</b> chưa có đơn</span>
        <span>Bán chéo: nhận hàng <b>{config.crossSellFromDays}–{config.crossSellToDays} ngày</b> trước</span>
        <span>Tối đa <b>{config.dailyLimit} tin/ngày</b></span>
        {config.discountCode ? <span>Mã ưu đãi <b>{config.discountCode}</b></span> : null}
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-4" /> {open ? "Đóng" : "Sửa cấu hình & mẫu tin"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-4 space-y-4 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-4 xl:grid-cols-7">
            <div className="space-y-1"><Label>Tên shop</Label><Input value={form.shopName} onChange={(e) => setForm({ ...form, shopName: e.target.value })} /></div>
            <div className="space-y-1"><Label>Mã ưu đãi (tuỳ chọn)</Label><Input value={form.discountCode} onChange={(e) => setForm({ ...form, discountCode: e.target.value })} placeholder="VD: CAMON10" /></div>
            <div className="space-y-1"><Label>Băn khoăn: nhắn trong (ngày)</Label><Input type="number" min={1} value={form.nurtureDays} onChange={(e) => setForm({ ...form, nurtureDays: num(e.target.value, 2) })} /></div>
            <div className="space-y-1"><Label>Bán chéo từ (ngày sau nhận)</Label><Input type="number" min={0} value={form.crossSellFromDays} onChange={(e) => setForm({ ...form, crossSellFromDays: num(e.target.value, 3) })} /></div>
            <div className="space-y-1"><Label>Bán chéo đến (ngày)</Label><Input type="number" min={1} value={form.crossSellToDays} onChange={(e) => setForm({ ...form, crossSellToDays: num(e.target.value, 14) })} /></div>
            <div className="space-y-1"><Label>Không nhắn lại trong (ngày)</Label><Input type="number" min={1} value={form.cooldownDays} onChange={(e) => setForm({ ...form, cooldownDays: num(e.target.value, 14) })} /></div>
            <div className="space-y-1"><Label>Giới hạn tin/ngày</Label><Input type="number" min={1} value={form.dailyLimit} onChange={(e) => setForm({ ...form, dailyLimit: num(e.target.value, 200) })} /></div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1">
              <Label>Mẫu tin băn khoăn chưa mua · biến: {"{ten} {san_pham} {goi_y} {shop} {uu_dai}"}</Label>
              <Textarea rows={5} value={form.nurtureTemplate} onChange={(e) => setForm({ ...form, nurtureTemplate: e.target.value })} />
              <Button type="button" size="sm" variant="ghost" onClick={() => doPreview("NURTURE")} disabled={pending}><Eye className="size-4" /> Xem trước</Button>
              {preview.nurture ? <p className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{preview.nurture}</p> : null}
            </div>
            <div className="space-y-1">
              <Label>Mẫu tin bán chéo sau nhận hàng</Label>
              <Textarea rows={5} value={form.crossSellTemplate} onChange={(e) => setForm({ ...form, crossSellTemplate: e.target.value })} />
              <Button type="button" size="sm" variant="ghost" onClick={() => doPreview("CROSS_SELL")} disabled={pending}><Eye className="size-4" /> Xem trước</Button>
              {preview.cross ? <p className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{preview.cross}</p> : null}
            </div>
          </div>
          <div>
            <Label className="mb-1 block">Gợi ý bán chéo theo mã đã mua (nhập mã hàng cách nhau dấu phẩy; để trống = gợi ý top bán chạy khách chưa mua)</Label>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {products.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <span className="w-40 shrink-0 truncate text-xs" title={p.name}>{p.code ? `${p.code} · ` : ""}{p.name}</span>
                  <Input className="h-8" placeholder="VD: Q003, X001" value={mapText[p.id] ?? ""} onChange={(e) => setMapText({ ...mapText, [p.id]: e.target.value })} />
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end"><Button onClick={save} disabled={pending}>Lưu cấu hình</Button></div>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, Plus, RotateCcw, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { previewOutreachTemplate, saveOutreachConfig } from "@/lib/actions/outreach";
import { DEFAULT_NURTURE_STEPS, NURTURE_WINDOWS, type OutreachConfig } from "@/lib/constants/outreach";

type Product = { id: string; name: string; code: string };

export function OutreachConfigForm({ config, products, canWrite }: { config: OutreachConfig; products: Product[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<OutreachConfig>({ ...config, nurtureSteps: [...config.nurtureSteps] });
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const num = (v: string, d: number) => (v.trim() === "" ? d : Number(v));
  const byId = new Map(products.map((p) => [p.id, p]));
  const codeOf = (id: string) => byId.get(id)?.code || byId.get(id)?.name || id;
  const idsFromCodes = (text: string) =>
    text.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean).map((c) => products.find((p) => p.code.toLowerCase() === c || p.name.toLowerCase() === c)?.id).filter((x): x is string => Boolean(x));
  const [mapText, setMapText] = useState<Record<string, string>>(Object.fromEntries(Object.entries(config.crossSellMap).map(([k, v]) => [k, v.map(codeOf).join(", ")])));
  const [mediaText, setMediaText] = useState<Record<string, string>>(Object.fromEntries(Object.entries(config.crossSellMedia).map(([k, v]) => [k, v.join("\n")])));
  const windowLabel = NURTURE_WINDOWS.find((w) => w.hours === config.nurtureWindowHours)?.label ?? `${config.nurtureWindowHours} giờ`;

  const setStep = (i: number, text: string) => setForm((f) => ({ ...f, nurtureSteps: f.nurtureSteps.map((s, k) => (k === i ? text : s)) }));
  const removeStep = (i: number) => setForm((f) => ({ ...f, nurtureSteps: f.nurtureSteps.filter((_, k) => k !== i) }));
  const addStep = () => setForm((f) => ({ ...f, nurtureSteps: [...f.nurtureSteps, ""] }));

  const save = () =>
    startTransition(async () => {
      const crossSellMap: Record<string, string[]> = {};
      for (const [pid, text] of Object.entries(mapText)) { const ids = idsFromCodes(text); if (ids.length) crossSellMap[pid] = ids; }
      const { nurtureDays: _d, nurtureTemplate: _t, ...rest } = form;
      void _d; void _t;
      const crossSellMedia: Record<string, string[]> = {};
      for (const [pid, text] of Object.entries(mediaText)) { const urls = text.split(/[\n,]/).map((u) => u.trim()).filter(Boolean); if (urls.length) crossSellMedia[pid] = urls; }
      const r = await saveOutreachConfig({ ...rest, crossSellMap, crossSellMedia, nurtureSteps: form.nurtureSteps.map((s) => s.trim()).filter(Boolean) });
      if ("error" in r) toast.error(r.error);
      else { toast.success("Đã lưu cấu hình chăm sóc khách"); setOpen(false); router.refresh(); }
    });
  const doPreview = (key: string, seg: "NURTURE" | "CROSS_SELL", template: string) =>
    startTransition(async () => {
      const r = await previewOutreachTemplate(seg, template);
      if ("error" in r) toast.error(r.error);
      else setPreview((p) => ({ ...p, [key]: r.text }));
    });

  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Cấu hình:</span>
        <span>Băn khoăn: khách nhắn trong <b>{windowLabel}</b> chưa có đơn · kịch bản <b>{config.nurtureSteps.length} bước</b>, cách nhau <b>{config.nurtureStepGapDays} ngày</b></span>
        <span>Bán chéo: nhận hàng <b>{config.crossSellFromDays}–{config.crossSellToDays} ngày</b> trước · khách cũ giảm <b>{config.crossSellDiscount}</b>, mã xả giảm <b>{config.clearanceDiscount}</b>{config.attachProductImages ? " · kèm ảnh/video" : ""}</span>
        <span>Tối đa <b>{config.dailyLimit} tin/ngày</b></span>
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-4" /> {open ? "Đóng" : "Sửa cấu hình & kịch bản"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-4 space-y-5 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-4 xl:grid-cols-8">
            <div className="space-y-1"><Label>Tên shop</Label><Input value={form.shopName} onChange={(e) => setForm({ ...form, shopName: e.target.value })} /></div>
            <div className="space-y-1"><Label>Ưu đãi chốt nhanh {"{giam}"}</Label><Input value={form.nurtureDiscount} onChange={(e) => setForm({ ...form, nurtureDiscount: e.target.value })} placeholder="VD: 50k/váy" /></div>
            <div className="space-y-1"><Label>Mã ưu đãi {"{uu_dai}"}</Label><Input value={form.discountCode} onChange={(e) => setForm({ ...form, discountCode: e.target.value })} placeholder="tuỳ chọn" /></div>
            <div className="space-y-1">
              <Label>Băn khoăn: khách nhắn trong</Label>
              <Select value={String(form.nurtureWindowHours)} onValueChange={(v) => setForm({ ...form, nurtureWindowHours: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{NURTURE_WINDOWS.map((w) => <SelectItem key={w.hours} value={String(w.hours)}>{w.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>Cách nhau (ngày/bước)</Label><Input type="number" min={1} value={form.nurtureStepGapDays} onChange={(e) => setForm({ ...form, nurtureStepGapDays: num(e.target.value, 1) })} /></div>
            <div className="space-y-1"><Label>Bán chéo từ–đến (ngày)</Label><div className="flex gap-1"><Input type="number" min={0} value={form.crossSellFromDays} onChange={(e) => setForm({ ...form, crossSellFromDays: num(e.target.value, 3) })} /><Input type="number" min={1} value={form.crossSellToDays} onChange={(e) => setForm({ ...form, crossSellToDays: num(e.target.value, 14) })} /></div></div>
            <div className="space-y-1"><Label>Không nhắn lại trong (ngày)</Label><Input type="number" min={1} value={form.cooldownDays} onChange={(e) => setForm({ ...form, cooldownDays: num(e.target.value, 14) })} /></div>
            <div className="space-y-1"><Label>Giới hạn tin/ngày</Label><Input type="number" min={1} value={form.dailyLimit} onChange={(e) => setForm({ ...form, dailyLimit: num(e.target.value, 200) })} /></div>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Label>Kịch bản băn khoăn chưa mua · mỗi ngày gửi một bước · biến: {"{ten} {giam} {shop} {goi_y} {uu_dai}"}</Label>
              <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setForm({ ...form, nurtureSteps: [...DEFAULT_NURTURE_STEPS] })}><RotateCcw className="size-4" /> Kịch bản mẫu</Button>
              <Button type="button" size="sm" variant="outline" onClick={addStep}><Plus className="size-4" /> Thêm bước</Button>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {form.nurtureSteps.map((step, i) => (
                <div key={i} className="space-y-1 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold">Bước {i + 1} · ngày {1 + i * form.nurtureStepGapDays}</span>
                    <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" onClick={() => doPreview(`n${i}`, "NURTURE", step)} disabled={pending || !step.trim()}><Eye className="size-4" /> Xem trước</Button>
                    <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => removeStep(i)} disabled={form.nurtureSteps.length <= 1}><Trash2 className="size-4" /></Button>
                  </div>
                  <Textarea rows={4} value={step} onChange={(e) => setStep(i, e.target.value)} />
                  {preview[`n${i}`] ? <p className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{preview[`n${i}`]}</p> : null}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="text-sm font-semibold">Bán chéo sau nhận hàng · ưu đãi & ảnh/video</div>
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <div className="space-y-1"><Label>Khách cũ mua mẫu khác giảm</Label><Input value={form.crossSellDiscount} onChange={(e) => setForm({ ...form, crossSellDiscount: e.target.value })} placeholder="50K" /></div>
              <div className="space-y-1"><Label>Mã xả (giá siêu hời) giảm</Label><Input value={form.clearanceDiscount} onChange={(e) => setForm({ ...form, clearanceDiscount: e.target.value })} placeholder="100K" /></div>
              <div className="space-y-1"><Label>Mã xả: tỷ lệ hoàn ≥ (%)</Label><Input type="number" min={0} max={100} value={form.clearanceReturnRatePct} onChange={(e) => setForm({ ...form, clearanceReturnRatePct: num(e.target.value, 35) })} /></div>
              <div className="space-y-1"><Label>và tồn đủ bán ≥ (ngày)</Label><Input type="number" min={0} value={form.clearanceStockDays} onChange={(e) => setForm({ ...form, clearanceStockDays: num(e.target.value, 45) })} /></div>
              <div className="space-y-1"><Label>Số ảnh/video kèm tối đa</Label><Input type="number" min={1} max={6} value={form.maxMediaPerMessage} onChange={(e) => setForm({ ...form, maxMediaPerMessage: num(e.target.value, 3) })} /></div>
              <label className="flex items-center gap-2 pt-6 text-sm"><Checkbox checked={form.attachProductImages} onCheckedChange={(v) => setForm({ ...form, attachProductImages: v === true })} /> Gửi kèm ảnh/video</label>
            </div>
            <div>
              <Label className="mb-1 block">Mã luôn coi là mã xả (ngoài điều kiện tự động)</Label>
              <div className="flex flex-wrap gap-3">
                {products.map((p) => (
                  <label key={p.id} className="flex items-center gap-1.5 text-xs">
                    <Checkbox checked={form.clearanceProductIds.includes(p.id)} onCheckedChange={(v) => setForm({ ...form, clearanceProductIds: v === true ? [...form.clearanceProductIds, p.id] : form.clearanceProductIds.filter((x) => x !== p.id) })} /> {p.code ? `${p.code} · ` : ""}{p.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-1">
                <Label>Mẫu tin bán chéo thường · biến: {"{ten} {san_pham} {goi_y} {giam} {shop} {uu_dai}"}</Label>
                <Textarea rows={5} value={form.crossSellTemplate} onChange={(e) => setForm({ ...form, crossSellTemplate: e.target.value })} />
                <Button type="button" size="sm" variant="ghost" onClick={() => doPreview("cross", "CROSS_SELL", form.crossSellTemplate)} disabled={pending}><Eye className="size-4" /> Xem trước</Button>
                {preview.cross ? <p className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{preview.cross}</p> : null}
              </div>
              <div className="space-y-1">
                <Label>Mẫu tin khi gợi ý là mã xả (giá siêu hời)</Label>
                <Textarea rows={5} value={form.crossSellClearanceTemplate} onChange={(e) => setForm({ ...form, crossSellClearanceTemplate: e.target.value })} />
                <Button type="button" size="sm" variant="ghost" onClick={() => doPreview("clear", "CROSS_SELL", form.crossSellClearanceTemplate)} disabled={pending}><Eye className="size-4" /> Xem trước</Button>
                {preview.clear ? <p className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{preview.clear}</p> : null}
              </div>
            </div>
            <div>
              <Label className="mb-1 block">Ảnh / video gửi kèm theo mã hàng (mỗi dòng một URL công khai: ảnh thật, video TikTok/Facebook…; để trống = ảnh sản phẩm từ Pancake)</Label>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {products.map((p) => (
                  <div key={p.id} className="space-y-1">
                    <span className="block truncate text-xs font-medium" title={p.name}>{p.code ? `${p.code} · ` : ""}{p.name}</span>
                    <Textarea rows={2} className="text-xs" placeholder="https://…/anh-that.jpg&#10;https://…/video.mp4" value={mediaText[p.id] ?? ""} onChange={(e) => setMediaText({ ...mediaText, [p.id]: e.target.value })} />
                  </div>
                ))}
              </div>
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

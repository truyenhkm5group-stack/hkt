"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ProductionSheet } from "@/components/production-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveProductionOrder } from "@/lib/actions/production";
import { cellKey, colorSwatch } from "@/lib/constants/production";
import { formatNumber, formatVND } from "@/lib/format";

export type EditorInit = {
  id?: string;
  code?: string;
  product: { id: string; name: string; code: string };
  colors: string[];
  sizes: string[];
  cells: Record<string, number>;
  detail?: Record<string, { stock: number; available: number; sold30: number; suggested: number }>;
  images: { color: string; url: string }[];
  unitCost: number;
  supplier: string;
  note: string;
  dueDate: string;
};

export function ProductionEditor({ init }: { init: EditorInit }) {
  const [colors, setColors] = useState(init.colors);
  const [sizes, setSizes] = useState(init.sizes);
  const [cells, setCells] = useState<Record<string, number>>({ ...init.cells });
  const [images, setImages] = useState(init.images);
  const [supplier, setSupplier] = useState(init.supplier);
  const [note, setNote] = useState(init.note);
  const [dueDate, setDueDate] = useState(init.dueDate);
  const [unitCost, setUnitCost] = useState(init.unitCost);
  const [newColor, setNewColor] = useState("");
  const [newSize, setNewSize] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const total = useMemo(() => colors.reduce((s, c) => s + sizes.reduce((x, z) => x + (cells[cellKey(c, z)] || 0), 0), 0), [colors, sizes, cells]);
  const setCell = (c: string, s: string, v: string) => setCells((prev) => ({ ...prev, [cellKey(c, s)]: Math.max(0, Math.round(Number(v) || 0)) }));
  const fillSuggested = () => {
    const next: Record<string, number> = {};
    for (const [k, d] of Object.entries(init.detail ?? {})) next[k] = Math.max(0, d.suggested);
    setCells(next);
  };
  const save = () =>
    startTransition(async () => {
      const r = await saveProductionOrder({ productId: init.product.id, productCode: init.product.code, productName: init.product.name, colors, sizes, cells, images: images.filter((i) => i.url), unitCost, supplier, note, dueDate: dueDate || null }, init.id);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`Đã lưu bảng ${r.code}`);
        router.push(`/inventory/planning/orders/${r.id}`);
      }
    });

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <div className="rounded-xl border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold">Số lượng đặt theo màu × size</div>
            <Button type="button" size="sm" variant="ghost" onClick={fillSuggested} disabled={!init.detail}>Điền theo đề xuất ERP</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCells({})}>Xoá hết</Button>
            <span className="ml-auto text-sm">Tổng <b className="tabular-nums">{formatNumber(total)}</b> sp{unitCost ? ` · ~${formatVND(total * unitCost, { compact: true })}` : ""}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-center text-sm">
              <thead>
                <tr>
                  <th className="border bg-muted px-2 py-1.5 text-left">Size \ Màu</th>
                  {colors.map((c) => {
                    const sw = colorSwatch(c);
                    return (
                      <th key={c} className="border px-2 py-1.5" style={{ background: sw.bg, color: sw.fg }}>
                        <div className="flex items-center justify-center gap-1">{c}<button type="button" className="opacity-70 hover:opacity-100" title="Bỏ màu" onClick={() => setColors(colors.filter((x) => x !== c))}><Trash2 className="size-3" /></button></div>
                      </th>
                    );
                  })}
                  <th className="border bg-muted px-2 py-1.5">Tổng</th>
                </tr>
              </thead>
              <tbody>
                {sizes.map((s) => (
                  <tr key={s}>
                    <td className="border bg-muted/50 px-2 py-1 text-left font-semibold">
                      <div className="flex items-center gap-1">{s}<button type="button" className="text-muted-foreground hover:text-destructive" title="Bỏ size" onClick={() => setSizes(sizes.filter((x) => x !== s))}><Trash2 className="size-3" /></button></div>
                    </td>
                    {colors.map((c) => {
                      const d = init.detail?.[cellKey(c, s)];
                      return (
                        <td key={c} className="border p-1">
                          <Input type="number" min={0} className="h-8 w-20 text-center tabular-nums" value={cells[cellKey(c, s)] ?? ""} placeholder="0" onChange={(e) => setCell(c, s, e.target.value)} />
                          {d ? <div className="mt-0.5 text-[10px] text-muted-foreground" title="Tồn khả dụng · bán 30 ngày · ERP đề xuất">kd {d.available} · b30 {d.sold30} · đx {d.suggested}</div> : null}
                        </td>
                      );
                    })}
                    <td className="border bg-muted/40 px-2 font-semibold tabular-nums">{colors.reduce((x, c) => x + (cells[cellKey(c, s)] || 0), 0)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="border bg-muted px-2 py-1.5 text-left font-bold">Tổng</td>
                  {colors.map((c) => <td key={c} className="border bg-muted/40 px-2 font-bold tabular-nums">{sizes.reduce((x, s) => x + (cells[cellKey(c, s)] || 0), 0)}</td>)}
                  <td className="border bg-muted px-2 font-bold tabular-nums">{total}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <div className="flex items-center gap-1"><Input className="h-8 w-32" placeholder="Thêm màu" value={newColor} onChange={(e) => setNewColor(e.target.value)} /><Button type="button" size="sm" variant="outline" onClick={() => { const v = newColor.trim(); if (v && !colors.includes(v)) setColors([...colors, v]); setNewColor(""); }}><Plus className="size-4" /></Button></div>
            <div className="flex items-center gap-1"><Input className="h-8 w-28" placeholder="Thêm size" value={newSize} onChange={(e) => setNewSize(e.target.value)} /><Button type="button" size="sm" variant="outline" onClick={() => { const v = newSize.trim().toUpperCase(); if (v && !sizes.includes(v)) setSizes([...sizes, v]); setNewSize(""); }}><Plus className="size-4" /></Button></div>
          </div>
        </div>
        <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3">
          <div className="space-y-1"><Label>Xưởng may</Label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Tên xưởng / người nhận" /></div>
          <div className="space-y-1"><Label>Ngày cần hàng</Label><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
          <div className="space-y-1"><Label>Giá gia công / nhập (đ/sp)</Label><Input type="number" min={0} value={unitCost || ""} onChange={(e) => setUnitCost(Math.max(0, Number(e.target.value) || 0))} /></div>
          <div className="space-y-1 sm:col-span-3"><Label>Ghi chú cho xưởng</Label><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Chất liệu, yêu cầu may, đóng gói, lịch giao…" /></div>
          <div className="space-y-1 sm:col-span-3">
            <Label>Ảnh mẫu theo màu (URL công khai; để trống màu nào thì không in ảnh màu đó)</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {colors.map((c) => {
                const img = images.find((i) => i.color === c);
                return (
                  <div key={c} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 truncate text-xs font-medium">{c}</span>
                    <Input className="h-8 text-xs" placeholder="https://…" value={img?.url ?? ""} onChange={(e) => setImages([...images.filter((i) => i.color !== c), { color: c, url: e.target.value }])} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={save} disabled={pending || total <= 0}><Save className="size-4" /> {init.id ? "Lưu thay đổi" : "Chốt bảng đặt hàng"}</Button>
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-semibold">Xem trước bản gửi xưởng</div>
        <div className="rounded-xl border bg-white p-4 text-zinc-900">
          <ProductionSheet compact data={{ code: init.code ?? "(mới)", productCode: init.product.code, productName: init.product.name, colors, sizes, cells, images: images.filter((i) => i.url && colors.includes(i.color)), note, dueDate: dueDate ? new Date(dueDate) : null, supplier }} />
        </div>
      </div>
    </div>
  );
}

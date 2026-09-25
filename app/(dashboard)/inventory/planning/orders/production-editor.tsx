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
import { designWarning, diffCells, OVERRIDE_REASON_MIN } from "@/lib/constants/production-os";
import { formatDate, formatNumber, formatVND } from "@/lib/format";

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
  /*
    Company OS · Agent C — bản duyệt + gợi ý máy vs số người chốt. Tất cả tuỳ chọn để trình sửa vẫn mở
    được ở nơi chưa truyền (không có bản duyệt nào ⇒ ô chọn trống, không có gợi ý ⇒ không đòi lý do).
  */
  designVersionId?: string | null;
  designOptions?: { id: string; version: number; approvedAt: Date; approvedBy: string }[];
  /** Gợi ý đã LƯU trên lệnh (ảnh chụp lúc lần trước điền theo đề xuất). */
  storedSuggestion?: Record<string, number> | null;
  /** Ô khởi tạo có phải là đề xuất của máy không (bảng mới mở từ kế hoạch: có). */
  initialFromSuggestion?: boolean;
  /** Căn cứ kế hoạch để máy chủ tính LẠI đúng gợi ý đó lúc lưu. */
  suggestionBasis?: { coverDays: number; countIncoming: boolean };
  overrideReason?: string;
  requireApprovedDesign?: boolean;
};

/** `supplierOptions`: tên xưởng đang dùng trong danh mục — chỉ là GỢI Ý, máy chủ mới quyết lô thuộc xưởng nào. */
export function ProductionEditor({ init, supplierOptions = [] }: { init: EditorInit; supplierOptions?: string[] }) {
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
  const [designVersionId, setDesignVersionId] = useState(init.designVersionId ?? "");
  const [fromSuggestion, setFromSuggestion] = useState(Boolean(init.initialFromSuggestion && init.detail));
  const [overrideReason, setOverrideReason] = useState(init.overrideReason ?? "");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const total = useMemo(() => colors.reduce((s, c) => s + sizes.reduce((x, z) => x + (cells[cellKey(c, z)] || 0), 0), 0), [colors, sizes, cells]);
  const setCell = (c: string, s: string, v: string) => setCells((prev) => ({ ...prev, [cellKey(c, s)]: Math.max(0, Math.round(Number(v) || 0)) }));
  const suggestedFromDetail = useMemo(() => {
    const next: Record<string, number> = {};
    for (const [k, d] of Object.entries(init.detail ?? {})) if (d.suggested > 0) next[k] = d.suggested;
    return next;
  }, [init.detail]);
  const fillSuggested = () => {
    setCells({ ...suggestedFromDetail });
    setFromSuggestion(true);
  };
  // Chỉ gửi ô còn nằm trong ma trận hiện tại — ô của màu / size đã bỏ không được lẩn vào số chốt.
  const finalCells = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of colors) for (const s of sizes) {
      const v = cells[cellKey(c, s)] || 0;
      if (v > 0) out[cellKey(c, s)] = v;
    }
    return out;
  }, [colors, sizes, cells]);
  /*
    Số chốt so với GỢI Ý NÀO: vừa điền theo đề xuất ⇒ đề xuất đang thấy (máy chủ tính lại đúng căn cứ đó
    lúc lưu); chưa điền lại ⇒ gợi ý đã lưu trên lệnh. Không có gợi ý nào ⇒ không có gì để so.
  */
  const reference = fromSuggestion ? suggestedFromDetail : (init.storedSuggestion ?? null);
  const diff = useMemo(() => (reference ? diffCells(reference, finalCells) : []), [reference, finalCells]);
  const canLyDo = diff.length > 0 && overrideReason.trim().length < OVERRIDE_REASON_MIN;
  const save = () =>
    startTransition(async () => {
      const r = await saveProductionOrder(
        {
          productId: init.product.id,
          productCode: init.product.code,
          productName: init.product.name,
          colors,
          sizes,
          cells: finalCells,
          images: images.filter((i) => i.url),
          unitCost,
          supplier,
          note,
          dueDate: dueDate || null,
          designVersionId: designVersionId || null,
          fromSuggestion,
          suggestionBasis: init.suggestionBasis,
          overrideReason,
        },
        init.id,
      );
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`Đã lưu bảng ${r.code}${r.lifecycle ? ` · ${r.lifecycle}` : ""}`);
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
          <div className="space-y-1"><Label>Xưởng may</Label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Tên xưởng / người nhận" list="xuong-goi-y" /><datalist id="xuong-goi-y">{supplierOptions.map((n) => <option key={n} value={n} />)}</datalist></div>
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
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="space-y-1">
            <Label>Bản thiết kế đã duyệt mà xưởng may theo</Label>
            <select value={designVersionId} onChange={(e) => setDesignVersionId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="">— Chưa trỏ bản duyệt nào —</option>
              {(init.designOptions ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  Bản duyệt V{d.version} · {d.approvedBy || "—"} · {formatDate(d.approvedAt)}
                </option>
              ))}
            </select>
            {!designVersionId ? (
              <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                {designWarning(Boolean(init.requireApprovedDesign))}
                {(init.designOptions ?? []).length ? "" : " Mẫu này chưa có bản duyệt nào — duyệt mẫu ở trang Topic sản xuất."}
              </p>
            ) : null}
          </div>
          {reference ? (
            <div className="space-y-1">
              <div className="text-sm font-semibold">
                So với gợi ý của máy{fromSuggestion ? " (vừa điền theo đề xuất)" : " (đã lưu trên lệnh)"}:{" "}
                {diff.length ? <span className="text-amber-700 dark:text-amber-300">khác ở {diff.length} ô</span> : <span className="text-emerald-700 dark:text-emerald-300">khớp từng ô</span>}
              </div>
              {diff.length ? (
                <>
                  <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                    {diff.map((x) => (
                      <li key={x.key} className="tabular-nums">
                        {x.key.replace("|", " · ")}: máy {x.suggested} → chốt <b>{x.final}</b>
                      </li>
                    ))}
                  </ul>
                  <Textarea rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder={`Vì sao chốt khác gợi ý của máy (bắt buộc, ít nhất ${OVERRIDE_REASON_MIN} ký tự)`} />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={save} disabled={pending || total <= 0 || canLyDo} title={canLyDo ? "Ghi lý do chốt khác gợi ý của máy trước khi lưu" : undefined}><Save className="size-4" /> {init.id ? "Lưu thay đổi" : "Chốt bảng đặt hàng"}</Button>
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

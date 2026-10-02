"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useNavTransition } from "@/components/nav-progress";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deactivatePriceListAction, savePriceListAction } from "@/lib/actions/trade";
import { validateTiers } from "@/lib/constants/price-lists";
import { formatVND } from "@/lib/format";

type VariantOption = { id: string; label: string; sku: string; price: number | null };
type Row = { variantId: string; minQuantity: string; unitPrice: string };

const SELECT = "h-8 w-full rounded-md border bg-background px-2 text-sm";
const toInt = (v: string) => {
  const s = v.replace(/[.\s,]/g, "").trim();
  return s ? Number(s) : Number.NaN;
};

/**
 * Trình sửa MỘT bảng giá: tên, mặc định, các bậc (mẫu mã · mua từ · đơn giá). Kiểm bằng CÙNG hàm thuần với máy chủ
 * (`validateTiers`) để lỗi hiện ngay ở đúng ô; máy chủ vẫn kiểm lại.
 */
export function PriceListEditor({ id, initial, variants, active }: { id: string | null; initial: { name: string; note: string; isDefault: boolean; tiers: { variantId: string; minQuantity: number; unitPrice: number }[] }; variants: VariantOption[]; active: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [note, setNote] = useState(initial.note);
  const [isDefault, setIsDefault] = useState(initial.isDefault);
  const [rows, setRows] = useState<Row[]>(initial.tiers.length ? initial.tiers.map((t) => ({ variantId: t.variantId, minQuantity: String(t.minQuantity), unitPrice: String(t.unitPrice) })) : [{ variantId: "", minQuantity: "1", unitPrice: "" }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useNavTransition();
  const byId = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);

  const tiers = rows.filter((r) => r.variantId || r.unitPrice).map((r) => ({ variantId: r.variantId, minQuantity: toInt(r.minQuantity), unitPrice: toInt(r.unitPrice) }));
  const setRow = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = () => {
    const local = validateTiers(tiers);
    if (!name.trim()) local.unshift({ field: "name", message: "Đặt tên bảng giá." });
    if (local.length) {
      setErrors(Object.fromEntries(local.map((e) => [e.field, e.message])));
      return toast.error(local[0].message);
    }
    setErrors({});
    start(async () => {
      const r = await savePriceListAction(id, { name: name.trim(), note, isDefault, tiers });
      if (!r.ok) {
        setErrors(Object.fromEntries(r.errors.map((e) => [e.field, e.message])));
        toast.error(r.errors[0]?.message ?? "Không lưu được.");
        return;
      }
      toast.success(r.message);
      if (!id) router.push(`/products/price-lists/${r.id}`);
    });
  };
  const deactivate = () =>
    start(async () => {
      if (!id) return;
      const r = await deactivatePriceListAction(id);
      if (r.ok) toast.success(r.message);
      else toast.error(r.errors[0]?.message ?? "Không đổi được.");
    });

  // Dòng của một bảng tham chiếu theo CHỈ SỐ trong danh sách đã lọc dòng trống — đổi về chỉ số của `rows` để tô đúng ô.
  const filledIndex = (i: number) => rows.slice(0, i).filter((r) => r.variantId || r.unitPrice).length;
  const err = (i: number, f: string) => errors[`tiers.${filledIndex(i)}.${f}`];

  return (
    <div className="space-y-4" data-price-list-editor>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="pl-name">Tên bảng giá</Label>
          <Input id="pl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Đại lý cấp 1 / Khách sỉ / CTV…" />
          {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="pl-note">Ghi chú</Label>
          <Input id="pl-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Mặc định cho khách chưa gán bảng
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-2">Mẫu mã</th>
              <th className="w-28 py-1.5 pr-2">Mua từ (SL)</th>
              <th className="w-40 py-1.5 pr-2">Đơn giá (₫)</th>
              <th className="w-32 py-1.5 pr-2 text-right">Giá lẻ</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const v = byId.get(r.variantId);
              return (
                <tr key={i} className="border-t border-hairline align-top">
                  <td className="py-1.5 pr-2">
                    <select aria-label={`Mẫu mã dòng ${i + 1}`} className={SELECT} value={r.variantId} onChange={(e) => setRow(i, { variantId: e.target.value })}>
                      <option value="">— chọn mẫu mã —</option>
                      {variants.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                          {o.sku ? ` (${o.sku})` : ""}
                        </option>
                      ))}
                    </select>
                    {err(i, "variantId") ? <p className="text-xs text-destructive">{err(i, "variantId")}</p> : null}
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input aria-label={`Mua từ dòng ${i + 1}`} inputMode="numeric" value={r.minQuantity} onChange={(e) => setRow(i, { minQuantity: e.target.value })} className="numeric h-8 text-right" />
                    {err(i, "minQuantity") ? <p className="text-xs text-destructive">{err(i, "minQuantity")}</p> : null}
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input aria-label={`Đơn giá dòng ${i + 1}`} inputMode="numeric" value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: e.target.value })} className="numeric h-8 text-right" />
                    {err(i, "unitPrice") ? <p className="text-xs text-destructive">{err(i, "unitPrice")}</p> : null}
                  </td>
                  <td className="numeric py-1.5 pr-2 text-right text-muted-foreground">{v?.price ? formatVND(v.price) : "—"}</td>
                  <td className="py-1.5">
                    <Button type="button" variant="ghost" size="icon" aria-label={`Xoá dòng ${i + 1}`} onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [{ variantId: "", minQuantity: "1", unitPrice: "" }]))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setRows((prev) => [...prev, { variantId: prev[prev.length - 1]?.variantId ?? "", minQuantity: "", unitPrice: "" }])}>
          <Plus className="size-4" /> Thêm bậc
        </Button>
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Lưu bảng giá
        </Button>
        {id && active ? (
          <Button type="button" variant="outline" onClick={deactivate} disabled={pending}>
            Ngừng dùng
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">Mỗi dòng là một bậc: mua từ số lượng này trở lên thì áp đơn giá này. Cùng mẫu mã có thể nhiều bậc (vd từ 1 · từ 10 · từ 50). Mẫu mã không có dòng nào ⇒ dùng giá lẻ. Lưu xong chỉ áp cho đơn tạo / sửa từ bây giờ.</p>
    </div>
  );
}

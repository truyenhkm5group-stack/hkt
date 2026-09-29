"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createProductAction, updateProductAction } from "@/lib/actions/manual-products";
import { PRODUCT_UNIT_SUGGESTIONS } from "@/lib/constants/manual-products";
import { cn } from "@/lib/utils";

/**
 * Form tạo / sửa sản phẩm TẠO TAY (tổ chức không đồng bộ sản phẩm). Máy chủ kiểm lại mọi thứ (cổng năng lực tổ chức,
 * `products:write`, zod, trùng SKU) — form chỉ gom dữ liệu và tô lỗi theo ô (`field` của lỗi: `name`, `code`,
 * `variants.<i>.sku`…). Tiền để trống = CHƯA KHAI, không phải 0 đ.
 */

export type ProductFormVariant = { id?: string; sku: string; size: string; color: string; retailPrice: string; cost: string; selling: boolean };
export type ProductFormValues = { name: string; code: string; unit: string; retailPrice: string; cost: string; variants: ProductFormVariant[] };

const EMPTY_VARIANT: ProductFormVariant = { sku: "", size: "", color: "", retailPrice: "", cost: "", selling: true };

/** "150.000" / "150000đ" ⇒ 150000; trống ⇒ `null` (chưa khai). */
function toMoney(v: string): number | null {
  const digits = v.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

export function ProductForm({ mode, productId, initial }: { mode: "create" | "edit"; productId?: string; initial?: ProductFormValues }) {
  const router = useRouter();
  const [values, setValues] = useState<ProductFormValues>(initial ?? { name: "", code: "", unit: "cái", retailPrice: "", cost: "", variants: [{ ...EMPTY_VARIANT }] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (key: keyof Omit<ProductFormValues, "variants">, v: string) => setValues((prev) => ({ ...prev, [key]: v }));
  const setVariant = (i: number, patch: Partial<ProductFormVariant>) => setValues((prev) => ({ ...prev, variants: prev.variants.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const addVariant = () => setValues((prev) => ({ ...prev, variants: [...prev.variants, { ...EMPTY_VARIANT, sku: prev.code ? `${prev.code}-${prev.variants.length + 1}` : "" }] }));
  // Chỉ bỏ được dòng CHƯA lưu: mẫu mã đã có không xoá ở ERP (xoá là mất dòng phiếu kho của nó) — bỏ "Đang bán" thay vào.
  const removeVariant = (i: number) => setValues((prev) => ({ ...prev, variants: prev.variants.filter((_, j) => j !== i) }));

  const err = (key: string) => (errors[key] ? <p className="text-[11px] font-medium text-destructive">{errors[key]}</p> : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const variants = values.variants.map((v, i) => ({
      ...(v.id ? { id: v.id } : {}),
      // Sản phẩm một mẫu mã mà để trống SKU ⇒ dùng chính mã sản phẩm (thói quen bán buôn: mã hàng = SKU).
      sku: v.sku.trim() || (values.variants.length === 1 && i === 0 ? values.code.trim() : ""),
      size: v.size,
      color: v.color,
      retailPrice: toMoney(v.retailPrice),
      cost: toMoney(v.cost),
      selling: v.selling,
    }));
    const payload = { name: values.name, code: values.code, unit: values.unit, retailPrice: toMoney(values.retailPrice), cost: toMoney(values.cost), variants };
    setFormError(null);
    startTransition(async () => {
      const res = mode === "create" ? await createProductAction(payload) : await updateProductAction(productId ?? "", payload);
      if (!("ok" in res)) {
        const map: Record<string, string> = {};
        for (const x of res.errors) if (!(x.field in map)) map[x.field] = x.message;
        setErrors(map);
        setFormError(res.error);
        return;
      }
      setErrors({});
      toast.success(res.message);
      if ("redirectTo" in res && typeof res.redirectTo === "string") router.push(res.redirectTo);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pf-name">Tên sản phẩm *</Label>
          <Input id="pf-name" value={values.name} onChange={(e) => set("name", e.target.value)} placeholder="Vd: Nước suối 500ml" />
          {err("name")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="pf-code">Mã sản phẩm (SKU gốc) *</Label>
          <Input id="pf-code" value={values.code} onChange={(e) => set("code", e.target.value)} placeholder="Vd: NS-500" className="font-mono" />
          {err("code")}
          <p className="text-[11px] text-muted-foreground">Duy nhất trong tổ chức. Chữ/số Latin và . _ - /, không dấu cách.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pf-unit">Đơn vị tính *</Label>
          <Input id="pf-unit" value={values.unit} onChange={(e) => set("unit", e.target.value)} list="pf-unit-goi-y" placeholder="cái, thùng, kg…" />
          <datalist id="pf-unit-goi-y">
            {PRODUCT_UNIT_SUGGESTIONS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          {err("unit")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="pf-price">Giá bán (₫)</Label>
          <Input id="pf-price" inputMode="numeric" value={values.retailPrice} onChange={(e) => set("retailPrice", e.target.value)} placeholder="Áp cho mẫu mã không khai giá riêng" className="numeric" />
          {err("retailPrice")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="pf-cost">Giá vốn khai tay (₫)</Label>
          <Input id="pf-cost" inputMode="numeric" value={values.cost} onChange={(e) => set("cost", e.target.value)} placeholder="Để trống = chưa biết" className="numeric" />
          {err("cost")}
          <p className="text-[11px] text-muted-foreground">Phiếu nhập có đơn giá sẽ thay số này (giá vốn lấy theo phiếu nhập gần nhất).</p>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Mẫu mã ({values.variants.length})</legend>
        {err("variants")}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/40 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="px-3 py-2 text-left">SKU *</th>
                <th className="px-3 py-2 text-left">Size</th>
                <th className="px-3 py-2 text-left">Màu</th>
                <th className="px-3 py-2 text-right">Giá bán riêng</th>
                <th className="px-3 py-2 text-right">Giá vốn riêng</th>
                <th className="px-3 py-2 text-center">Đang bán</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {values.variants.map((v, i) => (
                <tr key={v.id ?? `moi-${i}`} className="border-t align-top">
                  <td className="px-3 py-1.5">
                    <Input aria-label={`SKU mẫu mã ${i + 1}`} value={v.sku} onChange={(e) => setVariant(i, { sku: e.target.value })} placeholder={values.variants.length === 1 ? values.code || "SKU" : "SKU"} className={cn("h-8 font-mono", errors[`variants.${i}.sku`] && "border-destructive")} />
                    {err(`variants.${i}.sku`)}
                    {err(`variants.${i}.id`)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input aria-label={`Size mẫu mã ${i + 1}`} value={v.size} onChange={(e) => setVariant(i, { size: e.target.value })} className="h-8" />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input aria-label={`Màu mẫu mã ${i + 1}`} value={v.color} onChange={(e) => setVariant(i, { color: e.target.value })} className="h-8" />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input aria-label={`Giá bán mẫu mã ${i + 1}`} inputMode="numeric" value={v.retailPrice} onChange={(e) => setVariant(i, { retailPrice: e.target.value })} placeholder="giá chung" className="numeric h-8 text-right" />
                    {err(`variants.${i}.retailPrice`)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input aria-label={`Giá vốn mẫu mã ${i + 1}`} inputMode="numeric" value={v.cost} onChange={(e) => setVariant(i, { cost: e.target.value })} placeholder="giá chung" className="numeric h-8 text-right" />
                    {err(`variants.${i}.cost`)}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <input type="checkbox" aria-label={`Đang bán mẫu mã ${i + 1}`} checked={v.selling} onChange={(e) => setVariant(i, { selling: e.target.checked })} className="mt-2" />
                  </td>
                  <td className="px-1 py-1.5">
                    {!v.id && values.variants.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => removeVariant(i)} aria-label={`Bỏ dòng mẫu mã ${i + 1}`}>
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addVariant}>
          <Plus className="size-4" /> Thêm mẫu mã
        </Button>
        <p className="text-[11px] text-muted-foreground">Tồn kho KHÔNG nhập ở đây: sau khi tạo, lập phiếu Nhập hàng (hoặc Kiểm kê) để sổ kho có số — chưa có phiếu nhập thì ERP ghi «Chưa có phiếu nhập», không hiện số bịa.</p>
      </fieldset>

      {formError ? <p className="text-sm font-medium text-destructive">{formError}</p> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "create" ? "Tạo sản phẩm" : "Lưu sản phẩm"}
        </Button>
      </div>
    </form>
  );
}

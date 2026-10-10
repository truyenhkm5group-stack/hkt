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
import { EXPERIENCE_PROFILES, type ExperienceProfile, type VariantField } from "@/lib/constants/experience-profile";
import { cn } from "@/lib/utils";

/**
 * Form tạo / sửa sản phẩm TẠO TAY (tổ chức không đồng bộ sản phẩm). Máy chủ kiểm lại mọi thứ (cổng năng lực tổ chức,
 * `products:write`, zod, trùng SKU) — form chỉ gom dữ liệu và tô lỗi theo ô (`field` của lỗi: `name`, `code`,
 * `variants.<i>.sku`…). Tiền để trống = CHƯA KHAI, không phải 0 đ.
 */

export type ProductFormVariant = { id?: string; sku: string; size: string; color: string; spec?: string; weight?: string; retailPrice: string; cost: string; selling: boolean; addOnOnly?: boolean };
export type ProductFormValues = { name: string; code: string; unit: string; retailPrice: string; cost: string; variants: ProductFormVariant[] };

const EMPTY_VARIANT: ProductFormVariant = { sku: "", size: "", color: "", spec: "", weight: "", retailPrice: "", cost: "", selling: true, addOnOnly: false };

/** "150.000" / "150000đ" ⇒ 150000; trống ⇒ `null` (chưa khai). */
function fieldValue(v: ProductFormVariant, f: VariantField): string {
  return (f.storage === "size" ? v.size : f.storage === "color" ? v.color : f.storage === "spec" ? v.spec : v.weight) ?? "";
}

function toMoney(v: string): number | null {
  const digits = v.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

/**
 * `profile` — hồ sơ ngành của tổ chức (`lib/constants/experience-profile.ts`), máy chủ đọc rồi truyền xuống: quyết định ô
 * nào của mẫu mã hiện ra và gọi là gì (thời trang: Size / Màu · thực phẩm: Quy cách / Khối lượng). Vắng ⇒ bộ chung.
 */
export function ProductForm({ mode, productId, initial, profile = EXPERIENCE_PROFILES.GENERIC_COMMERCE }: { mode: "create" | "edit"; productId?: string; initial?: ProductFormValues; profile?: ExperienceProfile }) {
  const router = useRouter();
  const fields = profile.variantFields;
  const term = profile.variantTerm;
  const [values, setValues] = useState<ProductFormValues>(initial ?? { name: "", code: "", unit: profile.defaultUnit, retailPrice: "", cost: "", variants: [{ ...EMPTY_VARIANT }] });
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
      spec: v.spec ?? "",
      weight: v.weight ? toMoney(v.weight) : null,
      retailPrice: toMoney(v.retailPrice),
      cost: toMoney(v.cost),
      selling: v.selling,
      addOnOnly: Boolean(v.addOnOnly),
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
          <Input id="pf-name" value={values.name} onChange={(e) => set("name", e.target.value)} placeholder={profile.examples.productName} />
          {err("name")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="pf-code">Mã sản phẩm (SKU gốc) *</Label>
          <Input id="pf-code" value={values.code} onChange={(e) => set("code", e.target.value)} placeholder={profile.examples.code} className="font-mono" />
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
          <Input id="pf-price" inputMode="numeric" value={values.retailPrice} onChange={(e) => set("retailPrice", e.target.value)} placeholder={`Áp cho ${term.toLowerCase()} không khai giá riêng`} className="numeric" />
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
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{term} ({values.variants.length})</legend>
        {err("variants")}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/40 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="px-3 py-2 text-left">SKU *</th>
                {fields.map((f) => (
                  <th key={f.storage} className={cn("px-3 py-2", f.storage === "weight" ? "text-right" : "text-left")}>
                    {f.label}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Giá bán riêng</th>
                <th className="px-3 py-2 text-right">Giá vốn riêng</th>
                <th className="px-3 py-2 text-center">Đang bán</th>
                <th className="px-3 py-2 text-center" title="Không báo giá / không bán riêng — chỉ thêm khi đơn đã có mẫu mã chính (vd 0,5kg)">Chỉ bán kèm</th>
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
                  {fields.map((f) => (
                    <td key={f.storage} className="px-3 py-1.5">
                      <Input
                        aria-label={`${f.label} ${term.toLowerCase()} ${i + 1}`}
                        value={fieldValue(v, f)}
                        onChange={(e) => setVariant(i, { [f.storage]: e.target.value })}
                        placeholder={f.placeholder}
                        inputMode={f.storage === "weight" ? "numeric" : undefined}
                        className={cn("h-8", f.storage === "weight" && "numeric text-right")}
                      />
                      {err(`variants.${i}.${f.storage}`)}
                    </td>
                  ))}
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
                  <td className="px-3 py-1.5 text-center">
                    <input type="checkbox" aria-label={`Chỉ bán kèm mẫu mã ${i + 1}`} checked={Boolean(v.addOnOnly)} onChange={(e) => setVariant(i, { addOnOnly: e.target.checked })} className="mt-2" />
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
          <Plus className="size-4" /> Thêm {term.toLowerCase()}
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

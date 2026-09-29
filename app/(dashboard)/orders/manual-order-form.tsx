"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createManualOrderAction, updateManualOrderAction } from "@/lib/actions/manual-orders";
import { manualOrderStageLabel, manualOrderTotals, MANUAL_ORDER_STAGE_HINT, MANUAL_ORDER_STAGES, type ManualOrderCustomerOption, type ManualOrderStage, type ManualOrderVariantOption } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Form tạo / sửa ĐƠN TẠO TAY (tổ chức không đồng bộ đơn). Máy chủ kiểm lại mọi thứ (cổng tổ chức, `orders:write`, zod,
 * khách / mẫu mã có thật, phép tính tiền) — form chỉ gom dữ liệu, hiện số bằng CHÍNH hàm tính của máy chủ
 * (`manualOrderTotals`) và tô lỗi theo ô (`customerId`, `lines.<i>.quantity`, `orderDiscount`…).
 *
 * Không `useTransition`: form chỉ điều hướng SAU khi lưu xong, trạng thái chờ là cờ riêng của nút.
 */

type Line = { variantId: string; quantity: string; unitPrice: string; discount: string };
type RecipientDraft = { name: string; phone: string; address: string; province: string };
export type ManualOrderFormValues = { customerId: string; stage: ManualOrderStage; channel: string; note: string; orderDiscount: string; shippingFee: string; lines: Line[]; recipient?: RecipientDraft };
const EMPTY_RECIPIENT: RecipientDraft = { name: "", phone: "", address: "", province: "" };

const EMPTY_LINE: Line = { variantId: "", quantity: "1", unitPrice: "", discount: "" };
const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";

/** "150.000" / "150000đ" ⇒ 150000; trống ⇒ `fallback` (NaN ⇒ máy chủ báo lỗi đúng ô). */
function toInt(v: string, fallback = Number.NaN): number {
  const digits = v.replace(/[^\d]/g, "");
  return digits ? Number(digits) : fallback;
}

export function ManualOrderForm({
  mode,
  orderId,
  initial,
  customers,
  variants,
}: {
  mode: "create" | "edit";
  orderId?: string;
  initial?: ManualOrderFormValues;
  customers: ManualOrderCustomerOption[];
  variants: ManualOrderVariantOption[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<ManualOrderFormValues>(initial ?? { customerId: "", stage: "CONFIRMED", channel: "", note: "", orderDiscount: "", shippingFee: "", lines: [{ ...EMPTY_LINE }] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const variantById = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);

  const payload = () => ({
    customerId: values.customerId,
    stage: values.stage,
    channel: values.channel,
    note: values.note,
    orderDiscount: toInt(values.orderDiscount, 0),
    shippingFee: toInt(values.shippingFee, 0),
    lines: values.lines.map((l) => ({ variantId: l.variantId, quantity: toInt(l.quantity), unitPrice: toInt(l.unitPrice), discount: toInt(l.discount, 0) })),
    // Ô trống = lấy của hồ sơ khách (máy chủ quyết); chỉ gửi khi có ít nhất một ô.
    ...(values.recipient && Object.values(values.recipient).some((x) => x.trim()) ? { recipient: values.recipient } : {}),
  });
  const recipient = values.recipient ?? EMPTY_RECIPIENT;
  const setRecipient = (patch: Partial<RecipientDraft>) => setValues((prev) => ({ ...prev, recipient: { ...(prev.recipient ?? EMPTY_RECIPIENT), ...patch } }));
  const preview = manualOrderTotals(payload().lines, toInt(values.orderDiscount, 0), toInt(values.shippingFee, 0));

  const set = <K extends keyof Omit<ManualOrderFormValues, "lines">>(key: K, v: ManualOrderFormValues[K]) => setValues((prev) => ({ ...prev, [key]: v }));
  const setLine = (i: number, patch: Partial<Line>) => setValues((prev) => ({ ...prev, lines: prev.lines.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const pickVariant = (i: number, id: string) => {
    const price = variantById.get(id)?.price;
    setValues((prev) => ({ ...prev, lines: prev.lines.map((x, j) => (j === i ? { ...x, variantId: id, unitPrice: x.unitPrice || (price ? String(price) : "") } : x)) }));
  };
  const addLine = () => setValues((prev) => ({ ...prev, lines: [...prev.lines, { ...EMPTY_LINE }] }));
  const removeLine = (i: number) => setValues((prev) => ({ ...prev, lines: prev.lines.filter((_, j) => j !== i) }));
  const err = (key: string) => (errors[key] ? <p className="text-[11px] font-medium text-destructive">{errors[key]}</p> : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      const res = mode === "create" ? await createManualOrderAction(payload()) : await updateManualOrderAction(orderId ?? "", payload());
      if (!("ok" in res)) {
        const map: Record<string, string> = {};
        for (const x of res.errors) if (!(x.field in map)) map[x.field] = x.message;
        setErrors(map);
        setFormError(res.error);
        return;
      }
      setErrors({});
      toast.success(res.message);
      router.push(res.redirectTo);
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="mo-customer">Khách hàng *</Label>
          <select id="mo-customer" className={cn(SELECT, errors.customerId && "border-destructive")} value={values.customerId} onChange={(e) => set("customerId", e.target.value)}>
            <option value="">— Chọn khách —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ""}
                {c.province ? ` · ${c.province}` : ""}
              </option>
            ))}
          </select>
          {err("customerId")}
          <p className="text-[11px] text-muted-foreground">Tên, SĐT và địa chỉ giao lấy từ hồ sơ khách lúc lưu. Khách mới thì tạo ở trang Khách hàng trước.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mo-stage">Trạng thái *</Label>
          <select id="mo-stage" className={SELECT} value={values.stage} onChange={(e) => set("stage", e.target.value as ManualOrderStage)}>
            {MANUAL_ORDER_STAGES.map((s) => (
              <option key={s} value={s}>
                {manualOrderStageLabel(s)}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">{MANUAL_ORDER_STAGE_HINT[values.stage]}</p>
          {err("stage")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="mo-channel">Kênh bán</Label>
          <Input id="mo-channel" value={values.channel} onChange={(e) => set("channel", e.target.value)} placeholder="Vd: Gọi điện, Tại cửa hàng, Zalo" />
          {err("channel")}
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Dòng hàng ({values.lines.length})</legend>
        {err("lines")}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/40 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Mẫu mã *</th>
                <th className="px-3 py-2 text-right">SL *</th>
                <th className="px-3 py-2 text-right">Đơn giá (₫) *</th>
                <th className="px-3 py-2 text-right">Chiết khấu dòng (₫)</th>
                <th className="px-3 py-2 text-right">Thành tiền</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {values.lines.map((l, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-3 py-1.5">
                    <select aria-label={`Mẫu mã dòng ${i + 1}`} className={cn(SELECT, "h-8", errors[`lines.${i}.variantId`] && "border-destructive")} value={l.variantId} onChange={(e) => pickVariant(i, e.target.value)}>
                      <option value="">— Chọn mẫu mã —</option>
                      {variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.sku ? `${v.sku} · ` : ""}
                          {v.label}
                        </option>
                      ))}
                    </select>
                    {err(`lines.${i}.variantId`)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input aria-label={`Số lượng dòng ${i + 1}`} inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className="numeric h-8 w-20 text-right" />
                    {err(`lines.${i}.quantity`)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input aria-label={`Đơn giá dòng ${i + 1}`} inputMode="numeric" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} className="numeric h-8 text-right" />
                    {err(`lines.${i}.unitPrice`)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input aria-label={`Chiết khấu dòng ${i + 1}`} inputMode="numeric" value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} placeholder="0" className="numeric h-8 text-right" />
                    {err(`lines.${i}.discount`)}
                  </td>
                  <td className="numeric px-3 py-2.5 text-right">{preview.ok ? formatVND(preview.totals.lines[i]?.lineTotal ?? null) : "—"}</td>
                  <td className="px-1 py-1.5">
                    {values.lines.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => removeLine(i)} aria-label={`Bỏ dòng ${i + 1}`}>
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addLine}>
          <Plus className="size-4" /> Thêm dòng hàng
        </Button>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="mo-discount">Chiết khấu đơn (₫)</Label>
          <Input id="mo-discount" inputMode="numeric" value={values.orderDiscount} onChange={(e) => set("orderDiscount", e.target.value)} placeholder="0" className="numeric" />
          {err("orderDiscount")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="mo-ship">Phí ship (₫)</Label>
          <Input id="mo-ship" inputMode="numeric" value={values.shippingFee} onChange={(e) => set("shippingFee", e.target.value)} placeholder="0" className="numeric" />
          {err("shippingFee")}
        </div>
        <fieldset className="grid gap-3 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-2">
          <legend className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Người nhận / địa chỉ giao (để trống = theo hồ sơ khách)</legend>
          <Input aria-label="Tên người nhận" placeholder="Tên người nhận" value={recipient.name} onChange={(e) => setRecipient({ name: e.target.value })} />
          <Input aria-label="SĐT người nhận" placeholder="SĐT người nhận" inputMode="tel" value={recipient.phone} onChange={(e) => setRecipient({ phone: e.target.value })} />
          <Input aria-label="Địa chỉ giao" placeholder="Địa chỉ giao" className="sm:col-span-2" value={recipient.address} onChange={(e) => setRecipient({ address: e.target.value })} />
          <Input aria-label="Tỉnh / thành" placeholder="Tỉnh / thành" value={recipient.province} onChange={(e) => setRecipient({ province: e.target.value })} />
          {err("recipient")}
        </fieldset>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="mo-note">Ghi chú</Label>
          <Textarea id="mo-note" value={values.note} onChange={(e) => set("note", e.target.value)} rows={3} />
          {err("note")}
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        {preview.ok ? (
          <dl className="grid gap-1 sm:grid-cols-4">
            <div>
              <dt className="text-[11px] text-muted-foreground">Tiền hàng</dt>
              <dd className="numeric font-semibold">{formatVND(preview.totals.totalPrice)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Chiết khấu</dt>
              <dd className="numeric font-semibold">{formatVND(preview.totals.totalDiscount)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Sau chiết khấu</dt>
              <dd className="numeric font-semibold">{formatVND(preview.totals.totalPriceAfterDiscount)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Khách trả (gồm ship)</dt>
              <dd className="numeric font-semibold">{formatVND(preview.totals.grandTotal)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">Điền đủ mẫu mã, số lượng và đơn giá để xem tổng tiền.</p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">Tạo đơn KHÔNG trừ tồn thực tế: xuất hàng bằng phiếu xuất kho ở trang đơn. Kết quả giao / thu tiền của đơn không qua đơn vị vận chuyển chưa được ERP kết luận.</p>
      </div>

      {formError ? <p className="text-sm font-medium text-destructive">{formError}</p> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "create" ? "Tạo đơn hàng" : "Lưu đơn hàng"}
        </Button>
      </div>
    </form>
  );
}

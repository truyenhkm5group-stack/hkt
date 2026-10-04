"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createStockLotAction, deleteStockLotAction } from "@/lib/actions/stock-lots";
import { LOT_LIMITS } from "@/lib/constants/lots";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function firstError(r: { ok: false; errors: { message: string }[] }): string {
  return r.errors[0]?.message ?? "Không lưu được.";
}

/** Gắn lô lên MỘT dòng phiếu nhập: mã lô · hạn dùng · ngày sản xuất · số lượng (mặc định = phần chưa gắn). */
export function StockLotForm({ options }: { options: { itemId: string; label: string; free: number }[] }) {
  const [itemId, setItemId] = useState(options[0]?.itemId ?? "");
  const [lotCode, setLotCode] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [producedOn, setProducedOn] = useState("");
  const [quantity, setQuantity] = useState(options[0] ? String(options[0].free) : "");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const pick = (id: string) => {
    setItemId(id);
    const o = options.find((x) => x.itemId === id);
    if (o) setQuantity(String(o.free));
  };
  const submit = () =>
    start(async () => {
      const r = await createStockLotAction({ receiptItemId: itemId, lotCode, expiresOn, producedOn: producedOn || null, quantity: Number(quantity), note });
      if (r.ok) {
        toast.success(r.message);
        setLotCode("");
        setNote("");
      } else toast.error(firstError(r));
    });
  return (
    <div className="grid gap-3 text-sm md:grid-cols-4 md:items-end" data-stock-lot-form>
      <div className="space-y-1 md:col-span-4">
        <Label htmlFor="lot-item">Dòng phiếu nhập *</Label>
        <select id="lot-item" className={SELECT} value={itemId} onChange={(e) => pick(e.target.value)}>
          {options.map((o) => (
            <option key={o.itemId} value={o.itemId}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="lot-code">Mã lô *</Label>
        <Input id="lot-code" value={lotCode} onChange={(e) => setLotCode(e.target.value)} maxLength={LOT_LIMITS.codeMax} placeholder="In trên bao bì / hoá đơn NCC" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="lot-exp">Hạn dùng *</Label>
        <Input id="lot-exp" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="lot-mfg">Ngày sản xuất</Label>
        <Input id="lot-mfg" type="date" value={producedOn} max={expiresOn || undefined} onChange={(e) => setProducedOn(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="lot-qty">Số lượng *</Label>
        <Input id="lot-qty" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>
      <div className="space-y-1 md:col-span-3">
        <Label htmlFor="lot-note">Ghi chú</Label>
        <Input id="lot-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={LOT_LIMITS.noteMax} />
      </div>
      <Button type="button" onClick={submit} disabled={pending || !itemId || !lotCode.trim() || !expiresOn || !/^\d+$/.test(quantity)}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Gắn lô
      </Button>
    </div>
  );
}

/** Gỡ lô gắn nhầm — bắt buộc lý do. Không đổi tồn. */
export function DeleteStockLotButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
        Gỡ lô…
      </Button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Input className="h-7 w-44 text-xs" placeholder="Lý do gỡ" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={pending || reason.trim().length < LOT_LIMITS.reasonMin}
        onClick={() =>
          start(async () => {
            const r = await deleteStockLotAction(id, reason);
            if (r.ok) toast.success(r.message);
            else toast.error(firstError(r));
          })
        }
      >
        Gỡ lô
      </Button>
    </span>
  );
}

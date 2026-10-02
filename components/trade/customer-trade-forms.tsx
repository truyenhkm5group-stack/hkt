"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { collectCustomerDebtAction, setCustomerTermsAction } from "@/lib/actions/trade";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS } from "@/lib/constants/order-payments";
import { formatVND } from "@/lib/format";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function firstError(r: { ok: false; errors: { message: string }[] }): string {
  return r.errors[0]?.message ?? "Không lưu được.";
}

/** Ô số tiền / số ngày: trống ⇒ `null` (CHƯA KHAI), không phải 0. */
function optionalInt(v: string): number | null | "bad" {
  const s = v.replace(/[.\s,]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : "bad";
}

export function CustomerTermsForm({ customerId, priceLists, current }: { customerId: string; priceLists: { id: string; name: string; isDefault: boolean }[]; current: { priceListId: string | null; creditLimit: number | null; paymentTermsDays: number | null } }) {
  const [priceListId, setPriceListId] = useState(current.priceListId ?? "");
  const [limit, setLimit] = useState(current.creditLimit === null ? "" : String(current.creditLimit));
  const [days, setDays] = useState(current.paymentTermsDays === null ? "" : String(current.paymentTermsDays));
  const [pending, start] = useTransition();
  const save = () => {
    const creditLimit = optionalInt(limit);
    const paymentTermsDays = optionalInt(days);
    if (creditLimit === "bad" || paymentTermsDays === "bad") return toast.error("Hạn mức và số ngày là số nguyên không âm — để trống nếu chưa khai.");
    start(async () => {
      const r = await setCustomerTermsAction(customerId, { priceListId: priceListId || null, creditLimit, paymentTermsDays });
      if (r.ok) toast.success(r.message);
      else toast.error(firstError(r));
    });
  };
  const defaultList = priceLists.find((p) => p.isDefault);
  return (
    <div className="grid gap-3 sm:grid-cols-3 sm:items-end" data-customer-terms>
      <div className="space-y-1">
        <Label htmlFor="ct-list">Bảng giá</Label>
        <select id="ct-list" className={SELECT} value={priceListId} onChange={(e) => setPriceListId(e.target.value)}>
          <option value="">{defaultList ? `Mặc định (${defaultList.name})` : "Giá lẻ"}</option>
          {priceLists.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ct-limit">Hạn mức nợ (₫)</Label>
        <Input id="ct-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Trống = chưa khai" className="numeric" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ct-days">Số ngày được nợ</Label>
        <div className="flex gap-2">
          <Input id="ct-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="Trống = chưa khai" className="numeric" />
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Lưu
          </Button>
        </div>
      </div>
    </div>
  );
}

function nowLocalInput(): string {
  const d = new Date(Date.now() + 7 * 3_600_000);
  return d.toISOString().slice(0, 16);
}

/** Khách trả MỘT khoản cho nhiều đơn — máy chủ chia vào đơn cũ nhất trước và ghi một phiếu thu cho mỗi đơn. */
export function CollectDebtForm({ customerId, outstanding }: { customerId: string; outstanding: number }) {
  const [amount, setAmount] = useState(String(outstanding));
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>("BANK_TRANSFER");
  const [paidAt, setPaidAt] = useState(nowLocalInput());
  const [reference, setReference] = useState("");
  const [pending, start] = useTransition();
  const submit = () => {
    const n = optionalInt(amount);
    if (n === null || n === "bad" || n <= 0) return toast.error("Nhập số tiền thu (số nguyên dương).");
    start(async () => {
      // Ô datetime-local là giờ Việt Nam — gửi kèm múi +07:00 để máy chủ không đọc nhầm sang UTC.
      const r = await collectCustomerDebtAction(customerId, { amount: n, method, paidAt: `${paidAt}:00+07:00`, reference, note: "" });
      if (r.ok) toast.success(r.message);
      else toast.error(firstError(r));
    });
  };
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end" data-collect-debt>
      <div className="space-y-1">
        <Label htmlFor="cd-amount">Số tiền thu (tối đa {formatVND(outstanding)})</Label>
        <Input id="cd-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="numeric" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cd-method">Phương thức</Label>
        <select id="cd-method" className={SELECT} value={method} onChange={(e) => setMethod(e.target.value as (typeof PAYMENT_METHODS)[number])}>
          {PAYMENT_METHODS.filter((m) => m !== "COD").map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="cd-at">Lúc nhận tiền</Label>
        <Input id="cd-at" type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cd-ref">Số tham chiếu</Label>
        <Input id="cd-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder="Mã giao dịch ngân hàng…" />
      </div>
      <Button type="button" onClick={submit} disabled={pending || outstanding <= 0}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Ghi thu nợ
      </Button>
    </div>
  );
}

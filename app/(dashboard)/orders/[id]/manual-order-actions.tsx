"use client";

import { useState } from "react";
import { Banknote, Loader2, PackageCheck, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cancelManualOrderAction, confirmManualDeliveryAction, recordManualPaymentAction, voidManualDeliveryAction, voidManualPaymentAction } from "@/lib/actions/manual-orders";
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentKind, type PaymentMethod } from "@/lib/constants/order-payments";

/**
 * Huỷ ĐƠN TAY — hỏi lý do (vào nhật ký), gọi `cancelManualOrderAction`. Server action tự `revalidatePath` trang đơn nên
 * KHÔNG `router.refresh()` ở đây (làm vậy là dựng trang hai lần). Đơn đồng bộ không bao giờ có nút này.
 */
export function CancelManualOrderButton({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <XCircle className="size-4" /> Huỷ đơn
      </Button>
    );

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await cancelManualOrderAction(orderId, { reason });
      if (!("ok" in res)) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-md space-y-2 rounded-lg border bg-background p-3">
      <Textarea aria-label="Lý do huỷ đơn" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Vì sao huỷ đơn (bắt buộc)" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xác nhận huỷ
        </Button>
      </div>
    </div>
  );
}

/** "YYYY-MM-DDTHH:mm" theo GIỜ VIỆT NAM — giá trị cho ô `datetime-local` (luôn đọc là giờ VN, không theo máy người dùng). */
function vnLocalInput(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

/** Ô `datetime-local` (giờ VN) ⇒ ISO có múi giờ. Rỗng / hỏng ⇒ chuỗi rỗng (máy chủ báo lỗi đúng ô). */
function vnInputToIso(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return "";
  const d = new Date(`${v}:00+07:00`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

/**
 * XÁC NHẬN ĐÃ GIAO bằng PHIẾU GIAO CÓ KÝ NHẬN (G-ORDER — ORDER_OUTCOME.md mục 11). Chỉ hiện cho đơn tay «Đã xác nhận».
 * Hỏi đúng ba thứ trên tờ phiếu: mốc người nhận ký, tên người ký, ghi chú. Sau khi lưu: đơn «Đã nhận», hàng trừ khỏi kho;
 * TIỀN KHÔNG ĐỔI — phiếu giao không phải chứng từ thanh toán, câu xác nhận nói rõ điều đó.
 */
export function ConfirmManualDeliveryButton({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [signedAt, setSignedAt] = useState(() => vnLocalInput(new Date()));
  const [receiver, setReceiver] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PackageCheck className="size-4" /> Xác nhận đã giao (phiếu giao có ký nhận)
      </Button>
    );

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await confirmManualDeliveryAction(orderId, { signedAt: vnInputToIso(signedAt), receiverName: receiver, note });
      if (!("ok" in res)) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-md space-y-2 rounded-lg border bg-background p-3">
      <p className="text-[12.5px] text-muted-foreground">Nhập theo tờ phiếu giao đã có chữ ký người nhận. Xác nhận giao KHÔNG ghi nhận tiền — doanh thu chờ chứng từ thanh toán.</p>
      <label className="block space-y-1 text-[12.5px]">
        <span className="font-medium">Mốc người nhận ký (giờ Việt Nam)</span>
        <Input type="datetime-local" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} aria-label="Mốc người nhận ký" />
      </label>
      <label className="block space-y-1 text-[12.5px]">
        <span className="font-medium">Người ký nhận</span>
        <Input value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder="Tên ghi trên phiếu" aria-label="Người ký nhận" />
      </label>
      <Textarea aria-label="Ghi chú phiếu giao" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Ghi chú (không bắt buộc) — số phiếu, người giao…" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu phiếu giao
        </Button>
      </div>
    </div>
  );
}

/** HUỶ PHIẾU GIAO ghi nhầm — bắt buộc lý do (vào nhật ký); phiếu giữ làm vết, đơn về «Đã xác nhận», hàng quay lại kho. */
export function VoidManualDeliveryButton({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Undo2 className="size-4" /> Huỷ phiếu giao (ghi nhầm)
      </Button>
    );

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await voidManualDeliveryAction(orderId, { reason });
      if (!("ok" in res)) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-md space-y-2 rounded-lg border bg-background p-3">
      <Textarea aria-label="Lý do huỷ phiếu giao" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Vì sao huỷ phiếu giao (bắt buộc)" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xác nhận huỷ phiếu
        </Button>
      </div>
    </div>
  );
}

/**
 * GHI CHỨNG TỪ THANH TOÁN (ORDER_OUTCOME.md mục 11) — phiếu THU hoặc phiếu HOÀN TIỀN cho đơn tay. Hỏi đúng những gì trên
 * chứng từ: loại, phương thức, số tiền, mốc tiền đổi tay, số tham chiếu, ghi chú. Ghi chứng từ KHÔNG đổi trạng thái giao
 * hàng và không trừ tồn — chỉ đổi chiều tiền.
 */
export function RecordManualPaymentButton({ orderId, allowReceipt, allowRefund, suggestedAmount }: { orderId: string; allowReceipt: boolean; allowRefund: boolean; suggestedAmount: number }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PaymentKind>(allowReceipt ? "RECEIPT" : "REFUND");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [amount, setAmount] = useState(() => (allowReceipt && suggestedAmount > 0 ? String(suggestedAmount) : ""));
  const [paidAt, setPaidAt] = useState(() => vnLocalInput(new Date()));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Banknote className="size-4" /> Ghi chứng từ thanh toán
      </Button>
    );

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const digits = amount.replace(/[^0-9]/g, "");
      const res = await recordManualPaymentAction(orderId, { kind, method, amount: digits ? Number(digits) : 0, paidAt: vnInputToIso(paidAt), reference, note });
      if (!("ok" in res)) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  const kinds = ([allowReceipt ? "RECEIPT" : null, allowRefund ? "REFUND" : null] as const).filter((k): k is PaymentKind => k !== null);
  return (
    <div className="w-full max-w-md space-y-2 rounded-lg border bg-background p-3">
      <p className="text-[12.5px] text-muted-foreground">Nhập theo chứng từ thật (phiếu thu, giao dịch ngân hàng, biên nhận của shipper). Chứng từ chỉ đổi chiều TIỀN — không đổi trạng thái giao, không trừ tồn.</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1 text-[12.5px]">
          <span className="font-medium">Loại</span>
          <select className="h-9 w-full rounded-md border bg-background px-2" value={kind} onChange={(e) => setKind(e.target.value as PaymentKind)} aria-label="Loại chứng từ">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {PAYMENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-[12.5px]">
          <span className="font-medium">Phương thức</span>
          <select className="h-9 w-full rounded-md border bg-background px-2" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} aria-label="Phương thức thanh toán">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-[12.5px]">
        <span className="font-medium">Số tiền (đồng)</span>
        <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Ví dụ 1500000" aria-label="Số tiền" />
      </label>
      <label className="block space-y-1 text-[12.5px]">
        <span className="font-medium">Mốc tiền đổi tay (giờ Việt Nam)</span>
        <Input type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} aria-label="Mốc thanh toán" />
      </label>
      <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Số tham chiếu (mã giao dịch, số phiếu thu…)" aria-label="Số tham chiếu" />
      <Textarea aria-label="Ghi chú chứng từ" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Ghi chú (không bắt buộc)" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu chứng từ
        </Button>
      </div>
    </div>
  );
}

/** HUỶ CHỨNG TỪ THANH TOÁN ghi nhầm — bắt buộc lý do (vào nhật ký); chứng từ giữ làm vết, thôi vào mọi phép tính. */
export function VoidManualPaymentButton({ orderId, paymentId }: { orderId: string; paymentId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Undo2 className="size-4" /> Huỷ
      </Button>
    );

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await voidManualPaymentAction(orderId, { paymentId, reason });
      if (!("ok" in res)) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="ml-auto w-64 space-y-2 text-left">
      <Textarea aria-label="Lý do huỷ chứng từ" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Vì sao huỷ chứng từ (bắt buộc)" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Huỷ chứng từ
        </Button>
      </div>
    </div>
  );
}

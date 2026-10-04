"use client";

import { useState } from "react";
import { Ban, Calculator, Loader2, Printer, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cancelVtpShipmentAction, createVtpShipmentAction, discardVtpCreateAction, quoteVtpShipmentAction, vtpPrintLinkAction } from "@/lib/actions/carrier-shipments";
import type { VtpQuote } from "@/lib/constants/carrier-vtp";
import type { CarrierAttemptView, CarrierPanelView } from "@/lib/carriers/vtp-shipments";
import { formatDateTime, formatVND } from "@/lib/format";

/**
 * TẠO VẬN ĐƠN VIETTEL POST cho đơn ERP «Đã xác nhận» (POS tự chủ). Ba bước trên một khung: nhập cân nặng + tiền thu hộ →
 * «Tính cước» (hãng trả bảng dịch vụ VÀ địa chỉ nhận mà hãng đọc được — đọc sai xã thì sửa đơn, đừng tạo) → chọn dịch vụ →
 * «Tạo vận đơn». Đổi cân nặng / tiền thu hộ thì bảng cước cũ bị bỏ: giá đó không còn đúng. Server action tự `revalidatePath`.
 */
export function CreateVtpShipmentButton({ orderId, defaults }: { orderId: string; defaults: CarrierPanelView["defaults"] }) {
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState(defaults.weightGrams ? String(defaults.weightGrams) : "");
  const [cod, setCod] = useState(String(defaults.cod));
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<VtpQuote | null>(null);
  const [service, setService] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"quote" | "create" | null>(null);

  if (!open)
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Truck className="size-4" /> Tạo vận đơn Viettel Post
      </Button>
    );

  const numbers = () => ({ weightGrams: Number(weight), cod: Number(cod) });
  const changed = (fn: () => void) => {
    fn();
    setQuote(null);
    setService("");
  };

  const runQuote = async () => {
    setPending("quote");
    setError(null);
    try {
      const res = await quoteVtpShipmentAction(orderId, numbers());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setQuote(res.quote);
      setService(res.quote.services[0]?.code ?? "");
    } finally {
      setPending(null);
    }
  };

  const create = async () => {
    setPending("create");
    setError(null);
    try {
      const res = await createVtpShipmentAction(orderId, { ...numbers(), serviceCode: service, note });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="w-full max-w-xl space-y-3 rounded-lg border bg-background p-3 text-[12.5px]">
      <p className="text-muted-foreground">
        Gửi tới: <span className="font-medium text-foreground">{defaults.receiverAddress || "— (đơn chưa có địa chỉ)"}</span>
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="font-medium">Trọng lượng (gam)</span>
          <Input inputMode="numeric" value={weight} onChange={(e) => changed(() => setWeight(e.target.value.replace(/\D/g, "")))} placeholder="Ví dụ 500" aria-label="Trọng lượng (gam)" />
          {defaults.weightGrams === null ? <span className="text-[11.5px] text-muted-foreground">Mẫu mã chưa khai cân nặng — nhập tay.</span> : null}
        </label>
        <label className="space-y-1">
          <span className="font-medium">Tiền thu hộ (VND)</span>
          <Input inputMode="numeric" value={cod} onChange={(e) => changed(() => setCod(e.target.value.replace(/\D/g, "")))} aria-label="Tiền thu hộ" />
          <span className="text-[11.5px] text-muted-foreground">Mặc định = số khách còn phải trả theo chứng từ thanh toán. Cước hãng do shop trả.</span>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="font-medium">Ghi chú trên vận đơn</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={150} placeholder="Để trống = ghi chú mặc định của shop (khai ở kết nối Viettel Post)" aria-label="Ghi chú trên vận đơn" />
      </label>
      {quote ? (
        <div className="space-y-2">
          {quote.receiverAddressAsRead ? (
            <p className="rounded-md bg-muted/50 px-2 py-1.5">
              Viettel Post đọc địa chỉ nhận là: <span className="font-semibold">{quote.receiverAddressAsRead}</span> — sai xã / tỉnh thì sửa địa chỉ đơn trước khi tạo.
            </p>
          ) : null}
          <fieldset className="space-y-1">
            <legend className="font-medium">Dịch vụ</legend>
            {quote.services.map((sv) => (
              <label key={sv.code} className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 hover:bg-muted/40">
                <input type="radio" name={`vtp-service-${orderId}`} value={sv.code} checked={service === sv.code} onChange={() => setService(sv.code)} />
                <span className="flex-1">
                  {sv.name || sv.code} <span className="text-muted-foreground">({sv.code}{sv.eta ? ` · ${sv.eta}` : ""})</span>
                </span>
                <span className="font-semibold">{formatVND(sv.fee)}</span>
              </label>
            ))}
          </fieldset>
        </div>
      ) : null}
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending !== null}>
          Thôi
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={runQuote} disabled={pending !== null || !weight}>
          {pending === "quote" ? <Loader2 className="size-4 animate-spin" /> : <Calculator className="size-4" />} Tính cước
        </Button>
        <Button type="button" size="sm" onClick={create} disabled={pending !== null || !quote || !service}>
          {pending === "create" ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} Tạo vận đơn
        </Button>
      </div>
    </div>
  );
}

/** Thao tác trên MỘT lần gửi do ERP tạo: in nhãn · huỷ ở hãng (khi hãng chưa lấy hàng) · bỏ lượt tạo không rõ kết quả. */
export function VtpAttemptActions({ orderId, attempt }: { orderId: string; attempt: CarrierAttemptView }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"print" | "cancel" | "discard" | null>(null);

  const print = async () => {
    setPending("print");
    setError(null);
    // Mở cửa sổ NGAY trong cú bấm (trình duyệt chặn cửa sổ mở sau một lượt chờ mạng), rồi trỏ nó tới link in.
    const win = window.open("about:blank", "_blank");
    try {
      const res = await vtpPrintLinkAction(attempt.id);
      if (!res.ok) {
        win?.close();
        setError(res.error);
        return;
      }
      if (win) win.location.href = res.url;
      else window.location.href = res.url;
    } finally {
      setPending(null);
    }
  };

  const cancel = async () => {
    setPending("cancel");
    setError(null);
    try {
      const res = await cancelVtpShipmentAction(orderId, attempt.id, { reason });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setCancelOpen(false);
    } finally {
      setPending(null);
    }
  };

  const discard = async () => {
    setPending("discard");
    setError(null);
    try {
      const res = await discardVtpCreateAction(orderId, attempt.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
    } finally {
      setPending(null);
    }
  };

  const create = attempt.create;
  return (
    <div className="space-y-2 text-[12.5px]">
      {create?.state === "UNKNOWN" || create?.state === "REQUESTED" ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
          Lượt tạo vận đơn mã <span className="font-mono">{create.reference}</span> {create.state === "UNKNOWN" ? "không rõ kết quả" : "đang chờ hãng trả lời"} ({formatDateTime(new Date(create.at))})
          {create.message ? `: ${create.message}` : ""}. Tra trên viettelpost.vn theo mã đó: có vận đơn thì chờ webhook; không có thì bỏ lượt này rồi tạo lại.
        </p>
      ) : null}
      {attempt.cancel ? (
        <p className="text-muted-foreground">
          Viettel Post đã nhận lệnh huỷ lúc {formatDateTime(new Date(attempt.cancel.at))} ({attempt.cancel.reason}) — trạng thái «Đã huỷ» về theo webhook.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {attempt.canPrint ? (
          <Button type="button" variant="outline" size="sm" onClick={print} disabled={pending !== null}>
            {pending === "print" ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />} In nhãn Viettel Post
          </Button>
        ) : null}
        {attempt.canCancel && !cancelOpen ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setCancelOpen(true)} disabled={pending !== null}>
            <Ban className="size-4" /> Huỷ vận đơn
          </Button>
        ) : null}
        {attempt.canDiscard ? (
          <Button type="button" variant="outline" size="sm" onClick={discard} disabled={pending !== null}>
            {pending === "discard" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Bỏ lượt tạo
          </Button>
        ) : null}
      </div>
      {cancelOpen ? (
        <div className="w-full max-w-md space-y-2 rounded-lg border bg-background p-3">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={150} placeholder="Vì sao huỷ vận đơn (bắt buộc)" aria-label="Lý do huỷ vận đơn" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCancelOpen(false)} disabled={pending !== null}>
              Thôi
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={cancel} disabled={pending !== null}>
              {pending === "cancel" ? <Loader2 className="size-4 animate-spin" /> : null} Huỷ ở Viettel Post
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

"use client";

import { useState } from "react";
import { Loader2, PackageCheck, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cancelManualOrderAction, confirmManualDeliveryAction, voidManualDeliveryAction } from "@/lib/actions/manual-orders";

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

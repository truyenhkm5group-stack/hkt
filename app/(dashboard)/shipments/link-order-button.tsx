"use client";

import * as React from "react";
import { linkShipmentToOrder } from "@/lib/actions/shipment-link";

/**
 * NÚT «GẮN ĐƠN» cho vận đơn chưa gắn đơn (vtp-direct-sync (4b), 25/10/2026). Shop tạo vận đơn thẳng trên app Viettel Post mà ô «Mã đơn
 * hàng» trống / sai ⇒ ERP không tự ghép được. Người trực nhập mã đơn ERP hoặc số đơn POS (vd 6277) — đúng dạng mà webhook và tệp nhập
 * nhận (order-reference.ts). Máy chủ chặn chiều hoàn và SĐT lệch, ghi nhật ký người bấm; `revalidatePath` của action làm mới bảng.
 * Không bao giờ ghép theo tên.
 */
export function LinkOrderButton({ shipmentId }: { shipmentId: string }) {
  const [open, setOpen] = React.useState(false);
  const [ref, setRef] = React.useState("");
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = React.useTransition();
  if (!open) {
    return (
      <button type="button" className="text-[11px] font-medium text-primary underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        Gắn đơn
      </button>
    );
  }
  return (
    <form
      className="flex flex-col gap-1"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await linkShipmentToOrder({ shipmentId, orderRef: ref });
          setMsg(r.ok ? { ok: true, text: `Đã gắn — lần gửi ${r.attemptNo}` } : { ok: false, text: r.error ?? "Không gắn được" });
        });
      }}
    >
      <input
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        placeholder="Mã đơn / số POS"
        aria-label="Mã đơn ERP hoặc số đơn POS"
        className="h-7 w-28 rounded border bg-background px-1.5 text-[12px]"
        autoFocus
      />
      <div className="flex gap-1">
        <button type="submit" disabled={pending || !ref.trim()} className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50">
          {pending ? "Đang gắn…" : "Gắn"}
        </button>
        <button type="button" className="rounded border px-2 py-0.5 text-[11px]" onClick={() => { setOpen(false); setMsg(null); }}>
          Huỷ
        </button>
      </div>
      {msg ? <p className={msg.ok ? "text-[11px] text-emerald-700 dark:text-emerald-400" : "text-[11px] text-rose-700 dark:text-rose-400"}>{msg.text}</p> : null}
    </form>
  );
}

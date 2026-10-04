"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Printer, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { bulkCreateAction, bulkPrintLinkAction, bulkQuoteAction } from "@/lib/actions/carrier-shipments";
import type { CarrierKey, CarrierQuote } from "@/lib/carriers/types";
import type { BulkCreateRow } from "@/lib/carriers/engine";
import { isManualOrderId, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";

/**
 * TẠO / IN VẬN ĐƠN HÀNG LOẠT từ các dòng đã chọn ở danh sách đơn (POS tự chủ · P2). Chỉ đơn tạo trong ERP được gửi đi (đơn
 * đồng bộ có nguồn của nó lo). Chọn hãng (khi tổ chức bật nhiều hãng) → tạo: tra bảng cước bằng đơn đầu tiên tạo được → chọn
 * MỘT dịch vụ → máy chủ tạo TUẦN TỰ qua đúng lõi tạo một đơn → bảng kết quả từng đơn (đơn hỏng không dừng cả lượt). In: một
 * link in cho mọi vận đơn của hãng đó.
 */
export function CarrierBulkActions({ carriers, orderIds, clear }: { carriers: { key: CarrierKey; label: string }[]; orderIds: string[]; clear: () => void }) {
  const ids = orderIds.filter((id) => isManualOrderId(id));
  const [carrier, setCarrier] = useState<CarrierKey>(carriers[0]?.key ?? "VTP");
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<CarrierQuote | null>(null);
  const [service, setService] = useState("");
  const [rows, setRows] = useState<BulkCreateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"quote" | "create" | "print" | null>(null);
  const label = carriers.find((c) => c.key === carrier)?.label ?? carrier;

  if (!ids.length) return <span className="text-[12px] text-muted-foreground">Vận đơn chỉ tạo cho đơn tạo trong ERP.</span>;

  const start = async () => {
    setOpen(true);
    setRows(null);
    setQuote(null);
    setError(null);
    setPending("quote");
    try {
      const res = await bulkQuoteAction(carrier, ids);
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
      const res = await bulkCreateAction(carrier, ids, { serviceCode: service });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRows(res.rows);
      toast.success(res.message);
    } finally {
      setPending(null);
    }
  };

  const print = async () => {
    setPending("print");
    setError(null);
    // Mở cửa sổ NGAY trong cú bấm — trình duyệt chặn cửa sổ mở sau một lượt chờ mạng.
    const win = window.open("about:blank", "_blank");
    try {
      const res = await bulkPrintLinkAction(carrier, ids);
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

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {carriers.length > 1 ? (
          <select
            aria-label="Hãng vận chuyển"
            className="h-8 rounded-md border bg-background px-2 text-[12.5px]"
            value={carrier}
            onChange={(e) => {
              setCarrier(e.target.value as CarrierKey);
              setQuote(null);
              setRows(null);
            }}
            disabled={pending !== null}
          >
            {carriers.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="button" size="sm" onClick={start} disabled={pending !== null}>
          {pending === "quote" ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} Tạo vận đơn {label} ({ids.length})
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={print} disabled={pending !== null}>
          {pending === "print" ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />} In nhãn {label}
        </Button>
      </div>
      {open ? (
        <div className="w-full max-w-2xl space-y-2 rounded-lg border bg-background p-3 text-[12.5px]">
          {quote && !rows ? (
            <>
              <p className="text-muted-foreground">
                Bảng cước tra theo đơn đầu tiên tạo được. Mỗi đơn dùng cân nặng mẫu mã × số lượng (thiếu ⇒ bỏ qua), thu hộ = số khách còn phải trả, ghi chú mặc định của shop, tỉnh / xã đơn đã lưu. Đơn nào hãng không nhận sẽ báo riêng.
              </p>
              <fieldset className="space-y-1">
                <legend className="font-medium">Dịch vụ dùng chung</legend>
                {quote.services.map((sv) => (
                  <label key={sv.code} className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 hover:bg-muted/40">
                    <input type="radio" name="bulk-service" value={sv.code} checked={service === sv.code} onChange={() => setService(sv.code)} />
                    <span className="flex-1">
                      {sv.name || sv.code} <span className="text-muted-foreground">({sv.code}{sv.eta ? ` · ${sv.eta}` : ""})</span>
                    </span>
                    <span className="font-semibold">{formatVND(sv.fee)}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}
          {rows ? (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {rows.map((r) => (
                <li key={r.orderId} className={r.ok ? "text-foreground" : "text-destructive"}>
                  <Link href={`/orders/${encodeURIComponent(r.orderId)}`} className="font-mono font-semibold hover:underline">
                    #{manualOrderShortCode(r.orderId)}
                  </Link>{" "}
                  — {r.ok ? `vận đơn ${r.trackingCode}` : r.message}
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <p className="font-medium text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              onClick={() => {
                setOpen(false);
                if (rows) clear();
              }}
            >
              {rows ? "Đóng" : "Thôi"}
            </Button>
            {quote && !rows ? (
              <Button type="button" size="sm" onClick={create} disabled={pending !== null || !service}>
                {pending === "create" ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} Tạo {ids.length} vận đơn {label}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

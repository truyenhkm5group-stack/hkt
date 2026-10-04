"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Printer, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { bulkCreateVtpShipmentsAction, bulkQuoteVtpAction, bulkVtpPrintLinkAction } from "@/lib/actions/carrier-shipments";
import type { VtpQuote } from "@/lib/constants/carrier-vtp";
import type { BulkCreateRow } from "@/lib/carriers/vtp-shipments";
import { isManualOrderId, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";

/**
 * TẠO / IN VẬN ĐƠN VIETTEL POST HÀNG LOẠT từ các dòng đã chọn ở danh sách đơn (POS tự chủ · P2). Chỉ đơn tạo trong ERP được
 * gửi đi (đơn đồng bộ có nguồn của nó lo). Tạo: tra bảng cước bằng đơn đầu tiên tạo được → chọn MỘT dịch vụ → máy chủ tạo
 * TUẦN TỰ qua đúng lõi tạo một đơn → bảng kết quả từng đơn (đơn hỏng không dừng cả lượt). In: một link in cho tất cả.
 */
export function VtpBulkActions({ orderIds, clear }: { orderIds: string[]; clear: () => void }) {
  const ids = orderIds.filter((id) => isManualOrderId(id));
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<VtpQuote | null>(null);
  const [service, setService] = useState("");
  const [rows, setRows] = useState<BulkCreateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"quote" | "create" | "print" | null>(null);

  if (!ids.length) return <span className="text-[12px] text-muted-foreground">Vận đơn Viettel Post chỉ tạo cho đơn tạo trong ERP.</span>;

  const start = async () => {
    setOpen(true);
    setRows(null);
    setError(null);
    setPending("quote");
    try {
      const res = await bulkQuoteVtpAction(ids);
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
      const res = await bulkCreateVtpShipmentsAction(ids, { serviceCode: service });
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
      const res = await bulkVtpPrintLinkAction(ids);
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
        <Button type="button" size="sm" onClick={start} disabled={pending !== null}>
          {pending === "quote" ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} Tạo vận đơn Viettel Post ({ids.length})
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={print} disabled={pending !== null}>
          {pending === "print" ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />} In nhãn Viettel Post
        </Button>
      </div>
      {open ? (
        <div className="w-full max-w-2xl space-y-2 rounded-lg border bg-background p-3 text-[12.5px]">
          {quote && !rows ? (
            <>
              <p className="text-muted-foreground">
                Bảng cước tra theo đơn đầu tiên tạo được. Mỗi đơn dùng cân nặng mẫu mã × số lượng (thiếu ⇒ bỏ qua), thu hộ = số khách còn phải trả, ghi chú mặc định của shop. Đơn nào hãng không phục vụ dịch vụ đã chọn sẽ báo riêng.
              </p>
              <fieldset className="space-y-1">
                <legend className="font-medium">Dịch vụ dùng chung</legend>
                {quote.services.map((sv) => (
                  <label key={sv.code} className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 hover:bg-muted/40">
                    <input type="radio" name="vtp-bulk-service" value={sv.code} checked={service === sv.code} onChange={() => setService(sv.code)} />
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
                  — {r.ok ? `vận đơn ${r.vtpOrderNumber}` : r.message}
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
                {pending === "create" ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} Tạo {ids.length} vận đơn
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

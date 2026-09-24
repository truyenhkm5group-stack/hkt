"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import type { CarrierRequestView } from "@/lib/care/contracts";
import { MANUAL_VERDICT_TONE, manualRequestVerdict, manualVerdictText } from "@/lib/constants/carrier-manual";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Lệnh làm tay: webhook đã xác minh chưa, và nội dung soạn sẵn để làm trên viettelpost.vn.
 * Không phải lệnh làm tay ⇒ không vẽ gì (đường API đã có nhãn ACK → SUCCESS riêng).
 */
export function ManualRequestVerdict({ req, className }: { req: CarrierRequestView; className?: string }) {
  const v = manualRequestVerdict(req);
  if (!v) return null;
  const copy = async () => {
    if (!req.copyText) return;
    try {
      await navigator.clipboard.writeText(req.copyText);
      toast.success("Đã chép nội dung — dán vào viettelpost.vn");
    } catch {
      toast.error("Trình duyệt không cho chép tự động", { description: req.copyText, duration: 20000 });
    }
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-1 text-[10.5px] leading-tight", className)}>
      <span className={MANUAL_VERDICT_TONE[v.state]} title={v.state === "CARRIER_CONFIRMED" ? "Sự kiện Viettel Post mang chặng khớp lệnh, xảy ra sau lúc lập lệnh. Không có nghĩa là lệnh làm tay đã GÂY RA kết quả — ĐVVC có thể tự phát lại." : undefined}>
        {manualVerdictText(v, req.status)}
        {v.state === "CARRIER_CONFIRMED" ? ` · ${formatDateTime(v.at)}` : ""}
      </span>
      {req.status === "MANUAL_REQUIRED" && req.copyText && v.state !== "CARRIER_CONFIRMED" ? (
        <button type="button" onClick={copy} className="inline-flex items-center gap-0.5 rounded border px-1 py-px hover:bg-accent" title={req.copyText}>
          <Copy className="size-3" /> Chép nội dung
        </button>
      ) : null}
    </div>
  );
}

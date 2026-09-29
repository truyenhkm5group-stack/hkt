"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { setReceiptPricingModeAction } from "@/lib/actions/manual-products";
import { RECEIPT_PRICING_LABEL, RECEIPT_PRICING_MODES, RECEIPT_PRICING_SOURCE_LABEL, type ReceiptPricingMode, type ReceiptPricingSource } from "@/lib/constants/receipt-pricing-mode";

/**
 * Chọn cách định giá phiếu nhập hàng mới — CHỈ tổ chức khác nhà, CHỈ người có quyền cài đặt (trang quyết định hiện hay
 * không; action kiểm lại). Tổ chức nhà không thấy ô này: giá báo MKT là quyết định của chủ shop.
 */
export function PricingModeControl({ mode, source }: { mode: ReceiptPricingMode; source: ReceiptPricingSource }) {
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">Đơn giá phiếu nhập:</span>
      <select
        value={mode}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(async () => {
            const r = await setReceiptPricingModeAction(next);
            if ("error" in r) toast.error(r.error);
            else toast.success("Đã đổi cách định giá phiếu nhập");
          });
        }}
        className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
      >
        {RECEIPT_PRICING_MODES.map((m) => (
          <option key={m} value={m}>
            {RECEIPT_PRICING_LABEL[m]}
          </option>
        ))}
      </select>
      <span>({RECEIPT_PRICING_SOURCE_LABEL[source]})</span>
    </label>
  );
}

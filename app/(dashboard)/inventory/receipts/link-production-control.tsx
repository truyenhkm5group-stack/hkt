"use client";

import { useState, useTransition } from "react";
import { Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { linkStockReceiptToProductionOrder } from "@/lib/actions/stock";

export type LinkCandidateOption = { id: string; label: string };

/**
 * "Nối với lệnh SX" cho một phiếu NHẬP HÀNG đã có mà chưa nối (Company OS · Agent P2).
 *
 * Ứng viên do máy chủ tính (`matchReceiptToOrders`); một ứng viên ⇒ điền sẵn, nhiều ⇒ để trống và người
 * chọn. Không có gì được nối cho tới khi NGƯỜI bấm — máy chủ kiểm lại bằng `validateProductionLink`.
 */
export function LinkProductionControl({ receiptId, candidates, prefilled }: { receiptId: string; candidates: LinkCandidateOption[]; prefilled: string }) {
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState(prefilled);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-amber-50/60 px-4 py-3 text-sm dark:bg-amber-950/20">
      <span className="font-medium">Nối với lệnh SX</span>
      <select aria-label="Lệnh sản xuất để nối" value={chosen} onChange={(e) => setChosen(e.target.value)} className="h-8 min-w-[220px] rounded-md border bg-background px-2 text-sm">
        <option value="">{candidates.length > 1 ? `— chọn 1 trong ${candidates.length} lệnh khớp —` : "— chọn lệnh —"}</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        className="h-8"
        disabled={!chosen || pending}
        onClick={() =>
          startTransition(async () => {
            const kq = await linkStockReceiptToProductionOrder({ receiptId, productionOrderId: chosen });
            if ("error" in kq) toast.error(kq.error);
            else toast.success("Đã nối phiếu với lệnh sản xuất");
          })
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />} Nối
      </Button>
      <span className="text-xs text-muted-foreground">
        {candidates.length > 1 ? "Nhiều lệnh cùng sản phẩm khớp ngày / xưởng — ERP không chọn hộ." : "Lệnh đang gửi xưởng, cùng sản phẩm, gửi không muộn hơn ngày nhận."}
      </span>
    </div>
  );
}

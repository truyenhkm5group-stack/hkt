"use client";

import { useState, useTransition } from "react";
import { Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { saveManualDeliveryFeeAction } from "@/lib/actions/manual-orders";
import { formatVND } from "@/lib/format";

/**
 * PHÍ GIAO ĐỒNG GIÁ mỗi đơn giao thành công (tổ chức tạo đơn tay — `orders.manualDeliveryFee`). Ghi vào cước của đơn lúc
 * xác nhận đã giao; đơn đã giao trước đó giữ phí cũ. Không `router.refresh()` — action đã `revalidatePath`.
 */
export function DeliveryFeeButton({ fee }: { fee: number | null }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(fee === null ? "" : String(fee));
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const digits = value.replace(/[^\d]/g, "");
      const r = await saveManualDeliveryFeeAction(digits ? Number(digits) : null);
      if ("ok" in r) {
        toast.success(r.message);
        setOpen(false);
      } else toast.error(r.error);
    });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="delivery-fee-button">
          <Truck className="size-4" /> Phí giao: {fee === null ? "chưa khai" : formatVND(fee)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 text-sm">
        <p className="font-medium">Phí giao mỗi đơn giao thành công</p>
        <p className="text-xs text-muted-foreground">
          Ghi vào cước của đơn khi bấm «Xác nhận đã giao» — vào chi phí vận chuyển của báo cáo lợi nhuận. Đơn giao không thành công không mang phí. Đơn đã giao trước đó giữ phí cũ.
        </p>
        <Input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ví dụ 40000 — để trống là xoá" aria-label="Phí giao mỗi đơn (₫)" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Thôi
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={pending}>
            Lưu
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

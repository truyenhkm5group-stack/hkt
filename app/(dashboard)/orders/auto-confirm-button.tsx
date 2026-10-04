"use client";

import { useState, useTransition } from "react";
import { CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { saveAutoConfirmCompleteAction } from "@/lib/actions/manual-orders";

/**
 * «ĐƠN ĐỦ THÔNG TIN = ĐÃ XÁC NHẬN» (theo tổ chức — `orders.autoConfirmComplete`). Bật ⇒ đơn «Mới» có SĐT, địa chỉ và hàng
 * tính là đơn ngay (giữ hàng, vào mọi báo cáo); đơn «Mới» đủ thông tin đang có được xác nhận trong lượt bấm. Không
 * `router.refresh()` — action đã `revalidatePath`.
 */
export function AutoConfirmButton({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const save = (v: boolean) =>
    start(async () => {
      const r = await saveAutoConfirmCompleteAction(v);
      if ("ok" in r) {
        toast.success(r.message);
        setOpen(false);
      } else toast.error(r.error);
    });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="auto-confirm-button">
          <CheckCheck className="size-4" /> Đơn đủ thông tin: {enabled ? "tự xác nhận" : "xác nhận tay"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 text-sm">
        <label className="flex items-center gap-2 font-medium">
          <Switch checked={enabled} disabled={pending} onCheckedChange={save} aria-label="Đơn đủ thông tin tính là đã xác nhận" />
          Đơn đủ SĐT · địa chỉ · hàng tính là đơn ngay
        </label>
        <p className="text-xs text-muted-foreground">
          Bật: đơn «Mới» có đủ SĐT, địa chỉ và ít nhất một mặt hàng được ghi thẳng «Đã xác nhận» — giữ hàng ở kho và vào báo cáo hiệu quả quảng cáo, lợi nhuận ngay. Chỉ trừ đơn huỷ. Đơn «Mới» đủ thông tin đang có được xác nhận luôn khi bật. Khách vượt hạn mức nợ thì đơn vẫn ở «Mới».
        </p>
      </PopoverContent>
    </Popover>
  );
}

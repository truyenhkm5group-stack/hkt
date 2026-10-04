"use client";

import { useState, useTransition } from "react";
import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { declareErpNativeAction } from "@/lib/actions/manual-orders";
import type { ErpNativeView } from "@/lib/records/order-create";

/**
 * «CHUYỂN HẲN SANG ERP» (ORDER_OUTCOME.md mục 11.3 — chủ shop chốt 04/10/2026). Shop đến từ Pancake đã nhập lịch sử đơn rồi tắt
 * kết nối: bấm một lần để đơn tạo trong ERP vào mọi báo cáo. Đã tuyên bố ⇒ chỉ hiện mốc. Không `router.refresh()` — action đã
 * `revalidatePath`.
 */
export function ErpNativeButton({ view }: { view: ErpNativeView }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  if (view.declared)
    return <span className="text-[12px] text-muted-foreground">Đã chuyển hẳn sang ERP{view.since ? ` từ ${new Date(view.since).toLocaleDateString("vi-VN")}` : ""}</span>;
  const go = () =>
    start(async () => {
      const r = await declareErpNativeAction();
      if ("ok" in r) {
        toast.success(r.message);
        setOpen(false);
      } else toast.error(r.error);
    });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="erp-native-button">
          <ArrowRightLeft className="size-4" /> Chuyển hẳn sang ERP
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 space-y-2 text-[12.5px]">
        <p className="font-semibold">Thôi dùng Pancake, đơn mới tạo trong ERP?</p>
        <p className="text-muted-foreground">
          CSDL đang có đơn nhập từ Pancake, nên báo cáo đang coi tổ chức là «đồng bộ đơn» và để đơn tạo trong ERP ĐỨNG NGOÀI doanh thu, lợi nhuận, marketer. Bấm để tuyên bố đã chuyển hẳn: đơn Pancake giữ nguyên làm lịch sử, đơn ERP từ giờ vào mọi báo cáo. Làm một lần, có ghi nhật ký.
        </p>
        {view.reason ? <p className="font-medium text-destructive">{view.reason}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Thôi
          </Button>
          <Button size="sm" onClick={go} disabled={pending || !view.canDeclare}>
            Chuyển hẳn sang ERP
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

"use client";

import { useState } from "react";
import { Loader2, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runShippingRouteNowAction } from "@/lib/actions/shipping-routes";

/** «Tạo vận đơn ngay» — chạy MỘT lượt máy tự tạo vận đơn (cùng hàm của job `shipping-route`), không đợi lịch 5 phút. */
export function RunShippingRouteButton({ due }: { due: number }) {
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      const res = await runShippingRouteNowAction();
      if ("error" in res) toast.error(res.error);
      else toast.success(res.message);
    } finally {
      setPending(false);
    }
  };
  return (
    <Button type="button" size="sm" variant="outline" onClick={run} disabled={pending || due === 0}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} Tạo vận đơn ngay ({due})
    </Button>
  );
}

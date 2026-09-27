"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runVideoOptimizeNowAction } from "@/lib/actions/video-scale";

/** Chạy một lượt vòng tối ưu ngay (không thay bộ lập lịch — cổng bật quảng cáo vẫn đọc nhịp tim của bộ lập lịch). */
export function OptimizeNowButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await runVideoOptimizeNowAction();
          if ("error" in r) return void toast.error(r.error);
          toast.success(r.detail);
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Chạy vòng tối ưu ngay
    </Button>
  );
}

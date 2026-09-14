"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { reconcileAttribution } from "@/lib/actions/fanpage-attribution";

/**
 * ĐỐI SOÁT LẠI — an toàn để bấm bất cứ lúc nào.
 *
 * Phép ghi là ghi ĐÈ theo khoá `order_id`, nên bấm mười lần cũng ra đúng một kết quả và không có
 * đường nào để doanh thu bị cộng đúp. "Chạy thử" cho biết trước bao nhiêu đơn sẽ đổi kết quả —
 * dùng nó khi vừa sửa một dòng phân công của quá khứ.
 */
export function ReconcileButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const run = (dryRun: boolean) =>
    startTransition(async () => {
      const r = await reconcileAttribution({ dryRun });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message ?? "Đã đối soát", { duration: 8000 });
        if (!dryRun) router.refresh();
      }
    });
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={disabled || pending} onClick={() => run(true)}>
        Chạy thử
      </Button>
      <Button type="button" size="sm" disabled={disabled || pending} onClick={() => run(false)}>
        <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} /> Đối soát lại
      </Button>
    </div>
  );
}

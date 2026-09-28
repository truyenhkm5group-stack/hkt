"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { refreshPendingReturnsFromPancake } from "@/lib/actions/care-pancake-refresh";

/**
 * Hỏi lại Pancake cho các ca đang chờ quyết định hoàn (kiện ở 505). Ca nào VTP đã duyệt hoàn thì rời
 * hàng đợi ngay — không đợi lượt đối chiếu đêm. Không `router.refresh()`: hành động đã
 * `revalidatePath("/shipments")` nên lượt gọi trả luôn giao diện mới.
 */
export function PancakeRefreshButton() {
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const r = await refreshPendingReturnsFromPancake();
      if (r.error) {
        toast.error(r.error);
        return;
      }
      if (r.checked === 0) {
        toast.success("Không có ca nào đang chờ quyết định hoàn");
        return;
      }
      toast.success(
        `Đã hỏi lại Pancake ${r.checked} ca chờ quyết định hoàn · ${r.closed} ca VTP đã duyệt hoàn nên rời hàng đợi` +
          (r.failed ? ` · ${r.failed} đơn Pancake không trả lời, thử lại sau` : ""),
      );
    });
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={run}
      disabled={pending}
      title="Webhook Viettel Post không báo “Đã duyệt hoàn”; Pancake thì có, nhưng thường chỉ tới ERP lúc đêm. Nút này hỏi lại Pancake ngay cho những ca đang ở “đề nghị hoàn” (tối đa 80 ca một lượt)."
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
      Kiểm tra duyệt hoàn
    </Button>
  );
}

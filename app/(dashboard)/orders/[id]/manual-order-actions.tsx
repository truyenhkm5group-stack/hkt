"use client";

import { useState } from "react";
import { Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cancelManualOrderAction } from "@/lib/actions/manual-orders";

/**
 * Huỷ ĐƠN TAY — hỏi lý do (vào nhật ký), gọi `cancelManualOrderAction`. Server action tự `revalidatePath` trang đơn nên
 * KHÔNG `router.refresh()` ở đây (làm vậy là dựng trang hai lần). Đơn đồng bộ không bao giờ có nút này.
 */
export function CancelManualOrderButton({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <XCircle className="size-4" /> Huỷ đơn
      </Button>
    );

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await cancelManualOrderAction(orderId, { reason });
      if (!("ok" in res)) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-md space-y-2 rounded-lg border bg-background p-3">
      <Textarea aria-label="Lý do huỷ đơn" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Vì sao huỷ đơn (bắt buộc)" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xác nhận huỷ
        </Button>
      </div>
    </div>
  );
}

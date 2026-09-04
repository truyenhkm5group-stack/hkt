"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Tải lại một đơn từ Pancake (và trạng thái VTP nếu có) */
export function SyncOrderButton({ orderId, shipmentId, label = "Tải lại từ Pancake" }: { orderId?: string; shipmentId?: string; label?: string }) {
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const run = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId, shipmentId }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) toast.error(body.error || "Không tải lại được");
      else toast.success(body.message || "Đã cập nhật");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Lỗi mạng");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={run} disabled={loading}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
      {label}
    </Button>
  );
}

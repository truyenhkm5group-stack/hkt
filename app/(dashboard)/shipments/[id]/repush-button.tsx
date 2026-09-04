"use client";

import { useState } from "react";
import { Loader2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Yêu cầu Viettel Post gửi lại webhook cho vận đơn */
export function RepushButton({ shipmentId }: { shipmentId: string }) {
  const [loading, setLoading] = useState(false);
  const run = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/shipments/${shipmentId}/repush`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || body.ok === false) toast.error(body.error || `Không gửi được yêu cầu (${res.status})`);
      else toast.success(body.message || "Đã yêu cầu Viettel Post gửi lại webhook");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Lỗi mạng");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={run} disabled={loading}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : <Webhook className="size-4" />}
      Yêu cầu VTP gửi lại webhook
    </Button>
  );
}

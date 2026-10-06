"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reviewAiFindingAction } from "@/lib/actions/ai-sales-performance";

/** Hai nút rà một phát hiện + ô ghi chú. Người rà và tên do máy chủ đọc — form không gửi tên. */
export function ReviewButtons({ conversationId, seq, kind, current }: { conversationId: string; seq: number; kind: string; current: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const send = (status: "CONFIRMED" | "DISMISSED") =>
    start(async () => {
      const r = await reviewAiFindingAction({ conversationId, seq, kind, status, note });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input className="h-8 min-w-0 flex-1 basis-48" placeholder="Ghi chú (tuỳ chọn)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Ghi chú rà" />
      <Button size="sm" className="h-8" variant={current === "CONFIRMED" ? "default" : "outline"} disabled={pending} onClick={() => send("CONFIRMED")}>
        Đúng là lỗi
      </Button>
      <Button size="sm" className="h-8" variant={current === "DISMISSED" ? "default" : "outline"} disabled={pending} onClick={() => send("DISMISSED")}>
        Không phải lỗi
      </Button>
    </div>
  );
}

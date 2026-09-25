"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, MessageSquareWarning } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { respondMyPayslip } from "@/lib/actions/payroll-autopilot";

/** Hai nút, một ô lý do. Khiếu nại bắt buộc ghi rõ sai ở đâu — "có gì đó sai" không ai sửa được. */
export function PayslipRespondForm({ confirmationId, status, note }: { confirmationId: string; status: string; note: string }) {
  const [pending, start] = useTransition();
  const [text, setText] = useState(status === "DISPUTED" ? note : "");
  const [disputing, setDisputing] = useState(status === "DISPUTED");

  const send = (decision: "CONFIRMED" | "DISPUTED") =>
    start(async () => {
      const r = await respondMyPayslip({ confirmationId, decision, note: decision === "DISPUTED" ? text : "" });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Đã ghi nhận");
    });

  return (
    <div className="space-y-3">
      {status !== "PENDING" ? (
        <p className="text-[12px] text-muted-foreground">
          Bạn đã {status === "CONFIRMED" ? "xác nhận" : "khiếu nại"} phiếu này. Vẫn đổi được câu trả lời cho tới khi kỳ được khoá.
        </p>
      ) : null}
      {disputing ? (
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Sai ở đâu? Ví dụ: thiếu 2 ngày công ngày 12 và 13, hoặc đơn X đã giao mà chưa tính." />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => send("CONFIRMED")} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Xác nhận đúng
        </Button>
        {disputing ? (
          <Button variant="destructive" onClick={() => send("DISPUTED")} disabled={pending || text.trim().length < 3}>
            <MessageSquareWarning className="size-4" /> Gửi khiếu nại
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setDisputing(true)} disabled={pending}>
            <MessageSquareWarning className="size-4" /> Khiếu nại
          </Button>
        )}
      </div>
    </div>
  );
}

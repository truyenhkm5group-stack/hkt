"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setExpenseAllocation } from "@/lib/actions/expenses";

/**
 * KHAI KỲ HIỆU LỰC — việc của tài chính, làm nhanh trên đúng khoản đang cần.
 *
 * ERP KHÔNG đoán kỳ từ ngày ghi sổ hay nội dung chuyển khoản. Người khai phải biết hoá đơn/hợp đồng
 * nói gì. Chọn "chi một lần" cũng là một câu trả lời hợp lệ và làm tắt cờ cần xem lại — khác hẳn
 * với việc bỏ mặc không trả lời.
 */
export function AllocationDialog({ id, description, amount }: { id: string; description: string; amount: number }) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<"EVENT_DATE" | "PERIOD_PRORATA">("PERIOD_PRORATA");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const save = () =>
    start(async () => {
      const r = await setExpenseAllocation({ id, allocationMethod: method, periodStart: from || null, periodEnd: to || null });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã khai kỳ hiệu lực — Báo cáo lợi nhuận sẽ phân bổ theo phần chồng lấn");
        setOpen(false);
        router.refresh();
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
          <CalendarRange className="size-3.5" /> Khai kỳ
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Khai kỳ hiệu lực</DialogTitle>
          <DialogDescription>
            {description} · {Math.round(amount).toLocaleString("vi-VN")}đ
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Khoản này là</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="PERIOD_PRORATA">Chi cho một KỲ — chia theo số ngày chồng lấn</option>
              <option value="EVENT_DATE">Chi MỘT LẦN cho ngày ghi sổ</option>
            </select>
          </div>
          {method === "PERIOD_PRORATA" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Kỳ từ ngày</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Kỳ đến ngày</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            ERP không tự đoán kỳ. Lấy từ hoá đơn / hợp đồng / kỳ thanh toán — khai sai còn tệ hơn để trống, vì con số sai
            trông vẫn hợp lý.
          </p>
          <Button size="sm" onClick={save} disabled={pending || (method === "PERIOD_PRORATA" && (!from || !to))}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

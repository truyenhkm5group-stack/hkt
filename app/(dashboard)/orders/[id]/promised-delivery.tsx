"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { clearPromisedDelivery, setPromisedDelivery } from "@/lib/actions/promised-delivery";
import { PROMISED_STATE_LABEL, PROMISED_STATE_TONE, type PromisedState } from "@/lib/constants/promised-delivery";
import { cn } from "@/lib/utils";

/**
 * ═══════ NGÀY KHÁCH HẸN GIAO ═══════
 *
 * Khối này là chỗ DUY NHẤT ghi lời hẹn. Nó tắt cảnh báo "đã chốt mà chưa gửi" trong lúc còn hạn,
 * nên nó CỐ Ý nói thẳng điều đó ngay trên màn hình — một ô nhập lặng lẽ thay đổi hành vi cảnh báo
 * là thứ người dùng sẽ không bao giờ đoán ra.
 *
 * Ô ngày gửi đi dạng `YYYY-MM-DD`; việc đổi thành mốc thật (cuối ngày giờ VN) do MÁY CHỦ làm.
 */
export function PromisedDelivery({
  orderId,
  state,
  promisedDate,
  note,
  recordedBy,
  canWrite,
}: {
  orderId: string;
  state: PromisedState;
  /** `YYYY-MM-DD` đã quy về giờ VN ở máy chủ, hoặc `null` khi chưa có hẹn. */
  promisedDate: string | null;
  note: string;
  recordedBy: string | null;
  canWrite: boolean;
}) {
  const [mo, setMo] = useState(false);
  const [date, setDate] = useState(promisedDate ?? "");
  const [ly_do, setLyDo] = useState(note);
  const [pending, start] = useTransition();
  const router = useRouter();

  const luu = () => {
    start(async () => {
      const r = await setPromisedDelivery({ orderId, date, note: ly_do });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã ghi ngày khách hẹn giao");
      setMo(false);
      router.refresh();
    });
  };

  const bo = () => {
    const reason = window.prompt("Vì sao bỏ lời hẹn này? (khách đổi ý, ghi nhầm đơn…)")?.trim() ?? "";
    if (reason.length < 3) {
      if (reason.length) toast.error("Nói rõ hơn một chút — người mở đơn ngày mai cần biết vì sao");
      return;
    }
    start(async () => {
      const r = await clearPromisedDelivery({ orderId, reason });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã bỏ lời hẹn — đơn quay lại hạn xử lý thông thường");
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="size-4 text-muted-foreground" />
        <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold", PROMISED_STATE_TONE[state])}>{PROMISED_STATE_LABEL[state]}</span>
        {promisedDate ? <span className="text-[12.5px] font-medium">{promisedDate}</span> : null}
        {canWrite ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setMo((v) => !v)} disabled={pending}>
              {promisedDate ? "Đổi ngày hẹn" : "Ghi ngày khách hẹn"}
            </Button>
            {promisedDate ? (
              <Button size="sm" variant="ghost" onClick={bo} disabled={pending}>
                <X className="size-3.5" /> Bỏ hẹn
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {note ? (
        <p className="text-[12.5px] text-muted-foreground">
          Khách nói: {note}
          {recordedBy ? ` · ${recordedBy} ghi` : ""}
        </p>
      ) : null}

      {mo && canWrite ? (
        <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
          <p className="text-[12px] text-muted-foreground">
            Trong lúc còn hạn, đơn này <b>không bị đếm là trễ</b> ở cảnh báo và hàng đợi kho. Trước ngày hẹn một ngày nó <b>tự quay lại</b>
            {" "}hàng đợi để kho kịp gói.
          </p>
          <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
            <div>
              <Label htmlFor="ngay-hen" className="text-[12px]">
                Ngày khách hẹn
              </Label>
              <Input id="ngay-hen" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ly-do-hen" className="text-[12px]">
                Khách nói gì
              </Label>
              <Textarea id="ly-do-hen" rows={2} value={ly_do} onChange={(e) => setLyDo(e.target.value)} placeholder="Khách đi công tác tới 19/09, hẹn giao ngày 20" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={luu} disabled={pending || !date || ly_do.trim().length < 3}>
              Lưu ngày hẹn
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMo(false)} disabled={pending}>
              Thôi
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

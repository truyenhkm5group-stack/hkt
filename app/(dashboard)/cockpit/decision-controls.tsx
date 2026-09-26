"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Clock, X } from "lucide-react";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { decideRecommendation } from "@/lib/actions/owner-decisions";
import { DISMISS_REASON_MIN, type OwnerDecisionKind, type RecommendationDecision } from "@/lib/constants/owner-decisions";
import { addDays, todayVN } from "@/lib/format";

/**
 * Ba nút phản ứng với MỘT đề xuất (Company OS · Agent H). Không nút nào đóng việc ở nguồn — việc thật
 * làm ở màn hình chủ qua nút hành động bên cạnh (luật 19). Ba nút chỉ ghi lại người đọc nghĩ gì về đề
 * xuất, để đo đề xuất nào đúng.
 *
 * Mốc "Nhắc lại sau" là TIỆN ÍCH NHẬP LIỆU (ngày mai / 3 ngày / 1 tuần / ngày tự chọn), không phải ngưỡng
 * nghiệp vụ: người bấm chọn ngày, máy chỉ ẩn tới đúng ngày đó.
 */
export function DecisionControls({ kind, sourceKey, accepted, from }: { kind: OwnerDecisionKind; sourceKey: string; accepted: boolean; from: "home" | "cockpit" }) {
  const [pending, start] = useNavTransition();
  const [dialog, setDialog] = useState<null | "DISMISSED" | "SNOOZED">(null);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(() => addDays(todayVN(), 1));

  const gui = (decision: RecommendationDecision, extra: { reason?: string; snoozeUntil?: string } = {}) =>
    start(async () => {
      const r = await decideRecommendation({ kind, sourceKey, decision, reason: extra.reason ?? null, snoozeUntil: extra.snoozeUntil ?? null, from });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.skipped ? "Đã ghi từ trước — không ghi thêm" : decision === "ACCEPTED" ? "Đã ghi: chấp nhận. Việc vẫn nằm đây tới khi làm xong ở màn hình chủ." : decision === "DISMISSED" ? "Đã bỏ qua — hiện lại khi nguồn đổi kết luận." : `Sẽ nhắc lại từ ${date.split("-").reverse().join("/")}.`);
      setDialog(null);
      setReason("");
    });

  const lyDoDu = reason.trim().length >= DISMISS_REASON_MIN;
  const homNay = todayVN();

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {accepted ? null : (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => gui("ACCEPTED")} title="Chấp nhận đề xuất — việc vẫn ở đây tới khi làm xong ở màn hình chủ">
          <Check className="size-3.5" /> Chấp nhận
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => setDialog("DISMISSED")} title="Bỏ qua (bắt buộc lý do)">
        <X className="size-3.5" /> Bỏ qua
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => setDialog("SNOOZED")} title="Ẩn tới một ngày rồi nhắc lại">
        <Clock className="size-3.5" /> Nhắc lại sau
      </Button>

      <Dialog open={dialog !== null} onOpenChange={(o) => (o ? null : setDialog(null))}>
        <DialogContent className="sm:max-w-md">
          {dialog === "DISMISSED" ? (
            <>
              <DialogHeader>
                <DialogTitle>Bỏ qua đề xuất</DialogTitle>
                <DialogDescription>Đề xuất ẩn đi cho tới khi nguồn đổi kết luận. Lý do được lưu để đo đề xuất sai ở đâu.</DialogDescription>
              </DialogHeader>
              <Textarea rows={3} maxLength={1000} autoFocus placeholder="Vì sao không làm theo đề xuất này?" value={reason} onChange={(e) => setReason(e.target.value)} />
              <DialogFooter>
                <span className="mr-auto self-center text-[11px] text-muted-foreground">Ít nhất {DISMISS_REASON_MIN} ký tự</span>
                <Button size="sm" disabled={pending || !lyDoDu} onClick={() => gui("DISMISSED", { reason })}>
                  {pending ? "Đang lưu…" : "Bỏ qua"}
                </Button>
              </DialogFooter>
            </>
          ) : dialog === "SNOOZED" ? (
            <>
              <DialogHeader>
                <DialogTitle>Nhắc lại sau</DialogTitle>
                <DialogDescription>Đề xuất ẩn tới 00:00 ngày chọn (giờ Việt Nam) rồi tự hiện lại.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  { n: 1, label: "Ngày mai" },
                  { n: 3, label: "3 ngày" },
                  { n: 7, label: "1 tuần" },
                ].map((p) => (
                  <Button key={p.n} type="button" size="sm" variant={date === addDays(homNay, p.n) ? "default" : "outline"} className="h-7 text-xs" onClick={() => setDate(addDays(homNay, p.n))}>
                    {p.label}
                  </Button>
                ))}
                <Input type="date" className="h-7 w-40 text-xs" min={addDays(homNay, 1)} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Ngày nhắc lại" />
              </div>
              <DialogFooter>
                <Button size="sm" disabled={pending || !date || date <= homNay} onClick={() => gui("SNOOZED", { snoozeUntil: date })}>
                  {pending ? "Đang lưu…" : "Hẹn nhắc"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { Loader2, PauseCircle, Play, Rocket, X } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dismissScaleProposal, draftScaleCampaign, launchScaleDraft, pauseScaleCampaign, proposeScaleLaunch } from "@/lib/actions/creative-scale";
import type { ScaleDraftStatus, ScaleKind } from "@/lib/constants/creative-loop";
import { formatVND } from "@/lib/format";

/** Kiểu đề nghị bật — suy từ Server Action để phía trình duyệt không nhập gì từ `lib/creative/*`. */
type ScaleLaunchProposal = Exclude<Awaited<ReturnType<typeof proposeScaleLaunch>>, { error: string }>;

/**
 * Nút của một ô nháp scale — chỉ hiện ĐÚNG bước kế tiếp của trạng thái:
 *   PROPOSED ⇒ Dựng nháp · Bỏ qua   ·   FAILED (chưa từng sao chép) ⇒ Dựng lại · Bỏ qua   ·   FAILED (đã sao chép) ⇒ Bỏ qua
 *   DRAFT ⇒ Duyệt chạy (hai bước: đề nghị → phiếu → bật)   ·   ACTIVE ⇒ Tắt
 */
export function ScaleCellActions({
  draftId,
  variantId,
  kind,
  kindLabel,
  status,
  copyAttempted,
  templateMissing,
}: {
  draftId: string;
  variantId: string;
  kind: ScaleKind;
  kindLabel: string;
  status: ScaleDraftStatus;
  copyAttempted: boolean;
  templateMissing: boolean;
}) {
  const [busy, start] = useTransition();
  const [confirmDraft, setConfirmDraft] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [launch, setLaunch] = useState<ScaleLaunchProposal | null>(null);

  const run = (fn: () => Promise<{ ok: true; detail: string } | { error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.detail);
      after?.();
    });

  const moDuyet = () =>
    start(async () => {
      const r = await proposeScaleLaunch({ draftId });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setLaunch(r);
    });

  const coTheDung = status === "PROPOSED" || (status === "FAILED" && !copyAttempted);
  const coTheBo = status === "PROPOSED" || status === "FAILED";

  return (
    <div className="flex flex-wrap gap-1">
      {coTheDung ? (
        <Button size="sm" className="h-7 px-2 text-[12px]" disabled={busy || templateMissing} title={templateMissing ? "Chưa khai chiến dịch mẫu cho loại này (tab Cấu hình)" : undefined} onClick={() => setConfirmDraft(true)}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
          {status === "FAILED" ? "Dựng lại" : "Dựng nháp"}
        </Button>
      ) : null}
      {status === "DRAFT" ? (
        <Button size="sm" className="h-7 px-2 text-[12px]" disabled={busy} onClick={moDuyet}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          Duyệt chạy
        </Button>
      ) : null}
      {status === "ACTIVE" ? (
        <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" disabled={busy} onClick={() => setConfirmPause(true)}>
          <PauseCircle className="size-3.5" />
          Tắt
        </Button>
      ) : null}
      {coTheBo ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" disabled={busy} onClick={() => run(() => dismissScaleProposal({ draftId }))}>
          <X className="size-3.5" />
          Bỏ qua
        </Button>
      ) : null}

      <AlertDialog open={confirmDraft} onOpenChange={setConfirmDraft}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dựng nháp “{kindLabel}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Máy sao chép chiến dịch MẪU trên Facebook, thay bài bằng ảnh + câu chữ của mẫu thắng và đặt ngân sách ngày. Bản sao ở trạng thái TẮT — không tiêu đồng nào cho tới khi
              bạn bấm “Duyệt chạy”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                run(() => draftScaleCampaign({ variantId, kind }), () => setConfirmDraft(false));
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Dựng nháp (TẮT)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPause} onOpenChange={setConfirmPause}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tắt chiến dịch scale?</AlertDialogTitle>
            <AlertDialogDescription>Máy tắt chiến dịch trên Facebook. Tắt chỉ làm GIẢM tiền; lượt tắt ghi tên bạn vào sổ ghi Facebook.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                run(() => pauseScaleCampaign({ draftId }), () => setConfirmPause(false));
              }}
            >
              Tắt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={launch !== null} onOpenChange={(o) => (o ? null : setLaunch(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Duyệt chạy “{kindLabel}”</DialogTitle>
            <DialogDescription>Máy đọc lại bản nháp trên Facebook rồi BẬT mẩu → nhóm → chiến dịch. Ai đã sửa bài hay ngân sách trên Ads Manager sau lúc này thì máy không bật.</DialogDescription>
          </DialogHeader>
          {launch ? (
            <div className="space-y-2 text-[13px]">
              <div className="rounded-lg border px-3 py-2">
                <p>
                  Ngân sách: <b className="numeric">{formatVND(launch.payload.dailyBudgetVnd)}</b>/ngày (cấp {launch.payload.budgetLevel === "CAMPAIGN" ? "chiến dịch" : "nhóm"})
                </p>
                <p className="text-muted-foreground">Chiến dịch {launch.payload.campaignId} · bài {launch.payload.creativeId}</p>
                <p className="text-muted-foreground">Các chiến dịch scale khác đang bật: {formatVND(launch.activeTotalVnd)}/ngày</p>
              </div>
              {launch.blocked ? <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">Không bật được: {launch.blocked}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLaunch(null)} disabled={busy}>
              Để sau
            </Button>
            <Button
              disabled={!launch?.ticket || busy}
              onClick={() => {
                if (!launch?.ticket) return;
                const l = launch;
                run(() => launchScaleDraft({ draftId, ticket: l.ticket ?? "", signed: l.payload }), () => setLaunch(null));
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Bật {launch ? formatVND(launch.payload.dailyBudgetVnd) : ""}/ngày
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { Image as ImageIcon, Loader2, Play, RotateCcw, X } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cancelVideoRunAction, kickVideoQueueAction, remakeVideoVariantAction, retryVideoJobAction, setVideoSkuReviewModeAction, switchSceneToPhotoAction } from "@/lib/actions/video-scale";
import { VIDEO_REVIEW_MODES, VIDEO_REVIEW_MODE_LABEL, type VideoReviewMode } from "@/lib/constants/video-scale";

function useAct() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: true } | { error: string }>, okText: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(okText);
    });
  return [pending, run] as const;
}

export function CancelRunButton({ runId }: { runId: string }) {
  const [pending, run] = useAct();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Huỷ lượt này? Clip đang sinh trên Veo vẫn có thể bị tính tiền.") && run(() => cancelVideoRunAction({ id: runId }), "Đã huỷ lượt.")}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />} Huỷ
    </Button>
  );
}

export function RetryJobButton({ jobId, ambiguous }: { jobId: string; ambiguous: boolean }) {
  const [pending, run] = useAct();
  const ask = ambiguous ? "Lượt trước có thể đã được tạo và TÍNH TIỀN trên nhà cung cấp. Thử lại có thể trả tiền hai lần. Vẫn thử lại?" : "Thử lại việc này?";
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => confirm(ask) && run(() => retryVideoJobAction({ id: jobId }), "Đã xếp lại việc.")}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Thử lại
    </Button>
  );
}

export function SceneToPhotoButton({ jobId }: { jobId: string }) {
  const [pending, run] = useAct();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => switchSceneToPhotoAction({ id: jobId }), "Đã đổi cảnh sang ảnh động — dựng trong ít giây.")}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />} Dùng ảnh động (miễn phí)
    </Button>
  );
}

export function RemakeVariantButton({ variantId }: { variantId: string }) {
  const [pending, run] = useAct();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => confirm("Làm lại biến thể này (sinh clip mới — tốn tiền)?") && run(() => remakeVideoVariantAction({ id: variantId }), "Đã xếp làm lại.")}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Làm lại
    </Button>
  );
}

export function KickQueueButton() {
  const [pending, run] = useAct();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => kickVideoQueueAction(), "Đang chạy hàng đợi — tải lại trang sau ít phút.")}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Chạy hàng đợi ngay
    </Button>
  );
}

export function SkuModeSelect({ productId, value, disabled }: { productId: string; value: VideoReviewMode; disabled: boolean }) {
  const [pending, run] = useAct();
  return (
    <select
      aria-label="Chế độ duyệt video của mã"
      className="h-8 max-w-[15rem] rounded border px-1.5 text-[12px]"
      value={value}
      disabled={disabled || pending}
      onChange={(e) => run(() => setVideoSkuReviewModeAction({ productId, reviewMode: e.target.value }), "Đã đổi chế độ duyệt.")}
    >
      {VIDEO_REVIEW_MODES.map((m) => (
        <option key={m} value={m}>
          {VIDEO_REVIEW_MODE_LABEL[m]}
        </option>
      ))}
    </select>
  );
}

"use client";

import { Loader2, OctagonX, PlayCircle, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cancelVideoPostAction, setVideoPageConfigAction, setVideoPauseAction, setVideoSkuPublishingAction } from "@/lib/actions/video-scale";
import { VIDEO_PUBLISH_MODES, VIDEO_PUBLISH_MODE_LABEL, type VideoPublishMode } from "@/lib/constants/video-scale";
import { cn } from "@/lib/utils";

function useAct() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(ok);
    });
  return [pending, run] as const;
}

/** Gán FANPAGE ĐƯỢC DUYỆT cho mã + ép "luôn chờ người" (người có quyền chọn — máy không đoán fanpage theo tên). */
export function SkuPublishingSelect({ productId, pageId, publishMode, pages, disabled }: { productId: string; pageId: string | null; publishMode: string | null; pages: { id: string; name: string }[]; disabled: boolean }) {
  const [pending, run] = useAct();
  const save = (next: { pageId: string; publishMode: string }) => run(() => setVideoSkuPublishingAction({ productId, ...next }), "Đã lưu fanpage của mã.");
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <select aria-label="Fanpage được duyệt cho mã" className="h-8 max-w-[14rem] rounded border px-1.5 text-[12px]" value={pageId ?? ""} disabled={disabled || pending} onChange={(e) => save({ pageId: e.target.value, publishMode: publishMode ?? "" })}>
        <option value="">— Chưa gán fanpage —</option>
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-[12px]">
        <input type="checkbox" checked={publishMode === "MANUAL_REVIEW"} disabled={disabled || pending || !pageId} onChange={(e) => save({ pageId: pageId ?? "", publishMode: e.target.checked ? "MANUAL_REVIEW" : "" })} />
        luôn chờ người đăng
      </label>
    </span>
  );
}

/** Nút dừng / mở lại khẩn cấp cho một phạm vi. Kéo và nhả đều bắt buộc lý do. */
export function PauseButton({ scope, id, paused, reason, canEngage, canRelease, label }: { scope: "SKU" | "PAGE" | "ALL"; id: string; paused: boolean; reason: string; canEngage: boolean; canRelease: boolean; label: string }) {
  const [pending, run] = useAct();
  const allowed = paused ? canRelease : canEngage;
  const click = () => {
    const why = prompt(paused ? `Vì sao mở lại ${label}?` : `Vì sao DỪNG ${label}? (có hiệu lực ở lượt việc kế tiếp)`);
    if (!why || why.trim().length < 3) return;
    run(() => setVideoPauseAction({ scope, id, paused: !paused, reason: why }), paused ? `Đã mở lại ${label}.` : `Đã DỪNG ${label}.`);
  };
  return (
    <Button size="sm" variant={paused ? "outline" : "destructive"} disabled={!allowed || pending} onClick={click} title={paused && reason ? `Đang dừng: ${reason}` : undefined}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : paused ? <PlayCircle className="size-4" /> : <OctagonX className="size-4" />}
      {paused ? `Mở lại ${label}` : `Dừng ${label}`}
    </Button>
  );
}

export function PageConfigRowControls({ pageId, publishMode, maxPostsPerDay, disabled }: { pageId: string; publishMode: string; maxPostsPerDay: number; disabled: boolean }) {
  const [pending, run] = useAct();
  const [mode, setMode] = useState(publishMode as VideoPublishMode);
  const [max, setMax] = useState(maxPostsPerDay);
  const dirty = mode !== publishMode || max !== maxPostsPerDay;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <select aria-label="Chế độ đăng của fanpage" className={cn("h-8 rounded border px-1.5 text-[12px]", mode === "AUTO_PUBLISH" && "border-amber-500")} value={mode} disabled={disabled || pending} onChange={(e) => setMode(e.target.value as VideoPublishMode)}>
        {VIDEO_PUBLISH_MODES.map((m) => (
          <option key={m} value={m}>
            {VIDEO_PUBLISH_MODE_LABEL[m]}
          </option>
        ))}
      </select>
      <Input aria-label="Trần bài tự đăng / ngày" type="number" min={1} max={10} className="h-8 w-16" value={max} disabled={disabled || pending} onChange={(e) => setMax(Number(e.target.value) || 1)} />
      <span className="text-[11.5px] text-muted-foreground">bài / ngày</span>
      {dirty ? (
        <Button
          size="sm"
          disabled={disabled || pending}
          onClick={() => (mode === "AUTO_PUBLISH" && publishMode !== "AUTO_PUBLISH" ? confirm("Bật TỰ ĐĂNG: video đã duyệt của các mã gán fanpage này sẽ được máy đăng không cần người bấm. Tiếp tục?") : true) && run(() => setVideoPageConfigAction({ pageId, publishMode: mode, maxPostsPerDay: max }), "Đã lưu cấu hình fanpage.")}
        >
          Lưu
        </Button>
      ) : null}
    </span>
  );
}

export function CancelPostButton({ postId }: { postId: string }) {
  const [pending, run] = useAct();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Huỷ bài này?") && run(() => cancelVideoPostAction({ id: postId }), "Đã huỷ bài.")}>
      <X className="size-4" /> Huỷ
    </Button>
  );
}

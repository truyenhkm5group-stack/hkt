"use client";

import { CalendarClock, Loader2, RefreshCw, Save, Send } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { publishVideoReelAction, regenerateVideoCaptionAction, saveVideoCaptionAction } from "@/lib/actions/video-scale";
import { CAPTION_LIMITS, composeCaption, type CaptionOption } from "@/lib/constants/video-scale";
import { cn } from "@/lib/utils";

/**
 * Content của một video ĐÃ DUYỆT: chọn một phương án máy viết (bấm để nạp vào ô), sửa, lưu; rồi Đăng ngay hoặc Hẹn giờ.
 * Máy chủ kiểm lại content bằng CÙNG bộ kiểm với kịch bản (giá, size, màu, chất liệu, khuyến mãi) trước khi lưu / đăng.
 */
export function ContentEditor({ variantId, options, caption, captionState, captionBy, canPost, pageLabel }: { variantId: string; options: CaptionOption[]; caption: string; captionState: string; captionBy: string; canPost: boolean; pageLabel: string | null }) {
  const [text, setText] = useState(caption);
  const [at, setAt] = useState("");
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(ok);
    });

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-2 text-[12.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          Content {captionState === "READY" ? `· đã chốt${captionBy ? ` bởi ${captionBy}` : ""}` : captionState === "DRAFTED" ? "· máy viết, chưa chốt" : "· đang chờ máy viết"}
        </p>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => regenerateVideoCaptionAction({ id: variantId }), "Đang viết lại content — tải lại trang sau ít phút.")}>
          <RefreshCw className="size-4" /> Viết lại
        </Button>
      </div>
      {options.length ? (
        <div className="grid gap-1.5 sm:grid-cols-3">
          {options.map((o, i) => {
            const c = composeCaption(o);
            return (
              <button key={i} type="button" onClick={() => setText(c)} className={cn("rounded border bg-background p-1.5 text-left text-[12px] hover:border-primary", text === c && "border-primary")}>
                <b>{o.hook}</b>
                <span className="line-clamp-3 block text-muted-foreground">{o.body}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <Textarea rows={5} value={text} maxLength={CAPTION_LIMITS.totalMaxChars} onChange={(e) => setText(e.target.value)} placeholder="Content đăng kèm Reel" aria-label="Content đăng kèm Reel" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending || !text.trim()} onClick={() => run(() => saveVideoCaptionAction({ variantId, caption: text }), "Đã lưu content.")}>
          <Save className="size-4" /> Lưu
        </Button>
        {canPost ? (
          <>
            <Button size="sm" disabled={pending || !text.trim()} onClick={() => confirm(`Đăng Reel NGAY lên ${pageLabel}?`) && run(() => publishVideoReelAction({ variantId, caption: text, publishAt: "" }), "Đã xếp đăng Reel.")}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Đăng ngay
            </Button>
            <Input type="datetime-local" className="h-8 w-auto" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Giờ hẹn đăng" />
            <Button size="sm" variant="outline" disabled={pending || !text.trim() || !at} onClick={() => run(() => publishVideoReelAction({ variantId, caption: text, publishAt: new Date(at).toISOString() }), "Đã hẹn giờ đăng Reel.")}>
              <CalendarClock className="size-4" /> Hẹn giờ
            </Button>
            <span className="text-[11.5px] text-muted-foreground">Fanpage: {pageLabel}</span>
          </>
        ) : (
          <span className="text-[11.5px] text-muted-foreground">{pageLabel ? "Bạn không có quyền đăng." : "Mã chưa được gán fanpage (tab Mã win) — chưa đăng được."}</span>
        )}
      </div>
    </div>
  );
}

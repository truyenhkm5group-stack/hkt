"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Bot, Hand, Loader2, Play, Sparkles, Timer } from "lucide-react";
import { toast } from "sonner";
import { setConversationControlAction } from "@/lib/actions/sales-inbox";
import Link from "next/link";
import { cooldownRemainingMs, formatCountdown, type AiHoldView } from "@/lib/sales-chatbot/ai-hold-shared";
import { controlBarStatus, type AiBlock } from "@/lib/sales-chatbot/ai-status-shared";
import { CONTROL_REASON_MAX, type ControlStamp, type ConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * THANH AI ↔ NGƯỜI của một hội thoại. Trạng thái TƯỜNG MINH do máy chủ tính (`ai-hold-shared.ts::aiHoldOf`):
 *  · AI_ACTIVE      — AI đang trả lời. Nút: AI gợi ý · Tiếp quản.
 *  · HUMAN_COOLDOWN — AI đang nhường sau câu tay của nhân viên: ĐỒNG HỒ ĐẾM NGƯỢC theo giờ MÁY CHỦ (`serverNow` bù lệch đồng hồ
 *                     trình duyệt). Nút: «Cho AI tiếp tục ngay» · Tiếp quản.
 *  · HUMAN_TAKEOVER — người tiếp quản / cần người xử lý: AI im không thời hạn. Nút: «Trả lại cho AI».
 * Tiếp quản hỏi lý do (không bắt buộc) ngay tại chỗ, vào nhật ký. Mọi phép kiểm ở máy chủ; hai người bấm cùng lúc ⇒ người sau
 * được báo tải lại. Nút xuống dòng trên điện thoại.
 */
export function ConversationControlBar({
  conversationId,
  channel,
  control,
  hold,
  blocks,
  handoffReason,
  canWork,
}: {
  conversationId: string;
  channel: string;
  control: ControlStamp | null;
  hold: AiHoldView;
  /** Lý do AI KHÔNG trả lời do máy chủ tính bằng đúng các cổng của đường xử lý (ai-status.ts). */
  blocks: AiBlock[];
  handoffReason: string | null;
  canWork: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<ConversationControl | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const mode: ConversationControl = control?.mode ?? "AUTO";

  // Đồng hồ đếm ngược: chỉ chạy sau khi gắn vào trang (bản dựng sẵn ở máy chủ không mang số giây). Lệch = giờ máy chủ − giờ trình
  // duyệt lúc nhận ảnh chụp, nên máy nhân viên nhanh / chậm vài phút không làm sai số còn lại.
  const skew = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const refreshed = useRef(false);
  useEffect(() => {
    if (hold.state !== "HUMAN_COOLDOWN") return;
    skew.current = null;
    const tick = () => {
      const t = Date.now();
      if (skew.current === null) skew.current = new Date(hold.serverNow).getTime() - t;
      setNowMs(t);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [hold.state, hold.serverNow]);
  const remaining = hold.state === "HUMAN_COOLDOWN" && nowMs !== null ? cooldownRemainingMs(hold.until, nowMs, skew.current ?? 0) : null;
  const lapsed = remaining === 0;
  useEffect(() => {
    // Hết nhường ⇒ đọc lại trạng thái từ máy chủ một lần (máy chủ mới là nơi quyết định).
    if (lapsed && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [lapsed, router]);

  const apply = async (next: ConversationControl, why?: string) => {
    setPending(next);
    try {
      const r = await setConversationControlAction(conversationId, next, why);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(
        next === "HUMAN"
          ? "Đã tiếp quản — AI im cho tới khi bạn trả lại"
          : next === "COPILOT"
            ? "AI chỉ gợi ý, bạn gửi"
            : hold.state === "HUMAN_COOLDOWN"
              ? "AI tiếp tục ngay — trả lời từ tin khách kế tiếp"
              : "Đã trả lại cho AI",
      );
      setAsking(false);
      setReason("");
    } finally {
      setPending(null);
    }
  };

  // Câu hiển thị dựng bằng MỘT hàm thuần (ai-status-shared.ts): còn lý do chặn ⇒ AI_BLOCKED, không bao giờ «AI đang trả lời».
  const shown = controlBarStatus({ hold, blocks, mode, handoffReason, control, lapsed, formatAt: formatDateTime });
  const status = shown.text;
  const tone = shown.state === "HUMAN_TAKEOVER" || shown.state === "AI_BLOCKED" ? "rose" : (shown.state === "HUMAN_COOLDOWN" && !lapsed) || mode === "COPILOT" ? "amber" : "violet";

  const btn = (key: string, target: ConversationControl, icon: React.ReactNode, label: string, onClick: () => void, active = false) => (
    <button
      key={key}
      type="button"
      data-testid={`control-${key}`}
      aria-pressed={active}
      disabled={!canWork || pending !== null || active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] font-medium transition-colors disabled:cursor-default",
        active ? "border-transparent bg-foreground text-background" : "bg-background hover:bg-muted disabled:opacity-50",
      )}
    >
      {pending === target ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );

  const buttons: React.ReactNode[] = [];
  if (hold.state === "AI_ACTIVE") buttons.push(btn("AUTO", "AUTO", <Bot className="size-3.5" />, "AI tự trả lời", () => void apply("AUTO"), mode === "AUTO" && shown.state === "AI_ACTIVE"));
  else if (hold.state === "HUMAN_COOLDOWN") buttons.push(btn("RESUME", "AUTO", <Play className="size-3.5" />, "Cho AI tiếp tục ngay", () => void apply("AUTO")));
  else buttons.push(btn("RETURN", "AUTO", <Bot className="size-3.5" />, "Trả lại cho AI", () => void apply("AUTO")));
  if (channel !== "WEB") buttons.push(btn("COPILOT", "COPILOT", <Sparkles className="size-3.5" />, "AI gợi ý", () => void apply("COPILOT"), mode === "COPILOT" && hold.state !== "HUMAN_TAKEOVER"));
  buttons.push(btn("HUMAN", "HUMAN", <Hand className="size-3.5" />, mode === "HUMAN" ? "Đang tiếp quản" : "Tiếp quản", () => setAsking((v) => !v), mode === "HUMAN"));

  return (
    <div
      className={cn(
        "space-y-1.5 border-b px-4 py-1.5 text-[12px]",
        tone === "rose" && "bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
        tone === "amber" && "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
        tone === "violet" && "bg-violet-50 text-violet-900 dark:bg-violet-950/40 dark:text-violet-200",
      )}
      data-testid="conversation-control"
      data-hold-state={hold.state}
      data-ai-state={shown.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-start gap-1.5">
          {shown.state === "HUMAN_COOLDOWN" ? <Timer className="mt-0.5 size-3.5 shrink-0" /> : shown.state === "HUMAN_TAKEOVER" ? <Hand className="mt-0.5 size-3.5 shrink-0" /> : shown.state === "AI_BLOCKED" ? <Ban className="mt-0.5 size-3.5 shrink-0" /> : <Bot className="mt-0.5 size-3.5 shrink-0" />}
          <span className="break-words">
            {remaining !== null && !lapsed ? (
              <span className="mr-1.5 inline-block rounded bg-amber-200/70 px-1.5 font-mono font-semibold tabular-nums dark:bg-amber-900/60" data-testid="cooldown-countdown" aria-label="Thời gian AI còn nhường">
                {formatCountdown(remaining)}
              </span>
            ) : null}
            {status}
          </span>
        </span>
        {canWork ? (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Ai trả lời khách">
            {buttons}
          </div>
        ) : null}
      </div>
      {shown.note ? <p className="break-words text-[11px] opacity-90" data-testid="ai-block-note">{shown.note}</p> : null}
      {blocks.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]" data-testid="ai-blocks">
          {blocks.map((b) => (
            <li key={b.code} data-code={b.code} className="inline-flex items-center gap-1">
              <code className="rounded bg-background/60 px-1 font-mono">{b.code}</code>
              {b.fixHref ? (
                <Link href={b.fixHref} className="font-medium underline underline-offset-2">
                  {b.fixLabel}
                </Link>
              ) : (
                <span className="opacity-80">liên hệ người vận hành</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {asking && mode !== "HUMAN" ? (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void apply("HUMAN", reason);
          }}
        >
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={CONTROL_REASON_MAX}
            placeholder="Lý do tiếp quản (không bắt buộc) — vd: khách sỉ, khiếu nại"
            aria-label="Lý do tiếp quản"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[12px] text-foreground"
            autoFocus
          />
          <button type="submit" disabled={pending !== null} className="inline-flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background">
            {pending === "HUMAN" ? <Loader2 className="size-3.5 animate-spin" /> : <Hand className="size-3.5" />} Xác nhận tiếp quản
          </button>
          <button type="button" className="h-7 px-1.5 text-[12px] underline underline-offset-2" onClick={() => setAsking(false)}>
            Huỷ
          </button>
        </form>
      ) : null}
    </div>
  );
}

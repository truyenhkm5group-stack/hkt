"use client";

import { useState } from "react";
import { Bot, Hand, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { setConversationControlAction } from "@/lib/actions/sales-inbox";
import { CONTROL_REASON_MAX, CONVERSATION_CONTROL_LABEL, type ControlStamp, type ConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * THANH AI ↔ NGƯỜI của một hội thoại (conversation-control-shared.ts): ba nút — AI tự trả lời · AI gợi ý · Tiếp quản — và một
 * câu nói rõ ai đang trả lời khách. Tiếp quản hỏi lý do (không bắt buộc) ngay tại chỗ, vào nhật ký. Mọi phép kiểm ở máy chủ;
 * hai người bấm cùng lúc ⇒ người sau được báo tải lại. Nút xuống dòng trên điện thoại.
 */
export function ConversationControlBar({
  conversationId,
  channel,
  control,
  botYields,
  handoffReason,
  canWork,
}: {
  conversationId: string;
  channel: string;
  control: ControlStamp | null;
  botYields: boolean;
  handoffReason: string | null;
  canWork: boolean;
}) {
  const [pending, setPending] = useState<ConversationControl | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const mode: ConversationControl = control?.mode ?? "AUTO";

  const apply = async (next: ConversationControl, why?: string) => {
    setPending(next);
    try {
      const r = await setConversationControlAction(conversationId, next, why);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(next === "HUMAN" ? "Đã tiếp quản — AI im cho tới khi bạn trả lại" : next === "COPILOT" ? "AI chỉ gợi ý, bạn gửi" : "Đã trả lại cho AI");
      setAsking(false);
      setReason("");
    } finally {
      setPending(null);
    }
  };

  const status =
    mode === "HUMAN"
      ? `Người đang xử lý — AI im${control?.byName ? ` · ${control.byName}` : ""}${control?.at ? ` · ${formatDateTime(control.at)}` : ""}${control?.reason ? ` · «${control.reason}»` : ""}`
      : mode === "COPILOT"
        ? "AI chỉ soạn gợi ý, không gửi — bạn gửi khách."
        : botYields
          ? `AI đang nhường cho người — ${handoffReason ?? "cần người xử lý"}`
          : "AI đang tự trả lời khách này. Bạn gửi tin thì AI nhường 30 phút; bấm «Tiếp quản» để AI im hẳn.";
  const human = mode === "HUMAN" || botYields;
  // Nút đang chọn: chế độ ghi đè của hội thoại; không ghi đè thì «AI tự trả lời» chỉ khi AI không đang nhường (nhường 30 phút
  // sau một câu của nhân viên KHÔNG phải tiếp quản — không nút nào sáng, để người thấy còn một bước «Tiếp quản» hẳn).
  const active: ConversationControl | null = mode !== "AUTO" ? mode : botYields ? null : "AUTO";

  const btn = (key: ConversationControl, icon: React.ReactNode, label: string, onClick: () => void) => (
    <button
      key={key}
      type="button"
      data-testid={`control-${key}`}
      aria-pressed={active === key}
      disabled={!canWork || pending !== null || active === key}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] font-medium transition-colors disabled:cursor-default",
        active === key ? "border-transparent bg-foreground text-background" : "bg-background hover:bg-muted disabled:opacity-50",
      )}
    >
      {pending === key ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );

  return (
    <div className={cn("space-y-1.5 border-b px-4 py-1.5 text-[12px]", human ? "bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200" : mode === "COPILOT" ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "bg-violet-50 text-violet-900 dark:bg-violet-950/40 dark:text-violet-200")} data-testid="conversation-control">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-start gap-1.5">
          <Bot className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{status}</span>
        </span>
        {canWork ? (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Ai trả lời khách">
            {btn("AUTO", <Bot className="size-3.5" />, mode === "AUTO" && !botYields ? CONVERSATION_CONTROL_LABEL.AUTO : "Trả lại AI", () => void apply("AUTO"))}
            {channel !== "WEB" ? btn("COPILOT", <Sparkles className="size-3.5" />, "AI gợi ý", () => void apply("COPILOT")) : null}
            {btn("HUMAN", <Hand className="size-3.5" />, mode === "HUMAN" ? "Đang tiếp quản" : "Tiếp quản", () => setAsking((v) => !v))}
          </div>
        ) : null}
      </div>
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

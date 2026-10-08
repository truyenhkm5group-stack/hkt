"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { refreshPublicChatAction, sendPublicChatAction, startPublicChatAction } from "@/lib/actions/public-chat";
import { sendTestChatAction, startTestChatAction } from "@/lib/actions/sales-chatbot";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { cn } from "@/lib/utils";

/**
 * Khung chat dùng chung cho KHUNG THỬ (trong ERP, kênh `TEST` — lượt ghi mô phỏng) và TRANG CHAT CÔNG KHAI (tên miền
 * con, kênh `WEB` — ghi thật). Client chỉ gửi chữ; tổ chức, kênh và khách truy cập do máy chủ quyết.
 */
export function SalesChatPanel({ mode, title, className }: { mode: "test" | "public"; title?: string; className?: string }) {
  const [view, setView] = useState<ChatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const list = useRef<HTMLDivElement>(null);

  const open = () =>
    start(async () => {
      setError(null);
      const r = mode === "test" ? await startTestChatAction() : await startPublicChatAction();
      if ("error" in r) setError(r.error);
      else setView(r.view);
    });

  useEffect(() => {
    open();
    // Mở MỘT hội thoại khi khung chat hiện lần đầu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cuộn KHUNG TIN xuống đáy — không `scrollIntoView`: trên điện thoại (một cột) lệnh đó cuộn CẢ TRANG xuống tận cuối ngay khi
  // mở AI Sales (đo 08/10/2026: scrollY 7.532 / 8.889 px ở 390 px), đẩy bảng «AI đã sẵn sàng…» và cấu hình khuất lên trên.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view, pending]);

  // Trang chat CÔNG KHAI: nhân viên trả lời từ hộp thư ERP (không có kênh đẩy) ⇒ khung chat tự đọc lại hội thoại mỗi 15 giây
  // khi tab đang mở và không có lượt gửi nào đang chạy. Chỉ thay khi CÙNG hội thoại và có thêm tin — không giật khung đang gõ.
  // ĐỌC LẠI, không MỞ: `startPublicChatAction` tạo một hội thoại mới mỗi lần gọi (mỗi tab đang mở = 4 hội thoại rác / phút, và
  // tin nhân viên không bao giờ hiện vì id luôn khác) — đọc lại đi qua `refreshPublicChatAction`, chỉ đọc, không qua trần tần suất.
  const viewRef = useRef<ChatView | null>(null);
  viewRef.current = view;
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  useEffect(() => {
    if (mode !== "public") return;
    const id = window.setInterval(async () => {
      const cur = viewRef.current;
      if (!cur || pendingRef.current || document.visibilityState !== "visible") return;
      const r = await refreshPublicChatAction(cur.conversationId);
      if ("error" in r || pendingRef.current) return;
      const now = viewRef.current;
      if (now && r.view.conversationId === now.conversationId && (r.view.messages.length > now.messages.length || r.view.status !== now.status)) setView(r.view);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [mode]);

  const send = () => {
    const t = text.trim();
    if (!t || !view) return;
    setText("");
    setView({ ...view, messages: [...view.messages, { role: "user", text: t }] });
    start(async () => {
      setError(null);
      const r = mode === "test" ? await sendTestChatAction(view.conversationId, t) : await sendPublicChatAction(view.conversationId, t);
      if ("error" in r) {
        setError(r.error);
        if (r.view) setView(r.view);
        else if (mode === "public") {
          // Trang công khai: lỗi KHÔNG kèm hội thoại = tin chưa tới hội thoại (trần tần suất, phiên hết, shop tắt chat). Gỡ bong
          // bóng vừa thêm và trả chữ về ô nhập để khách gửi lại — không để khách tưởng tin đã đi.
          setView(view);
          setText((cur) => cur || t);
        }
      } else setView(r.view);
    });
  };

  return (
    <div className={cn("flex h-[560px] flex-col rounded-xl border bg-background", className)} data-testid={`sales-chat-${mode}`}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-sm font-semibold">{title ?? "Chat"}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {view?.order ? (
            <span data-testid="chat-order" data-stage={view.order.stage ?? ""} data-simulated={view.order.simulated ? "1" : "0"}>
              {view.order.stage === "CONFIRMED" ? "Đơn đã chốt" : "Đơn nháp"} {view.order.id ?? ""}
              {view.order.simulated ? " (thử)" : ""}
            </span>
          ) : null}
          {view?.status === "HANDOFF" ? <span className="rounded bg-amber-100 px-1.5 text-amber-900">Đã chuyển nhân viên</span> : null}
          <Button type="button" size="icon" variant="ghost" title="Hội thoại mới" disabled={pending} onClick={open}>
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </div>
      <div ref={list} className="flex-1 space-y-3 overflow-y-auto p-3" data-testid="chat-messages">
        {view?.messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-6", m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted")} data-role={m.role}>
              {m.text ? <p className="whitespace-pre-wrap">{m.text}</p> : null}
              {mode === "test" && m.tools?.length ? (
                <ul className="mt-1.5 space-y-0.5 border-t border-foreground/10 pt-1.5 text-[11px] opacity-75" data-testid="chat-tools">
                  {m.tools.map((t, j) => (
                    <li key={j} data-tool={t.name} data-ok={t.ok ? "1" : "0"}>
                      {t.ok ? "✓" : "✗"} {t.name}
                      {t.summary ? ` — ${t.summary}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ))}
        {pending ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Đang trả lời…
          </p>
        ) : null}
      </div>
      {error ? <p className="border-t px-3 py-2 text-xs text-destructive" data-testid="chat-error">{error}</p> : null}
      <form
        className="flex items-end gap-2 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          rows={2}
          value={text}
          maxLength={1000}
          placeholder="Nhập tin nhắn…"
          aria-label="Tin nhắn"
          className="min-h-0 resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button type="submit" size="icon" disabled={pending || !view || !text.trim()} aria-label="Gửi">
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatOrderForm } from "@/components/orders/chat-order-form";
import { assignConversationAction, claimConversationAction, handBackToAiAction, releaseConversationAction, sendStaffReplyAction, suggestReplyAction } from "@/lib/actions/sales-inbox";
import { formatDateTime } from "@/lib/format";
import { STAFF_REPLY_MAX, type InboxOrder, type InboxThread, type TimelineItem } from "@/lib/sales-chatbot/inbox-shared";
import { cn } from "@/lib/utils";

/**
 * MỘT HỘI THOẠI CỦA HỘP THƯ (M8): dòng thời gian gộp + khung soạn + bảng khách / đơn. Mọi phép kiểm ở máy chủ
 * (`lib/sales-chatbot/inbox.ts`); trang chỉ giữ chữ đang gõ và khoá lượt gửi (`requestKey` — bấm hai lần không gửi khách hai tin;
 * gửi hỏng thì giữ nguyên khoá để bấm lại là gửi lại ĐÚNG tin đó).
 */

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const SIDE_STYLE: Record<TimelineItem["side"], string> = {
  CUSTOMER: "bg-muted",
  BOT: "ml-auto bg-primary/10",
  STAFF: "ml-auto bg-emerald-100 dark:bg-emerald-950/50",
  PAGE: "ml-auto bg-sky-100 dark:bg-sky-950/50",
};
const SIDE_LABEL: Record<TimelineItem["side"], string> = { CUSTOMER: "Khách", BOT: "Bot", STAFF: "Nhân viên", PAGE: "Phía page" };

export function InboxThreadView({
  thread,
  me,
  users,
  backHref,
  ordersSummary,
}: {
  thread: InboxThread;
  me: string;
  users: { id: string; name: string }[];
  backHref: string;
  ordersSummary: (InboxOrder & { totalText: string })[];
}) {
  const [text, setText] = useState("");
  const [requestKey, setRequestKey] = useState(newKey);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [pending, setPending] = useState<null | "send" | "suggest" | "claim" | "release" | "assign" | "resume">(null);
  const [error, setError] = useState<string | null>(null);
  const [showOrder, setShowOrder] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const lastKey = thread.items[thread.items.length - 1]?.key;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lastKey]);

  const run = async (kind: NonNullable<typeof pending>, fn: () => Promise<{ ok: true } | { error: string }>, okMsg?: string) => {
    setPending(kind);
    setError(null);
    try {
      const r = await fn();
      if ("error" in r) {
        setError(r.error);
        toast.error(r.error);
        return false;
      }
      if (okMsg) toast.success(okMsg);
      return true;
    } finally {
      setPending(null);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || pending) return;
    const ok = await run("send", () => sendStaffReplyAction(thread.id, { text: body, requestKey, confirmPaid }));
    if (ok) {
      setText("");
      setRequestKey(newKey());
      setConfirmPaid(false);
    }
  };

  const suggest = async () => {
    setPending("suggest");
    setError(null);
    try {
      const r = await suggestReplyAction(thread.id);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setText(r.suggestion);
      // Câu mới ⇒ lượt gửi mới.
      setRequestKey(newKey());
    } finally {
      setPending(null);
    }
  };

  const mine = thread.assigneeUserId === me;
  const w = thread.window;

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-h-[70vh] flex-col rounded-lg border bg-background">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <div className="min-w-0">
            <Link href={backHref} className="mr-2 text-[12px] text-primary hover:underline lg:hidden">
              ← Danh sách
            </Link>
            <span className="font-semibold">{thread.customer.name}</span>
            <span className="ml-2 text-[12px] text-muted-foreground">
              {thread.channelLabel}
              {thread.customer.phone ? ` · ${thread.customer.phone}` : ""}
            </span>
            <div className="text-[11.5px] text-muted-foreground">
              {thread.botYields ? <span className="text-rose-700 dark:text-rose-300">Bot đang nhường · {thread.handoffReason ?? "cần người"}</span> : <span>Bot đang trả lời</span>}
              {" · "}
              {thread.assigneeName ? `Người nhận: ${thread.assigneeName}` : "Chưa ai nhận"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {!thread.assigneeUserId ? (
              <Button size="sm" variant="outline" className="h-7" disabled={!!pending} onClick={() => void run("claim", () => claimConversationAction(thread.id), "Đã nhận hội thoại")}>
                Nhận
              </Button>
            ) : mine || thread.canManage ? (
              <Button size="sm" variant="ghost" className="h-7" disabled={!!pending} onClick={() => void run("release", () => releaseConversationAction(thread.id), "Đã trả hội thoại")}>
                Bỏ nhận
              </Button>
            ) : null}
            {thread.canManage && users.length ? (
              <select
                className="h-7 rounded-md border bg-background px-1 text-[12px]"
                value=""
                aria-label="Giao cho"
                disabled={!!pending}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) void run("assign", () => assignConversationAction(thread.id, id), "Đã giao hội thoại");
                }}
              >
                <option value="">Giao cho…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            ) : null}
            {thread.botYields ? (
              <Button size="sm" variant="outline" className="h-7" disabled={!!pending} onClick={() => void run("resume", () => handBackToAiAction(thread.id), "Đã trả lại cho AI")}>
                Trả lại cho AI
              </Button>
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-[13px]" data-testid="inbox-timeline">
          {thread.items.length === 0 ? <p className="text-muted-foreground">Chưa có tin nào.</p> : null}
          {thread.items.map((m) => (
            <div key={m.key} className={cn("max-w-[85%] rounded-lg px-3 py-2", SIDE_STYLE[m.side], m.status === "FAILED" && "ring-1 ring-destructive")} data-side={m.side}>
              <div className="mb-0.5 text-[10.5px] text-muted-foreground">
                {m.author ?? SIDE_LABEL[m.side]} · {formatDateTime(m.at)}
                {m.status === "SENDING" ? " · đang gửi" : m.status === "FAILED" ? " · GỬI HỎNG" : ""}
              </div>
              {m.text ? <div className="whitespace-pre-wrap break-words">{m.text}</div> : null}
              {m.images.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.images.slice(0, 6).map((src) => (
                    <a key={src} href={src} target="_blank" rel="noopener noreferrer" className="text-[11px] text-primary underline">
                      Ảnh
                    </a>
                  ))}
                </div>
              ) : null}
              {m.status === "FAILED" && m.error ? <div className="mt-1 text-[11px] text-destructive">{m.error}</div> : null}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <footer className="space-y-2 border-t p-2">
          {w.note ? (
            <p className={cn("rounded-md px-2 py-1 text-[11.5px]", w.kind === "OPEN" ? "bg-muted text-muted-foreground" : "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200")}>{w.note}</p>
          ) : w.kind === "OPEN" && w.until ? (
            <p className="text-[11.5px] text-muted-foreground">Gửi được tới {formatDateTime(w.until)} (khung của kênh, tính từ tin cuối của khách).</p>
          ) : null}
          {thread.canReply ? (
            <>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={STAFF_REPLY_MAX}
                rows={3}
                placeholder="Nhập tin trả lời khách… (Ctrl + Enter để gửi)"
                aria-label="Tin trả lời"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="h-8" disabled={!!pending} onClick={() => void suggest()}>
                    {pending === "suggest" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} AI gợi ý câu trả lời
                  </Button>
                  {w.kind === "PAID" ? (
                    <label className="flex items-center gap-1 text-[12px]">
                      <input type="checkbox" checked={confirmPaid} onChange={(e) => setConfirmPaid(e.target.checked)} /> Gửi tin tính phí
                    </label>
                  ) : null}
                </div>
                <Button size="sm" className="h-8" disabled={!!pending || !text.trim() || (w.kind === "PAID" && !confirmPaid)} onClick={() => void send()}>
                  {pending === "send" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Gửi
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">{thread.replyBlockedReason ?? "Bạn chỉ được xem hội thoại này."}</p>
          )}
          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
        </footer>
      </div>

      <aside className="space-y-3 text-[12.5px]">
        <div className="space-y-1 rounded-lg border p-3">
          <p className="font-semibold">Khách</p>
          <p>{thread.customer.name}</p>
          {thread.customer.phone ? <p>{thread.customer.phone}</p> : <p className="text-muted-foreground">Chưa có SĐT</p>}
          {thread.customer.address ? (
            <p className="text-muted-foreground">
              {thread.customer.address}
              {thread.customer.province ? `, ${thread.customer.province}` : ""}
            </p>
          ) : null}
          {thread.customer.id ? (
            <Link href={`/customers/${encodeURIComponent(thread.customer.id)}`} className="text-primary hover:underline">
              Hồ sơ khách →
            </Link>
          ) : null}
        </div>
        <div className="space-y-1.5 rounded-lg border p-3" data-testid="inbox-orders">
          <p className="font-semibold">Đơn của khách</p>
          {ordersSummary.length === 0 ? <p className="text-muted-foreground">Chưa có đơn.</p> : null}
          {ordersSummary.map((o) => (
            <Link key={o.id} href={`/orders/${encodeURIComponent(o.id)}`} className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-muted">
              <span>
                #{o.shortCode} · {o.totalText}
                {o.byBot ? <span className="text-muted-foreground"> · bot</span> : null}
              </span>
              <span className={cn("text-[11px]", o.outcome === "DELIVERED" ? "text-emerald-700 dark:text-emerald-300" : o.outcome === "RETURNED" || o.outcome === "RETURNED_BY_RULE" ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground")}>{o.outcomeLabel}</span>
            </Link>
          ))}
          <Button size="sm" variant="outline" className="mt-1 h-7 w-full" onClick={() => setShowOrder((v) => !v)}>
            {showOrder ? "Đóng form tạo đơn" : "Tạo đơn cho khách này"}
          </Button>
          {showOrder ? (
            <div className="pt-2">
              <ChatOrderForm conversationId={thread.id} defaults={{ customerId: thread.customer.id, name: thread.customer.id ? undefined : thread.customer.name === "Khách" ? undefined : thread.customer.name, phone: thread.customer.id ? undefined : (thread.customer.phone ?? undefined), address: thread.customer.id ? undefined : (thread.customer.address ?? undefined) }} />
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

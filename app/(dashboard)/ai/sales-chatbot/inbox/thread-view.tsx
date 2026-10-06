"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ImagePlus, Loader2, Send, Sparkles, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChatOrderForm } from "@/components/orders/chat-order-form";
import { assignConversationAction, claimConversationAction, releaseConversationAction, sendStaffReplyAction, suggestReplyAction } from "@/lib/actions/sales-inbox";
import { formatDateTime, vnClock, vnDateKey } from "@/lib/format";
import { STAFF_IMAGE_MAX_BYTES, STAFF_IMAGES_MAX, STAFF_REPLY_MAX, type InboxOrder, type InboxThread, type TimelineItem } from "@/lib/sales-chatbot/inbox-shared";
import { cn } from "@/lib/utils";
import { ChannelAvatar } from "./avatar";
import { ConversationControlBar } from "./control-bar";
import { LabelsPanel } from "./labels-panel";
import { NotesPanel } from "./notes-panel";
import { CustomerHistoryCard, FeedbackPanel } from "./customer-insight";

/**
 * MỘT HỘI THOẠI CỦA HỘP THƯ (M8): dòng thời gian (vạch ngày, gộp tin liền nhau, khách bên trái — shop bên phải) + khung soạn luôn
 * ở đáy (Enter gửi, Shift + Enter xuống dòng) + cột khách / ghi chú / đơn. Mọi phép kiểm ở máy chủ (`lib/sales-chatbot/inbox.ts`);
 * trang chỉ giữ chữ đang gõ và khoá lượt gửi (`requestKey` — bấm hai lần không gửi khách hai tin; gửi hỏng thì giữ nguyên khoá để
 * bấm lại là gửi lại ĐÚNG tin đó). Đang đọc tin cũ mà có tin mới ⇒ nút «Có tin mới ↓», không giật cuộn của người đang đọc.
 */

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const BUBBLE: Record<TimelineItem["side"], string> = {
  CUSTOMER: "bg-muted text-foreground rounded-bl-md",
  BOT: "bg-violet-600 text-white rounded-br-md dark:bg-violet-700",
  STAFF: "bg-emerald-600 text-white rounded-br-md dark:bg-emerald-700",
  PAGE: "bg-sky-600 text-white rounded-br-md dark:bg-sky-700",
};
const SIDE_LABEL: Record<TimelineItem["side"], string> = { CUSTOMER: "Khách", BOT: "Bot", STAFF: "Nhân viên", PAGE: "Nhân viên / tự động (ngoài ERP)" };
/** Tin cùng phía cách nhau ít hơn chừng này ⇒ gộp dưới một tên người gửi. */
const GROUP_GAP_MS = 5 * 60_000;

function dayLabel(key: string): string {
  const today = vnDateKey(new Date());
  const yesterday = vnDateKey(new Date(Date.now() - 86_400_000));
  if (key === today) return "Hôm nay";
  if (key === yesterday) return "Hôm qua";
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

type Row = { kind: "day"; key: string; label: string } | { kind: "msg"; m: TimelineItem; head: boolean; author: string };

function layout(items: readonly TimelineItem[]): Row[] {
  const out: Row[] = [];
  let lastDay = "";
  let prev: TimelineItem | null = null;
  for (const m of items) {
    const day = vnDateKey(m.at);
    if (day !== lastDay) {
      out.push({ kind: "day", key: `d:${day}`, label: dayLabel(day) });
      lastDay = day;
      prev = null;
    }
    const author = m.author ?? SIDE_LABEL[m.side];
    const head = !prev || prev.side !== m.side || (prev.author ?? SIDE_LABEL[prev.side]) !== author || new Date(m.at).getTime() - new Date(prev.at).getTime() > GROUP_GAP_MS;
    out.push({ kind: "msg", m, head, author });
    prev = m;
  }
  return out;
}

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
  const [pending, setPending] = useState<null | "send" | "suggest" | "claim" | "release" | "assign">(null);
  const [error, setError] = useState<string | null>(null);
  const [showOrder, setShowOrder] = useState(false);
  // Dưới 1280 px cột khách / đơn / ghi chú là một lớp PHỦ mở bằng nút trên đầu hội thoại — trước đây nó `hidden` hẳn nên trên
  // điện thoại không tạo được đơn, không ghi chú được.
  const [showSide, setShowSide] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [newBelow, setNewBelow] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const lastKey = thread.items[thread.items.length - 1]?.key;
  const firstRender = useRef(true);

  // Tin mới tới: đang ở đáy ⇒ cuộn theo; đang đọc tin cũ ⇒ KHÔNG giật cuộn, hiện nút «Có tin mới».
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (firstRender.current || nearBottom.current) {
      el.scrollTop = el.scrollHeight;
      setNewBelow(false);
    } else setNewBelow(true);
    firstRender.current = false;
  }, [lastKey]);

  // Ô soạn tự cao theo chữ (tối đa ~6 dòng).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // Ảnh xem trước: URL tạm của trình duyệt, thu hồi khi đổi / rời trang.
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewBelow(false);
  };

  const pickFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = [...list].filter((f) => f.type.startsWith("image/"));
    const tooBig = incoming.find((f) => f.size > STAFF_IMAGE_MAX_BYTES);
    if (tooBig) toast.error(`«${tooBig.name}» quá ${Math.round(STAFF_IMAGE_MAX_BYTES / 1024 / 1024)} MB.`);
    const next = [...files, ...incoming.filter((f) => f.size <= STAFF_IMAGE_MAX_BYTES)].slice(0, STAFF_IMAGES_MAX);
    if (files.length + incoming.length > STAFF_IMAGES_MAX) toast.message(`Mỗi tin tối đa ${STAFF_IMAGES_MAX} ảnh.`);
    setFiles(next);
    // Ảnh đổi ⇒ tin khác ⇒ lượt gửi mới.
    setRequestKey(newKey());
    if (fileInput.current) fileInput.current.value = "";
  };

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
    if ((!body && !files.length) || pending) return;
    if (w.kind === "PAID" && !confirmPaid) {
      toast.error("Tin ngoài 48 giờ của Zalo là tin tính phí — tick «Gửi tin tính phí» trước.");
      return;
    }
    const form = new FormData();
    form.set("text", body);
    form.set("requestKey", requestKey);
    if (confirmPaid) form.set("confirmPaid", "1");
    for (const f of files) form.append("images", f);
    nearBottom.current = true;
    const ok = await run("send", () => sendStaffReplyAction(thread.id, form));
    if (ok) {
      setText("");
      setFiles([]);
      setRequestKey(newKey());
      setConfirmPaid(false);
      input.current?.focus();
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
      input.current?.focus();
    } finally {
      setPending(null);
    }
  };

  const mine = thread.assigneeUserId === me;
  const w = thread.window;
  const rows = layout(thread.items);

  return (
    // `minmax(0,1fr)` cả khi chỉ có một cột: rãnh `auto` mặc định nở theo nội dung (tin dài, hàng nút) ⇒ tràn ngang trên điện thoại.
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        {/* ── Đầu hội thoại ── */}
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b px-4 py-2.5">
          <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
            <Link href={backHref} className="mt-2 text-muted-foreground hover:text-foreground lg:hidden" aria-label="Về danh sách">
              <ArrowLeft className="size-4" />
            </Link>
            <ChannelAvatar name={thread.customer.name} channel={thread.channel} size="lg" />
            <div className="min-w-0 space-y-0.5">
              <p className="truncate text-base font-semibold leading-tight">{thread.customer.name}</p>
              <p className="truncate text-[12px] text-muted-foreground">
                {thread.channelLabel}
                {thread.customer.phone ? ` · ${thread.customer.phone}` : ""}
                {" · "}
                {thread.assigneeName ? `Người nhận: ${thread.assigneeName}` : "Chưa ai nhận"}
              </p>
              <LabelsPanel key={thread.labels.map((l) => l.id).join()} conversationId={thread.id} labels={thread.labels} allLabels={thread.allLabels} canEdit={thread.canWork} canManage={thread.canManage} />
            </div>
          </div>
          <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
            <Button size="sm" variant="outline" className="h-8 xl:hidden" onClick={() => setShowSide(true)} aria-label="Khách, đơn và ghi chú" data-testid="inbox-open-side">
              <UserRound className="size-4" /> Khách · Đơn
            </Button>
            {!thread.assigneeUserId && thread.canWork ? (
              <Button size="sm" className="h-8" disabled={!!pending} onClick={() => void run("claim", () => claimConversationAction(thread.id), "Đã nhận hội thoại")}>
                Nhận hội thoại
              </Button>
            ) : thread.assigneeUserId && (mine || thread.canManage) ? (
              <Button size="sm" variant="ghost" className="h-8" disabled={!!pending} onClick={() => void run("release", () => releaseConversationAction(thread.id), "Đã bỏ nhận")}>
                Bỏ nhận
              </Button>
            ) : null}
            {thread.canManage && users.length ? (
              <select
                className="h-8 rounded-md border bg-background px-1 text-[12px]"
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
          </div>
        </header>

        {/* ── AI hay người trả lời khách (Tiếp quản / AI gợi ý / Trả lại AI) ── */}
        <ConversationControlBar key={`${thread.control?.mode ?? "AUTO"}:${thread.status}`} conversationId={thread.id} channel={thread.channel} control={thread.control} botYields={thread.botYields} handoffReason={thread.handoffReason} canWork={thread.canWork} />

        {/* ── Tin nhắn ── */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            className="h-full overflow-y-auto bg-muted/20 px-4 py-3"
            data-testid="inbox-timeline"
            onScroll={(e) => {
              const el = e.currentTarget;
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              if (nearBottom.current) setNewBelow(false);
            }}
          >
            {rows.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">Chưa có tin nào.</p> : null}
            {rows.map((r) =>
              r.kind === "day" ? (
                <div key={r.key} className="my-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {r.label}
                  <span className="h-px flex-1 bg-border" />
                </div>
              ) : (
                <div key={r.m.key} className={cn("flex flex-col", r.m.side === "CUSTOMER" ? "items-start" : "items-end", r.head ? "mt-3" : "mt-0.5")} data-side={r.m.side}>
                  {r.head ? (
                    <span className="mb-0.5 px-1 text-[11px] text-muted-foreground">
                      {r.author} · {vnClock(r.m.at).slice(0, 5)}
                    </span>
                  ) : null}
                  <div className={cn("max-w-[78%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed shadow-sm", BUBBLE[r.m.side], r.m.status === "FAILED" && "bg-destructive/90 dark:bg-destructive/80", r.m.status === "SENDING" && "opacity-70")} title={formatDateTime(r.m.at)}>
                    {r.m.text ? <div className="whitespace-pre-wrap break-words">{r.m.text}</div> : null}
                    {r.m.images.length ? (
                      <div className={cn("flex flex-wrap gap-1", r.m.text && "mt-1.5")}>
                        {r.m.images.slice(0, 6).map((src) => (
                          <a key={src} href={src} target="_blank" rel="noopener noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh khách (CDN của kênh) hoặc ảnh nhân viên trong CSDL qua tuyến có kiểm quyền */}
                            <img src={src} alt="Ảnh trong hội thoại" className="h-32 w-32 rounded-lg border border-white/30 object-cover" loading="lazy" />
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {r.m.status === "SENDING" ? <span className="mt-0.5 px-1 text-[11px] text-muted-foreground">Đang gửi…</span> : null}
                  {r.m.status === "FAILED" ? <span className="mt-0.5 max-w-[78%] px-1 text-right text-[11px] font-medium text-destructive">Gửi hỏng — {r.m.error ?? "thử lại"}</span> : null}
                </div>
              ),
            )}
          </div>
          {newBelow ? (
            <button type="button" className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground shadow-lg" onClick={toBottom}>
              <ArrowDown className="size-3.5" /> Có tin mới
            </button>
          ) : null}
        </div>

        {/* ── Khung soạn ── */}
        <footer className="space-y-2 border-t bg-background px-3 py-2">
          {w.kind !== "OPEN" || w.note ? (
            <p className={cn("rounded-md px-2 py-1 text-[12px]", w.kind === "OPEN" ? "bg-muted text-muted-foreground" : "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200")}>{w.note}</p>
          ) : null}
          {thread.canReply ? (
            <>
              {previews.length ? (
                <div className="flex flex-wrap gap-1.5" data-testid="inbox-image-previews">
                  {previews.map((src, i) => (
                    <div key={src} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- ảnh xem trước, URL tạm của trình duyệt */}
                      <img src={src} alt={`Ảnh ${i + 1}`} className="h-16 w-16 rounded-md border object-cover" />
                      <button
                        type="button"
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 shadow"
                        aria-label={`Bỏ ảnh ${i + 1}`}
                        onClick={() => {
                          setFiles((prev) => prev.filter((_, j) => j !== i));
                          setRequestKey(newKey());
                        }}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex items-end gap-2 rounded-xl border bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-primary/30">
                <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => pickFiles(e.target.files)} aria-label="Chọn ảnh" />
                <button
                  type="button"
                  className="mb-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  disabled={!!pending || files.length >= STAFF_IMAGES_MAX || thread.channel === "WEB"}
                  title={thread.channel === "WEB" ? "Chat web chưa nhận ảnh từ hộp thư" : `Gửi ảnh — tối đa ${STAFF_IMAGES_MAX} ảnh, mỗi ảnh ≤ ${Math.round(STAFF_IMAGE_MAX_BYTES / 1024 / 1024)} MB${thread.channel === "ZALO" ? " (Zalo: JPG / PNG ≤ 1 MB)" : ""}`}
                  aria-label="Gửi ảnh"
                  onClick={() => fileInput.current?.click()}
                >
                  <ImagePlus className="size-5" />
                </button>
                <textarea
                  ref={input}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={STAFF_REPLY_MAX}
                  rows={1}
                  placeholder="Nhập tin nhắn… (Enter để gửi · Shift + Enter xuống dòng)"
                  aria-label="Tin trả lời"
                  className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <Button size="sm" className="mb-0.5 h-9 px-4" disabled={!!pending || (!text.trim() && !files.length)} onClick={() => void send()}>
                  {pending === "send" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Gửi
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3 px-1 text-[12px]">
                <button type="button" className="inline-flex items-center gap-1 text-violet-700 hover:underline disabled:opacity-50 dark:text-violet-300" disabled={!!pending} onClick={() => void suggest()}>
                  {pending === "suggest" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} AI gợi ý câu trả lời
                </button>
                {w.kind === "PAID" ? (
                  <label className="flex items-center gap-1 font-medium text-amber-800 dark:text-amber-200">
                    <input type="checkbox" checked={confirmPaid} onChange={(e) => setConfirmPaid(e.target.checked)} /> Gửi tin tính phí
                  </label>
                ) : null}
                {w.kind === "OPEN" && w.until ? <span className="text-muted-foreground">Gửi được tới {formatDateTime(w.until)}</span> : null}
              </div>
            </>
          ) : (
            <p className="px-1 py-2 text-[13px] text-muted-foreground">{thread.replyBlockedReason ?? "Bạn chỉ được xem hội thoại này."}</p>
          )}
          {error ? <p className="px-1 text-[12px] text-destructive">{error}</p> : null}
        </footer>
      </div>

      {/* ── Cột khách (≥ 1280 px: cột cố định · nhỏ hơn: lớp phủ toàn màn hình) ── */}
      <aside
        className={cn("min-h-0 space-y-3 overflow-y-auto bg-muted/20 p-3 text-[13px] xl:static xl:z-auto xl:block xl:border-l xl:border-foreground/15 xl:bg-muted/20", showSide ? "fixed inset-0 z-50 block bg-background pb-8" : "hidden")}
        data-testid="inbox-side"
        aria-label="Khách, đơn và ghi chú"
      >
        <div className="sticky -top-3 z-10 -mx-3 -mt-3 flex items-center justify-between border-b bg-background px-3 py-2 xl:hidden">
          <span className="text-sm font-semibold">{thread.customer.name}</span>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setShowSide(false)} aria-label="Đóng">
            <X className="size-4" /> Đóng
          </Button>
        </div>
        <div className="space-y-1 rounded-lg border bg-background p-3">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Khách</p>
          <p className="font-medium">{thread.customer.name}</p>
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
        <CustomerHistoryCard history={thread.history} level={thread.level} />
        <div className="space-y-1.5 rounded-lg border bg-background p-3" data-testid="inbox-orders">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Đơn của khách</p>
          {ordersSummary.length === 0 ? <p className="text-muted-foreground">Chưa có đơn.</p> : null}
          {ordersSummary.map((o) => (
            <div key={o.id}>
              <Link href={`/orders/${encodeURIComponent(o.id)}`} className="flex items-center justify-between gap-2 rounded px-1 py-1 hover:bg-muted">
                <span>
                  #{o.shortCode} · {o.totalText}
                  {o.byBot ? <span className="text-muted-foreground"> · bot</span> : null}
                </span>
                <span className={cn("text-[12px]", o.outcome === "DELIVERED" ? "text-emerald-700 dark:text-emerald-300" : o.outcome === "RETURNED" || o.outcome === "RETURNED_BY_RULE" ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground")}>{o.outcomeLabel}</span>
              </Link>
              {/* Địa chỉ chưa ghép được tỉnh / xã ⇒ chưa gửi hãng vận chuyển được, chưa tự xác nhận — sửa ngay từ hộp thư. */}
              {o.placeGap ? (
                <Link href={`/orders/${encodeURIComponent(o.id)}/edit`} className="block px-1 text-[11.5px] font-medium text-amber-700 hover:underline dark:text-amber-300">
                  ⚠ {o.placeGap} — sửa đơn →
                </Link>
              ) : null}
            </div>
          ))}
          <Button size="sm" variant={showOrder ? "ghost" : "default"} className="mt-1 h-8 w-full" onClick={() => setShowOrder((v) => !v)}>
            {showOrder ? "Đóng form tạo đơn" : "+ Tạo đơn cho khách này"}
          </Button>
          {showOrder ? (
            <div className="pt-2">
              <ChatOrderForm conversationId={thread.id} defaults={{ customerId: thread.customer.id, name: thread.customer.id ? undefined : thread.customer.name === "Khách" ? undefined : thread.customer.name, phone: thread.customer.id ? undefined : (thread.customer.phone ?? undefined), address: thread.customer.id ? undefined : (thread.customer.address ?? undefined) }} />
            </div>
          ) : null}
        </div>
        <FeedbackPanel conversationId={thread.id} feedback={thread.feedback} canWrite={thread.canWork} />
        <NotesPanel conversationId={thread.id} notes={thread.notes} canWrite={thread.canWork} />
      </aside>
    </div>
  );
}

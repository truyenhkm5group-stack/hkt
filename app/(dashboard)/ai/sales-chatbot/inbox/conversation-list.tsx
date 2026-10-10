"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Sparkles, UserRound } from "lucide-react";
import { AI_HOLD_LABEL } from "@/lib/sales-chatbot/ai-hold-shared";
import { compactTimeAgo, INBOX_HANDLING_LABEL, INBOX_SOURCE_LABEL, inboxHref, inboxRowStatus, keepActiveInPlace, unreadBadge, type InboxFilterState, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";
import { CUSTOMER_LEVEL_LABEL } from "@/lib/sales-chatbot/levels-shared";
import { cn } from "@/lib/utils";
import { ChannelAvatar } from "./avatar";
import { openConversationInPlace, useSelectedConversation } from "./thread-pane";

/**
 * ═══════════ DANH SÁCH HỘI THOẠI (INBOX-V2-A) — MỘT HÀNG HAI DÒNG ═══════════
 *
 * Mỗi hàng: ảnh · tên · MỘT trạng thái đơn / cần người · giờ — rồi MỘT dấu AI / người · một dòng xem trước · số chưa đọc. Trước
 * đây mỗi hàng mang 3–4 huy hiệu xuống dòng (AI · Chưa chốt · Pancake · page · level · SĐT · người nhận · nhãn) và cao 87–116 px;
 * nay ≈ 56 px. Thông tin phụ KHÔNG mất: rê chuột lên hàng thấy page · nguồn · level · SĐT · người nhận · nhãn (title), và mọi thứ
 * đó vẫn LỌC được ở «Lọc ▾». Chấm màu cạnh tên = nhãn (tên nhãn ở title).
 *
 * THỨ TỰ do máy chủ quyết (`inboxOrderBy`: chưa đọc trước, mới nhất trước). Trang chỉ làm MỘT việc: hội thoại ĐANG MỞ đứng yên tại
 * chỗ người vừa bấm (`keepActiveInPlace`) — mở hội thoại là đánh dấu đã đọc, nên ở lượt tải sau nó thuộc nhóm «đã đọc» (hoặc rời
 * thẻ «Chưa đọc»); không giữ thì hàng vừa bấm nhảy khỏi tầm mắt. Bấm hội thoại khác ⇒ hội thoại cũ về đúng chỗ của nó.
 */

const WAIT_URGENT_MIN = 15;

function waitMinutes(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ms = nowMs - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null;
}

const STATUS_CLASS = {
  NEEDS_HUMAN: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200",
  CLOSED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  DRAFT: "bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
} as const;

const LABEL_DOT: Record<string, string> = {
  gray: "bg-zinc-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};

const SIDE_PREFIX: Record<string, string> = { CUSTOMER: "", BOT: "AI: ", STAFF: "Bạn: ", PAGE: "Page: " };

function HandlingIcon({ r }: { r: InboxRow }) {
  const label = `${INBOX_HANDLING_LABEL[r.handling]} — ${AI_HOLD_LABEL[r.aiHold]}`;
  const cls = "size-3.5 shrink-0";
  return (
    <span title={label} aria-label={label} data-handler={r.handling === "AI" ? "AI" : "HUMAN"} data-handling={r.handling} className="inline-flex">
      {r.handling === "AI" ? <Bot className={cn(cls, "text-violet-600 dark:text-violet-400")} /> : r.handling === "COPILOT" ? <Sparkles className={cn(cls, "text-amber-600 dark:text-amber-400")} /> : <UserRound className={cn(cls, "text-orange-600 dark:text-orange-400")} />}
    </span>
  );
}

function metaOf(r: InboxRow, showPage: boolean): string {
  return [
    showPage && r.pageName ? `Page: ${r.pageName}` : null,
    r.source === "PANCAKE" || r.source === "DIRECT" ? `Nguồn: ${INBOX_SOURCE_LABEL[r.source]}` : null,
    r.level && r.level !== "NEW_MESSAGE" ? `Level: ${CUSTOMER_LEVEL_LABEL[r.level]}` : null,
    r.customerPhone ? `SĐT: ${r.customerPhone}` : "Chưa có SĐT",
    r.assigneeName ? `Người nhận: ${r.assigneeName}` : null,
    r.labels.length ? `Nhãn: ${r.labels.map((l) => l.name).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Row({ r, href, active, showPage, nowMs }: { r: InboxRow; href: string; active: boolean; showPage: boolean; nowMs: number }) {
  const wait = waitMinutes(r.waitingSince, nowMs);
  const status = inboxRowStatus(r);
  return (
    <Link
      href={href}
      prefetch={false}
      onClick={(e) => openConversationInPlace(e, href)}
      title={metaOf(r, showPage)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex items-center gap-2.5 border-l-[3px] px-2.5 py-2 transition-colors",
        active ? "border-l-primary bg-card shadow-[var(--shadow-card)]" : r.unread ? "border-l-primary/60 hover:bg-card/70" : "border-l-transparent hover:bg-card/70",
      )}
      data-conversation={r.id}
      data-unread={r.unread ? "1" : "0"}
      data-closed={r.closed ? "1" : "0"}
      data-source={r.source}
      data-page={r.pageId ?? undefined}
    >
      <ChannelAvatar name={r.customerName} channel={r.channel} src={r.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn("min-w-0 truncate text-[14px] leading-5 text-foreground", r.unread ? "font-bold" : "font-medium")}>{r.customerName}</span>
          {r.labels.length ? (
            <span className="flex shrink-0 gap-0.5" aria-hidden>
              {r.labels.slice(0, 3).map((l) => (
                <span key={l.id} className={cn("size-1.5 rounded-full", LABEL_DOT[l.color] ?? "bg-zinc-400")} />
              ))}
            </span>
          ) : null}
          {status ? (
            <span className={cn("shrink-0 rounded px-1.5 text-[11px] font-medium leading-[18px]", STATUS_CLASS[status.kind])} data-status={status.kind}>
              {status.label}
            </span>
          ) : null}
          <span
            className={cn("ml-auto shrink-0 text-xs tabular-nums", wait !== null && wait >= WAIT_URGENT_MIN ? "font-semibold text-red-600 dark:text-red-400" : wait !== null ? "font-medium text-amber-700 dark:text-amber-300" : r.unread ? "font-semibold text-primary" : "text-muted-foreground")}
            title={wait !== null ? `Khách chờ ${wait} phút` : undefined}
            suppressHydrationWarning
          >
            {compactTimeAgo(r.lastActivityAt, nowMs)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <HandlingIcon r={r} />
          <p className={cn("min-w-0 flex-1 truncate text-[13px] leading-[18px]", r.unread ? "font-medium text-foreground" : "text-muted-foreground")}>
            {r.previewSide ? SIDE_PREFIX[r.previewSide] : ""}
            {r.preview || "—"}
          </p>
          {r.unreadCount > 0 ? (
            <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground" aria-label={`${r.unreadCount} tin chưa đọc`} data-unread-count={r.unreadCount}>
              {unreadBadge(r.unreadCount)}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

export function ConversationRows({ rows, state, showPage }: { rows: InboxRow[]; state: InboxFilterState; showPage: boolean }) {
  // Hội thoại đang mở theo URL — bấm hàng đổi `?c=` tại chỗ (thread-pane.tsx), danh sách không dựng lại nên đọc thẳng URL.
  const activeId = useSelectedConversation();
  // Bản danh sách ĐÃ HIỆN lần trước — để giữ hội thoại đang mở đứng yên (xem chú thích đầu tệp). Mở hội thoại = đã đọc: hàng đang
  // mở thôi in đậm / số chưa đọc ngay, không đợi lượt làm mới.
  const shown = useRef<InboxRow[] | null>(null);
  const display = keepActiveInPlace(rows, shown.current, activeId).map((r) => (r.id === activeId && r.unread ? { ...r, unread: false, unreadCount: 0 } : r));
  useEffect(() => {
    shown.current = display;
  });
  // Giờ «x phút» tính theo đồng hồ trình duyệt, cập nhật mỗi phút (trang tự làm mới 5 giây đã đọc lại dữ liệu).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // Hội thoại đang mở luôn trong tầm nhìn (mở bằng link trực tiếp, hoặc danh sách vừa đổi).
  const anchor = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!activeId) return;
    const el = anchor.current?.parentElement?.querySelector<HTMLElement>(`[data-conversation="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  return (
    <>
      <li ref={anchor} hidden aria-hidden />
      {display.map((r) => (
        <li key={r.id}>
          <Row r={r} href={inboxHref(state, { c: r.id })} active={r.id === activeId} showPage={showPage} nowMs={nowMs} />
        </li>
      ))}
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Hourglass, Sparkles, UserRound } from "lucide-react";
import { AI_HOLD_LABEL } from "@/lib/sales-chatbot/ai-hold-shared";
import { avatarHrefOf, compactTimeAgo, HUMAN_HANDLING_LABEL, INBOX_HANDLING_LABEL, INBOX_SOURCE_LABEL, inboxHref, inboxRowStatus, unreadBadge, type InboxFilterState, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";
import { inboxDisplayRows } from "@/lib/sales-chatbot/inbox-read-shared";
import { CUSTOMER_LEVEL_LABEL } from "@/lib/sales-chatbot/levels-shared";
import { cn } from "@/lib/utils";
import { AvatarLinkWrap, ChannelAvatar } from "./avatar";
import { useInboxReads } from "./read-store";
import { openConversationInPlace, useSelectedConversation } from "./thread-pane";

/**
 * ═══════════ DANH SÁCH HỘI THOẠI (INBOX-V2-A) — MỘT HÀNG HAI DÒNG ═══════════
 *
 * Mỗi hàng: ảnh · tên · MỘT trạng thái đơn / cần người · giờ — rồi MỘT dấu AI / người · một dòng xem trước · số chưa đọc. Trước
 * đây mỗi hàng mang 3–4 huy hiệu xuống dòng (AI · Chưa chốt · Pancake · page · level · SĐT · người nhận · nhãn) và cao 87–116 px;
 * nay ≈ 56 px. Thông tin phụ KHÔNG mất: rê chuột lên hàng thấy page · nguồn · level · SĐT · người nhận · nhãn (title), và mọi thứ
 * đó vẫn LỌC được ở «Lọc ▾». Chấm màu cạnh tên = nhãn (tên nhãn ở title).
 *
 * THỨ TỰ do máy chủ quyết (`inboxOrderBy`: chưa đọc trước, mới nhất trước). Trang vá đúng hai thứ (`inboxDisplayRows`,
 * inbox-read-shared.ts): hội thoại ĐANG MỞ đứng yên tại chỗ người vừa bấm và hiện đã đọc ngay; và XÁC NHẬN ĐỌC của máy chủ thắng mọi bản
 * danh sách dựng trước lượt đọc — rời A ở thẻ «Tin khách chưa đọc» ⇒ A rời danh sách NGAY (trừ khi có tin khách mới hơn lượt đọc), ở
 * thẻ khác A về nhóm đã đọc đúng chỗ. Bản danh sách mới hơn lượt đọc thì máy chủ thắng.
 *
 * XEM TRƯỚC (P0.2): hội thoại chưa đọc in TIN KHÁCH chưa đọc mới nhất (không tiền tố) + dòng phụ «AI đã trả lời …» nếu sau nó đã có
 * câu trả lời — không bao giờ in tin AI cạnh huy hiệu chưa đọc.
 *
 * ẢNH ĐẠI DIỆN (P1 avatar): hàng KHÔNG còn là một thẻ `<a>` bọc tất cả. Hàng là một khung `relative`; một `Link` phủ kín (lớp dưới) mở
 * hội thoại; nội dung nằm trên và để chuột đi xuyên (`pointer-events-none`); RIÊNG ảnh đại diện nhận chuột (`pointer-events-auto`
 * · `z-10`) và là link ANH EM của link hàng (`avatarHrefOf`: trang Facebook thật ⇒ tab mới; không có ⇒ hồ sơ khách nội bộ; chưa nối
 * hồ sơ ⇒ ảnh trơn, bấm vào là mở hội thoại). Không bao giờ `<a>` trong `<a>`.
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
  // Huy hiệu do máy chủ phân loại (`classifyInboxState` — cùng tệp với điều kiện thẻ lọc), trang chỉ vẽ.
  const label = `${r.humanHandling ? HUMAN_HANDLING_LABEL[r.humanHandling] : INBOX_HANDLING_LABEL[r.handling]} — ${AI_HOLD_LABEL[r.aiHold]}`;
  const cls = "size-3.5 shrink-0";
  return (
    <span title={label} aria-label={label} data-handler={r.handling === "AI" ? "AI" : r.handling === "WAITING" ? "WAITING" : "HUMAN"} data-handling={r.handling} data-human-handling={r.humanHandling ?? undefined} className="inline-flex">
      {r.handling === "AI" ? (
        <Bot className={cn(cls, "text-violet-600 dark:text-violet-400")} />
      ) : r.handling === "COPILOT" ? (
        <Sparkles className={cn(cls, "text-amber-600 dark:text-amber-400")} />
      ) : r.handling === "WAITING" ? (
        <Hourglass className={cn(cls, "text-rose-600 dark:text-rose-400")} />
      ) : (
        <UserRound className={cn(cls, "text-orange-600 dark:text-orange-400")} />
      )}
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

const AFTER_LABEL: Record<string, string> = { BOT: "AI đã trả lời", STAFF: "Bạn đã trả lời", PAGE: "Page đã trả lời" };

function Row({ r, href, active, showPage, nowMs }: { r: InboxRow; href: string; active: boolean; showPage: boolean; nowMs: number }) {
  const wait = waitMinutes(r.waitingSince, nowMs);
  const status = inboxRowStatus(r);
  const avatarLink = avatarHrefOf(r.customerId);
  return (
    <div
      className={cn(
        "relative flex items-center gap-2.5 border-l-[3px] px-2.5 py-2 transition-colors",
        active ? "border-l-primary bg-card shadow-[var(--shadow-card)]" : r.unread ? "border-l-primary/60 hover:bg-card/70" : "border-l-transparent hover:bg-card/70",
      )}
      title={metaOf(r, showPage)}
      data-conversation={r.id}
      data-unread={r.unread ? "1" : "0"}
      data-preview-side={r.previewSide ?? undefined}
      data-closed={r.closed ? "1" : "0"}
      data-source={r.source}
      data-page={r.pageId ?? undefined}
    >
      {/* Lớp dưới: cả hàng là MỘT link mở hội thoại. Nội dung phía trên để chuột đi xuyên xuống link này. */}
      <Link
        href={href}
        prefetch={false}
        onClick={(e) => openConversationInPlace(e, href)}
        aria-current={active ? "true" : undefined}
        aria-label={`Mở hội thoại với ${r.customerName}${r.unread ? ` — ${r.unreadCount} tin khách chưa đọc` : ""}`}
        className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        data-row-link
      />
      {/* Ảnh đại diện: link ANH EM của link hàng, nhận chuột riêng (không lồng trong link hàng); không có đích ⇒ chuột đi xuyên, mở hội thoại. */}
      <span className={cn("relative z-10 inline-flex shrink-0", avatarLink.href ? "pointer-events-auto" : "pointer-events-none")} data-avatar-slot>
        <AvatarLinkWrap link={avatarLink} name={r.customerName}>
          <ChannelAvatar name={r.customerName} channel={r.channel} src={r.avatarUrl} />
        </AvatarLinkWrap>
      </span>
      <div className="pointer-events-none relative min-w-0 flex-1">
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
            <span className={cn("shrink-0 rounded px-1.5 text-[11px] font-medium leading-[18px]", STATUS_CLASS[status.kind])} data-status={status.kind} data-needs-human={r.needsHuman ?? undefined} title={status.hint}>
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
          <p className={cn("min-w-0 flex-1 truncate text-[13px] leading-[18px]", r.unread ? "font-medium text-foreground" : "text-muted-foreground")} data-preview>
            {r.previewSide ? SIDE_PREFIX[r.previewSide] : ""}
            {r.preview || "—"}
          </p>
          {r.unreadCount > 0 ? (
            <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground" aria-label={`${r.unreadCount} tin khách chưa đọc`} data-unread-count={r.unreadCount}>
              {unreadBadge(r.unreadCount)}
            </span>
          ) : null}
        </div>
        {r.unread && r.afterPreview ? (
          // Dòng phụ: tin khách chưa đọc đã được trả lời (AI · bạn · page) — để nhân viên biết khách không bị bỏ im.
          <p className="mt-0.5 truncate pl-5 text-[11px] leading-[14px] text-muted-foreground" data-after-preview={r.afterPreview.side} suppressHydrationWarning>
            {AFTER_LABEL[r.afterPreview.side]} · {compactTimeAgo(r.afterPreview.at, nowMs)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ConversationRows({ rows, state, showPage }: { rows: InboxRow[]; state: InboxFilterState; showPage: boolean }) {
  // Hội thoại đang mở theo URL — bấm hàng đổi `?c=` tại chỗ (thread-pane.tsx), danh sách không dựng lại nên đọc thẳng URL.
  const activeId = useSelectedConversation();
  // Bản danh sách ĐÃ HIỆN lần trước — để giữ hội thoại đang mở đứng yên (xem chú thích đầu tệp). Mở hội thoại = đã đọc: hàng đang
  // mở thôi in đậm / số chưa đọc ngay, không đợi lượt làm mới.
  const shown = useRef<InboxRow[] | null>(null);
  // Xác nhận đọc của máy chủ (khung chat ghi vào read-store) thắng mọi bản danh sách dựng TRƯỚC lượt đọc.
  const reads = useInboxReads();
  const display = inboxDisplayRows(rows, shown.current, { activeId, filter: state.filter, reads });
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

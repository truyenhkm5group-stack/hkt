"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  compactCount,
  INBOX_CHANNEL_LABEL,
  INBOX_CHANNELS,
  INBOX_FILTER_HINT,
  INBOX_FILTER_LABEL,
  INBOX_HANDLER_LABEL,
  INBOX_HREF,
  INBOX_MORE_FILTERS,
  INBOX_PERIOD_LABEL,
  INBOX_PERIODS,
  INBOX_QUICK_FILTERS,
  inboxAdvancedCount,
  inboxHref,
  type InboxFilter,
  type InboxFilterState,
  type InboxLabel,
} from "@/lib/sales-chatbot/inbox-shared";
import { patchUnreadCount } from "@/lib/sales-chatbot/inbox-read-shared";
import {
  INBOX_SEARCH_DEBOUNCE_MS,
  inboxActiveChip,
  inboxChipHref,
  inboxFilterLabels,
  inboxHasFilters,
  inboxScopeHref,
  inboxSearchHref,
  inboxSearchMode,
  normalizeInboxQuery,
  shouldLiveSearch,
} from "@/lib/sales-chatbot/inbox-search-shared";
import { CUSTOMER_LEVEL_LABEL, type CustomerLevel } from "@/lib/sales-chatbot/levels-shared";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useInboxReads } from "./read-store";
import { useSelectedConversation } from "./thread-pane";

/**
 * ═══════════ BỘ LỌC GỌN CỦA HỘP THƯ (INBOX-V2-A, chủ shop 09/10/2026) ═══════════
 *
 * Trước: 11 thẻ trạng thái xếp 4 dòng + hàng «Có SĐT» / thời gian + hàng level + ô tìm + hai khối gập — đo HSLC 1366×768: hàng
 * hội thoại đầu tiên ở y = 502, chỉ thấy 3 hội thoại. Nay: MỘT hàng [Tìm] [Lọc ▾] [công cụ] + MỘT hàng ≤ 5 thẻ việc-cần-làm
 * (`INBOX_QUICK_FILTERS`). Mọi bộ lọc khác nằm trong «Lọc ▾» — không bộ lọc nào mất (`INBOX_URL_PARAMS` là bản khai, bài kiểm so).
 * URL vẫn là tham số cũ (`f · pg · ch · xl · nv · sdt · lv · tg · tu · den · lb · q`), nên link cũ, nút quay lại, tab mới đều đúng.
 * Áp bộ lọc = điều hướng tới URL mới (máy chủ lọc + đếm); ô trống không vào URL.
 *
 * Ô TÌM (P0 inbox-search-global, chủ shop 12/10/2026): tìm TOÀN hộp thư mặc định — gõ là tìm (debounce `INBOX_SEARCH_DEBOUNCE_MS`),
 * Enter / nút «Tìm» tìm ngay, biểu tượng quay khi đang tìm. Thẻ / bộ lọc đang chọn KHÔNG ngầm thu hẹp lần tìm: chúng nằm nguyên trong
 * URL (xoá ô tìm là về đúng bộ lọc cũ) và một dòng nói rõ «Đang tìm trong toàn hộp thư · tạm bỏ qua …» kèm lựa chọn «Chỉ tìm trong
 * bộ lọc hiện tại» (`pv=loc`). Luật áp bộ lọc ở MỘT chỗ: `inboxQueryState` (inbox-search-shared.ts).
 */

type Props = {
  state: InboxFilterState;
  counts: Record<InboxFilter, number>;
  /** Dấu con trỏ đọc mới nhất của người xem trong CÙNG câu đếm (`listInbox().unreadStamp`) — để vá số «Tin khách chưa đọc» ngay khi đọc. */
  unreadStamp?: string | null;
  phoneCount: number;
  levelCounts: Partial<Record<CustomerLevel, number>>;
  levels: readonly CustomerLevel[];
  pages: { id: string; name: string }[];
  labels: InboxLabel[];
  users: { id: string; name: string }[];
  /** Số hội thoại khớp danh sách đang hiện (`listInbox().total`) — in cạnh dòng phạm vi tìm. */
  total?: number;
  /** Nút âm báo + lối tới cấu hình — đứng cuối hàng tìm. */
  tools?: ReactNode;
  /** Phần quản lý (đường nhận tin & AI nhường) — chỉ người quản lý; nằm cuối bảng «Lọc». */
  manage?: ReactNode;
  /** «Trả tất cả cho AI» — một dòng dưới hàng thẻ, chỉ khi có quyền và có hội thoại đang do người xử lý (máy chủ quyết). */
  bulk?: ReactNode;
};

const SELECT = "h-9 w-full min-w-0 rounded-md border border-foreground/15 bg-card px-2 text-[13px]";
const FIELD = "space-y-1 text-[12px] font-medium text-muted-foreground";

export function InboxFilters({ state, counts: serverCounts, unreadStamp = null, phoneCount, levelCounts, levels, pages, labels, users, total, tools, manage, bulk }: Props) {
  const router = useRouter();
  // Hội thoại đang mở theo URL SỐNG (bấm hàng đổi `?c=` bằng pushState, chưa dựng lại trang) — không phải `state.selected` của lượt
  // dựng trước: tìm ngay sau khi bấm sang hội thoại B từng đưa người dùng về hội thoại A cũ.
  const liveSelected = useSelectedConversation();
  // Số «Tin khách chưa đọc» trừ ngay các hội thoại vừa đọc mà bản đếm của máy chủ chưa thấy (inbox-read-shared.ts) — không đợi làm mới.
  const reads = useInboxReads();
  const counts: Record<InboxFilter, number> = { ...serverCounts, UNREAD: patchUnreadCount(serverCounts.UNREAD, unreadStamp, reads.values()) };
  const [open, setOpen] = useState(false);
  const advanced = inboxAdvancedCount(state);
  const quickActive = (INBOX_QUICK_FILTERS as readonly InboxFilter[]).includes(state.filter);
  // Bỏ mọi bộ lọc nâng cao, GIỮ ô tìm + thẻ nhanh đang chọn + hội thoại đang mở.
  const clearAdvanced = inboxHref(state, { f: quickActive ? state.filter : null, pg: null, ch: null, xl: null, nv: null, sdt: null, lv: null, tg: null, tu: null, den: null, lb: null, n: null });

  /** Gửi form ⇒ URL chỉ mang ô CÓ giá trị (form GET thô để lại `?ch=&lb=`). Đổi bộ lọc ⇒ về đầu danh sách, giữ hội thoại đang mở. */
  const go = (form: HTMLFormElement) => {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === "string" && v.trim()) p.set(k, v.trim());
    if (liveSelected) p.set("c", liveSelected);
    const s = p.toString();
    setOpen(false);
    router.push(`${INBOX_HREF}${s ? `?${s}` : ""}`);
  };

  // ═══ Ô TÌM: gõ là tìm (debounce), Enter / nút «Tìm» tìm ngay, trạng thái đang tải ═══
  const mode = inboxSearchMode(state);
  const hasFilters = inboxHasFilters(state);
  const filterLabels = inboxFilterLabels(state, Object.fromEntries(pages.map((p) => [p.id, p.name])));
  const activeChip = inboxActiveChip(state);
  const [navPending, startNav] = useTransition();
  const [text, setText] = useState(state.q);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);
  // URL đổi từ NGOÀI ô tìm (Back / Forward, link xoá ô tìm, thẻ) trong lúc người dùng không gõ ⇒ ô nhập theo URL. Đang gõ thì không
  // ghi đè: lượt dựng của một chuỗi cũ hơn tới sau không được kéo lùi chữ người đang gõ.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setText(state.q);
  }, [state.q]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const search = (value: string, how: "push" | "replace") => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const href = inboxSearchHref(state, value, liveSelected);
    startNav(() => (how === "push" ? router.push(href) : router.replace(href)));
  };
  const onType = (value: string) => {
    setText(value);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (!shouldLiveSearch(value)) return;
    // Bắt đầu tìm từ danh sách thường ⇒ một mục lịch sử mới (Back về đúng bộ lọc cũ); đang tìm mà gõ tiếp ⇒ thay mục hiện tại.
    const how = normalizeInboxQuery(state.q) ? "replace" : "push";
    timer.current = window.setTimeout(() => search(value, how), INBOX_SEARCH_DEBOUNCE_MS);
  };
  // Đang tải: đang điều hướng, hoặc chữ đã gõ khác lần tìm máy chủ đã trả (đợi debounce).
  const queued = shouldLiveSearch(text) && normalizeInboxQuery(text) !== normalizeInboxQuery(state.q);
  const busy = navPending || queued;

  /** Ô ẩn giữ các bộ lọc KHÁC khi gửi một form (ô tìm giữ bộ lọc nâng cao và ngược lại). */
  const keep = (omit: readonly string[]) => {
    const all: [string, string | null][] = [
      ["f", state.filter === "ALL" ? null : state.filter],
      ["q", state.q || null],
      ["pg", state.page],
      ["ch", state.channel],
      ["xl", state.handler === "AI" ? "ai" : state.handler === "HUMAN" ? "nguoi" : null],
      ["nv", state.assignee],
      ["sdt", state.phone === "HAS" ? "co" : state.phone === "NONE" ? "khong" : null],
      ["lv", state.level],
      ["tg", state.period],
      ["tu", state.from],
      ["den", state.to],
      ["lb", state.label],
    ];
    return all.filter(([k, v]) => v && !omit.includes(k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v!} />);
  };

  return (
    <div className="space-y-1.5 border-b border-foreground/10 px-1.5 py-2" data-testid="inbox-filters">
      <div className="flex items-center gap-1.5">
        <form
          role="search"
          className="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            search(text, normalizeInboxQuery(text) === normalizeInboxQuery(state.q) ? "replace" : "push");
          }}
          data-testid="inbox-search"
          data-pending={busy ? "1" : "0"}
          aria-busy={busy}
        >
          {busy ? (
            <Loader2 className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-primary" aria-hidden data-testid="inbox-search-loading" />
          ) : (
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          )}
          <input
            ref={inputRef}
            name="q"
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && text) {
                e.preventDefault();
                setText("");
                search("", "push");
              }
            }}
            placeholder="Tìm tên / SĐT / mã đơn trong toàn hộp thư…"
            maxLength={80}
            enterKeyHint="search"
            autoComplete="off"
            className="h-8 w-full rounded-md border border-foreground/15 bg-card pl-7 pr-14 text-[13px] outline-none focus:ring-2 focus:ring-primary/30"
            aria-label="Tìm khách trong toàn hộp thư"
          />
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {text ? (
              <button
                type="button"
                className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Xoá ô tìm — về bộ lọc trước đó"
                title="Xoá ô tìm — về bộ lọc trước đó"
                onClick={() => {
                  setText("");
                  search("", "push");
                  inputRef.current?.focus();
                }}
                data-testid="inbox-search-clear"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
            <button type="submit" className="inline-flex size-6 items-center justify-center rounded bg-primary/10 text-primary hover:bg-primary/20" aria-label="Tìm" title="Tìm (Enter)" data-testid="inbox-search-submit">
              <Search className="size-3.5" />
            </button>
          </div>
        </form>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn("inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-[12.5px] font-medium", advanced ? "border-primary/60 bg-primary/10 text-primary" : "border-foreground/15 bg-card hover:bg-muted")}
              aria-label={advanced ? `Lọc nâng cao — đang bật ${advanced} bộ lọc` : "Lọc nâng cao"}
              data-testid="inbox-filter-open"
              data-advanced-count={advanced}
            >
              <SlidersHorizontal className="size-3.5" />
              {advanced ? `Lọc (${advanced})` : "Lọc"}
              <ChevronDown className="size-3 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6} collisionPadding={12} className="max-h-(--radix-popover-content-available-height) w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto p-3" data-testid="inbox-filter-panel">
            <form
              className="space-y-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                go(e.currentTarget);
              }}
            >
              {keep(["f", "pg", "ch", "xl", "nv", "sdt", "lv", "tg", "tu", "den", "lb"])}
              {/* Áp bộ lọc trong lúc đang tìm = người dùng CHỌN tìm trong bộ lọc đó (không còn là bộ lọc ngầm). */}
              {normalizeInboxQuery(state.q) ? <input type="hidden" name="pv" value="loc" /> : null}
              {mode === "GLOBAL" && hasFilters ? (
                <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[12px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid="inbox-filter-paused">
                  Đang tìm trong toàn hộp thư nên các bộ lọc dưới đây tạm chưa áp. Bấm «Áp dụng» để chỉ tìm trong bộ lọc.
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <label className={cn(FIELD, "col-span-2")}>
                  <span>Trạng thái</span>
                  {/* Thẻ nhanh đang chọn là lựa chọn «mặc định» của ô này — chọn trạng thái khác thay thế nó (một thẻ một lúc, như cũ). */}
                  <select name="f" defaultValue={state.filter === "ALL" ? "" : state.filter} className={SELECT} aria-label="Trạng thái hội thoại">
                    <option value="">{`Tất cả (${counts.ALL})`}</option>
                    {quickActive ? (
                      <option value={state.filter} title={INBOX_FILTER_HINT[state.filter]}>{`${INBOX_FILTER_LABEL[state.filter]} (${counts[state.filter]})`}</option>
                    ) : null}
                    {INBOX_MORE_FILTERS.map((f) => (
                      <option key={f} value={f} title={INBOX_FILTER_HINT[f]}>{`${INBOX_FILTER_LABEL[f]} (${counts[f]})`}</option>
                    ))}
                  </select>
                </label>
                {pages.length > 1 ? (
                  <label className={cn(FIELD, "col-span-2")}>
                    <span>Page</span>
                    <select name="pg" defaultValue={state.page ?? ""} className={SELECT} aria-label="Page" data-testid="inbox-page-select">
                      <option value="">Mọi page</option>
                      {pages.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className={FIELD}>
                  <span>Kênh</span>
                  <select name="ch" defaultValue={state.channel ?? ""} className={SELECT} aria-label="Kênh">
                    <option value="">Mọi kênh</option>
                    {INBOX_CHANNELS.map((c) => (
                      <option key={c} value={c}>
                        {INBOX_CHANNEL_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={FIELD}>
                  <span>AI / Người</span>
                  <select name="xl" defaultValue={state.handler === "AI" ? "ai" : state.handler === "HUMAN" ? "nguoi" : ""} className={SELECT} aria-label="AI hay người đang xử lý">
                    <option value="">AI hoặc người</option>
                    <option value="ai" title={INBOX_FILTER_HINT.AI}>{INBOX_HANDLER_LABEL.AI}</option>
                    <option value="nguoi" title={INBOX_FILTER_HINT.HUMAN}>{INBOX_HANDLER_LABEL.HUMAN}</option>
                  </select>
                </label>
                <label className={FIELD}>
                  <span>Nhân viên</span>
                  <select name="nv" defaultValue={state.assignee ?? ""} className={SELECT} aria-label="Nhân viên phụ trách">
                    <option value="">Mọi nhân viên</option>
                    <option value="none">Chưa ai nhận</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={FIELD}>
                  <span>Số điện thoại</span>
                  <select name="sdt" defaultValue={state.phone === "HAS" ? "co" : state.phone === "NONE" ? "khong" : ""} className={SELECT} aria-label="Số điện thoại">
                    <option value="">Có / chưa SĐT</option>
                    <option value="co">{`Có SĐT (${phoneCount})`}</option>
                    <option value="khong">Chưa có SĐT</option>
                  </select>
                </label>
                {levels.length ? (
                  <label className={cn(FIELD, "col-span-2")}>
                    <span>Level khách</span>
                    <select name="lv" defaultValue={state.level ?? ""} className={SELECT} aria-label="Level khách">
                      <option value="">Mọi level</option>
                      {levels.map((l) => (
                        <option key={l} value={l}>{`${CUSTOMER_LEVEL_LABEL[l]} (${levelCounts[l] ?? 0})`}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className={cn(FIELD, "col-span-2")}>
                  <span>Tin cuối</span>
                  <select name="tg" defaultValue={state.period ?? ""} className={SELECT} aria-label="Thời gian tin cuối">
                    <option value="">Mọi thời gian</option>
                    {INBOX_PERIODS.map((t) => (
                      <option key={t} value={t}>
                        {INBOX_PERIOD_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={FIELD}>
                  <span>Từ ngày</span>
                  <input type="date" name="tu" defaultValue={state.from ?? ""} className={SELECT} aria-label="Từ ngày (chọn «Khoảng ngày»)" />
                </label>
                <label className={FIELD}>
                  <span>Đến ngày</span>
                  <input type="date" name="den" defaultValue={state.to ?? ""} className={SELECT} aria-label="Đến ngày" />
                </label>
                {labels.length ? (
                  <label className={cn(FIELD, "col-span-2")}>
                    <span>Nhãn</span>
                    <select name="lb" defaultValue={state.label ?? ""} className={SELECT} aria-label="Thẻ / nhãn">
                      <option value="">Mọi nhãn</option>
                      {labels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-2 pt-1">
                {advanced ? (
                  <Link href={clearAdvanced} className="text-[13px] font-medium text-primary hover:underline" onClick={() => setOpen(false)} data-testid="inbox-filter-clear">
                    Xóa bộ lọc
                  </Link>
                ) : (
                  <span />
                )}
                <button type="submit" className="h-9 rounded-md bg-foreground px-4 text-[13px] font-medium text-background hover:opacity-90">
                  Áp dụng
                </button>
              </div>
            </form>
            {manage ? <div className="mt-3 border-t border-foreground/10 pt-3">{manage}</div> : null}
          </PopoverContent>
        </Popover>
        {tools}
      </div>
      {mode !== "NONE" ? (
        // Phạm vi của lần tìm — nói RÕ đang tìm ở đâu, và lối chuyển phạm vi (chủ shop 12/10/2026).
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md bg-primary/5 px-2 py-1 text-[12px] leading-[18px]" data-testid="inbox-search-scope" data-mode={mode} role="status">
          <span className="font-medium text-foreground">{mode === "GLOBAL" ? "Đang tìm trong toàn hộp thư" : `Đang tìm trong bộ lọc: ${filterLabels.join(" · ")}`}</span>
          <span className="tabular-nums text-muted-foreground" data-testid="inbox-search-count">
            {busy ? "· đang tìm…" : total !== undefined ? `· ${formatNumber(total)} kết quả` : null}
          </span>
          {mode === "GLOBAL" && hasFilters ? (
            <>
              <span className="min-w-0 text-muted-foreground">· tạm bỏ qua «{filterLabels.join(" · ")}»</span>
              <Link href={inboxScopeHref(state, "FILTER", liveSelected)} className="font-medium text-primary hover:underline" data-testid="inbox-search-scope-filter">
                Chỉ tìm trong bộ lọc hiện tại
              </Link>
            </>
          ) : null}
          {mode === "FILTERED" ? (
            <Link href={inboxScopeHref(state, "GLOBAL", liveSelected)} className="font-medium text-primary hover:underline" data-testid="inbox-search-scope-global">
              Tìm toàn hộp thư
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" data-testid="inbox-quick-filters" data-quick-row>
        {INBOX_QUICK_FILTERS.map((f) => {
          // Đang tìm toàn hộp thư ⇒ không thẻ nào bật (thẻ trong URL tạm không áp); số trên thẻ là số KẾT QUẢ TÌM thuộc thẻ đó.
          const on = f === activeChip;
          const hot = !on && (f === "UNREAD" || f === "UNANSWERED" || f === "NEEDS_HUMAN") && counts[f] > 0;
          return (
            <Link
              key={f}
              // Bấm lại thẻ đang bật ⇒ về «Tất cả». Đang tìm toàn hộp thư ⇒ bấm thẻ = chọn tìm trong thẻ đó (`inboxChipHref`).
              href={inboxChipHref(state, f)}
              className={cn("inline-flex h-7 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border px-[5px] text-[12px]", on ? "border-foreground bg-foreground font-medium text-background" : "border-foreground/15 bg-card hover:bg-muted", hot && "text-foreground")}
              aria-current={on ? "true" : undefined}
              title={mode === "GLOBAL" ? `${INBOX_FILTER_LABEL[f]}: ${formatNumber(counts[f])} kết quả tìm — bấm để chỉ tìm trong thẻ này` : `${INBOX_FILTER_LABEL[f]}: ${formatNumber(counts[f])} hội thoại — ${INBOX_FILTER_HINT[f]}`}
              data-filter={f}
            >
              {INBOX_FILTER_LABEL[f]}
              {/* Số gọn («2,1k») để bốn thẻ vừa cột 360 px ở 1366×768 với số cỡ HSLC (2,1k · 219); số đủ ở chú thích. */}
              <span className={cn("text-[11.5px] tabular-nums", on ? "opacity-80" : hot ? "font-semibold text-primary" : "text-muted-foreground")} data-count={counts[f]}>
                {compactCount(counts[f])}
              </span>
            </Link>
          );
        })}
        {advanced ? (
          <Link href={clearAdvanced} className="inline-flex h-7 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-2 text-[12px] text-muted-foreground hover:text-foreground" aria-label="Xóa bộ lọc nâng cao" title="Xóa bộ lọc nâng cao">
            <X className="size-3.5" /> Xóa lọc
          </Link>
        ) : null}
      </div>
      {bulk}
    </div>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  compactCount,
  INBOX_CHANNEL_LABEL,
  INBOX_CHANNELS,
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
import { CUSTOMER_LEVEL_LABEL, type CustomerLevel } from "@/lib/sales-chatbot/levels-shared";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BỘ LỌC GỌN CỦA HỘP THƯ (INBOX-V2-A, chủ shop 09/10/2026) ═══════════
 *
 * Trước: 11 thẻ trạng thái xếp 4 dòng + hàng «Có SĐT» / thời gian + hàng level + ô tìm + hai khối gập — đo HSLC 1366×768: hàng
 * hội thoại đầu tiên ở y = 502, chỉ thấy 3 hội thoại. Nay: MỘT hàng [Tìm] [Lọc ▾] [công cụ] + MỘT hàng ≤ 5 thẻ việc-cần-làm
 * (`INBOX_QUICK_FILTERS`). Mọi bộ lọc khác nằm trong «Lọc ▾» — không bộ lọc nào mất (`INBOX_URL_PARAMS` là bản khai, bài kiểm so).
 * URL vẫn là tham số cũ (`f · pg · ch · xl · nv · sdt · lv · tg · tu · den · lb · q`), nên link cũ, nút quay lại, tab mới đều đúng.
 * Áp bộ lọc = điều hướng tới URL mới (máy chủ lọc + đếm); ô trống không vào URL.
 */

type Props = {
  state: InboxFilterState;
  counts: Record<InboxFilter, number>;
  phoneCount: number;
  levelCounts: Partial<Record<CustomerLevel, number>>;
  levels: readonly CustomerLevel[];
  pages: { id: string; name: string }[];
  labels: InboxLabel[];
  users: { id: string; name: string }[];
  /** Nút âm báo + lối tới cấu hình — đứng cuối hàng tìm. */
  tools?: ReactNode;
  /** Phần quản lý (đường nhận tin & AI nhường) — chỉ người quản lý; nằm cuối bảng «Lọc». */
  manage?: ReactNode;
};

const SELECT = "h-9 w-full min-w-0 rounded-md border border-foreground/15 bg-card px-2 text-[13px]";
const FIELD = "space-y-1 text-[12px] font-medium text-muted-foreground";

export function InboxFilters({ state, counts, phoneCount, levelCounts, levels, pages, labels, users, tools, manage }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const advanced = inboxAdvancedCount(state);
  const quickActive = (INBOX_QUICK_FILTERS as readonly InboxFilter[]).includes(state.filter);
  // Bỏ mọi bộ lọc nâng cao, GIỮ ô tìm + thẻ nhanh đang chọn + hội thoại đang mở.
  const clearAdvanced = inboxHref(state, { f: quickActive ? state.filter : null, pg: null, ch: null, xl: null, nv: null, sdt: null, lv: null, tg: null, tu: null, den: null, lb: null, n: null });

  /** Gửi form ⇒ URL chỉ mang ô CÓ giá trị (form GET thô để lại `?ch=&lb=`). Đổi bộ lọc ⇒ về đầu danh sách, giữ hội thoại đang mở. */
  const go = (form: HTMLFormElement) => {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === "string" && v.trim()) p.set(k, v.trim());
    if (state.selected) p.set("c", state.selected);
    const s = p.toString();
    setOpen(false);
    router.push(`${INBOX_HREF}${s ? `?${s}` : ""}`);
  };

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
            go(e.currentTarget);
          }}
        >
          {keep(["q"])}
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input name="q" defaultValue={state.q} key={state.q} placeholder={`Tìm tên / SĐT trong ${counts.ALL} hội thoại…`} maxLength={80} className="h-8 w-full rounded-md border border-foreground/15 bg-card pl-7 pr-2 text-[13px] outline-none focus:ring-2 focus:ring-primary/30" aria-label="Tìm khách" />
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
              <div className="grid grid-cols-2 gap-2">
                <label className={cn(FIELD, "col-span-2")}>
                  <span>Trạng thái</span>
                  {/* Thẻ nhanh đang chọn là lựa chọn «mặc định» của ô này — chọn trạng thái khác thay thế nó (một thẻ một lúc, như cũ). */}
                  <select name="f" defaultValue={state.filter === "ALL" ? "" : state.filter} className={SELECT} aria-label="Trạng thái hội thoại">
                    <option value="">{`Tất cả (${counts.ALL})`}</option>
                    {quickActive ? <option value={state.filter}>{`${INBOX_FILTER_LABEL[state.filter]} (${counts[state.filter]})`}</option> : null}
                    {INBOX_MORE_FILTERS.map((f) => (
                      <option key={f} value={f}>{`${INBOX_FILTER_LABEL[f]} (${counts[f]})`}</option>
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
                    <option value="ai">{INBOX_HANDLER_LABEL.AI}</option>
                    <option value="nguoi">{INBOX_HANDLER_LABEL.HUMAN}</option>
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
      <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" data-testid="inbox-quick-filters" data-quick-row>
        {INBOX_QUICK_FILTERS.map((f) => {
          const on = f === state.filter;
          const hot = !on && (f === "UNREAD" || f === "UNANSWERED" || f === "NEEDS_HUMAN") && counts[f] > 0;
          return (
            <Link
              key={f}
              // Bấm lại thẻ đang bật ⇒ về «Tất cả».
              href={inboxHref(state, { f: on ? null : f, c: null, n: null })}
              className={cn("inline-flex h-7 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border px-[5px] text-[12px]", on ? "border-foreground bg-foreground font-medium text-background" : "border-foreground/15 bg-card hover:bg-muted", hot && "text-foreground")}
              aria-current={on ? "true" : undefined}
              title={`${INBOX_FILTER_LABEL[f]}: ${formatNumber(counts[f])} hội thoại`}
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
    </div>
  );
}

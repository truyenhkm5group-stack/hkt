import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { formatTimeAgo, formatVND } from "@/lib/format";
import { assignableUsers, inboxAssignees, inboxPages, listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { customerFacing, customerInboxThread } from "@/lib/saas/visibility";
import { listLabels } from "@/lib/sales-chatbot/inbox-labels";
import { INBOX_CHANNEL_LABEL, INBOX_CHANNELS, INBOX_FILTER_LABEL, INBOX_FILTERS, INBOX_LIST_MAX, INBOX_PERIOD_LABEL, INBOX_PERIODS, INBOX_SOURCE_LABEL, unreadBadge, type InboxChannel, type InboxFilter, type InboxHandler, type InboxPeriod, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";
import { AI_HOLD_LABEL } from "@/lib/sales-chatbot/ai-hold-shared";
import { listPageRoutes } from "@/lib/sales-chatbot/channel-ownership";
import { humanCooldownMinutes } from "@/lib/sales-chatbot/conversation-control";
import { organizationLevelPack } from "@/lib/sales-chatbot/levels";
import { CUSTOMER_LEVEL_CLASS, CUSTOMER_LEVEL_LABEL, CUSTOMER_LEVELS, levelsForPack, type CustomerLevel } from "@/lib/sales-chatbot/levels-shared";
import { cn } from "@/lib/utils";
import { InboxAutoRefresh } from "./auto-refresh";
import { ChannelAvatar } from "./avatar";
import { LabelChip } from "./labels-panel";
import { PageRoutesPanel } from "./page-routes";
import { InboxThreadView } from "./thread-view";

export const metadata = { title: "Hộp thư khách" };

const SIDE_PREFIX: Record<string, string> = { CUSTOMER: "", BOT: "Bot: ", STAFF: "NV: ", PAGE: "Page: " };
/** Khách chờ quá chừng này phút ⇒ chip đỏ (dưới đó chip vàng). Chỉ là MÀU nhắc việc, không phải chỉ số chấm người. */
const WAIT_URGENT_MIN = 15;

function waitMinutes(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null;
}

function waitLabel(min: number): string {
  if (min < 1) return "vừa nhắn";
  if (min < 60) return `chờ ${min} phút`;
  if (min < 24 * 60) return `chờ ${Math.round(min / 60)} giờ`;
  return `chờ ${Math.round(min / 1440)} ngày`;
}

function ListItem({ r, href, active, showPage }: { r: InboxRow; href: string; active: boolean; showPage: boolean }) {
  const wait = waitMinutes(r.waitingSince);
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn("flex gap-3 border-l-[3px] px-3 py-2.5 transition-colors hover:bg-muted", active ? "border-l-primary bg-primary/15 hover:bg-primary/15" : r.unread ? "border-l-primary/70 bg-primary/[0.06]" : "border-l-transparent")}
      data-conversation={r.id}
      data-unread={r.unread ? "1" : "0"}
    >
      <ChannelAvatar name={r.customerName} channel={r.channel} src={r.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-[14px] text-foreground", r.unread ? "font-extrabold" : "font-semibold")}>{r.customerName}</span>
          <span className={cn("shrink-0 text-[11.5px]", r.unread ? "font-bold text-primary" : "text-foreground/60")}>{formatTimeAgo(r.lastActivityAt)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <p className={cn("min-w-0 flex-1 truncate text-[13px]", r.unread ? "font-bold text-foreground" : "text-foreground/65")}>
            {r.previewSide ? SIDE_PREFIX[r.previewSide] : ""}
            {r.preview || "—"}
          </p>
          {r.unreadCount > 0 ? (
            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground" aria-label={`${r.unreadCount} tin chưa đọc`} data-unread-count={r.unreadCount}>
              {unreadBadge(r.unreadCount)}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
          {/* Huy hiệu AI / Người — `aiHoldOf` (một nguồn với thẻ lọc và thanh điều khiển trong luồng tin). */}
          <span className={cn("rounded px-1.5 font-semibold", r.aiHold === "AI_ACTIVE" ? "bg-violet-600 text-white" : "bg-orange-500 text-white")} title={AI_HOLD_LABEL[r.aiHold]} data-handler={r.aiHold === "AI_ACTIVE" ? "AI" : "HUMAN"}>
            {r.aiHold === "AI_ACTIVE" ? "AI" : "Người"}
          </span>
          <span className={cn("rounded px-1.5 font-medium", r.closed ? "bg-green-600 text-white dark:bg-green-500 dark:text-black" : "border border-foreground/20 text-foreground/70")} data-closed={r.closed ? "1" : "0"}>
            {r.closed ? "Đã chốt" : "Chưa chốt"}
          </span>
          {r.source === "PANCAKE" || r.source === "DIRECT" ? (
            <span className="rounded border border-foreground/20 px-1.5 text-foreground/70" data-source={r.source}>
              {INBOX_SOURCE_LABEL[r.source]}
            </span>
          ) : null}
          {showPage && r.pageName ? (
            <span className="max-w-[10rem] truncate rounded border px-1.5 text-muted-foreground" data-page-chip>
              {r.pageName}
            </span>
          ) : null}
          {wait !== null ? (
            <span className={cn("rounded px-1.5 font-medium", wait >= WAIT_URGENT_MIN ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200")}>{waitLabel(wait)}</span>
          ) : null}
          {r.level && r.level !== "NEW_MESSAGE" ? <span className={cn("rounded px-1.5 font-medium", CUSTOMER_LEVEL_CLASS[r.level])}>{CUSTOMER_LEVEL_LABEL[r.level]}</span> : null}
          {r.customerPhone ? (
            <span className="rounded bg-emerald-600 px-1.5 font-semibold text-white" title={`Có SĐT ${r.customerPhone}`}>
              SĐT
            </span>
          ) : null}
          {r.status === "HANDOFF" ? <span className="rounded bg-rose-600 px-1.5 font-medium text-white">Cần người</span> : null}
          {r.assigneeName ? <span className="rounded bg-zinc-200 px-1.5 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100">{r.assigneeName}</span> : null}
          {r.hasOrder && !r.closed ? <span className="rounded bg-zinc-200 px-1.5 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100">đơn nháp</span> : null}
          {r.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      </div>
    </Link>
  );
}

/**
 * HỘP THƯ KHÁCH (M8) — mọi tin Facebook / Instagram / Zalo OA / chat web ở MỘT chỗ; nhân viên đọc và trả lời ngay trong ERP.
 * Bố cục ba cột cao bằng màn hình (danh sách · khung chat · thông tin khách), mỗi cột tự cuộn. Không bỏ sót khách: hội thoại có
 * mặt NGAY khi khách nhắn (kể cả bot tắt / nhân viên đã trả lời ngoài ERP / tin nhãn dán · ghi âm), «Chưa đọc» theo lần cuối nhân
 * viên mở, «Chờ trả lời» xếp khách chờ lâu nhất lên đầu, tiêu đề tab đếm khách đang chờ + âm báo khi có tin mới, tự làm mới.
 */
export default async function SalesInboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("ai_sales:view");
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const filter = ((INBOX_FILTERS as readonly string[]).includes(one("f")) ? one("f") : "ALL") as InboxFilter;
  const channel = (INBOX_CHANNELS as readonly string[]).includes(one("ch")) ? (one("ch") as InboxChannel) : null;
  const q = one("q").slice(0, 80);
  const selected = one("c");
  const labels = await listLabels();
  const label = labels.some((l) => l.id === one("lb")) ? one("lb") : null;
  const phone = one("sdt") === "co" ? "HAS" : one("sdt") === "khong" ? "NONE" : null;
  const level = (CUSTOMER_LEVELS as readonly string[]).includes(one("lv")) ? (one("lv") as CustomerLevel) : null;
  const assignee = one("nv") ? one("nv").slice(0, 100) : null;
  const period = (INBOX_PERIODS as readonly string[]).includes(one("tg")) ? (one("tg") as InboxPeriod) : null;
  const day = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(one(k)) ? one(k) : null);
  const from = day("tu");
  const to = day("den");
  const limit = Math.min(INBOX_LIST_MAX, Math.max(100, Number(one("n")) || 100));
  const handler: InboxHandler | null = one("xl") === "ai" ? "AI" : one("xl") === "nguoi" ? "HUMAN" : null;
  // NHIỀU PAGE: một hộp thư chung cho mọi page; chọn một page là LỌC trên cùng hội thoại, không phải một hộp thư thứ hai.
  const pages = await inboxPages();
  const page = pages.some((p) => p.id === one("pg")) ? one("pg") : null;
  // Mở hội thoại TRƯỚC (đánh dấu đã đọc) rồi mới đọc danh sách — không thì hội thoại đang mở vẫn hiện «chưa đọc».
  // Workspace KHÁCH: lý do AI không trả lời + dấu vết từng tin lọc ở MÁY CHỦ trước khi vào props (lib/saas/visibility.ts).
  const loaded = selected ? await loadInboxThread(user, selected) : null;
  const thread = loaded && "thread" in loaded && customerFacing(user.organization) ? { ...loaded, thread: customerInboxThread(loaded.thread) } : loaded;
  const canManage = can(user, "ai_sales:manage");
  const [list, users, assignees, pack, routes, cooldown] = await Promise.all([
    listInbox(user, { filter, channel, q, label, page, phone, level, assignee, period, from, to, limit, handler }),
    assignableUsers(user),
    inboxAssignees(user),
    organizationLevelPack(),
    canManage ? listPageRoutes().catch(() => []) : Promise.resolve([]),
    humanCooldownMinutes(),
  ]);
  const levels = levelsForPack(pack);
  const advanced = Boolean(channel || label || assignee || period || phone === "NONE");
  const href = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | null> = {
      f: filter === "ALL" ? null : filter,
      ch: channel,
      lb: label,
      pg: page,
      q: q || null,
      sdt: phone === "HAS" ? "co" : phone === "NONE" ? "khong" : null,
      lv: level,
      nv: assignee,
      tg: period,
      tu: from,
      den: to,
      n: limit > 100 ? String(limit) : null,
      xl: handler === "AI" ? "ai" : handler === "HUMAN" ? "nguoi" : null,
      c: selected || null,
      ...patch,
    };
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    const s = p.toString();
    return `/ai/sales-chatbot/inbox${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-2">
      <PageHeader
        eyebrow="AI"
        title="Hộp thư khách"
        description={`Facebook · Instagram · Zalo OA · chat web — trả lời khách ngay trong ERP. Nhân viên gửi tin thì AI nhường ${cooldown} phút.`}
        refresh={false}
        actions={
          <div className="flex items-center gap-3">
            {"error" in list ? null : <InboxAutoRefresh waiting={list.counts.UNANSWERED} unread={list.counts.UNREAD} />}
            <Link href="/ai/sales-chatbot" className="text-sm font-medium text-primary hover:underline">
              Cấu hình chatbot →
            </Link>
          </div>
        }
      />
      {"error" in list ? (
        <p className="text-sm text-destructive">{list.error}</p>
      ) : (
        <div className="grid h-[calc(100dvh-13.5rem)] min-h-[560px] overflow-hidden rounded-xl border border-foreground/15 bg-background lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className={cn("min-h-0 flex-col border-r", selected ? "hidden lg:flex" : "flex")}>
            <div className="space-y-2 border-b bg-muted/30 p-2">
              {pages.length > 1 ? (
                <div className="flex gap-1 overflow-x-auto pb-0.5" data-testid="inbox-page-chips">
                  <Link href={href({ pg: null, c: null })} className={cn("shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px] font-medium", !page ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted")}>
                    Mọi page
                  </Link>
                  {pages.map((p) => (
                    <Link key={p.id} href={href({ pg: p.id, c: null })} className={cn("max-w-[11rem] shrink-0 truncate whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px]", page === p.id ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted")} data-page-filter={p.id}>
                      {p.name}
                    </Link>
                  ))}
                </div>
              ) : null}
              <div className="flex gap-1 overflow-x-auto pb-0.5 lg:flex-wrap lg:overflow-visible">
                {INBOX_FILTERS.map((f) => (
                  <Link
                    key={f}
                    href={href({ f: f === "ALL" ? null : f, c: null })}
                    className={cn(
                      "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px]",
                      f === filter ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                      f !== filter && (f === "UNREAD" || f === "UNANSWERED") && list.counts[f] > 0 && "border-primary/60 font-semibold text-primary",
                    )}
                    data-filter={f}
                  >
                    {INBOX_FILTER_LABEL[f]} {list.counts[f]}
                  </Link>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Link
                  href={href({ sdt: phone === "HAS" ? null : "co", c: null })}
                  className={cn("rounded-full border px-2.5 py-0.5 text-[12px] font-medium", phone === "HAS" ? "border-emerald-600 bg-emerald-600 text-white" : "border-emerald-600/50 bg-background text-emerald-800 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40")}
                  data-filter="has-phone"
                >
                  Có SĐT {list.phoneCount}
                </Link>
                {(["TODAY", "YESTERDAY", "7D"] as const).map((t) => (
                  <Link key={t} href={href({ tg: period === t ? null : t, tu: null, den: null, c: null })} className={cn("rounded-full border px-2.5 py-0.5 text-[12px]", period === t ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted")}>
                    {INBOX_PERIOD_LABEL[t]}
                  </Link>
                ))}
              </div>
              {levels.length ? (
                <div className="flex gap-1 overflow-x-auto pb-0.5" data-testid="inbox-levels">
                  {levels.map((l) => (
                    <Link
                      key={l}
                      href={href({ lv: level === l ? null : l, c: null })}
                      className={cn("shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium", CUSTOMER_LEVEL_CLASS[l], level === l ? "ring-2 ring-foreground ring-offset-1" : "opacity-90 hover:opacity-100")}
                      title={`Lọc khách ở level «${CUSTOMER_LEVEL_LABEL[l]}»`}
                    >
                      {CUSTOMER_LEVEL_LABEL[l]} {list.levelCounts[l] ?? 0}
                    </Link>
                  ))}
                </div>
              ) : null}
              <form method="get" action="/ai/sales-chatbot/inbox" className="space-y-1">
                {filter !== "ALL" ? <input type="hidden" name="f" value={filter} /> : null}
                {level ? <input type="hidden" name="lv" value={level} /> : null}
                {phone === "HAS" ? <input type="hidden" name="sdt" value="co" /> : null}
                {page ? <input type="hidden" name="pg" value={page} /> : null}
                <div className="flex gap-1">
                  <input name="q" defaultValue={q} placeholder="Tìm tên / SĐT…" className="h-8 min-w-0 flex-1 rounded-md border border-foreground/20 bg-background px-2 text-[13px]" aria-label="Tìm khách" />
                  <button type="submit" className="h-8 rounded-md bg-foreground px-3 text-[12px] font-medium text-background hover:opacity-90">
                    Lọc
                  </button>
                </div>
                <details open={advanced} className="rounded-md border border-foreground/15 bg-background px-2 py-1 text-[12px]">
                  <summary className="cursor-pointer select-none font-medium">Lọc nâng cao{advanced ? " · đang bật" : ""}</summary>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5 pb-1">
                    <select name="ch" defaultValue={channel ?? ""} className="h-8 rounded-md border bg-background px-1" aria-label="Kênh">
                      <option value="">Mọi kênh</option>
                      {INBOX_CHANNELS.map((c) => (
                        <option key={c} value={c}>
                          {INBOX_CHANNEL_LABEL[c]}
                        </option>
                      ))}
                    </select>
                    <select name="lb" defaultValue={label ?? ""} className="h-8 rounded-md border bg-background px-1" aria-label="Thẻ / nhãn">
                      <option value="">Mọi thẻ</option>
                      {labels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                    <select name="nv" defaultValue={assignee ?? ""} className="h-8 rounded-md border bg-background px-1" aria-label="Nhân viên phụ trách">
                      <option value="">Mọi nhân viên</option>
                      <option value="none">Chưa ai nhận</option>
                      {(users.length ? users : assignees).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                    <select name="sdt" defaultValue={phone === "HAS" ? "co" : phone === "NONE" ? "khong" : ""} className="h-8 rounded-md border bg-background px-1" aria-label="Số điện thoại">
                      <option value="">Có / không SĐT</option>
                      <option value="co">Có SĐT</option>
                      <option value="khong">Chưa có SĐT</option>
                    </select>
                    <select name="tg" defaultValue={period ?? ""} className="h-8 rounded-md border bg-background px-1" aria-label="Thời gian tin cuối">
                      <option value="">Mọi thời gian</option>
                      {INBOX_PERIODS.map((t) => (
                        <option key={t} value={t}>
                          {INBOX_PERIOD_LABEL[t]}
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center gap-1">
                      <input type="date" name="tu" defaultValue={from ?? ""} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-1" aria-label="Từ ngày (chọn «Khoảng ngày»)" />
                      <input type="date" name="den" defaultValue={to ?? ""} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-1" aria-label="Đến ngày" />
                    </div>
                  </div>
                  {advanced || level || phone || q ? (
                    <Link href="/ai/sales-chatbot/inbox" className="text-primary hover:underline">
                      Xoá mọi bộ lọc
                    </Link>
                  ) : null}
                </details>
              </form>
              {canManage ? <PageRoutesPanel routes={routes} pageNames={Object.fromEntries(pages.map((p) => [p.id, p.name]))} cooldownMinutes={cooldown} canManage={canManage} /> : null}
            </div>
            <ul className="min-h-0 flex-1 divide-y divide-foreground/10 overflow-y-auto" data-testid="inbox-list">
              {list.rows.length === 0 ? <li className="p-6 text-center text-sm text-muted-foreground">Không có hội thoại nào ở bộ lọc này.</li> : null}
              {list.rows.map((r) => (
                <li key={r.id}>
                  <ListItem r={r} href={href({ c: r.id })} active={r.id === selected} showPage={pages.length > 1 && !page} />
                </li>
              ))}
              {list.rows.length >= limit && limit < INBOX_LIST_MAX ? (
                <li className="p-2 text-center">
                  <Link href={href({ n: String(Math.min(INBOX_LIST_MAX, limit + 100)) })} className="text-[13px] font-medium text-primary hover:underline">
                    Xem thêm hội thoại ({list.rows.length}/{list.total})
                  </Link>
                </li>
              ) : null}
            </ul>
          </aside>
          <section className={cn("min-h-0", selected ? "block" : "hidden lg:block")}>
            {!selected ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-sm text-muted-foreground">
                <p className="text-base font-medium text-foreground">Chọn một hội thoại để trả lời</p>
                <p>
                  {list.counts.UNANSWERED > 0 ? `${list.counts.UNANSWERED} khách đang chờ trả lời — mở bộ lọc «Chờ trả lời» để xử lý khách chờ lâu nhất trước.` : "Không có khách nào đang chờ trả lời."}
                </p>
              </div>
            ) : !thread || !thread.ok ? (
              <div className="p-6 text-sm text-destructive">{thread && !thread.ok ? thread.error : "Không mở được hội thoại."}</div>
            ) : (
              <InboxThreadView
                key={thread.thread.id}
                thread={thread.thread}
                me={user.id}
                users={users}
                backHref={href({ c: null })}
                ordersSummary={thread.thread.orders.map((o) => ({ ...o, totalText: formatVND(o.total) }))}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

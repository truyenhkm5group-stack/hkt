import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { formatTimeAgo, formatVND } from "@/lib/format";
import { assignableUsers, listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { listLabels } from "@/lib/sales-chatbot/inbox-labels";
import { INBOX_CHANNEL_LABEL, INBOX_CHANNELS, INBOX_FILTER_LABEL, INBOX_FILTERS, type InboxChannel, type InboxFilter, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";
import { cn } from "@/lib/utils";
import { InboxAutoRefresh } from "./auto-refresh";
import { ChannelAvatar } from "./avatar";
import { LabelChip } from "./labels-panel";
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

function ListItem({ r, href, active }: { r: InboxRow; href: string; active: boolean }) {
  const wait = waitMinutes(r.waitingSince);
  return (
    <Link href={href} className={cn("flex gap-3 px-3 py-2.5 hover:bg-muted/60", active && "bg-primary/10 hover:bg-primary/10")} data-conversation={r.id} data-unread={r.unread ? "1" : "0"}>
      <ChannelAvatar name={r.customerName} channel={r.channel} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm", r.unread ? "font-bold" : "font-medium")}>{r.customerName}</span>
          <span className={cn("shrink-0 text-[11px]", r.unread ? "font-semibold text-primary" : "text-muted-foreground")}>{formatTimeAgo(r.lastActivityAt)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <p className={cn("min-w-0 flex-1 truncate text-[13px]", r.unread ? "font-medium text-foreground" : "text-muted-foreground")}>
            {r.previewSide ? SIDE_PREFIX[r.previewSide] : ""}
            {r.preview || "—"}
          </p>
          {r.unread ? <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-label="Chưa đọc" /> : null}
        </div>
        {wait !== null || r.status === "HANDOFF" || r.assigneeName || r.hasOrder || r.labels.length ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
            {wait !== null ? (
              <span className={cn("rounded px-1.5 font-medium", wait >= WAIT_URGENT_MIN ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200")}>{waitLabel(wait)}</span>
            ) : null}
            {r.status === "HANDOFF" ? <span className="rounded bg-rose-100 px-1.5 text-rose-900 dark:bg-rose-950/60 dark:text-rose-200">Cần người</span> : null}
            {r.assigneeName ? <span className="rounded bg-muted px-1.5 text-muted-foreground">{r.assigneeName}</span> : null}
            {r.hasOrder ? <span className="rounded bg-muted px-1.5 text-muted-foreground">có đơn</span> : null}
            {r.labels.map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
          </div>
        ) : null}
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
  // Mở hội thoại TRƯỚC (đánh dấu đã đọc) rồi mới đọc danh sách — không thì hội thoại đang mở vẫn hiện «chưa đọc».
  const thread = selected ? await loadInboxThread(user, selected) : null;
  const [list, users] = await Promise.all([listInbox(user, { filter, channel, q, label }), assignableUsers(user)]);
  const href = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | null> = { f: filter === "ALL" ? null : filter, ch: channel, lb: label, q: q || null, c: selected || null, ...patch };
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    const s = p.toString();
    return `/ai/sales-chatbot/inbox${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-2">
      <PageHeader
        eyebrow="AI"
        title="Hộp thư khách"
        description="Facebook · Instagram · Zalo OA · chat web — trả lời khách ngay trong ERP. Nhân viên gửi tin thì bot nhường."
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
        <div className="grid h-[calc(100dvh-13.5rem)] min-h-[560px] overflow-hidden rounded-xl border bg-background lg:grid-cols-[340px_minmax(0,1fr)]">
          <aside className={cn("min-h-0 flex-col border-r", selected ? "hidden lg:flex" : "flex")}>
            <div className="space-y-2 border-b bg-muted/30 p-2">
              <div className="flex flex-wrap gap-1">
                {INBOX_FILTERS.map((f) => (
                  <Link
                    key={f}
                    href={href({ f: f === "ALL" ? null : f, c: null })}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[12px]",
                      f === filter ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                      f !== filter && (f === "UNREAD" || f === "UNANSWERED") && list.counts[f] > 0 && "border-primary/60 font-semibold text-primary",
                    )}
                    data-filter={f}
                  >
                    {INBOX_FILTER_LABEL[f]} {list.counts[f]}
                  </Link>
                ))}
              </div>
              <form method="get" action="/ai/sales-chatbot/inbox" className="flex gap-1">
                {filter !== "ALL" ? <input type="hidden" name="f" value={filter} /> : null}
                <input name="q" defaultValue={q} placeholder="Tìm tên / SĐT…" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px]" aria-label="Tìm khách" />
                <select name="ch" defaultValue={channel ?? ""} className="h-8 w-[92px] rounded-md border bg-background px-1 text-[12px]" aria-label="Kênh">
                  <option value="">Mọi kênh</option>
                  {INBOX_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {INBOX_CHANNEL_LABEL[c]}
                    </option>
                  ))}
                </select>
                {labels.length ? (
                  <select name="lb" defaultValue={label ?? ""} className="h-8 w-[92px] rounded-md border bg-background px-1 text-[12px]" aria-label="Nhãn">
                    <option value="">Mọi nhãn</option>
                    {labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button type="submit" className="h-8 rounded-md border bg-background px-2 text-[12px] hover:bg-muted">
                  Lọc
                </button>
              </form>
            </div>
            <ul className="min-h-0 flex-1 divide-y overflow-y-auto" data-testid="inbox-list">
              {list.rows.length === 0 ? <li className="p-6 text-center text-sm text-muted-foreground">Không có hội thoại nào ở bộ lọc này.</li> : null}
              {list.rows.map((r) => (
                <li key={r.id}>
                  <ListItem r={r} href={href({ c: r.id })} active={r.id === selected} />
                </li>
              ))}
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

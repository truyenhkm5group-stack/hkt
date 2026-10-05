import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { formatTimeAgo, formatVND } from "@/lib/format";
import { assignableUsers, listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { listLabels } from "@/lib/sales-chatbot/inbox-labels";
import { INBOX_CHANNEL_LABEL, INBOX_CHANNELS, INBOX_FILTER_LABEL, INBOX_FILTERS, type InboxChannel, type InboxFilter } from "@/lib/sales-chatbot/inbox-shared";
import { cn } from "@/lib/utils";
import { InboxAutoRefresh } from "./auto-refresh";
import { LabelChip } from "./labels-panel";
import { InboxThreadView } from "./thread-view";

export const metadata = { title: "Hộp thư khách" };

const SIDE_PREFIX: Record<string, string> = { CUSTOMER: "", BOT: "Bot: ", STAFF: "Bạn/NV: ", PAGE: "Page: " };

/**
 * HỘP THƯ KHÁCH (M8) — mọi tin Facebook / Instagram / Zalo OA / chat web ở MỘT chỗ; nhân viên đọc và trả lời ngay trong ERP.
 * Hơn Pancake ở bốn chỗ: «Chờ trả lời» xếp khách chờ LÂU NHẤT lên đầu (gồm cả tin nhân viên trả lời ngoài ERP); mỗi tin gửi đi
 * mang tên người gửi (quy kết theo tài khoản); khung gửi của kênh hiện rõ (24 giờ Meta · 48 giờ Zalo, tin tính phí phải xác
 * nhận); cạnh khung chat là đơn cũ của khách với KẾT QUẢ THẬT (giao / hoàn theo ORDER_OUTCOME) và nút tạo đơn.
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
  const [list, thread, users] = await Promise.all([listInbox(user, { filter, channel, q, label }), selected ? loadInboxThread(user, selected) : Promise.resolve(null), assignableUsers(user)]);
  const href = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | null> = { f: filter === "ALL" ? null : filter, ch: channel, lb: label, q: q || null, c: selected || null, ...patch };
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    const s = p.toString();
    return `/ai/sales-chatbot/inbox${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-3">
      <PageHeader
        eyebrow="AI"
        title="Hộp thư khách"
        description="Facebook · Instagram · Zalo OA · chat web — đọc và trả lời khách ngay trong ERP. Nhân viên gửi tin thì bot nhường."
        refresh={false}
        actions={
          <Link href="/ai/sales-chatbot" className="text-sm font-medium text-primary hover:underline">
            Cấu hình chatbot →
          </Link>
        }
      />
      <InboxAutoRefresh />
      {"error" in list ? (
        <p className="text-sm text-destructive">{list.error}</p>
      ) : (
        <div className="grid min-h-[70vh] gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className={cn("flex min-h-0 flex-col rounded-lg border bg-background", selected ? "hidden lg:flex" : "flex")}>
            <div className="space-y-2 border-b p-2">
              <div className="flex flex-wrap gap-1">
                {INBOX_FILTERS.map((f) => (
                  <Link
                    key={f}
                    href={href({ f: f === "ALL" ? null : f, c: null })}
                    className={cn("rounded-full border px-2 py-0.5 text-[12px]", f === filter ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}
                    data-filter={f}
                  >
                    {INBOX_FILTER_LABEL[f]} <b>{list.counts[f]}</b>
                  </Link>
                ))}
              </div>
              <form method="get" action="/ai/sales-chatbot/inbox" className="flex gap-1">
                {filter !== "ALL" ? <input type="hidden" name="f" value={filter} /> : null}
                <select name="ch" defaultValue={channel ?? ""} className="h-8 rounded-md border bg-background px-1 text-[12px]" aria-label="Kênh">
                  <option value="">Mọi kênh</option>
                  {INBOX_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {INBOX_CHANNEL_LABEL[c]}
                    </option>
                  ))}
                </select>
                {labels.length ? (
                  <select name="lb" defaultValue={label ?? ""} className="h-8 max-w-[110px] rounded-md border bg-background px-1 text-[12px]" aria-label="Nhãn">
                    <option value="">Mọi nhãn</option>
                    {labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input name="q" defaultValue={q} placeholder="Tên / SĐT" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[12px]" aria-label="Tìm khách" />
                <button type="submit" className="h-8 rounded-md border px-2 text-[12px] hover:bg-muted">
                  Lọc
                </button>
              </form>
            </div>
            <ul className="min-h-0 flex-1 divide-y overflow-y-auto" data-testid="inbox-list">
              {list.rows.length === 0 ? <li className="p-4 text-sm text-muted-foreground">Không có hội thoại nào ở bộ lọc này.</li> : null}
              {list.rows.map((r) => (
                <li key={r.id}>
                  <Link href={href({ c: r.id })} className={cn("block px-3 py-2 text-[12.5px] hover:bg-muted/60", r.id === selected && "bg-muted")} data-conversation={r.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold">{r.customerName}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{formatTimeAgo(r.lastActivityAt)}</span>
                    </div>
                    <div className="truncate text-muted-foreground">
                      {r.previewSide ? SIDE_PREFIX[r.previewSide] : ""}
                      {r.preview || "—"}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]">
                      <span className="rounded bg-muted px-1">{INBOX_CHANNEL_LABEL[r.channel as InboxChannel] ?? r.channel}</span>
                      {r.waitingSince ? <span className="rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">Chờ {formatTimeAgo(r.waitingSince).replace(" trước", "")}</span> : null}
                      {r.status === "HANDOFF" ? <span className="rounded bg-rose-100 px-1 text-rose-900 dark:bg-rose-950/50 dark:text-rose-200">Cần người</span> : null}
                      {r.assigneeName ? <span className="text-muted-foreground">· {r.assigneeName}</span> : null}
                      {r.hasOrder ? <span className="text-muted-foreground">· có đơn</span> : null}
                      {r.labels.map((l) => (
                        <LabelChip key={l.id} label={l} />
                      ))}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </aside>
          <section className={cn("min-h-0", selected ? "block" : "hidden lg:block")}>
            {!selected ? (
              <div className="flex h-full items-center justify-center rounded-lg border p-8 text-sm text-muted-foreground">Chọn một hội thoại bên trái.</div>
            ) : !thread || !thread.ok ? (
              <div className="rounded-lg border p-6 text-sm text-destructive">{thread && !thread.ok ? thread.error : "Không mở được hội thoại."}</div>
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

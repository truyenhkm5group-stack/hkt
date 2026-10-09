import Link from "next/link";
import { Settings2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { formatVND } from "@/lib/format";
import { assignableUsers, inboxAssignees, inboxPages, listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { customerFacing, customerInboxThread } from "@/lib/saas/visibility";
import { listLabels } from "@/lib/sales-chatbot/inbox-labels";
import { INBOX_CHANNELS, INBOX_FILTERS, INBOX_LIST_MAX, INBOX_PERIODS, inboxHref, type InboxChannel, type InboxFilter, type InboxFilterState, type InboxHandler, type InboxPeriod } from "@/lib/sales-chatbot/inbox-shared";
import { listPageRoutes } from "@/lib/sales-chatbot/channel-ownership";
import { humanCooldownMinutes } from "@/lib/sales-chatbot/conversation-control";
import { organizationLevelPack } from "@/lib/sales-chatbot/levels";
import { CUSTOMER_LEVELS, levelsForPack, type CustomerLevel } from "@/lib/sales-chatbot/levels-shared";
import { cn } from "@/lib/utils";
import { InboxAutoRefresh } from "./auto-refresh";
import { ConversationRows } from "./conversation-list";
import { InboxFilters } from "./inbox-filters";
import { PageRoutesPanel } from "./page-routes";
import { InboxThreadView } from "./thread-view";
import { ShellViewportFit } from "@/components/shell-viewport-fit";
import { isSalesAgentUser, SALES_AGENT_CHANNELS_HREF } from "@/lib/constants/saas-nav";
import { manualOrderGate } from "@/lib/records/order-create";
import { CHANNELS_MANAGE_PERMISSION } from "@/lib/channels/overview-shared";
import { memo } from "@/lib/cache";
import { anyChannelConnected } from "@/lib/onboarding/go-live-shared";
import { loadChannelFacts } from "@/lib/onboarding/go-live";

/**
 * Khung hai cột của hộp thư. Ngoài vỏ: ĐÚNG chiều cao cũ (canh cho thanh menu ERP). Trong vỏ app Chốt Đơn: khung tự đo
 * (`ShellViewportFit`) — thanh dưới cố định của vỏ + vùng an toàn iPhone làm `100dvh - 13.5rem` đẩy ô soạn tin xuống dưới nó.
 */
function InboxFrame({ shell, children }: { shell: boolean; children: React.ReactNode }) {
  // INBOX-V2-A: tiêu đề chỉ còn cho trình đọc màn hình và hộp thư không in dòng vị trí «… / inbox» (components/detail-crumb.tsx) ⇒
  // 13.5rem cũ (chừa cho tiêu đề + mô tả ~190 px) còn 8rem (thanh menu + lề), vừa khít dưới thanh menu ERP mà trang không cuộn (đáy `pb-10` của khung chính). `grid-cols-[minmax(0,1fr)]`: một cột trên điện thoại
  // không được nở theo nội dung (hàng thẻ lọc cuộn ngang) mà tràn khỏi màn hình.
  if (!shell) return <div className="grid h-[calc(100dvh-8rem)] min-h-[560px] grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl border border-foreground/15 bg-card lg:grid-cols-[360px_minmax(0,1fr)]">{children}</div>;
  return (
    <ShellViewportFit testId="inbox-frame" className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl border border-foreground/15 bg-card lg:grid-cols-[360px_minmax(0,1fr)]" fallbackClassName="h-[calc(100dvh-15rem-env(safe-area-inset-bottom))] lg:h-[calc(100dvh-9rem)]">
      {children}
    </ShellViewportFit>
  );
}

export const metadata = { title: "Hộp thư khách" };

/**
 * HỘP THƯ KHÁCH (M8) — mọi tin Facebook / Instagram / Zalo OA / chat web ở MỘT chỗ; nhân viên đọc và trả lời ngay trong ERP.
 * Bố cục ba cột cao bằng màn hình (danh sách · khung chat · thông tin khách), mỗi cột tự cuộn. Không bỏ sót khách: hội thoại có
 * mặt NGAY khi khách nhắn (kể cả bot tắt / nhân viên đã trả lời ngoài ERP / tin nhãn dán · ghi âm), «Chưa đọc» theo lần cuối nhân
 * viên mở, «Chờ trả lời» xếp khách chờ lâu nhất lên đầu, tiêu đề tab đếm khách đang chờ + âm báo khi có tin mới, tự làm mới.
 */
export default async function SalesInboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("ai_sales:view");
  // Vỏ app Chốt Đơn: khung hộp thư đo theo thanh trên + thanh dưới của vỏ (ô soạn tin không bị thanh dưới che), đầu trang gọn.
  const shell = isSalesAgentUser(user);
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
  const [list, users, assignees, pack, routes, cooldown, orderGate] = await Promise.all([
    listInbox(user, { filter, channel, q, label, page, phone, level, assignee, period, from, to, limit, handler }),
    assignableUsers(user),
    inboxAssignees(user),
    organizationLevelPack(),
    canManage ? listPageRoutes().catch(() => []) : Promise.resolve([]),
    humanCooldownMinutes(),
    // Nút nhanh «Xác nhận đơn» / «Huỷ đơn» trong panel đơn: CÙNG cổng với sửa đơn tay (`orders:write`, tổ chức không đồng bộ đơn).
    manualOrderGate(user),
  ]);
  const levels = levelsForPack(pack);
  const advanced = Boolean(channel || label || assignee || period || phone === "NONE");
  // Hộp thư rỗng mà KHÔNG lọc gì ⇒ hỏi «đã nối kênh nào chưa» bằng ĐÚNG hàm của bước onboarding «đã nối kênh» (Pancake · Facebook
  // nối thẳng · Zalo OA · chat web đã xuất bản — lib/onboarding/go-live.ts), không chỉ danh sách page của hộp thư: shop chỉ nối
  // Zalo OA / chat web thì không có page Facebook nào mà vẫn có kênh. Chỉ đọc khi hộp thư rỗng thật (trang có tin không tốn gì);
  // đọc hỏng ⇒ KHÔNG kết luận «chưa nối kênh» (chưa biết không phải «không có»).
  const unfiltered = filter === "ALL" && !q && !advanced && !level && phone === null && !handler && !page;
  const emptyInbox = list.ok && list.total === 0 && unfiltered;
  // Đệm 60 giây theo MÃ TỔ CHỨC (`memo` của lib/cache.ts — khoá mang mã tổ chức, và memo tự thêm tiền tố tổ chức): hộp thư là
  // trang nhà của mọi shop mới và tự làm mới mỗi 5 giây, bốn lượt đọc kênh không cần chạy lại mỗi lượt. Nối kênh là lượt ghi của
  // NGƯỜI có `audit()` ⇒ `clearMemo()` ⇒ lượt đọc kế tiếp đã thấy kênh mới.
  const orgCode = user.organization?.code ?? null;
  const channelFacts = emptyInbox && orgCode ? await memo(`inbox:channel-facts:${orgCode}`, 60_000, () => loadChannelFacts(orgCode)).catch(() => null) : null;
  const noChannelYet = channelFacts !== null && !anyChannelConnected(channelFacts);
  // Nút «Kết nối Facebook» theo ĐÚNG quyền nối kênh của màn Kênh kết nối (`CHANNELS_MANAGE_PERMISSION`), không theo quyền quản lý
  // chatbot: người chỉ xem được Kênh kết nối mà bấm vào sẽ tới một màn không có nút nào cho họ.
  const canConnect = can(user, CHANNELS_MANAGE_PERMISSION);
  // Bộ lọc đang áp — MỘT đối tượng dựng mọi đường dẫn của hộp thư (`inboxHref`, ĐÚNG tên tham số cũ).
  const state: InboxFilterState = { filter, q, page, channel, handler, assignee, phone, level, period, from, to, label, limit, selected: selected || null };
  const href = (patch: Parameters<typeof inboxHref>[1]) => inboxHref(state, patch);
  const description = `Facebook · Instagram · Zalo OA · chat web — trả lời khách ngay tại đây. Nhân viên gửi tin thì AI nhường ${cooldown} phút.`;

  return (
    <div className="space-y-2">
      {/*
        Đầu trang GỌN (INBOX-V2-A): tiêu đề vẫn là h1 cho trình đọc màn hình + tiêu đề tab, nhưng không chiếm ~190 px phía trên
        danh sách (đo HSLC 1366×768: hàng hội thoại đầu ở y = 502). Câu mô tả vào chú thích của nút cấu hình; âm báo + cấu hình đứng
        cạnh ô tìm của danh sách.
      */}
      <PageHeader title={shell ? "Hội thoại" : "Hộp thư khách"} className="sr-only" refresh={false} />
      {"error" in list ? (
        <p className="text-sm text-destructive">{list.error}</p>
      ) : (
        <InboxFrame shell={shell}>
          <aside className={cn("min-h-0 min-w-0 flex-col border-r border-foreground/10 bg-surface-sunken/60", selected ? "hidden lg:flex" : "flex")} data-testid="inbox-list-column">
            <InboxFilters
              state={state}
              counts={list.counts}
              phoneCount={list.phoneCount}
              levelCounts={list.levelCounts}
              levels={levels}
              pages={pages}
              labels={labels}
              users={users.length ? users : assignees}
              tools={
                <>
                  <InboxAutoRefresh waiting={list.counts.UNANSWERED} unread={list.counts.UNREAD} compact />
                  <Link href="/ai/sales-chatbot" className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-foreground/15 bg-background text-muted-foreground hover:bg-muted hover:text-foreground" title={`Cấu hình chatbot — ${description}`} aria-label="Cấu hình chatbot">
                    <Settings2 className="size-4" />
                  </Link>
                </>
              }
              manage={canManage ? <PageRoutesPanel routes={routes} pageNames={Object.fromEntries(pages.map((p) => [p.id, p.name]))} cooldownMinutes={cooldown} canManage={canManage} /> : null}
            />
            <ul className="min-h-0 flex-1 divide-y divide-foreground/[0.06] overflow-y-auto overscroll-contain" data-testid="inbox-list">
              {list.rows.length === 0 ? (
                noChannelYet ? (
                  // Cửa hàng mới, chưa nối kênh nào: hộp thư rỗng vì CHƯA CÓ ĐƯỜNG tin tới — nói ra và dẫn đúng một việc tiếp theo
                  // (kiểm vỏ khách 08/10/2026, F-03), thay vì «không có hội thoại ở bộ lọc này» như thể khách chưa nhắn.
                  <li className="space-y-3 p-6 text-center text-sm" data-testid="inbox-empty-no-channel">
                    <p className="font-semibold text-foreground">Chưa có tin khách vì cửa hàng chưa nối kênh bán hàng</p>
                    <p className="text-muted-foreground">Nối fanpage qua Pancake, Zalo OA hoặc ô chat trên website — tin khách sẽ hiện ở đây và AI bắt đầu trả lời.</p>
                    {canConnect ? (
                      <Link href={SALES_AGENT_CHANNELS_HREF} className="inline-flex h-10 items-center rounded-full bg-primary px-4 font-medium text-primary-foreground hover:bg-primary/90" data-testid="inbox-empty-connect">
                        Nối kênh bán hàng
                      </Link>
                    ) : (
                      <p className="text-xs text-muted-foreground">Nhờ quản trị cửa hàng nối kênh ở mục «Kênh kết nối».</p>
                    )}
                  </li>
                ) : emptyInbox ? (
                  // Đã có kênh (hoặc chưa đọc được kênh) mà chưa có hội thoại nào, không lọc gì: không nói «ở bộ lọc này» khi không có bộ lọc.
                  <li className="p-6 text-center text-sm text-muted-foreground" data-testid="inbox-empty-waiting">
                    Chưa có tin khách nào — tin nhắn mới sẽ hiện ở đây ngay khi khách nhắn.
                  </li>
                ) : (
                  <li className="p-6 text-center text-sm text-muted-foreground">Không có hội thoại nào ở bộ lọc này.</li>
                )
              ) : null}
              <ConversationRows rows={list.rows} activeId={selected || null} state={state} showPage={pages.length > 1 && !page} />
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
                canDecideOrders={orderGate.allowed}
                shell={shell}
              />
            )}
          </section>
        </InboxFrame>
      )}
    </div>
  );
}

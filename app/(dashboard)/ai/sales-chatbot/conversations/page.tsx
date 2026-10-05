import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { CHAT_CHANNEL_LABEL, type ChatChannel } from "@/lib/sales-chatbot/config";
import { HANDOFF_REASON_LABEL, type HandoffReasonCode } from "@/lib/sales-chatbot/events-shared";
import { listDrillConversations } from "@/lib/sales-chatbot/experiment-report";
import { DRILL_PERIODS, drillHref, parseDrillFilter } from "@/lib/sales-chatbot/experiment-shared";
import { SALES_STAGE_LABEL, type SalesStage } from "@/lib/sales-chatbot/stages";
import { LOST_REASON_LABEL } from "@/lib/sales-chatbot/lost-reasons-shared";
import { inboxPages } from "@/lib/sales-chatbot/inbox";

export const metadata = { title: "Hội thoại theo chỉ số" };

const COHORT_LABEL = { AI_ONLY: "AI tự xử lý", AI_THEN_HUMAN: "AI rồi chuyển người" } as const;
const ARM_LABEL = { AI: "Nhánh AI", HUMAN: "Nhánh người" } as const;
const STATUS_LABEL: Record<string, string> = { OPEN: "Đang chat", WAITING: "Chờ khách", HANDOFF: "Cần người xử lý", CLOSED: "Đã đóng" };

/**
 * DRILL-DOWN TỪ MÀN «HIỆU QUẢ» — ô KPI nào cũng dẫn tới đúng các hội thoại làm ra nó (cùng định nghĩa phễu: hội thoại có tin
 * khách trong kỳ, khung thử bị loại). Chỉ hiện những gì trang Chatbot bán hàng đang hiện; bấm một dòng để xem lại hội thoại.
 */
export default async function DrillConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("ai_sales:view");
  const f = parseDrillFilter(await searchParams);
  const r = await listDrillConversations(user, f);
  const pageName = f.page ? ((await inboxPages()).find((p) => p.id === f.page)?.name ?? f.page) : null;
  const chips = [
    f.cohort ? COHORT_LABEL[f.cohort] : null,
    f.reason ? `Chuyển người: ${HANDOFF_REASON_LABEL[f.reason as HandoffReasonCode] ?? f.reason}` : null,
    f.arm ? ARM_LABEL[f.arm] : null,
    f.confirmed ? "Có đơn chốt" : null,
    f.lost ? `Không mua: ${LOST_REASON_LABEL[f.lost]}` : null,
    pageName ? `Page: ${pageName}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="AI"
        title="Hội thoại theo chỉ số"
        description={`${chips.length ? chips.join(" · ") : "Mọi hội thoại có khách nhắn"} · ${f.days} ngày`}
        actions={
          <Link href={`/ai/sales-chatbot/performance?days=${f.days}${f.page ? `&pg=${encodeURIComponent(f.page)}` : ""}`} className="text-sm font-medium text-primary hover:underline">
            ← Hiệu quả
          </Link>
        }
      />
      <div className="flex flex-wrap gap-2 text-xs">
        {DRILL_PERIODS.map((d) => (
          <Link key={d} href={drillHref({ ...f, days: d })} className={d === f.days ? "rounded border bg-primary/10 px-2 py-1 font-semibold" : "rounded border px-2 py-1 hover:bg-muted"}>
            {d} ngày
          </Link>
        ))}
      </div>
      <SectionCard title="Hội thoại" description={"ok" in r ? `${r.rows.length}${r.truncated ? "+ (hiện 200 gần nhất)" : ""} hội thoại` : undefined} padded={false}>
        {"error" in r ? (
          <p className="p-4 text-sm text-destructive">{r.error}</p>
        ) : r.rows.length === 0 ? (
          <EmptyState title="Không có hội thoại nào khớp" className="m-4" />
        ) : (
          <ul className="divide-y text-sm" data-testid="drill-list">
            {r.rows.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <Link href={`/ai/sales-chatbot/conversations/${encodeURIComponent(c.id)}`} className="hover:underline">
                  {CHAT_CHANNEL_LABEL[c.channel as ChatChannel] ?? c.channel} · <b>{STATUS_LABEL[c.status] ?? c.status}</b> · {c.turns} lượt
                  {c.stage && c.stage in SALES_STAGE_LABEL ? ` · ${SALES_STAGE_LABEL[c.stage as SalesStage]}` : ""}
                  {c.arm ? ` · ${ARM_LABEL[c.arm as keyof typeof ARM_LABEL] ?? c.arm}` : ""}
                  {c.handoffReason ? ` · ${c.handoffReason}` : ""}
                </Link>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {c.orderId ? (
                    <Link href={`/orders/${encodeURIComponent(c.orderId)}`} className="underline underline-offset-2">
                      Đơn đã chốt
                    </Link>
                  ) : null}
                  {formatDateTime(c.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

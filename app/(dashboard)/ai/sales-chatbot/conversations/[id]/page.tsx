import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { customerChatView, customerFacing } from "@/lib/saas/visibility";
import { formatDateTime } from "@/lib/format";
import { CHAT_CHANNEL_LABEL, type ChatChannel } from "@/lib/sales-chatbot/config";
import { HANDOFF_REASON_LABEL, type HandoffReasonCode } from "@/lib/sales-chatbot/events-shared";
import { loadConversationReview } from "@/lib/sales-chatbot/experiment-report";
import { maskPhones } from "@/lib/sales-chatbot/experiment-shared";
import { cn } from "@/lib/utils";

export const metadata = { title: "Xem lại hội thoại" };

const ACTOR_LABEL: Record<string, string> = { CUSTOMER: "Khách", AI: "AI", HUMAN: "Người", SYSTEM: "Máy" };

/** XEM LẠI MỘT HỘI THOẠI (lệnh §11.E) — chữ + công cụ AI đã gọi + dòng sổ sự kiện; SĐT trong chữ bị che, giữ 3 số cuối. */
export default async function ConversationReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("ai_sales:view");
  const { id } = await params;
  const r = await loadConversationReview(user, decodeURIComponent(id));
  if ("error" in r) notFound();
  // Workspace KHÁCH: không tên / tóm tắt công cụ bot đã gọi (lib/saas/visibility.ts) — lọc trước khi dựng.
  const v = customerFacing(user.organization) ? { ...r.value, view: customerChatView(r.value.view) } : r.value;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="AI"
        title="Xem lại hội thoại"
        description={`${CHAT_CHANNEL_LABEL[v.channel as ChatChannel] ?? v.channel} · mở ${formatDateTime(v.createdAt)}${v.arm ? ` · nhánh thử nghiệm ${v.arm === "AI" ? "AI" : "người"}` : ""}${v.handoffReason ? ` · ${v.handoffReason}` : ""}`}
        actions={
          <Link href="/ai/sales-chatbot/conversations" className="text-sm font-medium text-primary hover:underline">
            ← Danh sách
          </Link>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <SectionCard title="Tin nhắn">
          <div className="space-y-2 text-sm" data-testid="review-messages">
            {v.view.messages.map((m, i) => (
              <div key={i} className={cn("max-w-[85%] rounded-lg px-3 py-2", m.role === "user" ? "bg-muted" : "ml-auto bg-primary/10")}>
                <div className="whitespace-pre-wrap">{maskPhones(m.text)}</div>
                {m.tools?.length ? <div className="mt-1 text-[11px] text-muted-foreground">{m.tools.map((t) => `${t.ok ? "✓" : "✗"} ${t.name}`).join(" · ")}</div> : null}
              </div>
            ))}
          </div>
        </SectionCard>
        <SectionCard title="Sổ sự kiện" padded={false}>
          {v.events.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Hội thoại có từ trước khi bật sổ sự kiện.</p>
          ) : (
            <ul className="divide-y text-xs">
              {v.events.map((e, i) => (
                <li key={i} className="flex justify-between gap-2 px-3 py-1.5">
                  <span>
                    {e.type}
                    {e.reason ? ` · ${HANDOFF_REASON_LABEL[e.reason as HandoffReasonCode] ?? e.reason}` : ""}
                  </span>
                  <span className="text-muted-foreground">
                    {ACTOR_LABEL[e.actor] ?? e.actor} · {formatDateTime(e.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

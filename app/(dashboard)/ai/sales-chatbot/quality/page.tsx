import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { customerFacing, customerQualityItems } from "@/lib/saas/visibility";
import { CHAT_CHANNEL_LABEL, type ChatChannel } from "@/lib/sales-chatbot/config";
import { loadQualityQueue } from "@/lib/sales-chatbot/quality";
import { QUALITY_KIND_LABEL, QUALITY_KINDS, REVIEW_STATUS_LABEL } from "@/lib/sales-chatbot/quality-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { ReviewButtons } from "./review-buttons";

export const metadata = { title: "Rà lỗi AI" };

const PERIODS = [1, 7, 30] as const;
const SEVERITY_LABEL = { HIGH: "Nặng", MEDIUM: "Vừa", LOW: "Nhẹ" } as const;
const SEVERITY_CLASS = { HIGH: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200", MEDIUM: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200", LOW: "bg-muted text-muted-foreground" } as const;

/**
 * RÀ LỖI AI TRÊN HỘI THOẠI THẬT (docs/product-audit.md P7). Luật tất định tìm câu bot có thể sai (giá không căn cứ · công cụ
 * lỗi · khách hỏi lại y nguyên); người rà quyết đúng / không phải lỗi. Một cờ là một DẤU HIỆU, không phải kết luận.
 */
export default async function AiQualityPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await requirePermission("ai_sales:view");
  const manage = can(user, SALES_CHATBOT_MANAGE);
  const sp = await searchParams;
  const days = PERIODS.find((d) => String(d) === sp.days) ?? 7;
  const r = await loadQualityQueue(user, { days });
  // Workspace KHÁCH (lib/saas/visibility.ts): dấu hiệu «công cụ lỗi» không mang tên công cụ bot gọi / câu trả về thô của nó.
  const items = "ok" in r ? (customerFacing(user.organization) ? customerQualityItems(r.value.items) : r.value.items) : [];
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="AI"
        title="Rà lỗi AI"
        description={"ok" in r ? `${formatNumber(r.value.open)} chờ rà · ${formatNumber(r.value.confirmed)} đúng là lỗi · ${formatNumber(r.value.dismissed)} không phải lỗi · ${formatNumber(r.value.conversationsScanned)} hội thoại · ${days} ngày` : undefined}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Máy tìm bằng LUẬT, không bằng một AI thứ hai: «giá không có căn cứ» = câu bot có số tiền không nằm trong giá bảng, phí ship đã khai, số công cụ trả hoặc số đã nói trước đó. Bot có thể cộng hai số đúng thành tổng đơn — nên người rà quyết.</p>
            <p>Cùng luật với màn Phát lại hội thoại. Tin của nhân viên không bao giờ bị cờ.</p>
          </div>
        }
        actions={
          <div className="flex items-center gap-1">
            {PERIODS.map((d) => (
              <Link key={d} href={`/ai/sales-chatbot/quality?days=${d}`} className={`inline-flex h-8 items-center rounded-md border px-3 text-sm ${d === days ? "bg-muted font-semibold" : "hover:bg-muted"}`}>
                {d === 1 ? "Hôm nay" : `${d} ngày`}
              </Link>
            ))}
            <Link href="/ai/sales-chatbot/performance" className="ml-2 inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">
              ← Hiệu quả
            </Link>
          </div>
        }
      />
      {"error" in r ? (
        <SectionCard>
          <p className="text-sm text-destructive">{r.error}</p>
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2" data-testid="ai-quality-counts">
            {QUALITY_KINDS.map((k) => (
              <div key={k} className="rounded-lg border bg-muted/30 px-3 py-2">
                <div className="text-lg font-semibold tabular-nums">{formatNumber(r.value.counts[k])}</div>
                <div className="text-xs text-muted-foreground">{QUALITY_KIND_LABEL[k]}</div>
              </div>
            ))}
          </div>
          {r.value.truncated ? <p className="text-xs text-muted-foreground">Chỉ quét 300 hội thoại gần nhất của kỳ — chọn kỳ ngắn hơn để rà hết.</p> : null}
          <SectionCard title="Phát hiện" padded={false}>
            {items.length === 0 ? (
              <EmptyState title="Không có phát hiện nào trong kỳ" className="m-4" />
            ) : (
              <ul className="divide-y text-sm" data-testid="ai-quality-list">
                {items.map((it) => (
                  <li key={`${it.conversationId}:${it.seq}:${it.kind}`} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${SEVERITY_CLASS[it.severity]}`}>{SEVERITY_LABEL[it.severity]}</span>
                      <b>{QUALITY_KIND_LABEL[it.kind]}</b>
                      <span className="text-muted-foreground">{CHAT_CHANNEL_LABEL[it.channel as ChatChannel] ?? it.channel} · {formatDateTime(it.at)}</span>
                      <span className="rounded border px-1.5 py-0.5">{REVIEW_STATUS_LABEL[it.status]}</span>
                      <Link href={`/ai/sales-chatbot/conversations/${encodeURIComponent(it.conversationId)}`} className="ml-auto text-primary hover:underline">
                        Mở hội thoại →
                      </Link>
                    </div>
                    <p className="mt-1.5 break-words text-sm">{it.evidence}</p>
                    {it.amounts.length ? <p className="mt-1 text-xs text-muted-foreground">Số không có căn cứ: {it.amounts.map((n) => formatVND(n)).join(" · ")}</p> : null}
                    {it.reviewerName ? <p className="mt-1 text-xs text-muted-foreground">Rà bởi {it.reviewerName}{it.reviewedAt ? ` · ${formatDateTime(it.reviewedAt)}` : ""}{it.note ? ` — ${it.note}` : ""}</p> : null}
                    {manage ? <ReviewButtons conversationId={it.conversationId} seq={it.seq} kind={it.kind} current={it.status} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { TopicStatusBadge } from "@/app/(dashboard)/production/_components/badges";
import { ModelDesk } from "@/app/(dashboard)/production/_components/model-desk";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getModelBrief, getModelProductionDesk, listSupplierOptions } from "@/lib/queries/production-os";
import { getModelProductionSummary } from "@/lib/queries/model-production";

export const metadata = { title: "Bàn sản xuất của mẫu" };

/**
 * Bàn sản xuất của một mẫu khi KHÔNG đi qua topic nào (giá thành / mẫu ghi thẳng cho mẫu). Hàng đợi
 * "Mẫu chờ duyệt" trỏ về đây khi phiên bản mẫu không gắn topic.
 */
export default async function ModelProductionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("planning:view");
  const { id } = await params;
  const [model, desk, summary, suppliers] = await Promise.all([getModelBrief(id), getModelProductionDesk(id), getModelProductionSummary(id), listSupplierOptions()]);
  if (!model || !summary) notFound();
  const canWrite = can(user, "production:write");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất · Mẫu"
        title={`${model.code}${model.name ? ` · ${model.name}` : ""}`}
        description="Giá thành · mẫu · bản thiết kế đã duyệt của mẫu này"
        actions={
          <div className="flex items-center gap-3">
            {canWrite ? (
              <Link href={`/production/topics/new?model=${model.id}`} className="text-sm text-primary hover:underline">
                Mở topic
              </Link>
            ) : null}
            <Link href={`/models/${model.id}`} className="text-sm text-primary hover:underline">
              Trang mẫu
            </Link>
          </div>
        }
      />
      <SectionCard title="Topic của mẫu">
        {summary.topics.length ? (
          <ul className="divide-y text-sm">
            {summary.topics.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/production/topics/${t.id}`} className="font-medium underline-offset-2 hover:underline">
                  {t.title}
                </Link>
                <TopicStatusBadge status={t.status} />
                <span className="text-xs text-muted-foreground">cập nhật {formatDateTime(t.updatedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có topic nào cho mẫu này.</p>
        )}
      </SectionCard>
      <ModelDesk desk={desk} modelId={model.id} topicId={null} productId={model.productId} suppliers={suppliers} canWrite={canWrite} canApprove={can(user, "production:approve")} canAssumptions={can(user, "reports:assumptions")} />
    </div>
  );
}

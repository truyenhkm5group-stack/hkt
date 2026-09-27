import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { TopicsTable } from "@/app/(dashboard)/production/topics-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { canOpenTopic } from "@/lib/production/topic-access";
import { listTopics, TOPIC_SORTABLE, topicStatusFacets } from "@/lib/queries/production-os";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Topic gửi sản xuất" };

/**
 * ═══════════ MARKETING — TOPIC GỬI SẢN XUẤT (chủ shop 27/09/2026) ═══════════
 *
 * Marketer mở topic để trao đổi với sản xuất và tag người cần tham gia. Trang này chỉ liệt kê topic CỦA
 * MÌNH: mình mở hoặc được tag. Trang topic vẫn là `/production/topics/[id]` — một topic, một chỗ trao đổi.
 */
export default async function MarketingTopicsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  if (!canOpenTopic(user)) redirect("/?forbidden=1");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "updatedAt", defaultDir: "desc", filterKeys: ["status", "open"], sortable: TOPIC_SORTABLE, defaultPeriod: "all" });
  const [{ rows, total, pageCount }, facets] = await Promise.all([listTopics(params, user, { mine: true }), topicStatusFacets(user)]);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title="Topic gửi sản xuất"
        description="Topic bạn mở hoặc được tag — trao đổi với sản xuất về một mẫu"
        actions={
          <Button asChild size="sm">
            <Link href="/marketing/topics/new">
              <Plus className="size-4" /> Mở topic
            </Link>
          </Button>
        }
      />
      <DataTableToolbar
        searchPlaceholder="Tiêu đề, mã mẫu…"
        period={false}
        facets={[
          { key: "status", label: "Trạng thái", options: facets },
          { key: "open", label: "Đang mở", options: [{ value: "1", label: "Chỉ topic chưa ngã ngũ" }] },
        ]}
        resultLabel={`${formatNumber(total)} topic`}
      />
      <TopicsTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

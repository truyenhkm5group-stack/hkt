import Link from "next/link";
import { Plus } from "lucide-react";
import { TopicsTable } from "@/app/(dashboard)/production/topics-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/session";
import { canOpenTopic } from "@/lib/production/topic-access";
import { formatNumber } from "@/lib/format";
import { listTopics, TOPIC_SORTABLE, topicStatusFacets } from "@/lib/queries/production-os";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Topic sản xuất" };

/**
 * ═══════════ SẢN XUẤT NỬA ĐẦU — DANH SÁCH TOPIC (Company OS · Agent C) ═══════════
 *
 * Bước 4 của chủ shop: "tạo topic hỏi giá sản xuất và trao đổi phương án". Mỗi topic thuộc MỘT mẫu (sổ
 * mẫu của Agent A); giá thành, mẫu và bản duyệt của mẫu đó hiện ngay trong trang topic.
 */
export default async function ProductionTopicsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("planning:view");
  // Topic RIÊNG chỉ hiện với người mở, người được tag và ADMIN (lib/production/topic-access.ts).
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "updatedAt", defaultDir: "desc", filterKeys: ["status", "open"], sortable: TOPIC_SORTABLE, defaultPeriod: "all" });
  const [{ rows, total, pageCount }, facets] = await Promise.all([listTopics(params, user), topicStatusFacets(user)]);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất"
        title="Topic sản xuất"
        description="Hỏi giá xưởng · trao đổi phương án · giá thành tạm tính · mẫu · duyệt mẫu"
        hint={
          <>
            Topic là nơi bàn với xưởng về MỘT mẫu. <b>Giá thành</b> có phiên bản (bản chốt không sửa được), <b>mẫu</b> có phiên bản và mỗi phiên bản nhận
            đúng một phán quyết. Duyệt mẫu sinh <b>bản thiết kế bất biến</b> để lệnh sản xuất trỏ vào. Topic chờ báo giá / chờ quyết hiện ở hàng đợi Công việc.
          </>
        }
        actions={
          // Chủ shop 27/09/2026: marketing là người mở topic — nút dẫn sang biểu mẫu bên Marketing.
          canOpenTopic(user) ? (
            <Button asChild size="sm">
              <Link href="/marketing/topics/new">
                <Plus className="size-4" /> Mở topic
              </Link>
            </Button>
          ) : null
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

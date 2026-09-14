import Link from "next/link";
import { ImageIcon, MessageSquare } from "lucide-react";
import { IdeaForm } from "@/app/(dashboard)/ideas/idea-form";
import { IdeaStatusTabs } from "@/app/(dashboard)/ideas/status-tabs";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { IDEA_STATUSES, IDEA_STATUS_HINT, IDEA_STATUS_LABEL, IDEA_STATUS_TONE, ideaTitle } from "@/lib/constants/ideas";
import { formatDate, formatNumber, formatTimeAgo } from "@/lib/format";
import { ideaCounts, listIdeas, listMarketers } from "@/lib/queries/ideas";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Ý tưởng marketing" };

const HOP_LE = new Set<string>([...IDEA_STATUSES, "ALL"]);

export default async function IdeasPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("ideas:view");
  const canWrite = can(user, "ideas:write");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "ideaDate", sortable: [], defaultPeriod: "all", defaultPageSize: 24 });
  const tt = param(raw, "tt");
  const trangThai = HOP_LE.has(tt) ? tt : "ALL";
  const marketer = param(raw, "mkt");

  const [danhSach, dem, marketers] = await Promise.all([
    listIdeas({ period: params.period, status: trangThai as never, marketer, q: params.q, page: params.page, pageSize: params.pageSize }),
    ideaCounts({ period: params.period, marketer, q: params.q }),
    listMarketers(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title="Ý tưởng marketing"
        description={`${formatNumber(dem.ALL)} ý tưởng · ${formatNumber(dem.NEW + dem.CHANGES)} đang chờ`}
        hint={
          <>
            Marketer đăng ý tưởng kèm ảnh mẫu; quản lý xem, nhận xét và chốt <b>Duyệt</b>,{" "}
            <b>Cần sửa</b> hoặc <b>Không duyệt</b>. Cả quá trình trao đổi được giữ lại nên đọc lại
            lúc nào cũng biết vì sao ý tưởng được duyệt hay bị bỏ. Ảnh được thu nhỏ ngay trên máy
            trước khi tải lên và lưu trong cơ sở dữ liệu nên không phụ thuộc link ngoài.
          </>
        }
        actions={canWrite ? <IdeaForm marketers={marketers} /> : null}
      />

      <IdeaStatusTabs counts={dem} active={trangThai} />

      <DataTableToolbar
        searchPlaceholder="Nội dung ý tưởng, tên marketer…"
        period={{ defaultKey: "all" }}
        facets={marketers.length ? [{ key: "mkt", label: "Marketer", options: marketers.map((m) => ({ value: m.id, label: m.name, count: 0 })) }] : []}
        resultLabel={<>{formatNumber(danhSach.total)} ý tưởng{trangThai === "ALL" ? "" : ` · ${IDEA_STATUS_HINT[trangThai as keyof typeof IDEA_STATUS_HINT]}`}</>}
      />

      {danhSach.rows.length === 0 ? (
        <SectionCard>
          <EmptyState
            title="Chưa có ý tưởng nào"
            description={canWrite ? "Bấm “Thêm ý tưởng” để đăng ý tưởng đầu tiên kèm ảnh mẫu." : "Đội marketing chưa đăng ý tưởng nào trong bộ lọc này."}
          />
        </SectionCard>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {danhSach.rows.map((r) => (
            <Link
              key={r.id}
              href={`/ideas/${r.id}`}
              className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-colors hover:border-primary/40"
            >
              <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
                {r.imageIds.length ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/ideas/images/${r.imageIds[0]}`} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.02]" loading="lazy" />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    <ImageIcon className="size-8" />
                  </div>
                )}
                {r.imageIds.length > 1 ? (
                  <span className="absolute bottom-2 right-2 rounded-md bg-background/85 px-1.5 py-0.5 text-[11px] font-medium">+{r.imageIds.length - 1} ảnh</span>
                ) : null}
                <span className={cn("absolute left-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-semibold", IDEA_STATUS_TONE[r.status])}>
                  {IDEA_STATUS_LABEL[r.status]}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-4">
                <p className="line-clamp-2 font-semibold leading-snug">{ideaTitle(r.content)}</p>
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-medium text-foreground">{r.marketerName || "—"}</span> · {formatDate(r.ideaDate)}
                </p>
                <div className="mt-auto flex items-center gap-3 pt-2 text-[11.5px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="size-3.5" /> {formatNumber(r.comments)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ImageIcon className="size-3.5" /> {formatNumber(r.imageIds.length)}
                  </span>
                  <span className="ml-auto">{formatTimeAgo(r.lastCommentAt ?? r.createdAt)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <UrlPagination pageCount={danhSach.pageCount} total={danhSach.total} />
    </div>
  );
}

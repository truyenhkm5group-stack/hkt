import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ImageIcon } from "lucide-react";
import { FeedbackForm } from "@/app/(dashboard)/ideas/feedback-form";
import { ThemAnh, XoaAnh, XoaYTuong } from "@/app/(dashboard)/ideas/idea-manage";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { can, requirePermission } from "@/lib/auth/session";
import { IDEA_STATUS_HINT, IDEA_STATUS_LABEL, IDEA_STATUS_TONE, ideaTitle } from "@/lib/constants/ideas";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { getIdea } from "@/lib/queries/ideas";
import { cn } from "@/lib/utils";

export const metadata = { title: "Ý tưởng marketing" };

export default async function IdeaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("ideas:view");
  const { id } = await params;
  const idea = await getIdea(id);
  if (!idea) notFound();

  const canReview = can(user, "ideas:review");
  const laNguoiDang = idea.createdBy === user.email;
  // Marketer trả lời được trên chính ý tưởng của mình; người ngoài chỉ đọc.
  const duocTraLoi = canReview || (laNguoiDang && can(user, "ideas:write"));
  // SỬA SAI SÓT: cùng luật với tầng hành động (người đăng sửa của mình, người duyệt sửa của mọi
  // người). Ẩn nút chỉ để gọn mắt — tầng hành động vẫn tự kiểm, vì ẩn nút không phải kiểm soát.
  const duocSua = canReview || (laNguoiDang && can(user, "ideas:write"));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title={ideaTitle(idea.content)}
        description={`${idea.marketerName || "—"} · ${formatDate(idea.ideaDate)} · đăng bởi ${idea.createdByName || idea.createdBy}`}
        actions={
          <div className="flex items-center gap-2">
            <span className={cn("rounded-md px-2 py-1 text-xs font-semibold", IDEA_STATUS_TONE[idea.status])}>{IDEA_STATUS_LABEL[idea.status]}</span>
            {duocSua ? <XoaYTuong ideaId={idea.id} soAnh={idea.images.length} soTraoDoi={idea.comments.length} /> : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/ideas">
                <ArrowLeft className="size-4" /> Danh sách
              </Link>
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <SectionCard
            title="Ảnh minh hoạ"
            description={`${formatNumber(idea.images.length)} ảnh`}
            actions={duocSua ? <ThemAnh ideaId={idea.id} dangCo={idea.images.length} /> : null}
            padded={false}
          >
            {idea.images.length ? (
              <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
                {idea.images.map((a) => (
                  <a key={a.id} href={`/api/ideas/images/${a.id}`} target="_blank" rel="noreferrer" className="group relative block bg-card">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/ideas/images/${a.id}`} alt="" className="aspect-square w-full object-cover transition-opacity group-hover:opacity-90" loading="lazy" />
                    <span className="absolute bottom-1 right-1 rounded bg-background/85 px-1 text-[10px] text-muted-foreground">{Math.round(a.bytes / 1024)} KB</span>
                    {duocSua ? <XoaAnh imageId={a.id} /> : null}
                  </a>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 px-5 py-8 text-sm text-muted-foreground">
                <ImageIcon className="size-4" /> Ý tưởng này chưa có ảnh.
                {duocSua ? <ThemAnh ideaId={idea.id} dangCo={0} /> : null}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Nội dung">
            <p className="whitespace-pre-wrap text-sm leading-6">{idea.content}</p>
          </SectionCard>
        </div>

        <SectionCard
          title="Trao đổi với quản lý"
          description={IDEA_STATUS_HINT[idea.status]}
          hint="Giữ nguyên cả quá trình trao đổi, không ghi đè. Mỗi lần quản lý chốt trạng thái đều kèm lý do nên đọc lại lúc nào cũng biết vì sao ý tưởng được duyệt hay bị bỏ."
        >
          <div className="space-y-4">
            {idea.comments.length ? (
              <ol className="space-y-3">
                {idea.comments.map((c) => (
                  <li key={c.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold">{c.authorName || c.authorEmail}</span>
                      <span className="text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                      {c.statusSet ? (
                        <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[11px] font-semibold", IDEA_STATUS_TONE[c.statusSet])}>
                          {IDEA_STATUS_LABEL[c.statusSet]}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-5">{c.body}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">Chưa có nhận xét nào.</p>
            )}

            {duocTraLoi ? (
              <div className="border-t pt-4">
                <FeedbackForm ideaId={idea.id} canReview={canReview} />
              </div>
            ) : (
              <p className="border-t pt-4 text-xs text-muted-foreground">Bạn chỉ có quyền xem ý tưởng này.</p>
            )}

            {idea.reviewedAt ? (
              <p className="text-[11px] text-muted-foreground">
                Chốt gần nhất: {idea.reviewedBy} · {formatDateTime(idea.reviewedAt)}
              </p>
            ) : null}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

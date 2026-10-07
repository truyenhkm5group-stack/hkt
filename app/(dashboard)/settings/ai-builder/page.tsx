import Link from "next/link";
import { AiBuilderPanel } from "@/components/ai-builder/ai-builder-panel";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { AI_BUILDER_MODE_LABEL, AI_DRAFT_STATUS_LABEL } from "@/lib/ai-builder/types";
import { loadAiBuilderView, loadDraft } from "@/lib/ai-builder/service";
import { requirePermission } from "@/lib/auth/session";
import { customerAiBuilderView, customerAiDraft, customerFacing } from "@/lib/saas/visibility";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "AI dựng cấu hình" };

/**
 * AI DỰNG CẤU HÌNH (Phase 8 · §3). AI soạn một gói cấu hình từ câu mô tả; người bỏ chọn từng mục, xem trước kế hoạch và
 * xác nhận; bộ cài mẫu cấu hình (Phase 7) ghi. `?draft=<id>` mở lại một bản nháp trong lịch sử của tổ chức NGƯỜI XEM.
 */
export default async function AiBuilderPage({ searchParams }: { searchParams: Promise<{ draft?: string }> }) {
  const user = await requirePermission("metadata:manage");
  const { draft: draftId } = await searchParams;
  // Workspace KHÁCH: không nhà cung cấp / model / token / USD trong DTO (lib/saas/visibility.ts) — lọc trước props.
  const customer = customerFacing(user.organization);
  const rawLoaded = await loadAiBuilderView(user);
  const loaded = rawLoaded.ok && customer ? { ok: true as const, value: customerAiBuilderView(rawLoaded.value) } : rawLoaded;
  const rawOpened = loaded.ok && draftId ? await loadDraft(user, draftId) : null;
  const opened = rawOpened?.ok && customer ? { ok: true as const, value: customerAiDraft(rawOpened.value) } : rawOpened;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="AI dựng cấu hình"
        description={user.organization?.name}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Mô tả doanh nghiệp (dựng mới) hoặc một thay đổi (sửa lặp) — AI soạn một GÓI cấu hình: module, field, form, danh sách, trang, luật, vai trò.</p>
            <p>AI không ghi gì. Bạn bỏ chọn mục không muốn → Xem trước (máy liệt kê từng thao tác) → Áp dụng. Luật luôn ở NHÁP + CHẠY THỬ.</p>
            {customer ? null : <p>Khoá AI là của CHÍNH tổ chức (Kết nối theo tổ chức) — ai dùng người ấy trả; tổ chức khác không bao giờ dùng khoá của nhau.</p>}
          </div>
        }
      />
      {!loaded.ok ? (
        <EmptyState title="Không mở được AI dựng cấu hình" description={loaded.error} />
      ) : (
        <>
          {opened && !opened.ok ? <EmptyState title="Không mở được bản nháp" description={opened.error} /> : null}
          <AiBuilderPanel key={opened?.ok ? opened.value.id : "moi"} view={loaded.value} initialDraft={opened?.ok ? opened.value : null} />
          <SectionCard title="Lịch sử bản nháp" description="Mỗi lượt AI soạn của tổ chức — kể cả lượt còn lỗi hoặc đã bỏ" padded={false} contentClassName="p-3">
            {loaded.value.drafts.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Chưa có bản nháp nào — tổ chức chưa nhờ AI soạn lần nào.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Lúc</th>
                      <th className="px-3 py-2">Chế độ</th>
                      <th className="px-3 py-2">Yêu cầu</th>
                      <th className="px-3 py-2">Trạng thái</th>
                      <th className="px-3 py-2">Người tạo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaded.value.drafts.map((d) => (
                      <tr key={d.id} className="border-t border-hairline align-top">
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{formatDateTime(d.createdAt)}</td>
                        <td className="px-3 py-2 text-xs">{AI_BUILDER_MODE_LABEL[d.mode]}</td>
                        <td className="max-w-[420px] px-3 py-2">
                          <Link href={`/settings/ai-builder?draft=${encodeURIComponent(d.id)}`} className="font-medium text-primary underline-offset-2 hover:underline">
                            {d.name ?? "(chưa có gói)"}
                          </Link>
                          <div className="truncate text-xs text-muted-foreground">{d.prompt}</div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={d.status === "APPLIED" ? "default" : d.status === "DISCARDED" ? "secondary" : "outline"}>{AI_DRAFT_STATUS_LABEL[d.status]}</Badge>
                          {d.status === "DRAFT" && !d.valid ? <div className="mt-1 text-[11.5px] text-rose-700 dark:text-rose-300">còn lỗi</div> : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{d.createdByEmail ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

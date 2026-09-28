import Link from "next/link";
import { PencilRuler, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PageStateBadge } from "@/components/platform/pages/page-badges";
import { TemplatePicker } from "@/components/platform/pages/template-picker";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { loadPageList } from "@/lib/platform-ui/page-admin";
import { pageHref } from "@/lib/platform-ui/page-admin-shared";

export const metadata = { title: "Trang tuỳ biến" };

const TITLE = "Trang tuỳ biến";

/**
 * TRANG TUỲ BIẾN — danh sách trang động của tổ chức NGƯỜI XEM (Phase 4).
 *
 * Trang mới (trống hoặc từ mẫu) luôn sinh ở NHÁP: người dùng chưa thấy gì cho tới khi bấm Xuất bản ở trang của
 * từng trang. Bảng chỉ đọc; «Soạn» mở trình kéo-thả `/settings/pages/[id]/builder`, tên trang mở
 * chế độ bàn phím `/settings/pages/[id]` (thông tin trang, lưu trữ, soạn bằng ô chọn).
 */
export default async function CustomPagesPage() {
  const user = await requirePermission("metadata:manage");
  const loaded = await loadPageList(user);
  const newButton = (
    <Button asChild size="sm">
      <Link href="/settings/pages/new">
        <Plus /> Trang mới
      </Link>
    </Button>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={user.organization?.name}
        actions={
          loaded.ok ? (
            <div className="flex flex-wrap items-start gap-2">
              <TemplatePicker templates={loaded.value.templates} />
              {newButton}
            </div>
          ) : null
        }
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Mỗi trang là một bố cục các khối (chỉ số, bảng, biểu đồ, Kanban, nhật ký, form, nút, đoạn chữ) ghép từ sổ nguồn có sẵn — không SQL, không mã.</p>
            <p>Sửa ở trang của từng trang là sửa bản NHÁP. «Xuất bản» mới đổi thứ người dùng thấy ở /p/&lt;đường dẫn&gt;, có hiệu lực ở lần tải kế tiếp, không cần deploy.</p>
            <p>Cấu hình trang không phải ranh giới an ninh: mỗi khối vẫn tự kiểm module và quyền của NGƯỜI XEM khi lấy dữ liệu.</p>
          </div>
        }
      />
      {!loaded.ok ? (
        <EmptyState title="Không mở được danh sách trang" description={loaded.errors.map((e) => e.message).join(" · ")} />
      ) : loaded.value.pages.length === 0 ? (
        <EmptyState title="Chưa có trang tuỳ biến nào" description="Tạo trang trống hoặc từ mẫu — trang sinh ra ở NHÁP, người dùng chưa thấy gì cho tới khi bạn xuất bản." action={newButton} />
      ) : (
        <SectionCard title="Trang của tổ chức" padded={false} contentClassName="p-3">
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Tên</th>
                  <th className="px-3 py-2">Đường dẫn</th>
                  <th className="px-3 py-2">Module chủ</th>
                  <th className="px-3 py-2">Trạng thái</th>
                  <th className="px-3 py-2 text-right">Phiên bản</th>
                  <th className="px-3 py-2">Trên menu</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Soạn</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loaded.value.pages.map((p) => (
                  <tr key={p.id} className="border-t border-hairline">
                    <td className="px-3 py-2">
                      <Link href={`/settings/pages/${encodeURIComponent(p.id)}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-[12.5px]">
                      {p.publishedVersion > 0 && p.status === "ACTIVE" ? (
                        <a href={pageHref(p.slug)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                          {pageHref(p.slug)}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{pageHref(p.slug)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{p.moduleLabel}</td>
                    <td className="px-3 py-2">
                      <PageStateBadge status={p.status} publishedVersion={p.publishedVersion} />
                    </td>
                    <td className="numeric px-3 py-2 text-right" title={p.publishedAt ?? undefined}>
                      {p.publishedVersion > 0 ? p.publishedVersion : "—"}
                    </td>
                    <td className="px-3 py-2">{p.nav.enabled ? p.nav.label || p.name : <span className="text-muted-foreground">Không</span>}</td>
                    <td className="px-3 py-2 text-right">
                      {p.status === "ACTIVE" ? (
                        <Button asChild variant="outline" size="xs" title="Mở trình dựng kéo-thả (tên trang mở chế độ bàn phím)">
                          <Link href={`/settings/pages/${encodeURIComponent(p.id)}/builder`}>
                            <PencilRuler /> Soạn
                          </Link>
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

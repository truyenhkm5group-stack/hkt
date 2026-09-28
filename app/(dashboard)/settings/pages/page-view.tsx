import Link from "next/link";
import { ArrowLeft, PencilRuler } from "lucide-react";
import { PageMetaForm } from "@/components/platform/pages/page-meta-form";
import { PageSchemaEditor } from "@/components/platform/pages/page-schema-editor";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import type { SessionUser } from "@/lib/auth/session";
import type { loadPageEditor } from "@/lib/platform-ui/page-admin";
import { pageHref } from "@/lib/platform-ui/page-admin-shared";

/**
 * Trang của MỘT trang tuỳ biến (hoặc trang mới): thông tin trang · nội dung (nhóm → khối) · xuất bản. Dùng chung
 * cho `/settings/pages/[id]` và `/new`; mỗi trang tự vẽ `<PageHeader>` (nút làm mới đi theo tiêu đề trang —
 * tests/refresh-button.test.ts) từ `pageEditorHeader()`.
 */

type LoadedEditor = Awaited<ReturnType<typeof loadPageEditor>>;

export const PAGE_EYEBROW = "Hệ thống · Trang tuỳ biến";

export const BACK_TO_LIST = (
  <Button asChild variant="ghost" size="sm">
    <Link href="/settings/pages">
      <ArrowLeft /> Danh sách trang
    </Link>
  </Button>
);

const EDITOR_HINT = (
  <div className="space-y-1.5 text-xs leading-5">
    <p>Thông tin trang lưu riêng. Nội dung: «Lưu nháp» → «Xem trước» (tab mới, bản nháp đã lưu) → «Xuất bản». Người dùng thấy bản xuất bản ở lần tải kế tiếp — không deploy.</p>
    <p>Đường dẫn khoá sau lần xuất bản đầu. Khối dùng nguồn của module đang tắt thì không xuất bản được; module tắt SAU khi xuất bản thì khối hiện «chưa bật».</p>
    <p>Mỗi khối vẫn tự kiểm quyền của NGƯỜI XEM khi lấy dữ liệu — ẩn/hiện ở đây không phải ranh giới an ninh.</p>
  </div>
);

export function pageEditorHeader(loaded: LoadedEditor, user: SessionUser): { title: string; description?: string; hint?: React.ReactNode } {
  if (!loaded.ok) return { title: "Không mở được trang" };
  const page = loaded.value.page;
  return { title: page ? page.name : "Trang mới", description: page ? `${pageHref(page.slug)} · ${user.organization?.name ?? ""}` : user.organization?.name, hint: EDITOR_HINT };
}

export function PageEditorBody({ loaded }: { loaded: LoadedEditor }) {
  if (!loaded.ok) return <EmptyState title="Không mở được trang này" description={loaded.errors.map((e) => e.message).join(" · ")} />;
  const { page, draft, published, takenSlugs, options, catalog } = loaded.value;
  const archived = page?.status === "ARCHIVED";
  return (
    <>
      <SectionCard title="Thông tin trang" hint="Tên, đường dẫn, module chủ, quyền xem và vị trí trên menu. Tắt module chủ ⇒ trang không mở được, không lên menu.">
        <PageMetaForm
          key={page ? `${page.id}:${page.publishedVersion}:${page.status}` : "new"}
          pageId={page?.id ?? null}
          initial={page ? { name: page.name, slug: page.slug, moduleKey: page.moduleKey, requiredPermission: page.requiredPermission, nav: page.nav } : null}
          slugLocked={Boolean(page && page.publishedVersion > 0)}
          takenSlugs={takenSlugs}
          options={options}
          disabled={archived}
        />
      </SectionCard>
      {page ? (
        <SectionCard
          title="Nội dung trang — chế độ bàn phím"
          padded={false}
          contentClassName="p-3"
          actions={
            archived ? null : (
              <Button asChild variant="outline" size="sm">
                <Link href={`/settings/pages/${encodeURIComponent(page.id)}/builder`}>
                  <PencilRuler /> Mở trình kéo-thả
                </Link>
              </Button>
            )
          }
        >
          <PageSchemaEditor
            key={`${page.id}:${page.publishedVersion}:${page.status}`}
            pageId={page.id}
            pageName={page.name}
            slug={page.slug}
            status={page.status}
            publishedVersion={page.publishedVersion}
            publishedAt={page.publishedAt}
            publishedBy={page.publishedBy}
            draft={draft}
            published={published}
            catalog={catalog}
          />
        </SectionCard>
      ) : null}
    </>
  );
}

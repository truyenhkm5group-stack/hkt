import { PageHeader } from "@/components/page-header";
import { PageBuilder } from "@/components/platform/page-builder/page-builder";
import { EmptyState } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { pageHref } from "@/lib/platform-ui/page-admin-shared";
import { loadPageBuilder } from "@/lib/platform-ui/page-builder";
import { BACK_TO_LIST } from "../../page-view";

export const metadata = { title: "Trình dựng trang" };

const HINT = (
  <div className="space-y-1.5 text-xs leading-5">
    <p>Kéo khối từ thư viện vào khung, kéo để đổi chỗ hoặc sang nhóm khác, kéo tay nắm cạnh phải để đổi độ rộng (1/4 · 1/3 · 1/2 · 2/3 · cả hàng). Mọi thao tác có nút tương đương ở khung phải.</p>
    <p>Khung vẽ bằng ĐÚNG renderer của trang thật, mỗi khối là số thật theo quyền của chính bạn (xem trước từng khối — kéo / đổi chỗ / đổi độ rộng không gọi lại máy chủ). Nháp tự lưu 2 giây sau thao tác cuối; người khác vừa lưu thì bạn được hỏi tải bản của họ hay ghi đè. Người dùng chỉ thấy bản đã «Xuất bản».</p>
    <p>Ctrl+Z hoàn tác, Ctrl+Shift+Z làm lại (tối đa 50 bước, chỉ trong tab này). Mỗi khối vẫn tự kiểm quyền và module của NGƯỜI XEM khi lấy dữ liệu.</p>
  </div>
);

/** Trình dựng trang kéo-thả — vào từ nút «Soạn» ở /settings/pages; trình soạn bàn phím ở /settings/pages/[id]. */
export default async function PageBuilderRoute({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("metadata:manage");
  const { id } = await params;
  const loaded = await loadPageBuilder(user, decodeURIComponent(id));
  if (!loaded.ok || !loaded.value.page) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống · Trình dựng trang" title="Không mở được trang" actions={BACK_TO_LIST} refresh={false} />
        <EmptyState title="Không mở được trang này" description={loaded.ok ? "Không có trang này trong tổ chức." : loaded.errors.map((e) => e.message).join(" · ")} />
      </div>
    );
  }
  const { page, draft, draftRevision, catalog, options } = loaded.value;
  return (
    <div className="space-y-3">
      <PageHeader eyebrow="Hệ thống · Trình dựng trang" title={page.name} description={`${pageHref(page.slug)} · ${user.organization?.name ?? ""}`} hint={HINT} actions={BACK_TO_LIST} refresh={false} />
      {page.status === "ARCHIVED" ? (
        <EmptyState title="Trang đã lưu trữ" description="Trang lưu trữ không sửa được — nội dung và lịch sử phiên bản vẫn còn." />
      ) : (
        <PageBuilder
          pageId={page.id}
          pageName={page.name}
          slug={page.slug}
          status={page.status}
          publishedVersion={page.publishedVersion}
          publishedAt={page.publishedAt}
          nav={page.nav}
          draft={draft}
          draftRevision={draftRevision}
          catalog={catalog}
          options={options}
        />
      )}
    </div>
  );
}

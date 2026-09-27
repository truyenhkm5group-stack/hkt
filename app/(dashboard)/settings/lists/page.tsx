import { PageHeader } from "@/components/page-header";
import { AdminPicker } from "@/components/platform/metadata/admin-picker";
import { ListViewDesigner } from "@/components/platform/metadata/list-view-designer";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { loadListEditor } from "@/lib/platform-ui/metadata-admin";
import { adminObjects } from "@/lib/platform-ui/metadata-admin-shared";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Danh sách" };

const TITLE = "Danh sách";

/**
 * DANH SÁCH — cột, thứ tự, sắp xếp và bộ lọc mặc định của các danh sách chạy theo metadata (M9). Cùng
 * mô hình Nháp / Xuất bản với form; chưa xuất bản thì trang dùng cột của mã nguồn y như cũ.
 */
export default async function ListsAdminPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("metadata:manage");
  const raw = await searchParams;
  const objects = adminObjects(user, "lists");
  if (!user.organization || objects.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title={TITLE} />
        {!user.organization ? (
          <EmptyState title="Chưa có thông tin tổ chức của phiên" description="Phiên đăng nhập này không mang tổ chức nào — đăng xuất rồi đăng nhập lại." />
        ) : (
          <EmptyState title="Chưa có danh sách nào cấu hình được" description="Không có đối tượng nào có danh sách mà module đang bật với tổ chức — bật Khách hàng hoặc Đơn hàng ở Module của tổ chức." />
        )}
      </div>
    );
  }
  const current = objects.find((o) => o.key === param(raw, "object")) ?? objects[0];
  const list = current.lists.find((l) => l.key === param(raw, "view")) ?? current.lists[0];
  const loaded = await loadListEditor(user, current.key, list.key);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={`${user.organization.name} · ${current.label} · ${list.label}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Sửa ở đây là sửa bản NHÁP. «Xuất bản» đổi danh sách thật cho mọi người ở lần tải trang kế tiếp, không cần deploy.</p>
            <p>Field mới tạo KHÔNG tự chen vào danh sách — nó xuất hiện ở cuối với trạng thái ẩn, bật lên khi cần.</p>
            <p>Bộ lọc mặc định chỉ chọn được field «Lọc được». Người xem vẫn đổi được bộ lọc của riêng họ trên trang.</p>
          </div>
        }
      />
      <div className="space-y-2">
        <AdminPicker label="Đối tượng" current={current.key} items={objects.map((o) => ({ key: o.key, label: o.label, href: `/settings/lists?object=${o.key}` }))} />
        {current.lists.length > 1 ? <AdminPicker label="Danh sách" current={list.key} items={current.lists.map((l) => ({ key: l.key, label: l.label, href: `/settings/lists?object=${current.key}&view=${l.key}` }))} /> : null}
      </div>
      {!loaded.ok ? (
        <EmptyState title="Không mở được danh sách này" description={loaded.errors.map((e) => e.message).join(" · ")} />
      ) : (
        <SectionCard title={loaded.value.list.label} hint={`Trang chạy thật: ${loaded.value.list.route}`} padded={false} contentClassName="p-3">
          <ListViewDesigner
            key={`${current.key}:${list.key}`}
            objectKey={current.key}
            viewKey={list.key}
            listLabel={loaded.value.list.label}
            route={loaded.value.list.route}
            catalog={loaded.value.catalog}
            draft={loaded.value.draft}
            published={loaded.value.published}
          />
        </SectionCard>
      )}
    </div>
  );
}

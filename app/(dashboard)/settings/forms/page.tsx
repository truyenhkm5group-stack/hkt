import { PageHeader } from "@/components/page-header";
import { AdminPicker } from "@/components/platform/metadata/admin-picker";
import { FormDesigner } from "@/components/platform/metadata/form-designer";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { adminObjectsAll, loadFormEditor } from "@/lib/platform-ui/metadata-admin";

import { param, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Form nhập liệu" };

const TITLE = "Form nhập liệu";

/**
 * FORM NHẬP LIỆU — soạn NHÁP, xem trước, rồi xuất bản. Người dùng chỉ thấy bản đã xuất bản (M7); chưa
 * xuất bản lần nào thì họ thấy form mặc định dựng từ sổ đối tượng.
 */
export default async function FormsAdminPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("metadata:manage");
  const raw = await searchParams;
  const objects = await adminObjectsAll(user, "forms");
  if (!user.organization || objects.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title={TITLE} />
        {!user.organization ? (
          <EmptyState title="Chưa có thông tin tổ chức của phiên" description="Phiên đăng nhập này không mang tổ chức nào — đăng xuất rồi đăng nhập lại." />
        ) : (
          <EmptyState title="Chưa có form nào cấu hình được" description="Không có đối tượng nào có form mà module đang bật với tổ chức — bật module Khách hàng ở Module của tổ chức." />
        )}
      </div>
    );
  }
  const current = objects.find((o) => o.key === param(raw, "object")) ?? objects[0];
  const form = current.forms.find((f) => f.key === param(raw, "form")) ?? current.forms[0];
  const loaded = await loadFormEditor(user, current.key, form.key);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={`${user.organization.name} · ${current.label} · ${form.label}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Sửa ở đây là sửa bản NHÁP — người dùng chưa thấy gì. «Lưu nháp» rồi xem trước; «Xuất bản» mới đổi form thật, có hiệu lực ở lần tải trang kế tiếp, không cần deploy.</p>
            <p>Field hệ thống bắt buộc không nới được; field hệ thống không sửa được luôn chỉ đọc. Field ẩn không nhận ghi.</p>
            <p>Mỗi lần xuất bản được chụp lại thành một phiên bản trong lịch sử.</p>
          </div>
        }
      />
      <div className="space-y-2">
        <AdminPicker label="Đối tượng" current={current.key} items={objects.map((o) => ({ key: o.key, label: o.label, href: `/settings/forms?object=${o.key}` }))} />
        <AdminPicker label="Form" current={form.key} items={current.forms.map((f) => ({ key: f.key, label: f.label, href: `/settings/forms?object=${current.key}&form=${f.key}` }))} />
      </div>
      {!loaded.ok ? (
        <EmptyState title="Không mở được form này" description={loaded.errors.map((e) => e.message).join(" · ")} />
      ) : (
        <SectionCard title={loaded.value.form.label} hint={loaded.value.form.purpose === "create" ? "Form TẠO bản ghi mới." : "Form SỬA / bổ sung cho bản ghi đã có."} padded={false} contentClassName="p-3">
          <FormDesigner
            key={`${current.key}:${form.key}`}
            objectKey={current.key}
            formKey={form.key}
            formLabel={loaded.value.form.label}
            catalog={loaded.value.catalog}
            draft={loaded.value.draft}
            published={loaded.value.published}
          />
        </SectionCard>
      )}
    </div>
  );
}

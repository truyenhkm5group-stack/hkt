import { PageHeader } from "@/components/page-header";
import { ObjectManager } from "@/components/objects/object-manager";
import { EmptyState } from "@/components/ui-bits";
import { PERMISSION_GROUPS } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { PLATFORM_MODULES } from "@/lib/constants/platform-modules";
import { listObjects } from "@/lib/objects/objects";
import { moduleOn } from "@/lib/platform-ui/module-visibility";

export const metadata = { title: "Đối tượng tuỳ biến" };

const TITLE = "Đối tượng tuỳ biến";

/**
 * ĐỐI TƯỢNG TUỲ BIẾN (Phase 6 · mục 5) — tạo / sửa / lưu trữ nghiệp vụ mới của tổ chức. Field, form, danh sách của đối
 * tượng soạn ở các màn metadata sẵn có (chúng nhận khoá `x_…` qua bộ phân giải). Luôn là tổ chức CỦA NGƯỜI XEM.
 */
export default async function ObjectsSettingsPage() {
  const user = await requirePermission("metadata:manage");
  const r = await listObjects(user);
  if (!r.ok) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title={TITLE} />
        <EmptyState title="Không mở được danh sách đối tượng" description={r.errors.map((e) => e.message).join(" · ")} />
      </div>
    );
  }
  const appsOn = moduleOn(user, "apps");
  // Nhóm menu chọn được: module ĐANG BẬT, không phải kết nối dữ liệu (máy chủ kiểm lại đúng luật này).
  const modules = PLATFORM_MODULES.filter((m) => m.category !== "CONNECTOR" && moduleOn(user, m.key)).map((m) => ({ key: m.key as string, label: m.label }));
  const permissions = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => ({ key: i.key as string, label: `${g.module} · ${i.label}` })));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={`${user.organization?.name ?? ""} · ${r.objects.filter((o) => o.status === "ACTIVE").length} đối tượng đang dùng`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Mỗi đối tượng có danh sách, form tạo / sửa và trang chi tiết TỰ SINH ở /o/&lt;khoá&gt; — không cần viết mã, không deploy.</p>
            <p>Khoá bắt đầu bằng «x_» và bất biến. Không xoá — «Lưu trữ» giữ nguyên bản ghi, field và form; đối tượng thôi hiện cho tới khi khôi phục.</p>
            <p>Người xem cần «Ứng dụng tuỳ biến: xem bản ghi» (và khoá siết của đối tượng nếu có); phạm vi dữ liệu lọc theo người phụ trách.</p>
          </div>
        }
      />
      {!appsOn ? (
        <EmptyState title="Module «Ứng dụng tuỳ biến» chưa bật" description="Bật ở Module của tổ chức trước — tắt module thì mọi đối tượng tuỳ biến ẩn khỏi menu và máy chủ từ chối đọc / ghi (định nghĩa và dữ liệu vẫn giữ nguyên)." />
      ) : null}
      <ObjectManager objects={r.objects} modules={modules} permissions={permissions} />
    </div>
  );
}

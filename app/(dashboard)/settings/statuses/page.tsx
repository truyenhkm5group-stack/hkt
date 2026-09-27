import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { AdminPicker } from "@/components/platform/metadata/admin-picker";
import { StatusOverridesEditor } from "@/components/platform/metadata/status-overrides-editor";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { objectDef } from "@/lib/constants/object-registry";
import { loadStatusEditor } from "@/lib/platform-ui/metadata-admin";
import { adminObjects } from "@/lib/platform-ui/metadata-admin-shared";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Trạng thái" };

const TITLE = "Trạng thái";

/**
 * TRẠNG THÁI HỆ THỐNG — tổ chức chỉ đổi NHÃN hiển thị, THỨ TỰ, và ẩn khỏi bộ lọc (M10). Giá trị và chuyển
 * trạng thái do Core sở hữu. Trạng thái NGHIỆP VỤ riêng của tổ chức là field kiểu «Trạng thái nghiệp vụ»
 * ở Mô hình dữ liệu.
 */
export default async function StatusesAdminPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("metadata:manage");
  const raw = await searchParams;
  const objects = adminObjects(user, "statuses");
  const businessHref = "/settings/data-model";
  if (!user.organization || objects.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title={TITLE} />
        {!user.organization ? (
          <EmptyState title="Chưa có thông tin tổ chức của phiên" description="Phiên đăng nhập này không mang tổ chức nào — đăng xuất rồi đăng nhập lại." />
        ) : (
          <EmptyState
            title="Chưa có trạng thái hệ thống nào cấu hình được"
            description="Không có đối tượng nào có trạng thái hệ thống mà module đang bật (vd Đơn hàng). Trạng thái nghiệp vụ riêng của tổ chức cấu hình ở Mô hình dữ liệu."
            action={
              <Link href={businessHref} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                Mở Mô hình dữ liệu
              </Link>
            }
          />
        )}
      </div>
    );
  }
  const current = objects.find((o) => o.key === param(raw, "object")) ?? objects[0];
  const fieldKey = current.statusFields.includes(param(raw, "field")) ? param(raw, "field") : current.statusFields[0];
  const loaded = await loadStatusEditor(user, current.key, fieldKey);
  const fieldLabel = (k: string) => objectDef(current.key)?.fields.find((f) => f.key === k)?.label ?? k;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={`${user.organization.name} · ${current.label} · ${fieldLabel(fieldKey)}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Trạng thái hệ thống do Core sở hữu — không thêm giá trị, không đổi chuyển trạng thái. Chỉ đổi nhãn hiển thị, thứ tự, và có hiện trong bộ lọc hay không.</p>
            <p>Đổi nhãn KHÔNG đổi dữ liệu, không đổi logistics, COD hay kết quả đơn (ORDER_OUTCOME). Lưu là có hiệu lực ở lần tải trang kế tiếp.</p>
          </div>
        }
        actions={
          <Link href={`${businessHref}?object=${current.key}`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Trạng thái nghiệp vụ riêng → Mô hình dữ liệu
          </Link>
        }
      />
      <div className="space-y-2">
        <AdminPicker label="Đối tượng" current={current.key} items={objects.map((o) => ({ key: o.key, label: o.label, href: `/settings/statuses?object=${o.key}` }))} />
        {current.statusFields.length > 1 ? (
          <AdminPicker label="Trạng thái" current={fieldKey} items={current.statusFields.map((k) => ({ key: k, label: fieldLabel(k), href: `/settings/statuses?object=${current.key}&field=${k}` }))} />
        ) : null}
      </div>
      {!loaded.ok ? (
        <EmptyState title="Không mở được trạng thái này" description={loaded.errors.map((e) => e.message).join(" · ")} />
      ) : loaded.value.rows.length === 0 ? (
        <EmptyState title="Không có giá trị trạng thái nào được khai" description="Sổ đối tượng không khai giá trị cho trạng thái này — báo đội kỹ thuật." />
      ) : (
        <SectionCard
          title={`${current.label} · ${loaded.value.fieldLabel}`}
          hint="Trạng thái hệ thống do Core sở hữu — không thêm giá trị, không đổi chuyển trạng thái. Nhãn để trống = dùng nhãn gốc."
          padded={false}
          contentClassName="p-3"
        >
          <StatusOverridesEditor key={`${current.key}:${fieldKey}`} objectKey={current.key} fieldKey={fieldKey} rows={loaded.value.rows} />
        </SectionCard>
      )}
    </div>
  );
}

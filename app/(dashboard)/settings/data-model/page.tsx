import { PageHeader } from "@/components/page-header";
import { AdminPicker } from "@/components/platform/metadata/admin-picker";
import { CustomFieldManager } from "@/components/platform/metadata/custom-field-manager";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { OBJECT_REGISTRY } from "@/lib/constants/object-registry";
import { FIELD_TYPE_LABEL, isCustomObjectKey } from "@/lib/metadata/types";
import { moduleOn } from "@/lib/platform-ui/module-visibility";
import { adminObjectsAll, loadDataModel } from "@/lib/platform-ui/metadata-admin";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Mô hình dữ liệu" };

const TITLE = "Mô hình dữ liệu";

/**
 * MÔ HÌNH DỮ LIỆU — field hệ thống (chỉ xem) và field tuỳ biến của từng đối tượng.
 *
 * Luôn là tổ chức CỦA NGƯỜI XEM. Chỉ đối tượng `customizable` có module đang bật hiện trong ô chọn.
 * Trạng thái NGHIỆP VỤ custom = field kiểu «Trạng thái nghiệp vụ» ở đây; trạng thái HỆ THỐNG thì đổi
 * nhãn ở `/settings/statuses`.
 */
export default async function DataModelPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("metadata:manage");
  const raw = await searchParams;
  const objects = await adminObjectsAll(user, "customFields");
  if (!user.organization || objects.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title={TITLE} />
        {!user.organization ? (
          <EmptyState title="Chưa có thông tin tổ chức của phiên" description="Phiên đăng nhập này không mang tổ chức nào — đăng xuất rồi đăng nhập lại." />
        ) : (
          <EmptyState title="Chưa có đối tượng nào cấu hình được" description="Module của các đối tượng (Khách hàng, Đơn hàng, Sản phẩm…) đang tắt với tổ chức — bật ở Module của tổ chức." />
        )}
      </div>
    );
  }
  const current = objects.find((o) => o.key === param(raw, "object")) ?? objects[0];
  const loaded = await loadDataModel(user, current.key);
  // Đích quan hệ: đối tượng của sổ tĩnh có module bật + đối tượng tuỳ biến ACTIVE (Phase 6 · mục 3).
  const relationTargets = [
    ...OBJECT_REGISTRY.filter((o) => moduleOn(user, o.module)).map((o) => ({ key: o.key, label: o.label })),
    ...objects.filter((o) => isCustomObjectKey(o.key)).map((o) => ({ key: o.key, label: `${o.label} (tuỳ biến)` })),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={`${user.organization.name} · ${current.label}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Field hệ thống là cột thật của ERP — chỉ xem ở đây. Field tuỳ biến là của riêng tổ chức, lưu tách khỏi dữ liệu đồng bộ nên Pancake / Viettel Post không bao giờ ghi đè.</p>
            <p>Khoá field bất biến. Không xoá field — «Lưu trữ» giữ nguyên giá trị đã nhập, chỉ thôi hiện và thôi nhận ghi.</p>
            <p>Trạng thái nghiệp vụ riêng của tổ chức = field kiểu «Trạng thái nghiệp vụ» (tự khai giá trị và chuyển trạng thái). Trạng thái hệ thống như trạng thái đơn chỉ đổi được nhãn, ở màn hình Trạng thái.</p>
          </div>
        }
      />
      <AdminPicker label="Đối tượng" current={current.key} items={objects.map((o) => ({ key: o.key, label: o.label, href: `/settings/data-model?object=${o.key}` }))} />
      {!loaded.ok ? (
        <EmptyState title="Không mở được cấu hình của đối tượng này" description={loaded.errors.map((e) => e.message).join(" · ")} />
      ) : (
        <>
          <SectionCard title="Field hệ thống" hint="Do mã nguồn khai, trỏ cột thật của bảng. Không thêm / sửa / ẩn ở đây; form và danh sách chọn được chúng." padded={false} contentClassName="p-3">
            <div className="overflow-x-auto rounded-xl border">
              {loaded.value.system.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Không có field hệ thống nào được khai cho đối tượng này.</p>
              ) : (
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Khoá</th>
                      <th className="px-3 py-2">Nhãn</th>
                      <th className="px-3 py-2">Kiểu</th>
                      <th className="px-3 py-2">Bắt buộc</th>
                      <th className="px-3 py-2">Sửa được</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaded.value.system.map((f) => (
                      <tr key={f.key} className="border-t border-hairline">
                        <td className="px-3 py-2 font-mono text-[12.5px]">{f.key}</td>
                        <td className="px-3 py-2">{f.label}</td>
                        <td className="px-3 py-2">{FIELD_TYPE_LABEL[f.type]}</td>
                        <td className="px-3 py-2">{f.required ? "Có" : "—"}</td>
                        <td className="px-3 py-2">{f.editable ? "Có" : <span className="text-muted-foreground">Không — chỉ đọc</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </SectionCard>
          <SectionCard title="Field tuỳ biến" hint="Kiểm hợp lệ chạy ở máy chủ mỗi lần ghi; câu lỗi hiện nguyên văn dưới đúng ô. Quyền xem / sửa (nếu khai) được máy chủ lọc khi đọc và chặn khi ghi." padded={false} contentClassName="p-3">
            <CustomFieldManager
              key={current.key}
              objectKey={current.key}
              objectLabel={current.label}
              fields={loaded.value.custom}
              systemKeys={loaded.value.system.map((f) => f.key)}
              relationTargets={relationTargets}
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}

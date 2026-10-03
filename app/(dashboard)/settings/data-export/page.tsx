import { Download } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { DATA_EXPORT_ENTRIES } from "@/lib/constants/data-export";
import { moduleOn } from "@/lib/platform-ui/module-visibility";

export const metadata = { title: "Xuất dữ liệu" };

/**
 * XUẤT DỮ LIỆU (docs/platform/data-export.md) — quản trị tổ chức tải dữ liệu của chính tổ chức ra CSV, lúc nào cũng được,
 * kể cả khi gói đã quá hạn. Chỉ liệt kê loại thuộc module đang bật. Cấu hình (module, vai trò, form…) là trang khác:
 * «Xuất cấu hình».
 */
export default async function DataExportPage() {
  const user = await requirePermission("settings:manage");
  const entries = DATA_EXPORT_ENTRIES.filter((e) => moduleOn(user, e.module));
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Xuất dữ liệu"
        description={user.organization?.name}
        refresh={false}
        hint="Dữ liệu của cửa hàng là của cửa hàng: tải ra tệp CSV (mở bằng Excel / Google Sheets) bất cứ lúc nào, kể cả khi gói đã quá hạn. Mỗi lượt tải được ghi vào nhật ký."
      />
      {entries.length === 0 ? (
        <EmptyState title="Chưa có dữ liệu nào để xuất" description="Tổ chức chưa bật module nào có dữ liệu xuất được." />
      ) : (
        <SectionCard title="Tải về" description="Mỗi tệp là TOÀN BỘ dữ liệu loại đó (không lọc theo kỳ). Tệp có tên, số điện thoại, địa chỉ khách — giữ cẩn thận.">
          <ul className="divide-y">
            {entries.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{e.label}</p>
                  <p className="text-xs text-muted-foreground">{e.description}</p>
                </div>
                <a href={e.href} className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted" data-export={e.key}>
                  <Download className="size-4" /> Tải CSV
                </a>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

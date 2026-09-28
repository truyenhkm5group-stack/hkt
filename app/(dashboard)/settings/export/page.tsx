import Link from "next/link";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { exportForUser } from "@/lib/blueprints/export";
import { BLUEPRINT_ITEM_KIND_LABEL } from "@/lib/blueprints/types";

export const metadata = { title: "Xuất cấu hình" };
export const dynamic = "force-dynamic";

/**
 * XUẤT CẤU HÌNH TỔ CHỨC (Phase 11 · H3). Trang CHỈ ĐỌC: dựng blueprint từ cấu hình hiện tại (`exportOrgBlueprint`) để
 * người xem thấy trước tệp sẽ mang gì, thiếu gì và vì sao; nút tải gọi route `/api/metadata/blueprint-export` (kiểm lại
 * quyền + tổ chức). Khôi phục = cài tệp đó vào tổ chức mới ở «Mẫu cấu hình» → «Cài từ tệp JSON».
 */
export default async function ExportPage() {
  const user = await requirePermission("metadata:manage");
  const loaded = await exportForUser(user);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Xuất cấu hình"
        description={user.organization?.name}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Tệp blueprint JSON mang CẤU HÌNH của tổ chức: module đang bật, vai trò tuỳ chỉnh, đối tượng tuỳ biến, field, trạng thái, form + danh sách + trang đã xuất bản, luật tự động, ngữ cảnh AI.</p>
            <p>Tệp KHÔNG mang bản ghi, giá trị field, người dùng, email hay bí mật kết nối. Sao lưu DỮ LIỆU là việc của bản sao CSDL hằng đêm, không phải tệp này.</p>
          </div>
        }
      />
      {!loaded.ok ? (
        <EmptyState title="Không xuất được cấu hình" description={loaded.error} />
      ) : (
        <>
          <SectionCard
            title="Tệp sẽ tải"
            description={`${loaded.value.blueprint.key} · phiên bản ${loaded.value.blueprint.version}`}
            actions={
              loaded.value.validation.ok ? (
                <a href="/api/metadata/blueprint-export" download className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  <Download className="size-4" /> Tải blueprint JSON
                </a>
              ) : null
            }
          >
            <div className="space-y-2 text-sm">
              <p>
                {loaded.value.counts.modules} module · {loaded.value.counts.roles} vai trò · {loaded.value.counts.objects} đối tượng · {loaded.value.counts.fields} field · {loaded.value.counts.statuses} trạng thái ·{" "}
                {loaded.value.counts.forms} form · {loaded.value.counts.lists} danh sách · {loaded.value.counts.pages} trang · {loaded.value.counts.workflows} luật · {loaded.value.counts.settings} cài đặt ·{" "}
                {loaded.value.counts.ai ? "có" : "không có"} ngữ cảnh AI
              </p>
              <p className="text-xs text-muted-foreground">
                Dấu vân tay nội dung: <span className="font-mono">{loaded.value.contentHash}</span> — hai tổ chức cùng cấu hình cho cùng dấu này (không tính tên / phiên bản của tệp).
              </p>
              {!loaded.value.validation.ok ? (
                <div className="rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200" role="alert">
                  <p className="font-medium">Cấu hình hiện tại chưa dựng được thành một gói hợp lệ — chưa tải được.</p>
                  {loaded.value.validation.errors.slice(0, 20).map((e, i) => (
                    <p key={i}>
                      <span className="font-mono">{e.path}</span>: {e.message}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="Khôi phục bằng tệp này" padded>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>Tạo tổ chức mới (hoặc mở tổ chức trống cần dựng lại cấu hình).</li>
              <li>
                Mở{" "}
                <Link href="/settings/templates" className="font-medium text-primary underline-offset-2 hover:underline">
                  Mẫu cấu hình
                </Link>{" "}
                → «Cài từ tệp JSON» → chọn tệp vừa tải.
              </li>
              <li>Máy kiểm tệp và lập kế hoạch từng thao tác (chưa ghi gì) → bạn xác nhận → cài bằng đúng bộ cài của mẫu ngành.</li>
              <li>Luật tự động luôn về NHÁP + CHẠY THỬ: bật lại từng luật sau khi kiểm. Người dùng, bí mật kết nối và dữ liệu phải nhập lại / khôi phục từ bản sao CSDL.</li>
            </ol>
          </SectionCard>

          <SectionCard title="Không đi theo tệp" description="Mục có trong tổ chức nhưng gói không mang — và vì sao" padded={false} contentClassName="p-3">
            {loaded.value.omitted.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Không có mục nào bị bỏ lại — mọi cấu hình đọc được đều vào tệp.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Loại</th>
                      <th className="px-3 py-2">Mục</th>
                      <th className="px-3 py-2">Vì sao</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaded.value.omitted.map((o, i) => (
                      <tr key={`${o.kind}:${o.key}:${i}`} className="border-t border-hairline align-top">
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{BLUEPRINT_ITEM_KIND_LABEL[o.kind]}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{o.key}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{o.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {loaded.value.lossy.length > 0 ? (
            <SectionCard title="Đi theo tệp nhưng thiếu một phần" padded={false} contentClassName="p-3">
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[640px] text-sm">
                  <tbody>
                    {loaded.value.lossy.map((o, i) => (
                      <tr key={`${o.kind}:${o.key}:${i}`} className="border-t border-hairline align-top first:border-t-0">
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{BLUEPRINT_ITEM_KIND_LABEL[o.kind]}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{o.key}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{o.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}

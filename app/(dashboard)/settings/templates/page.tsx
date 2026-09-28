import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { InstallHistoryTable } from "@/components/blueprints/install-history-table";
import { BlueprintFileInstall } from "@/components/blueprints/file-install";
import { Badge } from "@/components/ui/badge";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { loadTemplateCatalog } from "@/lib/blueprints/admin";

export const metadata = { title: "Mẫu cấu hình" };

/**
 * MẪU CẤU HÌNH — danh sách mẫu ngành + lịch sử cài của tổ chức NGƯỜI XEM (Phase 7 · §5).
 *
 * Trang chỉ đọc: cài / cập nhật ở trang của từng mẫu, sau khi xem trước. Mẫu không tự kích hoạt (luật 23) — không
 * mẫu nào được cài khi mở trang này.
 */
export default async function TemplatesPage() {
  const user = await requirePermission("metadata:manage");
  const loaded = await loadTemplateCatalog(user);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Mẫu cấu hình"
        description={user.organization?.name}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Một mẫu là một gói cấu hình: module cần bật, field tuỳ biến, form, danh sách, trang, luật tự động, vai trò và ngữ cảnh AI của ngành.</p>
            <p>Cài = Xem trước (máy liệt kê từng thao tác, chưa ghi gì) → Xác nhận. Máy chỉ gọi các màn hình cấu hình sẵn có; luật luôn sinh ở NHÁP + CHẠY THỬ.</p>
            <p>Nâng mẫu lên phiên bản mới không đè thứ tổ chức đã sửa và không dựng lại thứ đã xoá — những mục đó hiện riêng để bạn quyết.</p>
          </div>
        }
      />
      {!loaded.ok ? (
        <EmptyState title="Không mở được danh sách mẫu" description={loaded.errors.map((e) => e.message).join(" · ")} />
      ) : (
        <>
          {loaded.value.templates.length === 0 ? (
            <EmptyState title="Chưa có mẫu nào" description="Sổ mẫu của nền tảng đang rỗng." />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {loaded.value.templates.map((t) => (
                <SectionCard
                  key={t.key}
                  title={t.name}
                  description={`${t.industry ?? "Chung"} · phiên bản ${t.version}`}
                  actions={
                    t.installedVersion ? (
                      <Badge variant={t.updateAvailable ? "default" : "secondary"}>{t.updateAvailable ? `Có bản mới — đang ${t.installedVersion}` : `Đã cài ${t.installedVersion}`}</Badge>
                    ) : (
                      <Badge variant="outline">Chưa cài</Badge>
                    )
                  }
                >
                  <div className="space-y-3 text-sm">
                    <p className="text-muted-foreground">{t.description}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {t.modules.map((m) => (
                        <span key={m.key} className="rounded-full border px-2 py-0.5 text-[11.5px]">
                          {m.label}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t.counts.objects ? `${t.counts.objects} đối tượng tuỳ biến · ` : ""}
                      {t.counts.fields} field · {t.counts.forms} form · {t.counts.lists} danh sách · {t.counts.pages} trang · {t.counts.workflows} luật · {t.counts.roles} vai trò
                    </p>
                    <Link href={`/settings/templates/${encodeURIComponent(t.key)}`} className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline">
                      {t.updateAvailable ? "Xem trước bản cập nhật" : t.installedVersion ? "Xem lại / cài lại" : "Xem trước & cài"} <ArrowRight className="size-3.5" />
                    </Link>
                  </div>
                </SectionCard>
              ))}
            </div>
          )}
          <SectionCard
            title="Cài từ tệp JSON"
            description="Khôi phục cấu hình: tải lên tệp đã xuất ở «Xuất cấu hình» (của tổ chức này hoặc tổ chức khác) → máy kiểm và xem trước → bạn xác nhận"
          >
            <div className="space-y-2 text-sm">
              <p className="text-xs text-muted-foreground">
                Tệp đi đúng đường của một mẫu: kiểm định dạng, lập kế hoạch từng thao tác (chưa ghi gì), rồi mới cài khi bạn xác nhận. Tệp chỉ mang cấu hình — không bản ghi, không người dùng, không bí mật kết
                nối; luật luôn cài ở NHÁP + CHẠY THỬ. <Link href="/settings/export" className="font-medium text-primary underline-offset-2 hover:underline">Xuất cấu hình của tổ chức này</Link>
              </p>
              <BlueprintFileInstall />
            </div>
          </SectionCard>
          <SectionCard title="Lịch sử cài" description="Mỗi lượt cài / cập nhật của tổ chức — kể cả lượt dừng giữa chừng" padded={false} contentClassName="p-3">
            {loaded.value.history.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Chưa có lượt cài nào — tổ chức chưa cài mẫu nào.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <InstallHistoryTable rows={loaded.value.history} showTemplate />
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { InstallHistoryTable } from "@/components/blueprints/install-history-table";
import { InstallPanel } from "@/components/blueprints/install-panel";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { previewTemplate } from "@/lib/blueprints/admin";
import { decodeRouteParam } from "@/lib/route-param";

export const metadata = { title: "Xem trước mẫu" };

/**
 * XEM TRƯỚC + CÀI MỘT MẪU (Phase 7 · §5). Máy chủ lập kế hoạch (`planBlueprint` — chạy thử, không ghi) cho tổ chức của
 * NGƯỜI XEM; nút Cài gửi lại `planHash` để máy chủ lập lại kế hoạch và chỉ cài khi nó đúng bằng thứ đang hiện.
 */
export default async function TemplatePreviewPage({ params }: { params: Promise<{ key: string }> }) {
  const user = await requirePermission("metadata:manage");
  const { key } = await params;
  const loaded = await previewTemplate(user, decodeRouteParam(key));
  const back = (
    <Link href="/settings/templates" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-2 hover:underline">
      <ArrowLeft className="size-3.5" /> Mọi mẫu
    </Link>
  );
  if (!loaded.ok) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống · Mẫu cấu hình" title="Xem trước mẫu" actions={back} />
        <EmptyState title="Không mở được mẫu" description={loaded.errors.map((e) => e.message).join(" · ")} />
      </div>
    );
  }
  const { template, plan, history } = loaded.value;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống · Mẫu cấu hình"
        title={template.name}
        description={`${template.industry ?? "Chung"} · phiên bản ${template.version}${template.installedVersion ? ` · tổ chức đang ở ${template.installedVersion}` : " · chưa cài"}`}
        actions={back}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Bảng dưới là KẾ HOẠCH — máy chưa ghi gì. «Tạo mới» / «Cập nhật» là thứ sẽ ghi; «Không đổi» là thứ đã đúng.</p>
            <p>«Giữ bản tổ chức đã sửa» và «Trùng thứ có sẵn» mặc định BỎ QUA; bật «Ghi đè» từng mục nếu bạn muốn bản của mẫu.</p>
            <p>«Tổ chức đã bỏ» không bao giờ được dựng lại. «Bị chặn» phải xử lý trước khi cài (thiếu quyền, thiếu module, lỗi của mẫu).</p>
            <p>Trang / form / danh sách: lần cài đầu xuất bản ngay nếu mẫu khai; lần cập nhật chỉ ghi vào NHÁP — xuất bản là việc của bạn.</p>
          </div>
        }
      />
      <SectionCard title="Mẫu này gồm gì" padded>
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">{template.description}</p>
          <p>
            <b>Module:</b> {template.modules.map((m) => m.label).join(" · ")}
          </p>
          {template.objects.length ? (
            <p>
              <b>Đối tượng tuỳ biến (tạo mới, module «Ứng dụng tuỳ biến»):</b> {template.objects.map((o) => `${o.label} (${o.key})`).join(", ")}
            </p>
          ) : null}
          <p>
            <b>Field tuỳ biến trên:</b> {template.fieldObjects.join(", ") || "—"} · <b>Trang:</b> {template.pages.map((p) => p.name).join(", ") || "—"} · <b>Luật (NHÁP):</b>{" "}
            {template.workflows.map((w) => w.name).join(", ") || "—"}
          </p>
          {template.integrations.length ? (
            <div>
              <b>Gợi ý kết nối</b> (mẫu KHÔNG cấu hình thông tin đăng nhập nào — bạn tự kết nối nếu cần):
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {template.integrations.map((i) => (
                  <li key={i.connectorKey}>
                    {i.label}: {i.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SectionCard>
      <InstallPanel templateKey={template.key} initialPlan={plan} />
      <SectionCard title="Lịch sử cài mẫu này" padded={false} contentClassName="p-3">
        {history.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Chưa có lượt cài nào của mẫu này.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <InstallHistoryTable rows={history} />
          </div>
        )}
      </SectionCard>
    </div>
  );
}

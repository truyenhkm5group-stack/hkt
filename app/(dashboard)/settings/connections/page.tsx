import { PageHeader } from "@/components/page-header";
import { ConnectorGroupTable } from "@/components/connectors/connector-group-table";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { CONNECTIONS_PERMISSION, loadConnectionsView } from "@/lib/connectors/service";
import { getBrandCopy } from "@/lib/branding/service";

export const metadata = { title: "Kết nối theo tổ chức" };

const TITLE = "Kết nối theo tổ chức";

/**
 * KẾT NỐI THEO TỔ CHỨC — sổ connector (docs/platform/phase-9-contracts.md §1–2).
 *
 * Luôn là tổ chức CỦA NGƯỜI XEM (phiên do máy chủ ký). Ba loại dòng:
 *  · connector chỉ tổ chức nhà (HOME_ONLY): tổ chức nhà thấy CHỈ ĐỌC — đã cấu hình hay chưa, không một ký tự bí mật
 *    nào; tổ chức khác thấy "chưa mở";
 *  · connector theo tổ chức lưu ở `org_connections`: form, Kiểm tra, Bật / Tắt — bật chỉ sau khi Kiểm tra đạt;
 *  · connector theo tổ chức cấu hình ở màn hình nghiệp vụ khác (link ở dòng).
 */
export default async function ConnectionsPage() {
  const user = await requirePermission(CONNECTIONS_PERMISSION);
  const [view, copy] = await Promise.all([loadConnectionsView(user), getBrandCopy(user)]);
  if ("error" in view) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title={TITLE} />
        <EmptyState title="Chưa mở được danh sách kết nối" description={view.error} />
      </div>
    );
  }
  const total = view.groups.reduce((n, g) => n + g.rows.length, 0);
  const configurable = view.groups.flatMap((g) => g.rows).filter((r) => r.mode === "CONFIGURABLE");
  const active = configurable.filter((r) => r.connection?.status === "ACTIVE").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={`${view.organization.name} · ${total} connector trong sổ · ${active}/${configurable.length} kết nối của tổ chức đang bật`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>{copy.text("connections.homeIntegrations")}</p>
            <p>Kết nối «theo tổ chức» do chính tổ chức khai: bí mật mã hoá trong CSDL của tổ chức, chỉ hiện •••• + 4 ký tự cuối. Lưu ⇒ về Nháp; Kiểm tra gửi một yêu cầu thật; Bật chỉ được sau khi Kiểm tra đạt.</p>
            <p>Mọi lượt lưu / kiểm tra / bật / tắt ghi vào Nhật ký hệ thống (không kèm bí mật).</p>
          </div>
        }
      />
      {!view.secretsReady.ok ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          ⚠ Chưa lưu được bí mật kết nối: {view.secretsReady.reason}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-secrets-key-status="ready">
          Khoá mã hoá bí mật kết nối của máy chủ: sẵn sàng · mã khoá <span className="font-mono">{view.secretsReady.keyIdShort}</span> (không phải khoá — chỉ để biết khoá có đổi hay không).
        </p>
      )}
      {view.groups.length === 0 ? (
        <EmptyState title="Chưa có connector nào trong sổ" description="Sổ connector của mã nguồn rỗng — không nên xảy ra; báo đội kỹ thuật." />
      ) : (
        view.groups.map((g) => (
          <SectionCard key={g.kind} title={g.label} description={`${g.rows.length} connector`} padded={false} contentClassName="overflow-x-auto p-0">
            <ConnectorGroupTable rows={g.rows} secretsReady={view.secretsReady.ok} />
          </SectionCard>
        ))
      )}
    </div>
  );
}

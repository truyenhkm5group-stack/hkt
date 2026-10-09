import { PageHeader } from "@/components/page-header";
import { ConnectorGroupTable } from "@/components/connectors/connector-group-table";
import { OrgCarrierPanel } from "@/components/connectors/org-carrier-panel";
import { OrgGhnPanel } from "@/components/connectors/org-ghn-panel";
import { OrgGhtkPanel } from "@/components/connectors/org-ghtk-panel";
import { LegacyConnections } from "@/components/connectors/legacy-connections";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { CONNECTIONS_PERMISSION, loadConnectionsView } from "@/lib/connectors/service";
import { splitLegacyConnectors } from "@/lib/connectors/legacy";
import { getBrandCopy } from "@/lib/branding/service";
import { moduleOn } from "@/lib/platform-ui/module-visibility";
import { isSalesAgentUser } from "@/lib/constants/saas-nav";
import Link from "next/link";

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
  // Vỏ Chốt Đơn: cùng sổ kết nối, cùng nút, câu chữ của chủ shop (không «connector» / «module» / «ERP») — chỉ trình bày.
  const shell = isSalesAgentUser(user);
  const title = shell ? "Kết nối" : TITLE;
  const [view, copy] = await Promise.all([loadConnectionsView(user), getBrandCopy(user)]);
  if ("error" in view) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow={shell ? undefined : "Hệ thống"} title={title} />
        <EmptyState title="Chưa mở được danh sách kết nối" description={view.error} />
      </div>
    );
  }
  const total = view.groups.reduce((n, g) => n + g.rows.length, 0);
  // Tổ chức khách: Pancake là kết nối CŨ / CHUYỂN ĐỔI (lib/connectors/legacy.ts) — rời bảng chính về mục cuối trang.
  const split = splitLegacyConnectors(view);
  /*
    Vỏ Chốt Đơn (C1 #7): bảng chỉ có kết nối THUỘC GÓI của cửa hàng. Dòng mà module chưa bật (Viettel Post · GHN · GHTK · Google
    Sheet · quảng cáo…) chỉ in được «Chưa có trong gói» — với chủ shop bán qua fanpage nó đọc như một việc phải làm, và lộ những
    tích hợp vận hành của ERP. Không đổi quyền: dòng ấy vốn không lưu / kiểm tra / bật được (server action từ chối khi module tắt).
    Đếm «đang bật» trên ĐÚNG các dòng người này thấy.
  */
  const groups = shell ? split.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.moduleEnabled) })).filter((g) => g.rows.length > 0) : split.groups;
  const configurable = (shell ? groups : view.groups).flatMap((g) => g.rows).filter((r) => r.mode === "CONFIGURABLE");
  const active = configurable.filter((r) => r.connection?.status === "ACTIVE").length;
  const directFacebook = !view.organization.isHome && moduleOn(user, "ai_sales");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={shell ? undefined : "Hệ thống"}
        title={title}
        description={shell ? `${view.organization.name} · ${active}/${configurable.length} kết nối đang bật` : `${view.organization.name} · ${total} connector trong sổ · ${active}/${configurable.length} kết nối của tổ chức đang bật`}
        hint={
          shell ? (
            <div className="space-y-1.5 text-xs leading-5">
              <p>Mật khẩu / khoá của kết nối được mã hoá, chỉ hiện •••• + 4 ký tự cuối. Lưu ⇒ về Nháp; «Kiểm tra» thử kết nối thật; «Bật» chỉ được sau khi Kiểm tra đạt.</p>
              <p>Mọi lượt lưu / kiểm tra / bật / tắt đều được ghi lại (không kèm mật khẩu).</p>
            </div>
          ) : (
          <div className="space-y-1.5 text-xs leading-5">
            <p>{copy.text("connections.homeIntegrations")}</p>
            <p>Kết nối «theo tổ chức» do chính tổ chức khai: bí mật mã hoá trong CSDL của tổ chức, chỉ hiện •••• + 4 ký tự cuối. Lưu ⇒ về Nháp; Kiểm tra gửi một yêu cầu thật; Bật chỉ được sau khi Kiểm tra đạt.</p>
            <p>Mọi lượt lưu / kiểm tra / bật / tắt ghi vào Nhật ký hệ thống (không kèm bí mật).</p>
          </div>
          )
        }
      />
      {!view.secretsReady.ok ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          ⚠ Chưa lưu được bí mật kết nối: {view.secretsReady.reason}
        </div>
      ) : view.secretsReady.keyIdShort ? (
        // Mã khoá mã hoá của máy chủ là thông tin vận hành — chỉ workspace nhà nhận (khách: `keyIdShort = null`, lib/saas/visibility.ts).
        <p className="text-xs text-muted-foreground" data-secrets-key-status="ready">
          Khoá mã hoá bí mật kết nối của máy chủ: sẵn sàng · mã khoá <span className="font-mono">{view.secretsReady.keyIdShort}</span> (không phải khoá — chỉ để biết khoá có đổi hay không).
        </p>
      ) : null}
      {directFacebook ? (
        <SectionCard title="Facebook · Instagram — nối thẳng, không cần phần mềm chat trung gian" description={shell ? "Cách khuyên dùng cho shop bán qua Facebook: chủ page bấm Kết nối Facebook, chọn page — tin khách về Hộp thư, bot AI trả lời, nhân viên tiếp quản ngay trong ứng dụng." : "Cách khuyên dùng cho shop bán qua Facebook: chủ page bấm Kết nối Facebook, chọn page — tin khách về Hộp thư ERP, bot AI trả lời, nhân viên tiếp quản ngay trong ERP."}>
          <Link href="/ai/sales-chatbot/messenger" className="text-sm font-semibold text-primary hover:underline" data-testid="connections-direct-facebook">
            Mở Kết nối Facebook →
          </Link>
        </SectionCard>
      ) : null}
      {view.organization.isHome ? null : <OrgCarrierPanel orgCode={view.organization.code} />}
      {view.organization.isHome ? null : <OrgGhnPanel orgCode={view.organization.code} />}
      {view.organization.isHome ? null : <OrgGhtkPanel orgCode={view.organization.code} />}
      {groups.length === 0 ? (
        <EmptyState title={shell ? "Chưa có kết nối nào" : "Chưa có connector nào trong sổ"} description={shell ? "Gói hiện tại của cửa hàng chưa có kết nối nào cần khai ở đây." : "Sổ connector của mã nguồn rỗng — không nên xảy ra; báo đội kỹ thuật."} />
      ) : (
        groups.map((g) => (
          <SectionCard key={g.kind} title={g.label} description={shell ? `${g.rows.length} kết nối` : `${g.rows.length} connector`} padded={false} contentClassName="overflow-x-auto p-0">
            <ConnectorGroupTable rows={g.rows} secretsReady={view.secretsReady.ok} plain={shell} />
          </SectionCard>
        ))
      )}
      {view.organization.isHome ? null : <LegacyConnections orgCode={view.organization.code} rows={split.legacy} open={split.legacyInUse} secretsReady={view.secretsReady.ok} plain={shell} />}
    </div>
  );
}

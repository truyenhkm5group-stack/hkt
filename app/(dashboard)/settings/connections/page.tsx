import { PageHeader } from "@/components/page-header";
import { ConnectorGroupTable } from "@/components/connectors/connector-group-table";
import { OrgCarrierPanel } from "@/components/connectors/org-carrier-panel";
import { OrgGhnPanel } from "@/components/connectors/org-ghn-panel";
import { OrgGhtkPanel } from "@/components/connectors/org-ghtk-panel";
import { OrgPosPanel } from "@/components/connectors/org-pos-panel";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { CONNECTIONS_PERMISSION, loadConnectionsView } from "@/lib/connectors/service";
import { splitLegacyConnectors } from "@/lib/connectors/legacy";
import { getBrandCopy } from "@/lib/branding/service";
import { moduleOn } from "@/lib/platform-ui/module-visibility";
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
  // Tổ chức khách: Pancake là kết nối CŨ / CHUYỂN ĐỔI (lib/connectors/legacy.ts) — rời bảng chính về mục cuối trang.
  const split = splitLegacyConnectors(view);
  const directFacebook = !view.organization.isHome && moduleOn(user, "ai_sales");

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
      {directFacebook ? (
        <SectionCard title="Facebook · Instagram — nối thẳng, không cần Pancake" description="Cách khuyên dùng cho shop bán qua Facebook: chủ page bấm Kết nối Facebook, chọn page — tin khách về Hộp thư ERP, bot AI trả lời, nhân viên tiếp quản ngay trong ERP.">
          <Link href="/ai/sales-chatbot/messenger" className="text-sm font-semibold text-primary hover:underline" data-testid="connections-direct-facebook">
            Mở Kết nối Facebook →
          </Link>
        </SectionCard>
      ) : null}
      {view.organization.isHome ? null : <OrgCarrierPanel orgCode={view.organization.code} />}
      {view.organization.isHome ? null : <OrgGhnPanel orgCode={view.organization.code} />}
      {view.organization.isHome ? null : <OrgGhtkPanel orgCode={view.organization.code} />}
      {split.groups.length === 0 ? (
        <EmptyState title="Chưa có connector nào trong sổ" description="Sổ connector của mã nguồn rỗng — không nên xảy ra; báo đội kỹ thuật." />
      ) : (
        split.groups.map((g) => (
          <SectionCard key={g.kind} title={g.label} description={`${g.rows.length} connector`} padded={false} contentClassName="overflow-x-auto p-0">
            <ConnectorGroupTable rows={g.rows} secretsReady={view.secretsReady.ok} />
          </SectionCard>
        ))
      )}
      {view.organization.isHome ? null : (
        <details open={split.legacyInUse} className="group space-y-3 rounded-xl border bg-muted/20 p-4" data-testid="connections-legacy">
          <summary className="cursor-pointer select-none text-sm font-semibold">
            Kết nối cũ / chuyển đổi — Pancake <span className="font-normal text-muted-foreground">· chỉ cho shop ĐANG dùng Pancake; shop mới không cần</span>
          </summary>
          <p className="text-xs leading-5 text-muted-foreground">
            Đang dùng Pancake và muốn chuyển: nối Facebook trực tiếp ở trên, kiểm tin vào Hộp thư ERP, rồi tắt kết nối Pancake của page đó (một page chỉ nhận tin qua một đường). Đồng bộ đơn Pancake POS là kết nối riêng — giữ hay bỏ tuỳ shop.
          </p>
          <OrgPosPanel orgCode={view.organization.code} />
          {split.legacy.length ? (
            <SectionCard title="Kết nối Pancake" description={`${split.legacy.length} connector`} padded={false} contentClassName="overflow-x-auto p-0">
              <ConnectorGroupTable rows={split.legacy} secretsReady={view.secretsReady.ok} />
            </SectionCard>
          ) : null}
        </details>
      )}
    </div>
  );
}

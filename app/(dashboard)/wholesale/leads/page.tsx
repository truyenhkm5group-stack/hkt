import Link from "next/link";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { assignableUsers, listWholesaleLeads, WHOLESALE_LEAD_FILTERS, WHOLESALE_LEAD_SORTABLE, wholesaleLeadFacets } from "@/lib/queries/wholesale";
import { LEAD_SOURCE_LABEL, LEAD_SOURCES } from "@/lib/wholesale/constants";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { GoogleAttribution, WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { LeadsTable } from "@/app/(dashboard)/wholesale/leads/leads-table";
import { fieldHandoffOptions } from "@/lib/wholesale/field-handoff";
import { EMAIL_FILTER_OPTIONS } from "@/lib/constants/wholesale-email";
import { EmailDiscoveryButton } from "@/app/(dashboard)/wholesale/leads/email-discovery-button";
import { ImportForm } from "@/app/(dashboard)/wholesale/leads/import-form";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { getEmailAiSettings } from "@/lib/wholesale/email-ai-draft";

export const metadata = { title: "Khách sỉ tiềm năng" };

export default async function WholesaleLeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Khách sỉ tiềm năng" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "leadScore", filterKeys: WHOLESALE_LEAD_FILTERS, sortable: WHOLESALE_LEAD_SORTABLE, defaultPeriod: "all", defaultPageSize: 50 });
  const canAssign = can(user, "wholesale:assign");
  const [{ rows, total, pageCount }, facets, users, handoff, cfg, aiEmail] = await Promise.all([listWholesaleLeads(params, decision, user.id), wholesaleLeadFacets(decision), canAssign ? assignableUsers() : Promise.resolve([]), fieldHandoffOptions(), getLeadHunterConfig(), getEmailAiSettings()]);
  // Mẫu thân thư cho «Email» / «Soạn email cho N khách»: lời chào gốc + mẫu thêm kênh Email / mọi kênh (khung Mẫu nội dung).
  const emailTemplates = [{ id: "__opener", label: "Lời chào (mẫu gốc)" }, ...cfg.outreach.extraTemplates.filter((t) => t.channel !== "ZALO").map((t) => ({ id: t.id, label: t.label }))];
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Khách sỉ tiềm năng"
        description="Nhà hàng, quán, khách sạn, cửa hàng thực phẩm chưa mua — xếp theo điểm phù hợp. Mở một lead để gọi, ghi chú, gửi lời chào, chuyển thành khách."
        hint="Điểm 0–100 tính theo luật cố định (ngành, quy mô, liên hệ được, vị trí, chất lượng dữ liệu, kết quả bán của nhóm) — mở lead để xem lý do từng phần. Lead bị lọc / trùng không hiện ở đây; chọn «Hiển thị: Bị lọc / trùng» để xem."
      />
      <WholesaleNav user={user} active="leads" />
      <Link href="/wholesale/mobile" className="flex min-h-12 items-center justify-center rounded-xl bg-primary text-base font-semibold text-primary-foreground md:hidden">
        📱 Mở giao diện gọi khách trên điện thoại
      </Link>
      {can(user, "wholesale:scan") ? (
        <div className="flex flex-wrap items-start gap-2">
          <EmailDiscoveryButton />
          {/* Dời từ trang Săn khách (30/10/2026): nhập lead là việc của danh sách lead, không phải của chiến dịch quét. */}
          <details className="group rounded-md border px-3 py-1.5 text-sm open:w-full open:p-3">
            <summary className="cursor-pointer font-medium">Nhập từ tệp</summary>
            <p className="mt-2 text-xs text-muted-foreground">Danh bạ tự có, hội chợ, đối tác giới thiệu. Cột: Tên, SĐT, Địa chỉ, Tỉnh, Khu vực, Website, Email, Loại hình, Ghi chú (chỉ cột Tên là bắt buộc). Trùng SĐT / website / tên + địa chỉ với lead đã có ⇒ bỏ qua.</p>
            <div className="mt-2">
              <ImportForm />
            </div>
          </details>
        </div>
      ) : null}
      <DataTableToolbar
        searchPlaceholder="Tên, địa chỉ, SĐT…"
        period={false}
        facets={[
          { key: "grade", label: "Hạng", options: ["A", "B", "C", "D"].map((g) => ({ value: g, label: `Hạng ${g}` })) },
          {
            key: "contact",
            label: "Liên hệ",
            options: [
              { value: "phone", label: "Có SĐT" },
              { value: "website", label: "Có website" },
              { value: "never", label: "Chưa liên hệ lần nào" },
              { value: "due", label: "Đến hạn gọi lại" },
            ],
          },
          { key: "email", label: "Email", options: EMAIL_FILTER_OPTIONS },
          { key: "status", label: "Trạng thái", options: facets.status },
          { key: "province", label: "Tỉnh / thành", options: facets.province },
          { key: "segment", label: "Nhóm khách", options: facets.segment },
          { key: "campaign", label: "Chiến dịch", options: facets.campaign },
          { key: "assignee", label: "Phụ trách", options: facets.assignee },
          { key: "source", label: "Nguồn", options: LEAD_SOURCES.map((s) => ({ value: s, label: LEAD_SOURCE_LABEL[s] })) },
          {
            key: "view",
            label: "Hiển thị",
            single: true,
            options: [
              { value: "active", label: "Lead sẵn sàng" },
              { value: "pending", label: "Đang lấy chi tiết" },
              { value: "filtered", label: "Bị lọc / trùng / lỗi" },
              { value: "all", label: "Tất cả" },
            ],
          },
        ]}
        resultLabel={`${formatNumber(total)} lead`}
      >
        <GoogleAttribution />
      </DataTableToolbar>
      <LeadsTable rows={rows} pageCount={pageCount} total={total} users={users} campaigns={facets.campaign} canAssign={canAssign} canWork={can(user, "wholesale:work")} handoff={handoff} emailTemplates={emailTemplates} aiEmailEnabled={aiEmail.enabled} />
    </div>
  );
}

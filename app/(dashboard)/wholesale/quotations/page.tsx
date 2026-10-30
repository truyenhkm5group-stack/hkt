import Link from "next/link";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { listQuotations, QUOTATION_FILTERS, QUOTATION_SORTABLE } from "@/lib/queries/wholesale-quotations";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { QUOTATION_STATUS_LABEL, QUOTATION_STATUSES } from "@/lib/wholesale/quotation-engine";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { QuotationsTable } from "@/app/(dashboard)/wholesale/quotations/quotations-table";
import { QuotationPolicyPanel } from "@/app/(dashboard)/wholesale/quotations/policy-panel";
import { loadQuotationPolicyView } from "@/lib/wholesale/quotation-policy";
import { ReorderSettingsForm } from "@/app/(dashboard)/wholesale/quotations/reorder-settings-form";
import { getWholesaleReorderSettings } from "@/lib/wholesale/reorder";

export const metadata = { title: "Báo giá sỉ" };

/**
 * BÁO GIÁ SỈ (docs/tech/hslc-b2b-sales-agent.md · P1b). Mỗi dòng là bản MỚI NHẤT của một mã báo giá; bản cũ («Đã có bản mới»)
 * xem bằng bộ lọc trạng thái. Số tiền là số đã ghi lúc lập phiên bản — trang không tính lại. Lập báo giá từ trang một lead hoặc
 * một khách (nút «Tạo báo giá»).
 */
export default async function WholesaleQuotationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("wholesale:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "createdAt", defaultDir: "desc", filterKeys: QUOTATION_FILTERS, sortable: [...QUOTATION_SORTABLE], defaultPageSize: 50 });
  // Cài đặt báo giá (trần CK · biên LN tối thiểu · thuế) chỉ cho người có quyền cấu hình Săn khách sỉ; lượt đọc không ghi gì.
  const [data, policyView, reorder] = await Promise.all([listQuotations(user, params), can(user, "wholesale:config") ? loadQuotationPolicyView() : Promise.resolve(null), can(user, "wholesale:config") ? getWholesaleReorderSettings() : Promise.resolve(null)]);
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Báo giá sỉ"
        description={"unavailable" in data ? "CSDL của tổ chức chưa áp migration 0263 — chưa lập được báo giá." : `${formatNumber(data.total)} báo giá · ${formatNumber(data.counts.PENDING_APPROVAL ?? 0)} chờ duyệt · ${formatNumber(data.counts.SENT ?? 0)} đã gửi khách · ${formatNumber(data.counts.ACCEPTED ?? 0)} khách chấp nhận.`}
        hint="Số trên báo giá do máy tính tất định từ bảng giá sỉ (bảng riêng của khách → bảng mặc định), không do AI. Giá lẻ không phải giá sỉ: mẫu mã không có bậc sỉ hoặc dưới MOQ thì báo giá bị chặn. Tồn chưa có phiếu nhập là «chưa xác minh», không phải hết hàng. Ship / thuế chưa khai thì tổng ghi rõ «chưa gồm». Sửa một báo giá là tạo phiên bản mới — bản đã gửi không bao giờ đổi số."
      />
      <WholesaleNav user={user} active="quotations" />
      {reorder ? <ReorderSettingsForm afterDays={reorder.afterDays} /> : null}
      {policyView ? <QuotationPolicyPanel policy={policyView.policy} declared={policyView.declared} suggestion={policyView.suggestion} activeLists={policyView.activeLists} /> : null}
      {"unavailable" in data ? (
        <EmptyState title="Chưa dùng được báo giá sỉ" description="CSDL của tổ chức chưa áp migration 0263 (báo giá sỉ). Phần còn lại của Săn khách sỉ chạy bình thường." />
      ) : (
        <>
          <DataTableToolbar
            searchPlaceholder="Mã báo giá, tên khách…"
            period={false}
            facets={[{ key: "status", label: "Trạng thái", options: QUOTATION_STATUSES.map((s) => ({ value: s, label: `${QUOTATION_STATUS_LABEL[s]} (${formatNumber(data.counts[s] ?? 0)})` })) }]}
            resultLabel={`${formatNumber(data.total)} báo giá`}
          />
          {data.total === 0 ? (
            <EmptyState
              title="Chưa có báo giá nào"
              description={
                <>
                  Mở một <Link href="/wholesale/leads" className="underline">lead khách sỉ</Link> hoặc một khách hàng rồi bấm «Tạo báo giá».
                </>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <QuotationsTable rows={data.rows} total={data.total} pageCount={data.pageCount} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

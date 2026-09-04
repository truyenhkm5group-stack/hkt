import { Headset, Inbox, MapPinOff, Ruler } from "lucide-react";
import { CaseDialog } from "@/app/(dashboard)/cs/case-dialog";
import { CsTable, DetectButton } from "@/app/(dashboard)/cs/cs-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { CS_KIND_LABEL, CS_KINDS, CS_STATUS_LABEL, CS_STATUSES } from "@/lib/constants/cs";
import { formatNumber } from "@/lib/format";
import { CS_SORTABLE, csFacets, csSummary, listCsCases } from "@/lib/queries/cs";
import { listEmployees } from "@/lib/queries/payroll";
import { listUsers } from "@/lib/queries/users";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "CSKH" };

export default async function CsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("orders:read");
  const canWrite = can(user, "cs:manage");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["kind", "status", "assignee"], sortable: CS_SORTABLE, defaultPeriod: "all" });
  const [{ rows, total, pageCount }, facets, summary, employees, users] = await Promise.all([listCsCases(params), csFacets(params), csSummary(), listEmployees(), listUsers()]);
  const assignees = [...new Set([...employees.filter((e) => e.active).map((e) => e.shortName || e.name), ...users.rows.filter((u) => u.active).map((u) => u.name), ...facets.assignees.map((a) => a.value)])].filter(Boolean).sort();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="CSKH · Case chăm sóc khách hàng"
        description="Đổi size, đổi màu, sai địa chỉ, sai SĐT, trả hàng, khiếu nại. Tự phát hiện từ thẻ đơn, ghi chú đơn và phiếu đổi/trả trên Pancake (mỗi 10 phút và sau webhook), hoặc nhập tay. Case mới được đưa lên chuông và nhóm Lark."
        actions={canWrite ? (<><DetectButton /><CaseDialog assignees={assignees} /></>) : null}
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Đang mở" value={formatNumber(summary.open)} note={`${formatNumber(summary.new)} case mới chưa ai nhận`} icon={Inbox} tone={summary.new ? "rose" : "slate"} />
        <MetricCard label="Đổi size / màu" value={formatNumber((summary.byKind.EXCHANGE_SIZE ?? 0) + (summary.byKind.EXCHANGE_COLOR ?? 0))} note="Đang mở" icon={Ruler} tone="amber" />
        <MetricCard label="Sai địa chỉ / SĐT" value={formatNumber((summary.byKind.WRONG_ADDRESS ?? 0) + (summary.byKind.WRONG_PHONE ?? 0))} note="Cần sửa trên Pancake trước khi giao" icon={MapPinOff} tone="amber" />
        <MetricCard label="Trả hàng / khiếu nại" value={formatNumber((summary.byKind.RETURN ?? 0) + (summary.byKind.COMPLAINT ?? 0))} note="Đang mở" icon={Headset} tone="blue" />
      </section>
      <DataTableToolbar
        searchPlaceholder="Tên khách, SĐT, nội dung…"
        period={{ defaultKey: "all" }}
        facets={[
          { key: "status", label: "Trạng thái", options: CS_STATUSES.map((s) => ({ value: s, label: CS_STATUS_LABEL[s], count: facets.statuses.find((x) => x.value === s)?.count ?? 0 })) },
          { key: "kind", label: "Loại", options: CS_KINDS.map((k) => ({ value: k, label: CS_KIND_LABEL[k], count: facets.kinds.find((x) => x.value === k)?.count ?? 0 })) },
          { key: "assignee", label: "Phụ trách", options: facets.assignees },
        ]}
        resultLabel={`${formatNumber(total)} case phù hợp`}
      />
      <SectionCard padded={false}>
        <CsTable rows={rows} assignees={assignees} canWrite={canWrite} />
        <div className="border-t px-4 py-2">
          <UrlPagination pageCount={pageCount} total={total} />
        </div>
      </SectionCard>
    </div>
  );
}

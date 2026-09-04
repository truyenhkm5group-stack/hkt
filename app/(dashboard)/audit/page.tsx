import { AuditTable } from "@/app/(dashboard)/audit/audit-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { AUDIT_SORTABLE, auditFacets, listAuditLogs } from "@/lib/queries/audit";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Nhật ký hệ thống" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  await requirePermission("audit:view");
  const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["action", "entity"], sortable: AUDIT_SORTABLE, defaultPeriod: "7d" });
  const [{ rows, total, pageCount }, facets] = await Promise.all([listAuditLogs(params), auditFacets(params)]);

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Hệ thống" title="Nhật ký hệ thống" description={`Ai đã làm gì, khi nào · ${params.period.label.toLowerCase()} · ${formatNumber(total)} bản ghi`} />
      <DataTableToolbar
        searchPlaceholder="Email người dùng, mã đối tượng…"
        period={{ defaultKey: "7d" }}
        facets={[
          { key: "action", label: "Hành động", options: facets.actions },
          { key: "entity", label: "Đối tượng", options: facets.entities },
        ]}
        resultLabel={`${formatNumber(total)} bản ghi phù hợp`}
      />
      <AuditTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

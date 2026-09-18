import { TechIncidentForm } from "@/app/(dashboard)/tech/incidents/incident-form";
import { TechIncidentsTable } from "@/app/(dashboard)/tech/incidents/incidents-table";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_INCIDENT_SORTABLE } from "@/lib/constants/tech";
import { formatNumber } from "@/lib/format";
import { techOverviewCounts } from "@/lib/queries/tech";
import { listTechIncidents, techIncidentFacets } from "@/lib/queries/tech-ops";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Sự cố" };

export default async function TechIncidentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const params = parseListParams(raw, { defaultSort: "detectedAt", filterKeys: ["status", "severity", "module", "open"], sortable: TECH_INCIDENT_SORTABLE, defaultPeriod: "90d" });
  const [{ rows, total, pageCount }, facets, counts] = await Promise.all([listTechIncidents(params), techIncidentFacets(params), techOverviewCounts()]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Sự cố"
        description={`${formatNumber(counts.incidents.open)} đang mở · ${formatNumber(counts.incidents.sev01)} ở mức SEV0/SEV1 · ${formatNumber(total)} trong ${params.period.label.toLowerCase()}`}
        hint={
          <>
            Vòng đời: mở → điều tra → giảm thiểu → theo dõi → đóng. Đóng bắt buộc kể được <b>đã làm
            gì</b> để sự cố hết. <b>Nguyên nhân gốc thì KHÔNG bắt buộc</b>: chưa chứng minh được thì
            để trống — ép điền chỉ đẻ ra những câu nghe hợp lý mà không ai kiểm được. Một sự cố tái
            phát thì quay lại “đang điều tra”, không mở sự cố mới (mở mới là làm mất dòng thời gian
            của lần đầu).
          </>
        }
        actions={canManage ? <TechIncidentForm /> : null}
      />

      <TechNav />

      <DataTableToolbar
        searchPlaceholder="Mã sự cố, tiêu đề, bằng chứng…"
        period={{ defaultKey: "90d" }}
        facets={[
          { key: "status", label: "Trạng thái", options: facets.status },
          { key: "severity", label: "Mức nặng", options: facets.severity },
        ]}
        resultLabel={`${formatNumber(total)} sự cố`}
      />

      <TechIncidentsTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

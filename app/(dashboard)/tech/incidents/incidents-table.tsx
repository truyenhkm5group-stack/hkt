"use client";

import { techIncidentColumns } from "@/app/(dashboard)/tech/incidents/columns";
import { DataTable } from "@/components/data-table/data-table";
import { TECH_INCIDENT_SORTABLE } from "@/lib/constants/tech";
import type { TechIncidentListRow } from "@/lib/queries/tech-ops";

export function TechIncidentsTable({ rows, pageCount, total }: { rows: TechIncidentListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={techIncidentColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      rowHref={(row) => `/tech/incidents/${row.id}`}
      defaultSort="detectedAt"
      sortable={TECH_INCIDENT_SORTABLE}
      dense
      emptyTitle="Không có sự cố nào khớp bộ lọc"
      emptyDescription="Sổ sự cố chỉ ghi thứ CÓ BẰNG CHỨNG. Trống nghĩa là chưa ai mở sự cố nào — không phải hệ thống đã được kiểm tra và thấy ổn."
    />
  );
}

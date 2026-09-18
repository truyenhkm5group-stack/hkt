"use client";

import { techDeploymentColumns } from "@/app/(dashboard)/tech/deployments/columns";
import { DataTable } from "@/components/data-table/data-table";
import { TECH_DEPLOY_SORTABLE } from "@/lib/constants/tech";
import type { TechDeploymentListRow } from "@/lib/queries/tech-ops";

export function TechDeploymentsTable({ rows, pageCount, total }: { rows: TechDeploymentListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={techDeploymentColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      defaultSort="startedAt"
      sortable={TECH_DEPLOY_SORTABLE}
      dense
      emptyTitle="Chưa ghi lượt deploy nào"
      emptyDescription="ERP không tự phát hiện được lượt deploy — GitHub Actions là bên có thẩm quyền và sổ này là lớp quan sát được ghi vào."
    />
  );
}

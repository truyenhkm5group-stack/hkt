"use client";

import { modelColumns } from "@/app/(dashboard)/models/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { ModelListRow } from "@/lib/queries/models";

export function ModelsTable({ rows, pageCount, total, emptyDescription }: { rows: ModelListRow[]; pageCount: number; total: number; emptyDescription: string }) {
  return (
    <DataTable
      columns={modelColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      defaultSort="code"
      defaultDir="asc"
      rowHref={(row) => `/models/${row.id}`}
      getRowId={(row) => row.id}
      sortable={["state"]}
      emptyTitle="Không có mẫu nào"
      emptyDescription={emptyDescription}
    />
  );
}

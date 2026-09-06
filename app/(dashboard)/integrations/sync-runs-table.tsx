"use client";

import { syncRunColumns } from "@/app/(dashboard)/integrations/sync-run-columns";
import { DataTable } from "@/components/data-table/data-table";
import type { SyncRunRow } from "@/lib/queries/integrations";

export function SyncRunsTable({ rows, pageCount, total }: { rows: SyncRunRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      defaultSort="startedAt"
      columns={syncRunColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      dense
      emptyTitle="Chưa có lần đồng bộ nào"
      emptyDescription="Bấm nút đồng bộ ở trên hoặc chạy service scheduler để hệ thống tự kéo dữ liệu theo lịch."
    />
  );
}

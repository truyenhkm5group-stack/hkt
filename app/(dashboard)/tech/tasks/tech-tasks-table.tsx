"use client";

import { techTaskColumns } from "@/app/(dashboard)/tech/tasks/columns";
import { DataTable } from "@/components/data-table/data-table";
import { TECH_TASK_SORTABLE } from "@/lib/constants/tech";
import type { TechTaskListRow } from "@/lib/queries/tech";

export function TechTasksTable({ rows, pageCount, total }: { rows: TechTaskListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={techTaskColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      rowHref={(row) => `/tech/tasks/${row.id}`}
      defaultSort="createdAt"
      sortable={TECH_TASK_SORTABLE}
      dense
      emptyTitle="Không có việc Tech nào khớp bộ lọc"
      emptyDescription="Thử mở rộng khoảng thời gian hoặc bỏ bộ lọc. Hàng đợi trống là trạng thái hợp lệ — nó không có nghĩa là hệ thống đã được kiểm tra."
    />
  );
}

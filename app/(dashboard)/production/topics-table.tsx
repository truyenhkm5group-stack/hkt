"use client";

import { topicColumns } from "@/app/(dashboard)/production/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { TopicListRow } from "@/lib/queries/production-os";

export function TopicsTable({ rows, pageCount, total }: { rows: TopicListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={topicColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      defaultSort="updatedAt"
      defaultDir="desc"
      rowHref={(row) => `/production/topics/${row.id}`}
      getRowId={(row) => row.id}
      sortable={["status", "updatedAt"]}
      emptyTitle="Chưa có topic nào"
      emptyDescription="Mở topic đầu tiên khi một mẫu thắng test và cần hỏi giá xưởng."
    />
  );
}

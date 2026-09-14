"use client";

import { aiRunColumns } from "@/app/(dashboard)/ai/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { AiRunRow } from "@/lib/queries/ai";

export function AiRunsTable({ rows }: { rows: AiRunRow[] }) {
  return (
    <DataTable
      columns={aiRunColumns}
      data={rows}
      pageCount={1}
      total={rows.length}
      getRowId={(row) => row.id}
      rowHref={(row) => `/ai/${row.id}`}
      dense
      emptyTitle="Chưa có lượt chạy nào"
      emptyDescription="Nhân sự AI chạy khi có tin nhắn khách vào qua webhook hội thoại Pancake, hoặc khi chạy job “Nạp hội thoại Pancake cho nhân viên bán hàng AI” ở trang Kết nối dữ liệu."
    />
  );
}

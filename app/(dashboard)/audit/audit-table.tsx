"use client";

import { auditColumns } from "@/app/(dashboard)/audit/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { AuditLogRow } from "@/lib/queries/audit";

export function AuditTable({ rows, pageCount, total }: { rows: AuditLogRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={auditColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      dense
      emptyTitle="Không có bản ghi"
      emptyDescription="Thử mở rộng khoảng thời gian hoặc bỏ bộ lọc. Nhật ký ghi lại đăng nhập, thay đổi người dùng, chi phí, đối soát COD…"
    />
  );
}

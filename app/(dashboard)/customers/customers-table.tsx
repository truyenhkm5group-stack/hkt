"use client";

import { customerColumns } from "@/app/(dashboard)/customers/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { CustomerListRow } from "@/lib/queries/customers";

export function CustomersTable({ rows, pageCount, total }: { rows: CustomerListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={customerColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/customers/${row.id}`}
      getRowId={(row) => row.id}
      emptyTitle="Không có khách hàng"
      emptyDescription="Thử đổi bộ lọc hoặc từ khoá. Khách hàng được tạo tự động khi đồng bộ đơn, hoặc bấm “Đồng bộ khách hàng”."
    />
  );
}

"use client";

import { returnRateColumns } from "@/app/(dashboard)/reports/returns/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { ReturnRateRow } from "@/lib/queries/return-rate";

export function ReturnRateTable({ rows, pageCount, total, baseQuery }: { rows: ReturnRateRow[]; pageCount: number; total: number; baseQuery: string }) {
  return (
    <DataTable
      columns={returnRateColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.key}
      rowHref={(row) => `/reports/returns?${baseQuery}${baseQuery ? "&" : ""}variant=${encodeURIComponent(row.key)}#chi-tiet`}
      emptyTitle="Không có mã hàng nào"
      emptyDescription="Thử đổi khoảng thời gian, bỏ bộ lọc tối thiểu, hoặc đồng bộ đơn hàng từ Pancake."
    />
  );
}

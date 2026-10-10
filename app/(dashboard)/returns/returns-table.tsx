"use client";

import * as React from "react";
import { returnColumns } from "@/app/(dashboard)/returns/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { ReturnListRow } from "@/lib/queries/returns";

export function ReturnsTable({ rows, pageCount, total, variationLabel = null }: { rows: ReturnListRow[]; pageCount: number; total: number; variationLabel?: string | null }) {
  const columns = React.useMemo(() => returnColumns(variationLabel), [variationLabel]);
  return (
    <DataTable
      defaultSort="insertedAt"
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => (row.order ? `/orders/${row.order.id}` : undefined)}
      getRowId={(row) => row.id}
      emptyTitle="Không có phiếu đổi/trả"
      emptyDescription="Thử đổi khoảng thời gian hoặc bộ lọc. Nếu chưa đồng bộ, bấm “Đồng bộ đổi/trả”."
    />
  );
}

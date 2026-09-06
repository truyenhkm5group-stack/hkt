"use client";

import { orderColumns } from "@/app/(dashboard)/orders/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { OrderListRow } from "@/lib/queries/orders";

export function OrdersTable({ rows, pageCount, total }: { rows: OrderListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      defaultSort="insertedAt"
      columns={orderColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/orders/${row.id}`}
      getRowId={(row) => row.id}
      emptyTitle="Không có đơn hàng"
      emptyDescription="Thử đổi khoảng thời gian hoặc bộ lọc. Nếu chưa đồng bộ, bấm “Đồng bộ đơn”."
    />
  );
}

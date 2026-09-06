"use client";

import { inventoryColumns } from "@/app/(dashboard)/inventory/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { InventoryListRow } from "@/lib/queries/inventory";

export function InventoryTable({ rows, pageCount, total }: { rows: InventoryListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      defaultSort="insertedAt"
      columns={inventoryColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => (row.variant ? `/products/${row.variant.productId}` : undefined)}
      getRowId={(row) => row.id}
      dense
      emptyTitle="Không có giao dịch kho"
      emptyDescription="Thử đổi khoảng thời gian hoặc bộ lọc. Nếu chưa đồng bộ, bấm “Đồng bộ nhật ký kho”."
    />
  );
}

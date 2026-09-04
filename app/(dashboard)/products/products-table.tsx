"use client";

import { useMemo } from "react";
import { buildProductColumns } from "@/app/(dashboard)/products/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { ProductListRow } from "@/lib/queries/products";

export function ProductsTable({ rows, pageCount, total, warehouses }: { rows: ProductListRow[]; pageCount: number; total: number; warehouses: { id: string; name: string }[] }) {
  const columns = useMemo(() => buildProductColumns(warehouses), [warehouses]);
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/products/${row.productId}`}
      getRowId={(row) => row.id}
      emptyTitle="Không có mẫu mã"
      emptyDescription="Thử đổi bộ lọc hoặc từ khoá. Nếu chưa đồng bộ, bấm “Đồng bộ sản phẩm & tồn kho”."
    />
  );
}

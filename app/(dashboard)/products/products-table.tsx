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
      defaultSort="erpStock"
      defaultDir="asc"
      rowHref={(row) => `/products/${row.productId}`}
      getRowId={(row) => row.id}
      group={{
        key: (row) => row.productId,
        parentHref: (p) => `/products/${p.productId}`,
        parent: (rows) => {
          const sum = (f: (r: ProductListRow) => number) => rows.reduce((t, r) => t + f(r), 0);
          const stockCells = new Map<string, ProductListRow["stocks"][number]>();
          for (const r of rows) for (const c of r.stocks) {
            const prev = stockCells.get(c.warehouseId);
            stockCells.set(c.warehouseId, prev ? { ...prev, remainQuantity: prev.remainQuantity + c.remainQuantity, actualRemainQuantity: prev.actualRemainQuantity + c.actualRemainQuantity, pendingQuantity: prev.pendingQuantity + c.pendingQuantity, returningQuantity: prev.returningQuantity + c.returningQuantity } : { ...c });
          }
          const stockValue = sum((r) => r.stockValue);
          const erpStock = sum((r) => r.erpStock);
          return {
            ...rows[0],
            id: `group:${rows[0].productId}`,
            sku: rows[0].productName,
            color: "",
            size: "",
            detail: `${rows.length} mẫu mã · ${[...new Set(rows.map((r) => r.color).filter(Boolean))].length} màu · ${[...new Set(rows.map((r) => r.size).filter(Boolean))].length} size`,
            retailPrice: Math.max(...rows.map((r) => r.retailPrice)),
            lastImportedPrice: rows.some((r) => r.lastImportedPrice) ? Math.round(sum((r) => r.lastImportedPrice) / rows.filter((r) => r.lastImportedPrice).length) : 0,
            avgImportedPrice: rows.some((r) => r.avgImportedPrice) ? sum((r) => r.avgImportedPrice) / rows.filter((r) => r.avgImportedPrice).length : 0,
            remainQuantity: sum((r) => r.remainQuantity),
            actualRemainQuantity: sum((r) => r.actualRemainQuantity),
            selling: rows.some((r) => r.selling),
            sold30: sum((r) => r.sold30),
            stockValue,
            stocks: [...stockCells.values()],
            received: sum((r) => r.received),
            delivered: sum((r) => r.delivered),
            returned: sum((r) => r.returned),
            inTransit: sum((r) => r.inTransit),
            pending: sum((r) => r.pending),
            erpStock,
            unitCost: erpStock ? Math.round(stockValue / erpStock) : 0,
          };
        },
      }}
      emptyTitle="Không có mẫu mã"
      emptyDescription="Thử đổi bộ lọc hoặc từ khoá. Nếu chưa đồng bộ, bấm “Đồng bộ sản phẩm & tồn kho”."
    />
  );
}

"use client";

import { useMemo } from "react";
import { buildProductColumns } from "@/app/(dashboard)/products/columns";
import { DataTable } from "@/components/data-table/data-table";
import { PRODUCT_LIST_PAGE_SIZE } from "@/lib/constants/inventory";
import type { ProductListRow } from "@/lib/queries/products";

/** `emptyDescription`: chữ của trang lõi theo tổ chức (`lib/branding/copy.ts` · `products.emptyList`) — nhà giữ nguyên câu cũ. */
export function ProductsTable({ rows, pageCount, total, warehouses, emptyDescription }: { rows: ProductListRow[]; pageCount: number; total: number; warehouses: { id: string; name: string }[]; emptyDescription: string }) {
  const columns = useMemo(() => buildProductColumns(warehouses), [warehouses]);
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      defaultSort="erpStock"
      defaultDir="asc"
      defaultPageSize={PRODUCT_LIST_PAGE_SIZE}
      rowHref={(row) => `/products/${row.productId}`}
      getRowId={(row) => row.id}
      group={{
        key: (row) => row.productId,
        // THU GỌN mặc định (chủ shop chốt 27/09/2026): mở trang là thấy đủ mọi MÃ trên một màn hình;
        // bấm mũi tên hoặc "Mở tất cả" mới xổ SKU. Vẫn đủ mọi dòng trong một trang — không cắt đôi một mã.
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
            receiptIn: sum((r) => r.receiptIn),
            returnIn: sum((r) => r.returnIn),
            adjust: sum((r) => r.adjust),
            manualOut: sum((r) => r.manualOut),
            shipped: sum((r) => r.shipped),
            inTransit: sum((r) => r.inTransit),
            awaitingReturn: sum((r) => r.awaitingReturn),
            shrinkage: sum((r) => r.shrinkage),
            reserved: sum((r) => r.reserved),
            delivered: sum((r) => r.delivered),
            returned: sum((r) => r.returned),
            // SỐ ĐƠN của mã do máy chủ gộp THEO ĐƠN — cộng các dòng mẫu mã là đếm hai lần đơn mua 2 mẫu.
            deliveredOrders: rows[0].productDeliveredOrders,
            returnedOrders: rows[0].productReturnedOrders,
            successRate: rows[0].productSuccessRate,
            erpStock,
            available: sum((r) => r.available),
            unitCost: erpStock ? Math.round(stockValue / erpStock) : 0,
          };
        },
      }}
      emptyTitle="Không có mẫu mã"
      emptyDescription={emptyDescription}
    />
  );
}

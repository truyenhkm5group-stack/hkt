"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Shirt } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { Money } from "@/components/ui-bits";
import { formatDate, formatNumber } from "@/lib/format";
import type { ProductListRow } from "@/lib/queries/products";
import { cn } from "@/lib/utils";

export function stockTone(remain: number) {
  if (remain <= 0) return "text-destructive";
  if (remain <= 5) return "text-amber-600 dark:text-amber-400";
  return "";
}

/** Tạo cột cho bảng mẫu mã; mỗi kho là một cột riêng (danh sách kho lấy từ server) */
export function buildProductColumns(warehouses: { id: string; name: string }[]): ColumnDef<ProductListRow, unknown>[] {
  const warehouseColumns: ColumnDef<ProductListRow, unknown>[] = warehouses.map((w) => ({
    id: `wh_${w.id}`,
    header: w.name,
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => {
      const stock = row.original.stocks.find((s) => s.warehouseId === w.id);
      if (!stock) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <div className="text-right">
          <span className={cn("numeric font-semibold", stockTone(stock.remainQuantity))}>{formatNumber(stock.remainQuantity)}</span>
          {stock.pendingQuantity > 0 || stock.returningQuantity > 0 ? (
            <div className="text-[10.5px] text-muted-foreground">
              {stock.pendingQuantity > 0 ? `chờ giao ${stock.pendingQuantity}` : ""}
              {stock.pendingQuantity > 0 && stock.returningQuantity > 0 ? " · " : ""}
              {stock.returningQuantity > 0 ? `đang hoàn ${stock.returningQuantity}` : ""}
            </div>
          ) : null}
        </div>
      );
    },
  }));

  return [
    {
      id: "sku",
      accessorKey: "sku",
      header: "Sản phẩm",
      cell: ({ row }) => {
        const r = row.original;
        const image = r.images[0] || r.productImage;
        return (
          <div className="flex min-w-[240px] items-center gap-3">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" className="size-10 shrink-0 rounded-md border object-cover" />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                <Shirt className="size-4" />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <RowLink href={`/products/${r.productId}`} className="truncate">
                  {r.productName}
                </RowLink>
                {!r.selling ? <span className="rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">Ẩn/khoá</span> : null}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{r.sku || "—"}</span>
                {r.color || r.size ? <span className="ml-2">{[r.color, r.size].filter(Boolean).join(" / ")}</span> : null}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "retailPrice",
      accessorKey: "retailPrice",
      header: "Giá bán",
      meta: { align: "right" },
      cell: ({ row }) => <Money value={row.original.retailPrice} className="font-semibold" />,
    },
    {
      id: "cost",
      header: "Giá vốn",
      enableSorting: false,
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <Money value={row.original.lastImportedPrice} />
          {row.original.avgImportedPrice > 0 ? (
            <div className="text-[10.5px] text-muted-foreground">
              TB <Money value={Math.round(row.original.avgImportedPrice)} />
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "remainQuantity",
      accessorKey: "remainQuantity",
      header: "Tồn khả dụng",
      meta: { align: "right" },
      cell: ({ row }) => <span className={cn("numeric text-base font-bold", stockTone(row.original.remainQuantity))}>{formatNumber(row.original.remainQuantity)}</span>,
    },
    {
      id: "actualRemainQuantity",
      header: "Tồn thực tế",
      enableSorting: false,
      meta: { align: "right" },
      cell: ({ row }) => <span className="numeric text-muted-foreground">{formatNumber(row.original.actualRemainQuantity)}</span>,
    },
    ...warehouseColumns,
    {
      id: "sold30",
      accessorKey: "sold30",
      header: "Bán 30 ngày",
      meta: { align: "right" },
      cell: ({ row }) => <span className={cn("numeric font-semibold", row.original.sold30 === 0 && "text-muted-foreground")}>{formatNumber(row.original.sold30)}</span>,
    },
    {
      id: "stockValue",
      accessorKey: "stockValue",
      header: "Giá trị tồn",
      meta: { align: "right" },
      cell: ({ row }) => <Money value={row.original.stockValue} className="text-muted-foreground" />,
    },
    {
      id: "updatedAtExternal",
      accessorKey: "updatedAtExternal",
      header: "Cập nhật",
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.updatedAtExternal, true)}</span>,
    },
  ];
}

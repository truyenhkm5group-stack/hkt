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
  // Tồn theo từng kho Pancake không hiển thị trong bảng (số Pancake không phản ánh tồn thật); vẫn có trong CSV.
  void warehouses;

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
          <Money value={row.original.unitCost} className={row.original.unitCost ? "" : "text-muted-foreground"} />
          {row.original.unitCost !== row.original.lastImportedPrice && row.original.lastImportedPrice > 0 ? (
            <div className="text-[10.5px] text-muted-foreground">
              Pancake <Money value={row.original.lastImportedPrice} />
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "received",
      accessorKey: "received",
      header: "Nhập",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric font-medium", row.original.received === 0 && "text-muted-foreground")}>{formatNumber(row.original.received)}</span>
          {row.original.receiptCount ? <div className="text-[10.5px] text-muted-foreground">{row.original.receiptCount} phiếu</div> : null}
        </div>
      ),
    },
    {
      id: "delivered",
      accessorKey: "delivered",
      header: "Giao thật",
      meta: { align: "right" },
      cell: ({ row }) => <span className="numeric text-emerald-700 dark:text-emerald-400">{formatNumber(row.original.delivered)}</span>,
    },
    {
      id: "returned",
      accessorKey: "returned",
      header: "Hoàn",
      meta: { align: "right" },
      cell: ({ row }) => <span className={cn("numeric", row.original.returned ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>{formatNumber(row.original.returned)}</span>,
    },
    {
      id: "inTransit",
      accessorKey: "inTransit",
      header: "Đang giao",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric", row.original.inTransit ? "text-sky-700 dark:text-sky-400" : "text-muted-foreground")}>{formatNumber(row.original.inTransit)}</span>
          {row.original.pending ? <div className="text-[10.5px] text-muted-foreground">chờ gửi {formatNumber(row.original.pending)}</div> : null}
        </div>
      ),
    },
    {
      id: "erpStock",
      accessorKey: "erpStock",
      header: "Tồn khả dụng",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric text-base font-bold", stockTone(row.original.erpStock))}>{formatNumber(row.original.erpStock)}</span>
          <div className="text-[10.5px] text-muted-foreground">Pancake {formatNumber(row.original.remainQuantity)}</div>
        </div>
      ),
    },
    {
      id: "sold30",
      accessorKey: "sold30",
      // Bán ròng: đã bỏ đơn huỷ và đơn hoàn (gồm đơn VTP báo giao thành công nhưng doanh thu COD ≤ 100K)
      header: "Bán ròng 30 ngày",
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

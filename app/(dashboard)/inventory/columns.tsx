"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Shirt } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { Money } from "@/components/ui-bits";
import { formatDateTime, formatNumber } from "@/lib/format";
import { INVENTORY_TABLE_TONE, inventoryTableLabel } from "@/lib/constants/inventory";
import type { InventoryListRow } from "@/lib/queries/inventory";
import { cn } from "@/lib/utils";

export const inventoryColumns: ColumnDef<InventoryListRow, unknown>[] = [
  {
    id: "insertedAt",
    accessorKey: "insertedAt",
    header: "Thời gian",
    cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(row.original.insertedAt)}</span>,
    size: 140,
  },
  {
    id: "product",
    header: "Sản phẩm",
    enableSorting: false,
    cell: ({ row }) => {
      const v = row.original.variant;
      if (!v) return <span className="text-xs text-muted-foreground">Mẫu mã không còn trong hệ thống</span>;
      const image = v.images[0] || v.product?.image;
      return (
        <div className="flex min-w-[220px] items-center gap-3">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="size-9 shrink-0 rounded-md border object-cover" />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><Shirt className="size-4" /></span>
          )}
          <div className="min-w-0">
            <RowLink href={`/products/${v.productId}`} className="block truncate">
              {v.product?.name || "—"}
            </RowLink>
            <div className="truncate text-xs text-muted-foreground">
              <span className="font-mono">{v.sku || "—"}</span>
              {v.color || v.size ? <span className="ml-2">{[v.color, v.size].filter(Boolean).join(" / ")}</span> : null}
            </div>
          </div>
        </div>
      );
    },
  },
  {
    id: "warehouse",
    header: "Kho",
    enableSorting: false,
    cell: ({ row }) => <span className="text-sm">{row.original.warehouse?.name ?? <span className="text-xs text-muted-foreground">—</span>}</span>,
  },
  {
    id: "type",
    header: "Loại",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="block max-w-[220px] truncate text-sm" title={row.original.type}>
        {row.original.type || "—"}
      </span>
    ),
  },
  {
    id: "ref",
    header: "Tham chiếu",
    enableSorting: false,
    cell: ({ row }) => {
      const { tableName, refDisplayId } = row.original;
      const label = inventoryTableLabel(tableName);
      const tone = (tableName && INVENTORY_TABLE_TONE[tableName]) || "bg-muted text-muted-foreground";
      const ref = refDisplayId ? (tableName === "orders" ? <Link href={`/orders/${refDisplayId}`} className="font-mono text-xs font-semibold hover:text-primary hover:underline" onClick={(e) => e.stopPropagation()}>#{refDisplayId}</Link> : <span className="font-mono text-xs">#{refDisplayId}</span>) : null;
      return (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", tone)}>{label}</span>
          {ref}
        </div>
      );
    },
  },
  {
    id: "quantity",
    accessorKey: "quantity",
    header: "Thay đổi",
    meta: { align: "right" },
    cell: ({ row }) => {
      const q = row.original.quantity;
      return <span className={cn("numeric text-base font-bold", q > 0 ? "text-success" : q < 0 ? "text-destructive" : "text-muted-foreground")}>{q > 0 ? `+${formatNumber(q)}` : formatNumber(q)}</span>;
    },
  },
  {
    id: "remainQuantity",
    accessorKey: "remainQuantity",
    header: "Tồn sau",
    meta: { align: "right" },
    cell: ({ row }) => <span className="numeric font-semibold">{formatNumber(row.original.remainQuantity)}</span>,
  },
  {
    id: "avgPrice",
    header: "Giá vốn TB",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => (row.original.avgPrice ? <Money value={Math.round(row.original.avgPrice)} className="text-muted-foreground" /> : <span className="text-xs text-muted-foreground">—</span>),
  },
  {
    id: "editor",
    header: "Người thao tác",
    enableSorting: false,
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.editorName || "—"}</span>,
  },
];

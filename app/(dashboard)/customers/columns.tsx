"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { RowLink } from "@/components/data-table/data-table";
import { SourceBadge } from "@/components/status-badge";
import { Money } from "@/components/ui-bits";
import { formatDate, formatNumber, formatTimeAgo, pct } from "@/lib/format";
import type { CustomerListRow } from "@/lib/queries/customers";
import { cn } from "@/lib/utils";

export const customerColumns: ColumnDef<CustomerListRow, unknown>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: "Khách hàng",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="min-w-[180px]">
          <div className="flex items-center gap-2">
            <RowLink href={`/customers/${r.id}`} className="truncate">
              {r.name || "—"}
            </RowLink>
            {r.level ? <span className="rounded bg-primary/10 px-1 text-[10px] font-semibold text-primary">{r.level}</span> : null}
            {r.isBlock ? <span className="rounded bg-destructive/10 px-1 text-[10px] font-semibold text-destructive">Chặn</span> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="font-mono">{r.phone || r.phones[0] || "—"}</span>
            {r.phones.length > 1 ? <span className="ml-1">+{r.phones.length - 1}</span> : null}
          </div>
          {r.tags.length ? <div className="mt-0.5 flex flex-wrap gap-1">{r.tags.slice(0, 3).map((t) => <span key={t} className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{t}</span>)}</div> : null}
        </div>
      );
    },
  },
  {
    id: "address",
    header: "Địa chỉ",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="max-w-[240px]">
        <div className="truncate text-sm font-medium">{row.original.province || "—"}</div>
        <div className="truncate text-xs text-muted-foreground" title={row.original.address}>
          {row.original.address || "—"}
        </div>
      </div>
    ),
  },
  {
    id: "orderCount",
    accessorKey: "orderCount",
    header: "Đơn",
    meta: { align: "right" },
    cell: ({ row }) => <span className={cn("numeric text-base font-bold", row.original.orderCount === 0 && "text-muted-foreground")}>{formatNumber(row.original.orderCount)}</span>,
  },
  {
    id: "success",
    header: "Thành công / hoàn",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => {
      const r = row.original;
      const rate = pct(r.succeedOrderCount, r.orderCount);
      return (
        <div className="text-right">
          <div className="numeric text-sm">
            <span className="font-semibold text-success">{formatNumber(r.succeedOrderCount)}</span>
            <span className="text-muted-foreground"> / </span>
            <span className={cn("font-semibold", r.returnedOrderCount > 0 ? "text-destructive" : "text-muted-foreground")}>{formatNumber(r.returnedOrderCount)}</span>
          </div>
          {r.orderCount > 0 ? <div className="text-[10.5px] text-muted-foreground">thành công {rate.toFixed(0)}%</div> : null}
        </div>
      );
    },
  },
  {
    id: "purchasedAmount",
    accessorKey: "purchasedAmount",
    header: "Đã mua",
    meta: { align: "right" },
    cell: ({ row }) => <Money value={row.original.purchasedAmount} className={cn("font-bold", row.original.purchasedAmount === 0 && "text-muted-foreground")} />,
  },
  {
    id: "lastOrderAt",
    accessorKey: "lastOrderAt",
    header: "Đơn gần nhất",
    cell: ({ row }) =>
      row.original.lastOrderAt ? (
        <div className="text-xs">
          <div>{formatDate(row.original.lastOrderAt, true)}</div>
          <div className="text-muted-foreground">{formatTimeAgo(row.original.lastOrderAt)}</div>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Chưa có đơn</span>
      ),
  },
  {
    id: "source",
    header: "Nguồn",
    enableSorting: false,
    cell: ({ row }) => (row.original.lastSource ? <SourceBadge source={row.original.lastSource} /> : <span className="text-xs text-muted-foreground">—</span>),
  },
];

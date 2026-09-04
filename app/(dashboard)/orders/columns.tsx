"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Truck } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { CodStatusBadge, OrderStageBadge, ShipmentStageBadge, SourceBadge } from "@/components/status-badge";
import { Money } from "@/components/ui-bits";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { OrderListRow } from "@/lib/queries/orders";

export const orderColumns: ColumnDef<OrderListRow, unknown>[] = [
  {
    id: "systemId",
    accessorKey: "systemId",
    header: "Mã đơn",
    cell: ({ row }) => (
      <div className="min-w-[72px]">
        <RowLink href={`/orders/${row.original.id}`}>#{row.original.systemId ?? row.original.id}</RowLink>
        {row.original.tags.length ? <div className="mt-0.5 flex flex-wrap gap-1">{row.original.tags.slice(0, 2).map((t) => <span key={t} className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{t}</span>)}</div> : null}
      </div>
    ),
    size: 96,
  },
  {
    id: "customer",
    header: "Khách hàng",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="min-w-[140px]">
        <div className="truncate font-medium">{row.original.billFullName || "—"}</div>
        <div className="text-xs text-muted-foreground">
          {row.original.billPhone}
          {row.original.shipProvince ? ` · ${row.original.shipProvince}` : ""}
        </div>
      </div>
    ),
  },
  {
    id: "items",
    header: "Sản phẩm",
    enableSorting: false,
    cell: ({ row }) => {
      const items = row.original.items;
      const text = items.map((i) => `${i.productName}${i.variationDetail ? ` (${i.variationDetail})` : ""} ×${i.quantity}`).join(", ");
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex max-w-[280px] items-center gap-2">
              {items[0]?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={items[0].image} alt="" className="size-8 shrink-0 rounded border object-cover" />
              ) : null}
              <span className="truncate text-xs text-muted-foreground">
                {text || "—"}
                {row.original.itemsCount > items.length ? ` +${row.original.itemsCount - items.length}` : ""}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">{text}</TooltipContent>
        </Tooltip>
      );
    },
  },
  { id: "source", header: "Kênh", enableSorting: false, cell: ({ row }) => <SourceBadge source={row.original.source} /> },
  {
    id: "status",
    accessorKey: "status",
    header: "Trạng thái",
    cell: ({ row }) => (
      <div className="space-y-1">
        <OrderStageBadge stage={row.original.stage} label={row.original.statusName || undefined} />
        {row.original.lastUpdateStatusAt ? <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(row.original.lastUpdateStatusAt)}</div> : null}
      </div>
    ),
  },
  {
    id: "shipment",
    header: "Vận chuyển",
    enableSorting: false,
    cell: ({ row }) => {
      const s = row.original.shipment;
      if (!s) return <span className="text-xs text-muted-foreground">Chưa gửi ĐVVC</span>;
      return (
        <div className="min-w-[150px] space-y-1">
          <div className="flex items-center gap-1.5 text-xs">
            <Truck className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{s.carrier || "ĐVVC"}</span>
            {s.trackingCode || s.vtpOrderNumber ? <span className="truncate font-mono text-[11px] text-muted-foreground">{s.vtpOrderNumber ?? s.trackingCode}</span> : null}
          </div>
          <ShipmentStageBadge stage={s.stage} label={s.vtpStatusName ?? undefined} />
        </div>
      );
    },
  },
  {
    id: "total",
    accessorKey: "totalPriceAfterDiscount",
    header: "Tổng tiền",
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <Money value={row.original.totalPriceAfterDiscount} className="font-bold" />
        <div className="mt-0.5 flex justify-end">{row.original.moneyToCollect > 0 && row.original.shipment ? <CodStatusBadge status={row.original.shipment.codStatus} className="px-1.5 text-[10px]" /> : <span className="text-[10.5px] text-muted-foreground">{row.original.moneyToCollect > 0 ? "COD" : "Đã thanh toán"}</span>}</div>
      </div>
    ),
  },
  {
    id: "insertedAt",
    accessorKey: "insertedAt",
    header: "Ngày tạo",
    cell: ({ row }) => (
      <div className="text-xs text-muted-foreground">
        <div>{formatDateTime(row.original.insertedAt)}</div>
        {row.original.sellerName ? <div className="truncate">NV: {row.original.sellerName}</div> : null}
      </div>
    ),
  },
];

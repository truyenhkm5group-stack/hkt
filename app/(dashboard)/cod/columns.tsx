"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Banknote, CheckCheck, MoreHorizontal, Truck, Undo2 } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { CodStatusBadge, ShipmentStageBadge } from "@/components/status-badge";
import { Money } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatDate, formatDateTime } from "@/lib/format";
import type { CodListRow } from "@/lib/queries/cod";

export type CodActionType = "RECONCILED" | "PAID" | "DISPUTED" | "COLLECTED";

export const COD_ACTION_LABEL: Record<CodActionType, string> = {
  RECONCILED: "Đánh dấu ĐVVC đã đối soát",
  PAID: "Đánh dấu đã về ngân hàng",
  DISPUTED: "Đánh dấu chênh lệch",
  COLLECTED: "Quay về Đã thu",
};

const baseColumns: ColumnDef<CodListRow, unknown>[] = [
  {
    id: "createdAt",
    accessorKey: "createdAt",
    header: "Vận đơn",
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div className="min-w-[124px]">
          <RowLink href={`/shipments/${s.id}`} className="font-mono text-[13px]">
            {s.vtpOrderNumber ?? s.trackingCode ?? "—"}
          </RowLink>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Truck className="size-3.5 shrink-0" />
            <span className="truncate">{s.carrier || "ĐVVC"}</span>
          </div>
        </div>
      );
    },
    size: 150,
  },
  {
    id: "order",
    header: "Đơn hàng",
    enableSorting: false,
    cell: ({ row }) => {
      const o = row.original.order;
      if (!o) return <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">Ngoài Pancake</span>;
      return (
        <div className="min-w-[80px]">
          <RowLink href={`/orders/${o.id}`}>#{o.systemId ?? o.id}</RowLink>
          <div className="text-xs text-muted-foreground">{o.source}</div>
        </div>
      );
    },
  },
  {
    id: "receiver",
    header: "Người nhận",
    enableSorting: false,
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div className="min-w-[120px] max-w-[180px]">
          <div className="truncate font-medium">{s.receiverName || s.order?.billFullName || "—"}</div>
          <div className="text-xs text-muted-foreground">{s.receiverPhone || s.order?.billPhone || ""}</div>
        </div>
      );
    },
  },
  {
    id: "deliveredAt",
    accessorKey: "deliveredAt",
    header: "Giao thành công",
    cell: ({ row }) => (
      <div className="min-w-[120px] space-y-1">
        <div className="text-xs">{row.original.deliveredAt ? formatDateTime(row.original.deliveredAt) : <span className="text-muted-foreground">Chưa giao</span>}</div>
        {row.original.stage !== "DELIVERED" ? <ShipmentStageBadge stage={row.original.stage} label={row.original.vtpStatusName ?? undefined} className="px-1.5 text-[10px]" /> : null}
      </div>
    ),
  },
  {
    id: "codAmount",
    accessorKey: "codAmount",
    header: "COD",
    meta: { align: "right" },
    cell: ({ row }) => <Money value={row.original.codAmount} className="font-bold" />,
  },
  {
    id: "codCollected",
    accessorKey: "codCollected",
    header: "Đã thu",
    meta: { align: "right" },
    cell: ({ row }) => {
      const s = row.original;
      const diff = s.codCollected > 0 ? s.codCollected - s.codAmount : 0;
      return (
        <div className="text-right">
          <Money value={s.codCollected} className={s.codCollected > 0 ? "font-semibold" : "text-muted-foreground"} />
          {diff !== 0 ? <div className="text-[10.5px] text-rose-600"><Money value={diff} sign compact /></div> : null}
        </div>
      );
    },
  },
  {
    id: "shippingFee",
    header: "Phí ship",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <Money value={row.original.shippingFee} className="text-muted-foreground" />
        {row.original.codFee ? <div className="text-[10.5px] text-muted-foreground">phí COD <Money value={row.original.codFee} compact /></div> : null}
      </div>
    ),
  },
  {
    id: "codStatus",
    header: "Trạng thái COD",
    enableSorting: false,
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div className="min-w-[110px] space-y-1">
          <CodStatusBadge status={s.codStatus} />
          {s.codPaidToBankAt ? <div className="text-[10.5px] text-muted-foreground">Về NH {formatDate(s.codPaidToBankAt)}</div> : s.codReconciledAt ? <div className="text-[10.5px] text-muted-foreground">Đối soát {formatDate(s.codReconciledAt)}</div> : null}
        </div>
      );
    },
  },
  {
    id: "codPaidToBankAt",
    accessorKey: "codPaidToBankAt",
    header: "Đợt nhận tiền",
    cell: ({ row }) => {
      const b = row.original.codBatch;
      if (!b) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <div className="min-w-[110px]">
          <RowLink href={`/cod?batch=${b.id}`} className="font-mono text-xs">
            {b.reference}
          </RowLink>
          <div className="text-[10.5px] text-muted-foreground">nhận {formatDate(b.receivedAt)}</div>
        </div>
      );
    },
  },
];

/** Cột bảng đối soát; khi có quyền ghi thêm menu thao tác từng dòng */
export function codColumns({ canWrite, onAction }: { canWrite: boolean; onAction: (type: CodActionType, row: CodListRow) => void }): ColumnDef<CodListRow, unknown>[] {
  if (!canWrite) return baseColumns;
  return [
    ...baseColumns,
    {
      id: "actions",
      header: "",
      enableSorting: false,
      size: 44,
      cell: ({ row }) => {
        const s = row.original;
        const status = s.codStatus;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Thao tác" className="text-muted-foreground">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-no-row-link>
              <DropdownMenuLabel className="text-xs text-muted-foreground">Vận đơn {s.vtpOrderNumber ?? s.trackingCode ?? ""}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!["PENDING", "COLLECTED", "DISPUTED"].includes(status)} onSelect={() => onAction("RECONCILED", s)}>
                <CheckCheck className="size-4" /> {COD_ACTION_LABEL.RECONCILED}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={status === "PAID_TO_BANK" || status === "NOT_APPLICABLE"} onSelect={() => onAction("PAID", s)}>
                <Banknote className="size-4" /> {COD_ACTION_LABEL.PAID}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={status === "DISPUTED" || status === "NOT_APPLICABLE"} onSelect={() => onAction("DISPUTED", s)}>
                <AlertTriangle className="size-4" /> {COD_ACTION_LABEL.DISPUTED}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!["RECONCILED", "PAID_TO_BANK", "DISPUTED"].includes(status)} onSelect={() => onAction("COLLECTED", s)}>
                <Undo2 className="size-4" /> {COD_ACTION_LABEL.COLLECTED}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];
}

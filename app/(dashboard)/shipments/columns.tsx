"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Truck } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { CodStatusBadge, ShipmentStageBadge } from "@/components/status-badge";
import { Money } from "@/components/ui-bits";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { ShipmentListRow } from "@/lib/queries/shipments";

export const shipmentColumns: ColumnDef<ShipmentListRow, unknown>[] = [
  {
    id: "createdAt",
    accessorKey: "createdAt",
    header: "Mã vận đơn",
    cell: ({ row }) => {
      const s = row.original;
      const number = s.vtpOrderNumber ?? s.trackingCode;
      return (
        <div className="min-w-[130px]">
          <RowLink href={`/shipments/${s.id}`} className="font-mono text-[13px]">
            {number ?? "—"}
          </RowLink>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Truck className="size-3.5 shrink-0" />
            <span className="truncate">{s.carrier || "ĐVVC"}</span>
          </div>
        </div>
      );
    },
    size: 160,
  },
  {
    id: "order",
    header: "Đơn hàng",
    enableSorting: false,
    cell: ({ row }) => {
      const o = row.original.order;
      if (!o) {
        return (
          <div className="min-w-[96px]">
            <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">Ngoài Pancake</span>
            {row.original.orderReference ? <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.original.orderReference}</div> : null}
          </div>
        );
      }
      return (
        <div className="min-w-[96px]">
          <RowLink href={`/orders/${o.id}`}>#{o.systemId ?? o.id}</RowLink>
          <div className="text-xs text-muted-foreground">
            {o.source}
            {o.totalPriceAfterDiscount ? (
              <>
                {" · "}
                <Money value={o.totalPriceAfterDiscount} compact />
              </>
            ) : null}
          </div>
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
      const name = s.receiverName || s.order?.billFullName || "—";
      const phone = s.receiverPhone || s.order?.billPhone || "";
      return (
        <div className="min-w-[150px] max-w-[220px]">
          <div className="truncate font-medium">{name}</div>
          <div className="truncate text-xs text-muted-foreground" title={s.receiverAddress || undefined}>
            {phone}
            {s.receiverAddress ? ` · ${s.receiverAddress}` : ""}
          </div>
        </div>
      );
    },
  },
  {
    id: "vtpStatusDate",
    accessorKey: "vtpStatusDate",
    header: "Trạng thái",
    cell: ({ row }) => {
      const s = row.original;
      const label = s.vtpStatusName ?? undefined;
      const short = label && label.length > 34 ? `${label.slice(0, 32).trimEnd()}…` : label;
      // Viettel Post ghi "Giao thành công" cho cả vận đơn chiều về và đơn khách trả hàng (không thu được tiền):
      // hiện thêm kết quả thật theo doanh thu COD để không bị đếm nhầm là đơn thành công.
      const fake = s.stage === "DELIVERED" && s.outcome && s.outcome !== "DELIVERED";
      return (
        <div className="min-w-[140px] space-y-1" title={label}>
          <ShipmentStageBadge stage={s.stage} label={short} />
          {fake ? (
            <div className="text-[10.5px] font-medium text-rose-600 dark:text-rose-400">
              {s.outcome === "RETURNED" ? "Thực tế: hoàn (không thu được tiền)" : "Thực tế: không thành công (COD ≤ 100K)"}
            </div>
          ) : null}
          <div className="text-[10.5px] text-muted-foreground" suppressHydrationWarning>
            {s.vtpStatusDate ? formatTimeAgo(s.vtpStatusDate) : "—"}
            {s.vtpLocation ? ` · ${s.vtpLocation}` : ""}
          </div>
        </div>
      );
    },
  },
  {
    id: "codAmount",
    accessorKey: "codAmount",
    header: "COD",
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <Money value={row.original.codAmount} className="font-bold" />
        <div className="mt-0.5 flex justify-end">
          <CodStatusBadge status={row.original.codStatus} className="px-1.5 text-[10px]" />
        </div>
      </div>
    ),
  },
  {
    id: "shippingFee",
    header: "Phí ship",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => <Money value={row.original.shippingFee} className="text-muted-foreground" />,
  },
  {
    id: "deliveredAt",
    accessorKey: "deliveredAt",
    header: "Thời gian",
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div className="min-w-[150px] text-xs text-muted-foreground">
          <div>Lấy: {formatDateTime(s.pickedUpAt)}</div>
          {s.stage === "RETURNED" && s.returnedAt ? <div className="text-rose-600">Hoàn: {formatDateTime(s.returnedAt)}</div> : <div className={s.deliveredAt ? "text-emerald-700 dark:text-emerald-300" : undefined}>Giao: {formatDateTime(s.deliveredAt)}</div>}
        </div>
      );
    },
  },
  {
    id: "lastVtpSyncAt",
    header: "Cập nhật VTP",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="text-xs text-muted-foreground">
        <div suppressHydrationWarning>{row.original.lastVtpSyncAt ? formatTimeAgo(row.original.lastVtpSyncAt) : "Chưa tra cứu"}</div>
        {row.original.isFinal ? <div className="text-[10.5px]">Đã kết thúc</div> : null}
      </div>
    ),
  },
];

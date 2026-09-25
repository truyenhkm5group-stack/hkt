"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Shirt } from "lucide-react";
import { ModelStateBadge } from "@/app/(dashboard)/models/state-badge";
import { RowLink } from "@/components/data-table/data-table";
import { formatDate } from "@/lib/format";
import type { ModelListRow } from "@/lib/queries/models";

export const modelColumns: ColumnDef<ModelListRow, unknown>[] = [
  {
    id: "code",
    accessorKey: "code",
    header: "Mẫu",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex min-w-[220px] items-center gap-3">
          {r.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.image} alt="" className="size-10 shrink-0 rounded-md border object-cover" />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
              <Shirt className="size-4" />
            </span>
          )}
          <div className="min-w-0">
            <RowLink href={`/models/${r.id}`} className="font-mono font-semibold">
              {r.code}
            </RowLink>
            <div className="truncate text-xs text-muted-foreground">{r.name || r.productName || "—"}</div>
          </div>
        </div>
      );
    },
  },
  {
    id: "state",
    header: "Trạng thái khai",
    cell: ({ row }) => (
      <div className="space-y-0.5">
        <ModelStateBadge state={row.original.state} />
        {row.original.stateChangedAt ? <div className="text-[10.5px] text-muted-foreground">từ {formatDate(row.original.stateChangedAt)}</div> : null}
      </div>
    ),
  },
  {
    id: "links",
    header: "Nối với",
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="space-y-0.5 text-xs">
          {r.productId ? (
            <div>
              Sản phẩm: <RowLink href={`/products/${r.productId}`}>{r.productName || r.productId}</RowLink>
              {r.productRemoved ? <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">đã xoá</span> : null}
            </div>
          ) : (
            <div className="text-muted-foreground">Chưa có sản phẩm Pancake</div>
          )}
          {r.designCode ? <div>Thiết kế: <span className="font-mono">{r.designCode}</span></div> : null}
        </div>
      );
    },
  },
  {
    id: "owner",
    header: "Phụ trách",
    enableSorting: false,
    cell: ({ row }) => <span className={row.original.ownerName ? "text-sm" : "text-sm text-muted-foreground"}>{row.original.ownerName ?? "—"}</span>,
  },
  {
    id: "createdAt",
    accessorKey: "createdAt",
    header: "Vào sổ",
    cell: ({ row }) => (
      <div className="text-xs">
        {formatDate(row.original.createdAt)}
        <div className="text-[10.5px] text-muted-foreground">{row.original.registeredBy === "USER" ? "người gõ mã" : "máy đồng bộ"}</div>
      </div>
    ),
  },
];

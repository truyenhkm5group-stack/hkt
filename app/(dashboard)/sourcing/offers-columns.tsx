"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { RowLink } from "@/components/data-table/data-table";
import { DataAge, OfferImage, TiersText } from "@/components/sourcing/offer-bits";
import { SOURCING_PLATFORM_LABEL } from "@/lib/constants/sourcing";
import { formatDate } from "@/lib/format";
import type { SourcingOfferRow } from "@/lib/queries/sourcing";

export function sourcingOfferColumns(now: Date): ColumnDef<SourcingOfferRow, unknown>[] {
  return [
    {
      id: "titleVi",
      accessorKey: "titleVi",
      header: "Mẫu",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex min-w-[260px] items-start gap-2">
            <OfferImage src={r.imageUrl} alt={r.titleVi} size={44} />
            <div className="min-w-0">
              <RowLink href={`/sourcing/offers/${r.id}`} className="font-medium">
                {r.titleVi || "(chưa đặt tên)"}
              </RowLink>
              {r.titleZh ? (
                <div className="truncate text-xs text-muted-foreground" lang="zh-CN">
                  {r.titleZh}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-1 text-[11px]">
                {r.archivedAt ? <span className="rounded bg-muted px-1">lưu trữ</span> : null}
                {r.imageDupes ? <span className="rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">có thể trùng ảnh ({r.imageDupes})</span> : null}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "platform",
      accessorKey: "platform",
      header: "Nguồn",
      cell: ({ row }) => (
        <div className="whitespace-nowrap text-xs">
          <div className="font-medium">{SOURCING_PLATFORM_LABEL[row.original.platform]}</div>
          <div className="text-muted-foreground">{row.original.offerId ?? "không có mã"}</div>
        </div>
      ),
      size: 110,
    },
    {
      id: "supplier",
      header: "Nhà cung cấp",
      enableSorting: false,
      cell: ({ row }) => <span className="text-xs">{row.original.supplierName ?? "—"}</span>,
    },
    {
      id: "price",
      header: "Giá lần chụp mới nhất",
      enableSorting: false,
      cell: ({ row }) => {
        const l = row.original.latest;
        if (!l) return <span className="text-xs text-muted-foreground">chưa chụp giá</span>;
        return (
          <div className="min-w-[200px] space-y-0.5 text-xs">
            <TiersText tiers={l.tiers} />
            <div className="text-muted-foreground">MOQ {l.moq ?? "—"}</div>
            <DataAge source={l.source} asOf={l.capturedAt} now={now} />
          </div>
        );
      },
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: "Lưu lúc",
      cell: ({ row }) => <span className="whitespace-nowrap text-xs">{formatDate(row.original.createdAt)}</span>,
      size: 100,
    },
  ];
}

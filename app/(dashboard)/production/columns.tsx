"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { TopicStatusBadge } from "@/app/(dashboard)/production/_components/badges";
import { RowLink } from "@/components/data-table/data-table";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import type { TopicListRow } from "@/lib/queries/production-os";

export const topicColumns: ColumnDef<TopicListRow, unknown>[] = [
  {
    id: "title",
    header: "Topic",
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="min-w-[240px]">
          <RowLink href={`/production/topics/${r.id}`} className="font-semibold">
            {r.title}
          </RowLink>
          <div className="text-xs text-muted-foreground">
            <span className="font-mono">{r.modelCode}</span>
            {r.modelName ? ` · ${r.modelName}` : ""}
          </div>
        </div>
      );
    },
  },
  { id: "status", header: "Trạng thái", cell: ({ row }) => <TopicStatusBadge status={row.original.status} /> },
  {
    id: "members",
    header: "Người được tag",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="tabular-nums" title={row.original.restricted ? "Topic riêng — chỉ người mở, người được tag và chủ shop xem được" : "Topic cũ — ai có quyền xem sản xuất cũng xem được"}>
        {row.original.restricted ? `🔒 ${formatNumber(row.original.members)}` : formatNumber(row.original.members)}
      </span>
    ),
  },
  {
    id: "lastQuote",
    header: "Báo giá gần nhất",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => <span className="tabular-nums">{row.original.lastQuote === null ? "—" : `${formatVND(row.original.lastQuote)}/sp`}</span>,
  },
  { id: "messages", header: "Lượt trao đổi", enableSorting: false, meta: { align: "right" }, cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.messages)}</span> },
  {
    id: "updatedAt",
    header: "Cập nhật",
    cell: ({ row }) => (
      <div className="text-xs text-muted-foreground">
        {formatDateTime(row.original.updatedAt)}
        <div>mở bởi {row.original.createdBy || "—"}</div>
      </div>
    ),
  },
];

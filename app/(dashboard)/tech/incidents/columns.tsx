"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { TechIncidentStatusBadge, TechSeverityBadge } from "@/app/(dashboard)/tech/badges";
import { TECH_MODULE_LABEL, type TechIncidentSeverity, type TechIncidentStatus, type TechModule } from "@/lib/constants/tech";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { TechIncidentListRow } from "@/lib/queries/tech-ops";

export const techIncidentColumns: ColumnDef<TechIncidentListRow, unknown>[] = [
  {
    id: "code",
    accessorKey: "code",
    header: "Mã",
    cell: ({ row }) => <span className="whitespace-nowrap font-mono text-xs font-semibold">{row.original.code}</span>,
    size: 80,
  },
  {
    id: "title",
    accessorKey: "title",
    header: "Sự cố",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="min-w-[260px]">
        <div className="truncate font-medium">{row.original.title}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {TECH_MODULE_LABEL[row.original.module as TechModule] ?? row.original.module}
          {row.original.task ? ` · ${row.original.task.code}` : ""}
        </div>
      </div>
    ),
  },
  {
    id: "severity",
    accessorKey: "severity",
    header: "Mức",
    cell: ({ row }) => <TechSeverityBadge severity={row.original.severity as TechIncidentSeverity} />,
    size: 170,
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Trạng thái",
    cell: ({ row }) => <TechIncidentStatusBadge status={row.original.status as TechIncidentStatus} />,
    size: 130,
  },
  {
    id: "detectedAt",
    accessorKey: "detectedAt",
    header: "Phát hiện",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-xs">
        <div className="font-medium">{formatTimeAgo(row.original.detectedAt)}</div>
        <div className="text-[10.5px] text-muted-foreground">{formatDateTime(row.original.detectedAt)}</div>
      </div>
    ),
    size: 140,
  },
  {
    id: "rootCause",
    header: "Nguyên nhân gốc",
    enableSorting: false,
    // Ô TRỐNG là câu trả lời hợp lệ: chưa chứng minh được thì không viết (AGENTS.md mục 45). In ra
    // "chưa xác định" chứ không để trắng, để người đọc biết đây là một khoảng trống CÓ Ý NGHĨA.
    cell: ({ row }) => <span className="text-xs">{row.original.rootCause || <span className="text-muted-foreground">— chưa xác định</span>}</span>,
  },
];

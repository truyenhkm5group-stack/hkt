"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { TechApprovalBadge, TechPriorityBadge, TechRiskBadge, TechStatusBadge } from "@/app/(dashboard)/tech/badges";
import { TECH_MODULE_LABEL, TECH_TASK_TYPE_LABEL, type TechApprovalStatus, type TechModule, type TechPriority, type TechRisk, type TechTaskStatus, type TechTaskType } from "@/lib/constants/tech";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { TechTaskListRow } from "@/lib/queries/tech";

export const techTaskColumns: ColumnDef<TechTaskListRow, unknown>[] = [
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
    header: "Việc",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="min-w-[260px]">
        <div className="truncate font-medium">{row.original.title}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {TECH_TASK_TYPE_LABEL[row.original.taskType as TechTaskType] ?? row.original.taskType} · {TECH_MODULE_LABEL[row.original.module as TechModule] ?? row.original.module}
          {row.original.branch ? ` · ${row.original.branch}` : ""}
        </div>
      </div>
    ),
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Trạng thái",
    cell: ({ row }) => (
      <div className="flex flex-wrap items-center gap-1">
        <TechStatusBadge status={row.original.status as TechTaskStatus} />
        <TechApprovalBadge status={row.original.approvalStatus as TechApprovalStatus} />
      </div>
    ),
    size: 170,
  },
  {
    id: "priority",
    accessorKey: "priority",
    header: "Ưu tiên",
    cell: ({ row }) => <TechPriorityBadge priority={row.original.priority as TechPriority} />,
    size: 120,
  },
  {
    id: "risk",
    accessorKey: "risk",
    header: "Rủi ro",
    cell: ({ row }) => <TechRiskBadge risk={row.original.risk as TechRisk} />,
    size: 150,
  },
  {
    id: "agent",
    header: "Agent",
    enableSorting: false,
    // "Chưa giao" in ra bằng dấu gạch, không in ra ô trống: ô trống đọc ra là "không có dữ liệu",
    // còn đây là một sự thật có nghĩa — chưa ai nhận việc này (AGENTS.md mục 42).
    cell: ({ row }) => <span className="whitespace-nowrap text-xs">{row.original.agent ? row.original.agent.name : <span className="text-muted-foreground">— chưa giao</span>}</span>,
    size: 130,
  },
  {
    id: "updatedAt",
    accessorKey: "updatedAt",
    header: "Cập nhật",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-xs">
        <div className="font-medium">{formatTimeAgo(row.original.updatedAt)}</div>
        <div className="text-[10.5px] text-muted-foreground">{formatDateTime(row.original.updatedAt)}</div>
      </div>
    ),
    size: 130,
  },
];

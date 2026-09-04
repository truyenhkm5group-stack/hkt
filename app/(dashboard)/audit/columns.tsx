"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { auditActionLabel, auditActionTone, auditEntityHref, auditEntityLabel } from "@/lib/constants/audit";
import { ROLE_LABEL } from "@/lib/constants/roles";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { AuditLogRow } from "@/lib/queries/audit";
import { cn } from "@/lib/utils";

const badge = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

/** Tóm tắt ngắn JSON chi tiết: "khoá: giá trị · khoá: giá trị" */
function summarizeDetail(detail: unknown, max = 3): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail !== "object") return String(detail);
  const entries = Object.entries(detail as Record<string, unknown>);
  return entries
    .slice(0, max)
    .map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? (Array.isArray(v) ? `[${v.length}]` : "{…}") : String(v)}`)
    .join(" · ") + (entries.length > max ? " · …" : "");
}

export const auditColumns: ColumnDef<AuditLogRow, unknown>[] = [
  {
    id: "createdAt",
    accessorKey: "createdAt",
    header: "Thời gian",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-xs">
        <div className="font-medium">{formatDateTime(row.original.createdAt)}</div>
        <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(row.original.createdAt)}</div>
      </div>
    ),
    size: 140,
  },
  {
    id: "userEmail",
    accessorKey: "userEmail",
    header: "Người dùng",
    cell: ({ row }) => (
      <div className="min-w-[160px]">
        <div className="truncate font-medium">{row.original.user?.name ?? row.original.userEmail}</div>
        <div className="truncate text-xs text-muted-foreground">
          {row.original.userEmail}
          {row.original.user ? ` · ${ROLE_LABEL[row.original.user.role]}` : ""}
        </div>
      </div>
    ),
  },
  {
    id: "action",
    accessorKey: "action",
    header: "Hành động",
    cell: ({ row }) => (
      <div>
        <span className={cn(badge, auditActionTone(row.original.action))}>{auditActionLabel(row.original.action)}</span>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{row.original.action}</div>
      </div>
    ),
  },
  {
    id: "entity",
    accessorKey: "entity",
    header: "Đối tượng",
    cell: ({ row }) => {
      const { entity, entityId } = row.original;
      const href = auditEntityHref(entity, entityId);
      return (
        <div className="min-w-[140px] text-xs">
          <div className="font-semibold">{auditEntityLabel(entity)}</div>
          {entityId ? (
            href ? (
              <RowLink href={href} className="inline-flex items-center gap-1 font-mono text-[11px] font-normal text-muted-foreground">
                {entityId.length > 28 ? `${entityId.slice(0, 12)}…${entityId.slice(-8)}` : entityId} <ExternalLink className="size-3" />
              </RowLink>
            ) : (
              <span className="font-mono text-[11px] text-muted-foreground">{entityId.length > 28 ? `${entityId.slice(0, 12)}…${entityId.slice(-8)}` : entityId}</span>
            )
          ) : null}
        </div>
      );
    },
  },
  {
    id: "detail",
    header: "Chi tiết",
    enableSorting: false,
    cell: ({ row }) => {
      const detail = row.original.detail;
      if (detail === null || detail === undefined) return <span className="text-xs text-muted-foreground">—</span>;
      const text = JSON.stringify(detail, null, 2);
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-[320px] cursor-help truncate text-xs text-muted-foreground">{summarizeDetail(detail)}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-md">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4">{text.length > 1500 ? `${text.slice(0, 1500)}…` : text}</pre>
          </TooltipContent>
        </Tooltip>
      );
    },
  },
];

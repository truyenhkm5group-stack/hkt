"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { RunStatusBadge } from "@/components/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SYNC_SOURCE_LABEL, SYNC_TRIGGER_LABEL, syncJobLabel } from "@/lib/constants/sync";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import type { SyncRunRow } from "@/lib/queries/integrations";

function duration(start: Date, end: Date | null) {
  const ms = (end ? end.getTime() : Date.now()) - start.getTime();
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}p ${s % 60}s`;
  return `${Math.floor(m / 60)}g ${m % 60}p`;
}

export const syncRunColumns: ColumnDef<SyncRunRow, unknown>[] = [
  {
    id: "source",
    accessorKey: "source",
    header: "Nguồn",
    cell: ({ row }) => <span className="whitespace-nowrap text-xs font-semibold">{SYNC_SOURCE_LABEL[row.original.source] ?? row.original.source}</span>,
    size: 110,
  },
  {
    id: "job",
    header: "Job",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="min-w-[160px]">
        <div className="font-medium">{syncJobLabel(row.original.job)}</div>
        <div className="font-mono text-[10.5px] text-muted-foreground">{row.original.job}</div>
      </div>
    ),
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Kết quả",
    cell: ({ row }) => <RunStatusBadge status={row.original.status} />,
    size: 110,
  },
  {
    id: "trigger",
    header: "Kích hoạt",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="text-xs">
        <div>{SYNC_TRIGGER_LABEL[row.original.trigger] ?? row.original.trigger}</div>
        <div className="truncate text-muted-foreground">{row.original.actor}</div>
      </div>
    ),
  },
  {
    id: "counts",
    header: "Mới / cập nhật / bỏ qua / lỗi",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="numeric whitespace-nowrap text-xs">
        <span className="font-semibold text-success">{formatNumber(row.original.imported)}</span>
        <span className="text-muted-foreground"> / </span>
        <span className="font-semibold text-info">{formatNumber(row.original.updated)}</span>
        <span className="text-muted-foreground"> / </span>
        <span>{formatNumber(row.original.skipped)}</span>
        <span className="text-muted-foreground"> / </span>
        <span className={row.original.failed ? "font-semibold text-destructive" : ""}>{formatNumber(row.original.failed)}</span>
      </div>
    ),
  },
  {
    id: "detail",
    header: "Chi tiết",
    enableSorting: false,
    cell: ({ row }) => {
      const { detail, error } = row.original;
      const text = detail || error || "";
      if (!text) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="max-w-[280px] cursor-help">
              <div className="truncate text-xs">{detail || "—"}</div>
              {error ? <div className="truncate text-[11px] text-destructive">{error.split("\n")[0]}</div> : null}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-md whitespace-pre-wrap break-words text-left">
            {detail ? <p>{detail}</p> : null}
            {error ? <p className="mt-1 font-mono text-[11px] opacity-90">{error}</p> : null}
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    id: "startedAt",
    accessorKey: "startedAt",
    header: "Bắt đầu",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-xs text-muted-foreground">
        <div>{formatDateTime(row.original.startedAt)}</div>
        <div className="text-[10.5px]">{formatTimeAgo(row.original.startedAt)}</div>
      </div>
    ),
  },
  {
    id: "duration",
    header: "Thời lượng",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => <span className="numeric text-xs">{row.original.finishedAt ? duration(row.original.startedAt, row.original.finishedAt) : row.original.status === "RUNNING" ? `đang chạy · ${duration(row.original.startedAt, null)}` : "—"}</span>,
    size: 100,
  },
];

"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AGENT_MODE_LABEL, costLabel, RUN_STATUS_LABEL, RUN_STATUS_TONE, type AgentMode, type RunStatus } from "@/lib/constants/ai";
import { SALES_ACTION_LABEL, SALES_STAGE_LABEL, SALES_STAGE_TONE, type SalesAction, type SalesStage } from "@/lib/constants/sales-agent";
import { formatDateTime, formatNumber, formatTimeAgo, formatVND } from "@/lib/format";
import type { AiRunRow } from "@/lib/queries/ai";
import { cn } from "@/lib/utils";

const badge = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

export const aiRunColumns: ColumnDef<AiRunRow, unknown>[] = [
  {
    id: "startedAt",
    accessorKey: "startedAt",
    header: "Thời điểm",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-xs">
        <div className="font-medium">{formatDateTime(row.original.startedAt)}</div>
        <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(row.original.startedAt)}</div>
      </div>
    ),
    size: 130,
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Kết quả",
    cell: ({ row }) => {
      const status = row.original.status as RunStatus;
      return (
        <div className="space-y-1">
          <span className={cn(badge, RUN_STATUS_TONE[status] ?? RUN_STATUS_TONE.SKIPPED)}>{RUN_STATUS_LABEL[status] ?? status}</span>
          <div className="text-[10.5px] text-muted-foreground">{AGENT_MODE_LABEL[row.original.mode as AgentMode] ?? row.original.mode}</div>
        </div>
      );
    },
    size: 150,
  },
  {
    id: "customerMessage",
    accessorKey: "customerMessage",
    header: "Khách nhắn",
    cell: ({ row }) => (
      <div className="min-w-[220px] max-w-[320px]">
        <div className="truncate font-medium">{row.original.customerName || "Khách chưa rõ tên"}</div>
        <div className="line-clamp-2 text-xs text-muted-foreground">{row.original.customerMessage || "—"}</div>
      </div>
    ),
  },
  {
    id: "stage",
    accessorKey: "stage",
    header: "Giai đoạn sau",
    cell: ({ row }) => {
      const stage = row.original.stage as SalesStage;
      return (
        <div className="space-y-1">
          <span className={cn(badge, SALES_STAGE_TONE[stage] ?? "bg-muted text-muted-foreground")}>{SALES_STAGE_LABEL[stage] ?? (stage || "—")}</span>
          <div className="text-[10.5px] text-muted-foreground">{SALES_ACTION_LABEL[row.original.action as SalesAction] ?? row.original.action}</div>
        </div>
      );
    },
    size: 180,
  },
  {
    id: "suggestedReply",
    accessorKey: "suggestedReply",
    header: "Máy gợi ý / Nhân viên trả lời",
    cell: ({ row }) => (
      <div className="min-w-[260px] max-w-[420px] space-y-1 text-xs">
        <div className="line-clamp-2"><span className="font-semibold text-primary">Máy: </span>{row.original.suggestedReply || "— (không soạn gì)"}</div>
        <div className="line-clamp-2 text-muted-foreground">
          <span className="font-semibold">Nhân viên: </span>
          {row.original.humanReply || "chưa trả lời"}
        </div>
      </div>
    ),
  },
  {
    id: "tier",
    accessorKey: "tier",
    header: "Nấc · công cụ",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-xs">
        <div className="font-medium">{row.original.tier}</div>
        <div className="text-[10.5px] text-muted-foreground">
          {formatNumber(row.original.toolCalls)} lượt gọi
          {row.original.deniedCalls > 0 ? ` · ${formatNumber(row.original.deniedCalls)} bị chặn` : ""}
        </div>
      </div>
    ),
    size: 130,
  },
  {
    id: "costVnd",
    accessorKey: "costVnd",
    header: "Token · chi phí",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-right text-xs">
        <div className="font-medium tabular-nums">{costLabel(row.original.costVnd, (n) => formatVND(n))}</div>
        <div className="text-[10.5px] text-muted-foreground tabular-nums">
          {formatNumber(row.original.inputTokens)} / {formatNumber(row.original.outputTokens)} · {formatNumber(row.original.latencyMs)} ms
        </div>
      </div>
    ),
    size: 150,
  },
];

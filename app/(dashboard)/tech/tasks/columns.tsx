"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { TechApprovalBadge, TechCiStateBadge, TechMergeStateBadge, TechPrStateBadge, TechPriorityBadge, TechReviewStateBadge, TechRiskBadge, TechStatusBadge } from "@/app/(dashboard)/tech/badges";
import { TECH_MODULE_LABEL, TECH_TASK_TYPE_LABEL, type TechApprovalStatus, type TechCiState, type TechMergeState, type TechModule, type TechPrState, type TechPriority, type TechReviewState, type TechRisk, type TechTaskStatus, type TechTaskType } from "@/lib/constants/tech";
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
    id: "pr",
    header: "Pull request",
    enableSorting: false,
    /*
      PHÉP CHIẾU, KHÔNG PHẢI LỜI KHẲNG ĐỊNH CỦA ERP.

      GitHub là bên có thẩm quyền; ô này chỉ chép lại. Nên nó in MỐC ĐỌC GẦN NHẤT ngay dưới: một
      dòng "Cổng xanh" không kèm mốc sẽ được đọc là tình trạng BÂY GIỜ, trong khi nó có thể là ảnh
      chụp của mười lăm phút trước — và đó đúng là cách sổ deploy từng báo động giả ngày 20/09/2026
      (sổ cũ 14 giờ, cảnh báo lại trỏ vào container).

      Chưa có PR thì KHÔNG in "—" cụt: nói rõ "chưa mở PR" nếu việc đã có nhánh, và bỏ trống nếu
      chưa có cả nhánh. Hai thứ đó là hai tình trạng khác nhau và gộp lại thì không ai biết phải
      làm gì tiếp.
    */
    cell: ({ row }) => {
      const r = row.original;
      if (!r.prNumber) {
        return <span className="whitespace-nowrap text-[11px] text-muted-foreground">{r.branch ? "— chưa mở PR" : ""}</span>;
      }
      return (
        <div className="min-w-[150px]">
          <div className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs font-semibold">#{r.prNumber}</span>
            <TechPrStateBadge state={r.prState as TechPrState} />
            <TechCiStateBadge state={r.ciState as TechCiState} />
            <TechReviewStateBadge state={r.reviewState as TechReviewState} />
            <TechMergeStateBadge state={r.mergeState as TechMergeState} />
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            {r.prSyncedAt ? `đọc ${formatTimeAgo(r.prSyncedAt)}` : "chưa đọc lần nào"}
          </div>
        </div>
      );
    },
    size: 210,
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

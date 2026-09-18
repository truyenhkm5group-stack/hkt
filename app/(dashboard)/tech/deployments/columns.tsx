"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { TechDeployBadge, TechGateBadge, TechProviderBadge, TechVerificationBadge } from "@/app/(dashboard)/tech/badges";
import { TECH_ACTOR_KIND_LABEL, TECH_VERIFICATION_HINT, type TechActorKind, type TechDeployProvider, type TechDeployStatus, type TechGateResult, type TechVerification } from "@/lib/constants/tech";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { TechDeploymentListRow } from "@/lib/queries/tech-ops";

export const techDeploymentColumns: ColumnDef<TechDeploymentListRow, unknown>[] = [
  {
    id: "startedAt",
    accessorKey: "startedAt",
    header: "Bắt đầu",
    cell: ({ row }) => (
      <div className="whitespace-nowrap text-xs">
        <div className="font-medium">{formatDateTime(row.original.startedAt)}</div>
        <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(row.original.startedAt)}</div>
      </div>
    ),
    size: 150,
  },
  {
    id: "commitSha",
    accessorKey: "commitSha",
    header: "Commit",
    cell: ({ row }) => (
      <div className="whitespace-nowrap">
        <div className="font-mono text-xs font-semibold">{row.original.commitSha.slice(0, 7)}</div>
        <div className="text-[10.5px] text-muted-foreground">{row.original.branch}</div>
        <TechProviderBadge provider={row.original.provider as TechDeployProvider} className="mt-0.5 text-[10px]" />
      </div>
    ),
    size: 120,
  },
  {
    id: "status",
    accessorKey: "status",
    header: "GitHub nói",
    cell: ({ row }) => <TechDeployBadge status={row.original.status as TechDeployStatus} />,
    size: 120,
  },
  {
    /*
      BA CHIỀU, BA CỘT. "GitHub nói xong" và "production đang chạy đúng bản đó" là hai câu hỏi khác
      nhau — workflow xanh KHÔNG chứng minh máy chủ đã khởi động lại. Cột này trả lời câu thứ hai.
    */
    id: "verification",
    header: "Production",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="min-w-[170px]" title={TECH_VERIFICATION_HINT[row.original.verification as TechVerification]}>
        <TechVerificationBadge verification={row.original.verification as TechVerification} />
        <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
          {row.original.productionCommit ? row.original.productionCommit.slice(0, 7) : "— chưa đối chiếu"}
        </div>
      </div>
    ),
    size: 180,
  },
  {
    id: "gates",
    header: "Sau khi lên",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {/* Ba cổng đứng riêng và mặc định “Chưa xác minh”. Chưa đo KHÔNG phải đã đạt. */}
        <TechGateBadge label="health" result={row.original.healthResult as TechGateResult} />
        <TechGateBadge label="smoke" result={row.original.smokeResult as TechGateResult} />
        <TechGateBadge label="quan sát" result={row.original.observationResult as TechGateResult} />
      </div>
    ),
    size: 260,
  },
  {
    id: "actor",
    header: "Do ai",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="text-xs">
        <div>{TECH_ACTOR_KIND_LABEL[row.original.actorKind as TechActorKind] ?? row.original.actorKind}</div>
        <div className="text-muted-foreground">{row.original.actorName || "—"}</div>
      </div>
    ),
    size: 120,
  },
  {
    id: "task",
    header: "Việc Tech",
    enableSorting: false,
    cell: ({ row }) => <span className="text-xs">{row.original.task ? `${row.original.task.code} · ${row.original.task.title}` : <span className="text-muted-foreground">— không gắn việc nào</span>}</span>,
  },
];

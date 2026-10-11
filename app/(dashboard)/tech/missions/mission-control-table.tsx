"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { TechPriorityBadge } from "@/app/(dashboard)/tech/badges";
import { DeliveryBadge, LivenessBadge, MissionControlBadge, RegistryRiskBadge } from "@/app/(dashboard)/tech/missions/registry-badges";
import { DataTable } from "@/components/data-table/data-table";
import type { TechPriority } from "@/lib/constants/tech";
import { MISSION_CONTROL_PAGE_SIZE, MISSION_CONTROL_SORTABLE } from "@/lib/constants/tech-registry";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { MissionControlRow } from "@/lib/queries/tech-registry";

/**
 * Bảng Mission Control — client wrapper bọc `DataTable` (docs/CONVENTIONS.md): cột và hàm sống ở đây, Server Component
 * chỉ truyền DỮ LIỆU. `id` cột trùng `MISSION_CONTROL_SORTABLE`.
 */

function shortOwner(owner: string) {
  const i = owner.lastIndexOf(":");
  return i >= 0 ? owner.slice(i + 1) : owner;
}

function ciLabel(row: MissionControlRow) {
  if (!row.ci) return <span className="text-muted-foreground">—</span>;
  const tone = row.ci === "SUCCESS" ? "text-success" : row.ci === "FAILURE" ? "text-destructive" : "text-warning";
  const text = row.ci === "SUCCESS" ? "gates xanh" : row.ci === "FAILURE" ? "gates đỏ" : "đang chạy";
  return (
    <span className={tone} title={row.ciSource === "MERGE" ? "Đọc từ sự kiện MERGED của sổ (lúc gộp)" : "Phép chiếu PR của /tech (github-pr-sync)"}>
      {text}
      {row.ciSource === "MERGE" ? <span className="text-muted-foreground"> · lúc gộp</span> : null}
    </span>
  );
}

function deployLabel(row: MissionControlRow) {
  if (row.deployCheck === "CONTAINED") return <span className="text-success">có trong production {row.deployCommit.slice(0, 7)}</span>;
  if (row.deployCheck === "NOT_CONTAINED") return <span className="text-warning">chưa có trong production {row.deployCommit.slice(0, 7)}</span>;
  return <span className="text-muted-foreground">ERP chưa kiểm</span>;
}

function PrLinks({ prs, repo }: { prs: number[]; repo: string | null }) {
  if (!prs.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {prs.map((n) =>
        repo ? (
          <a key={n} href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            #{n}
          </a>
        ) : (
          <span key={n}>#{n}</span>
        ),
      )}
    </span>
  );
}

function columns(repo: string | null): ColumnDef<MissionControlRow, unknown>[] {
  return [
    {
      id: "code",
      header: "Sứ mệnh",
      cell: ({ row }) => (
        <div className="min-w-[220px] max-w-[340px] whitespace-normal">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] font-semibold text-muted-foreground">{row.original.code}</span>
            {row.original.source === "ERP" ? <span className="text-[10.5px] text-muted-foreground">· tạo tay trong /tech</span> : null}
            {!row.original.inRegistry ? <span className="text-[10.5px] text-destructive">· đã biến khỏi sổ</span> : null}
          </div>
          <Link href={row.original.href} className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug hover:underline">
            {row.original.title || "—"}
          </Link>
        </div>
      ),
    },
    {
      id: "state",
      header: "Trạng thái",
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-1">
          <MissionControlBadge state={row.original.state} />
          {row.original.phaseLabel && row.original.state === "RUNNING" ? <span className="text-[10.5px] text-muted-foreground">{row.original.phaseLabel}</span> : null}
          <LivenessBadge liveness={row.original.liveness} />
        </div>
      ),
    },
    {
      id: "priority",
      header: "Ưu tiên",
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-1">
          <TechPriorityBadge priority={row.original.priority as TechPriority} />
          {row.original.risk ? <RegistryRiskBadge risk={row.original.risk} /> : null}
        </div>
      ),
    },
    {
      id: "owner",
      header: "Phụ trách",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="max-w-[140px] text-xs" title={row.original.owner}>
          <div className="truncate">{row.original.owner ? shortOwner(row.original.owner) : "—"}</div>
          <div className="truncate font-mono text-[10.5px] text-muted-foreground">{row.original.branch || "—"}</div>
        </div>
      ),
    },
    {
      id: "pr",
      header: "PR · CI",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="text-xs">
          <PrLinks prs={row.original.prs} repo={repo} />
          <div className="text-[10.5px]">{ciLabel(row.original)}</div>
        </div>
      ),
    },
    {
      id: "deploy",
      header: "Giao hàng",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.delivery ? (
          <div className="flex flex-col items-start gap-0.5 text-[10.5px]">
            <DeliveryBadge level={row.original.delivery} short />
            {deployLabel(row.original)}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "updatedAt",
      header: "Cập nhật cuối",
      cell: ({ row }) => (
        <div className="whitespace-nowrap text-xs">
          <div className="font-medium">{formatTimeAgo(row.original.updatedAt)}</div>
          <div className="text-[10.5px] text-muted-foreground">{formatDateTime(row.original.updatedAt)}</div>
        </div>
      ),
    },
  ];
}

function MobileCard({ row }: { row: MissionControlRow }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <MissionControlBadge state={row.state} />
        <TechPriorityBadge priority={row.priority as TechPriority} />
        <LivenessBadge liveness={row.liveness} />
      </div>
      <p className="text-sm font-semibold leading-snug">{row.title || "—"}</p>
      <p className="break-all font-mono text-[11px] text-muted-foreground">{row.code}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {row.phaseLabel && row.state === "RUNNING" ? <span>{row.phaseLabel}</span> : null}
        {row.owner ? <span>· {shortOwner(row.owner)}</span> : null}
        {row.prs.length ? <span>· PR {row.prs.map((n) => `#${n}`).join(" ")}</span> : null}
        {row.delivery ? <DeliveryBadge level={row.delivery} short /> : null}
        <span>· {formatTimeAgo(row.updatedAt)}</span>
      </div>
    </div>
  );
}

export function MissionControlTable({ rows, pageCount, total, repo }: { rows: MissionControlRow[]; pageCount: number; total: number; repo: string | null }) {
  return (
    <DataTable
      columns={columns(repo)}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(r) => r.key}
      rowHref={(r) => r.href}
      defaultSort="updatedAt"
      sortable={MISSION_CONTROL_SORTABLE}
      defaultPageSize={MISSION_CONTROL_PAGE_SIZE}
      dense
      mobileCard={(r) => <MobileCard row={r} />}
      emptyTitle="Không có sứ mệnh nào khớp bộ lọc"
      emptyDescription="Bỏ bớt bộ lọc, hoặc bấm «Đọc lại sổ» nếu sổ chưa được đọc lần nào."
    />
  );
}

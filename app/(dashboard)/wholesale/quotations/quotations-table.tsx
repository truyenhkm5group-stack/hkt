"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { formatDate, formatVND } from "@/lib/format";
import type { QuotationListRow } from "@/lib/queries/wholesale-quotations";
import { QUOTATION_STATUS_LABEL, type QuotationStatus } from "@/lib/wholesale/quotation-engine";
import { cn } from "@/lib/utils";

const TONE: Record<QuotationStatus, string> = {
  DRAFT: "bg-muted text-foreground",
  PENDING_APPROVAL: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  APPROVED: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  SENT: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  ACCEPTED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  EXPIRED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  SUPERSEDED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400",
};

export function QuotationStatusBadge({ status }: { status: QuotationStatus }) {
  return <span className={cn("inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold", TONE[status])}>{QUOTATION_STATUS_LABEL[status]}</span>;
}

const columns: ColumnDef<QuotationListRow, unknown>[] = [
  {
    id: "code",
    header: "Báo giá",
    cell: ({ row: { original: r } }) => (
      <div className="min-w-0 max-w-[260px]">
        <div className="font-medium tabular-nums">
          {r.code} <span className="text-xs text-muted-foreground">· bản {r.version}</span>
        </div>
        <div className="truncate text-xs text-muted-foreground" title={r.partyName}>
          {r.partyName || "—"} · {r.leadId ? "lead" : "khách"}
        </div>
      </div>
    ),
  },
  {
    id: "status",
    header: "Trạng thái",
    cell: ({ row: { original: r } }) => (
      <div className="space-y-1">
        <QuotationStatusBadge status={r.status} />
        {r.blockerCount ? <div className="text-xs text-rose-700 dark:text-rose-400">{r.blockerCount} chặn</div> : r.requiresApproval && (r.status === "DRAFT" || r.status === "PENDING_APPROVAL") ? <div className="text-xs text-amber-700 dark:text-amber-400">cần duyệt</div> : null}
      </div>
    ),
  },
  {
    id: "total",
    header: "Tổng",
    cell: ({ row: { original: r } }) => (
      <div className="whitespace-nowrap text-right tabular-nums">
        <div>{formatVND(r.total)}</div>
        <div className="text-xs text-muted-foreground">{[r.shippingKnown ? null : "chưa gồm ship", r.taxKnown ? null : "chưa gồm thuế"].filter(Boolean).join(" · ") || "đã gồm ship + thuế"}</div>
      </div>
    ),
  },
  { id: "validUntil", header: "Hiệu lực đến", cell: ({ row: { original: r } }) => <span className="whitespace-nowrap tabular-nums">{formatDate(r.validUntil)}</span> },
  {
    id: "createdAt",
    header: "Lập",
    cell: ({ row: { original: r } }) => (
      <div className="whitespace-nowrap text-xs">
        <div className="tabular-nums">{formatDate(r.createdAt, true)}</div>
        <div className="text-muted-foreground">{r.createdByName || "—"}</div>
      </div>
    ),
  },
];

export function QuotationsTable({ rows, total, pageCount }: { rows: QuotationListRow[]; total: number; pageCount: number }) {
  return <DataTable columns={columns} data={rows} total={total} pageCount={pageCount} getRowId={(r) => r.id} rowHref={(r) => `/wholesale/quotations/${r.id}`} defaultSort="createdAt" defaultDir="desc" />;
}

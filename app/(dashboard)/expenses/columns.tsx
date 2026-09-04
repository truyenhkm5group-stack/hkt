"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AdSpendRowActions, ExpenseRowActions } from "@/app/(dashboard)/expenses/row-actions";
import { Money } from "@/components/ui-bits";
import { AD_PLATFORM_TONE, EXPENSE_CATEGORY_LABEL, EXPENSE_CATEGORY_TONE } from "@/lib/constants/expenses";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import type { AdSpendRow, ExpenseRow } from "@/lib/queries/expenses";
import { cn } from "@/lib/utils";

const badge = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

export function ExpenseCategoryBadge({ category, className }: { category: ExpenseRow["category"]; className?: string }) {
  return <span className={cn(badge, EXPENSE_CATEGORY_TONE[category] ?? EXPENSE_CATEGORY_TONE.OTHER, className)}>{EXPENSE_CATEGORY_LABEL[category] ?? category}</span>;
}

export function AdPlatformBadge({ platform, className }: { platform: string; className?: string }) {
  return <span className={cn(badge, AD_PLATFORM_TONE[platform] ?? "bg-muted text-muted-foreground", className)}>{platform}</span>;
}

export function buildExpenseColumns({ canWrite }: { canWrite: boolean }): ColumnDef<ExpenseRow, unknown>[] {
  const columns: ColumnDef<ExpenseRow, unknown>[] = [
    {
      id: "occurredAt",
      accessorKey: "occurredAt",
      header: "Ngày",
      cell: ({ row }) => <span className="whitespace-nowrap text-sm font-medium">{formatDate(row.original.occurredAt)}</span>,
      size: 110,
    },
    {
      id: "category",
      accessorKey: "category",
      header: "Nhóm chi phí",
      cell: ({ row }) => <ExpenseCategoryBadge category={row.original.category} />,
      size: 140,
    },
    {
      id: "description",
      header: "Mô tả",
      enableSorting: false,
      cell: ({ row }) => <div className="min-w-[220px] max-w-[420px] truncate font-medium">{row.original.description || "—"}</div>,
    },
    {
      id: "amount",
      accessorKey: "amount",
      header: "Số tiền",
      meta: { align: "right" },
      cell: ({ row }) => <Money value={row.original.amount} className="font-bold" />,
      size: 140,
    },
    {
      id: "reference",
      header: "Tham chiếu",
      enableSorting: false,
      cell: ({ row }) => (row.original.reference ? <span className="font-mono text-xs text-muted-foreground">{row.original.reference}</span> : <span className="text-xs text-muted-foreground">—</span>),
    },
    {
      id: "createdBy",
      header: "Người tạo",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="text-xs text-muted-foreground">
          <div className="truncate">{row.original.createdBy || "—"}</div>
          <div className="text-[10.5px]">{formatDate(row.original.createdAt, true)}</div>
        </div>
      ),
    },
  ];
  if (canWrite) {
    columns.push({
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <ExpenseRowActions row={row.original} />
        </div>
      ),
      size: 48,
    });
  }
  return columns;
}

export function buildAdSpendColumns({ canWrite }: { canWrite: boolean }): ColumnDef<AdSpendRow, unknown>[] {
  const columns: ColumnDef<AdSpendRow, unknown>[] = [
    {
      id: "spendDate",
      accessorKey: "spendDate",
      header: "Ngày",
      cell: ({ row }) => <span className="whitespace-nowrap text-sm font-medium">{formatDate(row.original.spendDate)}</span>,
      size: 110,
    },
    {
      id: "platform",
      accessorKey: "platform",
      header: "Nền tảng",
      cell: ({ row }) => <AdPlatformBadge platform={row.original.platform} />,
      size: 120,
    },
    {
      id: "campaign",
      header: "Chiến dịch",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-[180px] max-w-[320px]">
          <div className="truncate font-medium">{row.original.campaign || "—"}</div>
          {row.original.note ? <div className="truncate text-xs text-muted-foreground">{row.original.note}</div> : null}
        </div>
      ),
    },
    {
      id: "spend",
      accessorKey: "spend",
      header: "Chi tiêu",
      meta: { align: "right" },
      cell: ({ row }) => <Money value={row.original.spend} className="font-bold" />,
    },
    {
      id: "leads",
      accessorKey: "leads",
      header: "Leads",
      meta: { align: "right" },
      cell: ({ row }) => <span className="numeric">{formatNumber(row.original.leads)}</span>,
      size: 80,
    },
    {
      id: "orders",
      accessorKey: "orders",
      header: "Đơn",
      meta: { align: "right" },
      cell: ({ row }) => <span className="numeric font-semibold">{formatNumber(row.original.orders)}</span>,
      size: 70,
    },
    {
      id: "revenue",
      accessorKey: "revenue",
      header: "Doanh thu",
      meta: { align: "right" },
      cell: ({ row }) => <Money value={row.original.revenue} />,
    },
    {
      id: "roas",
      header: "ROAS",
      enableSorting: false,
      meta: { align: "right" },
      cell: ({ row }) => {
        const roas = row.original.spend ? row.original.revenue / row.original.spend : 0;
        return <span className={cn("numeric font-semibold", roas >= 3 ? "text-success" : roas > 0 && roas < 1.5 ? "text-destructive" : "")}>{roas ? `${roas.toFixed(2)}×` : "—"}</span>;
      },
      size: 80,
    },
    {
      id: "cpo",
      header: "CPO",
      enableSorting: false,
      meta: { align: "right" },
      cell: ({ row }) => <span className="numeric text-xs text-muted-foreground">{row.original.orders ? formatVND(Math.round(row.original.spend / row.original.orders)) : "—"}</span>,
    },
  ];
  if (canWrite) {
    columns.push({
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <AdSpendRowActions row={row.original} />
        </div>
      ),
      size: 48,
    });
  }
  return columns;
}

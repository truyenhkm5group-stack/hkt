"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import {
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { DataTablePagination } from "@/components/data-table/pagination";

export type DataTableProps<T> = {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  pageCount: number;
  total: number;
  rowHref?: (row: T) => string | undefined;
  getRowId?: (row: T) => string;
  emptyTitle?: string;
  emptyDescription?: React.ReactNode;
  selectable?: boolean;
  bulkActions?: (rows: T[], clear: () => void) => React.ReactNode;
  className?: string;
  dense?: boolean;
  footer?: React.ReactNode;
};

export const tableParsers = {
  page: parseAsInteger.withDefault(1),
  pageSize: parseAsInteger.withDefault(25),
  sort: parseAsString.withDefault(""),
  dir: parseAsString.withDefault("desc"),
};

export function DataTable<T>({ columns, data, pageCount, total, rowHref, getRowId, emptyTitle = "Không có dữ liệu", emptyDescription, selectable, bulkActions, className, dense, footer }: DataTableProps<T>) {
  const router = useRouter();
  const [params, setParams] = useQueryStates(tableParsers, { shallow: false, history: "push" });
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const sorting: SortingState = params.sort ? [{ id: params.sort, desc: params.dir !== "asc" }] : [];

  const allColumns = React.useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return columns;
    const select: ColumnDef<T, unknown> = {
      id: "__select",
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Chọn tất cả"
          className="translate-y-[2px]"
        />
      ),
      cell: ({ row }) => (
        <Checkbox checked={row.getIsSelected()} onCheckedChange={(value) => row.toggleSelected(!!value)} aria-label="Chọn dòng" className="translate-y-[2px]" onClick={(e) => e.stopPropagation()} />
      ),
      enableSorting: false,
      size: 36,
    };
    return [select, ...columns];
  }, [columns, selectable]);

  const table = useReactTable({
    data,
    columns: allColumns,
    pageCount,
    state: { sorting, rowSelection, columnVisibility, pagination: { pageIndex: params.page - 1, pageSize: params.pageSize } },
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    enableRowSelection: Boolean(selectable),
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      void setParams({ sort: first?.id ?? "", dir: first ? (first.desc ? "desc" : "asc") : "desc", page: 1 });
    },
    onPaginationChange: (updater) => {
      const current = { pageIndex: params.page - 1, pageSize: params.pageSize };
      const next = typeof updater === "function" ? updater(current) : updater;
      void setParams({ page: next.pageIndex + 1, pageSize: next.pageSize });
    },
    getCoreRowModel: getCoreRowModel(),
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
  });

  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);
  const clearSelection = () => setRowSelection({});

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {selectable && selectedRows.length > 0 && bulkActions ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-semibold">Đã chọn {selectedRows.length}</span>
          <div className="flex flex-wrap items-center gap-2">{bulkActions(selectedRows, clearSelection)}</div>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={clearSelection}>
            Bỏ chọn
          </Button>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <Table className={cn(dense && "[&_td]:py-1.5")}>
            <TableHeader className="bg-muted/50">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort() && header.column.id !== "__select";
                    const sorted = header.column.getIsSorted();
                    const align = (header.column.columnDef.meta as { align?: string } | undefined)?.align;
                    return (
                      <TableHead key={header.id} style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }} className={cn("h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground", align === "right" && "text-right")}>
                        {header.isPlaceholder ? null : canSort ? (
                          <button type="button" className={cn("inline-flex items-center gap-1 uppercase hover:text-foreground", align === "right" && "flex-row-reverse")} onClick={header.column.getToggleSortingHandler()}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-50" />}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => {
                  const href = rowHref?.(row.original);
                  return (
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() && "selected"}
                      className={cn(href && "cursor-pointer")}
                      onClick={(e) => {
                        if (!href) return;
                        const target = e.target as HTMLElement;
                        if (target.closest("a,button,input,[role=checkbox],[data-no-row-link]")) return;
                        if (e.metaKey || e.ctrlKey) window.open(href, "_blank");
                        else router.push(href);
                      }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align;
                        return (
                          <TableCell key={cell.id} className={cn("align-middle", align === "right" && "text-right")}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={allColumns.length} className="h-40">
                    <div className="flex flex-col items-center justify-center gap-2 text-center">
                      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Inbox className="size-5" />
                      </span>
                      <p className="text-sm font-semibold">{emptyTitle}</p>
                      {emptyDescription ? <div className="max-w-sm text-xs text-muted-foreground">{emptyDescription}</div> : null}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {footer}
        <DataTablePagination page={params.page} pageSize={params.pageSize} pageCount={pageCount} total={total} onPageChange={(page) => void setParams({ page })} onPageSizeChange={(pageSize) => void setParams({ pageSize, page: 1 })} />
      </div>
    </div>
  );
}

export function RowLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn("font-semibold text-foreground hover:text-primary hover:underline", className)} onClick={(e) => e.stopPropagation()}>
      {children}
    </Link>
  );
}

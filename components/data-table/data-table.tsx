"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import {
  type ColumnDef,
  type Row,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsUpDown, Inbox } from "lucide-react";
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
  /**
   * Gom nhóm cha – con (vd mã hàng → mẫu mã): key(row) là khoá nhóm; parent(rows) tạo dòng cha (tổng hợp) hiển thị bằng chính
   * các cột; defaultExpanded mở sẵn (mặc định đóng, bấm mũi tên để xổ). Nhóm chỉ có 1 dòng thì hiện thẳng dòng đó.
   */
  group?: { key: (row: T) => string; parent: (rows: T[], key: string) => T; defaultExpanded?: boolean; parentHref?: (parent: T, rows: T[]) => string | undefined };
  /** Cột và chiều sắp xếp mặc định của trang (khớp với parseListParams ở phía máy chủ) để mũi tên hiển thị đúng thứ tự thật */
  defaultSort?: string;
  defaultDir?: "asc" | "desc";
  /**
   * Các mã cột được phép sắp xếp (chính là danh sách *_SORTABLE của truy vấn). Cần cho các cột chỉ hiển thị
   * (không có accessorKey) vì TanStack không cho sắp xếp cột loại này, dù máy chủ vẫn sắp xếp được.
   */
  sortable?: string[];
};

export const tableParsers = {
  page: parseAsInteger.withDefault(1),
  pageSize: parseAsInteger.withDefault(25),
  // clearOnDefault: false — nuqs mặc định XOÁ tham số khi giá trị bằng mặc định. Nếu để mặc định, bấm sắp xếp giảm dần
  // sẽ xoá "dir=desc" khỏi URL, máy chủ lại lấy mặc định riêng của trang (có trang là "asc") → sắp xếp không có tác dụng.
  sort: parseAsString.withDefault("").withOptions({ clearOnDefault: false }),
  dir: parseAsString.withDefault("desc").withOptions({ clearOnDefault: false }),
};

/** Parser theo mặc định sắp xếp của TỪNG trang để mũi tên trên tiêu đề khớp với thứ tự máy chủ đang trả về */
function sortParsers(defaultSort: string, defaultDir: "asc" | "desc") {
  return {
    page: parseAsInteger.withDefault(1),
    pageSize: parseAsInteger.withDefault(25),
    sort: parseAsString.withDefault(defaultSort).withOptions({ clearOnDefault: false }),
    dir: parseAsString.withDefault(defaultDir).withOptions({ clearOnDefault: false }),
  };
}

export function DataTable<T>({ columns, data, pageCount, total, rowHref, getRowId, emptyTitle = "Không có dữ liệu", emptyDescription, selectable, bulkActions, className, dense, footer, group, defaultSort = "", defaultDir = "desc", sortable }: DataTableProps<T>) {
  const router = useRouter();
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [allOpen, setAllOpen] = React.useState<boolean | null>(null);
  // gom nhóm theo thứ tự xuất hiện; dòng cha là bản tổng hợp do trang cung cấp
  const groups = React.useMemo(() => {
    if (!group) return null;
    const map = new Map<string, T[]>();
    for (const row of data) {
      const k = group.key(row);
      const list = map.get(k) ?? [];
      list.push(row);
      map.set(k, list);
    }
    return [...map.entries()].map(([key, rows]) => ({ key, rows, parent: rows.length > 1 ? group.parent(rows, key) : null }));
  }, [data, group]);
  const isOpen = (key: string) => (expanded[key] !== undefined ? expanded[key] : allOpen !== null ? allOpen : Boolean(group?.defaultExpanded));
  const parsers = React.useMemo(() => sortParsers(defaultSort, defaultDir), [defaultSort, defaultDir]);
  const [params, setParams] = useQueryStates(parsers, { shallow: false, history: "push" });
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
      void setParams({ sort: first?.id ?? "", dir: first ? (first.desc ? "desc" : "asc") : defaultDir, page: 1 });
    },
    onPaginationChange: (updater) => {
      const current = { pageIndex: params.page - 1, pageSize: params.pageSize };
      const next = typeof updater === "function" ? updater(current) : updater;
      void setParams({ page: next.pageIndex + 1, pageSize: next.pageSize });
    },
    getCoreRowModel: getCoreRowModel(),
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
  });

  const sortableSet = React.useMemo(() => new Set(sortable ?? []), [sortable]);
  // Tự xử lý bấm sắp xếp thay vì dùng TanStack: sắp xếp chạy ở máy chủ, và cột chỉ hiển thị (không accessorKey)
  // cũng phải bấm được. Vòng lặp: chưa sắp xếp → giảm dần → tăng dần → trở về mặc định của trang.
  const toggleSort = (id: string) => {
    const current = params.sort === id ? (params.dir === "asc" ? "asc" : "desc") : null;
    const next = current === null ? "desc" : current === "desc" ? "asc" : null;
    void setParams({ sort: next ? id : defaultSort, dir: next ?? defaultDir, page: 1 });
  };

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
      {groups && groups.some((g) => g.parent) ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{groups.length} nhóm · bấm mũi tên hoặc dòng cha để xổ chi tiết</span>
          <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => { setAllOpen(true); setExpanded({}); }}>Mở tất cả</button>
          <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => { setAllOpen(false); setExpanded({}); }}>Thu gọn tất cả</button>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <Table className={cn(dense && "[&_td]:py-1.5")}>
            <TableHeader className="bg-muted/50">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.id !== "__select" && (header.column.getCanSort() || sortableSet.has(header.column.id));
                    const sorted: false | "asc" | "desc" = params.sort === header.column.id ? (params.dir === "asc" ? "asc" : "desc") : false;
                    const align = (header.column.columnDef.meta as { align?: string } | undefined)?.align;
                    return (
                      <TableHead key={header.id} style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }} className={cn("h-10 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground", align === "right" && "text-right")}>
                        {header.isPlaceholder ? null : canSort ? (
                          <button type="button" className={cn("inline-flex items-center gap-1 uppercase hover:text-foreground", align === "right" && "flex-row-reverse")} onClick={() => toggleSort(header.column.id)}>
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
                (() => {
                  const rowsById = new Map(table.getRowModel().rows.map((r) => [r.id, r]));
                  const renderRow = (row: Row<T>, opts: { child?: boolean; parentKey?: string } = {}) => {
                    const href = rowHref?.(row.original);
                    return (
                      <TableRow
                        key={row.id}
                        data-state={row.getIsSelected() && "selected"}
                        className={cn(href && "cursor-pointer", opts.child && "bg-muted/20 text-[12.5px]")}
                        onClick={(e) => {
                          if (!href) return;
                          const target = e.target as HTMLElement;
                          if (target.closest("a,button,input,[role=checkbox],[data-no-row-link]")) return;
                          if (e.metaKey || e.ctrlKey) window.open(href, "_blank");
                          else router.push(href);
                        }}
                      >
                        {row.getVisibleCells().map((cell, idx) => {
                          const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align;
                          return (
                            <TableCell key={cell.id} className={cn("align-middle", align === "right" && "text-right", opts.child && idx === (selectable ? 1 : 0) && "pl-10")}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  };
                  if (!groups) return table.getRowModel().rows.map((row) => renderRow(row));
                  const rowId = (r: T) => (getRowId ? getRowId(r) : "");
                  return groups.flatMap((g) => {
                    if (!g.parent) {
                      const r = rowsById.get(rowId(g.rows[0]));
                      return r ? [renderRow(r)] : [];
                    }
                    const open = isOpen(g.key);
                    // dòng cha: render qua react-table tạm (không nằm trong data) bằng cách tạo row ảo
                    const parentRow = table.getRowModel().rows[0];
                    const parentHref = group?.parentHref?.(g.parent, g.rows);
                    const parentCells = parentRow.getVisibleCells().map((cell, idx) => {
                      const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align;
                      const ctx = { ...cell.getContext(), row: { ...cell.row, original: g.parent as T, getValue: (id: string) => (g.parent as Record<string, unknown>)[id] } };
                      const content = flexRender(cell.column.columnDef.cell, ctx as never);
                      const first = idx === (selectable ? 1 : 0);
                      return (
                        <TableCell key={`${g.key}-${cell.column.id}`} className={cn("align-middle font-semibold", align === "right" && "text-right")}>
                          {first ? (
                            <span className="flex items-center gap-1.5">
                              <button type="button" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={(e) => { e.stopPropagation(); setExpanded((x) => ({ ...x, [g.key]: !open })); }} aria-label={open ? "Thu gọn" : "Xổ chi tiết"}>
                                {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                              </button>
                              <span className="min-w-0 flex-1">{content}</span>
                              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] font-medium text-muted-foreground">{g.rows.length}</span>
                            </span>
                          ) : (
                            content
                          )}
                        </TableCell>
                      );
                    });
                    const parentEl = (
                      <TableRow
                        key={`group-${g.key}`}
                        className={cn("bg-muted/40 hover:bg-muted/50", parentHref && "cursor-pointer")}
                        onClick={(e) => {
                          const target = e.target as HTMLElement;
                          if (target.closest("a,button,input,[role=checkbox],[data-no-row-link]")) return;
                          if (parentHref) {
                            if (e.metaKey || e.ctrlKey) window.open(parentHref, "_blank");
                            else router.push(parentHref);
                          } else setExpanded((x) => ({ ...x, [g.key]: !open }));
                        }}
                      >
                        {parentCells}
                      </TableRow>
                    );
                    if (!open) return [parentEl];
                    return [parentEl, ...g.rows.map((r) => rowsById.get(rowId(r))).filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => renderRow(r, { child: true, parentKey: g.key }))];
                  });
                })()
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

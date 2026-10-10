"use client";

/*
  DANH SÁCH SẢN PHẨM CỦA KHÁCH VỎ CHỐT ĐƠN.
  Khách chỉ thuê Chốt Đơn Tự Động từng thấy nguyên bảng sổ kho 15 cột của ERP. Ở đây chỉ còn bốn câu hỏi người bán nhỏ hỏi:
  bán cái gì (tên · SKU · mẫu mã) · giá bao nhiêu · còn bao nhiêu · thiếu gì để AI chào bán được. Dữ liệu là dòng
  `listProducts()` đã tính, rút gọn ở máy chủ bằng `shellProductRow()` — không có công thức tồn thứ hai.
*/
import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Package } from "lucide-react";
import { DataTable, RowLink } from "@/components/data-table/data-table";
import { Money } from "@/components/ui-bits";
import { PRODUCT_LIST_PAGE_SIZE } from "@/lib/constants/inventory";
import { shellGapText, shellProductGroup, shellStockText, type ShellProductRow } from "@/lib/constants/products-shell";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

function priceCell(r: ShellProductRow) {
  if (!(r.priceMax > 0)) return <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">Chưa có giá</span>;
  if (r.priceMin === r.priceMax) return <Money value={r.priceMax} className="font-semibold" />;
  return (
    <span className="whitespace-nowrap">
      <Money value={r.priceMin} className="font-semibold" /> – <Money value={r.priceMax} className="font-semibold" />
    </span>
  );
}

function stockCell(r: ShellProductRow) {
  // Chưa có phiếu nhập ⇒ CHƯA BIẾT tồn: in câu, không in 0 (AGENTS.md luật 3.10 `stockKnown`, luật 42).
  if (r.available === null) return <span className="text-[11px] font-semibold text-muted-foreground">{shellStockText(r)}</span>;
  return (
    <div className="text-right">
      <span className={cn("numeric font-semibold", r.available <= 0 ? "text-destructive" : r.available <= 5 ? "text-amber-600 dark:text-amber-400" : "")}>{shellStockText(r)}</span>
      {r.unknownVariants ? <div className="text-[10.5px] text-muted-foreground">{formatNumber(r.unknownVariants)} mẫu chưa có phiếu nhập</div> : null}
    </div>
  );
}

const COLUMNS: ColumnDef<ShellProductRow, unknown>[] = [
  {
    id: "sku",
    accessorKey: "sku",
    header: "Sản phẩm",
    cell: ({ row }) => {
      const r = row.original;
      const parent = r.id.startsWith("group:");
      return (
        <div className="flex min-w-[220px] items-center gap-3">
          {r.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.image} alt="" className="size-10 shrink-0 rounded-md border object-cover" />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
              <Package className="size-4" />
            </span>
          )}
          <div className="min-w-0">
            <RowLink href={`/products/${r.productId}`} className="block truncate">
              {r.productName}
            </RowLink>
            <div className="truncate text-xs text-muted-foreground">
              {parent ? (
                `${formatNumber(r.variantCount)} mẫu mã`
              ) : (
                <>
                  <span className="font-mono">{r.sku || "—"}</span>
                  {r.variantLabel ? <span className="ml-2">{r.variantLabel}</span> : null}
                </>
              )}
            </div>
          </div>
        </div>
      );
    },
  },
  {
    id: "retailPrice",
    accessorKey: "priceMax",
    header: "Giá bán",
    meta: { align: "right" },
    cell: ({ row }) => <div className="text-right">{priceCell(row.original)}</div>,
  },
  {
    id: "available",
    header: "Tồn khả dụng",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => stockCell(row.original),
  },
  {
    id: "gaps",
    header: "Thiếu gì để AI bán được",
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      if (!r.gaps.length) return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Đủ để bán</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {r.gaps.map((g) => (
            <span key={g.gap} className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", g.gap === "REMOVED" ? "bg-muted text-muted-foreground" : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300")}>
              {shellGapText(g, r.variantCount)}
            </span>
          ))}
        </div>
      );
    },
  },
];

export function ShellProductList({ rows, pageCount, total, emptyDescription }: { rows: ShellProductRow[]; pageCount: number; total: number; emptyDescription: string }) {
  const columns = useMemo(() => COLUMNS, []);
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      defaultSort="erpStock"
      defaultDir="asc"
      defaultPageSize={PRODUCT_LIST_PAGE_SIZE}
      rowHref={(row) => `/products/${row.productId}`}
      getRowId={(row) => row.id}
      group={{ key: (row) => row.productId, parentHref: (p) => `/products/${p.productId}`, parent: (rows) => shellProductGroup(rows) }}
      emptyTitle="Chưa có sản phẩm"
      emptyDescription={emptyDescription}
    />
  );
}

"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Shirt } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { Money } from "@/components/ui-bits";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import type { ProductListRow } from "@/lib/queries/products";
import { cn } from "@/lib/utils";

export function stockTone(remain: number) {
  if (remain <= 0) return "text-destructive";
  if (remain <= 5) return "text-amber-600 dark:text-amber-400";
  return "";
}

/** Danh sách đơn chờ xuất: dòng mã hàng (gộp) mở theo mã, dòng mẫu mã mở theo mẫu. */
function reservedHref(r: ProductListRow) {
  return r.id.startsWith("group:") ? `/products/reserved?product=${encodeURIComponent(r.productId)}` : `/products/reserved?variant=${encodeURIComponent(r.id)}`;
}

/** Tạo cột cho bảng mẫu mã; mỗi kho là một cột riêng (danh sách kho lấy từ server) */
export function buildProductColumns(warehouses: { id: string; name: string }[]): ColumnDef<ProductListRow, unknown>[] {
  // Tồn theo từng kho Pancake không hiển thị trong bảng (số Pancake không phản ánh tồn thật); vẫn có trong CSV.
  void warehouses;

  return [
    {
      id: "sku",
      accessorKey: "sku",
      header: "Sản phẩm",
      cell: ({ row }) => {
        const r = row.original;
        const image = r.images[0] || r.productImage;
        return (
          <div className="flex min-w-[240px] items-center gap-3">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" className="size-10 shrink-0 rounded-md border object-cover" />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                <Shirt className="size-4" />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <RowLink href={`/products/${r.productId}`} className="truncate">
                  {r.productName}
                </RowLink>
                {!r.selling ? <span className="rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">Ẩn/khoá</span> : null}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{r.sku || "—"}</span>
                {r.color || r.size ? <span className="ml-2">{[r.color, r.size].filter(Boolean).join(" / ")}</span> : null}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "retailPrice",
      accessorKey: "retailPrice",
      header: "Giá bán",
      meta: { align: "right" },
      cell: ({ row }) => <Money value={row.original.retailPrice} className="font-semibold" />,
    },
    {
      id: "cost",
      header: "Giá vốn",
      enableSorting: false,
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <Money value={row.original.unitCost} className={row.original.unitCost ? "" : "text-muted-foreground"} />
          {row.original.unitCost !== row.original.lastImportedPrice && row.original.lastImportedPrice > 0 ? (
            <div className="text-[10.5px] text-muted-foreground">
              Pancake <Money value={row.original.lastImportedPrice} />
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "receiptIn",
      accessorKey: "receiptIn",
      header: "Nhập mới",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric font-medium", row.original.receiptIn === 0 && "text-muted-foreground")}>{formatNumber(row.original.receiptIn)}</span>
          {row.original.receiptCount ? <div className="text-[10.5px] text-muted-foreground">{row.original.receiptCount} phiếu</div> : null}
        </div>
      ),
    },
    {
      id: "returnIn",
      accessorKey: "returnIn",
      // Số kho ĐẾM THỰC TẾ khi nhận hàng hoàn về, không phải số suy ra từ vận đơn.
      header: "Tái nhập",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric", row.original.returnIn ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>{formatNumber(row.original.returnIn)}</span>
          {row.original.shrinkage ? <div className="text-[10.5px] text-rose-600 dark:text-rose-400">hụt {formatNumber(row.original.shrinkage)}</div> : null}
        </div>
      ),
    },
    {
      id: "adjust",
      accessorKey: "adjust",
      header: "Điều chỉnh",
      meta: { align: "right" },
      cell: ({ row }) => {
        const v = row.original.adjust;
        return (
          <div className="text-right">
            <span className={cn("numeric", v > 0 && "text-emerald-700 dark:text-emerald-400", v < 0 && "text-amber-600 dark:text-amber-400", v === 0 && "text-muted-foreground")}>
              {v > 0 ? `+${formatNumber(v)}` : formatNumber(v)}
            </span>
            {row.original.manualOut ? <div className="text-[10.5px] text-muted-foreground">xuất tay {formatNumber(row.original.manualOut)}</div> : null}
          </div>
        );
      },
    },
    {
      id: "shipped",
      accessorKey: "shipped",
      // Hàng rời kho theo xác nhận LẤY HÀNG của Viettel Post, không theo trạng thái Pancake và không theo tiền.
      header: "Đã xuất",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric font-medium", row.original.shipped === 0 && "text-muted-foreground")}>{formatNumber(row.original.shipped)}</span>
          {row.original.reserved ? (
            <Link
              href={reservedHref(row.original)}
              className="block text-[10.5px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
              title="Xem các đơn đã chốt đang chờ xuất"
            >
              chờ xuất {formatNumber(row.original.reserved)}
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      id: "inTransit",
      accessorKey: "inTransit",
      header: "Đang ở ngoài",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric", row.original.inTransit ? "text-sky-700 dark:text-sky-400" : "text-muted-foreground")}>{formatNumber(row.original.inTransit)}</span>
          {row.original.awaitingReturn ? (
            <div className="text-[10.5px] text-amber-600 dark:text-amber-400">hoàn chờ nhận {formatNumber(row.original.awaitingReturn)}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: "erpStock",
      accessorKey: "erpStock",
      header: "Tồn thực tế",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          {row.original.stockKnown ? (
            <span className={cn("numeric text-base font-bold", stockTone(row.original.erpStock))}>{formatNumber(row.original.erpStock)}</span>
          ) : (
            // Chưa có phiếu nhập nào ⇒ KHÔNG biết tồn. Hiện số âm bịa ra còn tệ hơn nói thẳng là chưa biết.
            <span className="text-[11px] font-semibold text-muted-foreground">Chưa có phiếu nhập</span>
          )}
        </div>
      ),
    },
    {
      id: "available",
      accessorKey: "available",
      header: "Khả dụng bán",
      meta: { align: "right" },
      cell: ({ row }) =>
        row.original.stockKnown ? (
          <span className={cn("numeric font-semibold", stockTone(row.original.available))}>{formatNumber(row.original.available)}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">—</span>
        ),
    },
    {
      id: "sold30",
      accessorKey: "sold30",
      // Bán ròng: đã bỏ đơn huỷ và đơn hoàn (gồm đơn VTP báo giao thành công nhưng doanh thu COD ≤ 100K)
      header: "Bán ròng 30 ngày",
      meta: { align: "right" },
      cell: ({ row }) => <span className={cn("numeric font-semibold", row.original.sold30 === 0 && "text-muted-foreground")}>{formatNumber(row.original.sold30)}</span>,
    },
    {
      id: "deliveredOrders",
      accessorKey: "deliveredOrders",
      // SỐ ĐƠN (không phải số cái) giao thành công theo ORDER_OUTCOME — chứng từ ĐVVC trước, rồi tới
      // luật tiền COD thực thu. Dòng mã hàng: máy chủ gộp theo đơn, không cộng các dòng mẫu mã.
      header: "Đơn GTC",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className={cn("numeric font-medium", row.original.deliveredOrders === 0 && "text-muted-foreground")}>{formatNumber(row.original.deliveredOrders)}</span>
          {row.original.returnedOrders ? <div className="text-[10.5px] text-muted-foreground">hoàn {formatNumber(row.original.returnedOrders)}</div> : null}
        </div>
      ),
    },
    {
      id: "successRate",
      accessorKey: "successRate",
      // GTC ÷ (GTC + hoàn) trên đơn ĐÃ kết thúc. Chưa đơn nào kết thúc ⇒ "—", không phải 0%.
      // KHÔNG tô màu: chưa có đích do chủ shop đặt thì không kết luận tốt/xấu (AGENTS.md mục 38).
      header: "Tỷ lệ GTC",
      meta: { align: "right" },
      cell: ({ row }) => {
        const finished = row.original.deliveredOrders + row.original.returnedOrders;
        return (
          <div className="text-right">
            <span className={cn("numeric font-semibold", row.original.successRate === null && "text-muted-foreground")}>{formatPercent(row.original.successRate)}</span>
            {finished ? <div className="text-[10.5px] text-muted-foreground">trên {formatNumber(finished)} đơn</div> : null}
          </div>
        );
      },
    },
    {
      id: "stockValue",
      accessorKey: "stockValue",
      header: "Giá trị tồn",
      meta: { align: "right" },
      cell: ({ row }) => <Money value={row.original.stockValue} className="text-muted-foreground" />,
    },
    {
      id: "updatedAtExternal",
      accessorKey: "updatedAtExternal",
      header: "Cập nhật",
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.updatedAtExternal, true)}</span>,
    },
  ];
}

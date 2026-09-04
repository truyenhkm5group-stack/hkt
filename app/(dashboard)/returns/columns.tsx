"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { RowLink } from "@/components/data-table/data-table";
import { OrderStageBadge } from "@/components/status-badge";
import { Money } from "@/components/ui-bits";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ReturnListRow } from "@/lib/queries/returns";
import { cn } from "@/lib/utils";

type ReturnItem = { name: string; detail: string; quantity: number };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(...values: unknown[]) {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

function num(...values: unknown[]) {
  for (const v of values) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** Đọc danh sách sản phẩm hoàn từ JSON Pancake (returned_items) — chấp nhận nhiều dạng khác nhau */
export function parseReturnItems(items: unknown): ReturnItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = asRecord(raw);
    const info = asRecord(item.variation_info ?? item.variationInfo ?? item.variation ?? item.product);
    const fields = Array.isArray(info.fields) ? info.fields.map((f) => `${str(asRecord(f).name)}: ${str(asRecord(f).value)}`).filter((s) => s !== ": ") : [];
    return {
      name: str(item.product_name, item.productName, item.name, info.name, info.product_name, asRecord(info.product).name) || "Sản phẩm",
      detail: str(item.variation_detail, item.variationDetail, info.detail, fields.join(", "), str(info.sku, item.sku) ? `SKU ${str(info.sku, item.sku)}` : ""),
      quantity: num(item.returned_quantity, item.returnedQuantity, item.quantity, item.qty, item.return_quantity) || 1,
    };
  });
}

const STATUS_TONE: Record<number, string> = {
  0: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  1: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  2: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  3: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  4: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

function ReturnStatusBadge({ status, name }: { status: number; name: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5", STATUS_TONE[status] ?? "bg-muted text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {name || `Trạng thái ${status}`}
    </span>
  );
}

export const returnColumns: ColumnDef<ReturnListRow, unknown>[] = [
  {
    id: "displayId",
    accessorKey: "displayId",
    header: "Phiếu",
    cell: ({ row }) => (
      <div className="min-w-[72px]">
        <span className="font-semibold">#{row.original.displayId ?? row.original.id}</span>
        {row.original.updatedAtExternal ? <div className="text-[10.5px] text-muted-foreground">sửa {formatDate(row.original.updatedAtExternal)}</div> : null}
      </div>
    ),
    size: 96,
  },
  {
    id: "order",
    header: "Đơn gốc",
    enableSorting: false,
    cell: ({ row }) => {
      const o = row.original.order;
      if (!o) return <span className="text-xs text-muted-foreground">{row.original.orderId ? `#${row.original.orderId}` : "—"}</span>;
      return (
        <div className="min-w-[96px]">
          <RowLink href={`/orders/${o.id}`}>#{o.systemId ?? o.id}</RowLink>
          <div className="mt-0.5">
            <OrderStageBadge stage={o.stage} className="px-1.5 text-[10px]" />
          </div>
        </div>
      );
    },
  },
  {
    id: "customer",
    header: "Khách hàng",
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      const name = r.billFullName || r.order?.billFullName || "—";
      const phone = r.billPhone || r.order?.billPhone || "";
      return (
        <div className="min-w-[140px]">
          <div className="truncate font-medium">{name}</div>
          <div className="text-xs text-muted-foreground">
            {phone}
            {r.order?.shipProvince ? ` · ${r.order.shipProvince}` : ""}
          </div>
        </div>
      );
    },
  },
  {
    id: "type",
    header: "Loại",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.isExchange ? (
        <span className="inline-flex items-center rounded-md bg-violet-50 px-2 py-0.5 text-[11.5px] font-semibold text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">Đổi hàng</span>
      ) : (
        <span className="inline-flex items-center rounded-md bg-rose-50 px-2 py-0.5 text-[11.5px] font-semibold text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">Trả hàng</span>
      ),
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Trạng thái",
    cell: ({ row }) => <ReturnStatusBadge status={row.original.status} name={row.original.statusName} />,
  },
  {
    id: "items",
    header: "Sản phẩm hoàn",
    enableSorting: false,
    cell: ({ row }) => {
      const items = parseReturnItems(row.original.items);
      if (!items.length) return <span className="text-xs text-muted-foreground">—</span>;
      const text = items.map((i) => `${i.name}${i.detail ? ` (${i.detail})` : ""} ×${i.quantity}`).join(", ");
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-[280px] truncate text-xs text-muted-foreground">{text}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">{text}</TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    id: "returnedFee",
    accessorKey: "returnedFee",
    header: "Phí hoàn",
    meta: { align: "right" },
    cell: ({ row }) => <Money value={row.original.returnedFee} className={row.original.returnedFee ? "font-semibold text-rose-600" : "text-muted-foreground"} />,
  },
  {
    id: "discount",
    header: "Giảm giá",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => <Money value={row.original.discount} className="text-muted-foreground" />,
  },
  {
    id: "insertedAt",
    accessorKey: "insertedAt",
    header: "Ngày tạo",
    cell: ({ row }) => (
      <div className="text-xs text-muted-foreground">
        <div>{formatDateTime(row.original.insertedAt)}</div>
        {row.original.order?.returnedReason ? <div className="max-w-[180px] truncate">Lý do: {row.original.order.returnedReason}</div> : null}
      </div>
    ),
  },
];

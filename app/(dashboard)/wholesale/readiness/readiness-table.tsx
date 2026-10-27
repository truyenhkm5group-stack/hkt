"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { READINESS_SORTABLE, READINESS_STATUS_LABEL, type VariantReadiness } from "@/lib/wholesale/catalog-readiness";
import { cn } from "@/lib/utils";

const columns: ColumnDef<VariantReadiness, unknown>[] = [
  {
    id: "productName",
    header: "Mẫu mã",
    cell: ({ row: { original: r } }) => (
      <div className="min-w-0 max-w-[280px]">
        <div className="truncate font-medium" title={r.productName}>
          {r.productName}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {[r.sku, r.variantLabel].filter(Boolean).join(" · ") || "—"}
          {r.addOnOnly ? " · chỉ bán kèm" : ""}
        </div>
      </div>
    ),
  },
  {
    id: "missingCount",
    header: "Kết luận",
    cell: ({ row: { original: r } }) => (
      <div className="max-w-[360px] space-y-1">
        <span
          className={cn(
            "inline-flex rounded-md px-2 py-0.5 text-xs font-semibold",
            r.status === "READY" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
          )}
        >
          {READINESS_STATUS_LABEL[r.status]}
          {r.missing.length ? ` · thiếu ${r.missing.length}` : ""}
        </span>
        {r.missing.length ? (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {r.missing.map((m) => (
              <li key={m.key} title={m.detail}>
                <span className="font-medium text-foreground">{m.label}:</span> {m.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {r.warnings.map((w) => (
          <div key={w} className="text-xs text-amber-700 dark:text-amber-400">
            {w}
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "moq",
    header: "MOQ · giá sỉ",
    cell: ({ row: { original: r } }) =>
      r.moq === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <div className="whitespace-nowrap text-right tabular-nums">
          <div>từ {formatNumber(r.moq)}</div>
          <div className="text-xs text-muted-foreground">
            {formatVND(r.moqUnitPrice)} · {r.tierCount} bậc
          </div>
        </div>
      ),
  },
  {
    id: "facts",
    header: "Khối lượng · ảnh · mô tả",
    cell: ({ row: { original: r } }) => (
      <div className="max-w-[220px] space-y-0.5 text-xs">
        <div>{r.weightGrams === null ? <span className="text-muted-foreground">Khối lượng: chưa nhập</span> : `${formatNumber(r.weightGrams)} g`}</div>
        <div className={r.hasImage ? "" : "text-muted-foreground"}>{r.hasImage ? "Có ảnh" : "Chưa có ảnh"}</div>
        <div className={cn("truncate", r.descriptionFields.length ? "" : "text-muted-foreground")} title={r.descriptionFields.join(", ")}>
          {r.descriptionFields.length ? `Mô tả: ${r.descriptionFields.join(", ")}` : "Mô tả: trống"}
        </div>
      </div>
    ),
  },
  {
    id: "available",
    header: "Tồn khả dụng",
    cell: ({ row: { original: r } }) =>
      r.stockKnown ? (
        <div className="whitespace-nowrap text-right tabular-nums">
          <div className={cn(r.available !== null && r.available <= 0 && "font-semibold text-rose-700 dark:text-rose-400")}>{formatNumber(r.available)}</div>
          <div className="text-xs text-muted-foreground">thực tế {formatNumber(r.onHand)}</div>
        </div>
      ) : (
        <span className="whitespace-nowrap text-xs text-muted-foreground">Chưa có phiếu nhập — chưa biết</span>
      ),
  },
  {
    id: "export",
    header: "Hạn dùng (lô) · bảo quản",
    cell: ({ row: { original: r } }) => (
      <div className="space-y-0.5 whitespace-nowrap text-xs">
        <div className={r.lotCount ? "" : "text-muted-foreground"}>{r.lotCount ? `${r.lotCount} lô · tới ${formatDate(r.lotLatestExpiry)}` : "Chưa khai lô"}</div>
        <div className={r.storageFilled ? "" : "text-muted-foreground"}>{r.storageFilled === null ? "Bảo quản: chưa có field" : r.storageFilled ? "Bảo quản: có" : "Bảo quản: trống"}</div>
      </div>
    ),
  },
];

export function ReadinessTable({ rows, total, pageCount }: { rows: VariantReadiness[]; total: number; pageCount: number }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      total={total}
      pageCount={pageCount}
      getRowId={(r) => r.variantId}
      defaultSort="missingCount"
      defaultDir="desc"
      defaultPageSize={50}
      sortable={[...READINESS_SORTABLE]}
      emptyTitle="Không có mẫu mã nào khớp bộ lọc"
      emptyDescription="Bỏ bớt bộ lọc, hoặc kiểm danh mục ở trang Sản phẩm."
    />
  );
}

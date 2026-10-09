"use client";

import * as React from "react";
import { customerColumns } from "@/app/(dashboard)/customers/columns";
import { DataTable } from "@/components/data-table/data-table";
import { columnsWithListView, type ListMetadataProps } from "@/components/metadata/custom-columns";
import { CUSTOMER_LIST_REF_COLUMNS } from "@/lib/constants/metadata-list-columns";
import type { CustomerListRow } from "@/lib/queries/customers";
import { Money } from "@/components/ui-bits";
import { formatNumber, formatTimeAgo } from "@/lib/format";

/**
 * `meta` vắng mặt (hoặc danh sách chưa xuất bản) ⇒ đúng cột của mã nguồn như trước Phase 2. Có ⇒ áp
 * thứ tự / ẩn cột + cột custom (docs/platform/phase-2-contracts.md M9).
 */
export function CustomersTable({ rows, pageCount, total, meta, defaultSort = "lastOrderAt", defaultDir = "desc" }: { rows: CustomerListRow[]; pageCount: number; total: number; meta?: ListMetadataProps; defaultSort?: string; defaultDir?: "asc" | "desc" }) {
  const columns = React.useMemo(() => columnsWithListView(customerColumns, meta, CUSTOMER_LIST_REF_COLUMNS, (row) => row.id), [meta]);
  return (
    <DataTable
      defaultSort={defaultSort}
      defaultDir={defaultDir}
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/customers/${row.id}`}
      getRowId={(row) => row.id}
      mobileCard={(row) => <CustomerMobileCard row={row} />}
      emptyTitle="Không có khách hàng"
      emptyDescription="Thử đổi bộ lọc hoặc từ khoá. Khách hàng được tạo tự động khi đồng bộ đơn, hoặc bấm “Đồng bộ khách hàng”."
    />
  );
}

/** Một khách trên điện thoại: ai · liên lạc · đã mua bao nhiêu · kết quả giao — cùng số của bảng máy tính, không tính lại. */
function CustomerMobileCard({ row }: { row: CustomerListRow }) {
  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">
            {row.name || "—"}
            {row.isBlock ? <span className="ml-1.5 rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-950 dark:text-rose-300">Đã chặn</span> : null}
          </p>
          <p className="truncate text-[13px] text-muted-foreground">
            {row.phone ?? "Chưa có SĐT"}
            {row.province ? ` · ${row.province}` : ""}
          </p>
        </div>
        <Money value={row.purchasedAmount} className="shrink-0 text-[15px] font-bold" />
      </div>
      <p className="text-[13px] text-muted-foreground">
        {formatNumber(row.orderCount)} đơn · {formatNumber(row.succeedOrderCount)} giao thành công · {formatNumber(row.returnedOrderCount)} hoàn
        {row.lastOrderAt ? ` · mua ${formatTimeAgo(row.lastOrderAt)}` : ""}
      </p>
    </div>
  );
}

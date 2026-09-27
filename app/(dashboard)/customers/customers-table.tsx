"use client";

import * as React from "react";
import { customerColumns } from "@/app/(dashboard)/customers/columns";
import { DataTable } from "@/components/data-table/data-table";
import { columnsWithListView, type ListMetadataProps } from "@/components/metadata/custom-columns";
import { CUSTOMER_LIST_REF_COLUMNS } from "@/lib/constants/metadata-list-columns";
import type { CustomerListRow } from "@/lib/queries/customers";

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
      emptyTitle="Không có khách hàng"
      emptyDescription="Thử đổi bộ lọc hoặc từ khoá. Khách hàng được tạo tự động khi đồng bộ đơn, hoặc bấm “Đồng bộ khách hàng”."
    />
  );
}

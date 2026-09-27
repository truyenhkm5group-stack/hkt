"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { orderColumns } from "@/app/(dashboard)/orders/columns";
import { DataTable } from "@/components/data-table/data-table";
import { columnsWithListView, type ListMetadataProps } from "@/components/metadata/custom-columns";
import { OrderStageBadge } from "@/components/status-badge";
import { ORDER_LIST_REF_COLUMNS } from "@/lib/constants/metadata-list-columns";
import { formatTimeAgo } from "@/lib/format";
import type { OrderListRow } from "@/lib/queries/orders";

/**
 * `meta` / `stageLabels` vắng mặt ⇒ y hệt trước Phase 2. `stageLabels`: nhãn tổ chức đặt cho trạng
 * thái HỆ THỐNG `orders.stage` (M10) — CHỈ đổi chữ hiển thị; giá trị, màu và mọi luật (ORDER_OUTCOME,
 * logistics, COD) giữ nguyên. Map CHỈ chứa giá trị tổ chức ĐÃ khai override (trang lọc bỏ giá trị
 * mang nhãn mặc định của sổ): khai rồi thì nhãn tổ chức thắng nhãn Pancake gửi về — lựa chọn tường
 * minh cho đúng giá trị ấy; chưa khai thì hiển thị y như cũ (nhãn Pancake, rồi nhãn mặc định).
 */
export function OrdersTable({ rows, pageCount, total, meta, stageLabels }: { rows: OrderListRow[]; pageCount: number; total: number; meta?: ListMetadataProps; stageLabels?: Record<string, string> }) {
  const columns = React.useMemo(() => {
    const base: ColumnDef<OrderListRow, unknown>[] =
      stageLabels && Object.keys(stageLabels).length
        ? orderColumns.map((c) =>
            c.id !== "status"
              ? c
              : {
                  ...c,
                  cell: ({ row }) => (
                    <div className="space-y-1">
                      <OrderStageBadge stage={row.original.stage} label={stageLabels[row.original.stage] ?? (row.original.statusName || undefined)} />
                      {row.original.lastUpdateStatusAt ? <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(row.original.lastUpdateStatusAt)}</div> : null}
                    </div>
                  ),
                },
          )
        : orderColumns;
    return columnsWithListView(base, meta, ORDER_LIST_REF_COLUMNS, (row) => row.id);
  }, [meta, stageLabels]);
  return (
    <DataTable
      defaultSort="insertedAt"
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/orders/${row.id}`}
      getRowId={(row) => row.id}
      emptyTitle="Không có đơn hàng"
      emptyDescription="Thử đổi khoảng thời gian hoặc bộ lọc. Nếu chưa đồng bộ, bấm “Đồng bộ đơn”."
    />
  );
}

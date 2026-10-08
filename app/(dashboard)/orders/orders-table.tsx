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
import type { CarrierKey } from "@/lib/carriers/types";
import { CarrierBulkActions } from "@/app/(dashboard)/orders/carrier-bulk-actions";
import { OrderQuickDecision, OrderReviewEntries } from "@/components/orders/order-review-quick";
import { isManualOrderId } from "@/lib/constants/manual-orders";

/**
 * `meta` / `stageLabels` vắng mặt ⇒ y hệt trước Phase 2. `stageLabels`: nhãn tổ chức đặt cho trạng
 * thái HỆ THỐNG `orders.stage` (M10) — CHỈ đổi chữ hiển thị; giá trị, màu và mọi luật (ORDER_OUTCOME,
 * logistics, COD) giữ nguyên. Map CHỈ chứa giá trị tổ chức ĐÃ khai override (trang lọc bỏ giá trị
 * mang nhãn mặc định của sổ): khai rồi thì nhãn tổ chức thắng nhãn Pancake gửi về — lựa chọn tường
 * minh cho đúng giá trị ấy; chưa khai thì hiển thị y như cũ (nhãn Pancake, rồi nhãn mặc định).
 */
export function OrdersTable({ rows, pageCount, total, meta, stageLabels, carrierBulk = [], canDecide = false }: { rows: OrderListRow[]; pageCount: number; total: number; meta?: ListMetadataProps; stageLabels?: Record<string, string>; carrierBulk?: { key: CarrierKey; label: string }[]; canDecide?: boolean }) {
  const columns = React.useMemo(() => {
    const relabel = Boolean(stageLabels && Object.keys(stageLabels).length);
    /*
      CỘT TRẠNG THÁI mang thêm cờ CẦN NGƯỜI KIỂM (chủ shop 08/10/2026) và — với người có quyền sửa đơn tay — nút nhanh «Xác nhận
      đơn» / «Huỷ đơn» cho đơn tay đang cần kiểm hoặc còn «Mới» / «Chờ hàng». Nút đi qua đúng server action của đơn tay.
    */
    const base: ColumnDef<OrderListRow, unknown>[] = orderColumns.map((c) =>
      c.id !== "status"
        ? c
        : {
            ...c,
            cell: ({ row }) => (
              <div className="space-y-1">
                <OrderStageBadge stage={row.original.stage} label={(relabel ? stageLabels?.[row.original.stage] : undefined) ?? (row.original.statusName || undefined)} />
                {row.original.lastUpdateStatusAt ? <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(row.original.lastUpdateStatusAt)}</div> : null}
                <OrderReviewEntries entries={row.original.review} compact />
                {canDecide && isManualOrderId(row.original.id) ? <OrderQuickDecision orderId={row.original.id} stage={row.original.stage} entries={row.original.review} gaps={row.original.gaps} size="xs" /> : null}
              </div>
            ),
          },
    );
    return columnsWithListView(base, meta, ORDER_LIST_REF_COLUMNS, (row) => row.id);
  }, [meta, stageLabels, canDecide]);
  return (
    <DataTable
      defaultSort="insertedAt"
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/orders/${row.id}`}
      getRowId={(row) => row.id}
      selectable={carrierBulk.length > 0}
      bulkActions={carrierBulk.length ? (selected, clear) => <CarrierBulkActions carriers={carrierBulk} orderIds={selected.map((r) => r.id)} clear={clear} /> : undefined}
      emptyTitle="Không có đơn hàng"
      emptyDescription="Thử đổi khoảng thời gian hoặc bộ lọc. Nếu chưa đồng bộ, bấm “Đồng bộ đơn”."
    />
  );
}

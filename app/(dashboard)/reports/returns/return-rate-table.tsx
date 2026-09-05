"use client";

import { returnRateColumns } from "@/app/(dashboard)/reports/returns/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { ReturnRateRow } from "@/lib/queries/return-rate";

export function ReturnRateTable({ rows, pageCount, total, baseQuery }: { rows: ReturnRateRow[]; pageCount: number; total: number; baseQuery: string }) {
  return (
    <DataTable
      columns={returnRateColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.key}
      rowHref={(row) => `/reports/returns?${baseQuery}${baseQuery ? "&" : ""}variant=${encodeURIComponent(row.key)}#chi-tiet`}
      group={{
        key: (row) => row.productName || row.sku.split(" ")[0] || row.key,
        parent: (rows, key) => {
          const sum = (f: (r: ReturnRateRow) => number) => rows.reduce((t, r) => t + f(r), 0);
          const delivered = sum((r) => r.delivered);
          const returned = sum((r) => r.returned);
          const failed = sum((r) => r.failed);
          const finished = delivered + returned;
          // xác suất chờ phát lại thành hoàn: suy ngược từ dự kiến của các mẫu mã (bình quân có trọng số), không có thì 0
          const pFailNum = rows.reduce((t, r) => (r.expectedRate !== null && r.failed ? t + ((r.expectedRate / 100) * (r.delivered + r.returned + r.failed) - r.returned) : t), 0);
          const pFail = failed ? Math.min(1, Math.max(0, pFailNum / failed)) : 0;
          return {
            ...rows[0],
            key: `group:${key}`,
            variantId: null,
            sku: key,
            productName: key,
            variationDetail: `${rows.length} mẫu mã`,
            shipped: sum((r) => r.shipped),
            delivered,
            returned,
            returnedByRule: sum((r) => r.returnedByRule),
            inTransit: sum((r) => r.inTransit),
            failed,
            cancelled: sum((r) => r.cancelled),
            returnedQty: sum((r) => r.returnedQty),
            lostRevenue: sum((r) => r.lostRevenue),
            deliveredRevenue: sum((r) => r.deliveredRevenue),
            rate: finished ? (returned / finished) * 100 : null,
            expectedRate: finished + failed ? ((returned + failed * pFail) / (finished + failed)) * 100 : null,
          };
        },
      }}
      emptyTitle="Không có mã hàng nào"
      emptyDescription="Thử đổi khoảng thời gian, bỏ bộ lọc tối thiểu, hoặc đồng bộ đơn hàng từ Pancake."
    />
  );
}

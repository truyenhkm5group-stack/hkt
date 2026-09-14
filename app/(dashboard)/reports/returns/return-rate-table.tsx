"use client";

import { makeReturnRateColumns, type StateProb } from "@/app/(dashboard)/reports/returns/columns";
import { DataTable } from "@/components/data-table/data-table";
import { projectedRateOf } from "@/lib/constants/projected-delivery";
import { RETURN_RATE_SORTABLE } from "@/lib/constants/returns";
import type { ReturnRateRow } from "@/lib/queries/return-rate";

export function ReturnRateTable({
  rows,
  pageCount,
  total,
  baseQuery,
  probabilities,
}: {
  rows: ReturnRateRow[];
  pageCount: number;
  total: number;
  baseQuery: string;
  /** Bảng xác suất từng trạng thái, để ô "GTC ước tính" in ra được phép tính của chính nó. */
  probabilities: StateProb[];
}) {
  return (
    <DataTable
      columns={makeReturnRateColumns(probabilities)}
      data={rows}
      pageCount={pageCount}
      total={total}
      defaultSort="successRate"
      defaultDir="asc"
      sortable={RETURN_RATE_SORTABLE}
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
          /*
            ═══ DÒNG GỘP CỘNG TỬ SỐ VÀ MẪU SỐ, KHÔNG SUY NGƯỢC MỘT THAM SỐ ═══

            Bản cũ ở đây lấy `expectedRate` của từng mẫu mã rồi GIẢI NGƯỢC ra `pFail` — tham số đầu
            vào của chính công thức đã sinh ra nó — bằng một phép chia có `Math.min(1, Math.max(0,
            …))` bọc ngoài để chặn kết quả vô nghĩa. Cái kẹp đó là bằng chứng: một đại lượng suy
            ngược đúng thì không cần kẹp. Mẫu mã có `expectedRate = null` bị bỏ khỏi tử số nhưng
            `failed` của nó VẪN nằm ở mẫu số, nên dòng gộp lạc quan hơn tổng các dòng con.

            Nay mỗi mẫu mã mang sẵn tử số và mẫu số THÔ của cùng một hợp đồng, nên dòng gộp chỉ
            việc cộng rồi đưa qua ĐÚNG hàm `projectedRateOf` — cùng luật loại đơn ngoài ước tính khỏi
            mẫu số và cùng ngưỡng "ngoài ước tính quá lớn ⇒ chưa đo được" như mọi nơi khác.
          */
          const projectedSent = sum((r) => r.projectedSent);
          const projectedDelivered = sum((r) => r.projectedDelivered);
          const projectedActive = sum((r) => r.projectedActive);
          const unmodelledActive = sum((r) => r.unmodelledActive);
          const projectedRate = projectedRateOf({ projectedDelivered, eligibleSent: projectedSent, active: projectedActive, unmodelledActive });
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
            expectedRate: projectedRate === null ? null : Math.round((100 - projectedRate) * 10) / 10,
            successRate: finished ? (delivered / finished) * 100 : null,
            expectedSuccessRate: projectedRate,
            projectedSent,
            projectedDelivered,
            projectedActive,
            unmodelledActive,
            // Cộng số đơn đang chạy của MỌI mẫu mã con theo từng trạng thái, để tooltip của dòng
            // gộp nói đúng thứ nó đang gộp thay vì mượn breakdown của mẫu mã đầu tiên.
            activeByState: rows.reduce<Record<string, number>>((acc, r) => {
              for (const [k, n] of Object.entries(r.activeByState)) acc[k] = (acc[k] ?? 0) + (n ?? 0);
              return acc;
            }, {}),
          };
        },
      }}
      emptyTitle="Không có mã hàng nào"
      emptyDescription="Thử đổi khoảng thời gian, bỏ bộ lọc tối thiểu, hoặc đồng bộ đơn hàng từ Pancake."
    />
  );
}

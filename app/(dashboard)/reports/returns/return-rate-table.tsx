"use client";

import { makeReturnRateColumns, type StateProb } from "@/app/(dashboard)/reports/returns/columns";
import { DataTable } from "@/components/data-table/data-table";
import { RETURN_RATE_SORTABLE } from "@/lib/constants/returns";
import type { ProductRateRow, ReturnRateRow } from "@/lib/queries/return-rate";

export function ReturnRateTable({
  rows,
  productRows,
  pageCount,
  total,
  baseQuery,
  probabilities,
}: {
  rows: ReturnRateRow[];
  /** Dòng gộp theo mã hàng, ĐÃ đếm theo đơn ở máy chủ — trình duyệt không cộng lại. */
  productRows: ProductRateRow[];
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
        /*
          GỘP THEO KHOÁ MÃ HÀNG, KHÔNG THEO CHUỖI TÊN. Hai mẫu mã ghi tên sản phẩm lệch một dấu cách
          từng rơi vào hai nhóm khác nhau; `productKey` là `product_id` thật nên không có chuyện đó.
          Mẫu mã chưa lần được về mã hàng giữ khoá riêng của nó — không gom vào một nhóm "khác".
        */
        key: (row) => row.productKey || `sku:${row.key}`,
        /*
          ═══ DÒNG GỘP ĐỌC SỐ MÁY CHỦ ĐÃ ĐẾM, KHÔNG TỰ CỘNG ═══

          Bản trước cộng các dòng mẫu mã ngay tại đây. Mỗi dòng mẫu mã đã `count(distinct order_id)`
          trong phạm vi mẫu mã của nó, nên một đơn mua HAI mẫu mã của CÙNG một mã bị cộng HAI lần —
          đo production 21/09/2026: Q003 in ra 405 đơn trong khi thật sự có 365 (+11,0%), Q005
          202/175 (+15,4%), Q002 744/699.

          Không có phép cộng nào ở đây nữa, nên không có phép cộng nào để sai. Máy chủ gộp trên CÙNG
          bảng dẫn xuất, chỉ đổi khoá — xem `rawMa` ở lib/queries/return-rate.ts.

          Mã hàng không có dòng gộp từ máy chủ (mẫu mã vô chủ) ⇒ trả `null`: DataTable hiện các dòng
          con như thường, KHÔNG dựng một dòng cha bịa ra.
        */
        parent: (rows, key) => {
          const p = productRows.find((x) => x.productKey === key);
          if (!p) return null;
          return {
            ...rows[0],
            key: `group:${key}`,
            productKey: p.productKey,
            variantId: null,
            sku: p.productName,
            productName: p.productName,
            variationDetail: `${p.variants} mẫu mã`,
            image: p.image,
            shipped: p.shipped,
            delivered: p.delivered,
            returned: p.returned,
            returnedByRule: p.returnedByRule,
            inTransit: p.inTransit,
            failed: p.failed,
            cancelled: p.cancelled,
            returnedQty: p.returnedQty,
            lostRevenue: p.lostRevenue,
            deliveredRevenue: p.deliveredRevenue,
            rate: p.rate,
            successRate: p.successRate,
            expectedSuccessRate: p.expectedSuccessRate,
            expectedRate: p.expectedRate,
            projectedSent: p.projectedSent,
            projectedDelivered: p.projectedDelivered,
            projectedActive: p.projectedActive,
            unmodelledActive: p.unmodelledActive,
            activeByState: p.activeByState,
          };
        },
      }}
      emptyTitle="Không có mã hàng nào"
      emptyDescription="Thử đổi khoảng thời gian, bỏ bộ lọc tối thiểu, hoặc đồng bộ đơn hàng từ Pancake."
    />
  );
}

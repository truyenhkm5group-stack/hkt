"use client";

import { useMemo } from "react";
import { codColumns } from "@/app/(dashboard)/cod/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { CodListRow } from "@/lib/queries/cod";

/**
 * Bảng vận đơn của trang Đối soát COD — CHỈ ĐỌC.
 *
 * Tiền COD chỉ đến từ bảng kê đối soát Viettel Post gửi qua email; không còn nút đánh dấu tay
 * "đã đối soát / đã về ngân hàng / có chênh lệch". Đánh dấu tay tạo ra con số không có chứng từ
 * và từng ghi đè lên số thật của bảng kê, nên bỏ hẳn thay vì để song song hai nguồn sự thật.
 */
export function CodTable({ rows, pageCount, total }: { rows: CodListRow[]; pageCount: number; total: number }) {
  const columns = useMemo(() => codColumns(), []);
  return (
    <DataTable
      defaultSort="deliveredAt"
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/shipments/${row.id}`}
      getRowId={(row) => row.id}
      emptyTitle="Không có vận đơn"
      emptyDescription="Thử đổi tab trạng thái, khoảng thời gian hoặc bộ lọc."
    />
  );
}

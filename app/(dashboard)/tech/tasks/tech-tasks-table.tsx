"use client";

import { techTaskColumns } from "@/app/(dashboard)/tech/tasks/columns";
import { BulkApprove } from "@/app/(dashboard)/tech/tasks/bulk-approve";
import { DataTable } from "@/components/data-table/data-table";
import { TECH_TASK_SORTABLE } from "@/lib/constants/tech";
import type { TechTaskListRow } from "@/lib/queries/tech";

export function TechTasksTable({ rows, pageCount, total }: { rows: TechTaskListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={techTaskColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      rowHref={(row) => `/tech/tasks/${row.id}`}
      /*
        TÍCH CHỌN ĐỂ KÝ TỪ NGAY DANH SÁCH.

        Trước đây ký một việc phải mở trang việc đó. Chín việc sinh ra từ MỘT bản kế hoạch đã được
        đọc và duyệt cả bản thì đòi chín lượt điều hướng nữa không làm quyết định kỹ hơn — nó làm
        người ta bấm cho nhanh. Bộ điều kiện không đổi một chút nào (xem `tech-approval-bulk.ts`).
      */
      selectable
      bulkActions={(selected, clear) => <BulkApprove rows={selected} clear={clear} />}
      defaultSort="createdAt"
      sortable={TECH_TASK_SORTABLE}
      dense
      emptyTitle="Không có việc Tech nào khớp bộ lọc"
      emptyDescription="Thử mở rộng khoảng thời gian hoặc bỏ bộ lọc. Hàng đợi trống là trạng thái hợp lệ — nó không có nghĩa là hệ thống đã được kiểm tra."
    />
  );
}

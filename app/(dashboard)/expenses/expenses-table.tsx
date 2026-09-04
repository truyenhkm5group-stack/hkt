"use client";

import { useMemo } from "react";
import { buildAdSpendColumns, buildExpenseColumns } from "@/app/(dashboard)/expenses/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { AdSpendRow, ExpenseRow } from "@/lib/queries/expenses";

export function ExpensesTable({ rows, pageCount, total, canWrite }: { rows: ExpenseRow[]; pageCount: number; total: number; canWrite: boolean }) {
  const columns = useMemo(() => buildExpenseColumns({ canWrite }), [canWrite]);
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      emptyTitle="Chưa có chi phí trong kỳ"
      emptyDescription={canWrite ? "Bấm “Thêm chi phí” để ghi nhận lương, mặt bằng, phần mềm, đóng gói… hoặc đổi khoảng thời gian." : "Thử đổi khoảng thời gian hoặc bộ lọc."}
    />
  );
}

export function AdSpendsTable({ rows, pageCount, total, canWrite }: { rows: AdSpendRow[]; pageCount: number; total: number; canWrite: boolean }) {
  const columns = useMemo(() => buildAdSpendColumns({ canWrite }), [canWrite]);
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      emptyTitle="Chưa có chi tiêu quảng cáo trong kỳ"
      emptyDescription={canWrite ? "Bấm “Thêm chi tiêu QC” để nhập chi tiêu theo ngày và nền tảng, hoặc đổi khoảng thời gian." : "Thử đổi khoảng thời gian hoặc bộ lọc."}
    />
  );
}

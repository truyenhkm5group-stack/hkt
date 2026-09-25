"use client";

import { useMemo } from "react";
import { modelColumns, signalColumn, type ModelSignalCell } from "@/app/(dashboard)/models/columns";
import { DataTable } from "@/components/data-table/data-table";
import type { ModelListRow } from "@/lib/queries/models";

export function ModelsTable({
  rows,
  pageCount,
  total,
  emptyDescription,
  signals,
}: {
  rows: ModelListRow[];
  pageCount: number;
  total: number;
  emptyDescription: string;
  /** Có ⇒ thêm cột "Tín hiệu" sau "Trạng thái khai" (Agent S, bật bằng `?tinhieu=1`). */
  signals?: { byModel: Record<string, ModelSignalCell | null>; periodLabel: string };
}) {
  const columns = useMemo(() => {
    if (!signals) return modelColumns;
    const i = modelColumns.findIndex((c) => c.id === "state");
    return [...modelColumns.slice(0, i + 1), signalColumn(signals.byModel, signals.periodLabel), ...modelColumns.slice(i + 1)];
  }, [signals]);
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      defaultSort="code"
      defaultDir="asc"
      rowHref={(row) => `/models/${row.id}`}
      getRowId={(row) => row.id}
      sortable={["state"]}
      emptyTitle="Không có mẫu nào"
      emptyDescription={emptyDescription}
    />
  );
}

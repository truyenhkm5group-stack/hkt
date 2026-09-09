"use client";

import { useQueryStates } from "nuqs";
import { tableParsers } from "@/components/data-table/data-table";
import { DataTablePagination } from "@/components/data-table/pagination";
import { useNavTransition } from "@/components/nav-progress";

/** Phân trang đọc/ghi page & pageSize trên URL (dùng cho bảng tự dựng, không qua DataTable) */
export function UrlPagination({ pageCount, total }: { pageCount: number; total: number }) {
  const [, startTransition] = useNavTransition();
  const [params, setParams] = useQueryStates(tableParsers, { shallow: false, history: "push", startTransition });
  return <DataTablePagination page={params.page} pageSize={params.pageSize} pageCount={pageCount} total={total} onPageChange={(page) => void setParams({ page })} onPageSizeChange={(pageSize) => void setParams({ pageSize, page: 1 })} />;
}

"use client";

import type React from "react";
import { ColumnResize } from "@/components/data-table/column-resize";
import { ColumnVisibility } from "@/components/data-table/column-visibility";

/**
 * Thanh công cụ của MỘT bảng: nút trả bề rộng về tự động (chỉ hiện khi đã có cột bị kéo) và nút
 * ẩn/hiện cột. Hai việc khác nhau nhưng cùng trả lời một câu — *tôi muốn bảng này trông thế nào* —
 * nên đứng cạnh nhau, ở một chỗ duy nhất người dùng phải nhớ.
 *
 * `ColumnResize` còn dựng tay kéo NGAY TRONG từng ô tiêu đề (qua portal), nên nó phải được gắn kể
 * cả khi bảng ít cột tới mức nút "Cột" tự ẩn đi.
 */
export function TableTools({ tableRef }: { tableRef: React.RefObject<HTMLTableElement | null> }) {
  return (
    <div className="flex items-center justify-end gap-0.5 px-2 pt-1 print:hidden">
      <ColumnResize tableRef={tableRef} />
      <ColumnVisibility tableRef={tableRef} />
    </div>
  );
}

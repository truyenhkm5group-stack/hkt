"use client";

import { useEffect, useRef, useState } from "react";
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

/**
 * ═══════════ CÙNG THANH CÔNG CỤ ẤY, CHO BẢNG KHÔNG DÙNG `<Table>` ═══════════
 *
 * ERP có **44 bảng viết bằng `<table>` thô** (lương, vận đơn, lý do hoàn, fanpage, nhập tệp ĐVVC…).
 * Chúng không đi qua `components/ui/table.tsx` nên không có nút "Cột" và không có tay kéo — người
 * dùng gặp đúng một tính năng ở chỗ này mà không gặp ở chỗ kia, và không có cách nào đoán được
 * chỗ nào có.
 *
 * ─── VÌ SAO NHẬN `tableId` CHỨ KHÔNG NHẬN `ref` ───
 *
 * Phần lớn số bảng đó nằm trong **Server Component** (`app/(dashboard)/reports/returns/page.tsx`,
 * `payroll/...`). Ở đó không gọi được `useRef`, nên đường "tạo ref rồi truyền xuống" chỉ dùng được
 * sau khi đã đổi cả trang thành client — tức là một lượt viết lại lớn cho một việc nhỏ.
 *
 * `id` thì Server Component đặt được, và nó **tường minh**: mỗi bảng tự khai nó là bảng nào. Cố ý
 * KHÔNG làm một bộ quét toàn trang tự tìm mọi `<table>` — quét như vậy sẽ vớ cả bảng lồng trong ô,
 * bảng trong hộp thoại và bảng của trang in, rồi gắn nút vào những chỗ không ai muốn.
 *
 * Dùng:
 *
 *     <TableToolsFor tableId="ly-do-hoan" />
 *     <div className={TABLE_SCROLL}>
 *       <table id="ly-do-hoan" className="w-full min-w-[1200px] text-sm">
 *
 * Bảng chưa tồn tại lúc gắn (dữ liệu về sau, tab chưa mở) thì thanh công cụ KHÔNG hiện — không
 * dựng một cái nút trỏ vào hư vô. Tìm lại mỗi khi DOM đổi.
 */
export function TableToolsFor({ tableId }: { tableId: string }) {
  const [table, setTable] = useState<HTMLTableElement | null>(null);
  const ref = useRef<HTMLTableElement | null>(null);
  ref.current = table;

  useEffect(() => {
    const tim = () => {
      const el = document.getElementById(tableId);
      setTable((cu) => (cu === el ? cu : el instanceof HTMLTableElement ? el : null));
    };
    tim();
    const obs = new MutationObserver(tim);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [tableId]);

  if (!table) return null;
  return <TableTools tableRef={ref} />;
}

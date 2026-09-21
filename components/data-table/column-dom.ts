/**
 * ═══════════ ĐỌC CỘT TỪ DOM CỦA MỘT BẢNG — MỘT BẢN, HAI NƠI DÙNG ═══════════
 *
 * Nút "Cột" (ẩn/hiện) và tay kéo bề rộng đều phải trả lời đúng một câu hỏi: *bảng này có mấy cột,
 * và ô nào thuộc cột nào?* Câu hỏi ấy KHÔNG tầm thường vì `colSpan`: một ô trải hai cột thì chỉ số
 * cột không còn bằng chỉ số ô. Hai bản sao của phép đếm ấy sẽ lệch nhau vào đúng ngày ai đó thêm
 * một tiêu đề gộp — và lệch theo kiểu im lặng, vì cả hai vẫn chạy.
 *
 * Nên phép đếm nằm ở ĐÂY, và cả hai lớp gọi nó.
 */

export type ColumnHeader = { index: number; el: HTMLTableCellElement; label: string };

/** Nhãn để người đọc nhận ra cột. Ô chọn dòng không có chữ nên được gọi tên riêng. */
export function headerLabel(th: HTMLTableCellElement, index: number): string {
  if (th.querySelector('input[type="checkbox"], [role="checkbox"]')) return "Chọn";
  const text = (th.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || `Cột ${index + 1}`;
}

/**
 * Các cột của bảng, theo DÒNG TIÊU ĐỀ ĐẦU TIÊN.
 *
 * `index` là chỉ số CỘT (đã cộng dồn `colSpan`), không phải chỉ số ô. `data-orig-colspan` được
 * lớp ẩn/hiện cột ghi lại trước khi nó sửa `colSpan`, nên phải đọc bản gốc — nếu không, ẩn một cột
 * sẽ làm mọi cột sau nó bị đánh số lệch.
 */
export function columnHeaders(table: HTMLTableElement): ColumnHeader[] {
  const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th, thead tr:first-child td"));
  const out: ColumnHeader[] = [];
  let col = 0;
  for (const th of ths) {
    const span = th.dataset.origColspan ? Number(th.dataset.origColspan) : th.colSpan;
    out.push({ index: col, el: th, label: headerLabel(th, col) });
    col += span;
  }
  return out;
}

/** Tổng số cột của bảng — cộng dồn `colSpan` của dòng tiêu đề đầu tiên. */
export function columnCount(table: HTMLTableElement): number {
  const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th, thead tr:first-child td"));
  return ths.reduce((t, th) => t + (th.dataset.origColspan ? Number(th.dataset.origColspan) : th.colSpan), 0);
}

/**
 * Duyệt MỌI ô của bảng kèm chỉ số cột của nó.
 *
 * Ô trải nhiều cột được gọi lại MỘT LẦN với chỉ số cột ĐẦU TIÊN nó chiếm, kèm `span`: nơi gọi tự
 * quyết định nó thuộc về cột nào. Đây là chỗ duy nhất biết luật cộng dồn `colSpan`.
 */
export function forEachCellByColumn(
  table: HTMLTableElement,
  fn: (cell: HTMLTableCellElement, colIndex: number, span: number) => void,
) {
  for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"))) {
    let col = 0;
    for (const cell of Array.from(row.cells)) {
      const span = cell.dataset.origColspan ? Number(cell.dataset.origColspan) : cell.colSpan;
      fn(cell, col, span);
      col += span;
    }
  }
}

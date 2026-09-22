"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ruler } from "lucide-react";
import {
  MIN_COLUMN_WIDTH,
  RESIZE_HANDLE_WIDTH,
  clampColumnWidth,
  clipFadeEdge,
  clipFadeMask,
  parseStoredWidths,
  resizedWidths,
  tableConfigKey,
} from "@/lib/table/column-resize";
import { columnCount, columnHeaders, forEachCellByColumn } from "@/components/data-table/column-dom";
import { cn } from "@/lib/utils";

/**
 * ═══════════ KÉO ĐỂ ĐỔI BỀ RỘNG MỘT CỘT BẤT KỲ ═══════════
 *
 * Gắn vào MỌI bảng đi qua `components/ui/table.tsx`, cùng chỗ với nút "Cột" — cùng một cách làm
 * (thao tác trên DOM của bảng đã dựng sẵn), nên bảng do máy chủ kết xuất cũng dùng được mà không
 * trang nào phải khai thêm gì.
 *
 * ─── NĂM QUYẾT ĐỊNH, VÀ LÝ DO CỦA TỪNG CÁI ───
 *
 *  1. CÓ BỀ RỘNG NGƯỜI ĐẶT ⇒ BẢNG CHUYỂN SANG `table-layout: fixed`.
 *     Đó là cách duy nhất để bề rộng khai THẮNG nội dung, tức để cột hẹp được xuống dưới bề rộng
 *     tối thiểu của chữ trong nó. Chưa ai kéo thì không đụng gì: bảng vẫn y như trước.
 *
 *  2. LỚP NÀY CHỈ GHI `style`, KHÔNG BAO GIỜ DI CHUYỂN MỘT NÚT DOM NÀO.
 *     Cách "gọn" hơn là bọc nội dung ô vào một `<div>` có bề rộng px — `min-content` của nó bằng
 *     đúng bề rộng khai, nên `table-layout` giữ nguyên `auto` và chỉ cột đã kéo bị cắt. Nhưng
 *     những ô ấy do React dựng: chuyển chúng sang một cha khác thì lượt kết xuất sau React gọi
 *     `td.removeChild(node)` với `node` đã nằm trong lớp bọc ⇒ `NotFoundError` ⇒ sập cả trang.
 *     Không phải giả thuyết: 11 bảng của ERP nằm trong client component và ô của chúng có nhánh
 *     điều kiện (`{x ? <Money/> : "—"}`), tức React CÓ thay con của ô khi sang trang.
 *
 *  3. CHỈ CỘT ĐÃ KÉO MỚI CÓ BỀ RỘNG LƯU. Mọi cột khác được ĐO LẠI mỗi lần dữ liệu đổi, từ chính
 *     bảng ở trạng thái không có bề rộng khai nào — nên chúng bám nội dung y như khi tính năng này
 *     chưa tồn tại, không cắt và cũng không đóng băng ở con số của trang trước. Đây là phần trả
 *     giá cho quyết định 1: `table-layout` là thuộc tính của cả bảng, nên quyền "nở theo nội dung"
 *     phải được trả lại bằng phép đo.
 *
 *  4. MÉP BỊ CẮT PHẢI NHÌN RA ĐƯỢC LÀ ĐÃ CẮT. `1.307.910.998 ₫` cắt còn `1.307.9` vẫn là một con
 *     số đọc được — và là một con số KHÁC. Ô của cột đã kéo mang mặt nạ chuyển sắc ở đúng MÉP
 *     TRÀN (`clipFadeEdge`, suy từ CHIỀU VIẾT — `text-align` không quyết định điều này, đã đo):
 *     nội dung vừa chỗ thì mặt nạ rơi vào khoảng trống nên không ai thấy gì; nội dung tràn thì
 *     phần cuối nhoè hẳn.
 *
 *  5. LỐI RA NẰM NGAY CHỖ VỪA KÉO: bấm đúp lên tay kéo trả ĐÚNG cột đó về tự động. Nút "Bề rộng"
 *     trả cả bảng về.
 *
 * Bề rộng lưu theo trang + bảng + chữ ký nhãn cột trong trình duyệt của chính người dùng, cùng
 * cách với nút "Cột".
 */

const PREFIX = "erp.colw2";

/**
 * Bề rộng ĐANG HIỂN THỊ của từng cột.
 *
 * ═══ HÀNG ĐO PHẢI CÓ ĐÚNG MỘT Ô CHO MỖI CỘT ═══
 *
 * Bản đầu luôn đo ở dòng tiêu đề đầu tiên và chia đều bề rộng của ô gộp `colSpan`. Chia đều là
 * ĐOÁN, và với bố cục tự động cái đoán ấy vô hại (bề rộng khai chỉ là sàn, nội dung vẫn thắng).
 * Với `table-layout: fixed` thì không: bề rộng khai thắng, nên bảng có tiêu đề gộp sẽ NHẢY một cú
 * ngay khoảnh khắc bấm chuột. Nên tìm một hàng 1:1 trước — hàng dữ liệu đầu tiên gần như luôn là
 * một hàng như vậy — và chỉ lùi về phép chia đều khi không có hàng nào.
 *
 * Ô đang bị nút "Cột" ẩn đi trả 0, và số 0 được giữ nguyên: xem `resizedWidths`.
 */
function measureColumns(table: HTMLTableElement, count: number): number[] {
  const rong = (cell: HTMLTableCellElement) =>
    cell.style.display === "none" ? 0 : Math.max(Math.round(cell.getBoundingClientRect().width), MIN_COLUMN_WIDTH);
  const nhip = (cell: HTMLTableCellElement) => (cell.dataset.origColspan ? Number(cell.dataset.origColspan) : cell.colSpan);

  for (const row of Array.from(table.rows)) {
    const cells = Array.from(row.cells);
    if (cells.length !== count || !cells.every((c) => nhip(c) === 1)) continue;
    return cells.map(rong);
  }

  const out = new Array<number>(count).fill(MIN_COLUMN_WIDTH);
  const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th, thead tr:first-child td"));
  let col = 0;
  for (const th of ths) {
    const span = nhip(th);
    const w = Math.round(rong(th) / Math.max(span, 1));
    for (let c = col; c < col + span && c < count; c++) out[c] = w;
    col += span;
  }
  return out;
}

/** Bảo đảm `<colgroup>` là con ĐẦU TIÊN của bảng và có đúng số `<col>`. */
function ensureColGroup(table: HTMLTableElement, count: number): HTMLTableColElement[] {
  let group = table.querySelector<HTMLTableColElement>(":scope > colgroup[data-col-widths]");
  if (group && group.children.length !== count) {
    group.remove();
    group = null;
  }
  if (!group) {
    group = document.createElement("colgroup");
    group.setAttribute("data-col-widths", "");
    for (let i = 0; i < count; i++) group.appendChild(document.createElement("col"));
    table.insertBefore(group, table.firstChild);
  }
  return Array.from(group.children) as HTMLTableColElement[];
}

/**
 * Chỉ ghi bề rộng — chạy ở MỖI bước kéo nên phải rẻ: đúng N phép gán, không duyệt dòng nào.
 *
 * ═══ KHI ĐÃ CÓ BỀ RỘNG NGƯỜI ĐẶT, BẢNG PHẢI THÔI LÀ `width: 100%` ═══
 *
 * Mọi bảng ERP mang lớp `w-full`. `width: 100%` là một RÀNG BUỘC: tổng bề rộng các cột lớn hơn
 * khung chứa thì trình duyệt ép các cột co lại cho vừa — và nó ép MỌI cột, không riêng cột đang
 * kéo.
 *
 * ĐO TRÊN TRÌNH DUYỆT THẬT (21/09/2026, bảng 24 cột, khung ~1.160px): kéo cột "Mã hàng" hẹp đi
 * 80px làm cả bảng tụt từ 3.158px xuống 2.516px, và cột "CPQC" tự co từ 133px còn 56px dù không
 * ai chạm vào nó. Người dùng kéo MỘT cột và thấy SÁU cột khác đổi.
 *
 * Nên bề rộng bảng được khai bằng ĐÚNG TỔNG các cột, tính bằng px.
 *
 * ═══ VÀ PHẢI LÀ px, KHÔNG ĐƯỢC LÀ `max-content` ═══
 *
 * `table-layout: fixed` CHỈ có hiệu lực khi bảng có một bề rộng khai; bề rộng `auto` thì trình
 * duyệt lặng lẽ lùi về bố cục tự động. `max-content` là một từ khoá theo-nội-dung, nên Chrome xếp
 * nó vào nhóm `auto` — ĐO TRÊN CHROME THẬT (22/09/2026, bảng Đơn hàng): `<col>` khai 12px,
 * `getComputedStyle().tableLayout` trả về `"fixed"`, mà cột vẫn rộng 110px, đúng bằng `min-content`
 * của "1.234.000 ₫". Không lỗi, không cảnh báo, chỉ là cái lật không xảy ra.
 *
 * Bỏ hết bề rộng tuỳ chỉnh thì trả `w-full` về nguyên trạng — mặc định của bảng không đổi.
 */
function applyWidths(table: HTMLTableElement, widths: readonly number[] | null, count: number) {
  const cols = ensureColGroup(table, count);
  cols.forEach((col, i) => {
    const w = widths?.[i];
    col.style.width = w == null ? "" : `${w}px`;
  });
  const coDat = widths != null;
  table.style.tableLayout = coDat ? "fixed" : "";
  table.style.width = coDat ? `${widths.reduce((t, w) => t + w, 0)}px` : "";
  table.dataset.colSized = coDat ? "true" : "";
}

/**
 * Luật cắt cho từng ô. Đắt hơn `applyWidths` (duyệt mọi ô) nên KHÔNG gọi theo từng bước kéo — tập
 * cột đã kéo chỉ đổi khi người dùng bấm, còn bề rộng thì đi qua `<colgroup>`.
 *
 * `overflow: hidden` đặt cho MỌI ô khi bảng đã ở `table-layout: fixed`: ở bố cục ấy nội dung dài
 * hơn cột không bị chặn lại mà TRÀN ĐÈ sang ô bên cạnh, và hai con số chồng lên nhau còn tệ hơn
 * một con số bị cắt.
 *
 * Mặt nạ làm mờ thì CHỈ đặt ở cột đã kéo: cột khác được đo lại theo nội dung nên không có gì để
 * cắt, và một mặt nạ chuyển sắc trên vài nghìn ô là một cái giá dựng hình không đổi lấy được gì.
 * Ô trải nhiều cột (`span > 1`) cũng không mang mặt nạ — bề rộng của nó là tổng nhiều cột.
 */
function applyClip(table: HTMLTableElement, daKeo: Set<number>, batCat: boolean) {
  forEachCellByColumn(table, (cell, colIndex, span) => {
    if (!batCat) {
      cell.style.overflow = "";
      cell.style.whiteSpace = "";
      if (cell.dataset.colMasked) {
        cell.style.removeProperty("mask-image");
        cell.style.removeProperty("-webkit-mask-image");
        delete cell.dataset.colMasked;
      }
      return;
    }
    cell.style.overflow = "hidden";
    if (span === 1 && daKeo.has(colIndex)) {
      // Không để chữ xuống dòng ở cột đã kéo: người dùng thu hẹp để BỎ QUA cột đó, mà xuống dòng
      // thì cột hẹp lại làm hàng cao lên và cả bảng dài ra — ngược hẳn ý định.
      cell.style.whiteSpace = "nowrap";
      if (!cell.dataset.colMasked) {
        const mask = clipFadeMask(clipFadeEdge(getComputedStyle(cell).direction));
        cell.style.setProperty("mask-image", mask);
        cell.style.setProperty("-webkit-mask-image", mask);
        cell.dataset.colMasked = "1";
      }
    } else {
      cell.style.whiteSpace = "";
      if (cell.dataset.colMasked) {
        cell.style.removeProperty("mask-image");
        cell.style.removeProperty("-webkit-mask-image");
        delete cell.dataset.colMasked;
      }
    }
  });
}

/**
 * Đo bề rộng TỰ NHIÊN của mọi cột: gỡ sạch bề rộng khai và `table-layout`, đọc, rồi trả nguyên
 * trạng — tất cả trong MỘT lượt đồng bộ, nên trình duyệt không vẽ lại lần nào ở giữa và không ai
 * thấy một cú nhấp nháy.
 *
 * Đo ở trạng thái `w-full` (không phải `max-content`) là có chủ ý: đó đúng là hình dáng bảng khi
 * chưa ai kéo gì, kể cả phần giãn ra cho đủ khung. Đo ở `max-content` thì lượt kéo đầu tiên sẽ
 * làm MỌI cột co lại về bề rộng chữ — người dùng kéo một cột và thấy cả bảng đổi.
 */
function measureNatural(table: HTMLTableElement, count: number): number[] {
  const cols = ensureColGroup(table, count);
  const layout = table.style.tableLayout;
  const width = table.style.width;
  const cu = cols.map((c) => c.style.width);
  cols.forEach((c) => {
    c.style.width = "";
  });
  table.style.tableLayout = "";
  table.style.width = "";
  const nat = measureColumns(table, count);
  cols.forEach((c, i) => {
    c.style.width = cu[i];
  });
  table.style.tableLayout = layout;
  table.style.width = width;
  return nat;
}

/**
 * ═══ TAY KÉO CHỈ DỰNG CHO THIẾT BỊ CÓ CON TRỎ CHÍNH XÁC ═══
 *
 * Trên màn hình cảm ứng, tay kéo KHÔNG phải vô hại — nó CƯỚP thao tác vuốt. Nó rộng 9px, mang
 * `touch-action: none`, và nằm ở mép phải của MỌI cột: một bảng 12 cột rải hơn 100px vùng không
 * cuộn được dọc theo đúng thứ người ta hay đặt ngón tay. Tệ hơn, chạm trúng rồi vuốt ngang không
 * cuộn bảng mà ĐỔI BỀ RỘNG CỘT — người dùng không hề định làm vậy và cũng không biết vì sao nó
 * xảy ra.
 *
 * `(pointer: fine)` là chuột / bút cảm ứng — nơi nhắm trúng 9px là chuyện bình thường. Ngón tay
 * thì không, nên ở đó không dựng tay kéo nào. Nút "Cột" và nút "Bề rộng" vẫn còn: ẩn cột là cách
 * thu hẹp bảng dùng được bằng ngón tay.
 *
 * Đo ở LÚC GẮN và nghe thay đổi: máy tính bảng cắm/rút chuột rời đổi câu trả lời giữa chừng.
 * Mặc định `true` để lượt kết xuất đầu (chưa có `window`) không làm nhấp nháy trên máy bàn.
 */
function useConTroChinhXac() {
  const [co, setCo] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: fine)");
    const doc = () => setCo(mq.matches);
    doc();
    mq.addEventListener("change", doc);
    return () => mq.removeEventListener("change", doc);
  }, []);
  return co;
}

export function ColumnResize({ tableRef }: { tableRef: React.RefObject<HTMLTableElement | null> }) {
  const [heads, setHeads] = useState<{ index: number; el: HTMLTableCellElement; label: string }[]>([]);
  /** Bề rộng NGƯỜI ĐẶT — mỗi khoá là một cột đã kéo, tức một cột được phép cắt nội dung. */
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [dragging, setDragging] = useState<number | null>(null);
  const coConTro = useConTroChinhXac();
  const keyRef = useRef("");
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const clipRef = useRef("");
  const dragRef = useRef<{ index: number; startX: number; base: number[]; cuoi: number } | null>(null);

  /**
   * SỐ CỘT, KHÔNG PHẢI SỐ Ô TIÊU ĐỀ.
   *
   * Hai con số ấy bằng nhau ở hầu hết bảng, nên sai ở đây không ai thấy — cho tới bảng có TIÊU ĐỀ
   * GỘP. `/ads/daily` có 1 + 5 ô ở dòng tiêu đề đầu cho 29 cột: lấy `heads.length` thì `<colgroup>`
   * chỉ có 6 `<col>`, và với `table-layout: fixed` thì 6 cột đầu nhận bề rộng khai còn 23 cột sau
   * chia đều phần thừa. Phép cộng dồn `colSpan` nằm ở `columnCount`, dùng chung với nút "Cột".
   */
  const [count, setCount] = useState(0);

  /**
   * Áp cấu hình lên bảng: đo lại bề rộng tự nhiên, để cột đã kéo giữ con số người đặt, cột còn lại
   * lấy con số vừa đo. Cột đang bị ẩn đo ra 0 và giữ nguyên 0 — xem `resizedWidths`.
   */
  const apDung = useCallback((table: HTMLTableElement, soCot: number, rong: Record<number, number>) => {
    const keys = Object.keys(rong).map(Number);
    if (!keys.length) {
      applyWidths(table, null, soCot);
      if (clipRef.current !== "") {
        clipRef.current = "";
        applyClip(table, new Set(), false);
      }
      return;
    }
    const nat = measureNatural(table, soCot);
    applyWidths(
      table,
      nat.map((w, i) => (w > 0 && rong[i] != null ? rong[i] : w)),
      soCot,
    );
    const chuKy = keys.sort((a, b) => a - b).join(",");
    if (clipRef.current !== chuKy) {
      clipRef.current = chuKy;
      applyClip(table, new Set(keys), true);
    }
  }, []);

  /** Đọc lại tiêu đề, nạp cấu hình đã lưu, rồi áp. Chạy lúc gắn và mỗi khi bảng đổi dữ liệu. */
  const doc = useCallback(() => {
    const table = tableRef.current;
    // Đang kéo thì KHÔNG đo lại: phép đo gỡ sạch bề rộng khai, và làm vậy giữa lượt kéo là giật
    // cột đang cầm ra khỏi tay chuột.
    if (!table || dragRef.current) return;
    const list = columnHeaders(table);
    setHeads((prev) => (prev.length === list.length && prev.every((h, i) => h.el === list[i].el) ? prev : list));
    if (!list.length) return;
    const soCot = columnCount(table);
    setCount(soCot);
    const key = tableConfigKey(PREFIX, window.location.pathname, table.dataset.tableId ?? "", list.map((h) => h.label));
    if (key !== keyRef.current) {
      keyRef.current = key;
      let saved: Record<number, number> = {};
      try {
        saved = parseStoredWidths(localStorage.getItem(key), soCot);
      } catch {
        saved = {};
      }
      setWidths(saved);
      apDung(table, soCot, saved);
    } else {
      // Gọi lại vô điều kiện: trang sau có DÒNG MỚI, và dòng mới chưa mang luật cắt nào.
      applyClip(table, new Set(Object.keys(widthsRef.current).map(Number)), Object.keys(widthsRef.current).length > 0);
      apDung(table, soCot, widthsRef.current);
    }
  }, [apDung, tableRef]);

  useEffect(() => {
    doc();
    const table = tableRef.current;
    if (!table) return;
    // CHỈ quan sát thêm/bớt NÚT, không quan sát thuộc tính: lớp này (và nút "Cột") ghi `style` lên
    // từng ô, và quan sát thuộc tính sẽ biến chúng thành một vòng lặp tự kích hoạt lẫn nhau.
    // Gom về MỘT lượt mỗi khung hình: một lượt kết xuất của React sinh ra nhiều đợt đổi DOM, và
    // `apDung` phải ÉP TÍNH LẠI BỐ CỤC để đo bề rộng tự nhiên — chạy nó vài chục lần cho cùng một
    // lượt sang trang là trả giá thật cho một câu trả lời không đổi.
    let khung = 0;
    const obs = new MutationObserver(() => {
      if (khung) return;
      khung = requestAnimationFrame(() => {
        khung = 0;
        doc();
      });
    });
    obs.observe(table, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      if (khung) cancelAnimationFrame(khung);
    };
  }, [doc, tableRef]);

  const luu = useCallback((next: Record<number, number>) => {
    try {
      if (Object.keys(next).length) localStorage.setItem(keyRef.current, JSON.stringify(next));
      else localStorage.removeItem(keyRef.current);
    } catch {
      // trình duyệt chặn lưu trữ: bề rộng vẫn dùng được trong phiên này, chỉ không nhớ sang lần sau
    }
  }, []);

  /*
    ═══════════ CHUỘT ĐƯỢC THEO DÕI Ở `window`, KHÔNG Ở TAY KÉO ═══════════

    Bản đầu bắt `pointermove` / `pointerup` NGAY TRÊN tay kéo và dựa vào `setPointerCapture` để
    con trỏ đi ra ngoài vẫn còn nhận sự kiện. Hai lỗi, và lỗi thứ nhất giết cả tính năng:

      1. `setPointerCapture` CÓ THỂ NÉM, và nó đứng TRƯỚC mọi thứ khác trong hàm. Nó ném thì hàm
         thoát ngay ở dòng đó: không đóng băng, không đặt bề rộng, không một dấu vết nào. Đo trên
         Chrome thật (21/09/2026): lượt kéo lúc được lúc không, console SẠCH, `data-col-sized` vẫn
         rỗng. Gọi thẳng `onPointerDown` với một `setPointerCapture` giả ném lỗi thì tái hiện đúng
         100%. Bắt giữ con trỏ là TIỆN NGHI, không phải điều kiện — nên nó không được đứng chắn
         trước phần việc thật, và phải nằm trong `try`.
      2. Ngay cả khi bắt giữ chạy đúng, nó chỉ chuyển hướng sự kiện CHUỘT. Kéo nhanh ra khỏi bảng
         rồi thả ở chỗ khác vẫn cần một mốc kết thúc chắc chắn.

    `window` giải cả hai: sự kiện luôn tới, kể cả khi con trỏ đã rời khỏi tay kéo, khỏi bảng, hay
    ra ngoài cửa sổ. Tay kéo chỉ còn một việc — nói cho ta biết lượt kéo BẮT ĐẦU.
  */
  const batDau = (e: React.PointerEvent<HTMLSpanElement>, index: number) => {
    const table = tableRef.current;
    if (!table) return;
    e.preventDefault();
    const base = measureColumns(table, count);
    dragRef.current = { index, startX: e.clientX, base, cuoi: base[index] ?? MIN_COLUMN_WIDTH };
    setDragging(index);
    /*
      GIỮ NGUYÊN BỀ RỘNG ĐANG HIỂN THỊ CỦA MỌI CỘT, rồi mới bật `table-layout: fixed`.

      `fixed` đòi bề rộng cho mọi cột; cột nào không khai thì trình duyệt chia đều phần còn lại.
      Khai đúng con số đang hiện nên khoảnh khắc bấm chuột không có cú nhảy nào — và từ đó trở đi
      chỉ đúng một cột đổi.

      Cột đang kéo vào danh sách CẮT ngay từ đây, không đợi thả chuột: không bật cắt thì bước kéo
      đầu tiên đã bị `min-content` của chữ chặn lại, cột đứng yên, và người dùng kết luận tính
      năng hỏng.
    */
    applyWidths(table, base, count);
    const cat = new Set([...Object.keys(widthsRef.current).map(Number), index]);
    const chuKy = [...cat].sort((a, b) => a - b).join(",");
    if (clipRef.current !== chuKy) {
      clipRef.current = chuKy;
      applyClip(table, cat, true);
    }

    const keo = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = resizedWidths(d.base, d.index, ev.clientX - d.startX);
      d.cuoi = next[d.index];
      applyWidths(table, next, count);
    };
    const ketThuc = () => {
      window.removeEventListener("pointermove", keo);
      window.removeEventListener("pointerup", ketThuc);
      window.removeEventListener("pointercancel", ketThuc);
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDragging(null);
      const w = clampColumnWidth(d.cuoi);
      // Cột đang ẩn (bề rộng 0) không vào bản lưu: nó chưa từng được kéo, chỉ được đo.
      const next = w == null || d.base[d.index] <= 0 ? widthsRef.current : { ...widthsRef.current, [d.index]: w };
      setWidths(next);
      widthsRef.current = next;
      luu(next);
      apDung(table, count, next);
    };
    window.addEventListener("pointermove", keo);
    window.addEventListener("pointerup", ketThuc);
    window.addEventListener("pointercancel", ketThuc);
    // Tiện nghi, KHÔNG phải điều kiện: có bắt giữ thì con trỏ giữ hình mũi tên kéo khi ra ngoài.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // trình duyệt từ chối bắt giữ con trỏ — lượt kéo vẫn chạy đủ nhờ ba lắng nghe ở `window`
    }
  };

  /** Bấm đúp lên tay kéo: trả ĐÚNG cột đó về tự động (hết cắt, đo lại theo nội dung). */
  const veTuDong = (index: number) => {
    const table = tableRef.current;
    if (!table) return;
    const next = { ...widthsRef.current };
    delete next[index];
    setWidths(next);
    widthsRef.current = next;
    // Gỡ luật cắt của ô thuộc cột này trước khi đo lại: còn `overflow: hidden` thì phép đo vẫn ra
    // bề rộng cũ, và cột "về tự động" xong vẫn đứng nguyên chỗ hẹp.
    applyClip(table, new Set(Object.keys(next).map(Number)), Object.keys(next).length > 0);
    clipRef.current = Object.keys(next).map(Number).sort((a, b) => a - b).join(",");
    apDung(table, count, next);
    luu(next);
  };

  const datLai = () => {
    const table = tableRef.current;
    if (!table) return;
    setWidths({});
    widthsRef.current = {};
    applyClip(table, new Set(), false);
    clipRef.current = "";
    apDung(table, count, {});
    luu({});
  };

  const daChinh = useMemo(() => Object.keys(widths).length > 0, [widths]);

  return (
    <>
      {daChinh ? (
        <button
          type="button"
          onClick={datLai}
          title="Trả mọi cột về bề rộng tự động"
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Ruler className="size-3.5" /> Bề rộng
        </button>
      ) : null}
      {(coConTro ? heads : []).map((h) =>
        // Cột đang bị ẩn bằng nút "Cột" thì không có tay kéo — kéo một cột không nhìn thấy là một
        // thao tác không có phản hồi.
        h.el.style.display === "none"
          ? null
          : createPortal(
              <span
                role="separator"
                aria-orientation="vertical"
                aria-label={`Đổi bề rộng cột ${h.label}`}
                title="Kéo để đổi bề rộng cột · bấm đúp để trả cột này về tự động"
                onPointerDown={(e) => batDau(e, h.index)}
                onDoubleClick={() => veTuDong(h.index)}
                /*
                  VÙNG BẮT CHUỘT NẰM TRỌN TRONG Ô CỦA CHÍNH NÓ (`right: 0`), KHÔNG THÒ SANG Ô BÊN.

                  Bản đầu để tay kéo thò ra ngoài mép phải nửa bề rộng cho "cân". Đo bằng
                  `elementFromPoint` trên trình duyệt thật: 4/7 px đầu trả về tay kéo, 3px còn lại
                  trả về ô tiêu đề KẾ TIẾP — ô sau đứng sau trong DOM, cùng `z-index` của tiêu đề
                  dính, nên nó vẽ đè lên cả phần con z-20 của ô trước. Người dùng nhắm vào đường
                  kẻ giữa hai cột thì trượt, và trượt một cách im lặng.
                */
                style={{ width: RESIZE_HANDLE_WIDTH, right: 0 }}
                className={cn(
                  "absolute top-0 z-20 h-full cursor-col-resize touch-none select-none print:hidden",
                  "after:absolute after:inset-y-1 after:right-0 after:w-px after:rounded-full after:transition-colors",
                  dragging === h.index ? "after:bg-primary" : "after:bg-transparent hover:after:bg-primary/60",
                )}
              />,
              h.el,
            ),
      )}
    </>
  );
}

export { clampColumnWidth };

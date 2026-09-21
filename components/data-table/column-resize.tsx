"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ruler } from "lucide-react";
import {
  MIN_COLUMN_WIDTH,
  RESIZE_HANDLE_WIDTH,
  clampColumnWidth,
  parseStoredWidths,
  resizedWidths,
  tableConfigKey,
  wrapModeFor,
} from "@/lib/table/column-resize";
import { columnHeaders, forEachCellByColumn } from "@/components/data-table/column-dom";
import { cn } from "@/lib/utils";

/**
 * ═══════════ KÉO ĐỂ ĐỔI BỀ RỘNG MỘT CỘT BẤT KỲ ═══════════
 *
 * Gắn vào MỌI bảng đi qua `components/ui/table.tsx`, cùng chỗ với nút "Cột" — cùng một cách làm
 * (thao tác trên DOM của bảng đã dựng sẵn), nên bảng do máy chủ kết xuất cũng dùng được mà không
 * trang nào phải khai thêm gì.
 *
 * ─── BỐN QUYẾT ĐỊNH, VÀ LÝ DO CỦA TỪNG CÁI ───
 *
 *  1. BỀ RỘNG ĐẶT Ở `<col>`, BẢNG GIỮ `table-layout: auto`.
 *     Bố cục tự động lấy `max(bề rộng khai, min-content)`, nên trình duyệt KHÔNG BAO GIỜ thu một
 *     cột xuống dưới bề rộng tối thiểu của nội dung. Hàng rào chống cắt chữ nằm trong công cụ bố
 *     cục chứ không nằm trong mã của chúng ta — không có đường nào lách qua. Dùng
 *     `table-layout: fixed` thì ngược lại: bề rộng khai THẮNG nội dung, và chữ bị cắt thật.
 *
 *  2. LÚC BẮT ĐẦU KÉO, ĐÓNG BĂNG BỀ RỘNG ĐANG HIỂN THỊ CỦA MỌI CỘT.
 *     Không làm vậy thì thu hẹp một cột sẽ khiến các cột chưa khai bề rộng giãn ra theo tỷ lệ
 *     không ai đoán được: người dùng kéo một cột và thấy cả bảng nhảy. Đóng băng đúng tại con số
 *     đang hiện nên khoảnh khắc bấm chuột không có cú nhảy nào.
 *
 *  3. Ô SỐ KHÔNG BAO GIỜ XUỐNG DÒNG, Ô CHỮ XUỐNG DÒNG Ở KHOẢNG TRẮNG.
 *     Xem `lib/table/column-resize.ts`. Tóm tắt: "205.892.000 ₫" gãy làm đôi là đọc ra một con số
 *     khác; còn `overflow-wrap: break-word` (KHÔNG phải `anywhere`) giữ nguyên `min-content`, nên
 *     cột chữ vẫn không hẹp hơn từ dài nhất trong nó — mã vận đơn, SKU, số điện thoại còn nguyên.
 *
 *  4. KHÔNG `text-overflow`, KHÔNG `line-clamp`, KHÔNG `overflow: hidden`.
 *     Cả ba đều là giấu nội dung đi, và người đọc không có cách nào biết mình đang thiếu gì. Thu
 *     hẹp ở đây nghĩa là chữ DỒN XUỐNG DÒNG — dòng cao lên, không mất chữ nào.
 *
 * Bề rộng lưu theo trang + bảng + chữ ký nhãn cột trong trình duyệt của chính người dùng, cùng
 * cách với nút "Cột".
 */

const PREFIX = "erp.colw";

/** Bề rộng ĐANG HIỂN THỊ của từng cột. Tiêu đề gộp nhiều cột thì chia đều — không có nguồn nào mịn hơn. */
function measureColumns(table: HTMLTableElement, count: number): number[] {
  const out = new Array<number>(count).fill(MIN_COLUMN_WIDTH);
  const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th, thead tr:first-child td"));
  let col = 0;
  for (const th of ths) {
    const span = th.dataset.origColspan ? Number(th.dataset.origColspan) : th.colSpan;
    const w = th.getBoundingClientRect().width / Math.max(span, 1);
    for (let c = col; c < col + span && c < count; c++) out[c] = Math.max(Math.round(w), MIN_COLUMN_WIDTH);
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
 * Mọi bảng ERP mang lớp `w-full`. Với bố cục tự động, `width: 100%` là một RÀNG BUỘC: nếu tổng bề
 * rộng các cột lớn hơn khung chứa, trình duyệt ép các cột co lại về phía `min-content` cho vừa —
 * và nó ép MỌI cột, không riêng cột đang kéo.
 *
 * Bình thường điều đó vô hại vì mọi ô đều `white-space: nowrap`, nên `min-content` bằng đúng nội
 * dung và không cột nào co được. Nhưng lượt kéo đầu tiên bật xuống dòng cho ô chữ ⇒ `min-content`
 * tụt hẳn xuống ⇒ trình duyệt co được, và nó co thật.
 *
 * ĐO TRÊN TRÌNH DUYỆT THẬT (21/09/2026, bảng 24 cột, khung ~1.160px): kéo cột "Mã hàng" hẹp đi
 * 80px làm cả bảng tụt từ 3.158px xuống 2.516px, và cột "CPQC" tự co từ 133px còn 56px dù không
 * ai chạm vào nó. Người dùng kéo MỘT cột và thấy SÁU cột khác đổi — đúng thứ quyết định "đóng
 * băng" sinh ra để chặn, nhưng đóng băng một mình không đủ.
 *
 * `width: max-content` gỡ ràng buộc ấy: bảng rộng đúng bằng tổng các cột, khung bao tự cuộn ngang.
 * Bỏ hết bề rộng tuỳ chỉnh thì trả `w-full` về nguyên trạng — mặc định của bảng không đổi.
 */
function applyWidths(table: HTMLTableElement, widths: Record<number, number>, count: number) {
  const cols = ensureColGroup(table, count);
  cols.forEach((col, i) => {
    const w = widths[i];
    col.style.width = w ? `${w}px` : "";
  });
  const coDat = Object.keys(widths).length > 0;
  table.style.width = coDat ? "max-content" : "";
  table.dataset.colSized = coDat ? "true" : "";
}

/**
 * Đặt luật xuống dòng cho các ô thuộc cột ĐÃ CÓ bề rộng. Đắt hơn (duyệt mọi ô) nên CHỈ gọi khi
 * TẬP cột có bề rộng đổi, không gọi theo từng bước kéo.
 */
function applyWrap(table: HTMLTableElement, sized: Set<number>) {
  forEachCellByColumn(table, (cell, colIndex) => {
    if (!sized.has(colIndex)) {
      cell.style.whiteSpace = "";
      cell.style.overflowWrap = "";
      return;
    }
    const mode = wrapModeFor({ className: cell.className, containsNumeric: !!cell.querySelector(".numeric") });
    if (mode === "nowrap") {
      cell.style.whiteSpace = "nowrap";
      cell.style.overflowWrap = "";
    } else {
      cell.style.whiteSpace = "normal";
      cell.style.overflowWrap = "break-word";
    }
  });
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
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [dragging, setDragging] = useState<number | null>(null);
  const coConTro = useConTroChinhXac();
  const keyRef = useRef("");
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const sizedRef = useRef("");
  const dragRef = useRef<{ index: number; startX: number; base: number[] } | null>(null);

  const count = heads.length;

  /** Đọc lại tiêu đề, nạp cấu hình đã lưu, rồi áp. Chạy lúc gắn và mỗi khi bảng đổi dữ liệu. */
  const doc = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const list = columnHeaders(table);
    setHeads((prev) => (prev.length === list.length && prev.every((h, i) => h.el === list[i].el) ? prev : list));
    if (!list.length) return;
    const key = tableConfigKey(PREFIX, window.location.pathname, table.dataset.tableId ?? "", list.map((h) => h.label));
    if (key !== keyRef.current) {
      keyRef.current = key;
      let saved: Record<number, number> = {};
      try {
        saved = parseStoredWidths(localStorage.getItem(key), list.length);
      } catch {
        saved = {};
      }
      setWidths(saved);
      applyWidths(table, saved, list.length);
      sizedRef.current = Object.keys(saved).sort().join(",");
      applyWrap(table, new Set(Object.keys(saved).map(Number)));
    } else {
      applyWidths(table, widthsRef.current, list.length);
      applyWrap(table, new Set(Object.keys(widthsRef.current).map(Number)));
    }
  }, [tableRef]);

  useEffect(() => {
    doc();
    const table = tableRef.current;
    if (!table) return;
    // CHỈ quan sát thêm/bớt NÚT, không quan sát thuộc tính: nút "Cột" ghi `style` lên từng ô, và
    // quan sát thuộc tính sẽ biến hai lớp này thành một vòng lặp tự kích hoạt lẫn nhau.
    const obs = new MutationObserver(() => doc());
    obs.observe(table, { childList: true, subtree: true });
    return () => obs.disconnect();
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
    dragRef.current = { index, startX: e.clientX, base };
    setDragging(index);
    // ĐÓNG BĂNG mọi cột tại đúng con số đang hiện (quyết định 2 ở đầu tệp).
    const dong = Object.fromEntries(base.map((w, i) => [i, w]));
    setWidths(dong);
    applyWidths(table, dong, count);
    const chuKy = base.map((_, i) => i).join(",");
    if (sizedRef.current !== chuKy) {
      sizedRef.current = chuKy;
      applyWrap(table, new Set(base.map((_, i) => i)));
    }

    const keo = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = resizedWidths(d.base, d.index, ev.clientX - d.startX);
      const map = Object.fromEntries(next.map((w, i) => [i, w]));
      setWidths(map);
      applyWidths(table, map, count);
    };
    const ketThuc = () => {
      window.removeEventListener("pointermove", keo);
      window.removeEventListener("pointerup", ketThuc);
      window.removeEventListener("pointercancel", ketThuc);
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(null);
      luu(widthsRef.current);
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

  /** Bấm đúp lên tay kéo: trả ĐÚNG cột đó về tự động, giữ nguyên các cột khác. */
  const veTuDong = (index: number) => {
    const table = tableRef.current;
    if (!table) return;
    const next = { ...widthsRef.current };
    delete next[index];
    setWidths(next);
    applyWidths(table, next, count);
    const chuKy = Object.keys(next).sort().join(",");
    sizedRef.current = chuKy;
    applyWrap(table, new Set(Object.keys(next).map(Number)));
    luu(next);
  };

  const datLai = () => {
    const table = tableRef.current;
    if (!table) return;
    setWidths({});
    applyWidths(table, {}, count);
    sizedRef.current = "";
    applyWrap(table, new Set());
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns3, RotateCcw } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type HeaderInfo = { index: number; label: string };

function headerLabel(th: HTMLTableCellElement, index: number) {
  if (th.querySelector('input[type="checkbox"], [role="checkbox"]')) return "Chọn";
  const text = (th.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || `Cột ${index + 1}`;
}

function storageKey(table: HTMLTableElement, headers: HeaderInfo[]) {
  const path = typeof window !== "undefined" ? window.location.pathname.replace(/\/[0-9a-f-]{20,}/g, "/:id") : "";
  const sig = headers.map((h) => h.label).join("|");
  let hash = 0;
  for (let i = 0; i < sig.length; i++) hash = (hash * 31 + sig.charCodeAt(i)) | 0;
  return `erp.cols:${path}:${table.dataset.tableId ?? ""}:${hash}`;
}

/** Áp dụng ẩn/hiện theo chỉ số cột cho mọi hàng (kể cả hàng gộp colSpan) */
function applyHidden(table: HTMLTableElement, hidden: Set<number>) {
  const rows = table.querySelectorAll<HTMLTableRowElement>("tr");
  rows.forEach((row) => {
    let col = 0;
    Array.from(row.cells).forEach((cell) => {
      const orig = cell.dataset.origColspan ? Number(cell.dataset.origColspan) : cell.colSpan;
      if (!cell.dataset.origColspan) cell.dataset.origColspan = String(orig);
      if (orig <= 1) {
        cell.style.display = hidden.has(col) ? "none" : "";
      } else {
        let hiddenInside = 0;
        for (let c = col; c < col + orig; c++) if (hidden.has(c)) hiddenInside += 1;
        if (hiddenInside >= orig) cell.style.display = "none";
        else {
          cell.style.display = "";
          cell.colSpan = orig - hiddenInside;
        }
      }
      col += orig;
    });
  });
}

/**
 * Nút "Cột" cho mọi bảng: ẩn/hiện từng cột, ghi nhớ theo trang + bảng trong trình duyệt.
 * Hoạt động trên DOM của bảng (cả bảng server-render), tự áp lại khi bảng đổi dữ liệu.
 */
export function ColumnVisibility({ tableRef, minColumns = 4 }: { tableRef: React.RefObject<HTMLTableElement | null>; minColumns?: number }) {
  const [headers, setHeaders] = useState<HeaderInfo[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const keyRef = useRef("");
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  const readHeaders = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th, thead tr:first-child td"));
    const list: HeaderInfo[] = [];
    let col = 0;
    for (const th of ths) {
      const span = th.dataset.origColspan ? Number(th.dataset.origColspan) : th.colSpan;
      list.push({ index: col, label: headerLabel(th, col) });
      col += span;
    }
    setHeaders((prev) => (prev.length === list.length && prev.every((h, i) => h.label === list[i].label) ? prev : list));
    const key = storageKey(table, list);
    if (key !== keyRef.current) {
      keyRef.current = key;
      let saved: number[] = [];
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? "[]") as number[];
      } catch {
        saved = [];
      }
      const next = new Set(saved.filter((i) => Number.isInteger(i) && i < list.length));
      setHidden(next);
      applyHidden(table, next);
    } else {
      applyHidden(table, hiddenRef.current);
    }
  }, [tableRef]);

  useEffect(() => {
    readHeaders();
    const table = tableRef.current;
    if (!table) return;
    const obs = new MutationObserver(() => readHeaders());
    obs.observe(table, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [readHeaders, tableRef]);

  const toggle = (index: number, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(index);
    else next.add(index);
    setHidden(next);
    try {
      localStorage.setItem(keyRef.current, JSON.stringify([...next]));
    } catch {
      // bỏ qua khi trình duyệt chặn lưu trữ
    }
    if (tableRef.current) applyHidden(tableRef.current, next);
  };
  const reset = () => {
    setHidden(new Set());
    try {
      localStorage.removeItem(keyRef.current);
    } catch {
      // bỏ qua
    }
    if (tableRef.current) applyHidden(tableRef.current, new Set());
  };

  const visibleCount = useMemo(() => headers.length - hidden.size, [headers, hidden]);
  if (headers.length < minColumns) return null;
  return (
    <div className="flex justify-end px-2 pt-1 print:hidden">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground" title="Ẩn / hiện cột">
            <Columns3 className="size-3.5" /> Cột {hidden.size ? <span className="rounded bg-primary/10 px-1 text-primary">{visibleCount}/{headers.length}</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs font-semibold">Hiện cột</span>
            <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={reset}><RotateCcw className="size-3" /> Mặc định</button>
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {headers.map((h) => (
              <label key={h.index} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
                <Checkbox checked={!hidden.has(h.index)} onCheckedChange={(v) => toggle(h.index, v === true)} />
                <span className="truncate">{h.label}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 px-1 text-[10.5px] text-muted-foreground">Lưu riêng cho trang này trên trình duyệt của bạn.</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

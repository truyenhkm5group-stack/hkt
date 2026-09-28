"use client";

import * as React from "react";
import { Copy, GripVertical, MoveHorizontal, Trash2 } from "lucide-react";
import { PageRenderer } from "@/components/pages/page-renderer";
import { Button } from "@/components/ui/button";
import type { RenderBlock, RenderSection } from "@/lib/pages/render";
import { BLOCK_TYPE_LABEL, SPAN_LABEL, type PagePathError } from "@/lib/platform-ui/page-admin-shared";
import { childrenOf, findBlock, isColumn, isFilter, locate, sectionVariant, snapSpan, spanFromDrag, type BuilderErrors, type DropSlot } from "@/lib/platform-ui/page-builder-ops";
import { BLOCK_SPANS, type BlockSpan, type PageBlock, type PageSchema, type ResolvedBlock } from "@/lib/pages/types";
import { cn } from "@/lib/utils";
import { DRAG_MIME, isBefore, isSectionPayload, type DragPayload, type DropHint } from "./dnd";

/**
 * ═══════════ KHUNG GIỮA CỦA TRÌNH KÉO-THẢ ═══════════
 *
 * Khung vẽ bằng `PageRenderer` — ĐÚNG renderer của `/p/<slug>` — ở `mode="edit"` (khung chọn `data-block-id`,
 * `selectedId`, `onSelectBlock`), mỗi khối mang kết quả XEM TRƯỚC (`previewPageBlock`) do trình soạn giữ theo nội
 * dung khối. Renderer không có logic kéo-thả; phần đó nằm ở ĐÂY, gắn từ ngoài:
 *  · kéo: `draggable` gắn lên từng khung `[data-block-id]` sau mỗi lượt vẽ, sự kiện kéo bắt ở gốc khung (uỷ quyền);
 *  · vạch báo điểm thả, thanh công cụ của khối đang chọn, tay nắm đổi độ rộng, huy hiệu lỗi: một LỚP PHỦ tuyệt đối
 *    đo vị trí từng khung sau mỗi lượt vẽ.
 * Kéo / đổi chỗ / đổi độ rộng chỉ đổi schema ở trình duyệt, không gọi máy chủ (kết quả xem trước theo nội dung khối,
 * không theo vị trí hay độ rộng).
 *
 * Mỗi nhóm vẽ bằng một lượt `PageRenderer` riêng bên trong khung nhóm của trình soạn (tay nắm kéo nhóm, chọn nhóm,
 * vùng thả cho nhóm rỗng). Điện thoại = khung 390px, mọi khối rộng hết — đúng như renderer làm dưới `md`.
 */

export type Device = "desktop" | "phone";
export type Selection = { kind: "block"; id: string } | { kind: "section"; key: string } | null;

type Rect = { left: number; top: number; width: number; height: number };

type Props = {
  schema: PageSchema;
  resultOf: (block: PageBlock) => ResolvedBlock | Promise<ResolvedBlock>;
  device: Device;
  selection: Selection;
  errors: BuilderErrors;
  drag: React.RefObject<DragPayload | null>;
  hint: DropHint | null;
  onHint: (h: DropHint | null) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onSelect: (s: Selection) => void;
  onSpan: (id: string, span: BlockSpan) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
};

/**
 * Chế độ soạn: nội dung khối không nhận chuột (bấm là CHỌN khung, không phải bấm vào bảng / ô lọc), khung khối lồng
 * nhau (khối con của cột) vẫn nhận. Khung điện thoại ép lưới về một cột như renderer dưới `md`.
 */
const EDIT_CSS = `
[data-builder-root] [data-block-id] { pointer-events: auto; }
[data-builder-root] [data-block-id] *:not([data-block-id]) { pointer-events: none; }
[data-builder-root] [data-block-id][draggable="true"] { cursor: grab; }
[data-builder-device="phone"] [data-section] > div.grid { grid-template-columns: minmax(0, 1fr); }
[data-builder-device="phone"] [data-block] { grid-column: 1 / -1; }
`;

/** Khối nhận được điểm thả VÀO cột (không cột, không bộ lọc, không nhóm / hàng). */
function canEnterColumn(p: DragPayload | null, schema: PageSchema): boolean {
  if (!p) return false;
  if (p.kind === "new") return p.item !== "column" && p.item !== "filter" && p.item !== "section" && p.item !== "row";
  if (p.kind === "block") {
    const b = findBlock(schema, p.id);
    return b !== null && !isColumn(b) && !isFilter(b);
  }
  return false;
}

export function BuilderCanvas(props: Props) {
  const { schema, device, drag, hint, onHint, onDrop, selection, onSelect } = props;
  const phone = device === "phone";
  const root = React.useRef<HTMLDivElement>(null);
  const [rects, setRects] = React.useState<Record<string, Rect>>({});
  const [resize, setResize] = React.useState<{ id: string; span: BlockSpan } | null>(null);
  const resizing = React.useRef<{ id: string; x: number; span: number; width: number } | null>(null);

  const selectedId = selection?.kind === "block" ? selection.id : null;
  const errorIds = Object.keys(props.errors.block).filter((id) => (props.errors.block[id] ?? []).length > 0);

  // ─── Đo vị trí khung sau mỗi lượt vẽ (chỉ đặt state khi thật sự đổi — không vòng lặp) ───
  const measure = React.useCallback(() => {
    const el = root.current;
    if (!el) return;
    const base = el.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    el.querySelectorAll<HTMLElement>("[data-block-id]").forEach((f) => {
      f.setAttribute("draggable", "true");
      const r = f.getBoundingClientRect();
      next[f.dataset.blockId ?? ""] = { left: Math.round(r.left - base.left), top: Math.round(r.top - base.top), width: Math.round(r.width), height: Math.round(r.height) };
    });
    setRects((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  React.useLayoutEffect(() => measure());
  React.useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const rel = (r: DOMRect): Rect => {
    const base = root.current!.getBoundingClientRect();
    return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
  };

  // ─── Kéo-thả (uỷ quyền ở gốc khung) ───
  const onDragStart = (e: React.DragEvent) => {
    const frame = (e.target as HTMLElement).closest?.("[data-block-id]") as HTMLElement | null;
    if (!frame || !root.current?.contains(frame)) return;
    if (resizing.current) {
      e.preventDefault();
      return;
    }
    const id = frame.dataset.blockId ?? "";
    drag.current = { kind: "block", id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_MIME, `block:${id}`);
  };

  const onDragOver = (e: React.DragEvent) => {
    const p = drag.current;
    if (!p || !root.current) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    if (isSectionPayload(p)) {
      const sec = target.closest?.("[data-builder-section]") as HTMLElement | null;
      if (!sec) {
        onHint({ kind: "section", index: schema.sections.length, bar: null });
        return;
      }
      const si = schema.sections.findIndex((s) => s.key === sec.dataset.builderSection);
      const r = sec.getBoundingClientRect();
      const before = isBefore(e, r, "y");
      const box = rel(r);
      onHint({ kind: "section", index: before ? si : si + 1, bar: { left: box.left, top: before ? box.top - 8 : box.top + box.height + 4, width: box.width, height: 4 } });
      return;
    }
    const frame = target.closest?.("[data-block-id]") as HTMLElement | null;
    if (frame && root.current.contains(frame)) {
      const id = frame.dataset.blockId ?? "";
      if (p.kind === "block" && p.id === id) {
        onHint(null);
        return;
      }
      const at = locate(schema, id);
      const block = findBlock(schema, id);
      if (!at || !block) return;
      const r = frame.getBoundingClientRect();
      const box = rel(r);
      if (isColumn(block) && canEnterColumn(p, schema)) {
        const edge = Math.min(40, r.width * 0.2);
        if (e.clientX > r.left + edge && e.clientX < r.right - edge) {
          onHint({ kind: "block", slot: { section: at.section, column: id, index: childrenOf(block).length }, bar: { left: box.left + 8, top: box.top + box.height - 6, width: box.width - 16, height: 4 } });
          return;
        }
      }
      const axis: "x" | "y" = phone || at.child !== null ? "y" : "x";
      const before = isBefore(e, r, axis);
      const column = at.child === null ? null : schema.sections[at.section].blocks[at.index].id;
      const slot: DropSlot = { section: at.section, column, index: (at.child ?? at.index) + (before ? 0 : 1) };
      const bar = axis === "x" ? { left: before ? box.left - 7 : box.left + box.width + 3, top: box.top, width: 4, height: box.height } : { left: box.left, top: before ? box.top - 7 : box.top + box.height + 3, width: box.width, height: 4 };
      onHint({ kind: "block", slot, bar });
      return;
    }
    const sec = target.closest?.("[data-builder-section]") as HTMLElement | null;
    const si = sec ? schema.sections.findIndex((s) => s.key === sec.dataset.builderSection) : schema.sections.length - 1;
    if (si < 0) return;
    onHint({ kind: "block", slot: { section: si, column: null, index: schema.sections[si].blocks.length }, bar: null });
  };

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    onDrop();
  };

  // ─── Chọn: khung khối tự chọn đúng khung TRONG CÙNG chứa điểm bấm (`EditableBlockFrame`) — khối con trong cột chọn được ───
  const selectBlock = React.useCallback((id: string) => onSelect({ kind: "block", id }), [onSelect]);

  // ─── Tay nắm đổi độ rộng ───
  const startResize = (e: React.PointerEvent<HTMLButtonElement>, b: PageBlock) => {
    e.preventDefault();
    e.stopPropagation();
    const cell = root.current?.querySelector(`[data-block="${CSS.escape(b.id)}"]`);
    const grid = cell?.parentElement;
    resizing.current = { id: b.id, x: e.clientX, span: b.span, width: grid?.getBoundingClientRect().width ?? 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResize({ id: b.id, span: b.span });
  };
  const moveResize = (e: React.PointerEvent) => {
    const r = resizing.current;
    if (r) setResize({ id: r.id, span: spanFromDrag(r.span, e.clientX - r.x, r.width) });
  };
  const endResize = () => {
    const r = resizing.current;
    resizing.current = null;
    if (r && resize && resize.span !== r.span) props.onSpan(r.id, resize.span);
    setResize(null);
  };
  const keyResize = (e: React.KeyboardEvent, b: PageBlock) => {
    const i = BLOCK_SPANS.indexOf(b.span);
    if (e.key === "ArrowRight" && i < BLOCK_SPANS.length - 1) props.onSpan(b.id, BLOCK_SPANS[i + 1]);
    else if (e.key === "ArrowLeft" && i > 0) props.onSpan(b.id, BLOCK_SPANS[i - 1]);
    else return;
    e.preventDefault();
  };

  // ─── Dữ liệu cho renderer: khối hiện tại (độ rộng đang kéo áp ngay), kết quả xem trước theo nội dung ───
  const item = (b: PageBlock): RenderBlock => {
    const block = resize && resize.id === b.id ? { ...b, span: resize.span } : b;
    if (isColumn(b)) {
      // Cột không có dữ liệu riêng: kết quả của CHÍNH cột dựng tại chỗ (không gọi máy chủ), từng con xem trước riêng.
      return { block, result: { ok: true, block, data: { children: [] } }, children: childrenOf(b).map((c) => ({ block: c, result: props.resultOf(c) })) };
    }
    return { block, result: props.resultOf(b) };
  };
  const sectionFor = (s: PageSchema["sections"][number]): RenderSection => ({ key: s.key, ...(s.variant ? { variant: s.variant } : {}), blocks: s.blocks.map(item) });

  const selectedBlock = selectedId ? findBlock(schema, selectedId) : null;
  const selectedRect = selectedId ? rects[selectedId] : undefined;
  const selectedInColumn = selectedId ? locate(schema, selectedId)?.child !== null : false;

  return (
    <div ref={root} data-builder-root className="relative" onDragStart={onDragStart} onDragOver={onDragOver} onDrop={drop} onDragEnd={props.onDragEnd}>
      <style>{EDIT_CSS}</style>
      <div className={cn("mx-auto space-y-4", phone ? "w-[390px] max-w-full rounded-[28px] border-8 border-foreground/10 bg-background p-3" : "w-full")} data-builder-device={device}>
        {schema.sections.map((s, si) => {
          const plain = sectionVariant(s) === "plain";
          const selected = selection?.kind === "section" && selection.key === s.key;
          const sectionErrors = props.errors.section[s.key] ?? [];
          const endHint = hint?.kind === "block" && hint.slot.section === si && hint.slot.column === null && hint.slot.index === s.blocks.length;
          return (
            <div
              key={s.key}
              data-builder-section={s.key}
              aria-label={plain ? `Hàng ${si + 1}` : (s.title ?? `Nhóm ${si + 1}`)}
              className={cn("relative rounded-2xl p-2 transition-colors", plain ? "border border-dashed border-hairline" : "border bg-surface/60", selected && "ring-2 ring-primary", sectionErrors.length > 0 && "border-destructive/60")}
            >
              <header
                className="mb-2 flex items-center gap-1.5"
                draggable
                onDragStart={(e) => {
                  e.stopPropagation();
                  drag.current = { kind: "section", index: si };
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(DRAG_MIME, `section:${s.key}`);
                }}
              >
                <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-[13px] font-semibold hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect({ kind: "section", key: s.key });
                  }}
                >
                  {plain ? `Hàng ${si + 1} (không khung, không tiêu đề)` : s.title || `Nhóm ${si + 1} (không tiêu đề)`}
                </button>
                {sectionErrors.length ? <span className="rounded-full bg-destructive px-1.5 text-[10.5px] font-semibold text-white">{sectionErrors.length} lỗi</span> : null}
                <span className="ml-auto text-[11px] text-muted-foreground">{s.blocks.length} khối</span>
              </header>
              {s.blocks.length > 0 ? <PageRenderer sections={[sectionFor(s)]} diagnose mode="edit" selectedId={selectedId} onSelectBlock={selectBlock} /> : null}
              <div
                data-builder-drop-end={s.key}
                className={cn(
                  "mt-2 flex items-center justify-center rounded-xl border-2 border-dashed text-xs text-muted-foreground transition-colors",
                  s.blocks.length === 0 ? "min-h-[88px]" : "min-h-[28px] border-transparent",
                  endHint && "border-primary bg-primary/5 text-primary",
                )}
              >
                {s.blocks.length === 0 ? "Kéo một khối từ thư viện vào đây" : endHint ? "Thả vào cuối nhóm" : null}
              </div>
            </div>
          );
        })}
        <div
          className={cn("flex min-h-[56px] items-center justify-center rounded-2xl border-2 border-dashed text-xs text-muted-foreground", hint?.kind === "section" && hint.index === schema.sections.length && "border-primary bg-primary/5 text-primary")}
          data-builder-tail
        >
          Thả «Nhóm» / «Hàng» vào đây để thêm cuối trang
        </div>
      </div>

      {/* ─── LỚP PHỦ: vạch thả · huy hiệu lỗi · thanh công cụ + tay nắm của khối đang chọn ─── */}
      <div className="pointer-events-none absolute inset-0 z-20">
        {hint?.bar ? <span data-builder-dropbar className="absolute rounded-full bg-primary" style={hint.bar} /> : null}
        {errorIds.map((id) => {
          const r = rects[id];
          const errs: PagePathError[] = props.errors.block[id] ?? [];
          if (!r) return null;
          return (
            <span key={id} className="absolute rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-white" style={{ left: r.left + 8, top: r.top + 8 }} title={errs.map((e) => e.message).join("\n")} data-builder-error={id}>
              {errs.length} lỗi
            </span>
          );
        })}
        {selectedBlock && selectedRect ? (
          <>
            <div onClick={(e) => e.stopPropagation()} className="pointer-events-auto absolute flex -translate-x-full items-center gap-0.5 rounded-lg border bg-background/95 p-0.5 shadow-sm" style={{ left: selectedRect.left + selectedRect.width - 8, top: Math.max(0, selectedRect.top - 14) }}>
              <span className="px-1.5 text-[11px] font-medium text-muted-foreground">{BLOCK_TYPE_LABEL[selectedBlock.type]}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Nhân bản khối" title="Nhân bản" onClick={() => props.onDuplicate(selectedBlock.id)}>
                <Copy />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Xoá khối" title="Xoá (hoàn tác được)" onClick={() => props.onRemove(selectedBlock.id)}>
                <Trash2 />
              </Button>
            </div>
            {!phone && !selectedInColumn ? (
              <button
                type="button"
                draggable={false}
                data-builder-resize={selectedBlock.id}
                aria-label={`Đổi độ rộng (đang ${SPAN_LABEL[snapSpan(resize?.span ?? selectedBlock.span)]}) — kéo, hoặc mũi tên trái / phải`}
                title="Kéo để đổi độ rộng (bắt 1/4 · 1/3 · 1/2 · 2/3 · cả hàng)"
                className="pointer-events-auto absolute flex h-10 w-4 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border bg-background shadow"
                style={{ left: selectedRect.left + selectedRect.width - 6, top: selectedRect.top + selectedRect.height / 2 }}
                onPointerDown={(e) => startResize(e, selectedBlock)}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onDragStart={(e) => e.preventDefault()}
                onKeyDown={(e) => keyResize(e, selectedBlock)}
                onClick={(e) => e.stopPropagation()}
              >
                <MoveHorizontal className="size-3" aria-hidden />
              </button>
            ) : null}
            {resize ? (
              <span className="absolute rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground" style={{ left: Math.max(0, selectedRect.left + selectedRect.width - 90), top: selectedRect.top + selectedRect.height - 26 }}>
                {SPAN_LABEL[resize.span]}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

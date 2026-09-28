import type { DropSlot, LibraryKind } from "@/lib/platform-ui/page-builder-ops";

/**
 * Kéo-thả bằng HTML5 Drag and Drop GỐC của trình duyệt — không thư viện. Trình duyệt không cho đọc
 * `dataTransfer` trong lúc `dragover` (chỉ đọc được lúc `drop`), nên thứ đang kéo nằm ở một ref chung của trình
 * soạn; `dataTransfer` chỉ mang một chuỗi để Firefox chịu bắt đầu kéo.
 */
export type DragPayload = { kind: "new"; item: LibraryKind } | { kind: "block"; id: string } | { kind: "section"; index: number };

/** Vạch báo điểm thả, toạ độ tương đối với gốc khung. */
export type DropBar = { left: number; top: number; width: number; height: number };

/** Điểm thả đang báo trên khung: một vị trí khối, hoặc một vị trí NHÓM (thả nhóm / hàng mới, đổi chỗ nhóm). */
export type DropHint = { kind: "block"; slot: DropSlot; bar: DropBar | null } | { kind: "section"; index: number; bar: DropBar | null };

export const DRAG_MIME = "text/plain";

export function isSectionPayload(p: DragPayload | null): boolean {
  return p !== null && (p.kind === "section" || (p.kind === "new" && (p.item === "section" || p.item === "row")));
}

export function sameHint(a: DropHint | null, b: DropHint | null): boolean {
  if (a === null || b === null) return a === b;
  if (JSON.stringify(a.bar) !== JSON.stringify(b.bar)) return false;
  if (a.kind === "section" || b.kind === "section") return a.kind === b.kind && (a as { index: number }).index === (b as { index: number }).index;
  return a.slot.section === b.slot.section && a.slot.column === b.slot.column && a.slot.index === b.slot.index;
}

/** Nửa trước / nửa sau của một ô theo trục đang xếp (ngang trên lưới máy tính, dọc trên điện thoại / trong cột). */
export function isBefore(e: { clientX: number; clientY: number }, rect: DOMRect, axis: "x" | "y"): boolean {
  return axis === "x" ? e.clientX < rect.left + rect.width / 2 : e.clientY < rect.top + rect.height / 2;
}

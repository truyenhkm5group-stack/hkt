"use client";

import * as React from "react";
import { BarChart3, Columns3, FileText, Filter, FormInput, Hash, History, KanbanSquare, LayoutPanelTop, MousePointerClick, Rows3, Table2, type LucideIcon } from "lucide-react";
import { LIBRARY, libraryRefusal, type LibraryKind } from "@/lib/platform-ui/page-builder-ops";
import type { PageEditorCatalog } from "@/lib/platform-ui/page-admin-shared";
import type { PageSchema } from "@/lib/pages/types";
import { cn } from "@/lib/utils";
import { DRAG_MIME, type DragPayload } from "./dnd";

/**
 * ═══════════ THƯ VIỆN (cột trái) ═══════════
 *
 * Mỗi mục KÉO được vào khung, hoặc BẤM để thêm vào cuối nhóm đang chọn (bàn phím / màn cảm ứng). Mục chưa dùng
 * được thì MỜ và nói vì sao ngay dưới tên — không giấu đi, để người soạn biết thứ đó có tồn tại và thiếu gì.
 */

const ICON: Record<LibraryKind, LucideIcon> = {
  section: LayoutPanelTop,
  row: Rows3,
  column: Columns3,
  kpi: Hash,
  table: Table2,
  form: FormInput,
  kanban: KanbanSquare,
  chart: BarChart3,
  timeline: History,
  filter: Filter,
  button: MousePointerClick,
  text: FileText,
};

export function BuilderLibrary({ schema, catalog, drag, onAdd, onDragEnd }: { schema: PageSchema; catalog: PageEditorCatalog; drag: React.RefObject<DragPayload | null>; onAdd: (kind: LibraryKind) => void; onDragEnd: () => void }) {
  return (
    <nav aria-label="Thư viện khối" className="space-y-1">
      <p className="px-1 pb-1 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Thư viện</p>
      <ul className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
        {LIBRARY.map((item) => {
          const why = libraryRefusal(item, schema, catalog);
          const Icon = ICON[item.kind];
          return (
            <li key={item.kind}>
              <button
                type="button"
                data-library={item.kind}
                draggable={why === null}
                disabled={why !== null}
                title={why ?? item.hint}
                onDragStart={(e) => {
                  drag.current = { kind: "new", item: item.kind };
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData(DRAG_MIME, `new:${item.kind}`);
                }}
                onDragEnd={onDragEnd}
                onClick={() => onAdd(item.kind)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-xl border bg-card px-2.5 py-2 text-left text-sm transition-colors",
                  why === null ? "cursor-grab hover:border-primary/60 hover:bg-primary/5" : "cursor-not-allowed opacity-55",
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium leading-5">{item.label}</span>
                  {why ? <span className="block text-[11px] leading-4 text-muted-foreground">{why}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

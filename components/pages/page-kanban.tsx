"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usePageAction, PREVIEW_ACTION_REASON, type PageActionRunner } from "@/components/pages/page-action-button";
import { formatNumber } from "@/lib/format";
import type { KanbanData } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ KANBAN CỦA TRANG ĐỘNG (Phase 4 · G6) ═══════════
 *
 * Cột = giá trị của MỘT field custom kiểu trạng thái; thẻ đã dựng ở máy chủ. Chuyển cột CHỈ tới đích trong
 * `moveTargets` của thẻ (máy chủ đã tính theo luật chuyển của field) và đi qua `executePageAction` ⇒ action
 * `update_safe_field` ⇒ `saveCustomValues` — máy chủ kiểm lại luật chuyển lần nữa, nên đích lạ gửi tay vẫn bị từ
 * chối. Không kéo-thả: một menu "Chuyển sang…" dùng được bằng bàn phím và trên điện thoại.
 *
 * Khung cột cuộn NGANG bên trong khối (trang không cuộn ngang); dưới `md` cột xếp chồng — cùng khuôn với bảng quy
 * trình mẫu (`app/(dashboard)/models/pipeline-board.tsx`).
 */
export function PageKanban({ blockId, data, run }: { blockId: string; data: KanbanData; run?: PageActionRunner }) {
  const { pending, fire } = usePageAction(run);
  const labelOf = new Map(data.columns.map((c) => [c.value, c.label]));
  const total = data.columns.reduce((n, c) => n + c.cards.length, 0);

  if (data.columns.length === 0) return <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có cột nào — field trạng thái chưa khai giá trị.</p>;

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-3 md:flex-row md:overflow-x-auto md:pb-1">
        {data.columns.map((col) => (
          <section key={col.value} className="flex min-w-0 flex-col rounded-xl bg-muted/40 p-2 md:w-64 md:shrink-0" aria-label={col.label}>
            <header className="flex items-center justify-between gap-2 px-1 pb-2">
              <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
                {col.color ? <span className="size-2 shrink-0 rounded-full" style={{ background: col.color }} aria-hidden /> : null}
                <span className="truncate">{col.label}</span>
              </span>
              <span className="numeric text-xs text-muted-foreground">{formatNumber(col.cards.length)}</span>
            </header>
            <div className="flex max-h-[520px] flex-col gap-2 overflow-y-auto">
              {col.cards.length === 0 ? <p className="px-1 py-3 text-center text-xs text-muted-foreground">Không có thẻ</p> : null}
              {col.cards.map((card) => {
                const canMove = data.allowMove && card.moveTargets.length > 0;
                return (
                  <article key={card.id} className="rounded-lg border bg-card p-2 text-xs shadow-sm" data-kanban-card={card.id}>
                    {card.href ? (
                      <Link href={card.href} className="block truncate font-semibold hover:underline">
                        {card.title}
                      </Link>
                    ) : (
                      <p className="truncate font-semibold">{card.title}</p>
                    )}
                    {card.fields.length > 0 ? (
                      <dl className="mt-1 space-y-0.5 text-muted-foreground">
                        {card.fields.map((f) => (
                          <div key={f.label} className="flex gap-1">
                            <dt className="shrink-0">{f.label}:</dt>
                            <dd className="truncate text-foreground">{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {canMove ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          disabled={pending}
                          title={run ? undefined : PREVIEW_ACTION_REASON}
                          className={cn("mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-primary hover:bg-muted disabled:opacity-50")}
                        >
                          Chuyển sang <ArrowRight className="size-3" aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuLabel className="text-xs">Chỉ các bước luật chuyển cho phép</DropdownMenuLabel>
                          {card.moveTargets.map((t) => (
                            <DropdownMenuItem key={t} onSelect={() => fire(blockId, { recordId: card.id, value: t })}>
                              {labelOf.get(t) ?? t}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {formatNumber(total)} thẻ{data.truncated ? " — đã chạm trần của khối, còn thẻ chưa hiện (thu hẹp bộ lọc để thấy hết)" : ""}
      </p>
    </div>
  );
}

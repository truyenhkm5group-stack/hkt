import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { BlockBoundary } from "@/components/pages/block-boundary";
import { BlockView } from "@/components/pages/block-view";
import type { PageActionRunner } from "@/components/pages/page-action-button";
import type { RenderBlock, RenderSection } from "@/lib/pages/render";
import type { BlockSpan } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ RENDERER DUY NHẤT CỦA TRANG ĐỘNG (Phase 4 · G2, G9) ═══════════
 *
 * MỘT renderer cho mọi trang (đã xuất bản ở `/p/[slug]`, bản nháp ở màn hình xem trước) — không có mã riêng cho
 * trang nào hay tổ chức nào. Lưới 12 cột từ `md`; dưới `md` mọi khối rộng hết (không phá điện thoại).
 *
 * Lưới dựng NGAY từ schema; mỗi khối bọc RÀO LỖI (client) + SUSPENSE riêng chờ phần của nó trong MỘT lượt phân giải
 * song song (`resolvePage`) — người xem thấy bố cục + khung xương từng khối trước khi có số, khối hỏng hiện chỗ giữ
 * an toàn — không khối nào kéo cả trang đổ theo.
 */

/** Lớp tĩnh (Tailwind cần thấy nguyên chuỗi). */
const SPAN_CLASS: Record<BlockSpan, string> = {
  3: "md:col-span-6 xl:col-span-3",
  4: "md:col-span-6 xl:col-span-4",
  6: "md:col-span-6",
  8: "md:col-span-12 xl:col-span-8",
  12: "md:col-span-12",
};

async function ResolvedBlockSlot({ item, diagnose, run }: { item: RenderBlock; diagnose: boolean; run?: PageActionRunner }) {
  const resolved = await item.result;
  return <BlockView resolved={resolved} diagnose={diagnose} run={run} />;
}

function BlockSkeleton({ type }: { type: string }) {
  return <Skeleton className={cn("w-full rounded-2xl", type === "kpi" || type === "button" ? "h-[128px]" : "h-[280px]")} />;
}

export function PageRenderer({ sections, diagnose, run }: { sections: RenderSection[]; diagnose: boolean; run?: PageActionRunner }) {
  if (sections.length === 0) {
    return <p className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">Chưa có khối nào để hiển thị trên trang này.</p>;
  }
  return (
    <div className="space-y-6">
      {sections.map((s) => (
        <section key={s.key} aria-label={s.title ?? undefined} className="space-y-3">
          {s.title ? <h2 className="text-[15px] font-bold tracking-[-0.005em]">{s.title}</h2> : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
            {s.blocks.map((item) => (
              <div key={item.block.id} className={cn("min-w-0", SPAN_CLASS[item.block.span] ?? "md:col-span-12")} data-block={item.block.id} data-block-type={item.block.type}>
                <BlockBoundary blockId={item.block.id} title={item.block.title} diagnose={diagnose}>
                  <Suspense fallback={<BlockSkeleton type={item.block.type} />}>
                    <ResolvedBlockSlot item={item} diagnose={diagnose} run={run} />
                  </Suspense>
                </BlockBoundary>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

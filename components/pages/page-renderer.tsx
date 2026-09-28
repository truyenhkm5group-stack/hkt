import { Suspense, use } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { BlockBoundary } from "@/components/pages/block-boundary";
import { BlockPlaceholder } from "@/components/pages/block-placeholder";
import { BlockView } from "@/components/pages/block-view";
import { EditableBlockFrame } from "@/components/pages/editable-block-frame";
import type { PageActionRunner } from "@/components/pages/page-action-button";
import type { RenderBlock, RenderSection } from "@/lib/pages/render";
import type { BlockSpan, ResolvedBlock } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ RENDERER DUY NHẤT CỦA TRANG ĐỘNG (Phase 4 · G2, G9 + Phase 5) ═══════════
 *
 * MỘT renderer cho mọi trang (đã xuất bản ở `/p/[slug]`, bản nháp ở màn hình xem trước, khung giữa của trình
 * kéo-thả) — không có mã riêng cho trang nào hay tổ chức nào. Lưới 12 cột từ `md`; dưới `md` mọi khối rộng hết
 * (không phá điện thoại).
 *
 * Lưới dựng NGAY từ schema; mỗi khối bọc RÀO LỖI (client) + SUSPENSE riêng chờ phần của nó trong MỘT lượt phân giải
 * song song (`resolvePage`) — người xem thấy bố cục + khung xương từng khối trước khi có số, khối hỏng hiện chỗ giữ
 * an toàn — không khối nào kéo cả trang đổ theo. Khối con của CỘT cũng mỗi con một rào lỗi + Suspense.
 *
 * Section `card` (mặc định, như Phase 4) = NHÓM có tiêu đề; `plain` = HÀNG không tiêu đề.
 *
 * `mode="edit"` (trình kéo-thả): mỗi khối bọc khung chọn (`data-block-id`, viền khi `selectedId`, báo
 * `onSelectBlock`) — renderer KHÔNG chứa logic kéo-thả. Không `async`: kết quả khối là Promise (trang máy chủ) hoặc
 * giá trị sẵn (trình soạn), đọc bằng `use`, nên cùng một component chạy được ở cả máy chủ lẫn trình duyệt.
 */

/** Lớp tĩnh (Tailwind cần thấy nguyên chuỗi). */
const SPAN_CLASS: Record<BlockSpan, string> = {
  3: "md:col-span-6 xl:col-span-3",
  4: "md:col-span-6 xl:col-span-4",
  6: "md:col-span-6",
  8: "md:col-span-12 xl:col-span-8",
  12: "md:col-span-12",
};

export type PageRendererMode = "view" | "edit";

export type PageRendererProps = {
  sections: RenderSection[];
  diagnose: boolean;
  run?: PageActionRunner;
  mode?: PageRendererMode;
  selectedId?: string | null;
  onSelectBlock?: (blockId: string) => void;
};

type SlotProps = { item: RenderBlock; diagnose: boolean; run?: PageActionRunner };

function isPromise(x: RenderBlock["result"]): x is Promise<ResolvedBlock> {
  return typeof (x as Promise<ResolvedBlock>)?.then === "function";
}

function useResolved(item: RenderBlock): ResolvedBlock {
  return isPromise(item.result) ? use(item.result) : item.result;
}

function ResolvedBlockSlot({ item, diagnose, run }: SlotProps) {
  return <BlockView resolved={useResolved(item)} diagnose={diagnose} run={run} />;
}

function BlockSkeleton({ type }: { type: string }) {
  return <Skeleton className={cn("w-full rounded-2xl", type === "kpi" || type === "button" || type === "filter" ? "h-[128px]" : "h-[280px]")} />;
}

type FrameProps = { mode: PageRendererMode; selectedId?: string | null; onSelectBlock?: (blockId: string) => void };

function Framed({ item, frame, className, children }: { item: RenderBlock; frame: FrameProps; className?: string; children: React.ReactNode }) {
  if (frame.mode !== "edit") return <>{children}</>;
  return (
    <EditableBlockFrame blockId={item.block.id} label={item.block.title ?? item.block.id} selected={frame.selectedId === item.block.id} onSelect={frame.onSelectBlock} className={className}>
      {children}
    </EditableBlockFrame>
  );
}

function Guarded({ item, diagnose, run }: SlotProps) {
  return (
    <BlockBoundary blockId={item.block.id} title={item.block.title} diagnose={diagnose}>
      <Suspense fallback={<BlockSkeleton type={item.block.type} />}>
        <ResolvedBlockSlot item={item} diagnose={diagnose} run={run} />
      </Suspense>
    </BlockBoundary>
  );
}

/** Cột: kết quả của CHÍNH cột (vượt trần / cấu hình hỏng ⇒ chỗ giữ), rồi từng khối con với rào lỗi + Suspense riêng. */
function ColumnGate({ item, diagnose, run, frame }: SlotProps & { frame: FrameProps }) {
  const own = useResolved(item);
  if (!own.ok) return <BlockPlaceholder title={item.block.title} issue={own.issue} diagnose={diagnose} />;
  return (
    <div className="flex h-full flex-col gap-4">
      {(item.children ?? []).map((child) => (
        <div key={child.block.id} className="min-w-0" data-block={child.block.id} data-block-type={child.block.type}>
          <Framed item={child} frame={frame}>
            <Guarded item={child} diagnose={diagnose} run={run} />
          </Framed>
        </div>
      ))}
    </div>
  );
}

function Cell({ item, diagnose, run, frame }: SlotProps & { frame: FrameProps }) {
  // Cột có danh sách khối con để vẽ riêng ⇒ mỗi con một Suspense; không có (kết quả sẵn của trình soạn) ⇒ BlockView tự xếp.
  const body =
    item.block.type === "column" && item.children ? (
      <BlockBoundary blockId={item.block.id} title={item.block.title} diagnose={diagnose}>
        <Suspense fallback={<BlockSkeleton type="column" />}>
          <ColumnGate item={item} diagnose={diagnose} run={run} frame={frame} />
        </Suspense>
      </BlockBoundary>
    ) : (
      <Guarded item={item} diagnose={diagnose} run={run} />
    );
  return (
    <div className={cn("min-w-0", SPAN_CLASS[item.block.span] ?? "md:col-span-12")} data-block={item.block.id} data-block-type={item.block.type}>
      <Framed item={item} frame={frame} className="h-full">
        {body}
      </Framed>
    </div>
  );
}

export function PageRenderer({ sections, diagnose, run, mode = "view", selectedId, onSelectBlock }: PageRendererProps) {
  if (sections.length === 0) {
    return <p className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">Chưa có khối nào để hiển thị trên trang này.</p>;
  }
  const frame: FrameProps = { mode, selectedId, onSelectBlock };
  return (
    <div className="space-y-6">
      {sections.map((s) => {
        const plain = s.variant === "plain";
        return (
          <section key={s.key} aria-label={!plain ? (s.title ?? undefined) : undefined} className={plain ? "space-y-0" : "space-y-3"} data-section={s.key} data-section-variant={plain ? "plain" : "card"}>
            {!plain && s.title ? <h2 className="text-[15px] font-bold tracking-[-0.005em]">{s.title}</h2> : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
              {s.blocks.map((item) => (
                <Cell key={item.block.id} item={item} diagnose={diagnose} run={run} frame={frame} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

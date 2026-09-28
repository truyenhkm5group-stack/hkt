import { GenericChart } from "@/components/charts/generic-chart";
import { EntityTimeline } from "@/components/entity-timeline";
import { MetricCard } from "@/components/metric-card";
import { BlockPlaceholder } from "@/components/pages/block-placeholder";
import { PageActionButton, type PageActionRunner } from "@/components/pages/page-action-button";
import { PageFilterBar } from "@/components/pages/page-filter-bar";
import { PageForm } from "@/components/pages/page-form";
import { PageKanban } from "@/components/pages/page-kanban";
import { PageTable } from "@/components/pages/page-table";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { BlockDataByType, BlockType, ResolvedBlock, ValueFormat } from "@/lib/pages/types";

/**
 * ═══════════ MỘT COMPONENT CHO MỖI LOẠI KHỐI (Phase 4 · G3 + Phase 5) ═══════════
 *
 * Nhận khối ĐÃ PHÂN GIẢI và chọn đúng component vẽ. Không đọc CSDL, không gọi trình phân giải — dữ liệu đã có
 * sẵn. Không `async`, không import chỉ-máy-chủ: trang máy chủ (`/p/[slug]`) và trình kéo-thả (client) dùng CHUNG.
 * Thứ đi xuống client chỉ là dữ liệu thuần + tham chiếu server action (`run`).
 *
 * Số liệu: CHƯA BIẾT (`null`) in «—» qua `lib/format` (luật 42). Thẻ chỉ số KHÔNG tô màu đạt / không đạt: trang
 * tuỳ biến không có đích (luật 38, 44) — `goodWhen: "neutral"`.
 */

export function formatKpi(value: number | null, format: ValueFormat): string {
  if (format === "vnd") return formatVND(value);
  if (format === "percent") return formatPercent(value);
  return formatNumber(value);
}

function TextBlock({ d }: { d: BlockDataByType["text"] }) {
  if (d.variant === "heading") {
    return (
      <div className="flex h-full flex-col justify-end gap-1 px-1">
        {d.heading ? <h2 className="text-lg font-bold tracking-[-0.01em]">{d.heading}</h2> : null}
        {d.body ? <p className="whitespace-pre-line text-sm text-muted-foreground">{d.body}</p> : null}
      </div>
    );
  }
  if (d.variant === "paragraph") {
    return (
      <div className="h-full px-1">
        {d.heading ? <h3 className="text-[14px] font-semibold">{d.heading}</h3> : null}
        {d.body ? <p className="mt-1 whitespace-pre-line text-sm leading-6">{d.body}</p> : null}
      </div>
    );
  }
  if (d.variant === "note") {
    return (
      <div role="note" className="h-full rounded-xl border-l-4 border-primary/40 bg-muted/50 px-4 py-3 text-sm">
        {d.heading ? <p className="font-semibold">{d.heading}</p> : null}
        {d.body ? <p className="mt-0.5 whitespace-pre-line text-muted-foreground">{d.body}</p> : null}
      </div>
    );
  }
  return (
    <div className="h-full rounded-2xl bg-card p-5 text-card-foreground shadow-[var(--shadow-card)]">
      {d.heading ? <h2 className="text-[15px] font-bold tracking-[-0.005em]">{d.heading}</h2> : null}
      {d.body ? <p className="mt-1.5 whitespace-pre-line text-sm leading-6 text-muted-foreground">{d.body}</p> : null}
    </div>
  );
}

export function BlockView({ resolved, diagnose, run }: { resolved: ResolvedBlock; diagnose: boolean; run?: PageActionRunner }) {
  const { block } = resolved;
  if (!resolved.ok) return <BlockPlaceholder title={block.title} issue={resolved.issue} diagnose={diagnose} />;
  const type = block.type as BlockType;

  if (type === "kpi") {
    const d = resolved.data as BlockDataByType["kpi"];
    return <MetricCard label={block.title ?? d.label} value={formatKpi(d.value, d.format)} note={d.note} href={d.href} goodWhen="neutral" />;
  }
  if (type === "text") return <TextBlock d={resolved.data as BlockDataByType["text"]} />;
  if (type === "button") {
    const d = resolved.data as BlockDataByType["button"];
    return (
      <SectionCard title={block.title} className="h-full">
        <PageActionButton blockId={block.id} data={d} run={run} />
      </SectionCard>
    );
  }
  if (type === "filter") return <PageFilterBar data={resolved.data as BlockDataByType["filter"]} />;
  if (type === "column") {
    // Cột đã phân giải sẵn (trình kéo-thả vẽ lại kết quả xem trước): con xếp dọc, mỗi con một kết quả riêng.
    const d = resolved.data as BlockDataByType["column"];
    return (
      <div className="flex h-full flex-col gap-4">
        {(d.children ?? []).map((c) => (
          <BlockView key={c.block.id} resolved={c} diagnose={diagnose} run={run} />
        ))}
      </div>
    );
  }

  let body: React.ReactNode;
  if (type === "table") body = <PageTable blockId={block.id} data={resolved.data as BlockDataByType["table"]} run={run} />;
  else if (type === "chart") {
    const d = resolved.data as BlockDataByType["chart"];
    body = <GenericChart kind={d.kind} format={d.format} points={d.points} label={block.title} note={d.note} />;
  } else if (type === "kanban") body = <PageKanban blockId={block.id} data={resolved.data as BlockDataByType["kanban"]} run={run} />;
  else if (type === "timeline") {
    const d = resolved.data as BlockDataByType["timeline"];
    body = <EntityTimeline entries={d.entries} emptyText="Chưa có mốc nào cho bản ghi này." />;
  } else if (type === "form") body = <PageForm data={resolved.data as BlockDataByType["form"]} />;
  else body = <BlockPlaceholder issue={{ code: "INVALID_CONFIG", blockId: block.id, message: `loại khối «${String(type)}» không có renderer` }} diagnose={diagnose} />;

  return (
    <SectionCard title={block.title} className="h-full">
      {body}
    </SectionCard>
  );
}

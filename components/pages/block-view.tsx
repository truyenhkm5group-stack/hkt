import { GenericChart } from "@/components/charts/generic-chart";
import { EntityTimeline } from "@/components/entity-timeline";
import { MetricCard } from "@/components/metric-card";
import { BlockPlaceholder } from "@/components/pages/block-placeholder";
import { PageActionButton, type PageActionRunner } from "@/components/pages/page-action-button";
import { PageForm } from "@/components/pages/page-form";
import { PageKanban } from "@/components/pages/page-kanban";
import { PageTable } from "@/components/pages/page-table";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { BlockDataByType, BlockType, ResolvedBlock, ValueFormat } from "@/lib/pages/types";

/**
 * ═══════════ MỘT COMPONENT CHO MỖI LOẠI KHỐI (Phase 4 · G3) ═══════════
 *
 * Server Component: nhận khối ĐÃ PHÂN GIẢI và chọn đúng component vẽ. Không đọc CSDL, không gọi trình phân giải —
 * dữ liệu đã có sẵn. Thứ đi xuống client chỉ là dữ liệu thuần + tham chiếu server action (`run`).
 *
 * Số liệu: CHƯA BIẾT (`null`) in «—» qua `lib/format` (luật 42). Thẻ chỉ số KHÔNG tô màu đạt / không đạt: trang
 * tuỳ biến không có đích (luật 38, 44) — `goodWhen: "neutral"`.
 */

export function formatKpi(value: number | null, format: ValueFormat): string {
  if (format === "vnd") return formatVND(value);
  if (format === "percent") return formatPercent(value);
  return formatNumber(value);
}

export function BlockView({ resolved, diagnose, run }: { resolved: ResolvedBlock; diagnose: boolean; run?: PageActionRunner }) {
  const { block } = resolved;
  if (!resolved.ok) return <BlockPlaceholder title={block.title} issue={resolved.issue} diagnose={diagnose} />;
  const type = block.type as BlockType;

  if (type === "kpi") {
    const d = resolved.data as BlockDataByType["kpi"];
    return <MetricCard label={block.title ?? d.label} value={formatKpi(d.value, d.format)} note={d.note} href={d.href} goodWhen="neutral" />;
  }
  if (type === "text") {
    const d = resolved.data as BlockDataByType["text"];
    return (
      <div className="h-full rounded-2xl bg-card p-5 text-card-foreground shadow-[var(--shadow-card)]">
        {d.heading ? <h2 className="text-[15px] font-bold tracking-[-0.005em]">{d.heading}</h2> : null}
        {d.body ? <p className="mt-1.5 whitespace-pre-line text-sm leading-6 text-muted-foreground">{d.body}</p> : null}
      </div>
    );
  }
  if (type === "button") {
    const d = resolved.data as BlockDataByType["button"];
    return (
      <SectionCard title={block.title} className="h-full">
        <PageActionButton blockId={block.id} data={d} run={run} />
      </SectionCard>
    );
  }

  let body: React.ReactNode;
  if (type === "table") body = <PageTable blockId={block.id} data={resolved.data as BlockDataByType["table"]} />;
  else if (type === "chart") {
    const d = resolved.data as BlockDataByType["chart"];
    body = <GenericChart kind={d.kind} format={d.format} points={d.points} label={block.title} />;
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

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ModelStateBadge } from "@/app/(dashboard)/models/state-badge";
import { InfoHint } from "@/components/info-hint";
import { MODEL_SIGNAL_LABEL, MODEL_SIGNAL_TONE } from "@/lib/constants/model-signal";
import {
  daysInState,
  groupPipelineCards,
  modelHref,
  PIPELINE_COLUMN_BY_KEY,
  PIPELINE_COLUMNS,
  pipelineColumnCounts,
  type PipelineCard,
  type PipelineChipTone,
  type PipelineColumn,
} from "@/lib/constants/model-pipeline";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BẢNG QUY TRÌNH MẪU — KHUNG VẼ (Company OS · Agent BD) ═══════════
 *
 * Server Component thuần vẽ: nhận thẻ đã dựng (`lib/queries/model-pipeline.ts`), không đọc CSDL, không hàm
 * nào đi qua ranh giới client. Cột cuộn NGANG BÊN TRONG khung bảng (trang không cuộn ngang); mỗi cột cuộn dọc
 * riêng. Dưới `md` các cột xếp chồng thành từng khối. Cột "Dừng" thu gọn bằng `<details>` (không cần JS).
 * Chữ giải thích nằm trong ⓘ / tooltip — màn hình chỉ có mã, số ngày, nhãn và MỘT nút việc tiếp theo.
 */

const CHIP_TONE: Record<PipelineChipTone, string> = {
  danger: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  info: "bg-sky-50 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
};

function daysText(c: PipelineCard, now: Date): string {
  const d = daysInState(c.since, now);
  if (d === null) return "— ngày";
  return c.sinceIsRegistered ? `vào sổ ${formatNumber(d)} ngày` : `${formatNumber(d)} ngày ở bước này`;
}

function Card({ c, now }: { c: PipelineCard; now: Date }) {
  // Cột gộp nhiều trạng thái khai ⇒ in trạng thái của chính mẫu, để "Làm mẫu" và "Tính giá thành" không trông như một.
  const stateBadge = c.state !== null && PIPELINE_COLUMN_BY_KEY[c.column].states.length > 1;
  return (
    <article className="rounded-lg border bg-card p-2 text-xs shadow-sm" data-model-card={c.code}>
      <div className="flex gap-2">
        {c.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.image} alt="" className="size-9 shrink-0 rounded-md border object-cover" />
        ) : (
          <div className="size-9 shrink-0 rounded-md border border-dashed bg-muted/40" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <Link href={modelHref(c.modelId)} className="block truncate font-mono text-[12px] font-semibold hover:underline" title={`Mở mẫu ${c.code}`}>
            {c.code}
          </Link>
          <p className="truncate text-muted-foreground" title={c.name}>
            {c.name || "—"}
          </p>
        </div>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={c.ownerName ? `Phụ trách: ${c.ownerName}` : "Chưa giao người phụ trách"}>
        {daysText(c, now)} · {c.ownerName ?? "chưa giao"}
      </p>
      {/* Tín hiệu (S) · trạng thái khai (cột gộp) · tối đa hai nhãn máy suy ra — một hàng, gãy dòng được. */}
      {c.signal || stateBadge || c.chips.length ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {c.signal ? (
            <span className={cn("max-w-full truncate rounded px-1.5 py-px text-[10px] font-medium", MODEL_SIGNAL_TONE[c.signal])} title="Tín hiệu mẫu 30 ngày qua">
              {MODEL_SIGNAL_LABEL[c.signal]}
            </span>
          ) : null}
          {stateBadge ? <ModelStateBadge state={c.state} className="px-1.5 py-px text-[10px]" /> : null}
          {c.chips.map((ch) => (
            <span key={ch.kind} title={ch.title} className={cn("max-w-full truncate rounded px-1.5 py-px text-[10px] font-semibold", CHIP_TONE[ch.tone])}>
              {ch.text}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-end gap-2">
        {c.next ? (
          <Link
            href={c.next.href}
            title={c.next.why}
            data-next-action={c.next.source}
            className="line-clamp-2 min-w-0 flex-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-semibold leading-snug text-primary hover:bg-primary/15"
          >
            <ArrowRight className="mr-0.5 inline size-3" />
            {c.next.label}
          </Link>
        ) : (
          <span className="flex-1" />
        )}
        <Link href={modelHref(c.modelId)} className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Mở mẫu
        </Link>
      </div>
    </article>
  );
}

function ColumnHeader({ col, total, actionable }: { col: PipelineColumn; total: number; actionable: number }) {
  return (
    <header className="flex items-center gap-1.5 border-b px-2.5 py-2">
      <h3 className="min-w-0 truncate text-[12.5px] font-bold" title={col.label}>
        {col.label}
      </h3>
      <InfoHint label={`Cột ${col.label}`}>
        {col.steps.length ? <b>Bước {col.steps.join(", ")} · </b> : null}
        {col.hint}
      </InfoHint>
      <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[11px] font-bold tabular-nums" title={`${formatNumber(total)} mẫu · ${formatNumber(actionable)} có việc tiếp theo`}>
        {formatNumber(total)}
      </span>
    </header>
  );
}

export function PipelineBoard({ cards, now, declareHref }: { cards: readonly PipelineCard[]; now: Date; declareHref: string | null }) {
  const groups = groupPipelineCards(cards);
  const counts = pipelineColumnCounts(cards);
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:overflow-x-auto md:pb-2" data-pipeline-board>
      {PIPELINE_COLUMNS.map((col) => {
        const list = groups[col.key];
        const n = counts[col.key];
        const body = list.length ? (
          <div className="space-y-2 p-2 md:max-h-[calc(100vh-18rem)] md:overflow-y-auto">
            {list.map((c) => (
              <Card key={c.modelId} c={c} now={now} />
            ))}
          </div>
        ) : (
          <p className="px-2.5 py-3 text-[11px] text-muted-foreground">Không có mẫu nào ở bước này.</p>
        );
        return (
          <section
            key={col.key}
            data-column={col.key}
            className={cn("w-full shrink-0 rounded-xl border bg-muted/30", list.length ? "md:w-[208px]" : "md:w-[136px]")}
            aria-label={`${col.label}: ${n.total} mẫu`}
          >
            {col.collapsed ? (
              <details>
                <summary className="cursor-pointer list-none">
                  <ColumnHeader col={col} total={n.total} actionable={n.actionable} />
                </summary>
                {body}
              </details>
            ) : (
              <>
                <ColumnHeader col={col} total={n.total} actionable={n.actionable} />
                {/* Cột Chưa khai: khai cả lô theo gợi ý (Q) — chỉ người khai được. */}
                {col.key === "UNDECLARED" && declareHref && n.total > 0 ? (
                  <div className="border-b px-2.5 py-1">
                    <Link href={declareHref} className="text-[11px] font-semibold text-primary hover:underline">
                      Khai theo gợi ý cho cả lô
                    </Link>
                  </div>
                ) : null}
                {body}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

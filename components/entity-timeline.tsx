import { DIMENSION_LABEL, DIMENSION_TONE, WEIGHT_LABEL, sourceWeight, type TimelineDimension } from "@/lib/constants/timeline";
import { formatDateTime, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<string, string> = {
  PANCAKE: "Pancake",
  VTP_WEBHOOK: "VTP webhook",
  VTP_POLL: "VTP tra cứu",
  VTP_IMPORT: "VTP nhập tệp",
  VTP_UI_MANUAL_VERIFICATION: "Chủ shop chép tay từ web VTP",
  MANUAL: "Thủ công",
  ERP: "ERP",
};

/**
 * DÒNG THỜI GIAN TRUY VẾT ĐƯỢC.
 *
 * Mỗi mốc mang theo CHIỀU (đơn · giao vận · tiền · kho · người dùng) và NGUỒN, kèm nhãn nói rõ
 * nguồn đó có sức nặng gì: "quyết định kết quả đơn" hay "chỉ là bối cảnh".
 *
 * Vì sao nhãn sức nặng là bắt buộc: cùng một câu "đã giao", Viettel Post nói thì quyết định kết
 * quả đơn, Pancake nói thì không quyết định gì. Trộn chung mà không ghi nguồn sẽ khiến người đọc
 * kết luận sai — đúng loại sai lầm mà toàn bộ lớp Data Truth sinh ra để chống.
 */
/**
 * Một mốc. `TimelineEntry` của `lib/queries/entity-timeline.ts` khớp nguyên hình này; khối dòng thời gian của
 * trang động (Phase 4) truyền mốc KHÔNG có chiều / số tiền — thiếu thì không in nhãn chiều, KHÔNG đoán chiều
 * từ nguồn (một nhãn "Người dùng" gắn nhầm còn tệ hơn không có nhãn).
 */
export type EntityTimelineEntry = { id: string; at: Date | string; dimension?: TimelineDimension; source?: string; title: string; detail?: string; amount?: number | null };

export function EntityTimeline({ entries, limit = 40, emptyText = "Chưa có mốc nào được ghi nhận cho đơn này." }: { entries: EntityTimelineEntry[]; limit?: number; emptyText?: string }) {
  if (!entries.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  const shown = entries.slice(0, limit);

  return (
    <ol className="relative space-y-0 border-l pl-4">
      {shown.map((e, i) => {
        const weight = e.source ? sourceWeight(e.source) : null;
        return (
          <li key={e.id} className="relative pb-4 last:pb-0">
            <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-background", i === 0 ? "bg-primary" : "bg-muted-foreground/50")} />
            <div className="flex flex-wrap items-baseline gap-x-2">
              {e.dimension ? <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", DIMENSION_TONE[e.dimension])}>{DIMENSION_LABEL[e.dimension]}</span> : null}
              <span className={cn("text-sm font-semibold", i === 0 && "text-primary")}>{e.title}</span>
              {typeof e.amount === "number" ? <span className="text-sm tabular-nums">{formatVND(e.amount)}</span> : null}
              <span className="text-xs text-muted-foreground">{formatDateTime(e.at)}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {e.detail}
              {e.source && weight ? (
                <span className="ml-1.5 rounded bg-muted px-1 text-[10px]" title={`Nguồn này ${WEIGHT_LABEL[weight]}`}>
                  {SOURCE_LABEL[e.source] ?? e.source}
                  {weight === "DECIDES" ? " · quyết định kết quả đơn" : weight === "CONTEXT" ? " · chỉ là bối cảnh" : ""}
                </span>
              ) : null}
            </p>
          </li>
        );
      })}
      {entries.length > limit ? <li className="text-xs text-muted-foreground">… và {entries.length - limit} mốc cũ hơn</li> : null}
    </ol>
  );
}

import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type EventRow = { id: string; source: string; status: string; statusName: string; location: string; note: string; occurredAt: Date };

const SOURCE_LABEL: Record<string, string> = { PANCAKE: "Pancake", VTP_WEBHOOK: "VTP webhook", VTP_POLL: "VTP tra cứu", VTP_IMPORT: "VTP nhập", MANUAL: "Thủ công" };

export function ShipmentTimeline({ events, className, limit = 12 }: { events: EventRow[]; className?: string; limit?: number }) {
  if (!events.length) return <p className={cn("text-sm text-muted-foreground", className)}>Chưa có hành trình. Hành trình sẽ cập nhật qua webhook Viettel Post hoặc khi tra cứu.</p>;
  const sorted = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, limit);
  return (
    <ol className={cn("relative space-y-0 border-l pl-4", className)}>
      {sorted.map((e, i) => (
        <li key={e.id} className="relative pb-4 last:pb-0">
          <span className={cn("absolute -left-[21px] top-1 size-2.5 rounded-full border-2 border-background", i === 0 ? "bg-primary" : "bg-muted-foreground/50")} />
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className={cn("font-semibold", i === 0 && "text-primary")}>{e.statusName || e.status}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(e.occurredAt)}</span>
            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{SOURCE_LABEL[e.source] ?? e.source}</span>
          </div>
          {e.location || e.note ? <p className="mt-0.5 text-xs text-muted-foreground">{[e.location, e.note].filter(Boolean).join(" · ")}</p> : null}
        </li>
      ))}
      {events.length > limit ? <li className="text-xs text-muted-foreground">… và {events.length - limit} sự kiện cũ hơn</li> : null}
    </ol>
  );
}

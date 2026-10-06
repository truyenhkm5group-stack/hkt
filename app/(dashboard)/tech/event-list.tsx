import { TECH_ACTOR_KIND_LABEL, type TechActorKind } from "@/lib/constants/tech";
import { TECH_EVENT_LABEL, type TechEventName } from "@/lib/constants/tech-control-plane";
import { formatDateTime } from "@/lib/format";
import type { TechEventRow } from "@/db/schema";

/** Dòng thời gian của `tech_events` — chỉ thêm, không sửa. Tên chưa có nhãn in nguyên tên, không giấu. */
export function TechEventList({ events }: { events: TechEventRow[] }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">Chưa có sự kiện nào.</p>;
  return (
    <ol className="space-y-2.5">
      {events.map((e) => {
        const p = e.payload as { from?: string; to?: string; note?: string; taskCode?: string };
        return (
          <li key={e.id} className="border-l-2 border-hairline pl-3 text-sm">
            <p className="font-semibold">
              {TECH_EVENT_LABEL[e.name as TechEventName] ?? e.name}
              {p.from && p.to ? <span className="font-normal text-muted-foreground"> · {p.from} → {p.to}</span> : null}
              {p.taskCode ? <span className="font-normal text-muted-foreground"> · {p.taskCode}</span> : null}
            </p>
            {p.note ? <p className="text-xs text-muted-foreground">{p.note}</p> : null}
            <p className="text-[11px] text-muted-foreground">
              {formatDateTime(e.occurredAt)} · {TECH_ACTOR_KIND_LABEL[e.actorKind as TechActorKind] ?? e.actorKind} · {e.actorName || "—"}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

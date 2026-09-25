import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { datumText, impactText, OWNER_DECISION_KIND_SPEC, type DecoratedItem, type KindGroup } from "@/lib/constants/owner-decisions";
import type { FailedSource } from "@/lib/queries/owner-decisions";
import { formatDate } from "@/lib/format";
import { DecisionControls } from "./decision-controls";

/**
 * Một dòng đề xuất: CÁI GÌ · VÌ SAO (một dòng, đầy đủ ở ⓘ) · 1–3 ô SỐ LIỆU · TÁC ĐỘNG · NÚT sang màn hình
 * chủ · ba nút phản ứng. Không có nút "xong": việc đóng ở màn hình chủ (luật 19).
 */
export function DecisionItemRow({ item, from, maxData = 3 }: { item: DecoratedItem; from: "home" | "cockpit"; maxData?: number }) {
  const accepted = item.latest?.decision === "ACCEPTED";
  return (
    <div className="flex flex-col gap-2 px-5 py-3 lg:flex-row lg:items-center" data-decision-key={item.sourceKey}>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="truncate">{item.what}</span>
          {accepted ? (
            <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
              Đã chấp nhận · {item.latest?.decidedBy || "—"} {formatDate(item.latest?.decidedAt)}
            </span>
          ) : null}
        </p>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">{item.why}</span>
          <InfoHint>
            <p>{item.why}</p>
            <p className="mt-1.5">Tác động: {item.impact.basis}</p>
          </InfoHint>
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {item.data.slice(0, maxData).map((d) => (
            <span key={d.label} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px]">
              <span className="text-muted-foreground">{d.label}</span> <span className="font-semibold tabular-nums">{datumText(d.value)}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 lg:flex-nowrap">
        <div className="w-24 text-right" title={item.impact.basis}>
          <p className="text-[10px] text-muted-foreground">Tác động</p>
          <p className="text-sm font-bold tabular-nums">{impactText(item.impact.amountVnd)}</p>
        </div>
        <Button asChild size="sm" variant="outline" className="h-7 text-xs">
          <Link href={item.action.href}>
            {item.action.label} <ArrowRight className="size-3" />
          </Link>
        </Button>
        <DecisionControls kind={item.kind} sourceKey={item.sourceKey} accepted={accepted} from={from} />
      </div>
    </div>
  );
}

/** Nhóm theo loại: tiêu đề + số đếm + tối đa `limit` dòng (trang chủ 3, trang /cockpit tất cả). */
export function KindGroupBlock({ group, limit, from }: { group: KindGroup; limit: number | null; from: "home" | "cockpit" }) {
  const shown = limit === null ? group.items : group.items.slice(0, limit);
  return (
    <div className="border-b last:border-b-0" data-decision-kind={group.kind}>
      <div className="flex items-center justify-between gap-2 bg-muted/40 px-5 py-1.5">
        <div className="flex items-center gap-1.5 text-xs font-bold">
          {group.label}
          <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums">{group.count}</span>
          <InfoHint>{OWNER_DECISION_KIND_SPEC[group.kind].hint}</InfoHint>
        </div>
        {limit !== null && group.count > limit ? (
          <Link href={`/cockpit?kind=${group.kind}`} className="text-[11px] font-semibold text-primary hover:underline">
            Xem cả {group.count}
          </Link>
        ) : null}
      </div>
      <div className="divide-y">
        {shown.map((it) => (
          <DecisionItemRow key={it.sourceKey} item={it} from={from} maxData={from === "home" ? 3 : 4} />
        ))}
      </div>
    </div>
  );
}

/** Nguồn chưa đọc được + ghi chú của nguồn — nói ra, không để khối trông như đã đủ. */
export function SourceWarnings({ failed, notes }: { failed: FailedSource[]; notes: string[] }) {
  if (!failed.length && !notes.length) return null;
  return (
    <div className="space-y-0.5 border-t px-5 py-2 text-[11px] text-amber-700 dark:text-amber-400" data-decision-warnings>
      {failed.length ? (
        <div className="flex items-center gap-1">
          Chưa đọc được: {failed.map((f) => f.label).join(" · ")}
          <InfoHint>
            {failed.map((f) => (
              <p key={f.source}>
                {f.label}: {f.error}
              </p>
            ))}
          </InfoHint>
        </div>
      ) : null}
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

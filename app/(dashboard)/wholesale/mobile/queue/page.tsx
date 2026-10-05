import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource } from "@/lib/auth/scope-guard";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { isMobileChip, MOBILE_CHIPS, mobileQueue } from "@/lib/queries/wholesale-mobile";
import type { SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { GradeBadge } from "@/app/(dashboard)/wholesale/leads/leads-table";

export const metadata = { title: "Danh sách gọi" };

const RANK_TAG: Record<number, { text: string; cls: string } | undefined> = {
  0: { text: "Quá hẹn gọi lại", cls: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200" },
  1: { text: "Gọi lại hôm nay", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  2: { text: "Đang quan tâm", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
};

/** Hàng đợi gọi trên điện thoại: chip lọc một chạm, ô tìm, thẻ khách xếp theo thứ tự nên gọi (xem `mobileQueue`). */
export default async function WholesaleMobileQueue({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { decision } = await requireResource("WHOLESALE_LEADS", "wholesale:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Danh sách gọi" reason={decision.reason} fix={decision.fix} />;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const chip = isMobileChip(one(sp.f)) ? (one(sp.f) as (typeof MOBILE_CHIPS)[number]["key"]) : "call";
  const q = one(sp.q).slice(0, 80);
  const rows = await mobileQueue(decision, chip, q);
  const qs = (extra: Record<string, string>) => new URLSearchParams({ f: chip, ...(q ? { q } : {}), ...extra }).toString();
  return (
    <div className="mx-auto max-w-md space-y-3 pb-24">
      <Link href="/wholesale/mobile" className="text-sm text-muted-foreground">
        ← Hôm nay
      </Link>
      <PageHeader title="Danh sách gọi" description={`${rows.length >= 60 ? "60+" : rows.length} khách · ${MOBILE_CHIPS.find((c) => c.key === chip)?.label ?? ""}`} />
      <form action="/wholesale/mobile/queue" className="flex gap-2">
        <input type="hidden" name="f" value={chip} />
        <input name="q" defaultValue={q} placeholder="Tìm tên, SĐT, khu vực…" className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-base" inputMode="search" />
        <button className="h-11 rounded-xl border px-4 text-sm font-medium">Tìm</button>
      </form>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {MOBILE_CHIPS.map((c) => (
          <Link key={c.key} href={`/wholesale/mobile/queue?${new URLSearchParams({ f: c.key, ...(q ? { q } : {}) })}`} className={cn("shrink-0 rounded-full border px-3 py-1.5 text-sm", c.key === chip ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>
            {c.label}
          </Link>
        ))}
      </div>
      {one(sp.het) ? <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">Hết khách cần gọi trong mục này 🎉 Chọn mục khác ở trên.</p> : null}
      {rows.length === 0 && !one(sp.het) ? <p className="py-10 text-center text-sm text-muted-foreground">Không có khách nào trong mục này.</p> : null}
      <ul className="space-y-2">
        {rows.map((r) => {
          const tag = RANK_TAG[r.rank];
          return (
            <li key={r.id}>
              <Link href={`/wholesale/mobile/lead/${r.id}?${qs({})}`} className="block rounded-xl border bg-card p-3 active:bg-muted">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold">{r.name ?? "(chưa có tên)"}</div>
                    <div className="truncate text-sm text-muted-foreground">
                      {r.segmentLabel}
                      {r.area ? ` · ${r.area}` : ""}
                    </div>
                  </div>
                  <GradeBadge grade={r.grade} score={r.score} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-medium tabular-nums">{r.phoneDisplay ?? "—"}</span>
                  <span className="text-muted-foreground">· {r.statusLabel}</span>
                  {tag ? <span className={cn("rounded px-1.5 py-0.5 text-xs", tag.cls)}>{tag.text}</span> : null}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {r.lastContactAt ? `Liên hệ ${formatTimeAgo(r.lastContactAt)}` : "Chưa liên hệ"}
                  {r.nextFollowupAt ? ` · hẹn ${formatDateTime(r.nextFollowupAt)}` : ""}
                  {r.nextAction ? ` · ${r.nextAction}` : ""} · {r.sourceLabel}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {rows.length ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 p-3 backdrop-blur">
          <Link href={`/wholesale/mobile/next?${qs({})}`} className="mx-auto flex min-h-12 max-w-md items-center justify-center rounded-xl bg-primary text-base font-semibold text-primary-foreground">
            📞 Gọi khách đầu danh sách
          </Link>
        </div>
      ) : null}
    </div>
  );
}

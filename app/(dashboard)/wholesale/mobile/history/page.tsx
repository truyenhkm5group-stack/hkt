import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource } from "@/lib/auth/scope-guard";
import { formatDateTime } from "@/lib/format";
import { mobileHistory } from "@/lib/queries/wholesale-mobile";

export const metadata = { title: "Lịch sử gọi" };

/** Cuộc gọi của CHÍNH người đang xem, mới nhất trước — bấm để mở lại khách. */
export default async function WholesaleMobileHistory() {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Lịch sử gọi" reason={decision.reason} fix={decision.fix} />;
  const rows = await mobileHistory(user.id);
  return (
    <div className="mx-auto max-w-md space-y-3 pb-10">
      <Link href="/wholesale/mobile" className="text-sm text-muted-foreground">
        ← Hôm nay
      </Link>
      <PageHeader title="Lịch sử gọi" description="Cuộc gọi bạn đã ghi kết quả, mới nhất trước" />
      {rows.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">Chưa ghi cuộc gọi nào.</p> : null}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`/wholesale/mobile/lead/${r.leadId}?f=all`} className="block rounded-xl border bg-card p-3 active:bg-muted">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold">{r.name ?? "(chưa có tên)"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(r.at)}</span>
              </div>
              <div className="text-sm">{r.outcomeLabel}</div>
              {r.note ? <div className="line-clamp-2 text-xs text-muted-foreground">{r.note}</div> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

import Link from "next/link";
import { TECH_EXECUTION_PROVIDER_LABEL } from "@/lib/constants/tech-worker";
import { formatTimeAgo } from "@/lib/format";
import type { TechCockpit } from "@/lib/queries/tech-cockpit";
import { cn } from "@/lib/utils";

/**
 * BUỒNG LÁI — trả lời trên điện thoại: đang làm gì · chờ gì · hỏng gì · cần tôi gì · PR · production · tiền API.
 * Server Component (không "use client"). Mỗi ô là một liên kết tới đúng danh sách sinh ra con số.
 */
function O({ label, value, note, href, tone }: { label: string; value: string; note?: string; href: string; tone: "plain" | "warn" | "bad" | "ok" | "owner" }) {
  const mau = {
    plain: "border-hairline",
    ok: "border-emerald-200 dark:border-emerald-900",
    warn: "border-amber-300 dark:border-amber-800",
    bad: "border-rose-300 dark:border-rose-800",
    owner: "border-fuchsia-300 bg-fuchsia-50/60 dark:border-fuchsia-800 dark:bg-fuchsia-950/30",
  }[tone];
  return (
    <Link href={href} className={cn("block rounded-xl border-2 bg-card p-3 transition-colors hover:bg-muted/40", mau)}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-extrabold tabular-nums">{value}</p>
      {note ? <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{note}</p> : null}
    </Link>
  );
}

const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

export function TechCockpitPanel({ c }: { c: TechCockpit }) {
  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <O label="Cần bạn" value={String(c.counts.needsOwner)} note="việc chờ đúng một việc của bạn + việc chờ duyệt" href="/tech/needs-owner" tone={c.counts.needsOwner ? "owner" : "ok"} />
        <O label="Đang chạy" value={String(c.counts.running)} note={`${c.workers.online}/${c.workers.total} worker đang sống`} href="/tech/workers" tone="plain" />
        <O label="Đang chờ" value={String(c.counts.queued)} note={`${c.counts.ready} sẵn sàng · ${c.counts.queued - c.counts.ready} tồn đọng`} href="/tech/tasks?open=1" tone="plain" />
        <O label="Đường giao hàng" value={String(c.counts.inDelivery)} note="review · kiểm thử · deploy · hậu kiểm" href="/tech/tasks?open=1" tone="plain" />
        <O label="Bị chặn" value={String(c.counts.blocked)} href="/tech/tasks?status=BLOCKED" tone={c.counts.blocked ? "warn" : "ok"} />
        <O label="Thất bại" value={String(c.counts.failed)} href="/tech/tasks?status=FAILED,ROLLED_BACK" tone={c.counts.failed ? "bad" : "ok"} />
        <O
          label="Pull request"
          value={String(c.pr.open)}
          note={`${c.pr.ciFailing} CI đỏ · ${c.pr.awaitingReview} xanh chờ duyệt`}
          href="/tech/tasks?open=1"
          tone={c.pr.ciFailing ? "bad" : c.pr.awaitingReview ? "warn" : "plain"}
        />
        <O
          label="Chi API hôm nay"
          value={usd(c.spend.apiTodayUsd)}
          note={
            c.spend.apiDailyCapUsd === null
              ? "chưa khai trần ⇒ worker API không chạy"
              : `trần ${usd(c.spend.apiDailyCapUsd)}/ngày · tháng ${usd(c.spend.apiMonthUsd)}`
          }
          href="/tech/workers"
          tone={c.spend.apiAlert === "EXCEEDED" ? "bad" : c.spend.apiAlert === "WARN" ? "warn" : "plain"}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Gói thuê bao tháng này: {c.spend.subscriptionRunsMonth} lượt · ước tính CLI tự báo ≈ {usd(c.spend.subscriptionEstimateUsdMonth)} (KHÔNG phải tiền đã chi, không cộng vào tiền API).
        {c.lastDeploy ? ` · Deploy gần nhất ${c.lastDeploy.commitSha.slice(0, 7)} (${c.lastDeploy.verification}) ${formatTimeAgo(c.lastDeploy.startedAt)}.` : ""}
      </p>

      {c.executions.length ? (
        <div className="space-y-2">
          <p className="text-sm font-bold">Đang chạy ngay lúc này</p>
          {c.executions.map((e) => (
            <div key={e.runId} className="rounded-xl border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {e.task ? (
                  <Link href={`/tech/tasks/${e.task.id}`} className="font-semibold hover:underline">
                    {e.task.code} · {e.task.title}
                  </Link>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {e.task?.capability || e.task?.taskType} · {e.worker?.name ?? "—"} · {e.provider ? TECH_EXECUTION_PROVIDER_LABEL[e.provider] : "—"}
                {e.model ? ` · ${e.model}` : ""} · {e.runtimeMinutes}′ · nhịp tim {e.heartbeatAt ? formatTimeAgo(e.heartbeatAt) : "—"} · {e.step || "đang chạy"}
                {e.progressPct !== null ? ` · ${e.progressPct}%` : ""}
                {e.task?.prNumber ? ` · PR #${e.task.prNumber}` : ` · nhánh ${e.branch}`}
              </p>
              {e.logTail.length ? <pre className="mt-1.5 max-h-24 overflow-hidden whitespace-pre-wrap rounded bg-muted p-2 text-[11px] leading-4">{e.logTail.join("\n")}</pre> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

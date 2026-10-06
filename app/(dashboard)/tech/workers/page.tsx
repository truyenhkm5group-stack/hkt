import Link from "next/link";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { ReapLeases, RegisterWorker, WorkerToggle } from "@/app/(dashboard)/tech/workers/worker-controls";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_CAPABILITIES } from "@/lib/constants/tech-capabilities";
import { TECH_EXECUTION_PROVIDER_LABEL, TECH_PROVIDER_BILLING, WORKER_LIVENESS_LABEL, type TechExecutionProvider, type WorkerLiveness } from "@/lib/constants/tech-worker";
import { env } from "@/lib/env";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { listTechWorkers, recentWorkerRuns } from "@/lib/queries/tech-control-plane";
import { BudgetForm } from "@/app/(dashboard)/tech/budget-form";
import { getBudgetRow } from "@/lib/tech/budget";
import { cn } from "@/lib/utils";

export const metadata = { title: "Worker · Phòng Tech AI" };

const LIVE_TONE: Record<WorkerLiveness, string> = {
  NEVER: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  ONLINE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  STALE: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  LOST: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};
const badge = "inline-flex items-center rounded-md px-2 py-0.5 text-[11.5px] font-semibold";
const capLabel = (k: string) => TECH_CAPABILITIES.find((c) => c.key === k)?.label ?? k;

/** Tiền một lượt: API = tiền thật; gói thuê bao = ƯỚC TÍNH do CLI tự báo, không phải tiền đã chi. Chưa đo ⇒ "—". */
function tien(meta: unknown): string {
  const c = (meta as { cost?: { usd?: number | null; estimated?: boolean } | null } | null)?.cost;
  if (!c || c.usd == null) return "—";
  return `${c.estimated ? "≈" : ""}$${c.usd.toFixed(2)}${c.estimated ? " (ước tính, gói thuê bao)" : ""}`;
}

export default async function TechWorkersPage() {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const [workers, runs, nganCty] = await Promise.all([listTechWorkers(), recentWorkerRuns(20, 30), getBudgetRow("COMPANY", "")]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Worker"
        description="Tiến trình headless nhận việc từ hàng đợi — nhịp tim, lease, lượt chạy, nhật ký"
        hint={
          <>
            Hàng đợi là PostgreSQL: worker xin việc, nhận một lease 5 phút và gia hạn bằng nhịp tim 30 giây. Worker chết thì lease
            hết hạn, việc tự về hàng đợi (đếm lần thử, lùi dần, tối đa 3 lần). Worker chỉ nhận việc R0/R1 của sứ mệnh đang chạy;
            không gộp, không deploy. Worker gói thuê bao không bao giờ thấy khoá API — tiền của nó chỉ là ước tính.
          </>
        }
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <ReapLeases />
              <RegisterWorker origin={env.appUrl} />
            </div>
          ) : null
        }
      />
      <TechNav />

      {workers.length === 0 ? (
        <EmptyState title="Chưa có worker nào" description="Đăng ký một worker rồi chạy `npm run tech:worker` trên máy có Claude Code." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {workers.map((w) => (
            <div key={w.id} className="rounded-xl border bg-card p-4 shadow-[var(--shadow-card)]">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold">{w.name}</span>
                <span className="text-xs text-muted-foreground">{w.key}</span>
                <span className={cn(badge, LIVE_TONE[w.liveness])}>{WORKER_LIVENESS_LABEL[w.liveness]}</span>
                {!w.enabled ? <span className={cn(badge, "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")}>Đã tắt</span> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {TECH_EXECUTION_PROVIDER_LABEL[w.provider as TechExecutionProvider] ?? w.provider} · tối đa {w.maxConcurrency} việc · nhịp tim{" "}
                {w.lastHeartbeatAt ? formatTimeAgo(w.lastHeartbeatAt) : "chưa có"}
                {w.version ? ` · ${w.version}` : ""}
              </p>
              <p className="mt-1 text-xs">{(w.capabilities as string[]).map(capLabel).join(" · ")}</p>
              {w.running.length ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {w.running.map((r) => {
                    const m = (r.metadata as { progressPct?: number; step?: string } | null) ?? {};
                    return (
                      <li key={r.id}>
                        {r.task ? (
                          <Link href={`/tech/tasks/${r.task.id}`} className="font-semibold hover:underline">
                            {r.task.code}
                          </Link>
                        ) : null}{" "}
                        · {m.step ?? "đang chạy"} · {m.progressPct != null ? `${m.progressPct}%` : "—"} · nhịp {r.heartbeatAt ? formatTimeAgo(r.heartbeatAt) : "—"}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Không giữ việc nào.</p>
              )}
              {canManage ? (
                <div className="mt-3">
                  <WorkerToggle workerId={w.id} enabled={w.enabled} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <SectionCard
        title="Ngân sách & giới hạn — cấp công ty"
        description="Ô trống = chưa khai. Tiền API chưa khai trần ngày ⇒ worker API KHÔNG chạy. Sứ mệnh có thể khai trần riêng (đè từng ô)."
      >
        {canManage ? (
          <BudgetForm scopeKind="COMPANY" current={nganCty} />
        ) : (
          <p className="text-sm text-muted-foreground">Trần chi API / ngày: {nganCty?.apiUsdDaily ?? "chưa khai"}</p>
        )}
      </SectionCard>

      <SectionCard title="Lượt chạy gần đây" description="20 lượt cuối của worker hàng đợi · 30 dòng nhật ký cuối mỗi lượt">
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có lượt chạy nào.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {runs.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <p className="font-semibold">
                  {r.task ? (
                    <Link href={`/tech/tasks/${r.task.id}`} className="hover:underline">
                      {r.task.code} · {r.task.title}
                    </Link>
                  ) : (
                    "—"
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.status} · {r.worker?.key ?? "—"} · {TECH_EXECUTION_PROVIDER_LABEL[r.provider as TechExecutionProvider] ?? (r.provider || "—")}
                  {r.model ? ` · ${r.model}` : ""} · {TECH_PROVIDER_BILLING[r.provider as TechExecutionProvider] === "API" ? "tiền API thật" : "gói thuê bao"} · {tien(r.metadata)} · bắt đầu{" "}
                  {formatDateTime(r.startedAt)}
                  {r.endedAt ? ` · xong ${formatTimeAgo(r.endedAt)}` : ""} · nhánh {r.branch || "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Cổng: typecheck {r.typecheckResult} · lint {r.lintResult} · test {r.testResult}
                </p>
                {r.summary || r.error ? <p className="mt-1 text-xs">{r.error || r.summary}</p> : null}
                {r.logs.length ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-primary">Nhật ký ({r.logs.length} dòng cuối)</summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] leading-4">
                      {r.logs.map((l) => `${l.level === "info" ? "" : `[${l.level}] `}${l.line}`).join("\n")}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

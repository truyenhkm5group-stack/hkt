import Link from "next/link";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { AutoRefresh, CreateWorker, InstallerButton, ReapLeases, RemoveWorkerButton, RepairMenu, RotateTokenButton, WorkerToggle } from "@/app/(dashboard)/tech/workers/worker-controls";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_CAPABILITIES } from "@/lib/constants/tech-capabilities";
import {
  CLAUDE_AUTH_LABEL,
  ONBOARDING_STEPS,
  WORKER_POLICY_FACTS,
  onboardingProgress,
  sanitizeWorkerDiagnostics,
  type OnboardingStepState,
} from "@/lib/constants/tech-worker-onboarding";
import {
  TECH_EXECUTION_PROVIDER_LABEL,
  TECH_PROVIDER_BILLING,
  WORKER_LIVENESS_LABEL,
  WORKER_POLICY_CEILING_SETTING,
  workerPolicyCeiling,
  type TechExecutionProvider,
  type WorkerLiveness,
} from "@/lib/constants/tech-worker";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { listTechWorkers, recentWorkerRuns } from "@/lib/queries/tech-control-plane";
import { BudgetForm } from "@/app/(dashboard)/tech/budget-form";
import { getSettingJson } from "@/lib/settings";
import { getBudgetRow } from "@/lib/tech/budget";
import { pendingEnrollmentWorkerIds, workerPushReadiness } from "@/lib/tech/worker-onboarding";
import { cn } from "@/lib/utils";

export const metadata = { title: "Worker · Phòng Tech AI" };

const LIVE_TONE: Record<WorkerLiveness, string> = {
  NEVER: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  ONLINE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  STALE: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  LOST: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};
const STEP_TONE: Record<OnboardingStepState, string> = {
  DONE: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
  CURRENT: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200",
  TODO: "border-hairline text-muted-foreground",
  PROBLEM: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200",
};
const badge = "inline-flex items-center rounded-md px-2 py-0.5 text-[11.5px] font-semibold";
const capLabel = (k: string) => TECH_CAPABILITIES.find((c) => c.key === k)?.label ?? k;

/** Tiền một lượt: API = tiền thật; gói thuê bao = ƯỚC TÍNH do CLI tự báo, không phải tiền đã chi. Chưa đo ⇒ "—". */
function tien(meta: unknown): string {
  const c = (meta as { cost?: { usd?: number | null; estimated?: boolean } | null } | null)?.cost;
  if (!c || c.usd == null) return "—";
  return `${c.estimated ? "≈" : ""}$${c.usd.toFixed(2)}${c.estimated ? " (ước tính, gói thuê bao)" : ""}`;
}

/** Một ô chẩn đoán: nhãn · giá trị · tông (tốt / xấu / chưa biết). Chưa biết in "—", không in "0" hay "OK". */
function Cell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "ok" | "bad" | "unknown" }) {
  return (
    <div className="rounded-lg border border-hairline px-2.5 py-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("text-xs font-medium", tone === "ok" && "text-emerald-700 dark:text-emerald-300", tone === "bad" && "text-rose-700 dark:text-rose-300", tone === "unknown" && "text-muted-foreground")}>{value}</p>
    </div>
  );
}

export default async function TechWorkersPage() {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const now = new Date();
  const [workers, runs, nganCty, choGhiDanh, tranRaw] = await Promise.all([
    listTechWorkers(now),
    recentWorkerRuns(20, 30),
    getBudgetRow("COMPANY", ""),
    pendingEnrollmentWorkerIds(now),
    getSettingJson<Record<string, unknown>>(WORKER_POLICY_CEILING_SETTING, {}),
  ]);
  const tranChinhSach = workerPolicyCeiling(tranRaw);
  const day = workerPushReadiness();
  const apiBudgetDeclared = nganCty?.apiUsdDaily != null && nganCty.apiUsdDaily > 0;
  const view = workers.map((w) => {
    const diag = sanitizeWorkerDiagnostics(w.diagnostics);
    const prog = onboardingProgress(
      { provider: w.provider, enabled: w.enabled, removedAt: w.removedAt, secretRevokedAt: w.secretRevokedAt, enrolledAt: w.enrolledAt, lastHeartbeatAt: w.lastHeartbeatAt, pendingEnrollment: choGhiDanh.has(w.id), diagnostics: diag },
      now,
    );
    return { w, diag, prog };
  });
  // Còn worker chưa lên «Đang sống» mà đang trong luồng cài ⇒ trang tự làm mới để bước 4 tự hiện.
  const dangCho = view.some((v) => !v.w.removedAt && v.prog.steps[3]!.state !== "DONE" && (choGhiDanh.has(v.w.id) || !!v.w.enrolledAt));

  return (
    <div className="space-y-5">
      <AutoRefresh active={dangCho} />
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Worker"
        description="Máy làm việc của Phòng Tech AI — cài bằng một nút, theo dõi nhịp tim, lượt chạy, nhật ký"
        hint={
          <>
            Hàng đợi là PostgreSQL: worker xin việc, nhận một lease 5 phút và gia hạn bằng nhịp tim 30 giây. Worker chết thì lease hết hạn, việc
            tự về hàng đợi. Worker chỉ nhận việc tới trần chính sách ({tranChinhSach}); không gộp, không deploy. Worker gói thuê bao không bao giờ thấy
            khoá API. Khoá worker không bao giờ hiện ra màn hình — bộ cài nhận nó trực tiếp từ máy chủ.
          </>
        }
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <ReapLeases />
              <CreateWorker isFirst={workers.length === 0} apiBudgetDeclared={apiBudgetDeclared} policyCeiling={tranChinhSach} />
            </div>
          ) : null
        }
      />
      <TechNav />

      <ol className="grid gap-2 sm:grid-cols-4">
        {ONBOARDING_STEPS.map((s, i) => (
          <li key={s} className="rounded-lg border border-hairline bg-card px-3 py-2 text-sm">
            <span className="mr-1.5 inline-flex size-5 items-center justify-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {workers.length === 0 ? (
        <EmptyState
          title="Chưa có worker nào"
          description="Bấm «Tạo worker» (đã điền sẵn chế độ an toàn dogfood-1), rồi «Cài worker trên máy Windows này» và bấm đúp tệp tải về. Không cần cài gì tay, không cần dán khoá."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {view.map(({ w, diag, prog }) => {
            const sub = w.provider === "SUBSCRIPTION_CLAUDE_CODE";
            return (
              <div key={w.id} className="space-y-3 rounded-xl border bg-card p-4 shadow-[var(--shadow-card)]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold">{w.name}</span>
                  <span className="text-xs text-muted-foreground">{w.key}</span>
                  <span className={cn(badge, LIVE_TONE[w.liveness])}>{WORKER_LIVENESS_LABEL[w.liveness]}</span>
                  {w.removedAt ? <span className={cn(badge, "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")}>Đã gỡ</span> : !w.enabled ? <span className={cn(badge, "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")}>Đã tắt</span> : null}
                </div>
                {w.disabledReason && !w.enabled ? <p className="text-xs text-rose-700 dark:text-rose-300">{w.disabledReason}</p> : null}

                <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {prog.steps.map((s, i) => (
                    <li key={s.label} className={cn("rounded-md border px-2 py-1 text-[11.5px]", STEP_TONE[s.state])}>
                      {i + 1}. {s.label}
                    </li>
                  ))}
                </ol>
                <p className="text-sm">{prog.next}</p>

                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  <Cell label="Kết nối · nhịp tim" value={w.lastHeartbeatAt ? `${WORKER_LIVENESS_LABEL[w.liveness]} · ${formatTimeAgo(w.lastHeartbeatAt)}` : "Chưa có nhịp tim"} tone={w.liveness === "ONLINE" ? "ok" : w.liveness === "NEVER" ? "unknown" : "bad"} />
                  <Cell
                    label="Đăng nhập Claude"
                    value={sub ? (diag ? CLAUDE_AUTH_LABEL[diag.claudeAuth] : "—") : "Không cần (đường API)"}
                    tone={!sub ? "ok" : !diag || diag.claudeAuth === "UNKNOWN" ? "unknown" : diag.claudeAuth === "LOGGED_IN_SUBSCRIPTION" ? "ok" : "bad"}
                  />
                  <Cell label="Kho của worker" value={diag ? (diag.repo.ok ? `Sẵn sàng · ${diag.repo.head.slice(0, 8) || "—"}` : diag.repo.detail || "Chưa sẵn sàng") : "—"} tone={!diag ? "unknown" : diag.repo.ok ? "ok" : "bad"} />
                  <Cell label="Claude Code chạy được" value={diag ? (diag.adapter.ok ? "Có" : diag.adapter.detail || "Không") : "—"} tone={!diag ? "unknown" : diag.adapter.ok ? "ok" : "bad"} />
                  <Cell label="ANTHROPIC_API_KEY trong môi trường" value={diag ? (diag.apiKeyAbsent ? "Vắng mặt" : "CÓ — worker từ chối chạy") : "—"} tone={!diag ? "unknown" : diag.apiKeyAbsent ? "ok" : sub ? "bad" : "unknown"} />
                  <Cell label="Phiên bản" value={diag ? [diag.workerVersion, diag.claudeVersion, diag.nodeVersion].filter(Boolean).join(" · ") || "—" : w.version || "—"} tone={diag ? undefined : "unknown"} />
                  <Cell label="Ghi nhánh" value={day.ready ? "Máy chủ ghi bằng bot — máy không giữ quyền GitHub" : "Máy chủ chưa ghi được (thiếu bot)"} tone={day.ready ? "ok" : "bad"} />
                  <Cell label="Tự kiểm gần nhất" value={w.diagnosticsAt ? formatTimeAgo(w.diagnosticsAt) : "—"} tone={w.diagnosticsAt ? undefined : "unknown"} />
                  <Cell label="Lỗi gần nhất" value={diag?.lastError || "—"} tone={diag?.lastError ? "bad" : "unknown"} />
                </div>
                {!day.ready ? <p className="text-xs text-muted-foreground">{day.detail}</p> : null}

                <div className="rounded-lg bg-muted/60 p-2.5 text-xs">
                  <p>
                    <b>Chính sách:</b> trần {tranChinhSach} · tối đa {w.maxConcurrency} việc cùng lúc · {TECH_EXECUTION_PROVIDER_LABEL[w.provider as TechExecutionProvider] ?? w.provider}
                  </p>
                  <p className="mt-0.5 text-muted-foreground">{WORKER_POLICY_FACTS.map((f) => `${f.label}: ${f.value}`).join(" · ")}</p>
                  <p className="mt-0.5">
                    <b>Năng lực:</b> {(w.capabilities as string[]).map(capLabel).join(" · ")}
                  </p>
                </div>

                {w.running.length ? (
                  <ul className="space-y-1 text-sm">
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
                  <p className="text-xs text-muted-foreground">Không giữ việc nào.</p>
                )}

                {canManage ? (
                  <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                    <InstallerButton workerId={w.id} label={w.enrolledAt && !w.secretRevokedAt && !w.removedAt ? "Tải bộ cài (cài lại)" : "Cài worker trên máy Windows này"} variant={w.enrolledAt && !w.secretRevokedAt ? "outline" : "default"} />
                    {!w.removedAt ? (
                      <>
                        <RepairMenu workerId={w.id} />
                        <RotateTokenButton workerId={w.id} workerKey={w.key} />
                        {!w.secretRevokedAt ? <WorkerToggle workerId={w.id} enabled={w.enabled} /> : null}
                        <RemoveWorkerButton workerId={w.id} workerKey={w.key} />
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
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

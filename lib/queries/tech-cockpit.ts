import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TechTaskStatus } from "@/lib/constants/tech";
import { canonicalTaskState, countOpenDependencies, type CanonicalTaskState } from "@/lib/constants/tech-control-plane";
import { TECH_PROVIDER_BILLING, leaseIsActive, workerLiveness, type TechExecutionProvider } from "@/lib/constants/tech-worker";
import { apiSpendAlert } from "@/lib/constants/tech-policy";
import { apiSpend, effectiveBudget } from "@/lib/tech/budget";

/**
 * ───────────── BUỒNG LÁI CỦA CHỦ SHOP TRÊN /tech (Pha 5) ─────────────
 *
 * docs/tech-control-plane/README.md mục 12. Một câu trả lời cho mỗi câu hỏi chủ shop hỏi trên điện thoại: đang làm
 * gì · chờ gì · hỏng gì · cần tôi gì · PR ra sao · production ra sao · tốn bao nhiêu tiền API. Không đệm — người mở
 * trang này để hành động. Mọi trạng thái là phép chiếu tính lúc đọc (`canonicalTaskState`), không cột thứ hai.
 *
 * TIỀN: API là tiền THẬT (đếm từ sổ lượt chạy); gói thuê bao chỉ có ƯỚC TÍNH do CLI tự báo — in riêng, có nhãn,
 * KHÔNG cộng vào tiền API và không gọi là "tiết kiệm".
 */
export async function techCockpit(now = new Date()) {
  const db = await getDb();
  const t = schema.techTasks;
  const open = await db
    .select({ id: t.id, status: t.status, dependsOn: t.dependsOn, leaseWorkerId: t.leaseWorkerId, leaseExpiresAt: t.leaseExpiresAt, prState: t.prState, ciState: t.ciState, reviewState: t.reviewState, approvalStatus: t.approvalStatus })
    .from(t)
    .where(sql`${t.status} not in ('DONE','CANCELLED')`);
  const statusById = new Map<string, TechTaskStatus>(open.map((x) => [x.id, x.status as TechTaskStatus]));
  const depIds = [...new Set(open.flatMap((x) => x.dependsOn ?? []))].filter((id) => !statusById.has(id));
  if (depIds.length) for (const r of await db.select({ id: t.id, status: t.status }).from(t).where(inArray(t.id, depIds))) statusById.set(r.id, r.status as TechTaskStatus);
  const dem: Record<CanonicalTaskState, number> = { BACKLOG: 0, READY: 0, CLAIMED: 0, RUNNING: 0, REVIEW: 0, TESTING: 0, DEPLOYING: 0, VERIFYING: 0, DONE: 0, BLOCKED: 0, FAILED: 0, NEEDS_OWNER: 0, CANCELLED: 0 };
  for (const x of open) {
    dem[canonicalTaskState({ status: x.status as TechTaskStatus, leaseActive: leaseIsActive(x, now), openDependencies: countOpenDependencies(x.dependsOn ?? [], statusById) })] += 1;
  }
  const pr = {
    open: open.filter((x) => x.prState === "OPEN").length,
    ciFailing: open.filter((x) => x.prState === "OPEN" && x.ciState === "FAILURE").length,
    awaitingReview: open.filter((x) => x.prState === "OPEN" && x.ciState === "SUCCESS" && x.reviewState !== "APPROVED").length,
  };
  const choDuyet = open.filter((x) => x.approvalStatus === "PENDING").length;

  const runs = await db.query.techAgentRuns.findMany({
    where: and(isNotNull(schema.techAgentRuns.workerId), eq(schema.techAgentRuns.status, "RUNNING")),
    orderBy: [asc(schema.techAgentRuns.startedAt)],
    with: {
      task: { columns: { id: true, code: true, title: true, capability: true, taskType: true, prNumber: true, prUrl: true, status: true } },
      worker: { columns: { key: true, name: true } },
    },
    limit: 20,
  });
  const tail = runs.length
    ? await db
        .select({ runId: schema.techRunLogs.runId, seq: schema.techRunLogs.seq, line: schema.techRunLogs.line, level: schema.techRunLogs.level })
        .from(schema.techRunLogs)
        .where(sql`${schema.techRunLogs.runId} in (${sql.join(runs.map((r) => sql`${r.id}`), sql`, `)}) and ${schema.techRunLogs.seq} > (select coalesce(max(l2.seq), 0) - 5 from tech_run_logs l2 where l2.run_id = ${schema.techRunLogs.runId})`)
        .orderBy(asc(schema.techRunLogs.seq))
    : [];
  const executions = runs.map((r) => {
    const m = (r.metadata as { progressPct?: number; step?: string } | null) ?? {};
    return {
      runId: r.id,
      task: r.task,
      worker: r.worker,
      provider: r.provider as TechExecutionProvider | "",
      billing: r.provider ? TECH_PROVIDER_BILLING[r.provider as TechExecutionProvider] : null,
      model: r.model,
      branch: r.branch,
      startedAt: r.startedAt,
      runtimeMinutes: Math.round((now.getTime() - r.startedAt.getTime()) / 60000),
      heartbeatAt: r.heartbeatAt,
      progressPct: typeof m.progressPct === "number" ? m.progressPct : null,
      step: m.step ?? "",
      logTail: tail.filter((l) => l.runId === r.id).map((l) => l.line),
    };
  });

  const workers = await db.select({ lastHeartbeatAt: schema.techWorkers.lastHeartbeatAt, enabled: schema.techWorkers.enabled }).from(schema.techWorkers);
  const online = workers.filter((w) => w.enabled && workerLiveness(w.lastHeartbeatAt, now) === "ONLINE").length;

  // Tiền: API thật; gói thuê bao ước tính (CLI tự báo) — hai con số, hai nhãn.
  const ngan = await effectiveBudget(null);
  const chi = await apiSpend({ now });
  const dauThang = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [thang] = await db
    .select({
      api: sql<number>`coalesce(sum(nullif(${schema.techAgentRuns.metadata}->'cost'->>'usd', '')::float8) filter (where ${schema.techAgentRuns.metadata}->>'billing' = 'API'), 0)`,
      subEst: sql<number>`coalesce(sum(nullif(${schema.techAgentRuns.metadata}->'cost'->>'usd', '')::float8) filter (where ${schema.techAgentRuns.metadata}->>'billing' = 'SUBSCRIPTION'), 0)`,
      subRuns: sql<number>`count(*) filter (where ${schema.techAgentRuns.provider} = 'SUBSCRIPTION_CLAUDE_CODE')`,
      apiRuns: sql<number>`count(*) filter (where ${schema.techAgentRuns.provider} = 'ANTHROPIC_API')`,
    })
    .from(schema.techAgentRuns)
    .where(and(isNotNull(schema.techAgentRuns.workerId), gte(schema.techAgentRuns.startedAt, dauThang)));

  const lastDeploy = await db.query.techDeployments.findFirst({ where: eq(schema.techDeployments.status, "SUCCEEDED"), orderBy: [desc(schema.techDeployments.startedAt)] });

  return {
    counts: {
      running: dem.CLAIMED + dem.RUNNING,
      queued: dem.READY + dem.BACKLOG,
      ready: dem.READY,
      inDelivery: dem.REVIEW + dem.TESTING + dem.DEPLOYING + dem.VERIFYING,
      blocked: dem.BLOCKED,
      failed: dem.FAILED,
      needsOwner: dem.NEEDS_OWNER + choDuyet,
      byState: dem,
    },
    pr,
    executions,
    workers: { total: workers.length, online },
    lastDeploy: lastDeploy ? { commitSha: lastDeploy.commitSha, verification: lastDeploy.verification, startedAt: lastDeploy.startedAt } : null,
    spend: {
      apiTodayUsd: chi.todayUsd,
      apiMonthUsd: Number(thang?.api ?? 0),
      apiDailyCapUsd: ngan.apiUsdDaily,
      apiAlert: apiSpendAlert(ngan, chi.todayUsd),
      apiRunsMonth: Number(thang?.apiRuns ?? 0),
      subscriptionRunsMonth: Number(thang?.subRuns ?? 0),
      subscriptionEstimateUsdMonth: Number(thang?.subEst ?? 0),
    },
  };
}

export type TechCockpit = Awaited<ReturnType<typeof techCockpit>>;

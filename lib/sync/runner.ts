import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { publish } from "@/lib/realtime/bus";

export type SyncSource = "PANCAKE" | "VIETTELPOST" | "FACEBOOK";
export type SyncTrigger = "MANUAL" | "CRON" | "WEBHOOK";

export type SyncSummary = {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  detail: string;
};

export type SyncContext = {
  runId: string;
  summary: SyncSummary;
  log: (message: string) => void;
  /** cập nhật tiến độ vào DB (tối đa 1 lần / 3 giây) */
  progress: () => Promise<void>;
};

const runningJobs = new Map<string, Promise<unknown>>();

export function isJobRunning(key: string) {
  return runningJobs.has(key);
}

export function runningJobKeys() {
  return [...runningJobs.keys()];
}

/**
 * Chạy một job đồng bộ, ghi bản ghi sync_runs. Mỗi job chỉ chạy một tiến trình tại một thời điểm.
 */
export async function runSyncJob<T>(
  options: { source: SyncSource; job: string; trigger?: SyncTrigger; actor?: string },
  fn: (ctx: SyncContext) => Promise<T>,
): Promise<{ run: { id: string; status: string }; summary: SyncSummary; result: T | null; skippedBecauseRunning?: boolean }> {
  const key = `${options.source}:${options.job}`;
  if (runningJobs.has(key)) {
    return {
      run: { id: "", status: "RUNNING" },
      summary: { imported: 0, updated: 0, skipped: 0, failed: 0, detail: "Job đang chạy, bỏ qua lần gọi này" },
      result: null,
      skippedBecauseRunning: true,
    };
  }

  const db = await getDb();
  const summary: SyncSummary = { imported: 0, updated: 0, skipped: 0, failed: 0, detail: "" };
  const logs: string[] = [];
  const [run] = await db
    .insert(schema.syncRuns)
    .values({ source: options.source, job: options.job, trigger: options.trigger ?? "MANUAL", actor: options.actor ?? "system", status: "RUNNING" })
    .returning({ id: schema.syncRuns.id });

  let lastProgressAt = 0;
  const ctx: SyncContext = {
    runId: run.id,
    summary,
    log: (message) => {
      logs.push(message);
      if (logs.length > 50) logs.shift();
    },
    progress: async () => {
      if (Date.now() - lastProgressAt < 3000) return;
      lastProgressAt = Date.now();
      await db
        .update(schema.syncRuns)
        .set({ imported: summary.imported, updated: summary.updated, skipped: summary.skipped, failed: summary.failed, detail: summary.detail || logs.at(-1) || "" })
        .where(eq(schema.syncRuns.id, run.id))
        .catch(() => undefined);
    },
  };

  const promise = (async () => {
    try {
      const result = await fn(ctx);
      const status = summary.failed > 0 ? "PARTIAL" : "SUCCESS";
      await db
        .update(schema.syncRuns)
        .set({ status, imported: summary.imported, updated: summary.updated, skipped: summary.skipped, failed: summary.failed, detail: summary.detail || logs.at(-1) || "", error: logs.length ? logs.slice(-5).join("\n").slice(0, 2000) : null, finishedAt: new Date() })
        .where(eq(schema.syncRuns.id, run.id));
      publish({ type: "sync", source: options.source, job: options.job, status });
      return { run: { id: run.id, status }, summary, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(schema.syncRuns)
        .set({ status: "FAILED", imported: summary.imported, updated: summary.updated, skipped: summary.skipped, failed: summary.failed + 1, detail: summary.detail || logs.at(-1) || "", error: message.slice(0, 2000), finishedAt: new Date() })
        .where(eq(schema.syncRuns.id, run.id));
      publish({ type: "sync", source: options.source, job: options.job, status: "FAILED" });
      throw error;
    } finally {
      clearMemo();
      runningJobs.delete(key);
    }
  })();

  runningJobs.set(key, promise);
  return promise;
}

export async function getSyncState<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.query.syncState.findFirst({ where: eq(schema.syncState.key, key) });
  return (row?.value as T) ?? null;
}

export async function setSyncState(key: string, value: unknown) {
  const db = await getDb();
  await db
    .insert(schema.syncState)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value, updatedAt: new Date() } });
}

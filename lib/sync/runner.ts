import { and, eq, lt } from "drizzle-orm";
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
  /**
   * Job chạy trót lọt về kỹ thuật nhưng KHÔNG đạt mục đích (ví dụ đối chiếu không tra được vận
   * đơn nào). Có cảnh báo thì lần chạy ghi PARTIAL để hiện cảnh báo, không phải SUCCESS.
   */
  warning?: string;
};

export type SyncContext = {
  runId: string;
  summary: SyncSummary;
  log: (message: string) => void;
  /** cập nhật tiến độ vào DB (tối đa 1 lần / 3 giây) */
  progress: () => Promise<void>;
};

const runningJobs = new Map<string, Promise<unknown>>();
/** Đồng hồ canh cho từng job đang chạy — dọn khi job kết thúc để không giữ tiến trình sống. */
const jobWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Bản ghi RUNNING mồ côi: `runningJobs` chỉ nằm trong bộ nhớ tiến trình, nên deploy hay khởi động
 * lại container giữa chừng để lại dòng RUNNING vĩnh viễn — vừa hiện sai là "đang chạy", vừa che
 * mất lần chạy hỏng. Đóng chúng lại mỗi khi bắt đầu một lần chạy mới.
 */
const ORPHAN_RUN_AFTER_MS = 30 * 60_000;

/**
 * ĐỒNG HỒ CANH JOB TREO.
 *
 * Khoá job nằm trong bộ nhớ tiến trình và chỉ được nhả trong `finally`. Nếu một job TREO — mạng
 * không timeout, bên thứ ba không trả lời, vòng lặp không thoát — thì `finally` không bao giờ chạy,
 * khoá không bao giờ nhả, và job đó KHÔNG CÒN CHẠY ĐƯỢC NỮA cho tới khi khởi động lại container.
 * Phần dọn bản ghi RUNNING mồ côi chỉ sửa dòng trong CSDL, không chạm tới khoá trong bộ nhớ.
 *
 * Hệ quả thật: một job đồng bộ treo lúc nửa đêm thì cả ngày hôm sau không có dữ liệu mới, mà giao
 * diện vẫn báo "đang chạy" — im lặng và rất khó phát hiện.
 *
 * Sau ngưỡng này, khoá được nhả và lần chạy được đánh dấu hỏng. Job cũ có thể vẫn còn chạy nền,
 * nhưng mọi job ở đây đều idempotent (ghi theo khoá tự nhiên), nên chạy chồng an toàn hơn hẳn so
 * với việc đứng im vĩnh viễn.
 */
const JOB_WATCHDOG_MS = 30 * 60_000;

/** Nhả khoá và huỷ đồng hồ canh của một job. */
function releaseJob(key: string) {
  runningJobs.delete(key);
  const timer = jobWatchdogs.get(key);
  if (timer) clearTimeout(timer);
  jobWatchdogs.delete(key);
}

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
  await db
    .update(schema.syncRuns)
    .set({ status: "FAILED", error: "Không kết thúc — tiến trình bị dừng giữa chừng (deploy hoặc khởi động lại).", finishedAt: new Date() })
    .where(and(eq(schema.syncRuns.status, "RUNNING"), lt(schema.syncRuns.startedAt, new Date(Date.now() - ORPHAN_RUN_AFTER_MS))))
    .catch(() => undefined);
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
      const status = summary.failed > 0 || summary.warning ? "PARTIAL" : "SUCCESS";
      const errorText = [summary.warning, logs.length ? logs.slice(-5).join("\n") : ""].filter(Boolean).join("\n") || null;
      await db
        .update(schema.syncRuns)
        .set({ status, imported: summary.imported, updated: summary.updated, skipped: summary.skipped, failed: summary.failed, detail: summary.detail || logs.at(-1) || "", error: errorText?.slice(0, 2000) ?? null, finishedAt: new Date() })
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
      releaseJob(key);
    }
  })();

  runningJobs.set(key, promise);
  // Nhả khoá sau ngưỡng canh, kể cả khi job không bao giờ kết thúc.
  const watchdog = setTimeout(() => {
    if (!runningJobs.has(key)) return;
    runningJobs.delete(key);
    jobWatchdogs.delete(key);
    void db
      .update(schema.syncRuns)
      .set({
        status: "FAILED",
        error: `Job chạy quá ${Math.round(JOB_WATCHDOG_MS / 60_000)} phút mà không kết thúc — đã nhả khoá để lần chạy sau không bị chặn.`,
        finishedAt: new Date(),
      })
      .where(and(eq(schema.syncRuns.id, run.id), eq(schema.syncRuns.status, "RUNNING")))
      .catch(() => undefined);
  }, JOB_WATCHDOG_MS);
  // `unref` để đồng hồ canh không giữ tiến trình sống (quan trọng với script chạy một lần).
  watchdog.unref?.();
  jobWatchdogs.set(key, watchdog);
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

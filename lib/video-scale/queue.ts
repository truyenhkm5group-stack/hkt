import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { VIDEO_JOB_LEASE_MS, VIDEO_JOB_MAX_ATTEMPTS, retryDelayMs, type VideoErrorKind, type VideoJobKind } from "@/lib/constants/video-scale";

/**
 * ═══════════ HÀNG ĐỢI VIỆC CỦA VIDEO SCALE ═══════════
 *
 * Không có bảng hàng đợi chung trong kho — mỗi miền tự cầm việc bằng trạng thái. Hàng đợi này theo đúng lối ấy, trên một
 * bảng riêng (`video_scale_jobs`):
 *
 *  · KHOÁ CHỐNG TRÙNG — `idempotency_key` duy nhất: dựng lại việc cho cùng (biến thể, cảnh) không đẻ dòng thứ hai.
 *  · CẦM CÓ HẠN — `locked_until` + `lock_token`: cập nhật có điều kiện, nên lượt vòng (scheduler) và lượt `after()` sau
 *    cú bấm chạy song song cũng không cầm trùng một việc. Tiến trình chết giữa chừng ⇒ hết hạn cầm ⇒ lượt sau nhận lại.
 *  · MỌI LƯỢT CHỐT ĐỀU ĐÒI ĐÚNG `lock_token` — một lượt đã bị coi là chết (hết hạn) không ghi đè lượt đang sống.
 *  · THỬ LẠI chỉ với lỗi `TRANSIENT` / `TIMEOUT`, lùi dần (`retryDelayMs`), trong `max_attempts`. `AMBIGUOUS` /
 *    `PERMANENT` ⇒ `FAILED` ngay; chỉ người bấm "Thử lại" (`resetJob`).
 */

const j = schema.videoScaleJobs;
export type VideoJobRow = typeof j.$inferSelect;

export type EnqueueInput = {
  kind: VideoJobKind;
  key: string;
  runId: string | null;
  variantId: string | null;
  sceneIndex?: number | null;
  isTest: boolean;
  request?: Record<string, unknown>;
  deadlineAt?: Date | null;
  createdByUserId?: string | null;
  nextRunAt?: Date;
  postId?: string | null;
};

/** Tạo việc nếu CHƯA có việc cùng khoá. Trả id của việc (mới hoặc đã có). */
export async function enqueueJob(db: Db, input: EnqueueInput): Promise<string> {
  const rows = await db
    .insert(j)
    .values({
      kind: input.kind,
      idempotencyKey: input.key,
      runId: input.runId,
      variantId: input.variantId,
      sceneIndex: input.sceneIndex ?? null,
      isTest: input.isTest,
      request: input.request ?? {},
      deadlineAt: input.deadlineAt ?? null,
      createdByUserId: input.createdByUserId ?? null,
      postId: input.postId ?? null,
      maxAttempts: VIDEO_JOB_MAX_ATTEMPTS[input.kind],
      nextRunAt: input.nextRunAt ?? new Date(),
    })
    .onConflictDoNothing({ target: j.idempotencyKey })
    .returning({ id: j.id });
  if (rows[0]) return rows[0].id;
  const [row] = await db.select({ id: j.id }).from(j).where(eq(j.idempotencyKey, input.key)).limit(1);
  return row.id;
}

/**
 * Cầm tối đa `limit` việc đến hạn. Việc `QUEUED` / `BLOCKED` / `RUNNING` hết hạn cầm chuyển sang `RUNNING`; việc `WAITING`
 * (đang chờ nhà cung cấp) giữ `WAITING` nhưng được khoá để chỉ một lượt hỏi.
 */
export async function claimDueJobs(db: Db, now: Date, opts: { limit: number; kinds?: readonly VideoJobKind[] }): Promise<VideoJobRow[]> {
  const due = and(
    inArray(j.status, ["QUEUED", "WAITING", "BLOCKED", "RUNNING"]),
    lte(j.nextRunAt, now),
    or(isNull(j.lockedUntil), lt(j.lockedUntil, now)),
    opts.kinds ? inArray(j.kind, [...opts.kinds]) : undefined,
  );
  const candidates = await db.select().from(j).where(due).orderBy(asc(j.nextRunAt), asc(j.createdAt)).limit(opts.limit * 3);
  const out: VideoJobRow[] = [];
  for (const c of candidates) {
    if (out.length >= opts.limit) break;
    const token = crypto.randomUUID();
    const lease = VIDEO_JOB_LEASE_MS[c.kind as VideoJobKind] ?? 180_000;
    const [got] = await db
      .update(j)
      .set({ status: c.status === "WAITING" ? "WAITING" : "RUNNING", lockedUntil: new Date(now.getTime() + lease), lockToken: token, startedAt: c.startedAt ?? now })
      .where(and(eq(j.id, c.id), eq(j.status, c.status), or(isNull(j.lockedUntil), lt(j.lockedUntil, now))))
      .returning();
    if (got) out.push(got);
  }
  return out;
}

type Patch = Partial<typeof j.$inferInsert>;

/** Ghi một lượt chốt — chỉ khi còn giữ đúng khoá. Trả `false` nếu khoá đã mất (lượt khác đã nhận việc). */
export async function settleJob(db: Db, job: Pick<VideoJobRow, "id" | "lockToken">, patch: Patch, keepLock = false): Promise<boolean> {
  const rows = await db
    .update(j)
    .set({ ...patch, ...(keepLock ? {} : { lockedUntil: null, lockToken: "" }) })
    .where(and(eq(j.id, job.id), eq(j.lockToken, job.lockToken)))
    .returning({ id: j.id });
  return rows.length > 0;
}

/** Đếm một lần thử (trước lời gọi thật). Cập nhật `job.attempts` tại chỗ. */
export async function beginAttempt(db: Db, job: VideoJobRow, extra: Patch = {}): Promise<boolean> {
  const ok = await settleJob(db, job, { attempts: job.attempts + 1, ...extra }, true);
  if (ok) job.attempts += 1;
  return ok;
}

export function succeedJob(db: Db, job: VideoJobRow, now: Date, patch: Patch = {}) {
  return settleJob(db, job, { status: "SUCCEEDED", finishedAt: now, error: "", errorKind: "", providerPendingAt: null, ...patch });
}

export function waitJob(db: Db, job: VideoJobRow, nextRunAt: Date, patch: Patch = {}) {
  return settleJob(db, job, { status: "WAITING", nextRunAt, ...patch });
}

/** Chưa tới lượt (giới hạn đồng thời) — không tốn một lần thử. */
export function deferJob(db: Db, job: VideoJobRow, nextRunAt: Date) {
  return settleJob(db, job, { status: job.status === "WAITING" ? "WAITING" : "QUEUED", nextRunAt });
}

export function blockJob(db: Db, job: VideoJobRow, reason: string, recheckAt: Date, patch: Patch = {}) {
  return settleJob(db, job, { status: "BLOCKED", error: reason.slice(0, 1000), errorKind: "BLOCKED", nextRunAt: recheckAt, ...patch });
}

/** Thử lại được ⇒ `QUEUED` sau khoảng lùi; hết lượt hoặc lỗi không thử lại được ⇒ `FAILED`. Trả trạng thái mới. */
export async function failOrRetryJob(db: Db, job: VideoJobRow, now: Date, error: string, kind: VideoErrorKind, patch: Patch = {}): Promise<"QUEUED" | "FAILED"> {
  const retryable = (kind === "TRANSIENT" || kind === "TIMEOUT") && job.attempts < job.maxAttempts;
  if (retryable) {
    await settleJob(db, job, { status: "QUEUED", error: error.slice(0, 1000), errorKind: kind, nextRunAt: new Date(now.getTime() + retryDelayMs(job.attempts)), ...patch });
    return "QUEUED";
  }
  await settleJob(db, job, { status: "FAILED", error: error.slice(0, 1000), errorKind: kind, finishedAt: now, ...patch });
  return "FAILED";
}

/**
 * NGƯỜI bấm "Thử lại" một việc hỏng. Với việc `AMBIGUOUS` đây là lời chấp nhận rủi ro trả tiền hai lần — nơi gọi (server
 * action) ghi nhật ký người bấm. Không cầm khoá: chỉ đổi dòng đang `FAILED` / `BLOCKED` và không ai đang cầm.
 */
export async function resetJob(db: Db, jobId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(j)
    .set({ status: "QUEUED", attempts: 0, error: "", errorKind: "", providerRef: "", providerPendingAt: null, reservedUsd: null, nextRunAt: now, finishedAt: null, lockedUntil: null, lockToken: "" })
    .where(and(eq(j.id, jobId), inArray(j.status, ["FAILED", "BLOCKED"]), or(isNull(j.lockedUntil), lt(j.lockedUntil, now))))
    .returning({ id: j.id });
  return rows.length > 0;
}

/** Huỷ mọi việc chưa xong của một lượt / biến thể (việc đang bị cầm cũng huỷ — lượt đang cầm sẽ mất khoá khi chốt). */
export async function cancelJobs(db: Db, where: { runId?: string; variantId?: string }, now: Date): Promise<number> {
  const cond = where.variantId ? eq(j.variantId, where.variantId) : where.runId ? eq(j.runId, where.runId) : sql`false`;
  const rows = await db
    .update(j)
    .set({ status: "CANCELLED", finishedAt: now, lockedUntil: null, lockToken: "" })
    .where(and(cond, inArray(j.status, ["QUEUED", "RUNNING", "WAITING", "BLOCKED"])))
    .returning({ id: j.id });
  return rows.length;
}

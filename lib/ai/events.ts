/**
 * BUS SỰ KIỆN NỘI BỘ của nền tảng nhân sự AI.
 *
 * Ba việc, không hơn: ghi sự kiện (chống trùng), tạo việc cho nhân sự đã đăng ký nhận loại đó,
 * và đánh dấu đã điều phối. Bus KHÔNG tự chạy nhân sự nào — chạy là việc của dây chuyền, để một
 * gói tin webhook không bao giờ phải chờ một lời gọi mô hình.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { getAiSettings } from "@/lib/ai/config";
import { agentsForEvent, ensureAgents, getAgent } from "@/lib/ai/registry";
import { AI_EVENT_TYPES, type AiEventInput, type AiEventType } from "@/lib/constants/ai-events";
import { AI_ERROR_SCOPES, type AiErrorScope } from "@/lib/constants/ai";

export type EmitResult = { id: string; duplicate: boolean; deliveryCount: number };

/**
 * Ghi một sự kiện. Trùng `dedupeKey` thì KHÔNG đẻ dòng mới — chỉ đếm thêm một lần đẩy, y hệt
 * cách `storeWebhook` xử lý các lần thử lại của Viettel Post. Không có khoá thì vẫn ghi bình
 * thường: không nhận dạng được KHÔNG phải lý do để mất sự kiện.
 */
export async function emitAiEvent(input: AiEventInput, db?: Db): Promise<EmitResult> {
  const conn = db ?? (await getDb());
  const dedupeKey = input.dedupeKey || null;
  if (dedupeKey) {
    const [bumped] = await conn
      .update(schema.aiEvents)
      .set({ deliveryCount: sql`${schema.aiEvents.deliveryCount} + 1` })
      .where(eq(schema.aiEvents.dedupeKey, dedupeKey))
      .returning({ id: schema.aiEvents.id, deliveryCount: schema.aiEvents.deliveryCount });
    if (bumped) return { id: bumped.id, duplicate: true, deliveryCount: Number(bumped.deliveryCount) };
  }
  const [row] = await conn
    .insert(schema.aiEvents)
    .values({
      type: input.type,
      source: input.source,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: input.payload ?? null,
      dedupeKey,
      occurredAt: input.occurredAt ?? null,
    })
    .returning({ id: schema.aiEvents.id });
  return { id: row.id, duplicate: false, deliveryCount: 1 };
}

/**
 * Biến một sự kiện thành việc cho từng nhân sự đã đăng ký nhận loại đó.
 * Nhân sự đang `OFF` không nhận việc — và điều đó được ghi là `IGNORED`, không im lặng.
 */
export async function dispatchAiEvent(eventId: string, db?: Db): Promise<{ tasks: string[]; skipped: string[] }> {
  const conn = db ?? (await getDb());
  const event = await conn.query.aiEvents.findFirst({ where: eq(schema.aiEvents.id, eventId) });
  if (!event) return { tasks: [], skipped: [] };
  if (event.status === "DISPATCHED") return { tasks: [], skipped: [] };

  const settings = await getAiSettings();
  const type = event.type as AiEventType;
  if (!(AI_EVENT_TYPES as readonly string[]).includes(type)) {
    await conn.update(schema.aiEvents).set({ status: "IGNORED", error: `Loại sự kiện lạ: ${event.type}` }).where(eq(schema.aiEvents.id, eventId));
    return { tasks: [], skipped: [] };
  }

  await ensureAgents(conn);
  const tasks: string[] = [];
  const skipped: string[] = [];
  for (const definition of agentsForEvent(type)) {
    const agent = await getAgent(definition.key, settings, conn);
    if (!agent || agent.mode === "OFF") {
      skipped.push(definition.key);
      continue;
    }
    // Một sự kiện sinh ĐÚNG MỘT việc cho mỗi nhân sự, kể cả khi sự kiện được đẩy lại nhiều lần.
    const dedupeKey = `${definition.key}|${event.id}`;
    const [row] = await conn
      .insert(schema.aiTasks)
      .values({
        agentId: agent.id,
        eventId: event.id,
        kind: type,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        payload: event.payload ?? null,
        dedupeKey,
      })
      .onConflictDoNothing({ target: schema.aiTasks.dedupeKey })
      .returning({ id: schema.aiTasks.id });
    if (row) tasks.push(row.id);
  }
  await conn
    .update(schema.aiEvents)
    .set({ status: tasks.length ? "DISPATCHED" : "IGNORED", dispatchedAt: new Date() })
    .where(eq(schema.aiEvents.id, eventId));
  return { tasks, skipped };
}

/** Ghi + điều phối trong một lời gọi (đường dùng thường xuyên nhất). */
export async function emitAndDispatch(input: AiEventInput, db?: Db) {
  const emitted = await emitAiEvent(input, db);
  // Sự kiện trùng vẫn được điều phối lại: lần trước có thể đã hỏng giữa chừng, và tạo việc là
  // idempotent nên chạy lại không đẻ thêm gì.
  const dispatched = await dispatchAiEvent(emitted.id, db);
  return { ...emitted, ...dispatched };
}


/**
 * Nhận việc (một lượt). Cập nhật có ĐIỀU KIỆN trên `status = 'PENDING'` nên hai tiến trình cùng
 * giành một việc thì chỉ một tiến trình nhận được — không cần khoá riêng.
 */
export async function claimTask(taskId: string, db?: Db): Promise<boolean> {
  const conn = db ?? (await getDb());
  const rows = await conn
    .update(schema.aiTasks)
    .set({ status: "RUNNING", startedAt: new Date(), attempts: sql`${schema.aiTasks.attempts} + 1` })
    .where(and(eq(schema.aiTasks.id, taskId), eq(schema.aiTasks.status, "PENDING")))
    .returning({ id: schema.aiTasks.id });
  return rows.length > 0;
}

export async function finishTask(taskId: string, status: "DONE" | "FAILED" | "CANCELLED", error?: string | null, db?: Db) {
  const conn = db ?? (await getDb());
  await conn
    .update(schema.aiTasks)
    .set({ status, finishedAt: new Date(), lastError: error ? error.slice(0, 2000) : null })
    .where(eq(schema.aiTasks.id, taskId));
}

/** Ghi một lỗi của nền tảng. Không bao giờ ném tiếp — ghi lỗi mà làm sập việc thì mất cả hai. */
export async function recordAiError(params: {
  scope: AiErrorScope;
  message: string;
  agentKey?: string;
  runId?: string | null;
  subjectType?: string;
  subjectId?: string;
  detail?: unknown;
}, db?: Db) {
  try {
    const conn = db ?? (await getDb());
    const scope = (AI_ERROR_SCOPES as readonly string[]).includes(params.scope) ? params.scope : "PIPELINE";
    await conn.insert(schema.aiErrors).values({
      scope,
      agentKey: params.agentKey ?? "",
      runId: params.runId ?? null,
      subjectType: params.subjectType ?? "",
      subjectId: params.subjectId ?? "",
      message: params.message.slice(0, 2000),
      detail: (params.detail ?? null) as object | null,
    });
  } catch {
    // im lặng: một lỗi khi ghi lỗi không được kéo theo việc chính
  }
}

/** Số lượt chạy trong một giờ qua — dùng để chặn vòng lặp tốn tiền. */
export async function runsInLastHour(db?: Db): Promise<number> {
  const conn = db ?? (await getDb());
  const since = new Date(Date.now() - 3_600_000);
  const [row] = await conn
    .select({ n: sql<number>`count(*)` })
    .from(schema.aiRuns)
    .where(gte(schema.aiRuns.startedAt, since));
  return Number(row?.n ?? 0);
}

/**
 * BUS SỰ KIỆN NỘI BỘ của nền tảng nhân sự AI.
 *
 * Ba việc, không hơn: ghi sự kiện (chống trùng), tạo việc cho nhân sự đã đăng ký nhận loại đó,
 * và đánh dấu đã điều phối. Bus KHÔNG tự chạy nhân sự nào — chạy là việc của dây chuyền, để một
 * gói tin webhook không bao giờ phải chờ một lời gọi mô hình.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { agentsForEvent, ensureAgents, getAgent } from "@/lib/ai-workforce/registry";
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
  /**
   * MỘT QUAN SÁT LẶP LẠI KHÔNG ĐƯỢC ĐẺ RA MỘT DÒNG MỚI.
   *
   * Đo production 22/09/2026: bốn tin nhắn sinh ra **17.962 dòng** lỗi "hai đường nạp đánh mã
   * khác nhau" — 4.571 dòng cho MỘT tin. Nguyên nhân: cửa sổ đọc chồng lấn đọc lại cùng tin ấy
   * mỗi 45 giây, và lần nào cũng phát hiện lại đúng một mâu thuẫn đã biết rồi ghi thêm một dòng.
   * Chú thích ở nơi gọi đã ghi "Ghi lại MỘT lần" nhưng không có gì thực thi điều đó.
   *
   * Một bảng lỗi mà 99,98% số dòng nói về bốn sự việc là một bảng không ai mở lần thứ hai, và
   * con số "18.000 lỗi" đọc lên như một hệ thống đang sụp đổ trong khi sự thật là bốn tin nhắn.
   *
   * `once: true` ⇒ khoá tự nhiên là (phạm vi · đối tượng · nguyên văn thông báo). Đã có dòng ấy
   * thì KHÔNG ghi thêm — chỉ đếm thêm một lần gặp vào `detail`, y hệt cách `emitAiEvent` đếm
   * `deliveryCount` và cách `storeWebhook` xử lý các lần thử lại của Viettel Post.
   *
   * Số lần gặp KHÔNG bị vứt đi: nó là thứ phân biệt "một trục trặc thoáng qua" với "một mâu
   * thuẫn đang sống", và người đọc cần nó để biết có phải đi sửa hay không.
   */
  once?: boolean;
}, db?: Db) {
  try {
    const conn = db ?? (await getDb());
    const scope = (AI_ERROR_SCOPES as readonly string[]).includes(params.scope) ? params.scope : "PIPELINE";
    const message = params.message.slice(0, 2000);
    const subjectId = params.subjectId ?? "";

    if (params.once) {
      const daCo = await conn.query.aiErrors.findFirst({
        where: and(eq(schema.aiErrors.scope, scope), eq(schema.aiErrors.subjectId, subjectId), eq(schema.aiErrors.message, message)),
        columns: { id: true, detail: true },
      });
      if (daCo) {
        const cu = (daCo.detail ?? {}) as Record<string, unknown>;
        const lanDaGap = Number(cu.seen);
        await conn
          .update(schema.aiErrors)
          .set({ detail: { ...cu, seen: (Number.isFinite(lanDaGap) ? lanDaGap : 1) + 1, lastSeenAt: new Date().toISOString() } })
          .where(eq(schema.aiErrors.id, daCo.id));
        return;
      }
    }

    await conn.insert(schema.aiErrors).values({
      scope,
      agentKey: params.agentKey ?? "",
      runId: params.runId ?? null,
      subjectType: params.subjectType ?? "",
      subjectId,
      message,
      detail: (params.once
        ? { ...((params.detail ?? {}) as Record<string, unknown>), seen: 1, lastSeenAt: new Date().toISOString() }
        : (params.detail ?? null)) as object | null,
    });
  } catch {
    // im lặng: một lỗi khi ghi lỗi không được kéo theo việc chính
  }
}

/**
 * CHI TIÊU MÔ HÌNH TRONG 24 GIỜ QUA — và SỐ LƯỢT KHÔNG ĐỊNH GIÁ ĐƯỢC, đứng cạnh nhau.
 *
 * Hai con số phải đi CÙNG NHAU, vì một mình con số tiền là một lời nói dối có thể chứng minh:
 * `cost_vnd` là `NULL` với mọi lượt gọi mà bảng giá chưa khai mô hình ấy, và `sum()` của toàn
 * `NULL` trả về `NULL` → quy thành 0 → một cái trần đọc "đã tiêu 0đ" trong khi thực tế vừa gọi
 * mô hình 660 lượt.
 *
 * Đo production 22/09/2026: **660/1.065 lượt chạy có chi phí CHƯA BIẾT**, tổng "đã tính" là 0 ₫
 * — vì bảng giá chỉ khai `claude-*` trong khi hệ thống chạy `gpt-5.6-*`. Một cái trần dựng trên
 * con số ấy sẽ KHÔNG BAO GIỜ nổ, và một cái trần không bao giờ nổ tệ hơn không có trần: nó làm
 * người vận hành tin rằng có ai đó đang canh.
 *
 * Nên hàm này không trả về một con số. Nó trả về cả phần ĐO ĐƯỢC lẫn phần MÙ, và người gọi phải
 * xử lý phần mù một cách tường minh.
 */
export async function modelSpendLast24h(db?: Db): Promise<{ vnd: number; unpricedCalls: number }> {
  const conn = db ?? (await getDb());
  const since = new Date(Date.now() - 86_400_000);
  const [row] = await conn
    .select({
      vnd: sql<number>`coalesce(sum(${schema.aiModelCalls.costVnd}), 0)`,
      unpriced: sql<number>`count(*) filter (where ${schema.aiModelCalls.costVnd} is null)`,
    })
    .from(schema.aiModelCalls)
    .where(gte(schema.aiModelCalls.createdAt, since));
  return { vnd: Number(row?.vnd ?? 0), unpricedCalls: Number(row?.unpriced ?? 0) };
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

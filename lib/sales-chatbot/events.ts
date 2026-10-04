/**
 * ═══════════ SỔ SỰ KIỆN HỘI THOẠI BÁN HÀNG — PHẦN MÁY CHỦ (0199) ═══════════
 *
 * Ghi `sales_conversation_events` trong CSDL của tổ chức NGỮ CẢNH (`getDb()`). Ba đường vào, không đường nào đổi hành vi bot:
 *
 *  1. `withTurnEvents(chatTurnCore)` — bọc MỘT lượt hội thoại: chụp trạng thái trước, chạy lượt, so ảnh sau
 *     (`deriveTurnEvents`, hàm thuần) rồi ghi. Mọi kênh đi qua `chatTurn` (khung thử · web · widget · fanpage · Messenger) được
 *     phủ mà không cần móc nào trong vòng công cụ.
 *  2. `recordConversationEvent()` — sự việc xảy ra NGOÀI lượt: nhân viên nhận hội thoại, trả lại AI, nhắc khách, AI ghi đơn
 *     hộ nhân viên.
 *  3. `linkAgentOrder()` — đơn của AI mang khoá `orders.sales_conversation_id` + `origin` (chỉ ghi khi còn trống: không bao giờ
 *     đè lên một khoá đã có).
 *
 * GHI SAU, KHÔNG TRONG GIAO DỊCH CỦA LƯỢT (bài học luật 51): lỗi ghi sổ không được làm khách mất câu trả lời. Lỗi KHÔNG bị
 * nuốt im — in `[sales-events]` ra log máy chủ, và màn hiệu quả đo độ phủ của sổ (hội thoại có lượt mà không có sự kiện).
 */
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { deriveTurnEvents, purchaseCycle, SALES_EVENT_SCHEMA_VERSION, type SalesEventActor, type SalesEventDraft, type SalesEventType, type TurnMessage, type TurnSnapshot } from "@/lib/sales-chatbot/events-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";

export type OrderOrigin = "AI_AGENT" | "AI_ORDER_SYNC";

function logFailure(where: string, conversationId: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[sales-events] ${where} · hội thoại ${conversationId}: ${msg.slice(0, 300)}`);
}

async function snapshot(conversationId: string): Promise<(TurnSnapshot & { channel: string }) | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db
    .select({ channel: c.channel, status: c.status, handoffReason: c.handoffReason, state: c.state, turns: c.turns, quickReplies: c.quickReplies, aiCalls: c.aiCalls })
    .from(c)
    .where(eq(c.id, conversationId))
    .limit(1);
  if (!row) return null;
  const m = schema.salesChatMessages;
  const [mx] = await db.select({ seq: sql<number>`coalesce(max(${m.seq}), 0)::int` }).from(m).where(eq(m.conversationId, conversationId));
  return { channel: row.channel, status: row.status, handoffReason: row.handoffReason, state: (row.state ?? {}) as ChatState, maxSeq: Number(mx?.seq ?? 0), turns: row.turns, quickReplies: row.quickReplies, aiCalls: row.aiCalls };
}

/** Ghi các bản nháp sự kiện — khoá chống trùng `<hội thoại>:<key>`; ghi lại cùng sự việc là không làm gì. */
export async function insertSalesEvents(conversationId: string, channel: string, cycle: number, drafts: readonly SalesEventDraft[]): Promise<number> {
  if (!drafts.length) return 0;
  const db = await getDb();
  const rows = await db
    .insert(schema.salesConversationEvents)
    .values(
      drafts.map((d) => ({
        conversationId,
        cycle,
        type: d.type,
        actorKind: d.actorKind,
        actorUserId: d.actorUserId ?? null,
        channel,
        occurredAt: d.occurredAt,
        orderId: d.orderId ?? null,
        amountVnd: d.amountVnd ?? null,
        reasonCode: d.reasonCode ?? null,
        payload: d.payload ?? {},
        dedupeKey: `${conversationId}:${d.key}`,
        schemaVersion: SALES_EVENT_SCHEMA_VERSION,
      })),
    )
    .onConflictDoNothing({ target: schema.salesConversationEvents.dedupeKey })
    .returning({ id: schema.salesConversationEvents.id });
  return rows.length;
}

/**
 * Gắn đơn THẬT của AI về hội thoại. Chỉ ghi khi đơn chưa mang khoá hội thoại nào (không đè), và chỉ đơn tạo trong ERP (`erp-`) —
 * đơn đồng bộ từ Pancake không bao giờ do bot ERP tạo.
 */
export async function linkAgentOrder(orderId: string | null | undefined, conversationId: string, origin: OrderOrigin): Promise<void> {
  if (!orderId || !orderId.startsWith("erp-")) return;
  try {
    const db = await getDb();
    const o = schema.orders;
    await db
      .update(o)
      .set({ salesConversationId: conversationId, origin: sql`coalesce(${o.origin}, ${origin})` })
      .where(and(eq(o.id, orderId), isNull(o.salesConversationId)));
  } catch (error) {
    logFailure(`gắn đơn ${orderId}`, conversationId, error);
  }
}

async function recordTurn(conversationId: string, before: TurnSnapshot & { channel: string }): Promise<void> {
  const after = await snapshot(conversationId);
  if (!after) return;
  const db = await getDb();
  const m = schema.salesChatMessages;
  const rows = await db
    .select({ seq: m.seq, role: m.role, content: m.content, at: m.createdAt })
    .from(m)
    .where(and(eq(m.conversationId, conversationId), gt(m.seq, before.maxSeq)))
    .orderBy(asc(m.seq));
  const messages: TurnMessage[] = rows.map((r) => ({ seq: r.seq, role: r.role === "assistant" ? "assistant" : "user", content: (Array.isArray(r.content) ? r.content : []) as AiBlock[], at: r.at }));
  const cycle = purchaseCycle(after.state);
  // Chỉ cần đọc sổ khi lượt này có thể sinh «upsell.declined» (đơn vừa chốt sau lời mời).
  let acceptedInCycle = false;
  if (after.state.confirmed && !before.state.confirmed && after.state.upsellSent) {
    const e = schema.salesConversationEvents;
    const [hit] = await db
      .select({ id: e.id })
      .from(e)
      .where(and(eq(e.conversationId, conversationId), eq(e.cycle, cycle), eq(e.type, "upsell.accepted")))
      .limit(1);
    acceptedInCycle = Boolean(hit);
  }
  const drafts = deriveTurnEvents({ before, after, messages, acceptedInCycle });
  await insertSalesEvents(conversationId, after.channel, cycle, drafts);
  for (const d of drafts) if ((d.type === "order.drafted" || d.type === "order.confirmed") && d.orderId) await linkAgentOrder(d.orderId, conversationId, "AI_AGENT");
}

/**
 * Bọc một hàm LƯỢT HỘI THOẠI (tham số đầu là mã hội thoại). Hành vi của hàm gốc không đổi: cùng kết quả, cùng lỗi ném ra;
 * phần ghi sổ chạy SAU và không bao giờ làm hỏng lượt.
 */
export function withTurnEvents<A extends [conversationId: string, ...rest: unknown[]], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const id = args[0];
    const before = await snapshot(id).catch((error: unknown) => {
      logFailure("chụp trước lượt", id, error);
      return null;
    });
    const result = await fn(...args);
    if (before) await recordTurn(id, before).catch((error: unknown) => logFailure("ghi sự kiện lượt", id, error));
    return result;
  };
}

/**
 * Một sự việc NGOÀI lượt hội thoại. `key` phải tất định theo sự việc (vd mã tin, mã đơn) để ghi lại không đẻ dòng thứ hai.
 * Không bao giờ ném: lỗi in `[sales-events]`.
 */
export async function recordConversationEvent(
  conversationId: string,
  ev: { type: SalesEventType; actorKind: SalesEventActor; actorUserId?: string | null; occurredAt: Date; orderId?: string | null; amountVnd?: number | null; reasonCode?: string | null; payload?: Record<string, unknown>; key: string },
): Promise<void> {
  try {
    const db = await getDb();
    const c = schema.salesChatConversations;
    const [row] = await db.select({ channel: c.channel, state: c.state }).from(c).where(eq(c.id, conversationId)).limit(1);
    if (!row) return;
    await insertSalesEvents(conversationId, row.channel, purchaseCycle((row.state ?? {}) as ChatState), [ev]);
  } catch (error) {
    logFailure(ev.type, conversationId, error);
  }
}

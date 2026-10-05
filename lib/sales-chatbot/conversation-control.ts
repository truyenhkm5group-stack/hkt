import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { publish } from "@/lib/realtime/bus";
import {
  botSendVerdict,
  CONVERSATION_CONTROLS,
  normalizeControlReason,
  readConversationControl,
  TAKEOVER_REASON,
  type ControlStamp,
  type ConversationControl,
  type SendSnapshot,
} from "@/lib/sales-chatbot/conversation-control-shared";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";

/**
 * ═══════════ ĐỔI CHẾ ĐỘ AI ↔ NGƯỜI CỦA MỘT HỘI THOẠI + CỔNG GỬI CỦA BOT ═══════════
 *
 * Luật ở `conversation-control-shared.ts`. Tệp này là hai đường có CSDL:
 *  · `setConversationControlCore` — Tiếp quản / AI gợi ý / Trả lại AI từ hộp thư: quyền → ghi CÓ ĐIỀU KIỆN trên ảnh chụp cũ
 *    (hai người bấm cùng lúc ⇒ đúng một người thắng, người kia được báo tải lại) → sổ sự kiện → nhật ký (trước → sau + lý do).
 *    Bấm lại đúng chế độ đang có ⇒ KHÔNG ghi gì (luật 61).
 *  · `botMaySend` — lối vào kênh gọi NGAY TRƯỚC khi gửi từng câu bot đã soạn.
 */

const VIEW = "ai_sales:view";
const MANAGE = "ai_sales:manage";

export type ControlResult = { ok: true; mode: ConversationControl; changed: boolean } | { ok: false; error: string };

/** Người trả lời khách (cùng khoá với hộp thư) hoặc người quản lý chatbot. */
function canControl(user: SessionUser): boolean {
  return can(user, VIEW) && (can(user, "ai_sales:reply") || can(user, "outreach:send") || can(user, MANAGE));
}

export async function setConversationControlCore(user: SessionUser, conversationId: unknown, rawMode: unknown, rawReason?: unknown): Promise<ControlResult> {
  if (!canControl(user)) return { ok: false, error: "Bạn không có quyền đổi chế độ AI của hội thoại (ai_sales:reply)." };
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 100) return { ok: false, error: "Không có hội thoại này." };
  const mode = (CONVERSATION_CONTROLS as readonly string[]).includes(String(rawMode)) ? (rawMode as ConversationControl) : null;
  if (!mode) return { ok: false, error: "Chế độ không hợp lệ." };
  const reason = normalizeControlReason(rawReason);
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db
    .select({ id: c.id, channel: c.channel, status: c.status, handoffReason: c.handoffReason, state: c.state })
    .from(c)
    .where(eq(c.id, conversationId))
    .limit(1);
  if (!conv || conv.channel === "TEST") return { ok: false, error: "Không có hội thoại này." };
  // Chat web không có hội thoại bóng cho Copilot (bot trả lời ngay trong khung chat của khách).
  if (mode === "COPILOT" && conv.channel === "WEB") return { ok: false, error: "Chat web chưa hỗ trợ chế độ AI gợi ý — chọn «Người xử lý» hoặc «AI tự trả lời»." };

  const prev = readConversationControl(conv.state);
  const prevMode: ConversationControl = prev?.mode ?? "AUTO";
  // Đúng chế độ đang có ⇒ không ghi gì. Ngoại lệ: AUTO trên hội thoại đang NHƯỜNG (nhân viên vừa trả lời / AI xin người) là
  // «Trả lại cho AI» — vẫn phải mở lại hội thoại.
  if (prevMode === mode && !(mode === "AUTO" && conv.status === "HANDOFF")) return { ok: true, mode, changed: false };

  const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  const at = new Date();
  const stamp: ControlStamp | null = mode === "AUTO" ? null : { mode, byUserId: user.id, byName: me?.name ?? user.email, at: at.toISOString(), reason };
  // Ghi CÓ ĐIỀU KIỆN: ảnh chụp chế độ chưa đổi kể từ lúc đọc (mốc `at` của ảnh chụp là định danh của nó).
  const unchanged = and(eq(c.id, conv.id), sql`coalesce(${c.state}->'control'->>'at', '') = ${prev?.at ?? ""}`);
  const base = sql`coalesce(${c.state}, '{}'::jsonb)`;
  const set =
    mode === "HUMAN"
      ? {
          // Lý do TIẾP QUẢN không thuộc nhóm tự hết hạn 30 phút ⇒ bot im tới khi người trả lại. Lý do cũ còn ở nhật ký.
          state: sql`${base} || ${JSON.stringify({ control: stamp })}::jsonb`,
          status: "HANDOFF",
          handoffReason: TAKEOVER_REASON,
          nextFollowupAt: null,
          assigneeUserId: sql`coalesce(${c.assigneeUserId}, ${user.id})`,
          assignedAt: sql`coalesce(${c.assignedAt}, ${at})`,
          updatedAt: at,
        }
      : mode === "COPILOT"
        ? { state: sql`(${base} - 'handoff') || ${JSON.stringify({ control: stamp })}::jsonb`, status: sql`case when ${c.status} = 'HANDOFF' then 'OPEN' else ${c.status} end`, handoffReason: null, updatedAt: at }
        : { state: sql`${base} - 'control' - 'handoff'`, status: sql`case when ${c.status} = 'HANDOFF' then 'OPEN' else ${c.status} end`, handoffReason: null, updatedAt: at };
  const [row] = await db.update(c).set(set).where(unchanged).returning({ status: c.status });
  if (!row) return { ok: false, error: "Hội thoại vừa được người khác đổi chế độ — tải lại để xem chế độ hiện tại." };

  if (mode === "HUMAN" && conv.status !== "HANDOFF") {
    await recordConversationEvent(conv.id, { type: "human.took_over", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, reasonCode: "STAFF_TOOK_OVER", payload: reason ? { reason } : {}, key: `control:${at.toISOString()}` });
  }
  if (mode === "AUTO" && conv.status === "HANDOFF") {
    await recordConversationEvent(conv.id, { type: "ai.resumed", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, key: `control:${at.toISOString()}` });
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SALES_CHAT_CONTROL_SET",
    entity: "SALES_CONVERSATION",
    entityId: conv.id,
    before: { mode: prevMode, status: conv.status, handoffReason: conv.handoffReason },
    after: { mode, status: row.status },
    reason: reason ?? (mode === "HUMAN" ? "Tiếp quản từ hộp thư" : mode === "AUTO" ? "Trả lại cho AI từ hộp thư" : "Chuyển sang AI gợi ý từ hộp thư"),
  });
  publish({ type: "chat", conversationId: conv.id });
  return { ok: true, mode, changed: true };
}

async function readSendSnapshot(conversationId: string): Promise<SendSnapshot | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db.select({ status: c.status, state: c.state, lastStaffAt: c.lastStaffAt }).from(c).where(eq(c.id, conversationId)).limit(1);
  return row ?? null;
}

/** Ảnh chụp lúc BẮT ĐẦU lượt — lối vào kênh gọi ngay TRƯỚC `chatTurn`. */
export async function captureSendSnapshot(conversationId: string): Promise<SendSnapshot | null> {
  return readSendSnapshot(conversationId);
}

/**
 * Đọc lại hội thoại và hỏi bot còn được gửi không (`botSendVerdict`). Không có ảnh chụp đầu lượt / không đọc lại được ⇒ KHÔNG
 * gửi: nghi ngờ thì để người — một câu bot bị giữ lại rẻ hơn một câu bot đè lên câu của nhân viên.
 */
export async function botMaySend(conversationId: string, before: SendSnapshot | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = before ? await readSendSnapshot(conversationId) : null;
  if (!before || !now) return { ok: false, reason: "Không đọc lại được hội thoại — bot không gửi" };
  return botSendVerdict(before, now);
}

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
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
import { aiHoldOf, cooldownUntilFrom, humanResumeReason, type AiHold, type AiHoldInput } from "@/lib/sales-chatbot/ai-hold-shared";
import { controlOf, controlSkipNote, NEEDS_HUMAN_NOTE } from "@/lib/sales-chatbot/conversation-control-shared";

/**
 * ═══════════ ĐỔI CHẾ ĐỘ AI ↔ NGƯỜI CỦA MỘT HỘI THOẠI + CỔNG GỬI CỦA BOT ═══════════
 *
 * Luật ở `conversation-control-shared.ts`. Tệp này là hai đường có CSDL:
 *  · `setConversationControlCore` — Tiếp quản / AI gợi ý / Trả lại AI từ hộp thư: quyền → ghi CÓ ĐIỀU KIỆN trên ảnh chụp cũ
 *    (hai người bấm cùng lúc ⇒ đúng một người thắng, người kia được báo tải lại) → sổ sự kiện → nhật ký (trước → sau + lý do).
 *    Bấm lại đúng chế độ đang có ⇒ KHÔNG ghi gì (luật 61).
 *  · `botMaySend` — lối vào kênh gọi NGAY TRƯỚC khi gửi từng câu bot đã soạn.
 *  · `holdGate` — MỌI đường xử lý tin khách (Pancake · Messenger · Zalo) hỏi trước khi gọi AI: đang nhường / tiếp quản ⇒ tin đã
 *    lưu, KHÔNG gọi AI, KHÔNG gửi; nhường hết hạn ⇒ mở lại hội thoại + ghi `ai.resumed` (COOLDOWN_EXPIRED, MÁY).
 *  · `startHumanCooldown` — MỌI đường nhận tin NHÂN VIÊN (hộp thư ERP · Pancake · Messenger · Zalo): AI nhường 30 phút tính từ
 *    câu mới nhất, ghi mốc hết hạn tường minh (0231), sự kiện bắt đầu / kết thúc nhường.
 * Luật trạng thái (AI_ACTIVE · HUMAN_COOLDOWN · HUMAN_TAKEOVER) ở `ai-hold-shared.ts::aiHoldOf` — một hàm thuần.
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
    .select({ id: c.id, channel: c.channel, status: c.status, handoffReason: c.handoffReason, state: c.state, updatedAt: c.updatedAt, humanCooldownUntil: c.humanCooldownUntil })
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
  // Trạng thái NGAY TRƯỚC khi bấm — quyết định sự kiện nào được ghi (cho AI tiếp tục ngay ≠ trả lại sau tiếp quản).
  const before = aiHoldOf(conv, at);
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
          // Tiếp quản KHÔNG hết hạn: mốc nhường 30 phút (nếu có) không còn nghĩa gì.
          humanCooldownUntil: null,
          assigneeUserId: sql`coalesce(${c.assigneeUserId}, ${user.id})`,
          assignedAt: sql`coalesce(${c.assignedAt}, ${at})`,
          updatedAt: at,
        }
      : mode === "COPILOT"
        ? { state: sql`(${base} - 'handoff') || ${JSON.stringify({ control: stamp })}::jsonb`, status: sql`case when ${c.status} = 'HANDOFF' then 'OPEN' else ${c.status} end`, handoffReason: null, humanCooldownUntil: null, updatedAt: at }
        : // «Cho AI tiếp tục ngay» (đang nhường) / «Trả lại cho AI» (đang tiếp quản / cần người): XOÁ mốc nhường ⇒ AI_ACTIVE ngay.
          { state: sql`${base} - 'control' - 'handoff'`, status: sql`case when ${c.status} = 'HANDOFF' then 'OPEN' else ${c.status} end`, handoffReason: null, humanCooldownUntil: null, updatedAt: at };
  const [row] = await db.update(c).set(set).where(unchanged).returning({ status: c.status });
  if (!row) return { ok: false, error: "Hội thoại vừa được người khác đổi chế độ — tải lại để xem chế độ hiện tại." };

  // Lần nhường đã hết hạn mà chưa ai dọn (chưa có tin khách nào tới sau hạn) ⇒ ghi nốt mốc kết thúc của nó (MÁY).
  await recordCooldownExpired(conv.id, before);
  // Tiếp quản: ghi mỗi lần chuyển SANG tiếp quản — kể cả từ lúc đang nhường 30 phút (bản trước bỏ sót vì hội thoại đã `HANDOFF`).
  if (mode === "HUMAN" && prevMode !== "HUMAN") {
    await recordConversationEvent(conv.id, { type: "human.took_over", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, reasonCode: "STAFF_TOOK_OVER", payload: { from: before.state, ...(reason ? { reason } : {}) }, key: `control:${at.toISOString()}` });
  }
  const resumeReason = mode === "AUTO" ? humanResumeReason(before) : null;
  if (resumeReason) {
    await recordConversationEvent(conv.id, { type: "ai.resumed", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, reasonCode: resumeReason, payload: { from: before.state, cause: before.cause, ...(before.until ? { cooldownUntil: before.until.toISOString() } : {}) }, key: `control:${at.toISOString()}` });
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: resumeReason === "RESUMED_NOW" ? "SALES_CHAT_AI_RESUME_NOW" : "SALES_CHAT_CONTROL_SET",
    entity: "SALES_CONVERSATION",
    entityId: conv.id,
    before: { mode: prevMode, status: conv.status, handoffReason: conv.handoffReason, hold: before.state, cooldownUntil: before.until?.toISOString() ?? null },
    after: { mode, status: row.status, hold: mode === "HUMAN" ? "HUMAN_TAKEOVER" : "AI_ACTIVE" },
    reason: reason ?? (mode === "HUMAN" ? "Tiếp quản từ hộp thư" : resumeReason === "RESUMED_NOW" ? "Cho AI tiếp tục ngay — bỏ thời gian nhường" : mode === "AUTO" ? "Trả lại cho AI từ hộp thư" : "Chuyển sang AI gợi ý từ hộp thư"),
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

// ─────────────────────────── Nhường người: một đường vào cho mọi kênh ───────────────────────────

/** Hội thoại đủ trường để `aiHoldOf` quyết định. */
export type HoldRow = AiHoldInput & { id: string };

/** Lần nhường 30 phút đã hết hạn ⇒ sự kiện `ai.resumed` (COOLDOWN_EXPIRED) của MÁY tại đúng mốc hết hạn — khoá theo mốc, ghi lại vô hại. */
async function recordCooldownExpired(conversationId: string, hold: AiHold): Promise<void> {
  if (hold.expired?.cause !== "STAFF_REPLY") return;
  const at = hold.expired.at;
  await recordConversationEvent(conversationId, { type: "ai.resumed", actorKind: "SYSTEM", actorUserId: null, occurredAt: at, reasonCode: "COOLDOWN_EXPIRED", payload: { cooldownUntil: at.toISOString() }, key: `cooldown-end:${at.toISOString()}` });
}

/**
 * Cổng NHƯỜNG NGƯỜI của đường xử lý tin khách — gọi SAU khi tin đã lưu và TRƯỚC mọi bước tốn tiền (AI, đọc ảnh, hỏi Pancake).
 * Trả `{ skip }` = chốt các tin này với ghi chú, KHÔNG gọi AI, KHÔNG gửi gì (tin vẫn nằm ở hộp thư cho người đọc). Trả `null` = đi
 * tiếp. Nhường đã hết hạn ⇒ mở lại hội thoại CÓ ĐIỀU KIỆN (nhân viên vừa gửi thêm một câu ⇒ mốc mới chưa tới ⇒ không mở, vẫn im).
 *
 * Tin khách tới TRONG lúc nhường đã được chốt SKIPPED ngay lúc tới — hết nhường / «Cho AI tiếp tục ngay» KHÔNG quay lại trả lời
 * chúng (có thể người đã trả lời câu đó); AI trả lời từ tin khách KẾ TIẾP, và vẫn thấy các tin cũ trong lịch sử của lượt.
 */
/**
 * Ghi chú của tin khách bỏ qua vì người đang cầm: nhường ⇒ đúng lý do nhường của kênh; tiếp quản ⇒ lý do tiếp quản; cần người ⇒
 * `NEEDS_HUMAN_NOTE: <lý do>` (tiền tố cố định để dấu vết đọc được). HÀM THUẦN.
 */
export function holdSkipNote(conv: Pick<HoldRow, "handoffReason" | "state">, hold: AiHold): string {
  if (hold.cause === "NEEDS_HUMAN") return conv.handoffReason ? `${NEEDS_HUMAN_NOTE}: ${conv.handoffReason}`.slice(0, 300) : NEEDS_HUMAN_NOTE;
  if (hold.cause === "TAKEOVER") return conv.handoffReason === TAKEOVER_REASON ? TAKEOVER_REASON : (controlSkipNote(controlOf(conv.state)) ?? TAKEOVER_REASON);
  return conv.handoffReason ?? NEEDS_HUMAN_NOTE;
}

export async function holdGate(conv: HoldRow, now: Date): Promise<{ skip: string } | null> {
  const hold = aiHoldOf(conv, now);
  if (hold.state !== "AI_ACTIVE") return { skip: holdSkipNote(conv, hold) };
  if (!hold.expired) return null;
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [reopened] = await db
    .update(c)
    .set({ status: "OPEN", handoffReason: null, state: sql`${c.state} - 'handoff'`, humanCooldownUntil: null, updatedAt: now })
    .where(and(eq(c.id, conv.id), eq(c.status, "HANDOFF"), conv.handoffReason ? eq(c.handoffReason, conv.handoffReason) : isNull(c.handoffReason), or(isNull(c.humanCooldownUntil), lte(c.humanCooldownUntil, now))))
    .returning({ id: c.id });
  if (!reopened) return { skip: conv.handoffReason ?? NEEDS_HUMAN_NOTE };
  await recordCooldownExpired(conv.id, hold);
  publish({ type: "chat", conversationId: conv.id });
  return null;
}

export type StaffReplyNote = {
  /** Lý do «nhân viên đang trả lời» của kênh (`FANPAGE_STAFF_REASON` / `ZALO_STAFF_REASON` / chat web). */
  reason: string;
  at: Date;
  /** `users.id` khi người gửi từ hộp thư ERP; `null` khi nhân viên gõ ngoài ERP (Pancake / Hộp thư Meta / OA) — không có danh tính. */
  actorUserId: string | null;
  /** Khoá chống trùng của sự kiện bắt đầu nhường (mã tin). */
  key: string;
  via: "ERP_INBOX" | "PANCAKE" | "MESSENGER" | "ZALO";
  /** Chỉ hộp thư ERP: người gửi cầm hội thoại (nếu chưa ai cầm) + mốc tin nhân viên + dừng nhắc khách. */
  inbox?: { userId: string };
};

/**
 * NHÂN VIÊN VỪA GỬI TAY ⇒ AI nhường `HUMAN_COOLDOWN_MINUTES` phút tính từ câu này. Đang CẦN NGƯỜI vì lý do khác (AI xin người,
 * tiếp quản) ⇒ giữ lý do đó — tiếp quản KHÔNG biến về nhường 30 phút (`aiHoldOf` để «Tiếp quản» thắng). Sự kiện:
 *  · lần nhường trước đã hết hạn mà chưa ai dọn ⇒ `ai.resumed` COOLDOWN_EXPIRED (MÁY) tại mốc hết hạn;
 *  · AI đang trả lời ⇒ `human.took_over` STAFF_REPLIED (bắt đầu nhường) mang `actor_user_id` + mốc hết hạn.
 * Trả trạng thái TRƯỚC câu này.
 */
export async function startHumanCooldown(conversationId: string, note: StaffReplyNote): Promise<AiHold | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db.select({ id: c.id, status: c.status, handoffReason: c.handoffReason, state: c.state, updatedAt: c.updatedAt, humanCooldownUntil: c.humanCooldownUntil }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!row) return null;
  const before = aiHoldOf(row, note.at);
  const until = cooldownUntilFrom(note.at);
  await recordCooldownExpired(row.id, before);
  await db
    .update(c)
    .set({
      status: "HANDOFF",
      handoffReason: sql`case when ${c.status} = 'HANDOFF' and ${c.handoffReason} is not null and ${c.handoffReason} <> ${note.reason} then ${c.handoffReason} else ${note.reason} end`,
      humanCooldownUntil: until,
      updatedAt: note.at,
      ...(note.inbox
        ? { lastStaffAt: note.at, nextFollowupAt: null, waitingSince: null, assigneeUserId: sql`coalesce(${c.assigneeUserId}, ${note.inbox.userId})`, assignedAt: sql`coalesce(${c.assignedAt}, ${note.at})` }
        : {}),
    })
    .where(eq(c.id, row.id));
  if (before.state === "AI_ACTIVE") {
    await recordConversationEvent(row.id, { type: "human.took_over", actorKind: "HUMAN", actorUserId: note.actorUserId, occurredAt: note.at, reasonCode: "STAFF_REPLIED", payload: { via: note.via, cooldownUntil: until.toISOString() }, key: note.key });
  }
  publish({ type: "chat", conversationId: row.id });
  return before;
}

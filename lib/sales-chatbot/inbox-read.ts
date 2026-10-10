import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { can, type SessionUser } from "@/lib/auth/session";
import { canReplyTo } from "@/lib/sales-chatbot/inbox";
import { CUSTOMER_INBOUND_ROW_SQL, CUSTOMER_MESSAGE_ROW_SQL, personalUnreadCountSql } from "@/lib/sales-chatbot/inbox-states";
import type { InboxReadConfirmation } from "@/lib/sales-chatbot/inbox-read-shared";

/**
 * ═══════════ ĐÁNH DẤU ĐỌC TỚI ĐÚNG TIN KHÁCH ĐÃ HIỆN (chủ shop 10/10/2026 tối, P0.3) ═══════════
 *
 * Trước bản này mở hội thoại ⇒ `loadInboxThread` ghi `staff_seen_at = now` (GIỜ MÁY CHỦ lúc nạp), chung cho cả cửa hàng. Tin khách
 * tới SAU câu SELECT của khung chat nhưng TRƯỚC câu UPDATE đó bị coi là «đã đọc» mà người chưa từng thấy; và một người mở thì mọi người
 * khác mất dấu «chưa đọc».
 *
 * Nay: khung chat trả kèm `readThrough` = tin KHÁCH CUỐI CÙNG có trong chính payload đó (mã dòng + mốc). Trình duyệt hiện khung chat
 * rồi gọi `POST /api/ai-sales/inbox-read` với MÃ DÒNG ấy; máy chủ tự đọc MỐC của dòng đó trong CSDL (không nhận mốc từ trình duyệt —
 * trình duyệt gửi giờ tương lai là tự xoá «chưa đọc» của tin chưa tới) và ghi con trỏ của RIÊNG người bấm:
 *  · chỉ TIẾN (`setWhere read_through_at < mốc mới`) — bấm lại hội thoại cũ / lượt trả lời đến trễ không kéo con trỏ lùi;
 *  · idempotent — gọi hai lần cùng tin không đổi gì (mốc `updated_at` giữ nguyên);
 *  · tin khách tới sau mốc ⇒ VẪN chưa đọc (điều kiện là `created_at > con trỏ`, không phải `> giờ bấm`).
 * `staff_seen_at` (mốc chung cũ) vẫn được đẩy tới CÙNG mốc tin khách — các chỗ đang đọc nó và người xem chưa có con trỏ riêng (chỗ lùi
 * của `readCursorSql`) giữ nguyên nghĩa. Chỉ người TRẢ LỜI được mới đẩy mốc chung (người chỉ xem không xoá dấu của đội) — như cũ.
 *
 * Trả về XÁC NHẬN để danh sách vá ngay (không đợi làm mới cả trang): số chưa đọc của NGƯỜI NÀY trước / sau lượt ghi và `stamp`
 * (`updated_at` của con trỏ) — trình duyệt so `stamp` với dấu của bản danh sách để biết bản nào cũ hơn lượt đọc.
 */

const NO_VIEW = "Bạn không có quyền xem hội thoại (ai_sales:view).";

export type InboxReadResult = { ok: true; read: InboxReadConfirmation } | { ok: false; error: string };

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isFinite(x.getTime()) ? x.toISOString() : null;
}

export async function markInboxReadCore(user: SessionUser, conversationId: unknown, throughId: unknown): Promise<InboxReadResult> {
  if (!can(user, "ai_sales:view")) return { ok: false, error: NO_VIEW };
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 100) return { ok: false, error: "Thiếu mã hội thoại." };
  if (typeof throughId !== "string" || !throughId || throughId.length > 100) return { ok: false, error: "Thiếu mã tin đã đọc tới." };
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ id: c.id, channel: c.channel, pageId: c.pageId, threadId: c.threadId }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv || conv.channel === "TEST") return { ok: false, error: "Không có hội thoại này." };

  // MỐC của tin khách đọc tới — đọc trong CSDL, đúng tới micro giây, và CHỈ khi dòng là tin KHÁCH thật của CHÍNH hội thoại này.
  const messaging = Boolean(conv.pageId && conv.threadId);
  const throughAt = messaging
    ? sql<Date>`(select i.created_at from "sales_chat_inbound" i where i.id = ${throughId} and i.page_id = ${conv.pageId} and i.thread_id = ${conv.threadId} and ${CUSTOMER_INBOUND_ROW_SQL})`
    : sql<Date>`(select m.created_at from "sales_chat_messages" m where m.id = ${throughId} and m.conversation_id = ${conv.id} and ${CUSTOMER_MESSAGE_ROW_SQL})`;
  const unreadOf = async () => {
    const [r] = await db.select({ n: personalUnreadCountSql(user.id), ok: sql<boolean>`${throughAt} is not null` }).from(c).where(eq(c.id, conv.id));
    return { n: Number(r?.n ?? 0), ok: Boolean(r?.ok) };
  };
  const before = await unreadOf();
  if (!before.ok) return { ok: false, error: "Tin đánh dấu đọc không thuộc hội thoại này." };

  const r = schema.salesChatReads;
  await db
    .insert(r)
    .values({ conversationId: conv.id, userId: user.id, readThroughAt: throughAt, readThroughMessageId: throughId, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: [r.conversationId, r.userId],
      set: { readThroughAt: sql`excluded.read_through_at`, readThroughMessageId: sql`excluded.read_through_message_id`, updatedAt: sql`now()` },
      setWhere: sql`${r.readThroughAt} < excluded.read_through_at`,
    });
  if (canReplyTo(user)) await db.update(c).set({ staffSeenAt: sql`greatest(coalesce(${c.staffSeenAt}, 'epoch'::timestamptz), ${throughAt})` }).where(eq(c.id, conv.id));

  const after = await unreadOf();
  const [row] = await db.select({ at: r.readThroughAt, stamp: r.updatedAt }).from(r).where(and(eq(r.conversationId, conv.id), eq(r.userId, user.id))).limit(1);
  return { ok: true, read: { conversationId: conv.id, throughAt: iso(row?.at), unreadBefore: before.n, unreadAfter: after.n, stamp: iso(row?.stamp) } };
}

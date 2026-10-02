/**
 * ═══════════ BOT LÊN ĐƠN → CHUÔNG ERP (CHỈ MÁY CHỦ) ═══════════
 *
 * Job `alerts` (10 phút/lần) gọi hàm này: hỏi bot danh sách "cần duyệt" rồi ghi HAI nơi như mọi tin của chatbot bán
 * hàng (`lib/sales-chatbot/alerts.ts`): hàng đợi chung `notifications` và hộp thư cá nhân của người có quyền mở trang
 * Bot chat (`cs:config`) — chuông luôn đọc hộp thư, kể cả tổ chức không bật «Cần xử lý». Quyết định mở/đóng ở hàm thuần
 * `planOrderBotAlerts`. Không gửi Lark/Telegram (không thêm kênh mới).
 *
 * Không hỏi được bot ⇒ trả lỗi, KHÔNG đóng thông báo nào: không biết thì không kết luận "đã xử lý xong".
 */
import { and, inArray, isNull, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { sendInboxMessages } from "@/lib/inbox/send";
import { chatbotFetch } from "@/lib/integrations/chatbot/client";
import { ORDERBOT_ALERT_HREF, ORDERBOT_ALERT_PREFIX, planOrderBotAlerts, type OrderBotReviewItem } from "@/lib/constants/chatbot-orderbot";

export type OrderBotAlertResult = { created: number; resolved: number; error: string | null };

export async function syncOrderBotReviewAlerts(now: Date = new Date()): Promise<OrderBotAlertResult> {
  let review: OrderBotReviewItem[];
  try {
    const res = await chatbotFetch("/api/orderbot", { timeoutMs: 5000 });
    if (!res.ok) return { created: 0, resolved: 0, error: `bot trả HTTP ${res.status}` };
    const body = (await res.json()) as { review?: OrderBotReviewItem[] };
    review = Array.isArray(body.review) ? body.review : [];
  } catch (e) {
    return { created: 0, resolved: 0, error: e instanceof Error ? e.message : String(e) };
  }
  const db = await getDb();
  const n = schema.notifications;
  const open = await db
    .select({ key: n.dedupeKey })
    .from(n)
    .where(and(like(n.dedupeKey, `${ORDERBOT_ALERT_PREFIX}%`), isNull(n.resolvedAt)));
  const plan = planOrderBotAlerts(
    review,
    open.map((r) => r.key),
  );
  let created = 0;
  if (plan.create.length) {
    const rows = await db
      .insert(n)
      .values(plan.create.map((a) => ({ kind: "SYSTEM", severity: "warning", title: a.title, body: a.body, href: ORDERBOT_ALERT_HREF, entityType: "CHATBOT_ORDER", entityId: a.conversationKey, dedupeKey: a.dedupeKey, occurredAt: now })))
      .onConflictDoNothing({ target: n.dedupeKey })
      .returning({ key: n.dedupeKey });
    created = rows.length;
    const moi = new Set(rows.map((r) => r.key));
    const users = moi.size ? await activeUserIdsWhoCan("cs:config") : [];
    await sendInboxMessages(
      plan.create.filter((a) => moi.has(a.dedupeKey)).flatMap((a) => users.map((userId) => ({ userId, kind: "CHATBOT_ORDER_REVIEW", title: a.title, body: a.body, href: ORDERBOT_ALERT_HREF, dedupeKey: `${a.dedupeKey}:${userId}` }))),
      db,
    );
  }
  let resolved = 0;
  if (plan.resolve.length) {
    const rows = await db
      .update(n)
      .set({ resolvedAt: now, resolution: "AUTO" })
      .where(and(inArray(n.dedupeKey, plan.resolve), isNull(n.resolvedAt)))
      .returning({ id: n.id });
    resolved = rows.length;
  }
  return { created, resolved, error: null };
}

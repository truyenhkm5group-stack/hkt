/**
 * ═══════════ CHATBOT BÁN HÀNG — BÁO NGƯỜI (CHỈ MÁY CHỦ) ═══════════
 *
 * Hai loại tin, mỗi loại ghi HAI nơi:
 *  · hàng đợi CHUNG `notifications` — như mọi cảnh báo, cho tổ chức bật module «Cần xử lý»;
 *  · HỘP THƯ CÁ NHÂN `user_messages` của đúng người có quyền — chuông luôn đọc hộp thư này, kể cả khi tổ chức KHÔNG bật
 *    «Cần xử lý». Đo UAT 30/09/2026: mẫu «Thực phẩm đóng gói» không bật module đó, nên mọi «chatbot chuyển khách cho
 *    nhân viên» chỉ nằm trong hàng đợi chung mà không ai đọc được — khách được hứa «đã chuyển nhân viên» và không ai gọi.
 *
 * Người nhận chọn bằng `activeUserIdsWhoCan` — đúng `can()` mà trang dùng, không tính quyền lần thứ hai. Chống gửi trùng ở
 * CSDL (khoá duy nhất `dedupe_key`), nên gọi lại nhiều lần vẫn là MỘT tin mỗi người.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { sendInboxMessages } from "@/lib/inbox/send";
import { deliverMessage } from "@/lib/messaging/service";
import { isMessagingConnector, ORDER_NOTIFY_RULE_KEYS, type MessagingConnectorKey } from "@/lib/messaging/types";
import { listRules } from "@/lib/workflow/rules";

/**
 * Nhóm chat «báo nhóm vận hành» shop ĐÃ cấu hình (Cài đặt → Thông báo: luật đơn chốt / sửa / huỷ đang chạy THẬT có hành động
 * gửi tin) — nơi nhân viên đang theo dõi. `null` khi chưa cấu hình: không đoán kênh, không gửi.
 */
export async function operationsGroupChannel(): Promise<{ connectorKey: MessagingConnectorKey; destination: string | null } | null> {
  const rules = await listRules();
  for (const key of Object.values(ORDER_NOTIFY_RULE_KEYS)) {
    const rule = rules.find((r) => r.key === key && r.status === "ACTIVE" && r.mode === "LIVE");
    const send = rule?.actions.find((a) => a.kind === "send_message");
    if (send?.kind === "send_message" && isMessagingConnector(send.connectorKey)) return { connectorKey: send.connectorKey, destination: send.destination?.trim() || null };
  }
  return null;
}

/** Tên khách hiện trên fanpage (tin khách gần nhất của hội thoại) — để nhân viên tìm đúng hội thoại trong Pancake. */
async function fanpageCustomerName(conversationId: string): Promise<string | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ pageId: c.pageId, threadId: c.threadId }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv?.pageId || !conv.threadId) return null;
  const t = schema.salesChatInbound;
  const [row] = await db.select({ name: t.customerName }).from(t).where(and(eq(t.pageId, conv.pageId), eq(t.threadId, conv.threadId), isNotNull(t.customerName))).orderBy(desc(t.createdAt)).limit(1);
  return row?.name?.trim() || null;
}

/** Khách cần nhân viên (bot chuyển, hoặc AI không trả lời được): người ĐỌC được hội thoại chatbot được báo. */
export async function notifySalesChatHandoff(conversationId: string, reason: string, customer: { name: string; phone: string } | null | undefined, now: Date): Promise<void> {
  const title = "Chatbot chuyển khách cho nhân viên";
  const body = `${reason}${customer ? ` — ${customer.name} · ${customer.phone}` : ""}`;
  const href = `/ai/sales-chatbot?conversation=${conversationId}`;
  const key = `sales-chat:handoff:${conversationId}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "warning", title, body, href, entityType: "SALES_CHAT", entityId: conversationId, dedupeKey: key, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("ai_sales:view");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_HANDOFF", title, body, href, dedupeKey: `${key}:${userId}` })), db);
  // NHÓM CHAT (chủ shop 02/10/2026, ảnh «Lê Quyền»): trên fanpage bot IM LẶNG khi chuyển người, còn chuông ERP thì nhân viên
  // đang làm trên Pancake không thấy ⇒ khách chờ hơn 5 phút. Gửi MỘT tin vào đúng nhóm «báo nhóm vận hành» của shop; mỗi lần
  // chuyển một tin (khoá theo 10 phút — gọi lặp trong cùng lượt không nhân đôi). Lỗi gửi không chặn lượt chat.
  try {
    const group = await operationsGroupChannel();
    if (!group) return;
    const who = (await fanpageCustomerName(conversationId)) ?? customer?.name ?? null;
    const lines = [`🙋 Khách cần nhân viên trả lời${who ? `: ${who}` : ""}`, `Lý do: ${reason}`, customer?.phone ? `SĐT: ${customer.phone}` : "", "Bot đã dừng trả lời hội thoại này — vào Pancake trả lời khách."].filter(Boolean);
    await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title, body: lines.join("\n"), dedupeKey: `${key}:group:${Math.floor(now.getTime() / 600_000)}`, event: "sales_chat.handoff", subject: { type: "SALES_CHAT", id: conversationId } });
  } catch {
    // Nhóm chat là đường phụ — tin trong ERP ở trên đã ghi.
  }
}

/** Chatbot ngừng trả lời vì AI của shop: MỘT tin mỗi lý do mỗi ngày (giờ VN) cho người CẤU HÌNH được chatbot. */
export async function notifySalesChatAiDown(key: string, label: string, now: Date): Promise<void> {
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const title = "Chatbot bán hàng ngừng trả lời khách";
  const body = `${label}. Trong lúc chưa sửa, khách nhắn trang chat được chuyển thẳng cho nhân viên.`;
  const dedupe = `sales-chat:provider:${key}:${day}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "critical", title, body, href: "/ai/sales-chatbot", entityType: "SALES_CHAT", entityId: key, dedupeKey: dedupe, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("ai_sales:manage");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_AI_DOWN", title, body, href: "/ai/sales-chatbot", dedupeKey: `${dedupe}:${userId}` })), db);
}

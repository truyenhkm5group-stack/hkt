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
import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { sendInboxMessages } from "@/lib/inbox/send";

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

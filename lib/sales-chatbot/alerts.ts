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
import { parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";

/** Cấu hình bot — đọc thẳng settings (engine import tệp này, không import ngược). */
async function handoffNotifiesGroup(): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY)).limit(1);
  try {
    return parseSalesChatbotConfig(row?.value ? (JSON.parse(row.value) as unknown) : null).handoff.notifyGroup;
  } catch {
    return false;
  }
}

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

/** Luật «báo nhóm» của MỘT sự kiện đơn đang chạy THẬT (ACTIVE + LIVE, có hành động gửi tin) — tin của luật đã tới nhóm. */
export async function orderNotifyRuleLive(event: keyof typeof ORDER_NOTIFY_RULE_KEYS): Promise<boolean> {
  const rule = (await listRules()).find((r) => r.key === ORDER_NOTIFY_RULE_KEYS[event] && r.status === "ACTIVE" && r.mode === "LIVE");
  return Boolean(rule?.actions.some((a) => a.kind === "send_message"));
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
  const href = `/ai/sales-chatbot/inbox?c=${encodeURIComponent(conversationId)}`;
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
    // Chủ shop Hải Sản Làng Chài 03/10/2026: «Không cần thông báo chatbot chuyển khách cho nhân viên, chỉ cần thông báo khi
    // có đơn mới» ⇒ nhóm chỉ nhận khi shop BẬT ở cấu hình bot (mặc định tắt).
    if (!(await handoffNotifiesGroup())) return;
    const group = await operationsGroupChannel();
    if (!group) return;
    const who = (await fanpageCustomerName(conversationId)) ?? customer?.name ?? null;
    const lines = [`🙋 Khách cần nhân viên trả lời${who ? `: ${who}` : ""}`, `Lý do: ${reason}`, customer?.phone ? `SĐT: ${customer.phone}` : "", "Bot đã dừng trả lời hội thoại này — vào Pancake trả lời khách."].filter(Boolean);
    await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title, body: lines.join("\n"), dedupeKey: `${key}:group:${Math.floor(now.getTime() / 600_000)}`, event: "sales_chat.handoff", subject: { type: "SALES_CHAT", id: conversationId } });
  } catch {
    // Nhóm chat là đường phụ — tin trong ERP ở trên đã ghi.
  }
}

/**
 * Bot vừa giữ một chỗ trong lịch của shop: người XEM được lịch hẹn được báo (chuông + hàng đợi chung) — lễ tân xếp kỹ thuật
 * viên và gọi xác nhận. Một tin mỗi lịch.
 */
export async function notifySalesChatBooking(appointmentId: string, conversationId: string, text: string, now: Date): Promise<void> {
  const title = "Chatbot vừa đặt lịch hẹn";
  const href = "/appointments";
  const key = `sales-chat:booking:${appointmentId}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "info", title, body: text, href, entityType: "SALES_CHAT", entityId: conversationId, dedupeKey: key, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("appointments:view");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_BOOKING", title, body: text, href, dedupeKey: `${key}:${userId}` })), db);
}

/** Chatbot ngừng trả lời vì AI của shop: MỘT tin mỗi lý do mỗi ngày (giờ VN) cho người CẤU HÌNH được chatbot. */
/**
 * Model shop khai (cấu hình bot / kết nối AI) KHÔNG gọi được ⇒ bot đã tự chạy bằng model mặc định. Chủ shop được báo MỘT lần
 * mỗi ngày mỗi model để sửa ô model — bot vẫn trả lời khách bình thường.
 */
export async function notifySalesChatModelFallback(model: string, fallbackModel: string, now: Date): Promise<void> {
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const title = "Model AI của chatbot không dùng được";
  const body = `Model «${model}» bị nhà cung cấp AI từ chối — bot đang tự chạy bằng «${fallbackModel}». Sửa ô Model ở trang Chatbot bán hàng (hoặc Cài đặt → Kết nối) — để trống là dùng mặc định.`;
  const dedupe = `sales-chat:model-fallback:${model}:${day}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "warning", title, body, href: "/ai/sales-chatbot", entityType: "SALES_CHAT", entityId: model, dedupeKey: dedupe, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("ai_sales:manage");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_AI_DOWN", title, body, href: "/ai/sales-chatbot", dedupeKey: `${dedupe}:${userId}` })), db);
}

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
  // NHÓM CHAT (sự cố P0 06/10/2026): tài khoản AI hết tiền lúc 11:38, bot im và máy ngừng ghi đơn ~2 giờ — cảnh báo chỉ nằm
  // trong chuông ERP, nơi không ai đang nhìn. Lớp lỗi KHÔNG tự khỏi (hết tiền · khoá bị từ chối) ⇒ MỘT tin vào nhóm vận hành mỗi
  // lý do mỗi ngày (cùng khoá với chuông). KHÁC tin «chuyển nhân viên» (chủ shop 03/10 tắt): đây là sự cố cả shop, không phải
  // một khách. Lỗi gửi không chặn lượt chat.
  try {
    const group = await operationsGroupChannel();
    if (group)
      await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title, body: `🚨 ${title}\n${body}\nAI bán hàng ngừng cả trả lời lẫn TỰ GHI ĐƠN — sửa ngay để không sót đơn.`, dedupeKey: `${dedupe}:group`, event: "sales_chat.ai_down", subject: { type: "SALES_CHAT", id: key } });
  } catch {
    // Nhóm chat là đường phụ — chuông ERP ở trên đã ghi.
  }
}

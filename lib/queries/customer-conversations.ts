import { desc, eq, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { controlOf, type ConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";

/**
 * ═══════════ HỒ SƠ KHÁCH → HỘI THOẠI (Customer 360 · gap analysis slice 6) ═══════════
 *
 * Hội thoại của MỘT khách trên mọi kênh (Facebook / Instagram qua Pancake hoặc trực tiếp · Zalo OA · chat web). Chỉ nối bằng
 * KHOÁ CỨNG, không bao giờ bằng tên hay SĐT gõ trong chat (nhận diện thận trọng — hai người trùng tên không thành một khách):
 *  · `sales_chat_conversations.customer_id` — bot / nhân viên đã gắn khách vào hội thoại;
 *  · `orders.sales_conversation_id` của một đơn THUỘC khách này.
 * Chỉ đọc; không đụng một con số nào của hồ sơ (doanh thu / đơn vẫn từ `getCustomerDetail`).
 */

export type CustomerConversation = {
  id: string;
  channel: string;
  pageId: string | null;
  status: string;
  control: ConversationControl;
  lastActivityAt: string;
  orders: number;
};

export const CUSTOMER_CONVERSATIONS_MAX = 20;

export async function customerConversations(customerId: string): Promise<CustomerConversation[]> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const o = schema.orders;
  const activity = sql<Date>`greatest(coalesce(${c.lastCustomerAt}, 'epoch'::timestamptz), coalesce(${c.lastBotAt}, 'epoch'::timestamptz), coalesce(${c.lastStaffAt}, 'epoch'::timestamptz), ${c.createdAt})`;
  const rows = await db
    .select({
      id: c.id,
      channel: c.channel,
      pageId: c.pageId,
      status: c.status,
      state: c.state,
      lastActivityAt: activity,
      // Câu con TƯƠNG QUAN: tên cột viết tường minh — `${c.id}` in ra "id" trơn, trong câu con sẽ thành id của ĐƠN.
      orders: sql<number>`(select count(*)::int from ${o} x where x.sales_conversation_id = "sales_chat_conversations"."id" and x.customer_id = ${customerId})`,
    })
    .from(c)
    .where(sql`${c.channel} <> 'TEST' and (${or(eq(c.customerId, customerId), sql`${c.id} in (select y.sales_conversation_id from ${o} y where y.customer_id = ${customerId} and y.sales_conversation_id is not null)`)})`)
    .orderBy(desc(activity))
    .limit(CUSTOMER_CONVERSATIONS_MAX);
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    pageId: r.pageId,
    status: r.status,
    control: controlOf(r.state),
    lastActivityAt: (r.lastActivityAt instanceof Date ? r.lastActivityAt : new Date(r.lastActivityAt)).toISOString(),
    orders: Number(r.orders ?? 0),
  }));
}

/**
 * ═══════════ CỨU HỘI THOẠI BỊ BỎ SÓT TRONG SỰ CỐ AI (P1 sau sự cố P0 06/10/2026) — CHỈ ĐỌC, KHÔNG GỬI GÌ ═══════════
 *
 * Câu hỏi: trong một khung giờ (mặc định 24 giờ qua), hội thoại nào có tin KHÁCH mà sau đó KHÔNG có câu bot nào đi ra — và
 * với từng hội thoại, ai phải làm gì. Bốn lớp, xếp theo thứ tự kiểm (lớp đầu khớp thắng):
 *  · `HAS_ORDER`      — hội thoại đã có đơn tạo SAU tin khách (bot / máy ghi đơn / nhân viên): không cần làm gì thêm;
 *  · `STAFF_HANDLED`  — page (nhân viên / tin tự động của Meta) đã trả lời SAU tin khách: người đã nhận;
 *  · `AI_SAFE_RESUME` — tin khách còn trong cửa sổ trả lời (30 phút) và tin nằm ở dead-letter vì AI hỏng: máy tự thử lại khi
 *    provider hồi phục (inbound-retry.ts) — người KHÔNG cần nhắn, nhắn là khách nhận hai câu;
 *  · `HUMAN_REVIEW`   — còn lại: khách chờ quá 30 phút không ai trả lời. Bot KHÔNG tự nhắn vào hội thoại đã nguội — nhân viên
 *    xem và gọi / nhắn lại.
 * Hàm phân loại là HÀM THUẦN (`classifyMissedConversation`); hàm đọc chỉ SELECT. Không gửi tin, không đổi trạng thái.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { DEAD_AI_DOWN_NOTE, INBOUND_RETRY_WINDOW_MINUTES } from "@/lib/sales-chatbot/inbound-retry";
import { rowsOf } from "@/lib/sql-rows";

export type MissedClass = "HAS_ORDER" | "STAFF_HANDLED" | "AI_SAFE_RESUME" | "HUMAN_REVIEW";
export const MISSED_CLASS_LABEL: Record<MissedClass, string> = {
  HAS_ORDER: "Đã có đơn",
  STAFF_HANDLED: "Nhân viên đã trả lời",
  AI_SAFE_RESUME: "Máy tự thử lại khi AI hồi phục — đừng nhắn trùng",
  HUMAN_REVIEW: "Cần nhân viên gọi / nhắn lại",
};

export type MissedFacts = { lastCustomerAt: Date; orderAfter: boolean; pageReplyAfter: boolean; deadAiDown: boolean };

export function classifyMissedConversation(f: MissedFacts, now: Date): MissedClass {
  if (f.orderAfter) return "HAS_ORDER";
  if (f.pageReplyAfter) return "STAFF_HANDLED";
  if (f.deadAiDown && now.getTime() - f.lastCustomerAt.getTime() <= INBOUND_RETRY_WINDOW_MINUTES * 60_000) return "AI_SAFE_RESUME";
  return "HUMAN_REVIEW";
}

export type MissedConversation = MissedFacts & { pageId: string; threadId: string; customerName: string | null; lastText: string; conversationId: string | null; cls: MissedClass };

/** Hội thoại có tin khách trong [from, to] mà không câu bot nào sau tin khách cuối — kèm lớp. Chỉ đọc. */
export async function findMissedConversations(from: Date, to: Date, now: Date = new Date(), limit = 200): Promise<MissedConversation[]> {
  const db = await getDb();
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with khach as (
        select page_id, thread_id, max(created_at) as last_at
        from sales_chat_inbound
        where coalesce(note, '') not in ('BOT_SENT', 'PAGE_REPLY') and message_id not like 'bot-out:%' and message_id not like 'staff-out:%'
          and imported_at is null and created_at >= ${from} and created_at <= ${to}
        group by page_id, thread_id
      )
      select k.page_id, k.thread_id, k.last_at, c.id as conversation_id,
        (select i.customer_name from sales_chat_inbound i where i.page_id = k.page_id and i.thread_id = k.thread_id and i.customer_name is not null order by i.created_at desc limit 1) as customer_name,
        (select left(i.text, 160) from sales_chat_inbound i where i.page_id = k.page_id and i.thread_id = k.thread_id and i.created_at = k.last_at limit 1) as last_text,
        exists (select 1 from sales_chat_inbound b where b.page_id = k.page_id and b.thread_id = k.thread_id and b.note = 'BOT_SENT' and b.created_at >= k.last_at) as bot_after,
        exists (select 1 from sales_chat_inbound p where p.page_id = k.page_id and p.thread_id = k.thread_id and p.note = 'PAGE_REPLY' and p.created_at >= k.last_at) as page_after,
        exists (select 1 from sales_chat_inbound d where d.page_id = k.page_id and d.thread_id = k.thread_id and d.status = 'DEAD' and d.note = ${DEAD_AI_DOWN_NOTE}) as dead_ai,
        exists (select 1 from orders o where c.id is not null and o.sales_conversation_id = c.id and o.inserted_at >= ${from} and o.stage is distinct from 'DELETED') as order_after
      from khach k
      left join sales_chat_conversations c on c.page_id = k.page_id and c.thread_id = k.thread_id
      order by k.last_at desc
      limit ${limit}
    `),
  );
  return rows
    .filter((r) => !r.bot_after)
    .map((r) => {
      const facts: MissedFacts = { lastCustomerAt: new Date(String(r.last_at)), orderAfter: Boolean(r.order_after), pageReplyAfter: Boolean(r.page_after), deadAiDown: Boolean(r.dead_ai) };
      return {
        ...facts,
        pageId: String(r.page_id),
        threadId: String(r.thread_id),
        customerName: typeof r.customer_name === "string" ? r.customer_name : null,
        lastText: String(r.last_text ?? ""),
        conversationId: typeof r.conversation_id === "string" ? r.conversation_id : null,
        cls: classifyMissedConversation(facts, now),
      };
    });
}

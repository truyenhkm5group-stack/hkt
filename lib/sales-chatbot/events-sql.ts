/**
 * ═══════════ HAI VỊ NGỮ CỦA SỔ SỰ KIỆN DÙNG CHUNG CHO MỌI MÀN AI BÁN HÀNG ═══════════
 *
 * Màn «Hiệu quả», danh sách hội thoại (drill-down) và bảng bán chéo cùng trả lời «đơn nào là bot chốt» và «hội thoại nào có
 * người chạm vào». Ba câu SQL gõ ba lần từng ra ba đáp án: đơn NHÂN VIÊN tạo trong khung chat (`lib/records/chat-order.ts`,
 * `order.confirmed` tác nhân HUMAN) bị đếm là «Đơn bot chốt», vào doanh thu AI và làm chi phí AI / đơn thấp đi. Mọi câu
 * truy vấn đọc hai ý đó PHẢI đi qua hai biểu thức dưới đây.
 *
 *  · `BOT_CONFIRMED` — `order.confirmed` KHÔNG do người chốt. Đơn bot chốt mang tác nhân CUSTOMER (khách đồng ý trong lượt bot,
 *    `events-shared.ts`), nên lọc `= 'AI'` là SAI — nó xoá sạch đơn bot. Điều kiện đúng là «không phải HUMAN».
 *  · `HUMAN_TOUCHED` — chuyển người, nhân viên nhận / trả lời, hoặc NGƯỜI lên / chốt đơn trong hội thoại (form tạo đơn trong
 *    chat, AI ghi hộ đơn của nhân viên). `ai.resumed` không tính: nó chỉ xảy ra sau một lần chuyển người đã được đếm.
 *
 * Chỉ dùng trong hàm gộp `bool_or(...)` / `filter (where ...)` trên bảng `sales_conversation_events`.
 */
import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";

const e = schema.salesConversationEvents;

export const BOT_CONFIRMED: SQL = sql`(${e.type} = 'order.confirmed' and ${e.actorKind} <> 'HUMAN')`;

export const HUMAN_TOUCHED: SQL = sql`(${e.type} in ('handoff.requested','human.took_over','human.replied') or (${e.actorKind} = 'HUMAN' and ${e.type} in ('order.drafted','order.confirmed')))`;

/**
 * PHẠM VI MỘT PAGE (hộp thư / chỉ số nhiều page): sự kiện của hội thoại thuộc `pageId`. `null` = mọi page. Page là một CHIỀU
 * lọc trên CÙNG công thức — không page nào có định nghĩa chỉ số riêng.
 */
export function onPage(pageId: string | null | undefined): SQL | undefined {
  if (!pageId) return undefined;
  return sql`${e.conversationId} in (select "id" from "sales_chat_conversations" where "page_id" = ${pageId})`;
}

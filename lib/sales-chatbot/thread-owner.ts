/**
 * ═══════════ MỘT LUỒNG (page, thread) — MỘT HỘI THOẠI, MỘT BOT (P0 HSLC 24/10/2026, cặp đơn #B1135EC0 / #E0663E84) ═══════════
 *
 * Sau lượt chép bình luận EXISTING_INBOX, markWaitingForCustomer ghi `thread_id` = luồng HỘP THƯ vào hội thoại BÌNH LUẬN (và đặt WAITING +
 * lịch nhắc) ⇒ HAI dòng sales_chat_conversations cùng (page, thread): hội thoại bình luận và hội thoại hộp thư. Mọi đường đọc theo
 * (page_id, thread_id) — gửi bù, thử lại tin chết, tin theo dõi, giám sát — thấy cả hai, hai bot cùng trả lời, mỗi bên một đơn.
 *
 * CHỦ của một luồng = hội thoại FANPAGE có `visitor_key = fanpageVisitorKey(page, thread)` — đúng khoá mà webhook dùng để mở / tìm hội
 * thoại (`conversationFor`). Hàm chủ DUY NHẤT ở tệp này; tests/thread-owner.test.ts quét mã nguồn chặn đường đọc theo thread_id mới ngoài
 * nó (miễn trừ kèm lý do).
 *
 * `ownsThreadSql` cố ý là «KHÔNG bị hội thoại KHÁC giành»: một dòng lẻ (kể cả dòng cũ có khoá khác dạng) không bao giờ bị loại — chỉ dòng
 * trùng mà một hội thoại khác mới là chủ. Không ghi gì; dòng trùng cũ để lượt chạy thử đếm (chủ shop quyết sửa).
 */
import { createHash } from "node:crypto";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";

/** Khoá hội thoại fanpage của một luồng — MỘT chỗ (fanpage.ts xuất lại). */
export function fanpageVisitorKey(pageId: string, threadId: string): string {
  return createHash("sha256").update(`fanpage:${pageId}:${threadId}`).digest("hex");
}

/** Hội thoại (TS) có phải chủ luồng của chính nó không. HÀM THUẦN. */
export function ownsThread(row: { visitorKey: string | null; pageId: string | null; threadId: string | null }): boolean {
  return Boolean(row.pageId && row.threadId && row.visitorKey === fanpageVisitorKey(row.pageId, row.threadId));
}

/**
 * Mệnh đề SQL: dòng hội thoại `alias` KHÔNG bị một hội thoại FANPAGE khác giành luồng (page, thread) của nó. `alias` là bí danh / tên bảng
 * trong câu gọi (`c` · `"sales_chat_conversations"`). Cùng công thức với fanpageVisitorKey (sha256 hex của «fanpage:<page>:<thread>»).
 */
export function ownsThreadSql(alias: string): SQL {
  if (!/^(?:[a-z_][a-z0-9_]*|"[a-z_][a-z0-9_]*")$/i.test(alias)) throw new Error("ownsThreadSql: bí danh không hợp lệ");
  const a = sql.raw(alias);
  return sql`not exists (select 1 from sales_chat_conversations o_own where o_own.channel = 'FANPAGE' and o_own.id <> ${a}.id and o_own.visitor_key = encode(sha256(convert_to('fanpage:' || ${a}.page_id || ':' || ${a}.thread_id, 'UTF8')), 'hex'))`;
}

/** Hội thoại CHỦ của một luồng: khoá khách khớp trước; không có ⇒ dòng duy nhất / cũ nhất không bị giành. `null` = chưa có. */
export async function threadOwner(pageId: string, threadId: string): Promise<{ id: string } | null> {
  const c = schema.salesChatConversations;
  const key = fanpageVisitorKey(pageId, threadId);
  const [row] = await (await getDb())
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), sql`(${c.visitorKey} = ${key} or (${c.pageId} = ${pageId} and ${c.threadId} = ${threadId} and ${ownsThreadSql('"sales_chat_conversations"')}))`))
    .orderBy(desc(sql`${c.visitorKey} = ${key}`), c.createdAt)
    .limit(1);
  return row ?? null;
}

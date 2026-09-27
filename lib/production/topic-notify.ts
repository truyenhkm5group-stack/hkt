import type { Db } from "@/db";
import { sendInboxMessages } from "@/lib/inbox/send";
import { topicAudience } from "@/lib/production/topic-access";

/**
 * ═══════════ TIN HỘP THƯ CỦA TOPIC SẢN XUẤT ═══════════
 *
 * Tin đi vào HỘP THƯ CÁ NHÂN (`user_messages`, quả chuông) — KHÔNG vào hàng đợi `notifications` chung: topic
 * riêng chỉ người trong topic được thấy, còn hàng đợi chung ai có quyền cảnh báo cũng đọc được.
 *
 * Tiêu đề chỉ mang tên topic và tên người — không trích nội dung trao đổi (giá xưởng báo là thông tin nội bộ,
 * và chuông hiện trên màn hình người ngồi cạnh nhìn được). Nội dung nằm sau cổng quyền của trang topic.
 *
 * Gửi hỏng KHÔNG làm hỏng thao tác: tag / trao đổi đã ghi rồi, tin chỉ là lời nhắc.
 */

export const TOPIC_INBOX_KIND = { TAGGED: "PRODUCTION_TOPIC_TAGGED", MESSAGE: "PRODUCTION_TOPIC_MESSAGE" } as const;

const href = (topicId: string) => `/production/topics/${topicId}`;

export async function notifyTopicTagged(db: Db, input: { topicId: string; title: string; userIds: readonly string[]; byName: string; at?: Date }): Promise<number> {
  if (!input.userIds.length) return 0;
  const stamp = (input.at ?? new Date()).getTime();
  try {
    return await sendInboxMessages(
      input.userIds.map((userId) => ({
        userId,
        kind: TOPIC_INBOX_KIND.TAGGED,
        title: `${input.byName} tag bạn vào topic “${input.title}”`,
        body: "Mở topic để xem yêu cầu và trao đổi với sản xuất.",
        href: href(input.topicId),
        // Bỏ tag rồi tag lại là một lời mời MỚI — mốc thời gian nằm trong khoá.
        dedupeKey: `topic-tag:${input.topicId}:${userId}:${stamp}`,
      })),
      db,
    );
  } catch {
    return 0;
  }
}

export async function notifyTopicMessage(db: Db, input: { topicId: string; title: string; messageId: string; authorId: string | null; authorName: string }): Promise<number> {
  try {
    const to = await topicAudience(db, input.topicId, input.authorId);
    if (!to.length) return 0;
    return await sendInboxMessages(
      to.map((userId) => ({
        userId,
        kind: TOPIC_INBOX_KIND.MESSAGE,
        title: `${input.authorName} vừa trao đổi trong topic “${input.title}”`,
        href: href(input.topicId),
        dedupeKey: `topic-msg:${input.messageId}:${userId}`,
      })),
      db,
    );
  } catch {
    return 0;
  }
}

import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Hộp thư của CHÍNH người đang đăng nhập. Không có tham số "của ai khác" — hàm nhận `userId` từ
 * phiên, và mọi nơi gọi truyền `user.id` của phiên. Đọc hộp thư người khác không có đường nào.
 */
export async function listInbox(userId: string, limit = 20) {
  const db = await getDb();
  const t = schema.userMessages;
  const [items, [unread]] = await Promise.all([
    db
      .select({ id: t.id, kind: t.kind, title: t.title, body: t.body, href: t.href, createdAt: t.createdAt, readAt: t.readAt })
      .from(t)
      .where(eq(t.userId, userId))
      .orderBy(desc(t.createdAt))
      .limit(limit),
    db.select({ n: count() }).from(t).where(and(eq(t.userId, userId), isNull(t.readAt))),
  ]);
  return { items, unread: Number(unread?.n ?? 0) };
}

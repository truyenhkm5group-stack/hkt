import { and, desc, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

export type NotificationRow = typeof schema.notifications.$inferSelect;

/** Thông báo đang mở (chưa đóng), mới nhất trước */
export async function listOpenNotifications(limit = 200): Promise<NotificationRow[]> {
  const db = await getDb();
  return db.select().from(schema.notifications).where(isNull(schema.notifications.resolvedAt)).orderBy(desc(schema.notifications.createdAt)).limit(limit);
}

/** Số thông báo đang mở mà người dùng chưa đọc */
export async function unreadCount(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.notifications)
    .where(and(isNull(schema.notifications.resolvedAt), sql`not (${schema.notifications.readBy} @> ${JSON.stringify([userId])}::jsonb)`));
  return Number(row?.count ?? 0);
}

/** Tóm tắt theo loại cho trang Cần xử lý */
export async function openCountsByKind() {
  const db = await getDb();
  const rows = await db
    .select({ kind: schema.notifications.kind, count: sql<number>`count(*)` })
    .from(schema.notifications)
    .where(isNull(schema.notifications.resolvedAt))
    .groupBy(schema.notifications.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)])) as Record<string, number>;
}

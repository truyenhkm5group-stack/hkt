import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";

export type NotificationRow = typeof schema.notifications.$inferSelect;

/**
 * Cột mà giao diện thật sự đọc. `select()` trần kéo về CẢ những cột không ai hiển thị
 * (dedupe_key, assigned_*, acknowledged_*, ignored_*, started_*) — nhân với vài trăm dòng là vài
 * trăm KB đi qua đường truyền cho mỗi lần mở trang.
 */
const OPEN_COLUMNS = {
  id: schema.notifications.id,
  kind: schema.notifications.kind,
  severity: schema.notifications.severity,
  title: schema.notifications.title,
  body: schema.notifications.body,
  href: schema.notifications.href,
  readBy: schema.notifications.readBy,
  createdAt: schema.notifications.createdAt,
  occurredAt: schema.notifications.occurredAt,
  notifiedAt: schema.notifications.notifiedAt,
};

export type OpenNotificationRow = { [K in keyof typeof OPEN_COLUMNS]: NotificationRow[K] };

function openWhere(kind?: string): SQL {
  const open = isNull(schema.notifications.resolvedAt);
  return (kind ? and(open, eq(schema.notifications.kind, kind)) : open) as SQL;
}

/**
 * Thông báo đang mở (chưa đóng), mới nhất trước.
 *
 * LỌC THEO LOẠI PHẢI Ở TRONG SQL. Trước đây trang Cần xử lý lấy 300 dòng mới nhất rồi mới lọc theo
 * loại bằng JavaScript: loại nào ít gặp thì các dòng cũ hơn dòng thứ 300 biến mất khỏi kết quả mà
 * không có dấu hiệu gì — vừa sai vừa tốn.
 */
export async function listOpenNotifications(limit = 200, options: { offset?: number; kind?: string } = {}): Promise<OpenNotificationRow[]> {
  const db = await getDb();
  return db
    .select(OPEN_COLUMNS)
    .from(schema.notifications)
    .where(openWhere(options.kind))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit)
    .offset(options.offset ?? 0);
}

/** Tổng số thông báo đang mở (theo loại nếu có) — để phân trang biết còn bao nhiêu. */
export async function countOpenNotifications(kind?: string) {
  const db = await getDb();
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(schema.notifications).where(openWhere(kind));
  return Number(row?.count ?? 0);
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

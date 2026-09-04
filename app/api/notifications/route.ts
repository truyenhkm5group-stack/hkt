import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { listOpenNotifications, unreadCount } from "@/lib/queries/notifications";

export const dynamic = "force-dynamic";

/** Chuông thông báo: 20 thông báo đang mở mới nhất + số chưa đọc của người dùng hiện tại */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  const [items, unread] = await Promise.all([listOpenNotifications(20), unreadCount(user.id)]);
  return NextResponse.json({
    unread,
    items: items.map((n) => ({ id: n.id, kind: n.kind, severity: n.severity, title: n.title, body: n.body, href: n.href, createdAt: n.createdAt, read: n.readBy.includes(user.id) })),
  });
}

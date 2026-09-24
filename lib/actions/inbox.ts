"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { markInboxRead } from "@/lib/inbox/send";
import { listInbox } from "@/lib/queries/user-messages";

/**
 * ═══ HỘP THƯ CÁ NHÂN — CHỈ CỦA NGƯỜI ĐANG ĐĂNG NHẬP ═══
 *
 * Cố ý là server action, KHÔNG phải một route `/api/...`: hộp thư không có khoá quyền module nào để
 * hỏi (tin thuộc về đúng một tài khoản), và mọi route API trong kho đều phải hỏi một khoá quyền
 * (`tests/access-control.test.ts`). Thay vì mở một cửa API mới rồi xin miễn trừ, đường đọc đi qua đây:
 * `userId` LUÔN lấy từ phiên, không có tham số nào trỏ tới hộp thư người khác.
 */
export async function listMyInbox(): Promise<{ unread: number; items: { id: string; kind: string; title: string; body: string; href: string; createdAt: string; read: boolean }[] }> {
  const user = await requireUser();
  const { items, unread } = await listInbox(user.id, 15);
  return {
    unread,
    items: items.map((m) => ({ id: m.id, kind: m.kind, title: m.title, body: m.body, href: m.href, createdAt: m.createdAt.toISOString(), read: m.readAt !== null })),
  };
}

/** Đánh dấu đã đọc tin trong hộp thư CỦA CHÍNH MÌNH. */
export async function markMyInboxRead(input: unknown): Promise<{ ok: true; count: number } | { error: string }> {
  const user = await requireUser();
  const parsed = z.union([z.literal("all"), z.array(z.string().min(1)).max(200)]).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const count = await markInboxRead(user.id, parsed.data);
  return { ok: true, count };
}

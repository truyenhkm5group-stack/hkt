/**
 * ═══════════ HỘP THƯ CÁ NHÂN — ĐƯỜNG GHI DUY NHẤT ═══════════
 *
 * `notifications` là hàng đợi CHUNG: ai có quyền cảnh báo cũng đọc được mọi dòng. Có những tin chỉ
 * được thuộc về MỘT người — phiếu lương là ví dụ rõ nhất. Tin ấy đi vào `user_messages`, mỗi dòng
 * mang đúng một `user_id`, và chỉ chủ tài khoản ấy đọc được (`lib/queries/user-messages.ts`).
 *
 * CHỐNG GỬI TRÙNG Ở CSDL: job chạy mỗi giờ, nên cùng một tin sẽ được "định gửi" nhiều lần. Khoá
 * `dedupe_key` DUY NHẤT biến mọi lượt sau thành không làm gì — không phải một phép kiểm ở tầng ứng
 * dụng (hai lượt chạy song song vẫn thắng được phép kiểm ấy).
 *
 * KHÔNG CHỨA SỐ TIỀN TRONG TIÊU ĐỀ: tiêu đề hiện ở chuông thông báo, và người ngồi cạnh nhìn được màn
 * hình. Số tiền nằm trong trang mà đường dẫn trỏ tới, sau lớp kiểm chủ tài khoản.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";

export type InboxMessage = {
  userId: string;
  kind: string;
  title: string;
  body?: string;
  href?: string;
  dedupeKey: string;
};

/** Gửi nhiều tin một lượt. Trả số tin THẬT SỰ mới (tin đã gửi trước đó không đếm lại). */
export async function sendInboxMessages(messages: readonly InboxMessage[], dbIn?: Db): Promise<number> {
  if (!messages.length) return 0;
  const db = dbIn ?? (await getDb());
  const rows = await db
    .insert(schema.userMessages)
    .values(messages.map((m) => ({ userId: m.userId, kind: m.kind, title: m.title, body: m.body ?? "", href: m.href ?? "", dedupeKey: m.dedupeKey })))
    .onConflictDoNothing({ target: schema.userMessages.dedupeKey })
    .returning({ id: schema.userMessages.id });
  return rows.length;
}

/** Đánh dấu đã đọc — CHỈ tin của chính người ấy (`userId` luôn là người đang đăng nhập). */
export async function markInboxRead(userId: string, ids: readonly string[] | "all", dbIn?: Db): Promise<number> {
  const db = dbIn ?? (await getDb());
  const t = schema.userMessages;
  const conds = [eq(t.userId, userId), isNull(t.readAt)];
  if (ids !== "all") {
    if (!ids.length) return 0;
    conds.push(inArray(t.id, [...ids]));
  }
  const rows = await db.update(t).set({ readAt: sql`now()` }).where(and(...conds)).returning({ id: t.id });
  return rows.length;
}

/**
 * Tài khoản nhận tin DÀNH CHO NGƯỜI DUYỆT LƯƠNG: mọi tài khoản ADMIN đang bật.
 *
 * Cố ý không suy từ khoá quyền `payroll:approve`: quyền là mảng có thể ghi đè ở `settings`, và đọc
 * nó cho từng người ở đây là viết lại máy tính quyền lần thứ hai (AGENTS.md mục 28). Tin này chỉ là
 * lời nhắc có đường dẫn; ai bấm vào vẫn phải qua cổng quyền của trang đích.
 */
export async function payrollApproverUserIds(dbIn?: Db): Promise<string[]> {
  const db = dbIn ?? (await getDb());
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.active, true), eq(schema.users.role, "ADMIN")));
  return rows.map((r) => r.id);
}

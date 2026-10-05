import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { LABEL_COLORS, LABEL_NAME_MAX, NOTE_MAX, type InboxLabel, type InboxNote, type LabelColor } from "@/lib/sales-chatbot/inbox-shared";

/**
 * ═══════════ NHÃN + GHI CHÚ NỘI BỘ CỦA HỘP THƯ KHÁCH (M8 · 0211) ═══════════
 *
 * NHÃN: bộ nhãn của tổ chức (tên + màu trong bảng màu đóng). Người trả lời khách TẠO nhãn ngay lúc gắn (như Pancake); đổi tên /
 * lưu trữ nhãn là việc của người quản lý chatbot. Lưu trữ không gỡ nhãn khỏi hội thoại cũ — chỉ ẩn khỏi bộ chọn và bộ lọc.
 * GHI CHÚ: nhân viên ghi cho nhau — KHÔNG gửi khách, KHÔNG vào lịch sử của bot, KHÔNG phép tính / báo cáo nào đọc (cùng tinh thần
 * luật 46). Mỗi ghi chú mang khoá tài khoản + tên do máy chủ đọc (luật 34). Xoá = đánh dấu, chỉ người viết hoặc người quản lý.
 * Không thứ gì ở đây tham gia ORDER_OUTCOME, doanh thu hay thẻ điểm.
 */

const VIEW = "ai_sales:view";
const MANAGE = "ai_sales:manage";

export type LabelResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Cùng điều kiện với hộp thư: trả lời khách = `ai_sales:reply` hoặc `outreach:send`. */
function canWork(user: SessionUser): boolean {
  return can(user, "ai_sales:reply") || can(user, "outreach:send");
}

async function conversationExists(id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !id || id.length > 100) return null;
  const db = await getDb();
  const [row] = await db.select({ id: schema.salesChatConversations.id, channel: schema.salesChatConversations.channel }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, id)).limit(1);
  return row && row.channel !== "TEST" ? row.id : null;
}

/** Nhãn ĐANG DÙNG của tổ chức (chưa lưu trữ), xếp theo tên. */
export async function listLabels(): Promise<InboxLabel[]> {
  const db = await getDb();
  const l = schema.salesChatLabels;
  const rows = await db.select({ id: l.id, name: l.name, color: l.color }).from(l).where(isNull(l.archivedAt)).orderBy(asc(sql`lower(${l.name})`)).limit(200);
  return rows.map((r) => ({ id: r.id, name: r.name, color: (LABEL_COLORS as readonly string[]).includes(r.color) ? (r.color as LabelColor) : "gray" }));
}

/** Nhãn gắn trên nhiều hội thoại (kể cả nhãn đã lưu trữ — hội thoại cũ vẫn hiện nhãn của nó). */
export async function labelsFor(conversationIds: readonly string[]): Promise<Map<string, InboxLabel[]>> {
  const out = new Map<string, InboxLabel[]>();
  if (!conversationIds.length) return out;
  const db = await getDb();
  const cl = schema.salesChatConversationLabels;
  const l = schema.salesChatLabels;
  const rows = await db
    .select({ conversationId: cl.conversationId, id: l.id, name: l.name, color: l.color })
    .from(cl)
    .innerJoin(l, eq(l.id, cl.labelId))
    .where(inArray(cl.conversationId, [...conversationIds]))
    .orderBy(asc(sql`lower(${l.name})`));
  for (const r of rows) {
    const list = out.get(r.conversationId) ?? [];
    list.push({ id: r.id, name: r.name, color: (LABEL_COLORS as readonly string[]).includes(r.color) ? (r.color as LabelColor) : "gray" });
    out.set(r.conversationId, list);
  }
  return out;
}

const labelZ = z
  .object({
    name: z.string().trim().min(1, "Đặt tên nhãn.").max(LABEL_NAME_MAX, `Tên nhãn tối đa ${LABEL_NAME_MAX} ký tự.`),
    color: z.enum(LABEL_COLORS).default("gray"),
  })
  .strict();

/** Tạo nhãn mới. Trùng tên (không phân biệt hoa thường) với nhãn đang dùng ⇒ trả lại nhãn đó, không tạo bản thứ hai. */
export async function createLabelCore(user: SessionUser, raw: unknown): Promise<LabelResult<{ label: InboxLabel; existed: boolean }>> {
  if (!can(user, VIEW) || !canWork(user)) return { ok: false, error: "Bạn không có quyền gắn nhãn hội thoại (ai_sales:reply)." };
  const parsed = labelZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const db = await getDb();
  const l = schema.salesChatLabels;
  const name = parsed.data.name.replace(/\s+/g, " ");
  const find = async () => (await db.select({ id: l.id, name: l.name, color: l.color }).from(l).where(and(isNull(l.archivedAt), sql`lower(${l.name}) = lower(${name})`)).limit(1))[0];
  const hit = await find();
  if (hit) return { ok: true, existed: true, label: { id: hit.id, name: hit.name, color: hit.color as LabelColor } };
  try {
    const [row] = await db.insert(l).values({ name, color: parsed.data.color, createdBy: user.id }).returning({ id: l.id });
    return { ok: true, existed: false, label: { id: row.id, name, color: parsed.data.color } };
  } catch (error) {
    // Hai người tạo cùng tên một lúc — chỉ số UNIQUE giữ đúng một nhãn; trả lại nhãn của lượt thắng.
    if (!isUniqueViolation(error)) throw error;
    const again = await find();
    return again ? { ok: true, existed: true, label: { id: again.id, name: again.name, color: again.color as LabelColor } } : { ok: false, error: "Không tạo được nhãn — thử lại." };
  }
}

/** Lưu trữ nhãn (người quản lý chatbot). Hội thoại đã gắn vẫn giữ nhãn để đọc lại lịch sử. */
export async function archiveLabelCore(user: SessionUser, labelId: unknown): Promise<LabelResult> {
  if (!can(user, MANAGE)) return { ok: false, error: "Chỉ người quản lý chatbot (ai_sales:manage) gỡ được nhãn khỏi bộ nhãn." };
  if (typeof labelId !== "string" || !labelId) return { ok: false, error: "Không có nhãn này." };
  const db = await getDb();
  const l = schema.salesChatLabels;
  const done = await db.update(l).set({ archivedAt: new Date() }).where(and(eq(l.id, labelId), isNull(l.archivedAt))).returning({ id: l.id, name: l.name });
  if (!done.length) return { ok: false, error: "Không có nhãn này (hoặc đã gỡ)." };
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_INBOX_LABEL_ARCHIVE", entity: "SALES_CHAT_LABEL", entityId: labelId, before: { name: done[0].name }, after: { archived: true }, reason: "Gỡ nhãn khỏi bộ nhãn hộp thư" });
  return { ok: true };
}

/** Đặt LẠI bộ nhãn của một hội thoại (gắn thêm / bỏ bớt trong một lượt). Chỉ nhận nhãn đang dùng. */
export async function setConversationLabelsCore(user: SessionUser, conversationId: unknown, rawLabelIds: unknown): Promise<LabelResult<{ labels: InboxLabel[] }>> {
  if (!can(user, VIEW) || !canWork(user)) return { ok: false, error: "Bạn không có quyền gắn nhãn hội thoại (ai_sales:reply)." };
  const conv = await conversationExists(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  const ids = z.array(z.string().min(1).max(100)).max(20, "Tối đa 20 nhãn mỗi hội thoại.").safeParse(rawLabelIds);
  if (!ids.success) return { ok: false, error: ids.error.issues.map((i) => i.message).join(" · ") };
  const want = [...new Set(ids.data)];
  const db = await getDb();
  const l = schema.salesChatLabels;
  const cl = schema.salesChatConversationLabels;
  const active = want.length ? await db.select({ id: l.id }).from(l).where(and(inArray(l.id, want), isNull(l.archivedAt))) : [];
  const activeIds = new Set(active.map((r) => r.id));
  const current = await db.select({ labelId: cl.labelId }).from(cl).where(eq(cl.conversationId, conv));
  const currentIds = new Set(current.map((r) => r.labelId));
  // Nhãn đã lưu trữ đang gắn sẵn thì GIỮ (người không chọn lại được nó, nhưng cũng không vô tình gỡ mất).
  const archivedKept = [...currentIds].filter((id) => !activeIds.has(id) && want.includes(id));
  const finalIds = new Set([...activeIds, ...archivedKept]);
  const toRemove = [...currentIds].filter((id) => !finalIds.has(id));
  const toAdd = [...finalIds].filter((id) => !currentIds.has(id));
  await db.transaction(async (tx) => {
    if (toRemove.length) await tx.delete(cl).where(and(eq(cl.conversationId, conv), inArray(cl.labelId, toRemove)));
    if (toAdd.length) await tx.insert(cl).values(toAdd.map((labelId) => ({ conversationId: conv, labelId, addedBy: user.id }))).onConflictDoNothing();
  });
  return { ok: true, labels: (await labelsFor([conv])).get(conv) ?? [] };
}

/** Ghi chú nội bộ của một hội thoại (chưa xoá), cũ trước mới sau. */
export async function notesFor(user: SessionUser, conversationId: string): Promise<InboxNote[]> {
  const db = await getDb();
  const n = schema.salesChatNotes;
  const rows = await db.select().from(n).where(and(eq(n.conversationId, conversationId), isNull(n.deletedAt))).orderBy(asc(n.createdAt)).limit(200);
  const manage = can(user, MANAGE);
  return rows.map((r) => ({ id: r.id, text: r.text, author: r.userName || "Nhân viên", userId: r.userId, at: r.createdAt.toISOString(), canDelete: manage || r.userId === user.id }));
}

const noteZ = z.string().trim().min(1, "Ghi chú trống.").max(NOTE_MAX, `Ghi chú tối đa ${NOTE_MAX} ký tự.`);

export async function addNoteCore(user: SessionUser, conversationId: unknown, rawText: unknown): Promise<LabelResult<{ note: InboxNote }>> {
  if (!can(user, VIEW) || !canWork(user)) return { ok: false, error: "Bạn không có quyền ghi chú hội thoại (ai_sales:reply)." };
  const conv = await conversationExists(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  const text = noteZ.safeParse(rawText);
  if (!text.success) return { ok: false, error: text.error.issues.map((i) => i.message).join(" · ") };
  const db = await getDb();
  // Tên do MÁY CHỦ đọc từ `users` (luật 34) — không nhận từ trình duyệt.
  const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  const [row] = await db.insert(schema.salesChatNotes).values({ conversationId: conv, userId: user.id, userName: me?.name ?? user.name ?? "", text: text.data }).returning();
  return { ok: true, note: { id: row.id, text: row.text, author: row.userName || "Nhân viên", userId: row.userId, at: row.createdAt.toISOString(), canDelete: true } };
}

/** Xoá ghi chú = đánh dấu. Chỉ người viết, hoặc người quản lý chatbot. */
export async function deleteNoteCore(user: SessionUser, noteId: unknown): Promise<LabelResult> {
  if (!can(user, VIEW)) return { ok: false, error: "Bạn không có quyền xem hội thoại (ai_sales:view)." };
  if (typeof noteId !== "string" || !noteId) return { ok: false, error: "Không có ghi chú này." };
  const db = await getDb();
  const n = schema.salesChatNotes;
  const [row] = await db.select({ userId: n.userId }).from(n).where(and(eq(n.id, noteId), isNull(n.deletedAt))).limit(1);
  if (!row) return { ok: false, error: "Không có ghi chú này (hoặc đã xoá)." };
  if (row.userId !== user.id && !can(user, MANAGE)) return { ok: false, error: "Chỉ người viết ghi chú (hoặc người quản lý chatbot) xoá được." };
  await db.update(n).set({ deletedAt: new Date(), deletedBy: user.id }).where(eq(n.id, noteId));
  return { ok: true };
}

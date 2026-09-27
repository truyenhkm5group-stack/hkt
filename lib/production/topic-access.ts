import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Permission } from "@/lib/auth/permissions";
import { can, type SessionUser } from "@/lib/auth/session";

/**
 * ═══════════ AI XEM / GHI ĐƯỢC MỘT TOPIC SẢN XUẤT — MỘT CHỖ DUY NHẤT ═══════════
 *
 * Chủ shop 27/09/2026: marketing mở topic, TAG người cần trao đổi, "những người được tag mới xem được
 * topic". Mọi đường đọc (danh sách, trang topic, tệp đính kèm, hàng đợi, trang mẫu) và mọi đường ghi (trao
 * đổi, tệp, trạng thái, tag) hỏi ở đây — không trang nào tự viết lại điều kiện.
 *
 *  · ADMIN (chủ shop) xem mọi topic.
 *  · Topic RIÊNG (`restricted`, mọi topic mở từ 0153): chỉ người mở + người được tag.
 *  · Topic cũ (`restricted = false`, mở trước 0153): tầm nhìn cũ — ai có `planning:view` cũng xem. Không đoán
 *    ngược ai "lẽ ra" được tag (mục 35).
 *
 * Quyền ghi ĐI SAU quyền xem: không xem được thì không ghi được, kể cả khi có `production:write`. Mọi nhánh
 * lỗi rơi về phía HẸP HƠN.
 */

/**
 * Người đang xem — một `SessionUser` (hoặc phần của nó mà `can()` đọc). Quyền đi qua ĐÚNG `can()` của phiên:
 * cổng module của tổ chức (P8) áp như mọi màn hình khác — không tự viết lại phép kiểm quyền ở đây.
 */
export type TopicViewer = Pick<SessionUser, "id" | "role" | "permissions"> & Partial<Pick<SessionUser, "modules" | "organization">>;

export type TopicAccessFacts = {
  restricted: boolean;
  createdByUserId: string | null;
  /** Người xem có dòng trong `production_topic_members` của topic này. */
  isMember: boolean;
};

export type TopicAccess = {
  view: boolean;
  /** Ghi trao đổi, đính kèm / gỡ ảnh-video. */
  post: boolean;
  /** Đổi trạng thái / chốt phương án. */
  setStatus: boolean;
  /** Tag thêm người. */
  tag: boolean;
  /** Bỏ tag một người. */
  untag: boolean;
};

const NONE: TopicAccess = { view: false, post: false, setStatus: false, tag: false, untag: false };

const isAdmin = (v: TopicViewer) => v.role === "ADMIN";
// `can()` chỉ đọc role / permissions / modules / organization — đúng các trường của `TopicViewer`.
const has = (v: TopicViewer, p: Permission) => can(v as SessionUser, p);

/** Người này được MỞ topic mới không (khoá hẹp của marketing, hoặc quyền sản xuất đầy đủ). */
export function canOpenTopic(v: TopicViewer): boolean {
  return has(v, "production:topic-open") || has(v, "production:write");
}

/** Hàm THUẦN: quyền của một người trên một topic, từ các sự thật đã đọc. */
export function topicAccess(v: TopicViewer, f: TopicAccessFacts): TopicAccess {
  const creator = f.createdByUserId !== null && f.createdByUserId === v.id;
  const insider = creator || f.isMember;
  const view = isAdmin(v) || insider || (!f.restricted && has(v, "planning:view"));
  if (!view) return NONE;
  const prod = has(v, "production:write");
  const post = insider || prod || isAdmin(v);
  return { view, post, setStatus: creator || prod || isAdmin(v), tag: post, untag: creator || isAdmin(v) };
}

/**
 * Điều kiện SQL "người này xem được topic" — CÙNG luật với `topicAccess().view`, cho các truy vấn danh sách.
 * Truy vấn con viết TƯỜNG MINH `"production_topics"."id"`: drizzle in `${tp.id}` KHÔNG kèm tên bảng khi truy
 * vấn chỉ có một bảng, và `id` trần bên trong câu con bị hiểu thành `m.id` — mọi người thành "không được tag".
 */
export function topicVisibleSql(v: TopicViewer): SQL | undefined {
  if (isAdmin(v)) return undefined;
  const tp = schema.productionTopics;
  const member = sql`exists (select 1 from ${schema.productionTopicMembers} m where m.topic_id = "production_topics"."id" and m.user_id = ${v.id})`;
  const conds: SQL[] = [eq(tp.createdByUserId, v.id), member];
  if (has(v, "planning:view")) conds.push(eq(tp.restricted, false));
  return or(...conds);
}

/** Đọc sự thật của MỘT topic cho một người. `null` = topic không tồn tại. */
export async function loadTopicAccess(db: Db, topicId: string, v: TopicViewer): Promise<(TopicAccess & { facts: TopicAccessFacts }) | null> {
  const tp = schema.productionTopics;
  const mb = schema.productionTopicMembers;
  const [row] = await db
    .select({
      restricted: tp.restricted,
      createdByUserId: tp.createdByUserId,
      member: sql<boolean>`exists (select 1 from ${mb} m where m.topic_id = "production_topics"."id" and m.user_id = ${v.id})`,
    })
    .from(tp)
    .where(eq(tp.id, topicId))
    .limit(1);
  if (!row) return null;
  const facts: TopicAccessFacts = { restricted: row.restricted, createdByUserId: row.createdByUserId, isMember: row.member === true };
  return { ...topicAccess(v, facts), facts };
}

/** Topic của một tệp đính kèm — để hỏi quyền theo topic chứa nó. */
export async function topicIdOfFile(db: Db, fileId: string): Promise<string | null> {
  const [r] = await db.select({ topicId: schema.productionTopicFiles.topicId }).from(schema.productionTopicFiles).where(eq(schema.productionTopicFiles.id, fileId)).limit(1);
  return r?.topicId ?? null;
}

/** Người nhận tin của topic: người mở + người được tag, trừ `exceptUserId` (người vừa thao tác). */
export async function topicAudience(db: Db, topicId: string, exceptUserId: string | null): Promise<string[]> {
  const [t] = await db.select({ createdBy: schema.productionTopics.createdByUserId }).from(schema.productionTopics).where(eq(schema.productionTopics.id, topicId)).limit(1);
  const members = await db
    .select({ userId: schema.productionTopicMembers.userId })
    .from(schema.productionTopicMembers)
    .innerJoin(schema.users, and(eq(schema.users.id, schema.productionTopicMembers.userId), eq(schema.users.active, true)))
    .where(eq(schema.productionTopicMembers.topicId, topicId));
  const ids = new Set(members.map((m) => m.userId));
  if (t?.createdBy) ids.add(t.createdBy);
  if (exceptUserId) ids.delete(exceptUserId);
  return [...ids];
}

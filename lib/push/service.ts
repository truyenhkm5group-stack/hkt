import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { COMPANY } from "@/lib/constants/company";
import { allowedPushEndpoint, sendWebPush, type PushMessage, type PushResult, type VapidKeys } from "@/lib/push/web-push";

/**
 * ═══════════ THÔNG BÁO ĐẨY — ĐĂNG KÝ VÀ GỬI (docs/platform/pwa.md) ═══════════
 *
 *  · Nguồn tin DUY NHẤT là hộp thư cá nhân (`lib/inbox/send.ts`): tin nào vào `user_messages` thì đẩy tới máy của đúng người
 *    nhận. Không có đường đẩy thứ hai — thêm một loại thông báo = gửi một tin hộp thư như mọi nơi khác đã làm.
 *  · Một người, nhiều tin trong CÙNG một lượt ⇒ MỘT thông báo («… và N tin khác»): điện thoại rung một lần, không mười lần.
 *  · Đăng ký chết (máy chủ đẩy trả 404 / 410 / 401 / 403, hoặc endpoint lạ) ⇒ xoá dòng; lỗi tạm ⇒ ghi `last_error`, giữ lại.
 *  · Không bao giờ ném: hỏng thông báo đẩy không được làm hỏng việc đã sinh ra tin.
 */

export type PushItem = { userId: string; title: string; body: string; href: string; tag?: string };
export type PushDeps = { fetch?: typeof fetch; keys?: VapidKeys; db?: Db };
export type PushSummary = { sent: number; failed: number; removed: number };

const MAX_SUBS_PER_USER = 10;

// Bài kiểm thay máy chủ đẩy bằng hàm giả (luật 65: bộ kiểm thử không gọi mạng thật) — kể cả đường hộp thư không truyền `deps`.
let testFetch: typeof fetch | null = null;
export function setPushFetchForTests(f: typeof fetch | null): void {
  testFetch = f;
}

/** Gộp tin theo người nhận: một người một thông báo mỗi lượt. HÀM THUẦN. */
export function groupPushItems(items: readonly PushItem[]): PushItem[] {
  const byUser = new Map<string, PushItem[]>();
  for (const it of items) byUser.set(it.userId, [...(byUser.get(it.userId) ?? []), it]);
  return [...byUser.values()].map((list) => {
    const first = list[0];
    if (list.length === 1) return first;
    return { ...first, body: `${first.body ? `${first.body} — ` : ""}và ${list.length - 1} tin khác trong hộp thư ERP`, tag: undefined };
  });
}

/** Gửi tới mọi máy đã bật của những người nhận. `deps.db` = CSDL tổ chức của các tin (mặc định: tổ chức của phiên). */
export async function pushToUsers(items: readonly PushItem[], deps: PushDeps = {}): Promise<PushSummary> {
  const out: PushSummary = { sent: 0, failed: 0, removed: 0 };
  if (!items.length) return out;
  const db = deps.db ?? (await getDb());
  const t = schema.pushSubscriptions;
  const userIds = [...new Set(items.map((i) => i.userId))];
  const subs = await db.select({ id: t.id, userId: t.userId, endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth }).from(t).where(inArray(t.userId, userIds));
  if (!subs.length) return out;
  const subject = `mailto:${COMPANY.email}`;
  const okIds: string[] = [];
  const goneIds: string[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const item of groupPushItems(items)) {
    const mine = subs.filter((s) => s.userId === item.userId).slice(0, MAX_SUBS_PER_USER);
    const msg: PushMessage = { title: item.title, body: item.body, href: item.href || "/", tag: item.tag };
    const results = await Promise.all(mine.map(async (s) => [s.id, await sendWebPush(s, msg, { fetch: deps.fetch ?? testFetch ?? undefined, keys: deps.keys, subject })] as const));
    for (const [id, r] of results) tally(id, r);
  }
  function tally(id: string, r: PushResult) {
    if (r.ok) {
      out.sent += 1;
      okIds.push(id);
    } else if (r.gone) {
      out.removed += 1;
      goneIds.push(id);
    } else {
      out.failed += 1;
      errors.push({ id, error: r.error });
    }
  }
  if (goneIds.length) await db.delete(t).where(inArray(t.id, goneIds));
  if (okIds.length) await db.update(t).set({ lastOkAt: sql`now()`, lastError: null }).where(inArray(t.id, okIds));
  for (const e of errors) await db.update(t).set({ lastError: e.error.slice(0, 300) }).where(eq(t.id, e.id));
  return out;
}

export type SubscriptionInput = { endpoint: string; p256dh: string; auth: string; userAgent?: string | null };

/**
 * Lưu đăng ký của máy đang dùng cho NGƯỜI đang đăng nhập. Một endpoint là một máy ⇒ người khác đăng nhập máy đó rồi bấm bật
 * thì đăng ký CHUYỂN sang người mới (không để tin của người cũ tiếp tục hiện trên máy đã đổi chủ).
 */
export async function savePushSubscription(userId: string, input: SubscriptionInput, dbIn?: Db): Promise<{ ok: true } | { error: string }> {
  if (!allowedPushEndpoint(input.endpoint)) return { error: "Trình duyệt này dùng máy chủ thông báo ERP không hỗ trợ." };
  const db = dbIn ?? (await getDb());
  const t = schema.pushSubscriptions;
  const values = { userId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent?.slice(0, 300) ?? null, lastError: null };
  await db.insert(t).values(values).onConflictDoUpdate({ target: t.endpoint, set: { userId, p256dh: values.p256dh, auth: values.auth, userAgent: values.userAgent, lastError: null } });
  return { ok: true };
}

/** Tắt trên máy này: chỉ xoá đăng ký CỦA CHÍNH người đang đăng nhập. */
export async function removePushSubscription(userId: string, endpoint: string, dbIn?: Db): Promise<number> {
  const db = dbIn ?? (await getDb());
  const t = schema.pushSubscriptions;
  const rows = await db
    .delete(t)
    .where(and(eq(t.userId, userId), eq(t.endpoint, endpoint)))
    .returning({ id: t.id });
  return rows.length;
}

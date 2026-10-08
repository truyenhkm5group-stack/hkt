/**
 * ═══════════ GỬI SỰ KIỆN MUA HÀNG SANG META KHI CHỐT ĐƠN (job `meta-capi-org` · 0236) — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ shop HSLC 08/10/2026: «gửi sự kiện khi chốt đơn». Nguồn sự thật của «đã chốt» là sổ `domain_events` (`order.confirmed`,
 * ghi CÙNG giao dịch với lượt chốt ở `lib/records/order-create.ts` — mọi đường: bot chốt, máy ghi đơn từ hội thoại, nhân viên
 * bấm, tự xác nhận đơn đủ thông tin). Job KHÔNG chạm đường chốt đơn: một lỗi của Meta không bao giờ làm hỏng một đơn.
 *
 * Mỗi lượt (fan-out mỗi 10 phút, tổ chức nào đã BẬT kết nối «meta-capi-org»):
 *  1. Xếp hàng: `order.confirmed` trong 7 ngày chưa có dòng ở `meta_conversion_events` ⇒ một dòng `PENDING` (đơn chốt trong
 *     hội thoại Messenger, có PSID, có giá trị) hoặc `SKIPPED` kèm lý do (đếm được, không biến mất).
 *  2. Gửi: dòng `PENDING` / `FAILED` tới hạn ⇒ đọc lại trạng thái đơn (huỷ trước lượt gửi ⇒ `SKIPPED`), một request cho mỗi
 *     sự kiện. Token sai / thiếu quyền ⇒ dừng lượt (không gõ tiếp vào một cửa đóng), các dòng chờ lượt sau.
 * Tổ chức nhà / chưa bật kết nối / không có việc ⇒ bỏ qua sau một câu đọc, KHÔNG ghi sync_runs.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { openActiveConnection } from "@/lib/connectors/service";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import {
  buildPurchaseEvent,
  capiNextAttempt,
  capiVerdict,
  classifyOrderForCapi,
  META_CAPI_CONNECTOR,
  META_CAPI_ENQUEUE_PER_RUN,
  META_CAPI_EVENT_NAME,
  META_CAPI_SEND_PER_RUN,
  META_CAPI_WINDOW_MS,
  META_DATASET_ID_PATTERN,
  META_GRAPH_HOST,
  metaCapiEventId,
  psidOf,
} from "@/lib/constants/meta-capi";
import { env } from "@/lib/env";
import { currentOrganization } from "@/lib/platform/context";
import { orderChatThreads } from "@/lib/queries/orders";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

export type MetaCapiSkipped = { skipped: "HOME_ORG" | "NO_ACTIVE_CONNECTION" | "NO_DATASET" | "NOTHING_TO_DO"; org: string; detail: string };
export type MetaCapiDeps = { fetch?: typeof fetch; now?: () => Date };

const TIMEOUT_MS = 10_000;

/** Đơn chốt chưa xếp hàng — đọc sổ sự kiện, chỉ 7 ngày gần nhất (Meta không nhận cũ hơn). */
async function pendingConfirmations(now: Date) {
  const db = await getDb();
  const d = schema.domainEvents;
  const m = schema.metaConversionEvents;
  return db
    .select({ orderId: d.subjectId, at: d.occurredAt })
    .from(d)
    .where(and(eq(d.name, "order.confirmed"), eq(d.subjectType, "order"), gte(d.occurredAt, new Date(now.getTime() - META_CAPI_WINDOW_MS)), sql`not exists (select 1 from ${m} where ${m.orderId} = ${d.subjectId})`))
    .orderBy(asc(d.occurredAt))
    .limit(META_CAPI_ENQUEUE_PER_RUN);
}

/** PSID của từng hội thoại fanpage — dòng tin KHÁCH mới nhất có `sender_id` (0233), kèm cờ «có tin hộp thư». */
async function psidsOf(threads: readonly { pageId: string; threadId: string }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!threads.length) return out;
  const db = await getDb();
  const t = schema.salesChatInbound;
  const pairs = sql.join(
    threads.map((x) => sql`(${x.pageId}, ${x.threadId})`),
    sql`, `,
  );
  const rows = await db
    .select({
      pageId: t.pageId,
      threadId: t.threadId,
      senderId: sql<string | null>`(array_agg(${t.senderId} order by ${t.createdAt} desc) filter (where ${t.senderId} is not null))[1]`,
      inbox: sql<boolean>`bool_or(${t.kind} = 'INBOX' and coalesce(${t.note}, '') not in ('BOT_SENT', 'PAGE_REPLY'))`,
    })
    .from(t)
    .where(sql`(${t.pageId}, ${t.threadId}) in (${pairs})`)
    .groupBy(t.pageId, t.threadId);
  for (const x of threads) {
    const r = rows.find((y) => y.pageId === x.pageId && y.threadId === x.threadId);
    out.set(`${x.pageId}|${x.threadId}`, psidOf({ pageId: x.pageId, threadId: x.threadId, senderId: r?.senderId ?? null, hasInboxMessage: Boolean(r?.inbox) }));
  }
  return out;
}

/** Bước 1 — xếp hàng các đơn vừa chốt. Trả số dòng mới theo trạng thái. */
async function enqueue(now: Date): Promise<{ pending: number; skipped: number }> {
  const fresh = await pendingConfirmations(now);
  if (!fresh.length) return { pending: 0, skipped: 0 };
  const db = await getDb();
  const o = schema.orders;
  const ids = [...new Set(fresh.map((f) => f.orderId))];
  const orders = await db.select({ id: o.id, stage: o.stage, value: o.totalPriceAfterDiscount, conv: o.salesConversationId }).from(o).where(inArray(o.id, ids));
  const byId = new Map(orders.map((r) => [r.id, r]));
  // Khoá CỨNG trước (`orders.sales_conversation_id`) — một hội thoại có thể có NHIỀU đơn (khách mua lại), mà đường tra ngược
  // `orderChatThreads` gom theo hội thoại; chỉ đơn không mang cột đó mới đi đường cũ.
  const c = schema.salesChatConversations;
  const convIds = [...new Set(orders.flatMap((r) => (r.conv ? [r.conv] : [])))];
  const convs = convIds.length ? new Map((await db.select({ id: c.id, channel: c.channel, pageId: c.pageId, threadId: c.threadId }).from(c).where(inArray(c.id, convIds))).map((r) => [r.id, r])) : new Map<string, { id: string; channel: string; pageId: string | null; threadId: string | null }>();
  const legacy = await orderChatThreads(orders.filter((r) => !r.conv).map((r) => r.id));
  const chats = new Map<string, { channel: string; pageId: string | null; threadId: string | null }>();
  for (const r of orders) {
    const hit = r.conv ? convs.get(r.conv) : legacy.get(r.id);
    if (hit && hit.channel !== "TEST") chats.set(r.id, { channel: hit.channel, pageId: hit.pageId, threadId: hit.threadId });
  }
  const threads = [...chats.values()].filter((c) => c.channel === "FANPAGE" && c.pageId && c.threadId).map((c) => ({ pageId: c.pageId as string, threadId: c.threadId as string }));
  const psids = await psidsOf(threads);
  let pending = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const f of fresh) {
    if (seen.has(f.orderId)) continue;
    seen.add(f.orderId);
    const ord = byId.get(f.orderId);
    const chat = chats.get(f.orderId) ?? null;
    const psid = chat?.pageId && chat.threadId ? (psids.get(`${chat.pageId}|${chat.threadId}`) ?? null) : null;
    const value = ord ? Number(ord.value ?? 0) : null;
    const verdict = classifyOrderForCapi({ exists: Boolean(ord), stage: ord?.stage ?? null, valueVnd: value, channel: chat?.channel ?? null, pageId: chat?.pageId ?? null, psid, eventTime: f.at, now });
    const base = { orderId: f.orderId, eventName: META_CAPI_EVENT_NAME, eventId: metaCapiEventId(f.orderId), eventTime: f.at, pageId: chat?.pageId ?? null, psid, valueVnd: value && value > 0 ? value : null };
    const inserted = await db
      .insert(schema.metaConversionEvents)
      .values(verdict.status === "PENDING" ? { ...base, status: "PENDING", nextAttemptAt: now } : { ...base, status: "SKIPPED", skipReason: verdict.reason })
      .onConflictDoNothing({ target: schema.metaConversionEvents.orderId })
      .returning({ id: schema.metaConversionEvents.id });
    if (!inserted.length) continue;
    if (verdict.status === "PENDING") pending += 1;
    else skipped += 1;
  }
  return { pending, skipped };
}

/** Dòng tới hạn gửi. */
async function dueRows(now: Date) {
  const db = await getDb();
  const m = schema.metaConversionEvents;
  return db
    .select()
    .from(m)
    .where(and(inArray(m.status, ["PENDING", "FAILED"]), or(isNull(m.nextAttemptAt), lte(m.nextAttemptAt, now)), isNotNull(m.psid)))
    .orderBy(asc(m.eventTime))
    .limit(META_CAPI_SEND_PER_RUN);
}

/** Bước 2 — gửi từng sự kiện. `auth` = token / quyền hỏng ⇒ dừng lượt. */
async function send(due: Awaited<ReturnType<typeof dueRows>>, cred: { datasetId: string; token: string }, deps: MetaCapiDeps, now: Date) {
  const db = await getDb();
  const m = schema.metaConversionEvents;
  const o = schema.orders;
  const fetchImpl = deps.fetch ?? fetch;
  const out = { sent: 0, failed: 0, skipped: 0, authError: null as string | null, errors: [] as string[] };
  const stages = due.length ? new Map((await db.select({ id: o.id, stage: o.stage }).from(o).where(inArray(o.id, due.map((r) => r.orderId)))).map((r) => [r.id, r.stage])) : new Map<string, string>();
  for (const row of due) {
    const stage = stages.get(row.orderId);
    const late = now.getTime() - row.eventTime.getTime() > META_CAPI_WINDOW_MS;
    const skip = stage === undefined ? "ORDER_MISSING" : stage === "CANCELLED" || stage === "DELETED" ? "CANCELLED_BEFORE_SEND" : late ? "TOO_OLD" : null;
    if (skip) {
      await db.update(m).set({ status: "SKIPPED", skipReason: skip, nextAttemptAt: null, updatedAt: now }).where(eq(m.id, row.id));
      out.skipped += 1;
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = buildPurchaseEvent({ orderId: row.orderId, eventTime: row.eventTime, pageId: row.pageId ?? "", psid: row.psid ?? "", valueVnd: row.valueVnd ?? 0, orderCode: `#${manualOrderShortCode(row.orderId)}` });
    } catch (e) {
      await db.update(m).set({ status: "SKIPPED", skipReason: row.valueVnd ? "NO_PSID" : "NO_VALUE", lastError: e instanceof Error ? e.message : String(e), nextAttemptAt: null, updatedAt: now }).where(eq(m.id, row.id));
      out.skipped += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    try {
      const url = `${META_GRAPH_HOST}/${encodeURIComponent(env.facebook.apiVersion)}/${encodeURIComponent(cred.datasetId)}/events`;
      const res = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${cred.token}`, "content-type": "application/json" }, body: JSON.stringify({ data: [event] }), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }
      const v = capiVerdict(res.status, body);
      if (v.ok) {
        await db.update(m).set({ status: "SENT", attempts, sentAt: now, fbtraceId: v.fbtraceId, lastError: null, nextAttemptAt: null, updatedAt: now }).where(eq(m.id, row.id));
        out.sent += 1;
        continue;
      }
      await db.update(m).set({ status: "FAILED", attempts, lastError: v.message.replace(cred.token, "••••"), fbtraceId: v.fbtraceId, nextAttemptAt: capiNextAttempt(attempts, now), updatedAt: now }).where(eq(m.id, row.id));
      out.failed += 1;
      out.errors.push(v.message.replace(cred.token, "••••"));
      if (v.auth) {
        out.authError = v.message.replace(cred.token, "••••");
        break;
      }
    } catch (e) {
      const msg = `không gọi được Meta: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      await db.update(m).set({ status: "FAILED", attempts, lastError: msg, nextAttemptAt: capiNextAttempt(attempts, now), updatedAt: now }).where(eq(m.id, row.id));
      out.failed += 1;
      out.errors.push(msg);
    }
  }
  return out;
}

/** Job `meta-capi-org` — một lượt cho tổ chức ngữ cảnh. */
export async function runOrgMetaCapi(options: { trigger?: SyncTrigger; actor?: string } = {}, deps: MetaCapiDeps = {}) {
  const org = await currentOrganization();
  if (org.isHome) {
    const r: MetaCapiSkipped = { skipped: "HOME_ORG", org: org.code, detail: "Tổ chức nhà đồng bộ đơn từ Pancake — sự kiện chuyển đổi gửi từ Pancake, không từ job này." };
    return r;
  }
  const conn = await openActiveConnection(META_CAPI_CONNECTOR);
  if (!conn.ok) {
    const r: MetaCapiSkipped = { skipped: "NO_ACTIVE_CONNECTION", org: org.code, detail: `Bỏ qua: ${conn.reason}` };
    return r;
  }
  const datasetId = (conn.settings.datasetId ?? "").trim();
  const token = (conn.secrets.accessToken ?? "").trim();
  if (!META_DATASET_ID_PATTERN.test(datasetId) || !token) {
    const r: MetaCapiSkipped = { skipped: "NO_DATASET", org: org.code, detail: "Bỏ qua: kết nối chưa khai mã dataset / token hợp lệ." };
    return r;
  }
  const now = (deps.now ?? (() => new Date()))();
  const fresh = await pendingConfirmations(now);
  const due = await dueRows(now);
  if (!fresh.length && !due.length) {
    const r: MetaCapiSkipped = { skipped: "NOTHING_TO_DO", org: org.code, detail: "Không có đơn chốt mới và không có sự kiện chờ gửi." };
    return r;
  }
  return runSyncJob({ source: "FACEBOOK", job: "capi_purchase", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const q = await enqueue(now);
    const r = await send(await dueRows(now), { datasetId, token }, deps, now);
    ctx.summary.imported = q.pending;
    ctx.summary.updated = r.sent;
    ctx.summary.skipped = q.skipped + r.skipped;
    ctx.summary.failed = r.failed;
    ctx.summary.detail = `${q.pending} đơn chốt mới chờ gửi · ${q.skipped} đơn không gửi được (kèm lý do) · đã gửi ${r.sent} sự kiện Purchase · ${r.failed} lỗi${r.authError ? " · DỪNG: token / quyền hỏng" : ""}`;
    if (r.errors.length) ctx.summary.warning = (r.authError ? `Meta từ chối token / quyền dataset — sửa ở Kết nối dữ liệu rồi kiểm tra lại: ${r.authError}` : r.errors.slice(0, 3).join(" · ")).slice(0, 500);
    return { ...q, ...r };
  });
}

/** Số đếm theo trạng thái / lý do bỏ qua trong `days` ngày — cho màn hình kết nối và ops. */
export async function metaCapiSummary(days = 7, now: Date = new Date()) {
  const db = await getDb();
  const m = schema.metaConversionEvents;
  const rows = await db
    .select({ status: m.status, reason: m.skipReason, n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${m.valueVnd}) filter (where ${m.status} = 'SENT'), 0)::bigint` })
    .from(m)
    .where(gte(m.eventTime, new Date(now.getTime() - days * 86_400_000)))
    .groupBy(m.status, m.skipReason);
  return rows.map((r) => ({ status: r.status, reason: r.reason, n: Number(r.n), sentValueVnd: Number(r.value) }));
}

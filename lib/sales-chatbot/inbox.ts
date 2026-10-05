import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/realtime/bus";
import { can, type SessionUser } from "@/lib/auth/session";
import { isManualOrderId, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { sha256Hex, sniffImageType } from "@/lib/creative/images";
import { zaloWindow, ZALO_IMAGE_MAX_BYTES } from "@/lib/integrations/zalo/oa";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { appendContextMessages, resumeConversationToAi, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { labelsFor, listLabels, notesFor } from "@/lib/sales-chatbot/inbox-labels";
import { PAGE_REPLY, STAFF_OUT_PREFIX, STAFF_REASON, type FanpageDeps } from "@/lib/sales-chatbot/fanpage";
import { MESSAGING_WINDOW_MS } from "@/lib/sales-chatbot/followup-shared";
import {
  INBOX_CHANNEL_LABEL,
  INBOX_CHANNELS,
  INBOX_FILTERS,
  INBOX_LIST_MAX,
  INBOX_OUTCOME_LABEL,
  INBOX_PERIODS,
  STAFF_IMAGE_MAX_BYTES,
  STAFF_IMAGE_TYPES,
  STAFF_IMAGES_MAX,
  STAFF_REPLY_MAX,
  type InboxChannel,
  type InboxCustomerHistory,
  type InboxFilter,
  type InboxOrder,
  type InboxPeriod,
  type InboxRow,
  type InboxThread,
  type SendWindow,
  type TimelineItem,
  type TimelineSide,
} from "@/lib/sales-chatbot/inbox-shared";

type StaffImageType = (typeof STAFF_IMAGE_TYPES)[number];
import { sendBotText, sendPageImages } from "@/lib/sales-chatbot/messenger";
import { draftCopilotSuggestion } from "@/lib/sales-chatbot/operating-mode";
import { feedbackFor } from "@/lib/sales-chatbot/inbox-feedback";
import { CUSTOMER_LEVELS, parseCustomerLevel, type CustomerLevel } from "@/lib/sales-chatbot/levels-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { assessCustomerRisk } from "@/lib/alerts/risk";
import { loadAlertConfig } from "@/lib/alerts/config";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { sendZaloImages, sendZaloText, ZALO_STAFF_REASON } from "@/lib/sales-chatbot/zalo";

/**
 * ═══════════ HỘP THƯ NGƯỜI TRONG ERP (M8 · docs/productization/MIGRATION_PLAN.md) ═══════════
 *
 * Nhân viên đọc và TRẢ LỜI khách Facebook / Instagram / Zalo OA / chat web ngay trong ERP (chủ shop 05/10/2026: «làm tốt hơn
 * Pancake»). Không có đường gửi thứ hai: tin đi qua ĐÚNG hàm gửi của kênh (`sendBotText` · `sendZaloText`), đánh dấu là tin
 * NHÂN VIÊN (`staff-out:` + `PAGE_REPLY` — mọi chỗ đang hiểu «page đã trả lời» hiểu đúng). Năm luật:
 *  1. QUY KẾT BẰNG KHOÁ TÀI KHOẢN (AGENTS 34). Mỗi lượt «Gửi» là một dòng `sales_chat_staff_messages` mang `users.id`; tên là
 *     ảnh chụp máy chủ đọc từ `users`. Sổ sự kiện: `human.replied` (+ `human.took_over` khi hội thoại chuyển sang người).
 *  2. BẤM HAI LẦN KHÔNG GỬI KHÁCH HAI TIN. `request_key` do form sinh cho mỗi tin; trùng ⇒ trả kết quả của lượt trước.
 *  3. BOT NHƯỜNG. Gửi xong ⇒ hội thoại `HANDOFF` với lý do «nhân viên đang trả lời» của kênh (bot tự nhận lại sau 30 phút như
 *     khi nhân viên trả lời ngoài ERP); đang CẦN NGƯỜI vì lý do khác thì giữ lý do đó.
 *  4. KHUNG GỬI CỦA KÊNH LÀ LUẬT CỦA KÊNH. Zalo: quá 48 giờ là tin TÍNH PHÍ ⇒ người bấm phải xác nhận; quá 7 ngày ⇒ không gửi.
 *     Messenger: quá 24 giờ ⇒ cảnh báo (Meta có thể chặn) — không tự chặn, vì đường Pancake có thể còn gửi được.
 *  5. GỬI HỎNG LÀ HỎNG. Dòng `FAILED` hiện đỏ trong hộp thư, không vào lịch sử của bot, không tính «đã trả lời».
 */

const VIEW = "ai_sales:view";
const MANAGE = "ai_sales:manage";

const NO_VIEW = "Bạn không có quyền xem hội thoại (ai_sales:view).";
const NO_REPLY = "Bạn không có quyền trả lời khách (ai_sales:reply).";

/**
 * Trả lời khách = GỬI TIN cho khách. Khoá riêng `ai_sales:reply` (module AI bán hàng — tổ chức chỉ mua AI bán hàng vẫn có);
 * `outreach:send` («Chăm sóc & bán chéo: gửi tin») cũng đủ — vai trò đã lưu quyền ở tổ chức nhà không mất việc trả lời.
 */
function canReplyTo(user: SessionUser): boolean {
  return can(user, "ai_sales:reply") || can(user, "outreach:send");
}
export const WEB_STAFF_REASON = "Nhân viên đang trả lời trên chat web";

export type InboxResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const C = "sales_chat_conversations";
/** Tin khách CHƯA ai trả lời: mới hơn tin bot, tin nhân viên ERP, và mọi tin phía page ngoài ERP. Tên cột viết TƯỜNG MINH (câu con tương quan). */
const NEEDS_REPLY = sql<boolean>`("${sql.raw(C)}"."last_customer_at" is not null
  and "${sql.raw(C)}"."last_customer_at" > coalesce("${sql.raw(C)}"."last_bot_at", 'epoch'::timestamptz)
  and "${sql.raw(C)}"."last_customer_at" > coalesce("${sql.raw(C)}"."last_staff_at", 'epoch'::timestamptz)
  and not exists (select 1 from "sales_chat_inbound" i where i.page_id = "${sql.raw(C)}"."page_id" and i.thread_id = "${sql.raw(C)}"."thread_id"
    and i.note = ${PAGE_REPLY} and i.created_at > "${sql.raw(C)}"."last_customer_at"))`;
/** Chưa đọc: tin khách mới hơn lần cuối một NHÂN VIÊN mở hội thoại trong hộp thư. */
const UNREAD = sql<boolean>`("${sql.raw(C)}"."last_customer_at" is not null and "${sql.raw(C)}"."last_customer_at" > coalesce("${sql.raw(C)}"."staff_seen_at", 'epoch'::timestamptz))`;
/** Mốc TIN cuối (khách · bot · nhân viên ERP), không phải `updated_at` — mở / gắn nhãn / nhận hội thoại không được đẩy nó lên đầu. */
const ACTIVITY = sql<Date>`greatest(coalesce("${sql.raw(C)}"."last_customer_at", 'epoch'::timestamptz), coalesce("${sql.raw(C)}"."last_bot_at", 'epoch'::timestamptz), coalesce("${sql.raw(C)}"."last_staff_at", 'epoch'::timestamptz), "${sql.raw(C)}"."created_at")`;
const HAS_ORDER = sql<boolean>`("${sql.raw(C)}"."order_id" is not null or "${sql.raw(C)}"."draft_order_id" is not null or exists (select 1 from "orders" o where o.sales_conversation_id = "${sql.raw(C)}"."id"))`;
const INBOUND_NAME = sql<string | null>`(select i.customer_name from "sales_chat_inbound" i where i.page_id = "${sql.raw(C)}"."page_id" and i.thread_id = "${sql.raw(C)}"."thread_id" and i.customer_name is not null and i.customer_name <> '' order by i.created_at desc limit 1)`;

/** Có SĐT: SĐT hội thoại (job level đọc từ tin khách / Pancake) · hồ sơ khách · sổ trạng thái bot. */
const HAS_PHONE = sql<boolean>`(coalesce("${sql.raw(C)}"."customer_phone", '') <> '' or coalesce("customers"."phone", '') <> '' or coalesce("${sql.raw(C)}"."state"->'customer'->>'phone', '') <> '')`;

const dayZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null);
const listZ = z.object({
  filter: z.enum(INBOX_FILTERS).catch("ALL"),
  label: z.string().trim().min(1).max(100).nullable().catch(null),
  channel: z.enum(INBOX_CHANNELS).nullable().catch(null),
  q: z.string().trim().max(80).catch(""),
  phone: z.enum(["HAS", "NONE"]).nullable().catch(null),
  level: z.enum(CUSTOMER_LEVELS).nullable().catch(null),
  /** Người phụ trách: mã tài khoản, hoặc «none» = chưa ai cầm. */
  assignee: z.string().trim().min(1).max(100).nullable().catch(null),
  period: z.enum(INBOX_PERIODS).nullable().catch(null),
  from: dayZ,
  to: dayZ,
  limit: z.number().int().min(50).max(INBOX_LIST_MAX).catch(100),
});

/** Ngày giờ Việt Nam ⇒ mốc UTC đầu ngày. */
const vnDayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 3_600_000);

/** Khoảng thời gian của bộ lọc (theo mốc TIN cuối) — `null` = không lọc. HÀM THUẦN. */
export function inboxPeriodRange(q: { period: InboxPeriod | null; from: string | null; to: string | null }, now: Date): { from: Date | null; to: Date | null } | null {
  const today = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const start = vnDayStart(today);
  switch (q.period) {
    case "TODAY":
      return { from: start, to: null };
    case "YESTERDAY":
      return { from: new Date(start.getTime() - 86_400_000), to: start };
    case "7D":
      return { from: new Date(start.getTime() - 6 * 86_400_000), to: null };
    case "30D":
      return { from: new Date(start.getTime() - 29 * 86_400_000), to: null };
    case "CUSTOM":
      if (!q.from && !q.to) return null;
      return { from: q.from ? vnDayStart(q.from) : null, to: q.to ? new Date(vnDayStart(q.to).getTime() + 86_400_000) : null };
    default:
      return null;
  }
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isFinite(x.getTime()) ? x.toISOString() : null;
}

function textOf(blocks: readonly AiBlock[] | null | undefined): string {
  return (blocks ?? [])
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function inboundSide(note: string | null, messageId: string): TimelineSide {
  if (note === "BOT_SENT") return "BOT";
  if (note === PAGE_REPLY) return messageId.startsWith(STAFF_OUT_PREFIX) ? "STAFF" : "PAGE";
  return "CUSTOMER";
}

/** Danh sách hội thoại của hộp thư (tối đa 100) — lọc theo việc cần làm, kênh, tên / SĐT. Không kéo nội dung tin (chỉ một dòng xem trước). */
export async function listInbox(user: SessionUser, rawQuery: unknown, now: Date = new Date()): Promise<InboxResult<{ rows: InboxRow[]; counts: Record<InboxFilter, number>; levelCounts: Partial<Record<CustomerLevel, number>>; phoneCount: number; total: number }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  const q = listZ.parse(rawQuery ?? {});
  const db = await getDb();
  const c = schema.salesChatConversations;
  const cu = schema.customers;
  const u = schema.users;
  const base: SQL[] = [ne(c.channel, "TEST")];
  if (q.channel) base.push(eq(c.channel, q.channel));
  if (q.label) base.push(sql`exists (select 1 from "sales_chat_conversation_labels" cl where cl.conversation_id = "${sql.raw(C)}"."id" and cl.label_id = ${q.label})`);
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    base.push(or(sql`${cu.name} ilike ${like}`, sql`${cu.phone} ilike ${like}`, sql`${c.customerPhone} ilike ${like}`, sql`${c.state}->'customer'->>'name' ilike ${like}`, sql`${c.state}->'customer'->>'phone' ilike ${like}`, sql`${INBOUND_NAME} ilike ${like}`)!);
  }
  if (q.phone === "HAS") base.push(HAS_PHONE);
  if (q.phone === "NONE") base.push(sql`not ${HAS_PHONE}`);
  if (q.assignee === "none") base.push(isNull(c.assigneeUserId));
  else if (q.assignee) base.push(eq(c.assigneeUserId, q.assignee));
  const range = inboxPeriodRange(q, now);
  if (range?.from) base.push(sql`${ACTIVITY} >= ${range.from}`);
  if (range?.to) base.push(sql`${ACTIVITY} < ${range.to}`);
  // Bộ lọc level đứng RIÊNG: số đếm theo level tính trên các bộ lọc khác (chip level không tự triệt tiêu nhau).
  const levelCond = q.level ? eq(c.customerLevel, q.level) : undefined;
  const byFilter: Record<InboxFilter, SQL | undefined> = {
    ALL: undefined,
    UNREAD: UNREAD,
    UNANSWERED: NEEDS_REPLY,
    NEEDS_HUMAN: eq(c.status, "HANDOFF"),
    MINE: eq(c.assigneeUserId, user.id),
    UNASSIGNED: and(isNull(c.assigneeUserId), or(eq(c.status, "HANDOFF"), NEEDS_REPLY)),
  };
  // MỘT câu đếm cho mọi thẻ (trước đây sáu câu cho mỗi lượt làm mới 5 giây).
  const countCols = Object.fromEntries(INBOX_FILTERS.map((f) => [f, byFilter[f] ? sql<number>`count(*) filter (where ${byFilter[f]})::int` : sql<number>`count(*)::int`])) as Record<InboxFilter, SQL<number>>;
  const [countRow] = await db
    .select({ ...countCols, phone: sql<number>`count(*) filter (where ${HAS_PHONE})::int` })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .where(and(...base, ...(levelCond ? [levelCond] : [])));
  const counts = Object.fromEntries(INBOX_FILTERS.map((f) => [f, Number((countRow as Record<string, unknown> | undefined)?.[f] ?? 0)])) as Record<InboxFilter, number>;
  const levelRows = await db
    .select({ level: c.customerLevel, n: sql<number>`count(*)::int` })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .where(and(...base, ...(byFilter[q.filter] ? [byFilter[q.filter]!] : [])))
    .groupBy(c.customerLevel);
  const levelCounts: Partial<Record<CustomerLevel, number>> = {};
  for (const r of levelRows) if (r.level) levelCounts[r.level as CustomerLevel] = Number(r.n);
  const where = and(...base, ...(byFilter[q.filter] ? [byFilter[q.filter]!] : []), ...(levelCond ? [levelCond] : []));
  const rows = await db
    .select({
      id: c.id,
      channel: c.channel,
      status: c.status,
      handoffReason: c.handoffReason,
      pageId: c.pageId,
      threadId: c.threadId,
      customerName: cu.name,
      customerPhone: cu.phone,
      stateName: sql<string | null>`${c.state}->'customer'->>'name'`,
      statePhone: sql<string | null>`${c.state}->'customer'->>'phone'`,
      inboundName: INBOUND_NAME,
      lastCustomerAt: c.lastCustomerAt,
      activity: ACTIVITY,
      needsReply: NEEDS_REPLY,
      unread: UNREAD,
      assigneeUserId: c.assigneeUserId,
      assigneeName: u.name,
      hasOrder: HAS_ORDER,
      level: c.customerLevel,
      convPhone: c.customerPhone,
    })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .leftJoin(u, eq(u.id, c.assigneeUserId))
    .where(where)
    // «Chờ trả lời»: khách chờ LÂU NHẤT lên đầu (đúng thứ tự phải xử lý); còn lại: mới nhất lên đầu.
    .orderBy(q.filter === "UNANSWERED" ? asc(c.lastCustomerAt) : desc(ACTIVITY))
    .limit(q.limit);

  // Một dòng xem trước cho mỗi hội thoại — kênh nhắn tin đọc sổ tin thô của kênh, chat web đọc lịch sử của bot.
  const previews = new Map<string, { text: string; side: TimelineSide }>();
  const messaging = rows.filter((r) => r.pageId && r.threadId);
  if (messaging.length) {
    const t = schema.salesChatInbound;
    const pairs = messaging.map((r) => and(eq(t.pageId, r.pageId!), eq(t.threadId, r.threadId!))!);
    const last = await db
      .selectDistinctOn([t.pageId, t.threadId], { pageId: t.pageId, threadId: t.threadId, text: t.text, note: t.note, messageId: t.messageId, imageUrls: t.imageUrls })
      .from(t)
      .where(and(or(...pairs), eq(t.kind, "INBOX")))
      .orderBy(t.pageId, t.threadId, desc(t.createdAt));
    const byKey = new Map(last.map((l) => [`${l.pageId}\u0000${l.threadId}`, l]));
    for (const r of messaging) {
      const l = byKey.get(`${r.pageId}\u0000${r.threadId}`);
      if (l) previews.set(r.id, { text: l.text.trim() || ((l.imageUrls as string[] | null)?.length ? "[Ảnh]" : "[Tin không có chữ]"), side: inboundSide(l.note, l.messageId) });
    }
  }
  const web = rows.filter((r) => !(r.pageId && r.threadId));
  if (web.length) {
    const m = schema.salesChatMessages;
    const last = await db
      .selectDistinctOn([m.conversationId], { conversationId: m.conversationId, role: m.role, content: m.content })
      .from(m)
      .where(inArray(m.conversationId, web.map((r) => r.id)))
      .orderBy(m.conversationId, desc(m.seq));
    for (const l of last) {
      const text = textOf(l.content as AiBlock[]);
      previews.set(l.conversationId, { text: text.replace(SHOP_SAID, "").trim(), side: l.role === "user" ? "CUSTOMER" : text.startsWith(SHOP_SAID) ? "STAFF" : "BOT" });
    }
  }

  const labels = await labelsFor(rows.map((r) => r.id));
  return {
    ok: true,
    counts,
    levelCounts,
    phoneCount: Number(countRow?.phone ?? 0),
    total: counts[q.filter],
    rows: rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      status: r.status,
      handoffReason: r.handoffReason,
      customerName: r.customerName || r.stateName || r.inboundName || "Khách",
      customerPhone: r.customerPhone || r.statePhone || r.convPhone || null,
      preview: (previews.get(r.id)?.text ?? "").slice(0, 140),
      previewSide: previews.get(r.id)?.side ?? null,
      lastActivityAt: iso(r.activity) ?? new Date(0).toISOString(),
      waitingSince: r.needsReply ? iso(r.lastCustomerAt) : null,
      unread: Boolean(r.unread),
      assigneeUserId: r.assigneeUserId,
      assigneeName: r.assigneeName,
      hasOrder: Boolean(r.hasOrder),
      labels: labels.get(r.id) ?? [],
      level: parseCustomerLevel(r.level),
    })),
  };
}

/** Lịch sử mua của khách (đơn ERP cùng khách / cùng SĐT) theo `ORDER_OUTCOME` — mỗi đơn MỘT dòng (PRIMARY_ATTEMPT). */
export async function customerHistory(customerId: string | null, phone: string | null): Promise<InboxCustomerHistory | null> {
  const clean = (phone ?? "").replace(/\D/g, "");
  if (!customerId && clean.length < 9) return null;
  const db = await getDb();
  const o = schema.orders;
  const who = or(customerId ? eq(o.customerId, customerId) : undefined, clean.length >= 9 ? or(eq(o.billPhone, clean), eq(o.shipPhone, clean)) : undefined)!;
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')::int`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))::int`,
      inTransit: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('IN_TRANSIT','AWAITING_PICKUP'))::int`,
      notShipped: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'NOT_SHIPPED')::int`,
      cancelled: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'CANCELLED')::int`,
    })
    .from(o)
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(who, ne(o.stage, "DELETED")));
  const cu = schema.customers;
  const [pc] = customerId ? await db.select({ succeed: cu.succeedOrderCount, returned: cu.returnedOrderCount, block: cu.isBlock }).from(cu).where(eq(cu.id, customerId)).limit(1) : [];
  const cfg = await loadAlertConfig();
  const risk = assessCustomerRisk({ succeed: Number(pc?.succeed ?? 0), returned: Number(pc?.returned ?? 0), isBlock: Boolean(pc?.block), erpDelivered: Number(r?.delivered ?? 0), erpReturned: Number(r?.returned ?? 0) }, { riskMinReturned: cfg.riskMinReturned, riskReturnRatePct: cfg.riskReturnRatePct });
  return {
    total: Number(r?.total ?? 0),
    delivered: Number(r?.delivered ?? 0),
    returned: Number(r?.returned ?? 0),
    inTransit: Number(r?.inTransit ?? 0),
    notShipped: Number(r?.notShipped ?? 0),
    cancelled: Number(r?.cancelled ?? 0),
    pancakeSucceed: Number(pc?.succeed ?? 0),
    pancakeReturned: Number(pc?.returned ?? 0),
    blocked: Boolean(pc?.block),
    risk: risk.risky ? { severity: risk.severity, reasons: risk.reasons } : null,
  };
}

type ConvRow = typeof schema.salesChatConversations.$inferSelect;

async function loadConv(id: unknown): Promise<ConvRow | null> {
  if (typeof id !== "string" || !id || id.length > 100) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, id)).limit(1);
  return row && row.channel !== "TEST" ? row : null;
}

/** Khung gửi của kênh tại `now` — xem `SendWindow`. */
export function sendWindowOf(conv: Pick<ConvRow, "channel" | "lastCustomerAt">, now: Date): SendWindow {
  if (conv.channel === "WEB") return { kind: "OPEN", until: null, note: "Khách thấy tin khi mở lại khung chat trên website." };
  if (conv.channel === "ZALO") {
    const w = zaloWindow(conv.lastCustomerAt, now);
    if (w === "FREE") return { kind: "OPEN", until: iso(new Date(conv.lastCustomerAt!.getTime() + 48 * 3_600_000)), note: null };
    if (w === "PAID") return { kind: "PAID", note: "Quá 48 giờ từ tin cuối của khách — Zalo tính phí tin tư vấn. Gửi phải xác nhận." };
    if (w === "CLOSED") return { kind: "CLOSED", note: "Quá 7 ngày từ tin cuối của khách — Zalo không cho OA gửi tin tư vấn. Gọi điện cho khách." };
    return { kind: "UNKNOWN", note: "Chưa biết mốc tin cuối của khách — Zalo có thể từ chối." };
  }
  if (!conv.lastCustomerAt) return { kind: "UNKNOWN", note: "Chưa biết mốc tin cuối của khách." };
  const until = new Date(conv.lastCustomerAt.getTime() + MESSAGING_WINDOW_MS);
  if (now < until) return { kind: "OPEN", until: until.toISOString(), note: null };
  return { kind: "UNKNOWN", note: "Quá 24 giờ từ tin cuối của khách — Meta có thể chặn tin. Gửi hỏng thì gọi điện cho khách." };
}

const TIMELINE_MAX = 200;

/** Một hội thoại cho hộp thư: dòng thời gian gộp (khách · bot · nhân viên ERP · phía page ngoài ERP), khách, đơn, khung gửi. */
export async function loadInboxThread(user: SessionUser, conversationId: unknown, now: Date = new Date()): Promise<InboxResult<{ thread: InboxThread }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  const db = await getDb();
  const items: TimelineItem[] = [];

  /*
    Hộp thư hiện ĐÚNG thứ khách đã nhận. Chat web: lịch sử hội thoại chính là thứ khách thấy. Kênh nhắn tin (Facebook / Zalo):
    tin bot đọc từ sổ ĐÃ GỬI (`BOT_SENT`) — lịch sử của bot còn có lời chào mặc định và câu bot soạn mà KHÔNG gửi (Copilot /
    quan sát / gửi hỏng); hiện chúng là nói dối nhân viên rằng khách đã nhận.
  */
  const messaging = Boolean(conv.pageId && conv.threadId);
  if (!messaging) {
    const m = schema.salesChatMessages;
    const msgs = await db.select({ seq: m.seq, role: m.role, content: m.content, createdAt: m.createdAt }).from(m).where(eq(m.conversationId, conv.id)).orderBy(desc(m.seq)).limit(TIMELINE_MAX);
    for (const r of msgs) {
      const text = textOf(r.content as AiBlock[]);
      // Dòng «[Shop đã nhắn]» = tin nhân viên — đã có ở bảng tin nhân viên (có tên người gửi).
      if (!text || text.startsWith(SHOP_SAID)) continue;
      items.push({ key: `m:${r.seq}`, at: r.createdAt.toISOString(), side: r.role === "assistant" ? "BOT" : "CUSTOMER", text, images: [], author: null });
    }
  }
  if (messaging) {
    const t = schema.salesChatInbound;
    const rows = await db
      .select({ id: t.id, messageId: t.messageId, text: t.text, note: t.note, imageUrls: t.imageUrls, kind: t.kind, createdAt: t.createdAt })
      .from(t)
      .where(and(eq(t.pageId, conv.pageId!), eq(t.threadId, conv.threadId!)))
      .orderBy(desc(t.createdAt))
      .limit(TIMELINE_MAX);
    // Một tin bot có thể có HAI dòng BOT_SENT (dòng ghi sẵn `bot-out:` trước khi gửi + dòng mang mã kênh trả về) — giữ một.
    const botSeen: { text: string; at: number }[] = [];
    for (const r of [...rows].reverse()) {
      const side = inboundSide(r.note, r.messageId);
      // Tin nhân viên ERP có ở bảng của nó (có tên người gửi).
      if (side === "STAFF") continue;
      if (side === "BOT") {
        const norm = r.text.replace(/\s+/g, " ").trim();
        if (!norm) continue;
        const at = r.createdAt.getTime();
        if (botSeen.some((b) => b.text === norm && Math.abs(b.at - at) < 5 * 60_000)) continue;
        botSeen.push({ text: norm, at });
        items.push({ key: `i:${r.id}`, at: r.createdAt.toISOString(), side, text: r.text, images: [], author: null });
        continue;
      }
      const images = Array.isArray(r.imageUrls) ? (r.imageUrls as string[]).filter((x) => typeof x === "string") : [];
      if (!r.text.trim() && !images.length) continue;
      items.push({ key: `i:${r.id}`, at: r.createdAt.toISOString(), side, text: r.kind === "COMMENT" ? `[Bình luận] ${r.text}` : r.text, images, author: side === "PAGE" ? "Phía page (ngoài ERP)" : null });
    }
  }
  const s = schema.salesChatStaffMessages;
  const staff = await db.select().from(s).where(eq(s.conversationId, conv.id)).orderBy(desc(s.createdAt)).limit(TIMELINE_MAX);
  // Ảnh nhân viên đã gửi: đọc mã ảnh (không kéo byte) — trang mở ảnh qua tuyến có kiểm quyền.
  const withImages = staff.filter((r) => r.imageCount > 0).map((r) => r.id);
  const si = schema.salesChatStaffImages;
  const imageRows = withImages.length ? await db.select({ id: si.id, staffMessageId: si.staffMessageId }).from(si).where(inArray(si.staffMessageId, withImages)).orderBy(asc(si.position)) : [];
  const imagesOf = new Map<string, string[]>();
  for (const r of imageRows) imagesOf.set(r.staffMessageId, [...(imagesOf.get(r.staffMessageId) ?? []), `/api/ai-sales/inbox-images/${r.id}`]);
  for (const r of staff) items.push({ key: `s:${r.id}`, at: (r.sentAt ?? r.createdAt).toISOString(), side: "STAFF", text: r.text, images: imagesOf.get(r.id) ?? [], author: r.userName || "Nhân viên", status: r.status as "SENDING" | "SENT" | "FAILED", error: r.error });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));

  // Khách + đơn.
  const st = (conv.state ?? {}) as ChatState & { customer?: { name?: string; phone?: string; address?: string } };
  const cu = schema.customers;
  const [cust] = conv.customerId ? await db.select({ id: cu.id, name: cu.name, phone: cu.phone, address: cu.address, province: cu.province }).from(cu).where(eq(cu.id, conv.customerId)).limit(1) : [];
  // Chưa có hồ sơ khách: tên khách mang theo tin của kênh (Pancake / Zalo) — cùng nguồn với dòng trên danh sách.
  const channelName = !cust && conv.pageId && conv.threadId ? ((await db.select({ name: schema.salesChatInbound.customerName }).from(schema.salesChatInbound).where(and(eq(schema.salesChatInbound.pageId, conv.pageId), eq(schema.salesChatInbound.threadId, conv.threadId), sql`${schema.salesChatInbound.customerName} is not null and ${schema.salesChatInbound.customerName} <> ''`)).orderBy(desc(schema.salesChatInbound.createdAt)).limit(1))[0]?.name ?? null) : null;
  const o = schema.orders;
  const orderRows = await db
    .select({ id: o.id, stage: o.stage, total: o.totalPriceAfterDiscount, shippingFee: o.shippingFee, insertedAt: o.insertedAt, origin: o.origin, province: o.shipProvince, ward: o.shipCommune, outcome: ORDER_OUTCOME })
    .from(o)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, o.id))
    .where(and(cust ? or(eq(o.customerId, cust.id), eq(o.salesConversationId, conv.id)) : eq(o.salesConversationId, conv.id), ne(o.stage, "DELETED")))
    .orderBy(desc(o.insertedAt))
    .limit(30);
  const seen = new Set<string>();
  const orders: InboxOrder[] = [];
  for (const r of orderRows) {
    if (seen.has(r.id) || orders.length >= 10) continue;
    seen.add(r.id);
    const outcome = r.outcome ? String(r.outcome) : null;
    orders.push({ id: r.id, shortCode: manualOrderShortCode(r.id), stage: r.stage, outcome, outcomeLabel: outcome ? (INBOX_OUTCOME_LABEL[outcome] ?? outcome) : "—", total: Number(r.total ?? 0) + Number(r.shippingFee ?? 0), insertedAt: r.insertedAt.toISOString(), byBot: r.origin === "AI_AGENT" || r.origin === "AI_ORDER_SYNC", placeGap: isManualOrderId(r.id) && ["NEW", "CONFIRMED", "WAITING"].includes(r.stage) ? (!r.province ? "Chưa nhận ra tỉnh / thành" : !r.ward ? "Chưa chọn xã / phường" : null) : null });
  }

  let assigneeName: string | null = null;
  if (conv.assigneeUserId) assigneeName = (await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, conv.assigneeUserId)).limit(1))[0]?.name ?? null;
  const window = sendWindowOf(conv, now);
  const canReply = canReplyTo(user);
  // Nhân viên (người trả lời được) đang mở hội thoại ⇒ đã đọc tới đây. Người chỉ xem không làm mất dấu «chưa đọc» của đội.
  if (canReply) await db.update(schema.salesChatConversations).set({ staffSeenAt: now }).where(eq(schema.salesChatConversations.id, conv.id));
  const phoneForHistory = cust?.phone ?? st.customer?.phone ?? conv.customerPhone ?? null;
  const [labelMap, allLabels, notes, history, feedback] = await Promise.all([labelsFor([conv.id]), listLabels(), notesFor(user, conv.id), customerHistory(cust?.id ?? null, phoneForHistory).catch(() => null), feedbackFor(conv.id).catch(() => [])]);
  return {
    ok: true,
    thread: {
      id: conv.id,
      channel: conv.channel,
      channelLabel: INBOX_CHANNEL_LABEL[conv.channel as InboxChannel] ?? conv.channel,
      status: conv.status,
      handoffReason: conv.handoffReason,
      botYields: conv.status === "HANDOFF",
      control: readConversationControl(conv.state),
      customer: cust
        ? { id: cust.id, name: cust.name, phone: cust.phone, address: cust.address, province: cust.province }
        : { id: null, name: st.customer?.name || channelName || "Khách", phone: st.customer?.phone ?? null, address: st.customer?.address ?? null, province: null },
      assigneeUserId: conv.assigneeUserId,
      assigneeName,
      window,
      items: items.slice(-TIMELINE_MAX),
      orders,
      canReply: canReply && window.kind !== "CLOSED",
      canWork: canReply,
      canManage: can(user, MANAGE),
      replyBlockedReason: !canReply ? NO_REPLY : window.kind === "CLOSED" ? window.note : null,
      labels: labelMap.get(conv.id) ?? [],
      allLabels,
      notes,
      level: parseCustomerLevel(conv.customerLevel),
      history,
      feedback,
    },
  };
}

const sendZ = z
  .object({
    text: z.string().trim().max(STAFF_REPLY_MAX, `Tin tối đa ${STAFF_REPLY_MAX} ký tự.`).default(""),
    requestKey: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/, "Khoá lượt gửi không hợp lệ — tải lại trang."),
    confirmPaid: z.boolean().default(false),
  })
  .strict();

export type SendDeps = FanpageDeps;
export type StaffImageInput = { data: Uint8Array };

/** Lý do «nhân viên đang trả lời» của kênh — bot tự nhận lại sau 30 phút (fanpage / Zalo); chat web chờ người trả lại. */
function staffReasonOf(channel: string): string {
  return channel === "ZALO" ? ZALO_STAFF_REASON : channel === "WEB" ? WEB_STAFF_REASON : STAFF_REASON;
}

/**
 * Kiểm ảnh TRƯỚC khi ghi gì: loại nhận diện từ BYTE (không tin tên tệp / kiểu trình duyệt khai), trần số ảnh + dung lượng, và
 * luật của kênh (Zalo: JPG / PNG ≤ 1 MB; chat web chưa nhận ảnh từ hộp thư).
 */
export function checkStaffImages(channel: string, images: readonly StaffImageInput[]): { ok: true; images: { data: Uint8Array; contentType: StaffImageType; sha256: string }[] } | { ok: false; error: string } {
  if (!images.length) return { ok: true, images: [] };
  if (images.length > STAFF_IMAGES_MAX) return { ok: false, error: `Mỗi tin tối đa ${STAFF_IMAGES_MAX} ảnh.` };
  if (channel === "WEB") return { ok: false, error: "Chat web chưa nhận ảnh từ hộp thư — gửi chữ (hoặc link ảnh)." };
  const out: { data: Uint8Array; contentType: StaffImageType; sha256: string }[] = [];
  for (const [i, img] of images.entries()) {
    const type = sniffImageType(img.data);
    if (!type || !(STAFF_IMAGE_TYPES as readonly string[]).includes(type)) return { ok: false, error: `Ảnh ${i + 1}: chỉ nhận JPG / PNG / WEBP.` };
    if (img.data.byteLength > STAFF_IMAGE_MAX_BYTES) return { ok: false, error: `Ảnh ${i + 1} quá ${Math.round(STAFF_IMAGE_MAX_BYTES / 1024 / 1024)} MB.` };
    if (channel === "ZALO" && (type === "image/webp" || img.data.byteLength > ZALO_IMAGE_MAX_BYTES)) return { ok: false, error: `Ảnh ${i + 1}: Zalo chỉ nhận JPG / PNG tối đa 1 MB.` };
    out.push({ data: img.data, contentType: type as StaffImageType, sha256: sha256Hex(img.data) });
  }
  return { ok: true, images: out };
}

/**
 * Nhân viên gửi MỘT tin (chữ, ảnh, hoặc cả hai) cho khách từ hộp thư ERP. Không ném — lỗi trả về để form giữ nguyên tin đã soạn.
 * Gửi chữ trước, ảnh sau; chữ đã tới khách thì ghi `text_sent_at` ⇒ bấm lại một tin hỏng ở phần ảnh chỉ gửi lại ẢNH.
 */
export async function sendStaffReplyCore(user: SessionUser, conversationId: unknown, raw: unknown, deps: SendDeps = {}, rawImages: readonly StaffImageInput[] = []): Promise<InboxResult<{ messageId: string; reused: boolean }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  if (!canReplyTo(user)) return { ok: false, error: NO_REPLY };
  const parsed = sendZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const { text, requestKey, confirmPaid } = parsed.data;
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  const checked = checkStaffImages(conv.channel, rawImages);
  if (!checked.ok) return checked;
  if (!text && !checked.images.length) return { ok: false, error: "Tin trống — gõ chữ hoặc chọn ảnh." };
  const now = deps.now ?? (() => new Date());
  const window = sendWindowOf(conv, now());
  if (window.kind === "CLOSED") return { ok: false, error: window.note };
  if (window.kind === "PAID" && !confirmPaid) return { ok: false, error: `${window.note} Bấm «Gửi tin tính phí» để xác nhận.` };
  if ((conv.channel === "FANPAGE" || conv.channel === "ZALO") && !(conv.pageId && conv.threadId)) return { ok: false, error: "Hội thoại thiếu địa chỉ gửi của kênh." };

  const db = await getDb();
  const s = schema.salesChatStaffMessages;
  const si = schema.salesChatStaffImages;
  // Tên do MÁY CHỦ đọc từ `users` (luật 34) — không nhận từ trình duyệt.
  const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  const inserted = await db
    .insert(s)
    .values({ conversationId: conv.id, requestKey, userId: user.id, userName: me?.name ?? user.name ?? "", channel: conv.channel, text, imageCount: checked.images.length, status: "SENDING" })
    .onConflictDoNothing({ target: [s.conversationId, s.requestKey] })
    .returning({ id: s.id });
  let rowId = inserted[0]?.id;
  let row: { text: string; textSentAt: Date | null; imageCount: number };
  if (rowId) {
    if (checked.images.length) await db.insert(si).values(checked.images.map((img, position) => ({ staffMessageId: rowId!, conversationId: conv.id, position, contentType: img.contentType, bytes: img.data.byteLength, sha256: img.sha256, data: Buffer.from(img.data) })));
    row = { text, textSentAt: null, imageCount: checked.images.length };
  } else {
    const [prev] = await db.select().from(s).where(and(eq(s.conversationId, conv.id), eq(s.requestKey, requestKey))).limit(1);
    if (!prev) return { ok: false, error: "Không ghi được tin — thử lại." };
    if (prev.status === "SENT") return { ok: true, messageId: prev.id, reused: true };
    if (prev.status === "SENDING") return { ok: false, error: "Tin này đang được gửi — đợi vài giây." };
    // FAILED: lượt bấm lại cùng khoá = gửi lại ĐÚNG tin đã lưu (chữ + ảnh đã lưu), không phải thứ trình duyệt gửi lần này.
    const retried = await db.update(s).set({ status: "SENDING", error: null }).where(and(eq(s.id, prev.id), eq(s.status, "FAILED"))).returning({ id: s.id });
    if (!retried.length) return { ok: false, error: "Tin này đang được gửi — đợi vài giây." };
    rowId = prev.id;
    row = { text: prev.text, textSentAt: prev.textSentAt, imageCount: prev.imageCount };
  }
  const mark = { staffMessageId: rowId };

  const fail = async (error: string): Promise<InboxResult<{ messageId: string; reused: boolean }>> => {
    await db.update(s).set({ status: "FAILED", error: error.slice(0, 500) }).where(eq(s.id, mark.staffMessageId));
    return { ok: false, error };
  };
  try {
    // ── Chữ ──
    if (row.text && !row.textSentAt) {
      let sent: { ok: true } | { ok: false; error: string };
      if (conv.channel === "ZALO") sent = await sendZaloText(conv.threadId!, row.text, mark, deps);
      else if (conv.channel === "FANPAGE") sent = await sendBotText(conv.pageId!, conv.threadId!, row.text, deps, mark);
      else if (conv.channel === "WEB") {
        // Chat web không có kênh đẩy: tin vào lịch sử hội thoại, trang chat của khách tự đọc lại.
        await appendContextMessages(conv.id, [{ role: "assistant", text: row.text }]);
        sent = { ok: true };
      } else sent = { ok: false, error: `Kênh ${conv.channel} chưa gửi được từ hộp thư.` };
      if (!sent.ok) return await fail(sent.error);
      await db.update(s).set({ textSentAt: now() }).where(eq(s.id, mark.staffMessageId));
    }
    // ── Ảnh (đọc từ CSDL — đúng ảnh đã lưu cho tin này) ──
    if (row.imageCount > 0) {
      const imgs = await db.select({ data: si.data, contentType: si.contentType }).from(si).where(eq(si.staffMessageId, mark.staffMessageId)).orderBy(asc(si.position));
      const payload = imgs.map((i) => ({ data: new Uint8Array(i.data), contentType: i.contentType }));
      let sent: { ok: true } | { ok: false; error: string };
      if (conv.channel === "ZALO") sent = await sendZaloImages(conv.threadId!, payload, mark, deps);
      else if (conv.channel === "FANPAGE") sent = await sendPageImages(conv.pageId!, conv.threadId!, payload, deps, mark);
      else sent = { ok: false, error: "Kênh này chưa nhận ảnh từ hộp thư." };
      if (!sent.ok) return await fail(row.text ? `Đã gửi chữ; ẢNH chưa gửi được: ${sent.error}` : sent.error);
    }
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }
  const at = now();
  await db.update(s).set({ status: "SENT", sentAt: at, error: null }).where(eq(s.id, mark.staffMessageId));

  // Bot nhường + người cầm hội thoại. Đang CẦN NGƯỜI vì lý do khác ⇒ giữ lý do đó.
  const c = schema.salesChatConversations;
  const reason = staffReasonOf(conv.channel);
  const wasHandoff = conv.status === "HANDOFF";
  await db
    .update(c)
    .set({
      status: "HANDOFF",
      handoffReason: sql`case when ${c.status} = 'HANDOFF' and ${c.handoffReason} is not null and ${c.handoffReason} <> ${reason} then ${c.handoffReason} else ${reason} end`,
      lastStaffAt: at,
      nextFollowupAt: null,
      waitingSince: null,
      assigneeUserId: sql`coalesce(${c.assigneeUserId}, ${user.id})`,
      assignedAt: sql`coalesce(${c.assignedAt}, ${at})`,
      updatedAt: at,
    })
    .where(eq(c.id, conv.id));
  publish({ type: "chat", conversationId: conv.id });
  if (!wasHandoff) await recordConversationEvent(conv.id, { type: "human.took_over", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, reasonCode: "STAFF_REPLIED", key: `staff:${STAFF_OUT_PREFIX}${mark.staffMessageId}` });
  await recordConversationEvent(conv.id, { type: "human.replied", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, payload: { via: "ERP_INBOX", chars: row.text.length, images: row.imageCount }, key: `human-reply:${mark.staffMessageId}` });
  return { ok: true, messageId: mark.staffMessageId, reused: false };
}

/** Một ảnh nhân viên đã gửi — cho tuyến xem ảnh của hộp thư (đòi quyền xem ở tuyến). */
export async function readStaffImage(id: string): Promise<{ contentType: string; data: Buffer } | null> {
  if (!id || id.length > 100) return null;
  const db = await getDb();
  const si = schema.salesChatStaffImages;
  const [row] = await db.select({ contentType: si.contentType, data: si.data }).from(si).where(eq(si.id, id)).limit(1);
  return row ? { contentType: row.contentType, data: Buffer.from(row.data) } : null;
}

/** Nhận hội thoại về mình. Người khác đang cầm ⇒ chỉ người quản lý chatbot giao lại được (`assignConversationCore`). */
export async function claimConversationCore(user: SessionUser, conversationId: unknown): Promise<InboxResult> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  if (!canReplyTo(user)) return { ok: false, error: NO_REPLY };
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  if (conv.assigneeUserId === user.id) return { ok: true };
  const db = await getDb();
  const c = schema.salesChatConversations;
  const taken = await db
    .update(c)
    .set({ assigneeUserId: user.id, assignedAt: new Date() })
    .where(and(eq(c.id, conv.id), isNull(c.assigneeUserId)))
    .returning({ id: c.id });
  if (!taken.length) return { ok: false, error: "Hội thoại đã có người nhận — nhờ người quản lý giao lại nếu cần." };
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_INBOX_CLAIM", entity: "SALES_CONVERSATION", entityId: conv.id, before: { assignee: null }, after: { assignee: user.id }, reason: "Nhận hội thoại ở hộp thư" });
  return { ok: true };
}

/** Trả hội thoại (bỏ nhận). Chỉ người đang cầm, hoặc người quản lý chatbot. */
export async function releaseConversationCore(user: SessionUser, conversationId: unknown): Promise<InboxResult> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  if (!conv.assigneeUserId) return { ok: true };
  if (conv.assigneeUserId !== user.id && !can(user, MANAGE)) return { ok: false, error: "Chỉ người đang nhận hoặc người quản lý chatbot mới trả được hội thoại." };
  const db = await getDb();
  await db.update(schema.salesChatConversations).set({ assigneeUserId: null, assignedAt: null }).where(eq(schema.salesChatConversations.id, conv.id));
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_INBOX_RELEASE", entity: "SALES_CONVERSATION", entityId: conv.id, before: { assignee: conv.assigneeUserId }, after: { assignee: null }, reason: "Trả hội thoại ở hộp thư" });
  return { ok: true };
}

/** Người quản lý chatbot giao hội thoại cho một tài khoản đang hoạt động (luật 22: máy không tự giao người). */
export async function assignConversationCore(user: SessionUser, conversationId: unknown, assigneeUserId: unknown): Promise<InboxResult> {
  if (!can(user, MANAGE)) return { ok: false, error: "Chỉ người quản lý chatbot (ai_sales:manage) giao được hội thoại." };
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  if (typeof assigneeUserId !== "string" || !assigneeUserId) return { ok: false, error: "Chọn người nhận." };
  const db = await getDb();
  const [target] = await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, assigneeUserId)).limit(1);
  if (!target?.active) return { ok: false, error: "Tài khoản không tồn tại hoặc đã khoá." };
  await db.update(schema.salesChatConversations).set({ assigneeUserId: target.id, assignedAt: new Date() }).where(eq(schema.salesChatConversations.id, conv.id));
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_INBOX_ASSIGN", entity: "SALES_CONVERSATION", entityId: conv.id, before: { assignee: conv.assigneeUserId }, after: { assignee: target.id }, reason: "Giao hội thoại ở hộp thư" });
  return { ok: true };
}

/** Tài khoản đang hoạt động để giao hội thoại (tên + id) — chỉ cho người quản lý chatbot. */
export async function assignableUsers(user: SessionUser): Promise<{ id: string; name: string }[]> {
  if (!can(user, MANAGE)) return [];
  const db = await getDb();
  return db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.active, true)).orderBy(asc(schema.users.name)).limit(200);
}

/** Nhân viên đang / đã cầm hội thoại — cho bộ lọc «theo nhân viên» (ai xem hộp thư cũng thấy, không cần quyền quản lý). */
export async function inboxAssignees(user: SessionUser): Promise<{ id: string; name: string }[]> {
  if (!can(user, VIEW)) return [];
  const db = await getDb();
  const c = schema.salesChatConversations;
  const u = schema.users;
  return db
    .selectDistinct({ id: u.id, name: u.name })
    .from(c)
    .innerJoin(u, eq(u.id, c.assigneeUserId))
    .orderBy(asc(u.name))
    .limit(200);
}

/** Trả hội thoại lại cho AI (nhân viên xử lý xong) — cùng đường `resumeConversationToAi`, ghi `ai.resumed` mang khoá người bấm. */
export async function handBackToAiCore(user: SessionUser, conversationId: unknown): Promise<InboxResult> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  if (!canReplyTo(user) && !can(user, MANAGE)) return { ok: false, error: NO_REPLY };
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  if (conv.status !== "HANDOFF") return { ok: false, error: "Bot đang trả lời hội thoại này rồi." };
  const resumed = await resumeConversationToAi(conv.id);
  if (!resumed) return { ok: false, error: "Không trả lại được — hội thoại vừa đổi trạng thái." };
  await recordConversationEvent(conv.id, { type: "ai.resumed", actorKind: "HUMAN", actorUserId: user.id, occurredAt: new Date(), key: `resume:inbox:${conv.id}:${Date.now()}` });
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHAT_RESUME_AI", entity: "SALES_CONVERSATION", entityId: conv.id, before: { status: "HANDOFF", reason: conv.handoffReason }, after: { status: "OPEN" }, reason: "Trả lại cho AI từ hộp thư" });
  return { ok: true };
}

/**
 * AI soạn sẵn MỘT câu trả lời cho tin khách mới nhất (Copilot — hội thoại BÓNG, KHÔNG gửi). Câu được lưu ở
 * `sales_copilot_suggestions`, nên màn «Gợi ý Copilot» đo được nhân viên gửi nguyên văn / sửa / bỏ (câu thật = tin
 * `PAGE_REPLY` đầu tiên sau gợi ý — đúng dòng `staff-out:` hộp thư ghi).
 */
export async function suggestReplyCore(user: SessionUser, conversationId: unknown): Promise<InboxResult<{ suggestion: string }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  if (!canReplyTo(user)) return { ok: false, error: NO_REPLY };
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  const loaded = await loadInboxThread(user, conv.id);
  if (!loaded.ok) return loaded;
  const lastCustomer = [...loaded.thread.items].reverse().find((i) => i.side === "CUSTOMER" && i.text.trim());
  if (!lastCustomer) return { ok: false, error: "Chưa có tin khách để gợi ý trả lời." };
  const r = await draftCopilotSuggestion({ conversationId: conv.id, pageId: conv.pageId ?? `web:${conv.id}`, threadId: conv.threadId ?? conv.id, text: lastCustomer.text });
  if (!r.ok) return { ok: false, error: "AI chưa soạn được câu — thử lại sau, hoặc tự trả lời." };
  const db = await getDb();
  const [row] = await db.select({ suggestion: schema.salesCopilotSuggestions.suggestion }).from(schema.salesCopilotSuggestions).where(eq(schema.salesCopilotSuggestions.id, r.id)).limit(1);
  return row?.suggestion ? { ok: true, suggestion: row.suggestion } : { ok: false, error: "AI không trả câu nào." };
}

import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { zaloWindow } from "@/lib/integrations/zalo/oa";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { appendContextMessages, resumeConversationToAi, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { PAGE_REPLY, STAFF_OUT_PREFIX, STAFF_REASON, type FanpageDeps } from "@/lib/sales-chatbot/fanpage";
import { MESSAGING_WINDOW_MS } from "@/lib/sales-chatbot/followup-shared";
import {
  INBOX_CHANNEL_LABEL,
  INBOX_CHANNELS,
  INBOX_FILTERS,
  INBOX_OUTCOME_LABEL,
  STAFF_REPLY_MAX,
  type InboxChannel,
  type InboxFilter,
  type InboxOrder,
  type InboxRow,
  type InboxThread,
  type SendWindow,
  type TimelineItem,
  type TimelineSide,
} from "@/lib/sales-chatbot/inbox-shared";
import { sendBotText } from "@/lib/sales-chatbot/messenger";
import { draftCopilotSuggestion } from "@/lib/sales-chatbot/operating-mode";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { sendZaloText, ZALO_STAFF_REASON } from "@/lib/sales-chatbot/zalo";

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
const ACTIVITY = sql<Date>`greatest(coalesce("${sql.raw(C)}"."last_customer_at", 'epoch'::timestamptz), coalesce("${sql.raw(C)}"."last_bot_at", 'epoch'::timestamptz), coalesce("${sql.raw(C)}"."last_staff_at", 'epoch'::timestamptz), "${sql.raw(C)}"."updated_at")`;
const HAS_ORDER = sql<boolean>`("${sql.raw(C)}"."order_id" is not null or "${sql.raw(C)}"."draft_order_id" is not null or exists (select 1 from "orders" o where o.sales_conversation_id = "${sql.raw(C)}"."id"))`;
const INBOUND_NAME = sql<string | null>`(select i.customer_name from "sales_chat_inbound" i where i.page_id = "${sql.raw(C)}"."page_id" and i.thread_id = "${sql.raw(C)}"."thread_id" and i.customer_name is not null and i.customer_name <> '' order by i.created_at desc limit 1)`;

const listZ = z.object({
  filter: z.enum(INBOX_FILTERS).catch("ALL"),
  channel: z.enum(INBOX_CHANNELS).nullable().catch(null),
  q: z.string().trim().max(80).catch(""),
});

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
export async function listInbox(user: SessionUser, rawQuery: unknown): Promise<InboxResult<{ rows: InboxRow[]; counts: Record<InboxFilter, number> }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  const q = listZ.parse(rawQuery ?? {});
  const db = await getDb();
  const c = schema.salesChatConversations;
  const cu = schema.customers;
  const u = schema.users;
  const base: SQL[] = [ne(c.channel, "TEST")];
  if (q.channel) base.push(eq(c.channel, q.channel));
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    base.push(or(sql`${cu.name} ilike ${like}`, sql`${cu.phone} ilike ${like}`, sql`${c.state}->'customer'->>'name' ilike ${like}`, sql`${c.state}->'customer'->>'phone' ilike ${like}`, sql`${INBOUND_NAME} ilike ${like}`)!);
  }
  const byFilter: Record<InboxFilter, SQL | undefined> = {
    ALL: undefined,
    UNANSWERED: NEEDS_REPLY,
    NEEDS_HUMAN: eq(c.status, "HANDOFF"),
    MINE: eq(c.assigneeUserId, user.id),
    UNASSIGNED: and(isNull(c.assigneeUserId), or(eq(c.status, "HANDOFF"), NEEDS_REPLY)),
  };
  const counts = {} as Record<InboxFilter, number>;
  for (const f of INBOX_FILTERS) {
    const extra = byFilter[f];
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(c)
      .leftJoin(cu, eq(cu.id, c.customerId))
      .where(and(...base, ...(extra ? [extra] : [])));
    counts[f] = Number(r?.n ?? 0);
  }
  const where = and(...base, ...(byFilter[q.filter] ? [byFilter[q.filter]!] : []));
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
      assigneeUserId: c.assigneeUserId,
      assigneeName: u.name,
      hasOrder: HAS_ORDER,
    })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .leftJoin(u, eq(u.id, c.assigneeUserId))
    .where(where)
    // «Chờ trả lời»: khách chờ LÂU NHẤT lên đầu (đúng thứ tự phải xử lý); còn lại: mới nhất lên đầu.
    .orderBy(q.filter === "UNANSWERED" ? asc(c.lastCustomerAt) : desc(ACTIVITY))
    .limit(100);

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

  return {
    ok: true,
    counts,
    rows: rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      status: r.status,
      handoffReason: r.handoffReason,
      customerName: r.customerName || r.stateName || r.inboundName || "Khách",
      customerPhone: r.customerPhone || r.statePhone || null,
      preview: (previews.get(r.id)?.text ?? "").slice(0, 140),
      previewSide: previews.get(r.id)?.side ?? null,
      lastActivityAt: iso(r.activity) ?? new Date(0).toISOString(),
      waitingSince: r.needsReply ? iso(r.lastCustomerAt) : null,
      assigneeUserId: r.assigneeUserId,
      assigneeName: r.assigneeName,
      hasOrder: Boolean(r.hasOrder),
    })),
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

  // Bot: lịch sử của bot (bỏ dòng «[Shop đã nhắn]» — đó là bản chép tin phía page, đã có ở nguồn của nó).
  const m = schema.salesChatMessages;
  const msgs = await db.select({ seq: m.seq, role: m.role, content: m.content, createdAt: m.createdAt }).from(m).where(eq(m.conversationId, conv.id)).orderBy(desc(m.seq)).limit(TIMELINE_MAX);
  const messaging = Boolean(conv.pageId && conv.threadId);
  for (const r of msgs) {
    const text = textOf(r.content as AiBlock[]);
    if (!text || text.startsWith(SHOP_SAID)) continue;
    if (r.role === "assistant") items.push({ key: `m:${r.seq}`, at: r.createdAt.toISOString(), side: "BOT", text, images: [], author: null });
    // Chat web: tin khách chỉ có ở đây. Kênh nhắn tin: tin khách lấy ở sổ tin thô (đủ cả tin bot bỏ qua + ảnh).
    else if (!messaging) items.push({ key: `m:${r.seq}`, at: r.createdAt.toISOString(), side: "CUSTOMER", text, images: [], author: null });
  }
  if (messaging) {
    const t = schema.salesChatInbound;
    const rows = await db
      .select({ id: t.id, messageId: t.messageId, text: t.text, note: t.note, imageUrls: t.imageUrls, kind: t.kind, createdAt: t.createdAt })
      .from(t)
      .where(and(eq(t.pageId, conv.pageId!), eq(t.threadId, conv.threadId!)))
      .orderBy(desc(t.createdAt))
      .limit(TIMELINE_MAX);
    for (const r of rows) {
      const side = inboundSide(r.note, r.messageId);
      // Tin bot đã có ở lịch sử của bot (đúng chữ, không bị rút gọn khoảng trắng); tin nhân viên ERP có ở bảng của nó (có tên).
      if (side === "BOT" || side === "STAFF") continue;
      const images = Array.isArray(r.imageUrls) ? (r.imageUrls as string[]).filter((x) => typeof x === "string") : [];
      if (!r.text.trim() && !images.length) continue;
      items.push({ key: `i:${r.id}`, at: r.createdAt.toISOString(), side, text: r.kind === "COMMENT" ? `[Bình luận] ${r.text}` : r.text, images, author: side === "PAGE" ? "Phía page (ngoài ERP)" : null });
    }
  }
  const s = schema.salesChatStaffMessages;
  const staff = await db.select().from(s).where(eq(s.conversationId, conv.id)).orderBy(desc(s.createdAt)).limit(TIMELINE_MAX);
  for (const r of staff) items.push({ key: `s:${r.id}`, at: (r.sentAt ?? r.createdAt).toISOString(), side: "STAFF", text: r.text, images: [], author: r.userName || "Nhân viên", status: r.status as "SENDING" | "SENT" | "FAILED", error: r.error });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));

  // Khách + đơn.
  const st = (conv.state ?? {}) as ChatState & { customer?: { name?: string; phone?: string; address?: string } };
  const cu = schema.customers;
  const [cust] = conv.customerId ? await db.select({ id: cu.id, name: cu.name, phone: cu.phone, address: cu.address, province: cu.province }).from(cu).where(eq(cu.id, conv.customerId)).limit(1) : [];
  const o = schema.orders;
  const orderRows = await db
    .select({ id: o.id, stage: o.stage, total: o.totalPriceAfterDiscount, shippingFee: o.shippingFee, insertedAt: o.insertedAt, origin: o.origin, outcome: ORDER_OUTCOME })
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
    orders.push({ id: r.id, shortCode: manualOrderShortCode(r.id), stage: r.stage, outcome, outcomeLabel: outcome ? (INBOX_OUTCOME_LABEL[outcome] ?? outcome) : "—", total: Number(r.total ?? 0) + Number(r.shippingFee ?? 0), insertedAt: r.insertedAt.toISOString(), byBot: r.origin === "AI_AGENT" || r.origin === "AI_ORDER_SYNC" });
  }

  let assigneeName: string | null = null;
  if (conv.assigneeUserId) assigneeName = (await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, conv.assigneeUserId)).limit(1))[0]?.name ?? null;
  const window = sendWindowOf(conv, now);
  const canReply = canReplyTo(user);
  return {
    ok: true,
    thread: {
      id: conv.id,
      channel: conv.channel,
      channelLabel: INBOX_CHANNEL_LABEL[conv.channel as InboxChannel] ?? conv.channel,
      status: conv.status,
      handoffReason: conv.handoffReason,
      botYields: conv.status === "HANDOFF",
      customer: cust
        ? { id: cust.id, name: cust.name, phone: cust.phone, address: cust.address, province: cust.province }
        : { id: null, name: st.customer?.name || "Khách", phone: st.customer?.phone ?? null, address: st.customer?.address ?? null, province: null },
      assigneeUserId: conv.assigneeUserId,
      assigneeName,
      window,
      items: items.slice(-TIMELINE_MAX),
      orders,
      canReply: canReply && window.kind !== "CLOSED",
      canManage: can(user, MANAGE),
      replyBlockedReason: !canReply ? NO_REPLY : window.kind === "CLOSED" ? window.note : null,
    },
  };
}

const sendZ = z
  .object({
    text: z.string().trim().min(1, "Tin trống.").max(STAFF_REPLY_MAX, `Tin tối đa ${STAFF_REPLY_MAX} ký tự.`),
    requestKey: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/, "Khoá lượt gửi không hợp lệ — tải lại trang."),
    confirmPaid: z.boolean().default(false),
  })
  .strict();

export type SendDeps = FanpageDeps;

/** Lý do «nhân viên đang trả lời» của kênh — bot tự nhận lại sau 30 phút (fanpage / Zalo); chat web chờ người trả lại. */
function staffReasonOf(channel: string): string {
  return channel === "ZALO" ? ZALO_STAFF_REASON : channel === "WEB" ? WEB_STAFF_REASON : STAFF_REASON;
}

/** Nhân viên gửi MỘT tin cho khách từ hộp thư ERP. Không ném — lỗi trả về để form giữ nguyên chữ đã gõ. */
export async function sendStaffReplyCore(user: SessionUser, conversationId: unknown, raw: unknown, deps: SendDeps = {}): Promise<InboxResult<{ messageId: string; reused: boolean }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  if (!canReplyTo(user)) return { ok: false, error: NO_REPLY };
  const parsed = sendZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const { text, requestKey, confirmPaid } = parsed.data;
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: "Không có hội thoại này." };
  const now = deps.now ?? (() => new Date());
  const window = sendWindowOf(conv, now());
  if (window.kind === "CLOSED") return { ok: false, error: window.note };
  if (window.kind === "PAID" && !confirmPaid) return { ok: false, error: `${window.note} Bấm «Gửi tin tính phí» để xác nhận.` };
  if ((conv.channel === "FANPAGE" || conv.channel === "ZALO") && !(conv.pageId && conv.threadId)) return { ok: false, error: "Hội thoại thiếu địa chỉ gửi của kênh." };

  const db = await getDb();
  const s = schema.salesChatStaffMessages;
  // Tên do MÁY CHỦ đọc từ `users` (luật 34) — không nhận từ trình duyệt.
  const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  const inserted = await db
    .insert(s)
    .values({ conversationId: conv.id, requestKey, userId: user.id, userName: me?.name ?? user.name ?? "", channel: conv.channel, text, status: "SENDING" })
    .onConflictDoNothing({ target: [s.conversationId, s.requestKey] })
    .returning({ id: s.id });
  let rowId = inserted[0]?.id;
  if (!rowId) {
    const [prev] = await db.select().from(s).where(and(eq(s.conversationId, conv.id), eq(s.requestKey, requestKey))).limit(1);
    if (!prev) return { ok: false, error: "Không ghi được tin — thử lại." };
    if (prev.status === "SENT") return { ok: true, messageId: prev.id, reused: true };
    if (prev.status === "SENDING") return { ok: false, error: "Tin này đang được gửi — đợi vài giây." };
    // FAILED: lượt bấm lại cùng khoá = thử gửi lại đúng tin đó.
    const retried = await db.update(s).set({ status: "SENDING", error: null, text }).where(and(eq(s.id, prev.id), eq(s.status, "FAILED"))).returning({ id: s.id });
    if (!retried.length) return { ok: false, error: "Tin này đang được gửi — đợi vài giây." };
    rowId = prev.id;
  }

  let sent: { ok: true } | { ok: false; error: string };
  try {
    if (conv.channel === "ZALO") sent = await sendZaloText(conv.threadId!, text, { staffMessageId: rowId }, deps);
    else if (conv.channel === "FANPAGE") sent = await sendBotText(conv.pageId!, conv.threadId!, text, deps, { staffMessageId: rowId });
    else if (conv.channel === "WEB") {
      // Chat web không có kênh đẩy: tin vào lịch sử hội thoại, trang chat của khách tự đọc lại.
      await appendContextMessages(conv.id, [{ role: "assistant", text }]);
      sent = { ok: true };
    } else sent = { ok: false, error: `Kênh ${conv.channel} chưa gửi được từ hộp thư.` };
  } catch (error) {
    sent = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!sent.ok) {
    await db.update(s).set({ status: "FAILED", error: sent.error.slice(0, 500) }).where(eq(s.id, rowId));
    return { ok: false, error: sent.error };
  }
  const at = now();
  await db.update(s).set({ status: "SENT", sentAt: at, error: null }).where(eq(s.id, rowId));

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
  if (!wasHandoff) await recordConversationEvent(conv.id, { type: "human.took_over", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, reasonCode: "STAFF_REPLIED", key: `staff:${STAFF_OUT_PREFIX}${rowId}` });
  await recordConversationEvent(conv.id, { type: "human.replied", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, payload: { via: "ERP_INBOX", chars: text.length }, key: `human-reply:${rowId}` });
  return { ok: true, messageId: rowId, reused: false };
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

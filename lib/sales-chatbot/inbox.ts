import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { listChannelPages } from "@/lib/connectors/service";
import { loadTransportFacts, MESSENGER_DIRECT_KEY, transportOwnerOf, type TransportFacts } from "@/lib/sales-chatbot/channel-ownership";
import type { AiBlock } from "@/lib/ai/provider";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { isManualOrderId, manualOrderGaps, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { reconfirmsSinceOpen, reviewFromValue } from "@/lib/constants/order-review";
import { sha256Hex, sniffImageType } from "@/lib/creative/images";
import { zaloWindow, ZALO_IMAGE_MAX_BYTES } from "@/lib/integrations/zalo/oa";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { appendContextMessages, resumeConversationToAi, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { aiHoldOf, aiHoldView, humanResumeReason } from "@/lib/sales-chatbot/ai-hold-shared";
import { avatarProxyHref, avatarProxyRefOfState } from "@/lib/sales-chatbot/avatar-profile";
import {
  aiReplyingSql,
  classifyInboxState,
  humanHandlingSql,
  INBOX_ACTIVITY_SQL,
  inboxHandlingFrom,
  needsHumanSql,
  ORDER_UNDER_REVIEW_SQL,
  customerInboundRowSql,
  customerMessageRowSql,
  PAGE_REPLY_AFTER_CUSTOMER_SQL,
  personalUnreadCountSql,
  personalUnreadSql,
  readCursorSql,
  VIEWER_READ_ALIAS,
  WAITING_REPLY_SQL,
  WEB_STAFF_REASON,
} from "@/lib/sales-chatbot/inbox-states";
import { humanCooldownMinutes, startHumanCooldown } from "@/lib/sales-chatbot/conversation-control";
import { buildMessageTrace, conversationAiBlocks, loadAiUsageForConversation, transportOfConversation } from "@/lib/sales-chatbot/ai-status";
import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { labelsFor, listLabels, notesFor } from "@/lib/sales-chatbot/inbox-labels";
import { PAGE_REPLY, STAFF_OUT_PREFIX, STAFF_REASON, type FanpageDeps } from "@/lib/sales-chatbot/fanpage";
import { MESSAGING_WINDOW_MS } from "@/lib/sales-chatbot/followup-shared";
import {
  INBOX_CHANNEL_LABEL,
  INBOX_CHANNELS,
  INBOX_FILTERS,
  INBOX_HANDLERS,
  INBOX_LIST_MAX,
  INBOX_OUTCOME_LABEL,
  INBOX_PERIODS,
  safeAvatarUrl,
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
  type InboxSource,
  type InboxThread,
  type SendWindow,
  type TimelineItem,
  type TimelineSide,
} from "@/lib/sales-chatbot/inbox-shared";

type StaffImageType = (typeof STAFF_IMAGE_TYPES)[number];
import { sendBotText, sendPageImages } from "@/lib/sales-chatbot/messenger";
import { draftCopilotSuggestion, loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
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
const NO_CONVERSATION = "Không có hội thoại này.";

/**
 * Trả lời khách = GỬI TIN cho khách. Khoá riêng `ai_sales:reply` (module AI bán hàng — tổ chức chỉ mua AI bán hàng vẫn có);
 * `outreach:send` («Chăm sóc & bán chéo: gửi tin») cũng đủ — vai trò đã lưu quyền ở tổ chức nhà không mất việc trả lời.
 */
export function canReplyTo(user: SessionUser): boolean {
  return can(user, "ai_sales:reply") || can(user, "outreach:send");
}
export { WEB_STAFF_REASON };

export type InboxResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const C = "sales_chat_conversations";
const HAS_ORDER = sql<boolean>`("${sql.raw(C)}"."order_id" is not null or "${sql.raw(C)}"."draft_order_id" is not null or exists (select 1 from "orders" o where o.sales_conversation_id = "${sql.raw(C)}"."id"))`;
const INBOUND_NAME = sql<string | null>`(select i.customer_name from "sales_chat_inbound" i where i.page_id = "${sql.raw(C)}"."page_id" and i.thread_id = "${sql.raw(C)}"."thread_id" and i.customer_name is not null and i.customer_name <> '' order by i.created_at desc limit 1)`;
/** Đã chốt: đơn ERP thật của hội thoại (không tính đơn nháp) hoặc level khách «Đã chốt đơn» (job level). */
const CLOSED = sql<boolean>`("${sql.raw(C)}"."order_id" is not null or coalesce("${sql.raw(C)}"."customer_level", '') = 'ORDERED' or exists (select 1 from "orders" o where o.sales_conversation_id = "${sql.raw(C)}"."id"))`;
/** Đường đã ghi tin khách gần nhất của luồng (0233) — `NULL` ở dòng cũ ⇒ đường canonical hiện tại của page. */
const THREAD_TRANSPORT = sql<string | null>`(select i.transport from "sales_chat_inbound" i where i.page_id = "${sql.raw(C)}"."page_id" and i.thread_id = "${sql.raw(C)}"."thread_id" and i.transport is not null order by i.created_at desc limit 1)`;

/** Nhãn nguồn của hàng: Zalo · Web · Direct (Meta trực tiếp) · Pancake. HÀM THUẦN. */
export function inboxSourceOf(r: { channel: string; pageId: string | null; transport: string | null }, facts: TransportFacts | null): InboxSource {
  if (r.channel === "ZALO") return "ZALO";
  if (r.channel !== "FANPAGE") return "WEB";
  if (r.transport === "MESSENGER") return "DIRECT";
  if (r.transport === "PANCAKE") return "PANCAKE";
  return r.pageId && facts && transportOwnerOf(facts, r.pageId) === "MESSENGER" ? "DIRECT" : "PANCAKE";
}

/** Có SĐT: SĐT hội thoại (job level đọc từ tin khách / Pancake) · hồ sơ khách · sổ trạng thái bot. */
const HAS_PHONE = sql<boolean>`(coalesce("${sql.raw(C)}"."customer_phone", '') <> '' or coalesce("customers"."phone", '') <> '' or coalesce("${sql.raw(C)}"."state"->'customer'->>'phone', '') <> '')`;

const dayZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null);
const listZ = z.object({
  filter: z.enum(INBOX_FILTERS).catch("ALL"),
  label: z.string().trim().min(1).max(100).nullable().catch(null),
  channel: z.enum(INBOX_CHANNELS).nullable().catch(null),
  q: z.string().trim().max(80).catch(""),
  /** MỘT page / tài khoản kênh (`sales_chat_conversations.page_id`); `null` = mọi page (hộp thư chung). */
  page: z.string().trim().regex(/^[A-Za-z0-9_:.-]{1,80}$/).nullable().catch(null),
  phone: z.enum(["HAS", "NONE"]).nullable().catch(null),
  level: z.enum(CUSTOMER_LEVELS).nullable().catch(null),
  /** Người phụ trách: mã tài khoản, hoặc «none» = chưa ai cầm. */
  assignee: z.string().trim().min(1).max(100).nullable().catch(null),
  period: z.enum(INBOX_PERIODS).nullable().catch(null),
  from: dayZ,
  to: dayZ,
  limit: z.number().int().min(50).max(INBOX_LIST_MAX).catch(100),
  handler: z.enum(INBOX_HANDLERS).nullable().catch(null),
});

export type InboxPageOption = { id: string; name: string };

/**
 * Các page / tài khoản kênh của hộp thư — để LỌC và để in tên page trên từng hội thoại. Tên đọc từ page đã nối thẳng
 * (`org_channel_pages`); page Pancake / Zalo / page cũ chưa có tên ⇒ nhãn theo kênh kèm mã. Chỉ page có hội thoại hoặc đang nối.
 */
export async function inboxPages(): Promise<InboxPageOption[]> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const used = await db.selectDistinct({ pageId: c.pageId, channel: c.channel }).from(c).where(and(ne(c.channel, "TEST"), isNotNull(c.pageId)));
  const named = new Map((await listChannelPages(MESSENGER_DIRECT_KEY)).map((p) => [p.pageId, p.kind === "INSTAGRAM" ? p.name : p.name || p.pageId]));
  const out = new Map<string, string>();
  for (const [id, name] of named) out.set(id, name);
  for (const r of used) {
    if (!r.pageId || out.has(r.pageId)) continue;
    out.set(r.pageId, r.channel === "ZALO" ? "Zalo OA" : r.pageId.startsWith("comment:") ? `Bình luận ${r.pageId.slice(8, 20)}` : `Fanpage ${r.pageId}`);
  }
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

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

/**
 * Ảnh đại diện khách: Meta `profile_pic` (đọc sau lượt trả lời — messenger.ts) rồi ảnh Pancake không khoá (lượt nhập lịch sử), rồi
 * ảnh Pancake MANG KHOÁ đi qua proxy của ERP (`state.pancakeAvatarRef` ⇒ đường dẫn TƯƠNG ĐỐI `/api/ai-sales/avatar/<mã>` — máy chủ gắn
 * token lúc tải, avatar-profile.ts mục 1b). Không có gì ⇒ `null` ⇒ chữ cái.
 */
function avatarOf(state: unknown, conversationId: string): string | null {
  const st = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  const meta = st.messengerProfile && typeof st.messengerProfile === "object" ? (st.messengerProfile as Record<string, unknown>).pic : null;
  const ref = avatarProxyRefOfState(st);
  return safeAvatarUrl(meta) ?? safeAvatarUrl(st.pancakeAvatarUrl) ?? (ref ? avatarProxyHref(conversationId, ref) : null);
}

/** Phía của một dòng sổ tin thô (khách · bot · nhân viên ERP · phía page ngoài ERP). HÀM THUẦN — hộp thư và ops audit dùng chung. */
export function inboundSide(note: string | null, messageId: string): TimelineSide {
  if (note === "BOT_SENT") return "BOT";
  if (note === PAGE_REPLY) return messageId.startsWith(STAFF_OUT_PREFIX) ? "STAFF" : "PAGE";
  return "CUSTOMER";
}

/** Phía của một dòng lịch sử chat web (`sales_chat_messages`): vai `user` = khách; câu `[Shop đã nhắn]` = nhân viên; còn lại = bot. HÀM THUẦN. */
export function webSideOf(role: string, text: string): TimelineSide {
  return role === "user" ? "CUSTOMER" : text.startsWith(SHOP_SAID) ? "STAFF" : "BOT";
}

/**
 * THỨ TỰ DANH SÁCH (INBOX-V2-A 09/10 · chủ shop 10/10/2026 mục C) — xếp ở MÁY CHỦ, không xếp lại trên trình duyệt, nên «Xem thêm»
 * (nâng `limit`) luôn ra ĐÚNG phần nối tiếp của trang trước:
 *  · «Chờ trả lời»: khách chờ LÂU NHẤT lên đầu (đúng thứ tự phải xử lý).
 *  · Mọi thẻ khác: NGƯỜI XEM CHƯA ĐỌC trước (`personalUnreadSql` — AI trả lời không làm hội thoại thành «đã đọc»), rồi đã đọc; trong
 *    mỗi nhóm TIN CÓ NGHĨA mới nhất lên đầu (`INBOX_ACTIVITY_SQL` — không cột siêu dữ liệu nào: nhãn / người phụ trách / hồ sơ khách
 *    không đổi chỗ hội thoại).
 * Khoá cuối là `id` để hai hội thoại cùng mốc không đổi chỗ giữa hai lượt tải (phân trang ổn định). Hội thoại ĐANG MỞ thành «đã
 * đọc» không nhảy chỗ khi đang đọc: trình duyệt giữ nó tại chỗ (`keepActiveInPlace`), chuyển hội thoại khác thì nó về vị trí này.
 */
export function inboxOrderBy(filter: InboxFilter, unread: SQL<boolean>): SQL[] {
  if (filter === "UNANSWERED") return [asc(schema.salesChatConversations.lastCustomerAt), asc(schema.salesChatConversations.id)];
  return [sql`${unread} desc`, desc(INBOX_ACTIVITY_SQL), desc(schema.salesChatConversations.id)];
}

/** Danh sách hội thoại của hộp thư (tối đa 100) — lọc theo việc cần làm, kênh, tên / SĐT. Không kéo nội dung tin (chỉ một dòng xem trước). */
export async function listInbox(
  user: SessionUser,
  rawQuery: unknown,
  now: Date = new Date(),
): Promise<InboxResult<{ rows: InboxRow[]; counts: Record<InboxFilter, number>; levelCounts: Partial<Record<CustomerLevel, number>>; phoneCount: number; total: number; unreadStamp: string | null }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  const q = listZ.parse(rawQuery ?? {});
  const db = await getDb();
  const c = schema.salesChatConversations;
  const cu = schema.customers;
  const u = schema.users;
  const base: SQL[] = [ne(c.channel, "TEST")];
  if (q.channel) base.push(eq(c.channel, q.channel));
  if (q.page) base.push(eq(c.pageId, q.page));
  if (q.label) base.push(sql`exists (select 1 from "sales_chat_conversation_labels" cl where cl.conversation_id = "${sql.raw(C)}"."id" and cl.label_id = ${q.label})`);
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    base.push(or(sql`${cu.name} ilike ${like}`, sql`${cu.phone} ilike ${like}`, sql`${c.customerPhone} ilike ${like}`, sql`${c.state}->'customer'->>'name' ilike ${like}`, sql`${c.state}->'customer'->>'phone' ilike ${like}`, sql`${INBOUND_NAME} ilike ${like}`)!);
  }
  if (q.phone === "HAS") base.push(HAS_PHONE);
  if (q.phone === "NONE") base.push(sql`not ${HAS_PHONE}`);
  // Ai đang trả lời (INBOX_HANDLERS) — CÙNG điều kiện với huy hiệu trên hàng (`classifyInboxState`, inbox-states.ts — một nguồn).
  const orgCopilot = (await loadModeConfig().catch(() => null))?.mode === "COPILOT";
  const byHuman = humanHandlingSql(now, orgCopilot);
  const byAi = aiReplyingSql(now, orgCopilot);
  const needsHuman = needsHumanSql(now);
  if (q.handler === "HUMAN") base.push(byHuman);
  if (q.handler === "AI") base.push(byAi);
  if (q.assignee === "none") base.push(isNull(c.assigneeUserId));
  else if (q.assignee) base.push(eq(c.assigneeUserId, q.assignee));
  const range = inboxPeriodRange(q, now);
  if (range?.from) base.push(sql`${INBOX_ACTIVITY_SQL} >= ${range.from}`);
  if (range?.to) base.push(sql`${INBOX_ACTIVITY_SQL} < ${range.to}`);
  // Bộ lọc level đứng RIÊNG: số đếm theo level tính trên các bộ lọc khác (chip level không tự triệt tiêu nhau).
  const levelCond = q.level ? eq(c.customerLevel, q.level) : undefined;
  // «Tin khách chưa đọc» là của NGƯỜI XEM (con trỏ đọc riêng — inbox-states.ts); mọi thẻ khác là trạng thái chung của cửa hàng.
  // Con trỏ của người xem nối MỘT lần (LEFT JOIN theo khoá chính) cho cả ba câu — không phải một câu con mỗi lần nhắc tới.
  const scr = alias(schema.salesChatReads, VIEWER_READ_ALIAS);
  const viewerRead = and(eq(scr.conversationId, c.id), eq(scr.userId, user.id));
  const personalUnread = personalUnreadSql(user.id, true);
  const byFilter: Record<InboxFilter, SQL | undefined> = {
    ALL: undefined,
    UNREAD: personalUnread,
    UNANSWERED: WAITING_REPLY_SQL,
    NEEDS_HUMAN: needsHuman,
    MINE: eq(c.assigneeUserId, user.id),
    // Chưa ai nhận MÀ có việc của người: cần người thật hoặc khách đang chờ trả lời.
    UNASSIGNED: and(isNull(c.assigneeUserId), or(needsHuman, WAITING_REPLY_SQL)),
    AI: byAi,
    HUMAN: byHuman,
    ORDERED: CLOSED,
    NOT_ORDERED: sql`not ${CLOSED}`,
  };
  // MỘT câu đếm cho mọi thẻ (trước đây sáu câu cho mỗi lượt làm mới 5 giây).
  const countCols = Object.fromEntries(INBOX_FILTERS.map((f) => [f, byFilter[f] ? sql<number>`count(*) filter (where ${byFilter[f]})::int` : sql<number>`count(*)::int`])) as Record<InboxFilter, SQL<number>>;
  // `unreadStamp`: dấu con trỏ đọc MỚI NHẤT của người xem, đọc trong CÙNG câu (cùng ảnh chụp) với số «chưa đọc» — trình duyệt so nó
  // với xác nhận đọc để biết bản đếm này đã thấy lượt đọc vừa rồi chưa (inbox-read-shared.ts::patchUnreadCount).
  const [countRow] = await db
    .select({ ...countCols, phone: sql<number>`count(*) filter (where ${HAS_PHONE})::int`, unreadStamp: sql<string | null>`(select max(r.updated_at) from "sales_chat_reads" r where r.user_id = ${user.id})` })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .leftJoin(scr, viewerRead)
    .where(and(...base, ...(levelCond ? [levelCond] : [])));
  const counts = Object.fromEntries(INBOX_FILTERS.map((f) => [f, Number((countRow as Record<string, unknown> | undefined)?.[f] ?? 0)])) as Record<InboxFilter, number>;
  const levelRows = await db
    .select({ level: c.customerLevel, n: sql<number>`count(*)::int` })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .leftJoin(scr, viewerRead)
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
      customerId: c.customerId,
      stateName: sql<string | null>`${c.state}->'customer'->>'name'`,
      statePhone: sql<string | null>`${c.state}->'customer'->>'phone'`,
      inboundName: INBOUND_NAME,
      lastCustomerAt: c.lastCustomerAt,
      lastBotAt: c.lastBotAt,
      lastStaffAt: c.lastStaffAt,
      staffSeenAt: c.staffSeenAt,
      historyUntil: c.historyUntil,
      pageReplyAfterCustomer: PAGE_REPLY_AFTER_CUSTOMER_SQL,
      orderUnderReview: ORDER_UNDER_REVIEW_SQL,
      activity: INBOX_ACTIVITY_SQL,
      // Cờ chờ trả lời: ĐÚNG biểu thức của bộ lọc. «Chưa đọc» = SỐ tin khách sau con trỏ của người xem ≥ 1 (cùng điều kiện với bộ lọc
      // và khoá xếp — một hàng không bao giờ đứng sai nhóm, và không bao giờ «chưa đọc» mà số 0).
      needsReply: WAITING_REPLY_SQL,
      readCursor: readCursorSql(user.id, true),
      assigneeUserId: c.assigneeUserId,
      assigneeName: u.name,
      hasOrder: HAS_ORDER,
      level: c.customerLevel,
      convPhone: c.customerPhone,
      state: c.state,
      updatedAt: c.updatedAt,
      humanCooldownUntil: c.humanCooldownUntil,
      unreadN: personalUnreadCountSql(user.id, true),
      closed: CLOSED,
      transport: THREAD_TRANSPORT,
    })
    .from(c)
    .leftJoin(cu, eq(cu.id, c.customerId))
    .leftJoin(u, eq(u.id, c.assigneeUserId))
    .leftJoin(scr, viewerRead)
    .where(where)
    .orderBy(...inboxOrderBy(q.filter, personalUnread))
    .limit(q.limit);

  /*
    DÒNG XEM TRƯỚC (chủ shop 10/10/2026 tối, P0.2): hai tin mỗi hội thoại — tin MỚI NHẤT (mọi phía) và tin KHÁCH thật mới nhất. Hội
    thoại người xem chưa đọc ⇒ xem trước TIN KHÁCH (đó chính là tin chưa đọc mới nhất: chưa đọc ⇔ có tin khách sau con trỏ), kèm dòng
    phụ «AI đã trả lời …» nếu sau nó đã có câu trả lời; đã đọc ⇒ tin mới nhất như cũ. Trước đây luôn là tin mới nhất ⇒ «AI: Dạ giá
    280k… [1]» — huy hiệu của tin khách đứng cạnh chữ của AI. Hai câu DISTINCT ON trên ≤ 500 luồng của trang, chỉ mục (luồng, mốc) 0239.
  */
  type Pv = { text: string; side: TimelineSide; at: Date };
  const latest = new Map<string, Pv>();
  const newestCustomer = new Map<string, Pv>();
  const inboundText = (l: { text: string; imageUrls: unknown; kind?: string | null }) => {
    const body = l.text.trim() || (Array.isArray(l.imageUrls) && l.imageUrls.length ? "[Ảnh]" : "[Tin không có chữ]");
    return l.kind === "COMMENT" ? `[Bình luận] ${body}` : body;
  };
  const messaging = rows.filter((r) => r.pageId && r.threadId);
  if (messaging.length) {
    const t = schema.salesChatInbound;
    const pairs = messaging.map((r) => and(eq(t.pageId, r.pageId!), eq(t.threadId, r.threadId!))!);
    const cols = { pageId: t.pageId, threadId: t.threadId, text: t.text, note: t.note, messageId: t.messageId, imageUrls: t.imageUrls, kind: t.kind, createdAt: t.createdAt };
    const last = await db.selectDistinctOn([t.pageId, t.threadId], cols).from(t).where(and(or(...pairs), eq(t.kind, "INBOX"))).orderBy(t.pageId, t.threadId, desc(t.createdAt));
    const cust = await db.selectDistinctOn([t.pageId, t.threadId], cols).from(t).where(and(or(...pairs), customerInboundRowSql(`"sales_chat_inbound"`))).orderBy(t.pageId, t.threadId, desc(t.createdAt));
    const key = (pageId: string, threadId: string) => `${pageId}\u0000${threadId}`;
    const byKey = new Map(last.map((l) => [key(l.pageId, l.threadId), l]));
    const custByKey = new Map(cust.map((l) => [key(l.pageId, l.threadId), l]));
    for (const r of messaging) {
      const l = byKey.get(key(r.pageId!, r.threadId!));
      if (l) latest.set(r.id, { text: inboundText({ ...l, kind: null }), side: inboundSide(l.note, l.messageId), at: l.createdAt });
      const k = custByKey.get(key(r.pageId!, r.threadId!));
      if (k) newestCustomer.set(r.id, { text: inboundText(k), side: "CUSTOMER", at: k.createdAt });
    }
  }
  const web = rows.filter((r) => !(r.pageId && r.threadId));
  if (web.length) {
    const m = schema.salesChatMessages;
    const cols = { conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt };
    const last = await db.selectDistinctOn([m.conversationId], cols).from(m).where(inArray(m.conversationId, web.map((r) => r.id))).orderBy(m.conversationId, desc(m.seq));
    for (const l of last) {
      const text = textOf(l.content as AiBlock[]);
      latest.set(l.conversationId, { text: text.replace(SHOP_SAID, "").trim(), side: webSideOf(l.role, text), at: l.createdAt });
    }
    const cust = await db.selectDistinctOn([m.conversationId], cols).from(m).where(and(inArray(m.conversationId, web.map((r) => r.id)), customerMessageRowSql(`"sales_chat_messages"`))).orderBy(m.conversationId, desc(m.seq));
    for (const l of cust) newestCustomer.set(l.conversationId, { text: textOf(l.content as AiBlock[]), side: "CUSTOMER", at: l.createdAt });
  }

  const labels = await labelsFor(rows.map((r) => r.id));
  const pageNames = new Map((await inboxPages()).map((p) => [p.id, p.name]));
  const facts = rows.some((r) => r.channel === "FANPAGE" && !r.transport) ? await loadTransportFacts().catch(() => null) : null;
  return {
    ok: true,
    counts,
    levelCounts,
    phoneCount: Number(countRow?.phone ?? 0),
    total: counts[q.filter],
    unreadStamp: iso((countRow as { unreadStamp?: Date | string | null } | undefined)?.unreadStamp ?? null),
    rows: rows.map((r) => {
      const hold = aiHoldOf({ status: r.status, handoffReason: r.handoffReason, state: r.state, updatedAt: r.updatedAt, humanCooldownUntil: r.humanCooldownUntil }, now).state;
      // Huy hiệu AI / người + lý do cần người: hàm THUẦN cùng tệp với điều kiện lọc (inbox-states.ts).
      const unreadN = Math.max(0, Number(r.unreadN ?? 0));
      const st = classifyInboxState({ ...r, pageReplyAfterCustomer: Boolean(r.pageReplyAfterCustomer), orderUnderReview: Boolean(r.orderUnderReview), customerUnread: unreadN }, now, orgCopilot);
      const lt = latest.get(r.id) ?? null;
      const nc = newestCustomer.get(r.id) ?? null;
      // Chưa đọc ⇒ xem trước tin KHÁCH chưa đọc mới nhất; câu trả lời sau nó (AI · nhân viên · page) thành dòng phụ.
      const pv = st.humanUnread && nc ? nc : lt;
      const after = st.humanUnread && nc && lt && lt.side !== "CUSTOMER" && lt.at > nc.at ? { side: lt.side as Exclude<TimelineSide, "CUSTOMER">, at: lt.at.toISOString() } : null;
      return {
        id: r.id,
        channel: r.channel,
        pageId: r.pageId,
        pageName: r.pageId ? (pageNames.get(r.pageId) ?? null) : null,
        status: r.status,
        handoffReason: r.handoffReason,
        customerName: r.customerName || r.stateName || r.inboundName || "Khách",
        customerPhone: r.customerPhone || r.statePhone || r.convPhone || null,
        customerId: r.customerId ?? null,
        preview: (pv?.text ?? "").slice(0, 140),
        previewSide: pv?.side ?? null,
        previewAt: iso(pv?.at),
        afterPreview: after,
        latestPreview: (lt?.text ?? "").slice(0, 140),
        latestSide: lt?.side ?? null,
        latestAt: iso(lt?.at),
        newestCustomerAt: iso(nc?.at),
        readCursorAt: iso(r.readCursor),
        lastActivityAt: iso(r.activity) ?? new Date(0).toISOString(),
        waitingSince: r.needsReply ? iso(r.lastCustomerAt) : null,
        // Bất biến: chưa đọc ⇔ số tin khách sau con trỏ ≥ 1 — KHÔNG còn `max(1, …)` (nó in «1» cho hội thoại không có tin khách nào).
        unread: st.humanUnread,
        unreadCount: unreadN,
        avatarUrl: avatarOf(r.state, r.id),
        aiHold: hold,
        handling: inboxHandlingFrom(st),
        needsHuman: st.needsHuman,
        humanHandling: st.humanHandling,
        closed: Boolean(r.closed),
        source: inboxSourceOf(r, facts),
        assigneeUserId: r.assigneeUserId,
        assigneeName: r.assigneeName,
        hasOrder: Boolean(r.hasOrder),
        labels: labels.get(r.id) ?? [],
        level: parseCustomerLevel(r.level),
      };
    }),
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

/**
 * CỔNG TRẢ LỜI KHÁCH — MỘT chỗ cho mọi lối nhân viên đưa chữ tới khách: «Gửi» (`sendStaffReplyCore`) và công cụ ô soạn
 * (`inbox-composer.ts` — câu mẫu · dòng sản phẩm). Xem hộp thư → được trả lời khách → hội thoại có thật trong CSDL của tổ chức
 * PHIÊN (không phải khung thử, mã ≤ 100 ký tự). Siết hay nới luật ở ĐÂY là siết / nới cho cả hai lối: review PR #661 bắt được
 * bản chép của vị từ này trong ô soạn — sửa bản gốc thì bản chép không đổi theo, và bài kiểm vẫn xanh.
 */
export async function replyGate(user: SessionUser, conversationId: unknown): Promise<InboxResult<{ conv: ConvRow }>> {
  if (!can(user, VIEW)) return { ok: false, error: NO_VIEW };
  if (!canReplyTo(user)) return { ok: false, error: NO_REPLY };
  const conv = await loadConv(conversationId);
  if (!conv) return { ok: false, error: NO_CONVERSATION };
  return { ok: true, conv };
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
  // Tin KHÁCH thật cuối cùng trong khung chat này — mốc trình duyệt đánh dấu đọc tới (inbox-read.ts), KHÔNG phải giờ mở.
  let readThrough: { id: string; at: Date } | null = null;

  /*
    Hộp thư hiện ĐÚNG thứ khách đã nhận. Chat web: lịch sử hội thoại chính là thứ khách thấy. Kênh nhắn tin (Facebook / Zalo):
    tin bot đọc từ sổ ĐÃ GỬI (`BOT_SENT`) — lịch sử của bot còn có lời chào mặc định và câu bot soạn mà KHÔNG gửi (Copilot /
    quan sát / gửi hỏng); hiện chúng là nói dối nhân viên rằng khách đã nhận.
  */
  const messaging = Boolean(conv.pageId && conv.threadId);
  if (!messaging) {
    const m = schema.salesChatMessages;
    const msgs = await db.select({ id: m.id, seq: m.seq, role: m.role, content: m.content, createdAt: m.createdAt }).from(m).where(eq(m.conversationId, conv.id)).orderBy(desc(m.seq)).limit(TIMELINE_MAX);
    // `customerMessageRowSql`: vai `user` CÓ khối chữ (dòng kết quả công cụ cũng mang vai `user`).
    const firstCustomer = msgs.find((r) => r.role === "user" && (r.content as AiBlock[] | null)?.some((b) => b.type === "text"));
    if (firstCustomer) readThrough = { id: firstCustomer.id, at: firstCustomer.createdAt };
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
      .select({ id: t.id, messageId: t.messageId, text: t.text, note: t.note, imageUrls: t.imageUrls, kind: t.kind, createdAt: t.createdAt, status: t.status, attempts: t.attempts, lastError: t.lastError, claimId: t.claimId, claimedAt: t.claimedAt, processedAt: t.processedAt, nextAttemptAt: t.nextAttemptAt, importedAt: t.importedAt })
      .from(t)
      .where(and(eq(t.pageId, conv.pageId!), eq(t.threadId, conv.threadId!)))
      .orderBy(desc(t.createdAt))
      .limit(TIMELINE_MAX);
    // `customerInboundRowSql`: phía khách (`inboundSide`) và không phải tin nhập lịch sử. `rows` xếp mới nhất trước.
    const lastCustomer = rows.find((r) => !r.importedAt && inboundSide(r.note, r.messageId) === "CUSTOMER");
    if (lastCustomer) readThrough = { id: lastCustomer.id, at: lastCustomer.createdAt };
    // DẤU VẾT TỪNG TIN KHÁCH (ai-status.ts): dữ liệu ĐÃ CÓ — dòng tin, sổ AI của hội thoại, mốc các dòng BOT_SENT của thread.
    // Sổ AI chỉ đọc từ tin CŨ NHẤT đang hiện (trừ 1 phút) — không quét cả đời hội thoại mỗi lượt làm mới.
    const oldest = rows.length ? rows[rows.length - 1].createdAt : now;
    const traceEv = { transport: await transportOfConversation(conv), aiUsage: await loadAiUsageForConversation(conv.id, new Date(oldest.getTime() - 60_000)), botSentAt: rows.filter((r) => r.note === "BOT_SENT").map((r) => r.createdAt) };
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
      items.push({ key: `i:${r.id}`, at: r.createdAt.toISOString(), side, text: r.kind === "COMMENT" ? `[Bình luận] ${r.text}` : r.text, images, author: side === "PAGE" ? "Phía page (ngoài ERP)" : null, ...(side === "CUSTOMER" && !r.importedAt ? { trace: buildMessageTrace(r, traceEv, now) } : {}) });
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
    .select({ id: o.id, stage: o.stage, total: o.totalPriceAfterDiscount, shippingFee: o.shippingFee, insertedAt: o.insertedAt, origin: o.origin, province: o.shipProvince, ward: o.shipCommune, outcome: ORDER_OUTCOME, review: sql<unknown>`${o.raw}->'review'`, reviewLog: sql<unknown>`${o.raw}->'reviewLog'`, phone: o.shipPhone, address: o.shipAddress, lineCount: o.itemsCount })
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
    orders.push({ id: r.id, shortCode: manualOrderShortCode(r.id), stage: r.stage, outcome, outcomeLabel: outcome ? (INBOX_OUTCOME_LABEL[outcome] ?? outcome) : "—", total: Number(r.total ?? 0) + Number(r.shippingFee ?? 0), insertedAt: r.insertedAt.toISOString(), byBot: r.origin === "AI_AGENT" || r.origin === "AI_ORDER_SYNC", placeGap: isManualOrderId(r.id) && ["NEW", "CONFIRMED", "WAITING"].includes(r.stage) ? (!r.province ? "Chưa nhận ra tỉnh / thành" : !r.ward ? "Chưa chọn xã / phường" : null) : null, review: isManualOrderId(r.id) ? (reviewFromValue(r.review)?.entries ?? []) : [], reconfirms: isManualOrderId(r.id) ? reconfirmsSinceOpen({ review: r.review, reviewLog: r.reviewLog }) : [], gaps: isManualOrderId(r.id) ? manualOrderGaps({ phone: r.phone, address: r.address, province: r.province, ward: r.ward }, r.lineCount) : [] });
  }

  let assigneeName: string | null = null;
  if (conv.assigneeUserId) assigneeName = (await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, conv.assigneeUserId)).limit(1))[0]?.name ?? null;
  const window = sendWindowOf(conv, now);
  const canReply = canReplyTo(user);
  // KHÔNG đánh dấu đọc ở đây (trước 10/10/2026 tối: `staff_seen_at = now` — tin khách tới giữa câu đọc trên và câu ghi này bị coi là đã
  // đọc). Nạp khung chat chỉ ĐỌC; trình duyệt hiện xong mới gửi `readThrough` về `markInboxReadCore` (inbox-read.ts).
  const phoneForHistory = cust?.phone ?? st.customer?.phone ?? conv.customerPhone ?? null;
  const [labelMap, allLabels, notes, history, feedback] = await Promise.all([labelsFor([conv.id]), listLabels(), notesFor(user, conv.id), customerHistory(cust?.id ?? null, phoneForHistory).catch(() => null), feedbackFor(conv.id).catch(() => [])]);
  return {
    ok: true,
    thread: {
      id: conv.id,
      channel: conv.channel,
      // Hội thoại LUÔN mang page nó tới từ đó — shop nhiều page phải thấy ngay đang trả lời ở page nào.
      channelLabel: [INBOX_CHANNEL_LABEL[conv.channel as InboxChannel] ?? conv.channel, conv.pageId ? (await inboxPages()).find((p) => p.id === conv.pageId)?.name : null].filter(Boolean).join(" · "),
      status: conv.status,
      handoffReason: conv.handoffReason,
      botYields: conv.status === "HANDOFF",
      aiHold: aiHoldView(conv, now),
      avatarUrl: avatarOf(conv.state, conv.id),
      cooldownMinutes: await humanCooldownMinutes(),
      // Lý do AI KHÔNG trả lời — hỏi đúng các cổng của đường xử lý (ai-status.ts). Không rỗng ⇒ màn hình không được nói «AI đang trả lời».
      aiBlocks: await conversationAiBlocks(conv),
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
      readThrough: readThrough ? { id: readThrough.id, at: readThrough.at.toISOString() } : null,
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
  const gate = await replyGate(user, conversationId);
  if (!gate.ok) return gate;
  const conv = gate.conv;
  const parsed = sendZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const { text, requestKey, confirmPaid } = parsed.data;
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

  // Bot nhường 30 phút (mốc hết hạn tường minh) + người cầm hội thoại. Đang CẦN NGƯỜI / TIẾP QUẢN ⇒ giữ nguyên (`startHumanCooldown`).
  await startHumanCooldown(conv.id, { reason: staffReasonOf(conv.channel), at, actorUserId: user.id, key: `staff:${STAFF_OUT_PREFIX}${mark.staffMessageId}`, via: "ERP_INBOX", inbox: { userId: user.id } });
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
  const at = new Date();
  const before = aiHoldOf(conv, at);
  const resumed = await resumeConversationToAi(conv.id);
  if (!resumed) return { ok: false, error: "Không trả lại được — hội thoại vừa đổi trạng thái." };
  const resumeReason = humanResumeReason(before) ?? "RETURNED";
  await recordConversationEvent(conv.id, { type: "ai.resumed", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, reasonCode: resumeReason, payload: { from: before.state, cause: before.cause }, key: `resume:inbox:${conv.id}:${at.getTime()}` });
  // Cùng mã nhật ký với thanh điều khiển: cho AI tiếp tục NGAY trong lúc nhường ≠ trả lại sau tiếp quản / cần người.
  await audit({ userId: user.id, userEmail: user.email, action: resumeReason === "RESUMED_NOW" ? "SALES_CHAT_AI_RESUME_NOW" : "SALES_CHAT_RESUME_AI", entity: "SALES_CONVERSATION", entityId: conv.id, before: { status: "HANDOFF", reason: conv.handoffReason, hold: before.state }, after: { status: "OPEN", hold: "AI_ACTIVE" }, reason: resumeReason === "RESUMED_NOW" ? "Cho AI tiếp tục ngay — bỏ thời gian nhường" : "Trả lại cho AI từ hộp thư" });
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

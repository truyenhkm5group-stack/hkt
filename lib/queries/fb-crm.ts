import { asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { CRM_RULE } from "@/lib/constants/crm";
import {
  FB_CONNECTION_STATUSES,
  FB_CRM_SETTING_KEY,
  FB_CRM_TASK_TAG,
  FB_CRM_VIEWS,
  FB_URL_SOURCES,
  REPEAT_BUYER_MIN_DELIVERED,
  fbCrmEnabledOf,
  isUndefinedTableError,
  type FbConnectionStatus,
  type FbCrmView,
  type FbUrlSource,
} from "@/lib/constants/fb-crm";
import { pancakeConversationUrl } from "@/lib/constants/pancake";
import { toDate } from "@/lib/format";
import { segmentOf } from "@/lib/queries/crm";
import { customerSearchCondition } from "@/lib/queries/customers";
import { chatLinkOf, salesInboxEnabled, type ChatLink } from "@/lib/queries/orders";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT, VERIFIED_CASH } from "@/lib/queries/return-rate";
import { avatarProxyHref, avatarProxyRefFor } from "@/lib/sales-chatbot/avatar-profile";
import { safeAvatarUrl } from "@/lib/sales-chatbot/inbox-shared";
import type { ListParams } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ FACEBOOK FRIEND CRM — ĐƯỜNG ĐỌC (lát 1 · docs/verticals/facebook-friend-crm.md) ═══════════
 *
 * Danh sách = khách có ít nhất một hội thoại (`sales_chat_conversations.customer_id`, trừ khung TEST) HOẶC có đơn. Không tạo
 * CRM thứ hai: tên / SĐT từ `customers`, hội thoại từ hộp thư, đơn từ `orders`, kết quả đơn CHỈ qua `ORDER_OUTCOME_FAST` trên
 * lần gửi chính (`PRIMARY_ATTEMPT`) — đúng phép gom của trang Khách hàng (`lib/queries/customers.ts`).
 *
 * DOANH THU THỰC = tổng `VERIFIED_CASH` (COD đã thực thu + tiền chuyển trước có ghi nhận) của đơn GIAO THÀNH CÔNG. Không đơn nào
 * có chứng từ tiền ⇒ `null` (in «—», luật 42) — KHÔNG phải 0, và KHÔNG lấy giá trị đơn danh nghĩa thay vào.
 *
 * Mọi bảng ở CSDL của TỔ CHỨC (`getDb()` theo ngữ cảnh) — tổ chức này không bao giờ thấy khách của tổ chức khác.
 */

/** Cờ tổ chức `fbCrm.enabled` (object `{"on": true}`). Mặc định TẮT. */
export async function fbCrmEnabled(): Promise<boolean> {
  return fbCrmEnabledOf(await getSettingJson<Record<string, unknown>>(FB_CRM_SETTING_KEY, {}));
}

/**
 * «Lâu chưa quay lại» = phân khúc `AT_RISK` hoặc `CHURNED` của trang Giữ chân khách (`segmentOf`, lib/queries/crm.ts) — một định
 * nghĩa. Với khách đã có ≥ 1 đơn giao thành công, hai phân khúc ấy gộp lại đúng là «lần giao gần nhất cách quá `activeDays`»;
 * SQL dưới đây viết đúng điều kiện đó và bài kiểm so nó với `segmentOf` trên cả lưới số.
 */
export function isLapsed(delivered: number, daysSince: number): boolean {
  if (delivered < 1) return false;
  const seg = segmentOf(delivered, daysSince);
  return seg === "AT_RISK" || seg === "CHURNED";
}

const VIEW_COND: Record<FbCrmView, SQL> = {
  all: sql`true`,
  messaged: sql`messaged_fanpage`,
  bought: sql`delivered >= 1`,
  not_bought: sql`delivered = 0`,
  // Hỏi giá (sự kiện `quote.given` trong hội thoại của khách) mà CHƯA có đơn nào còn sống và chưa hội thoại nào ở mức «Đã chốt đơn».
  quoted: sql`quoted and orders = 0 and not any_ordered`,
  repeat: sql`delivered >= ${REPEAT_BUYER_MIN_DELIVERED}`,
  lapsed: sql`delivered >= 1 and days_since_delivered > ${CRM_RULE.activeDays}`,
  consented: sql`connection_status in ('CONSENTED', 'INVITE_SENT') and not do_not_contact`,
  friends: sql`connection_status = 'FRIENDS'`,
  not_friends: sql`connection_status <> 'FRIENDS' and not do_not_contact`,
  dnc: sql`do_not_contact`,
};

const SORT_EXPR: Record<string, string> = {
  lastInteractionAt: "last_interaction_at",
  deliveredCount: "delivered",
  realRevenue: "real_revenue",
  nextCareOn: "next_care_on",
  name: "name",
};

/** Phần chung của danh sách và bộ đếm: `with … base as (…)` — MỘT định nghĩa của «khách thuộc trang này» và mọi cột. */
function baseCte(q: string, customerId: string | null = null): SQL {
  const search = customerSearchCondition(q) ?? sql`true`;
  // `?c=<mã khách>` — dòng việc «Hẹn chăm sóc» trên /work mở ĐÚNG một khách để làm thao tác thật của miền.
  const only = customerId ? sql`customers.id = ${customerId}` : sql`true`;
  return sql`
    with conv as (
      select distinct on (sc.customer_id) sc.customer_id, sc.id as conv_id, sc.channel, sc.page_id, sc.thread_id,
             greatest(coalesce(sc.last_customer_at, 'epoch'::timestamptz), coalesce(sc.last_bot_at, 'epoch'::timestamptz),
                      coalesce(sc.last_staff_at, 'epoch'::timestamptz), sc.created_at) as activity
      from sales_chat_conversations sc
      where sc.customer_id is not null and sc.channel <> 'TEST'
      order by sc.customer_id, activity desc, sc.id
    ),
    conv_n as (
      select customer_id, count(*)::int as n, bool_or(channel = 'FANPAGE') as fanpage, bool_or(customer_level = 'ORDERED') as any_ordered
      from sales_chat_conversations
      where customer_id is not null and channel <> 'TEST'
      group by customer_id
    ),
    quoted as (
      select distinct sc.customer_id
      from sales_conversation_events e
      join sales_chat_conversations sc on sc.id = e.conversation_id
      where e.type = 'quote.given' and sc.customer_id is not null
    ),
    facts as (
      select orders.customer_id as customer_id, orders.inserted_at as at, orders.stage::text as stage,
             ${ORDER_OUTCOME_FAST} as outcome, ${VERIFIED_CASH} as cash
      from orders
      -- MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được đếm / cộng tiền nhiều lần.
      left join shipments on shipments.order_id = orders.id and ${PRIMARY_ATTEMPT}
      where orders.customer_id is not null
      offset 0
    ),
    agg as (
      select customer_id,
             count(*) filter (where stage not in ('CANCELLED', 'DELETED'))::int as orders,
             count(*) filter (where outcome = 'DELIVERED')::int as delivered,
             sum(cash) filter (where outcome = 'DELIVERED' and cash > 0) as real_revenue,
             max(at) filter (where outcome = 'DELIVERED') as last_delivered_at,
             max(at) as last_order_at
      from facts
      group by customer_id
    ),
    base as (
      select customers.id as customer_id, customers.name as name, customers.phone as phone, customers.conversation_link as conversation_link,
             conv.conv_id, conv.channel, conv.page_id, conv.thread_id, conv.activity as conv_activity,
             coalesce(conv_n.n, 0) as conv_count,
             coalesce(conv_n.fanpage, false) as messaged_fanpage,
             coalesce(conv_n.any_ordered, false) as any_ordered,
             (quoted.customer_id is not null) as quoted,
             coalesce(agg.orders, 0) as orders,
             coalesce(agg.delivered, 0) as delivered,
             agg.real_revenue,
             agg.last_delivered_at,
             floor(extract(epoch from now() - agg.last_delivered_at) / 86400) as days_since_delivered,
             greatest(conv.activity, agg.last_order_at) as last_interaction_at,
             coalesce(f.connection_status, 'NOT_ASKED') as connection_status,
             f.fb_profile_url, coalesce(f.fb_url_source, 'NONE') as fb_url_source,
             f.care_owner_user_id, ou.name as owner_name,
             f.next_care_on::text as next_care_on,
             coalesce(f.do_not_contact, false) as do_not_contact, f.do_not_contact_reason,
             fp.page_name
      from customers
      left join conv on conv.customer_id = customers.id
      left join conv_n on conv_n.customer_id = customers.id
      left join quoted on quoted.customer_id = customers.id
      left join agg on agg.customer_id = customers.id
      left join customer_fb_connections f on f.customer_id = customers.id
      left join users ou on ou.id = f.care_owner_user_id
      left join lateral (
        select coalesce(nullif(x.alias, ''), nullif(x.name, '')) as page_name from fanpages x where x.external_page_id = conv.page_id limit 1
      ) fp on true
      where (conv_n.customer_id is not null or agg.customer_id is not null) and ${search} and ${only}
    )`;
}

export type FbCrmRow = {
  customerId: string;
  name: string;
  phone: string | null;
  avatarUrl: string | null;
  pageName: string | null;
  pageId: string | null;
  channel: string | null;
  conversationCount: number;
  lastConversationAt: Date | null;
  lastInteractionAt: Date | null;
  orderCount: number;
  deliveredCount: number;
  /** VND có chứng từ của đơn giao thành công; `null` = CHƯA CÓ chứng từ tiền nào (không phải 0). */
  realRevenue: number | null;
  connectionStatus: FbConnectionStatus;
  fbProfileUrl: string | null;
  fbUrlSource: FbUrlSource;
  careOwnerUserId: string | null;
  careOwnerName: string | null;
  nextCareOn: string | null;
  doNotContact: boolean;
  doNotContactReason: string | null;
  /** Mở hội thoại: hộp thư ERP nếu tổ chức có module AI bán hàng, không thì Pancake (`chatLinkOf`). */
  chatLink: ChatLink | null;
  /** Hội thoại trên Pancake — nơi nhân viên bấm avatar khách để tự tìm trang Facebook. */
  pancakeHref: string | null;
};

type RawRow = {
  customer_id: string;
  name: string;
  phone: string | null;
  conversation_link: string | null;
  conv_id: string | null;
  channel: string | null;
  page_id: string | null;
  thread_id: string | null;
  conv_activity: string | Date | null;
  conv_count: number | string;
  orders: number | string;
  delivered: number | string;
  real_revenue: number | string | null;
  last_interaction_at: string | Date | null;
  connection_status: string;
  fb_profile_url: string | null;
  fb_url_source: string;
  care_owner_user_id: string | null;
  owner_name: string | null;
  next_care_on: string | null;
  do_not_contact: boolean;
  do_not_contact_reason: string | null;
  page_name: string | null;
  total?: number | string;
};

const STATUS_SET = new Set<string>(FB_CONNECTION_STATUSES);
const SOURCE_SET = new Set<string>(FB_URL_SOURCES);
const safeHttps = (v: string | null) => (v && /^https:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim() : null);
const numOrNull = (v: number | string | null) => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function mapRow(r: RawRow, inboxOn: boolean, avatars: Map<string, string | null>): FbCrmRow {
  const chat = r.conv_id ? { conversationId: r.conv_id, channel: r.channel ?? "", pageId: r.page_id, threadId: r.thread_id } : undefined;
  const pancakeHref = (r.channel === "FANPAGE" ? pancakeConversationUrl(r.page_id, r.thread_id) : null) ?? safeHttps(r.conversation_link);
  return {
    customerId: r.customer_id,
    name: r.name,
    phone: r.phone,
    avatarUrl: r.conv_id ? (avatars.get(r.conv_id) ?? null) : null,
    pageName: r.page_name,
    pageId: r.page_id,
    channel: r.channel,
    conversationCount: Number(r.conv_count ?? 0),
    lastConversationAt: r.conv_id ? toDate(r.conv_activity) : null,
    lastInteractionAt: toDate(r.last_interaction_at),
    orderCount: Number(r.orders ?? 0),
    deliveredCount: Number(r.delivered ?? 0),
    realRevenue: numOrNull(r.real_revenue),
    connectionStatus: (STATUS_SET.has(r.connection_status) ? r.connection_status : "NOT_ASKED") as FbConnectionStatus,
    fbProfileUrl: r.fb_profile_url,
    fbUrlSource: (SOURCE_SET.has(r.fb_url_source) ? r.fb_url_source : "NONE") as FbUrlSource,
    careOwnerUserId: r.care_owner_user_id,
    careOwnerName: r.owner_name,
    nextCareOn: r.next_care_on,
    doNotContact: Boolean(r.do_not_contact),
    doNotContactReason: r.do_not_contact_reason,
    chatLink: chatLinkOf(chat, inboxOn, { pageId: null, conversationId: null }) ?? (pancakeHref ? { href: pancakeHref, internal: false } : null),
    pancakeHref,
  };
}

/**
 * Ảnh đại diện có sẵn của hội thoại gần nhất — cùng thứ tự với hộp thư (`inbox.ts::avatarOf`): ảnh Meta → ảnh Pancake không khoá
 * → ảnh Pancake qua proxy ERP (chỉ khi tổ chức có hộp thư, vì proxy nằm sau module AI bán hàng). Chỉ đọc `state` của ĐÚNG các hội
 * thoại trên trang đang xem.
 */
async function avatarsOf(convs: { id: string; channel: string | null; pageId: string | null; threadId: string | null }[], inboxOn: boolean): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!convs.length) return out;
  const db = await getDb();
  const rows = await db.select({ id: schema.salesChatConversations.id, state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, convs.map((c) => c.id)));
  const byId = new Map(convs.map((c) => [c.id, c]));
  for (const r of rows) {
    const st = (r.state && typeof r.state === "object" ? r.state : {}) as Record<string, unknown>;
    const meta = st.messengerProfile && typeof st.messengerProfile === "object" ? (st.messengerProfile as Record<string, unknown>).pic : null;
    const conv = byId.get(r.id);
    const ref = inboxOn && conv ? avatarProxyRefFor(st, { channel: conv.channel, pageId: conv.pageId, threadId: conv.threadId })?.ref : null;
    out.set(r.id, safeAvatarUrl(meta) ?? safeAvatarUrl(st.pancakeAvatarUrl) ?? (ref ? avatarProxyHref(r.id, ref) : null));
  }
  return out;
}

/**
 * Kết quả danh sách. `unavailable = true` ⇒ CSDL của tổ chức CHƯA áp 0262 (bảng `customer_fb_connections` chưa có — tổ chức đang
 * phục vụ bằng lược đồ cũ, `DEGRADED_MIGRATION`, lib/constants/migration-serve-compat.ts): trang in «CSDL chưa áp 0262», KHÔNG in
 * một danh sách rỗng trông như «không có khách nào».
 */
export type FbCrmList = { rows: FbCrmRow[]; total: number; pageCount: number; unavailable: boolean };

export async function listFbCrm(params: ListParams, view: FbCrmView, customerId: string | null = null): Promise<FbCrmList> {
  const db = await getDb();
  const sortCol = SORT_EXPR[params.sort] ?? "last_interaction_at";
  const dir = params.dir === "asc" ? "asc nulls first" : "desc nulls last";
  let raw: unknown;
  let inboxOn: boolean;
  try {
    [raw, inboxOn] = await Promise.all([
      // TẮT JIT: `facts` tính ORDER_OUTCOME_FAST cho mọi đơn có khách — cùng họ câu `listCustomers` đã đo JIT bật 7,4 s ↔ tắt 0,1 s.
      chayKhongJit(db, (tx) =>
        tx.execute(sql`${baseCte(params.q, customerId)}
          select *, count(*) over() as total from base
          where ${VIEW_COND[view]}
          order by ${sql.raw(sortCol)} ${sql.raw(dir)}, name asc, customer_id asc
          limit ${params.pageSize} offset ${(params.page - 1) * params.pageSize}`),
      ),
      salesInboxEnabled(),
    ]);
  } catch (e) {
    if (isUndefinedTableError(e)) return { rows: [], total: 0, pageCount: 1, unavailable: true };
    throw e;
  }
  const rows = rowsOf<RawRow>(raw);
  const avatars = await avatarsOf(
    rows.filter((r) => r.conv_id).map((r) => ({ id: r.conv_id as string, channel: r.channel, pageId: r.page_id, threadId: r.thread_id })),
    inboxOn,
  );
  const total = rows.length ? Number(rows[0].total ?? 0) : 0;
  return { rows: rows.map((r) => mapRow(r, inboxOn, avatars)), total, pageCount: Math.max(1, Math.ceil(total / params.pageSize)), unavailable: false };
}

export type FbCrmOverview = { views: Record<FbCrmView, number>; statuses: Record<FbConnectionStatus, number> };

/**
 * Số khách mỗi bộ lọc + mỗi trạng thái kết bạn (cùng ô tìm kiếm, cùng tập khách của trang) — MỘT câu trên `baseCte`. `null` = CSDL
 * chưa áp 0262 (CHƯA BIẾT, không phải 0 khách).
 */
export async function fbCrmOverview(q: string): Promise<FbCrmOverview | null> {
  const db = await getDb();
  const cols = sql.join(
    [
      ...FB_CRM_VIEWS.map((v) => sql`count(*) filter (where ${VIEW_COND[v]})::int as ${sql.raw(`"v_${v}"`)}`),
      ...FB_CONNECTION_STATUSES.map((st) => sql`count(*) filter (where connection_status = ${st})::int as ${sql.raw(`"s_${st}"`)}`),
    ],
    sql`, `,
  );
  let raw: unknown;
  try {
    raw = await chayKhongJit(db, (tx) => tx.execute(sql`${baseCte(q)} select ${cols} from base`));
  } catch (e) {
    if (isUndefinedTableError(e)) return null;
    throw e;
  }
  const [r] = rowsOf<Record<string, number | string>>(raw);
  return {
    views: Object.fromEntries(FB_CRM_VIEWS.map((v) => [v, Number(r?.[`v_${v}`] ?? 0)])) as Record<FbCrmView, number>,
    statuses: Object.fromEntries(FB_CONNECTION_STATUSES.map((st) => [st, Number(r?.[`s_${st}`] ?? 0)])) as Record<FbConnectionStatus, number>,
  };
}

/** Số khách mỗi bộ lọc (cùng ô tìm kiếm) — cho thanh lọc. `null` = CSDL chưa áp 0262 (CHƯA BIẾT, không phải 0 khách). */
export async function fbCrmViewCounts(q: string): Promise<Record<FbCrmView, number> | null> {
  return (await fbCrmOverview(q))?.views ?? null;
}

/**
 * ═══════════ TƯƠNG QUAN «ĐÃ KẾT BẠN ⇒ CÓ MUA SAU ĐÓ» — KHÔNG PHẢI DOANH THU DO CRM MANG LẠI ═══════════
 *
 * Khách ĐANG ở trạng thái «Đã kết bạn»; MỐC kết bạn = lần đầu nhật ký ghi `STATUS_CHANGED → FRIENDS` (giờ của dòng nhật ký, tức lúc
 * NGƯỜI ghi, không phải lúc Facebook chấp nhận). Đếm đơn GIAO THÀNH CÔNG (ORDER_OUTCOME_FAST trên lần gửi chính) đặt SAU mốc đó và
 * tiền có chứng từ (VERIFIED_CASH) của chúng. Khách có thể đã mua dù không kết bạn — con số này KHÔNG chứng minh nhân quả, và màn
 * hình phải nói thế. ĐỘ PHỦ: bao nhiêu khách «Đã kết bạn» có mốc (dòng ghi ngoài đường ghi thì không có mốc ⇒ đứng ngoài phép đếm,
 * không đoán mốc).
 */
export type FbCrmFriendCorrelation = {
  friends: number;
  withMilestone: number;
  buyersAfter: number;
  deliveredOrdersAfter: number;
  /** VND có chứng từ của các đơn ấy; `null` = chưa đơn nào có chứng từ tiền (không phải 0). */
  verifiedCashAfter: number | null;
};

export async function fbCrmFriendCorrelation(): Promise<FbCrmFriendCorrelation | null> {
  const db = await getDb();
  let raw: unknown;
  try {
    raw = await chayKhongJit(db, (tx) =>
      tx.execute(sql`
        with fr as (
          select f.customer_id,
                 (select min(e.created_at) from customer_fb_connection_events e
                   where e.customer_id = f.customer_id and e.kind = 'STATUS_CHANGED' and e.to_value = 'FRIENDS') as friend_at
          from customer_fb_connections f
          where f.connection_status = 'FRIENDS'
        ),
        facts as (
          select orders.customer_id as customer_id, orders.inserted_at as at, ${ORDER_OUTCOME_FAST} as outcome, ${VERIFIED_CASH} as cash
          from orders
          left join shipments on shipments.order_id = orders.id and ${PRIMARY_ATTEMPT}
          where orders.customer_id in (select customer_id from fr where friend_at is not null)
          offset 0
        ),
        after_friend as (
          select facts.customer_id, facts.cash from facts join fr on fr.customer_id = facts.customer_id and facts.at > fr.friend_at
          where facts.outcome = 'DELIVERED'
        )
        select (select count(*)::int from fr) as friends,
               (select count(*)::int from fr where friend_at is not null) as with_milestone,
               (select count(distinct customer_id)::int from after_friend) as buyers_after,
               (select count(*)::int from after_friend) as delivered_after,
               (select sum(cash) from after_friend where cash > 0) as cash_after`),
    );
  } catch (e) {
    if (isUndefinedTableError(e)) return null;
    throw e;
  }
  const [r] = rowsOf<Record<string, number | string | null>>(raw);
  return {
    friends: Number(r?.friends ?? 0),
    withMilestone: Number(r?.with_milestone ?? 0),
    buyersAfter: Number(r?.buyers_after ?? 0),
    deliveredOrdersAfter: Number(r?.delivered_after ?? 0),
    verifiedCashAfter: r?.cash_after === null || r?.cash_after === undefined ? null : Number(r.cash_after),
  };
}

/** Khối «Facebook CRM» của Customer 360 — trạng thái hiện tại + vài dòng nhật ký gần nhất (người làm đọc từ `users`). */
export type FbCrmCustomerPanel = {
  connectionStatus: FbConnectionStatus;
  fbProfileUrl: string | null;
  fbUrlSource: FbUrlSource;
  careOwnerName: string | null;
  nextCareOn: string | null;
  doNotContact: boolean;
  doNotContactReason: string | null;
  events: { kind: string; fromValue: string | null; toValue: string | null; note: string; actorName: string | null; createdAt: Date }[];
};

export const FB_CRM_PANEL_EVENTS = 5;

/** `null` = CSDL chưa áp 0262. Khách chưa có dòng ⇒ trạng thái mặc định («Chưa hỏi»), nhật ký rỗng. */
export async function fbCrmCustomerPanel(customerId: string): Promise<FbCrmCustomerPanel | null> {
  const db = await getDb();
  const f = schema.customerFbConnections;
  const e = schema.customerFbConnectionEvents;
  try {
    const [row] = await db
      .select({ status: f.connectionStatus, url: f.fbProfileUrl, source: f.fbUrlSource, ownerName: schema.users.name, nextCareOn: f.nextCareOn, dnc: f.doNotContact, dncReason: f.doNotContactReason })
      .from(f)
      .leftJoin(schema.users, eq(schema.users.id, f.careOwnerUserId))
      .where(eq(f.customerId, customerId))
      .limit(1);
    const events = await db
      .select({ kind: e.kind, fromValue: e.fromValue, toValue: e.toValue, note: e.note, actorName: schema.users.name, createdAt: e.createdAt })
      .from(e)
      .leftJoin(schema.users, eq(schema.users.id, e.actorId))
      .where(eq(e.customerId, customerId))
      .orderBy(desc(e.createdAt), desc(e.id))
      .limit(FB_CRM_PANEL_EVENTS);
    return {
      connectionStatus: (row && STATUS_SET.has(row.status) ? row.status : "NOT_ASKED") as FbConnectionStatus,
      fbProfileUrl: row?.url ?? null,
      fbUrlSource: (row && SOURCE_SET.has(row.source) ? row.source : "NONE") as FbUrlSource,
      careOwnerName: row?.ownerName ?? null,
      nextCareOn: row?.nextCareOn ?? null,
      doNotContact: row?.dnc ?? false,
      doNotContactReason: row?.dncReason ?? null,
      events,
    };
  } catch (err) {
    if (isUndefinedTableError(err)) return null;
    throw err;
  }
}

/**
 * Khách tới NGÀY HẸN chăm sóc — đầu vào của nguồn việc `FB_CRM_CARE` (lib/queries/work-adapters.ts). Cờ tổ chức tắt ⇒ rỗng; CSDL chưa
 * áp 0262 ⇒ rỗng. Bỏ khách «không liên hệ» và khách đã có nhiệm vụ CSKH tay (nhãn `fb-crm`) còn MỞ — một khách không thành hai việc.
 */
export type FbCrmDueCareRow = { customerId: string; name: string; phone: string | null; nextCareOn: string; connectionStatus: FbConnectionStatus; ownerId: string | null; ownerName: string | null };

export async function fbCrmDueCare(today: string): Promise<FbCrmDueCareRow[]> {
  if (!(await fbCrmEnabled())) return [];
  const db = await getDb();
  let raw: unknown;
  try {
    raw = await db.execute(sql`
      select f.customer_id, c.name, c.phone, f.next_care_on::text as next_care_on, f.connection_status,
             f.care_owner_user_id as owner_id, u.name as owner_name
      from customer_fb_connections f
      join customers c on c.id = f.customer_id
      left join users u on u.id = f.care_owner_user_id
      where f.next_care_on is not null and f.next_care_on <= ${today}::date and not f.do_not_contact
        and not exists (
          select 1 from work_items w
          where w.business_entity = 'CUSTOMER' and w.business_entity_id = f.customer_id
            and w.tags @> ${JSON.stringify([FB_CRM_TASK_TAG])}::jsonb and w.status not in ('DONE', 'CANCELLED')
        )
      order by f.next_care_on, f.customer_id
      limit 500`);
  } catch (e) {
    if (isUndefinedTableError(e)) return [];
    throw e;
  }
  type Raw = { customer_id: string; name: string; phone: string | null; next_care_on: string; connection_status: string; owner_id: string | null; owner_name: string | null };
  return rowsOf<Raw>(raw).map((r) => ({
    customerId: r.customer_id,
    name: r.name,
    phone: r.phone,
    nextCareOn: r.next_care_on,
    connectionStatus: (STATUS_SET.has(r.connection_status) ? r.connection_status : "NOT_ASKED") as FbConnectionStatus,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
  }));
}

/** Nhân viên có thể nhận phụ trách — tài khoản còn hoạt động của tổ chức. */
export async function fbCrmAssignableUsers(): Promise<{ id: string; name: string }[]> {
  const db = await getDb();
  return db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.active, true)).orderBy(asc(schema.users.name));
}

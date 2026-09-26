/**
 * Truy vấn cho "Gửi tin hàng loạt" (`/outreach/broadcast`). Luật chọn người nhận ở
 * `lib/constants/outreach-broadcast.ts`, đường gửi ở `lib/outreach/broadcast.ts`.
 *
 * NGUỒN là `conversation_funnel`: job `cs-chat` quét lại mọi hội thoại 48 giờ gần nhất mỗi 15 phút (tối đa
 * 200 hội thoại mỗi page, xem cột `truncated`). 48 giờ phủ trọn cửa sổ 24 giờ của Meta, nên mọi khách còn
 * nhắn được đều có mặt ở đây — TRỪ page bị cắt ở trần 200, và màn hình phải in ra điều đó.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { broadcastFiltersSchema, conversationVerdict, seenVerdict, META_WINDOW_HOURS, META_WINDOW_MARGIN_MINUTES, type BroadcastFilters, type BroadcastSkipReason } from "@/lib/constants/outreach-broadcast";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { rowsOf } from "@/lib/sql-rows";

/**
 * Khách đã có đơn chưa huỷ trong [from, to]: ghép theo hội thoại HOẶC SĐT — cùng luật với
 * `hasRecentOrder` của kịch bản băn khoăn (`lib/outreach/build.ts`). MỘT biểu thức, dùng cho cả lọc lúc xem
 * trước, kiểm lại lúc gửi, và đếm "có đơn sau khi nhận tin".
 */
export function orderExistsBetween(conversationId: SQL, phone: SQL, from: SQL, to: SQL): SQL {
  return sql`exists (
    select 1 from orders o
    where (o.conversation_id = ${conversationId} or (${phone} is not null and ${phone} <> '' and o.bill_phone = ${phone}))
      and o.inserted_at >= ${from} and o.inserted_at <= ${to}
      and o.stage::text not in ('CANCELLED','DELETED')
  )`;
}

const RECENT_ORDER_DAYS = 30;

export function recentOrderExists(conversationId: SQL, phone: SQL): SQL {
  return orderExistsBetween(conversationId, phone, sql`now() - make_interval(days => ${RECENT_ORDER_DAYS})`, sql`now()`);
}

/** Lọc bằng SQL phần không phụ thuộc thời gian thực: page · ngày · thẻ · SĐT. */
function baseConds(f: BroadcastFilters): SQL[] {
  const c: SQL[] = [];
  if (f.pageIds.length) c.push(sql`cf.page_id in (${sql.join(f.pageIds.map((p) => sql`${p}`), sql`, `)})`);
  if (f.from) c.push(sql`cf.last_customer_message_at >= ${vnStartOfDay(f.from).toISOString()}::timestamptz`);
  if (f.to) c.push(sql`cf.last_customer_message_at <= ${vnEndOfDay(f.to).toISOString()}::timestamptz`);
  if (f.tagsAny.length) c.push(sql`cf.tags && array[${sql.join(f.tagsAny.map((t) => sql`${t}`), sql`, `)}]::text[]`);
  if (f.tagsNone.length) c.push(sql`not (cf.tags && array[${sql.join(f.tagsNone.map((t) => sql`${t}`), sql`, `)}]::text[])`);
  if (f.phone === "HAS") c.push(sql`coalesce(cf.phone, '') <> ''`);
  if (f.phone === "NONE") c.push(sql`coalesce(cf.phone, '') = ''`);
  return c;
}

const where = (conds: SQL[]) => (conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``);

export type BroadcastCandidate = {
  pageId: string;
  pageName: string;
  conversationId: string;
  pancakeCustomerId: string;
  customerName: string;
  phone: string | null;
  tags: string[];
  lastCustomerMessageAt: Date | null;
  lastShopMessageAt: Date | null;
  customerSeenAt: Date | null;
};

export type BroadcastPreview = {
  eligible: BroadcastCandidate[];
  /** Số khách bị loại, theo lý do. Chỉ lý do có số > 0. */
  excluded: Partial<Record<BroadcastSkipReason, number>>;
  /** Page bị cắt ở trần quét 200 hội thoại trong lượt `cs-chat` gần nhất — có khách không nằm trong danh sách. */
  truncatedPages: { pageId: string; pageName: string }[];
  /** Lượt quét hội thoại gần nhất — tuổi của dữ liệu đang lọc. `null` = chưa có lượt nào. */
  lastScanAt: Date | null;
};

type Row = {
  page_id: string;
  page_name: string | null;
  conversation_id: string;
  pancake_customer_id: string;
  customer_name: string;
  phone: string | null;
  tags: string[] | null;
  last_customer_message_at: string | Date | null;
  last_shop_message_at: string | Date | null;
  customer_seen_at: string | Date | null;
  has_order: boolean;
  recently_broadcast: boolean;
};

const toDate = (v: string | Date | null) => (v === null ? null : v instanceof Date ? v : new Date(v));

/** Danh sách người nhận theo bộ lọc — đúng danh sách lượt gửi sẽ chụp nếu bấm ngay bây giờ. */
export async function previewBroadcast(rawFilters: BroadcastFilters, now = new Date()): Promise<BroadcastPreview> {
  const f = broadcastFiltersSchema.parse(rawFilters);
  const db = await getDb();
  const windowStart = new Date(now.getTime() - (META_WINDOW_HOURS * 60 - META_WINDOW_MARGIN_MINUTES) * 60_000);
  const conds = baseConds(f);
  const recentCut = new Date(now.getTime() - f.skipRecentHours * 3_600_000);

  const [rows, outside, truncated, scan] = await Promise.all([
    db.execute(sql`
      select cf.page_id, fp.name as page_name, cf.conversation_id, cf.pancake_customer_id, cf.customer_name, cf.phone, cf.tags,
             cf.last_customer_message_at, cf.last_shop_message_at, cf.customer_seen_at,
             ${recentOrderExists(sql`cf.conversation_id`, sql`cf.phone`)} as has_order,
             ${
               f.skipRecentHours > 0
                 ? sql`exists (select 1 from outreach_broadcast_recipients r where r.page_id = cf.page_id and r.conversation_id = cf.conversation_id and r.status = 'SENT' and r.sent_at >= ${recentCut.toISOString()}::timestamptz)`
                 : sql`false`
             } as recently_broadcast
      from conversation_funnel cf
      left join fanpages fp on fp.external_page_id = cf.page_id
      ${where([...conds, sql`(cf.last_customer_message_at is null or cf.last_customer_message_at >= ${windowStart.toISOString()}::timestamptz)`])}
      order by cf.last_customer_message_at asc nulls last, cf.conversation_id
      limit 20000`),
    db.execute(sql`select count(*)::int as n from conversation_funnel cf ${where([...conds, sql`cf.last_customer_message_at < ${windowStart.toISOString()}::timestamptz`])}`),
    db.execute(sql`
      select distinct cf.page_id, coalesce(fp.name, '') as page_name
      from conversation_funnel cf left join fanpages fp on fp.external_page_id = cf.page_id
      where cf.truncated and cf.last_scan_at >= now() - interval '1 hour'`),
    db.execute(sql`select max(last_scan_at) as at from conversation_funnel`),
  ]);

  const excluded: Partial<Record<BroadcastSkipReason, number>> = {};
  const bump = (r: BroadcastSkipReason) => (excluded[r] = (excluded[r] ?? 0) + 1);
  const outsideN = Number(rowsOf<{ n: number }>(outside)[0]?.n ?? 0);
  if (outsideN) excluded.OUTSIDE_WINDOW = outsideN;

  const eligible: BroadcastCandidate[] = [];
  for (const r of rowsOf<Row>(rows)) {
    const lastShopAt = toDate(r.last_shop_message_at);
    const verdict = conversationVerdict({ lastCustomerAt: toDate(r.last_customer_message_at), lastShopAt }, f, now);
    // Lý do MẠNH đếm trước: khách đã có đơn thì "chưa biết đã xem" không còn nghĩa gì.
    const seen = seenVerdict(toDate(r.customer_seen_at), lastShopAt, f.seen);
    if (verdict) bump(verdict);
    else if (f.order === "NO_ORDER" && r.has_order) bump("HAS_ORDER");
    else if (r.recently_broadcast) bump("RECENTLY_BROADCAST");
    else if (!r.pancake_customer_id) bump("NO_CUSTOMER_ID");
    else if (seen) bump(seen);
    else if (eligible.length >= f.limit) bump("OVER_LIMIT");
    else
      eligible.push({
        pageId: r.page_id,
        pageName: r.page_name ?? "",
        conversationId: r.conversation_id,
        pancakeCustomerId: r.pancake_customer_id,
        customerName: r.customer_name,
        phone: r.phone,
        tags: r.tags ?? [],
        lastCustomerMessageAt: toDate(r.last_customer_message_at),
        lastShopMessageAt: lastShopAt,
        customerSeenAt: toDate(r.customer_seen_at),
      });
  }
  const scanAt = rowsOf<{ at: string | Date | null }>(scan)[0]?.at ?? null;
  return {
    eligible,
    excluded,
    truncatedPages: rowsOf<{ page_id: string; page_name: string }>(truncated).map((r) => ({ pageId: r.page_id, pageName: r.page_name })),
    lastScanAt: toDate(scanAt),
  };
}

/** Lựa chọn cho bộ lọc: page và thẻ đang có trong 48 giờ quét gần nhất, kèm số hội thoại. */
export async function broadcastFilterOptions() {
  const db = await getDb();
  const [pages, tags] = await Promise.all([
    db.execute(sql`
      select cf.page_id, coalesce(max(fp.name), '') as page_name, count(*)::int as n
      from conversation_funnel cf left join fanpages fp on fp.external_page_id = cf.page_id
      where cf.last_scan_at >= now() - interval '48 hours'
      group by cf.page_id order by n desc`),
    db.execute(sql`
      select t as tag, count(*)::int as n
      from conversation_funnel cf, unnest(cf.tags) as t
      where cf.last_scan_at >= now() - interval '48 hours'
      group by t order by n desc limit 80`),
  ]);
  return {
    pages: rowsOf<{ page_id: string; page_name: string; n: number }>(pages).map((r) => ({ id: r.page_id, name: r.page_name, count: Number(r.n) })),
    tags: rowsOf<{ tag: string; n: number }>(tags).map((r) => ({ tag: r.tag, count: Number(r.n) })),
  };
}

export type BroadcastSummary = {
  id: string;
  name: string;
  status: string;
  total: number;
  messageCount: number;
  createdByName: string;
  createdAt: Date;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  pending: number;
  sending: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Khách nhắn lại SAU tin (theo lượt quét `cs-chat`, chỉ thấy trong 48 giờ). */
  replied: number;
  /** Có đơn trong 7 ngày sau tin. Tương quan, KHÔNG phải quy công — không có nhóm đối chứng. */
  ordered: number;
  /** Lý do bỏ qua / loại lỗi → số khách. */
  reasons: { status: string; reason: string; n: number }[];
};

export async function listBroadcasts(limit = 20): Promise<BroadcastSummary[]> {
  const db = await getDb();
  const [rows, reasons] = await Promise.all([
    db.execute(sql`
      select b.id, b.name, b.status, b.total, jsonb_array_length(b.messages)::int as message_count, b.created_by_name, b.created_at, b.heartbeat_at, b.finished_at,
             count(r.id) filter (where r.status = 'PENDING')::int as pending,
             count(r.id) filter (where r.status = 'SENDING')::int as sending,
             count(r.id) filter (where r.status = 'SENT')::int as sent,
             count(r.id) filter (where r.status = 'SKIPPED')::int as skipped,
             count(r.id) filter (where r.status = 'FAILED')::int as failed,
             count(r.id) filter (where r.status = 'SENT' and exists (
               select 1 from conversation_funnel cf where cf.page_id = r.page_id and cf.conversation_id = r.conversation_id and cf.last_customer_message_at > r.sent_at
             ))::int as replied,
             count(r.id) filter (where r.status = 'SENT' and ${orderExistsBetween(sql`r.conversation_id`, sql`r.phone`, sql`r.sent_at`, sql`r.sent_at + interval '7 days'`)})::int as ordered
      from (select * from outreach_broadcasts order by created_at desc limit ${limit}) b
      left join outreach_broadcast_recipients r on r.broadcast_id = b.id
      group by b.id, b.name, b.status, b.total, b.messages, b.created_by_name, b.created_at, b.heartbeat_at, b.finished_at
      order by b.created_at desc`),
    db.execute(sql`
      select r.broadcast_id, r.status, coalesce(r.reason, '') as reason, count(*)::int as n
      from outreach_broadcast_recipients r
      where r.status in ('SKIPPED','FAILED') and r.broadcast_id in (select id from outreach_broadcasts order by created_at desc limit ${limit})
      group by r.broadcast_id, r.status, r.reason`),
  ]);
  const byId = new Map<string, { status: string; reason: string; n: number }[]>();
  for (const r of rowsOf<{ broadcast_id: string; status: string; reason: string; n: number }>(reasons)) {
    const list = byId.get(r.broadcast_id) ?? [];
    list.push({ status: r.status, reason: r.reason, n: Number(r.n) });
    byId.set(r.broadcast_id, list);
  }
  type R = { id: string; name: string; status: string; total: number; message_count: number; created_by_name: string; created_at: string | Date; heartbeat_at: string | Date | null; finished_at: string | Date | null; pending: number; sending: number; sent: number; skipped: number; failed: number; replied: number; ordered: number };
  return rowsOf<R>(rows).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    total: Number(r.total),
    messageCount: Number(r.message_count),
    createdByName: r.created_by_name,
    createdAt: toDate(r.created_at) as Date,
    heartbeatAt: toDate(r.heartbeat_at),
    finishedAt: toDate(r.finished_at),
    pending: Number(r.pending),
    sending: Number(r.sending),
    sent: Number(r.sent),
    skipped: Number(r.skipped),
    failed: Number(r.failed),
    replied: Number(r.replied),
    ordered: Number(r.ordered),
    reasons: (byId.get(r.id) ?? []).sort((a, b) => b.n - a.n),
  }));
}

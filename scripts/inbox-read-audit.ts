/*
  ops `inbox-read-audit` — «CHƯA ĐỌC» CỦA HỘP THƯ KHÁCH CÓ BẰNG CHỨNG KHÔNG, ĐO TRÊN DỮ LIỆU THẬT CỦA MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (chủ shop 10/10/2026 tối, P0.6): danh sách «Chưa đọc» của HSLC hiện nhiều dòng «AI: …» kèm huy hiệu — trông như tin gửi ra
  là chưa đọc. Bất biến của bản sửa: hội thoại «chưa đọc» ⇒ TỒN TẠI ≥ 1 tin KHÁCH thật (không phải bot · nhân viên ERP · phía page · tin
  nhập lịch sử) mới hơn con trỏ đọc. Script đo trên N hội thoại gần nhất (hoặc MỘT hội thoại chỉ định):
   · từng dòng: last_customer_at · last_bot_at · last_staff_at · con trỏ CHUNG (`greatest(staff_seen_at, last_staff_at)`) · số người có
     con trỏ RIÊNG (`sales_chat_reads`, 0239) · số tin khách sau con trỏ chung · huy hiệu theo LUẬT CŨ (cột mốc + `max(1, …)`) · phía +
     mốc của tin xem trước theo luật cũ (tin mới nhất) và luật mới (tin khách chưa đọc khi có);
   · TỔNG: FALSE-UNREAD (huy hiệu > 0 mà không có tin khách nào sau con trỏ) và «xem trước phía AI / NV / page mà vẫn chưa đọc» — theo
     luật CŨ (đúng thứ production đang hiện trước khi triển khai) và theo luật MỚI (phải bằng 0); cặp (hội thoại, người) có con trỏ riêng;
   · «CHƯA ĐỌC» LƯU SẴN 0245 trên MỌI hội thoại: số dòng `turn_unhandled` lệch định nghĩa #803 tính trực tiếp (+ mốc đọc lệch) — phải 0;
   · CHƯA ĐỌC VẬN HÀNH (chủ shop 11/10/2026, OWNER CORRECTION): «chưa đọc» = LƯỢT KHÁCH MỚI NHẤT CHƯA XỬ LÝ — MỘT định nghĩa của
     response-ownership (#803). UNREAD_COUNT_BEFORE = số hội thoại luật V3 đang báo chưa đọc (người xem chưa có con trỏ riêng — đúng thứ
     production hiện); UNREAD_COUNT_AFTER = định nghĩa #803 trên MỌI hội thoại. FALSE_UNREAD = hội thoại
     báo chưa đọc mà bản TS của #803 (`latestTurnStateOf`, đọc sổ độc lập) nói lượt khách mới nhất ĐÃ xử lý — TRƯỚC theo luật V3, SAU
     theo câu SQL của hộp thư (phải 0); kèm số «bỏ sót» (TS chưa xử lý mà SQL nói đã). CẦN bản triển khai có #803 + 0245: ops lấy script
     từ main nhưng lib/ từ image đang chạy.
  Luật dùng ĐÚNG các biểu thức của ứng dụng (`inbox-states.ts`, `inbox.ts::inboundSide / webSideOf`) — không viết luật thứ hai.

  Không in tên, SĐT, chữ tin, mã tin hay mã người. Mốc thời gian + số đếm + mã hội thoại (UUID nội bộ — chỉ ở phần MÃ HOÁ). Vẫn MÃ HOÁ
  cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] chỉ là số đếm. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở
  kết nối đầu tiên + hỏi lại phiên); CSDL tổ chức mở bằng `getDbForInspection` (không migrate). CSDL chưa có bảng 0239 ⇒ coi như
  không ai có con trỏ riêng (đúng nghĩa: luật mới lùi về con trỏ chung) và nói rõ trong kết quả.

  arg: `<mã tổ chức> [--limit=N] [--conversation=<mã hội thoại>]` (N mặc định 60, trần 3000).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("inbox-read-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";
import type { AiBlock } from "@/lib/ai/provider";
import { inboundSide, webSideOf } from "@/lib/sales-chatbot/inbox";
import {
  customerCountAfterSql,
  customerInboundRowSql,
  customerMessageRowSql,
  HUMAN_UNREAD_COUNT_SQL,
  HUMAN_UNREAD_SQL,
  INBOX_ACTIVITY_SQL,
  SHARED_SEEN_SQL,
} from "@/lib/sales-chatbot/inbox-states";
import { INBOX_UNREAD_SQL } from "@/lib/sales-chatbot/inbox-unread";
import { latestCustomerTurnUnhandledSql, latestTurnStateOf } from "@/lib/sales-chatbot/response-ownership-ledger";
import type { TimelineSide } from "@/lib/sales-chatbot/inbox-shared";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const READ_AUDIT_DEFAULT_LIMIT = 60;
export const READ_AUDIT_MAX_LIMIT = 3000;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export function parseReadAuditArgs(argv: readonly string[]): { code: string; limit: number; conversation: string | null } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--limit="))?.slice(8);
  const limit = raw === undefined ? READ_AUDIT_DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_AUDIT_MAX_LIMIT) return { error: `--limit phải là số nguyên 1..${READ_AUDIT_MAX_LIMIT}` };
  const conv = argv.find((a) => a.startsWith("--conversation="))?.slice(15) ?? null;
  if (conv !== null && !/^[A-Za-z0-9-]{1,100}$/.test(conv)) return { error: "--conversation phải là mã hội thoại (chữ, số, gạch ngang)" };
  return { code, limit, conversation: conv };
}

/** Sự thật đã đọc của MỘT hội thoại — chỉ mốc + số đếm + phía, không chữ. */
export type ReadAuditRow = {
  channel: string;
  lastCustomerAt: Date | null;
  lastBotAt: Date | null;
  lastStaffAt: Date | null;
  /** Con trỏ CHUNG (`greatest(staff_seen_at, last_staff_at)`, epoch khi chưa ai). */
  sharedCursor: Date;
  /** Số người có con trỏ riêng · số người trong đó còn tin khách chưa đọc · số cặp vi phạm bất biến. */
  readers: number;
  readersUnread: number;
  readersFalseUnread: number;
  /** Luật CŨ: cờ theo cột mốc + số đếm cũ (huy hiệu in `max(1, số)`). */
  legacyUnread: boolean;
  legacyCount: number;
  /** Số tin khách thật sau con trỏ CHUNG — luật MỚI cho người xem chưa có con trỏ riêng. */
  customerAfterShared: number;
  newestCustomerAt: Date | null;
  latestSide: TimelineSide | null;
  latestAt: Date | null;
  /**
   * Luật VẬN HÀNH (#803): cờ chưa đọc của hộp thư (`INBOX_UNREAD_SQL` — kết quả lưu sẵn 0245) và kết luận của bản TS (`latestTurnStateOf` — lượt khách mới
   * nhất đã xử lý chưa, bởi ai). `undefined` = chưa đo (CSDL chưa có 0245 / không phải kênh nhắn tin ⇒ TS không áp dụng).
   */
  unreadSql?: boolean | null;
  turnHandled?: boolean | null;
  turnBy?: string | null;
  /**
   * Dòng mà SQL và TS LỆCH nhau ở lượt đầu được ĐỌC LẠI cả hai dạng cùng lúc (`unreadSqlRecheck` / `turnHandledRecheck`): lượt đầu
   * đọc SQL cho cả trang trước rồi mới chạy TS từng hội thoại một — giờ cao điểm AI trả lời trong vài giây nên câu trả lời tới GIỮA
   * hai lần đọc trông như lệch định nghĩa. Còn lệch sau khi đọc lại mới là lệch thật. `undefined` = không cần đọc lại.
   */
  unreadSqlRecheck?: boolean | null;
  turnHandledRecheck?: boolean | null;
};

export type ReadAuditTotals = {
  rows: number;
  legacy: { unread: number; falseUnread: number; aiPreviewUnread: number };
  current: { unread: number; falseUnread: number; aiPreviewUnread: number };
  readers: { pairs: number; unread: number; falseUnread: number };
  /**
   * Chưa đọc VẬN HÀNH trên các dòng đã đo: TRƯỚC (luật V3) `v3Unread` · `v3FalseUnread` (V3 báo chưa đọc mà #803 nói đã xử lý — chia theo
   * `byReply` / `byRead`); SAU (câu SQL hộp thư) `unread` · `falseUnread` (phải 0) · `missed` (TS chưa xử lý mà SQL nói đã — phải 0).
   */
  attention: {
    measured: boolean;
    v3Unread: number;
    v3FalseUnread: number;
    byReply: number;
    byRead: number;
    unread: number;
    falseUnread: number;
    missed: number;
    /** Sau khi đọc lại cùng lúc: còn lệch (lệch THẬT) · hết lệch (câu trả lời / tin khách tới giữa hai lần đọc). */
    falseUnreadConfirmed: number;
    missedConfirmed: number;
    raced: number;
  };
};

/** Phía + mốc của tin xem trước theo luật MỚI (`listInbox`): chưa đọc ⇒ tin khách chưa đọc mới nhất; không ⇒ tin mới nhất. HÀM THUẦN. */
export function currentPreviewOf(r: ReadAuditRow): { side: TimelineSide | null; at: Date | null } {
  return r.customerAfterShared > 0 && r.newestCustomerAt ? { side: "CUSTOMER", at: r.newestCustomerAt } : { side: r.latestSide, at: r.latestAt };
}

/** Tổng của bất biến «chưa đọc ⇒ có tin khách sau con trỏ», luật cũ và luật mới. HÀM THUẦN. */
export function auditReadRows(rows: readonly ReadAuditRow[]): ReadAuditTotals {
  const t: ReadAuditTotals = {
    rows: rows.length,
    legacy: { unread: 0, falseUnread: 0, aiPreviewUnread: 0 },
    current: { unread: 0, falseUnread: 0, aiPreviewUnread: 0 },
    readers: { pairs: 0, unread: 0, falseUnread: 0 },
    attention: { measured: false, v3Unread: 0, v3FalseUnread: 0, byReply: 0, byRead: 0, unread: 0, falseUnread: 0, missed: 0, falseUnreadConfirmed: 0, missedConfirmed: 0, raced: 0 },
  };
  for (const r of rows) {
    if (r.legacyUnread) {
      t.legacy.unread += 1;
      // Huy hiệu cũ in max(1, số) — không có tin khách nào sau con trỏ chung mà vẫn «chưa đọc» là chưa đọc GIẢ.
      if (r.customerAfterShared === 0) t.legacy.falseUnread += 1;
      // Xem trước cũ = tin MỚI NHẤT bất kể phía.
      if (r.latestSide && r.latestSide !== "CUSTOMER") t.legacy.aiPreviewUnread += 1;
    }
    if (r.customerAfterShared > 0) {
      t.current.unread += 1;
      // Kiểm ĐỘC LẬP với câu đếm: tin khách mới nhất phải mới hơn con trỏ.
      if (!r.newestCustomerAt || r.newestCustomerAt.getTime() <= r.sharedCursor.getTime()) t.current.falseUnread += 1;
      if (currentPreviewOf(r).side !== "CUSTOMER") t.current.aiPreviewUnread += 1;
    }
    t.readers.pairs += r.readers;
    t.readers.unread += r.readersUnread;
    t.readers.falseUnread += r.readersFalseUnread;
    if (r.unreadSql === undefined || r.unreadSql === null || r.turnHandled === undefined || r.turnHandled === null) continue;
    t.attention.measured = true;
    if (r.customerAfterShared > 0) {
      t.attention.v3Unread += 1;
      if (r.turnHandled) {
        t.attention.v3FalseUnread += 1;
        if (r.turnBy === "HUMAN_READ") t.attention.byRead += 1;
        else t.attention.byReply += 1;
      }
    }
    if (r.unreadSql) {
      t.attention.unread += 1;
      if (r.turnHandled) t.attention.falseUnread += 1;
    } else if (!r.turnHandled) t.attention.missed += 1;
    if (r.unreadSql === !r.turnHandled) continue;
    // Lệch ở lượt đầu: chỉ tính là lệch THẬT khi đọc lại cùng lúc vẫn lệch. Chưa đọc lại (bài kiểm dựng dòng tay) ⇒ coi như còn lệch.
    const sqlNow = r.unreadSqlRecheck ?? r.unreadSql;
    const tsNow = r.turnHandledRecheck ?? r.turnHandled;
    if (sqlNow === !tsNow) t.attention.raced += 1;
    else if (sqlNow) t.attention.falseUnreadConfirmed += 1;
    else t.attention.missedConfirmed += 1;
  }
  return t;
}

const isoOr = (d: Date | null | undefined) => (d && d.getTime() > 0 ? d.toISOString() : "—");

/** Một dòng chi tiết (phần mã hoá) — mốc + số đếm + phía. HÀM THUẦN. */
export function readAuditLine(i: number, r: ReadAuditRow): string {
  const cur = currentPreviewOf(r);
  const legacyBadge = r.legacyUnread ? Math.max(1, r.legacyCount) : 0;
  return [
    `#${i + 1} ${r.channel}`,
    `khách ${isoOr(r.lastCustomerAt)}`,
    `bot ${isoOr(r.lastBotAt)}`,
    `NV ${isoOr(r.lastStaffAt)}`,
    `con trỏ chung ${isoOr(r.sharedCursor)}`,
    `người có con trỏ riêng ${r.readers} (còn chưa đọc ${r.readersUnread})`,
    `tin khách sau con trỏ chung ${r.customerAfterShared}`,
    `huy hiệu cũ ${legacyBadge} / mới ${r.customerAfterShared}`,
    `xem trước cũ ${r.latestSide ?? "—"} ${isoOr(r.latestAt)} / mới ${cur.side ?? "—"} ${isoOr(cur.at)}`,
    `vận hành: SQL ${r.unreadSql === undefined || r.unreadSql === null ? "—" : r.unreadSql ? "chưa đọc" : "đã xử lý"} · TS ${r.turnHandled === undefined || r.turnHandled === null ? "—" : r.turnHandled ? `đã xử lý (${r.turnBy ?? "—"})` : "chưa xử lý"}` + (r.unreadSqlRecheck !== undefined || r.turnHandledRecheck !== undefined ? ` · đọc lại: SQL ${r.unreadSqlRecheck === null || r.unreadSqlRecheck === undefined ? "—" : r.unreadSqlRecheck ? "chưa đọc" : "đã xử lý"} · TS ${r.turnHandledRecheck ? "đã xử lý" : "chưa xử lý"}` : ""),
  ].join(" · ");
}

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * `measureAttention` (mặc định: tự dò — có cột 0245 và bảng con trỏ đọc) đo thêm luật VẬN HÀNH: cờ SQL của hộp thư + bản TS của #803 cho
 * từng hội thoại kênh nhắn tin (chat web: #803 không xét lượt khách ⇒ đã xử lý). `now` = mốc chung cho cả hai dạng.
 */
export async function collectReadAudit(db: Db, opts: { limit: number; conversation: string | null; now?: Date; measureAttention?: boolean }): Promise<{ rows: ReadAuditRow[]; ids: string[]; hasReadsTable: boolean; attentionMeasured: boolean }> {
  const [reg] = rowsOf<{ ok: boolean }>(await db.execute(sql`select to_regclass('public.sales_chat_reads') is not null as ok`));
  const hasReadsTable = Boolean(reg?.ok);
  const [col0245] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from information_schema.columns where table_name = 'sales_chat_conversations' and column_name in ('turn_unhandled', 'last_read_at')`));
  const measureAttention = opts.measureAttention ?? (hasReadsTable && Number(col0245?.n) === 2);
  opts = { ...opts, measureAttention };
  const c = schema.salesChatConversations;
  // Cột của hội thoại trong câu con TƯƠNG QUAN phải ghi đủ tên bảng: drizzle in `${c.id}` thành `"id"` trần, và trong câu con trên
  // `sales_chat_messages m` / `sales_chat_inbound i` tên trần trỏ vào CỘT CỦA CHÍNH câu con (m.id · i.page_id) — so dòng với chính nó.
  // Bản trước (0239) dính đúng lỗi này: «tin khách mới nhất» của chat web luôn NULL, của kênh nhắn tin là max của MỌI luồng.
  const CP = sql.raw(`"sales_chat_conversations"."page_id"`);
  const CT = sql.raw(`"sales_chat_conversations"."thread_id"`);
  const CI = sql.raw(`"sales_chat_conversations"."id"`);
  const base = await db
    .select({
      id: c.id,
      channel: c.channel,
      pageId: c.pageId,
      threadId: c.threadId,
      lastCustomerAt: c.lastCustomerAt,
      lastBotAt: c.lastBotAt,
      lastStaffAt: c.lastStaffAt,
      sharedCursor: SHARED_SEEN_SQL,
      legacyUnread: HUMAN_UNREAD_SQL,
      legacyCount: HUMAN_UNREAD_COUNT_SQL,
      customerAfterShared: customerCountAfterSql(SHARED_SEEN_SQL),
      newestCustomerAt: sql<Date | null>`(case when ${CP} is not null and ${CT} is not null
        then (select max(i.created_at) from "sales_chat_inbound" i where i.page_id = ${CP} and i.thread_id = ${CT} and ${customerInboundRowSql("i")})
        else (select max(m.created_at) from "sales_chat_messages" m where m.conversation_id = ${CI} and ${customerMessageRowSql("m")}) end)`,
      unreadSql: opts.measureAttention ? INBOX_UNREAD_SQL : sql<boolean | null>`null::boolean`,
    })
    .from(c)
    .where(opts.conversation ? eq(c.id, opts.conversation) : ne(c.channel, "TEST"))
    .orderBy(desc(INBOX_ACTIVITY_SQL), desc(c.id))
    .limit(opts.conversation ? 1 : opts.limit);

  // Con trỏ RIÊNG: mỗi cặp (hội thoại, người) — số người, số còn chưa đọc, số vi phạm bất biến (đếm > 0 mà tin khách mới nhất ≤ con trỏ).
  const readers = new Map<string, { n: number; unread: number; falseUnread: number }>();
  if (hasReadsTable && base.length) {
    const ids = base.map((r) => r.id);
    const pairs = rowsOf<{ conversation_id: string; n: number | string; unread: number | string; false_unread: number | string }>(
      await db.execute(sql`select r.conversation_id, count(*)::int as n,
          count(*) filter (where ${customerCountAfterSql(sql`r.read_through_at`)} > 0)::int as unread,
          count(*) filter (where ${customerCountAfterSql(sql`r.read_through_at`)} > 0 and not exists (
            select 1 from "sales_chat_inbound" i2 where i2.page_id = "sales_chat_conversations"."page_id" and i2.thread_id = "sales_chat_conversations"."thread_id" and ${customerInboundRowSql("i2")} and i2.created_at > r.read_through_at)
            and not exists (select 1 from "sales_chat_messages" m2 where m2.conversation_id = "sales_chat_conversations"."id" and ${customerMessageRowSql("m2")} and m2.created_at > r.read_through_at))::int as false_unread
        from "sales_chat_reads" r join "sales_chat_conversations" on "sales_chat_conversations"."id" = r.conversation_id
        where r.conversation_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) group by r.conversation_id`),
    );
    for (const p of pairs) readers.set(p.conversation_id, { n: Number(p.n), unread: Number(p.unread), falseUnread: Number(p.false_unread) });
  }

  // Tin MỚI NHẤT của từng hội thoại (phía + mốc) — cùng câu DISTINCT ON với dòng xem trước của hộp thư, phía qua hàm của ứng dụng.
  const latest = new Map<string, { side: TimelineSide; at: Date }>();
  const messaging = base.filter((r) => r.pageId && r.threadId);
  const t = schema.salesChatInbound;
  for (let k = 0; k < messaging.length; k += 300) {
    const part = messaging.slice(k, k + 300);
    const rows = await db
      .selectDistinctOn([t.pageId, t.threadId], { pageId: t.pageId, threadId: t.threadId, note: t.note, messageId: t.messageId, createdAt: t.createdAt })
      .from(t)
      .where(and(or(...part.map((r) => and(eq(t.pageId, r.pageId!), eq(t.threadId, r.threadId!))!)), eq(t.kind, "INBOX")))
      .orderBy(t.pageId, t.threadId, desc(t.createdAt));
    const byKey = new Map(rows.map((l) => [`${l.pageId}|${l.threadId}`, l]));
    for (const r of part) {
      const l = byKey.get(`${r.pageId}|${r.threadId}`);
      if (l) latest.set(r.id, { side: inboundSide(l.note, l.messageId), at: l.createdAt });
    }
  }
  const web = base.filter((r) => !(r.pageId && r.threadId));
  if (web.length) {
    const m = schema.salesChatMessages;
    const rows = await db.selectDistinctOn([m.conversationId], { conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt }).from(m).where(inArray(m.conversationId, web.map((r) => r.id))).orderBy(m.conversationId, desc(m.seq));
    for (const l of rows) {
      const text = ((l.content as AiBlock[] | null) ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
      latest.set(l.conversationId, { side: webSideOf(l.role, text), at: l.createdAt });
    }
  }

  // Bản TS của #803 cho từng hội thoại kênh nhắn tin — đọc sổ độc lập với câu SQL (kiểm chéo hai dạng của MỘT định nghĩa).
  const turn = new Map<string, { handled: boolean; by: string | null }>();
  if (measureAttention) {
    for (const r of base) {
      const st = await latestTurnStateOf(r.id, opts.now ?? new Date());
      turn.set(r.id, { handled: st ? st.handled : true, by: st?.by ?? null });
    }
  }
  // Đọc lại CÙNG LÚC cho các dòng lệch: SQL trước, TS ngay sau, từng hội thoại một (khoảng cách mili giây thay vì cả trang).
  const recheck = new Map<string, { sql: boolean | null; handled: boolean }>();
  if (measureAttention) {
    for (const r of base) {
      const t0 = turn.get(r.id);
      if (!t0 || r.unreadSql === null || r.unreadSql === undefined || Boolean(r.unreadSql) === !t0.handled) continue;
      const [again] = await db.select({ u: INBOX_UNREAD_SQL }).from(c).where(eq(c.id, r.id));
      const st = await latestTurnStateOf(r.id, new Date());
      recheck.set(r.id, { sql: again ? Boolean(again.u) : null, handled: st ? st.handled : true });
    }
  }
  return {
    hasReadsTable,
    attentionMeasured: measureAttention,
    ids: base.map((r) => r.id),
    rows: base.map((r) => {
      const rd = readers.get(r.id);
      const lt = latest.get(r.id);
      return {
        channel: r.channel,
        lastCustomerAt: r.lastCustomerAt,
        lastBotAt: r.lastBotAt,
        lastStaffAt: r.lastStaffAt,
        sharedCursor: toDate(r.sharedCursor) ?? new Date(0),
        readers: rd?.n ?? 0,
        readersUnread: rd?.unread ?? 0,
        readersFalseUnread: rd?.falseUnread ?? 0,
        legacyUnread: Boolean(r.legacyUnread),
        legacyCount: Number(r.legacyCount ?? 0),
        customerAfterShared: Number(r.customerAfterShared ?? 0),
        newestCustomerAt: toDate(r.newestCustomerAt),
        latestSide: lt?.side ?? null,
        latestAt: lt?.at ?? null,
        unreadSql: r.unreadSql === null || r.unreadSql === undefined ? null : Boolean(r.unreadSql),
        turnHandled: turn.get(r.id)?.handled ?? null,
        turnBy: turn.get(r.id)?.by ?? null,
        ...(recheck.has(r.id) ? { unreadSqlRecheck: recheck.get(r.id)!.sql, turnHandledRecheck: recheck.get(r.id)!.handled } : {}),
      };
    }),
  };
}

/**
 * 0245 — «chưa đọc» LƯU SẴN (`turn_unhandled`, trigger CSDL giữ) có đúng bằng định nghĩa #803 tính TRỰC TIẾP không, đo trên MỌI hội thoại
 * (không theo --limit), kèm mốc đọc `last_read_at` so với max con trỏ. Kèm UNREAD_COUNT TRƯỚC (luật V3) / SAU (#803). Cột chưa có (chưa
 * triển khai 0245) ⇒ `hasColumn = false`.
 */
export async function measureLastInboundDrift(db: Db): Promise<{ hasColumn: boolean; conversations: number; withCustomer: number; drift: number; readDrift: number; unreadCount: number | null; v3UnreadCount: number }> {
  const [col] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from information_schema.columns where table_name = 'sales_chat_conversations' and column_name in ('turn_unhandled', 'last_read_at')`),
  );
  const [v3] = rowsOf<{ n: number }>(await db.execute(sql`select count(*) filter (where ${customerCountAfterSql(SHARED_SEEN_SQL)} > 0)::int as n from "sales_chat_conversations" where "sales_chat_conversations"."channel" <> 'TEST'`));
  if (Number(col?.n) !== 2) return { hasColumn: false, conversations: 0, withCustomer: 0, drift: 0, readDrift: 0, unreadCount: null, v3UnreadCount: Number(v3?.n ?? 0) };
  const [r] = rowsOf<{ total: number; unread: number; drift: number; read_drift: number }>(
    await db.execute(sql`select count(*)::int as total, count(*) filter (where x.live)::int as unread,
        count(*) filter (where x.cached is distinct from x.live)::int as drift, count(*) filter (where x.dcol is distinct from x.dtruth)::int as read_drift
      from (select "sales_chat_conversations"."turn_unhandled" as cached, ${latestCustomerTurnUnhandledSql()} as live, "sales_chat_conversations"."last_read_at" as dcol,
        (select max(rd.read_through_at) from "sales_chat_reads" rd where rd.conversation_id = "sales_chat_conversations"."id") as dtruth
      from "sales_chat_conversations" where "sales_chat_conversations"."channel" <> 'TEST') x`),
  );
  return {
    hasColumn: true,
    conversations: Number(r?.total ?? 0),
    withCustomer: Number(r?.unread ?? 0),
    drift: Number(r?.drift ?? 0),
    readDrift: Number(r?.read_drift ?? 0),
    unreadCount: Number(r?.unread ?? 0),
    v3UnreadCount: Number(v3?.n ?? 0),
  };
}

async function main() {
  const args = parseReadAuditArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`inbox-read-audit: DỪNG · cách dùng sai — ${args.error} (arg: <mã tổ chức> [--limit=1..${READ_AUDIT_MAX_LIMIT}] [--conversation=<mã>])`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`inbox-read-audit: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("inbox-read-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  const now = new Date();
  const { rows, ids, hasReadsTable } = await collectReadAudit(db, args);
  const tot = auditReadRows(rows);
  const li = await measureLastInboundDrift(db);

  // ── CHI TIẾT (phần MÃ HOÁ — mốc + số đếm + mã hội thoại nội bộ) ──
  console.log(`Tổ chức ${org.code} · ${rows.length} hội thoại${args.conversation ? " (chỉ định)" : ` gần nhất (trần ${args.limit})`} · lúc ${now.toISOString()} · bảng con trỏ riêng 0239 ${hasReadsTable ? "CÓ" : "CHƯA CÓ"}`);
  rows.forEach((r, i) => console.log(`${readAuditLine(i, r)} · mã ${ids[i]}`));

  // ── TÓM TẮT (số đếm, ra log công khai) ──
  tomTat(`inbox-read-audit ${org.code}: ${tot.rows} hội thoại${args.conversation ? " (chỉ định)" : ""} · bảng con trỏ riêng ${hasReadsTable ? "có" : "CHƯA có (chưa triển khai 0239)"}`);
  tomTat(`LUẬT CŨ (cột mốc + mốc chung): chưa đọc ${tot.legacy.unread} · FALSE-UNREAD ${tot.legacy.falseUnread} · xem trước AI/NV/page mà vẫn chưa đọc ${tot.legacy.aiPreviewUnread}`);
  tomTat(`LUẬT V3 (tin khách sau con trỏ, người chưa có con trỏ riêng — đã bỏ 11/10): chưa đọc ${tot.current.unread} · FALSE-UNREAD ${tot.current.falseUnread} · xem trước AI/NV/page mà vẫn chưa đọc ${tot.current.aiPreviewUnread}`);
  tomTat(`Con trỏ riêng: ${tot.readers.pairs} cặp (hội thoại, người) · còn chưa đọc ${tot.readers.unread} · FALSE-UNREAD ${tot.readers.falseUnread}`);
  const at = tot.attention;
  tomTat(`UNREAD_COUNT (mọi hội thoại): TRƯỚC (luật V3, người chưa có con trỏ riêng) ${li.v3UnreadCount} · SAU (lượt khách mới nhất chưa xử lý — #803) ${li.unreadCount ?? "chưa đo (chưa triển khai 0245)"}`);
  tomTat(
    at.measured
      ? `FALSE_UNREAD (${tot.rows} hội thoại đã đo, TS #803 làm chuẩn): TRƯỚC ${at.v3FalseUnread}/${at.v3Unread} (đã trả lời ${at.byReply} · đã đọc ${at.byRead}) · SAU lượt đầu ${at.falseUnread}/${at.unread} · bỏ sót lượt đầu ${at.missed} · ĐỌC LẠI CÙNG LÚC: còn lệch FALSE_UNREAD ${at.falseUnreadConfirmed} · bỏ sót ${at.missedConfirmed} (phải 0) · hết lệch (tin tới giữa hai lần đọc) ${at.raced}`
      : "FALSE_UNREAD: chưa đo (CSDL chưa có 0245 / bảng con trỏ đọc — cần bản triển khai có #803 + 0245)",
  );
  tomTat(
    li.hasColumn
      ? `«Chưa đọc» lưu sẵn 0245 (mọi hội thoại): ${li.conversations} hội thoại · LỆCH so với định nghĩa #803 tính trực tiếp ${li.drift} · mốc đọc lệch ${li.readDrift} (phải 0)`
      : "«Chưa đọc» lưu sẵn 0245: cột CHƯA có (chưa triển khai 0245)",
  );
  // Xả stdout RỒI mới thoát: stdout vào ống là ghi bất đồng bộ, `process.exit()` ngay sau console.log cắt mất phần còn trong bộ đệm —
  // lượt 3.000 hội thoại (12/10/2026) mất trọn khối tóm tắt ở cuối, chỉ còn mã thoát. Không bỏ `exit` được: bể kết nối CSDL giữ tiến trình sống.
  const code = at.falseUnreadConfirmed + at.missedConfirmed + li.drift + li.readDrift > 0 ? 2 : 0;
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("inbox-read-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("inbox-read-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

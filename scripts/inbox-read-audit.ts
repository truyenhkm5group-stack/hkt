/*
  ops `inbox-read-audit` — «CHƯA ĐỌC» CỦA HỘP THƯ KHÁCH CÓ BẰNG CHỨNG KHÔNG, ĐO TRÊN DỮ LIỆU THẬT CỦA MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (chủ shop 10/10/2026 tối, P0.6): danh sách «Chưa đọc» của HSLC hiện nhiều dòng «AI: …» kèm huy hiệu — trông như tin gửi ra
  là chưa đọc. Bất biến của bản sửa: hội thoại «chưa đọc» ⇒ TỒN TẠI ≥ 1 tin KHÁCH thật (không phải bot · nhân viên ERP · phía page · tin
  nhập lịch sử) mới hơn con trỏ đọc. Script đo trên N hội thoại gần nhất (hoặc MỘT hội thoại chỉ định):
   · từng dòng: last_customer_at · last_bot_at · last_staff_at · con trỏ CHUNG (`greatest(staff_seen_at, last_staff_at)`) · số người có
     con trỏ RIÊNG (`sales_chat_reads`, 0239) · số tin khách sau con trỏ chung · huy hiệu theo LUẬT CŨ (cột mốc + `max(1, …)`) · phía +
     mốc của tin xem trước theo luật cũ (tin mới nhất) và luật mới (tin khách chưa đọc khi có);
   · TỔNG: FALSE-UNREAD (huy hiệu > 0 mà không có tin khách nào sau con trỏ) và «xem trước phía AI / NV / page mà vẫn chưa đọc» — theo
     luật CŨ (đúng thứ production đang hiện trước khi triển khai) và theo luật MỚI (phải bằng 0); cặp (hội thoại, người) có con trỏ riêng.
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
import { customerCountAfterSql, HUMAN_UNREAD_COUNT_SQL, HUMAN_UNREAD_SQL, INBOX_ACTIVITY_SQL, SHARED_SEEN_SQL, customerInboundRowSql, customerMessageRowSql } from "@/lib/sales-chatbot/inbox-states";
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
};

export type ReadAuditTotals = {
  rows: number;
  legacy: { unread: number; falseUnread: number; aiPreviewUnread: number };
  current: { unread: number; falseUnread: number; aiPreviewUnread: number };
  readers: { pairs: number; unread: number; falseUnread: number };
};

/** Phía + mốc của tin xem trước theo luật MỚI (`listInbox`): chưa đọc ⇒ tin khách chưa đọc mới nhất; không ⇒ tin mới nhất. HÀM THUẦN. */
export function currentPreviewOf(r: ReadAuditRow): { side: TimelineSide | null; at: Date | null } {
  return r.customerAfterShared > 0 && r.newestCustomerAt ? { side: "CUSTOMER", at: r.newestCustomerAt } : { side: r.latestSide, at: r.latestAt };
}

/** Tổng của bất biến «chưa đọc ⇒ có tin khách sau con trỏ», luật cũ và luật mới. HÀM THUẦN. */
export function auditReadRows(rows: readonly ReadAuditRow[]): ReadAuditTotals {
  const t: ReadAuditTotals = { rows: rows.length, legacy: { unread: 0, falseUnread: 0, aiPreviewUnread: 0 }, current: { unread: 0, falseUnread: 0, aiPreviewUnread: 0 }, readers: { pairs: 0, unread: 0, falseUnread: 0 } };
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
  ].join(" · ");
}

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
};

export async function collectReadAudit(db: Db, opts: { limit: number; conversation: string | null }): Promise<{ rows: ReadAuditRow[]; ids: string[]; hasReadsTable: boolean }> {
  const [reg] = rowsOf<{ ok: boolean }>(await db.execute(sql`select to_regclass('public.sales_chat_reads') is not null as ok`));
  const hasReadsTable = Boolean(reg?.ok);
  const c = schema.salesChatConversations;
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
      newestCustomerAt: sql<Date | null>`(case when ${c.pageId} is not null and ${c.threadId} is not null
        then (select max(i.created_at) from "sales_chat_inbound" i where i.page_id = ${c.pageId} and i.thread_id = ${c.threadId} and ${customerInboundRowSql("i")})
        else (select max(m.created_at) from "sales_chat_messages" m where m.conversation_id = ${c.id} and ${customerMessageRowSql("m")}) end)`,
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

  return {
    hasReadsTable,
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
      };
    }),
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

  // ── CHI TIẾT (phần MÃ HOÁ — mốc + số đếm + mã hội thoại nội bộ) ──
  console.log(`Tổ chức ${org.code} · ${rows.length} hội thoại${args.conversation ? " (chỉ định)" : ` gần nhất (trần ${args.limit})`} · lúc ${now.toISOString()} · bảng con trỏ riêng 0239 ${hasReadsTable ? "CÓ" : "CHƯA CÓ"}`);
  rows.forEach((r, i) => console.log(`${readAuditLine(i, r)} · mã ${ids[i]}`));

  // ── TÓM TẮT (số đếm, ra log công khai) ──
  tomTat(`inbox-read-audit ${org.code}: ${tot.rows} hội thoại${args.conversation ? " (chỉ định)" : ""} · bảng con trỏ riêng ${hasReadsTable ? "có" : "CHƯA có (chưa triển khai 0239)"}`);
  tomTat(`LUẬT CŨ (cột mốc + mốc chung): chưa đọc ${tot.legacy.unread} · FALSE-UNREAD ${tot.legacy.falseUnread} · xem trước AI/NV/page mà vẫn chưa đọc ${tot.legacy.aiPreviewUnread}`);
  tomTat(`LUẬT MỚI (tin khách sau con trỏ, người chưa có con trỏ riêng): chưa đọc ${tot.current.unread} · FALSE-UNREAD ${tot.current.falseUnread} · xem trước AI/NV/page mà vẫn chưa đọc ${tot.current.aiPreviewUnread}`);
  tomTat(`Con trỏ riêng: ${tot.readers.pairs} cặp (hội thoại, người) · còn chưa đọc ${tot.readers.unread} · FALSE-UNREAD ${tot.readers.falseUnread}`);
  process.exit(tot.current.falseUnread + tot.readers.falseUnread > 0 ? 2 : 0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("inbox-read-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("inbox-read-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

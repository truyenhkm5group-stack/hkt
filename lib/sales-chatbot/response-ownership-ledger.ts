/**
 * ═══════════ SỔ LƯỢT KHÁCH CỦA MỘT HỘI THOẠI — PHẦN ĐỌC CSDL (P0 response-ownership) ═══════════
 *
 * Đọc `sales_chat_inbound` của MỘT hội thoại thành sổ thuần (`LedgerMessage[]`) cho `response-ownership.ts` quyết định. Không ghi gì.
 * Không nhập `fanpage.ts` (fanpage nhập tệp này) — chữ ghi chú dùng bản sao trong tệp thuần, bài kiểm so bằng nhau.
 *
 * Cùng tệp: câu đếm cho bảng điều khiển (`loadResponseOwnershipMetrics`) và HÀNG ĐỢI CỨU ĐƠN (`loadRescueQueue`) — đọc sổ tin thô
 * của các hội thoại có tin khách trong kỳ rồi gọi CHÍNH hàm thuần mà đường xử lý tin dùng, nên con số và quyết định không lệch nhau.
 */
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { aiHoldOf } from "@/lib/sales-chatbot/ai-hold-shared";
import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import {
  BOT_SENT_NOTE,
  CUSTOMER_TEMPLATE_MIN_THREADS,
  ownershipMetrics,
  PAGE_REPLY_NOTE,
  parseOrigin,
  rescueCandidates,
  responseOwnerState,
  senderOfRow,
  STAFF_OUT_ID_PREFIX,
  templateKeyOf,
  latestTurnHandled,
  latestWebTurnHandled,
  META_SYSTEM_TEXT_SQL_RE,
  type LatestTurnState,
  buildCustomerTurns,
  openTurnOf,
  type LedgerMessage,
  type OwnershipMetrics,
  type OwnershipThread,
  type RescueCandidate,
  type ResponseOwnerState,
} from "@/lib/sales-chatbot/response-ownership";

/** Ghi chú tin khách KHÔNG phải câu cần trả lời (nhãn dán / ghi âm) và chữ giữ chỗ ảnh phía page — bản sao chữ của fanpage.ts. */
export const LEDGER_MEDIA_ONLY_NOTE = "MEDIA_ONLY";
export const LEDGER_PAGE_IMAGE_TEXT = "[Ảnh]";
const TEMPLATE_LOOKBACK_MS = 7 * 24 * 3_600_000;
const PAGE_TEMPLATE_MIN_CHARS = 40;
/** Sổ của một hội thoại: chừng này dòng mới nhất trong 7 ngày — đủ phủ một phiên (24 giờ) và lượt mở. */
const LEDGER_ROWS = 150;

export type LedgerRow = {
  id: string;
  messageId: string;
  text: string;
  note: string | null;
  status: string;
  createdAt: Date;
  sourceAt: Date | null;
  senderKind: string | null;
  importedAt: Date | null;
  imageUrls?: unknown;
  /** Dòng `staff-out:` — trạng thái tin nhân viên gốc (`sales_chat_staff_messages.status`). Khác `SENT` ⇒ KHÔNG phải câu trả lời. */
  staffStatus?: string | null;
};

/** Mã tin nhân viên ERP trong mã dòng `staff-out:<id>:<đoạn>`. HÀM THUẦN. */
export function staffMessageIdOf(messageId: string): string | null {
  if (!messageId.startsWith(STAFF_OUT_ID_PREFIX)) return null;
  return messageId.slice(STAFF_OUT_ID_PREFIX.length).split(":")[0] || null;
}

/** Dòng sổ tin thô ⇒ dòng sổ thuần (`null` = không tham gia phép tính lượt). HÀM THUẦN. */
export function ledgerMessageOf(r: LedgerRow, flags: { customerTemplates: ReadonlySet<string>; pageTemplateIds: ReadonlySet<string> }): LedgerMessage | null {
  if (r.importedAt) return null;
  let sender = senderOfRow({ note: r.note, messageId: r.messageId, senderKind: r.senderKind, text: r.text });
  const mediaOnly = sender === "CUSTOMER" && r.note === LEDGER_MEDIA_ONLY_NOTE;
  if (sender === "CUSTOMER" && !mediaOnly) {
    const hasImage = Array.isArray(r.imageUrls) && r.imageUrls.length > 0;
    if (!r.text.trim() && !hasImage) return null;
  } else if (r.note === PAGE_REPLY_NOTE && r.messageId.startsWith(STAFF_OUT_ID_PREFIX)) {
    // Tin nhân viên gửi từ hộp thư ERP mà chưa / không tới khách (SENDING · FAILED) KHÔNG phải câu trả lời.
    if (r.staffStatus && r.staffStatus !== "SENT") return null;
  } else if (r.note === PAGE_REPLY_NOTE) {
    // Ảnh / nhãn dán phía page không chữ: ghi để người thấy, KHÔNG tính là trả lời (luật có từ 08/10/2026).
    if (r.text === LEDGER_PAGE_IMAGE_TEXT || !r.text.trim()) return null;
    if (sender === "UNKNOWN" && parseOrigin(r.senderKind) === null && flags.pageTemplateIds.has(r.messageId)) sender = "PANCAKE_AUTOMATION";
  }
  return {
    id: r.messageId,
    sender,
    text: r.text,
    arrivedAt: r.createdAt.getTime(),
    sourceAt: r.sourceAt ? r.sourceAt.getTime() : null,
    template: sender === "CUSTOMER" ? flags.customerTemplates.has(r.text) : undefined,
    ...(mediaOnly ? { mediaOnly: true } : {}),
    status: r.status,
    note: r.note,
  };
}

/**
 * Câu nào là câu MẪU (đã thấy nguyên văn ở hội thoại KHÁC của page trong 7 ngày): tin khách (câu mẫu quảng cáo — ≥ 2 hội thoại khác) và
 * tin phía page chưa phân loại (tin tự động — ≥ 1 hội thoại khác, ≥ 40 ký tự). Hai câu đọc, có trần.
 */
export async function templateTexts(pageId: string, threadId: string, customerTexts: readonly string[], pageTexts: readonly string[], now: Date): Promise<{ customerTemplates: Set<string>; pageTemplates: Set<string> }> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const since = new Date(now.getTime() - TEMPLATE_LOOKBACK_MS);
  // So theo KHOÁ câu mẫu (gộp khoảng trắng) — cùng một tin mẫu tới với xuống dòng khác nhau vẫn là một (cách audit nhận dạng).
  const custOf = new Map<string, string[]>();
  for (const x of customerTexts) {
    const k = templateKeyOf(x);
    if (k.length > 0 && k.length <= 300) custOf.set(k, [...(custOf.get(k) ?? []), x]);
  }
  const pageOf = new Map<string, string[]>();
  for (const x of pageTexts) {
    const k = templateKeyOf(x);
    if (k.length >= PAGE_TEMPLATE_MIN_CHARS) pageOf.set(k, [...(pageOf.get(k) ?? []), x]);
  }
  const custKeys = [...custOf.keys()].slice(0, 30);
  const pageKeys = [...pageOf.keys()].slice(0, 30);
  const customerTemplates = new Set<string>();
  const pageTemplates = new Set<string>();
  const key = sql<string>`btrim(regexp_replace(${t.text}, '[[:space:]]+', ' ', 'g'))`;
  if (custKeys.length) {
    const rows = await db
      .select({ k: key, n: sql<number>`count(distinct ${t.threadId})::int` })
      .from(t)
      .where(and(eq(t.pageId, pageId), ne(t.threadId, threadId), inArray(key, custKeys), gte(t.createdAt, since), isNull(t.importedAt), sql`coalesce(${t.note}, '') not in (${BOT_SENT_NOTE}, ${PAGE_REPLY_NOTE})`))
      .groupBy(key);
    for (const r of rows) if (Number(r.n) >= CUSTOMER_TEMPLATE_MIN_THREADS) for (const x of custOf.get(r.k) ?? []) customerTemplates.add(x);
  }
  if (pageKeys.length) {
    const rows = await db
      .select({ k: key })
      .from(t)
      .where(and(eq(t.pageId, pageId), ne(t.threadId, threadId), inArray(key, pageKeys), gte(t.createdAt, since), eq(t.note, PAGE_REPLY_NOTE)))
      .groupBy(key);
    for (const r of rows) for (const x of pageOf.get(r.k) ?? []) pageTemplates.add(x);
  }
  return { customerTemplates, pageTemplates };
}

/** Cửa sổ nhận dạng tin mẫu NEO THEO MỐC CỦA CHÍNH DÒNG: 168 giờ TRƯỚC mốc ghi dòng đó. */
export const ROW_TEMPLATE_WINDOW_MS = 168 * 3_600_000;

/**
 * Dòng phía page CŨ (chưa có `sender_kind`, trước 0242) nào là TIN MẪU: cùng khoá (gộp khoảng trắng, ≥ 40 ký tự) đã có ở một hội thoại
 * KHÁC của page trong 168 giờ TRƯỚC mốc của CHÍNH dòng đó — đúng điều đường nhận (`isPageTemplate`) hỏi lúc dòng tới. Kết quả TẤT ĐỊNH
 * theo dòng (không phụ thuộc «bây giờ») ⇒ lưu / cache được; bản SQL trong `latestCustomerTurnUnhandledFor`. Trả mã tin.
 */
export async function pageTemplateRowIds(pageId: string, threadId: string, rows: readonly { messageId: string; text: string; createdAt: Date }[]): Promise<Set<string>> {
  const cand = rows.map((r) => ({ ...r, k: templateKeyOf(r.text), at: r.createdAt.getTime() })).filter((r) => r.k.length >= PAGE_TEMPLATE_MIN_CHARS);
  const out = new Set<string>();
  if (!cand.length) return out;
  const db = await getDb();
  const t = schema.salesChatInbound;
  const key = sql<string>`btrim(regexp_replace(${t.text}, '[[:space:]]+', ' ', 'g'))`;
  const minAt = new Date(Math.min(...cand.map((r) => r.at)) - ROW_TEMPLATE_WINDOW_MS);
  const maxAt = new Date(Math.max(...cand.map((r) => r.at)) + 1);
  const keys = [...new Set(cand.map((r) => r.k))].slice(0, 30);
  const seen = await db
    .select({ k: key, at: sql<Date | string>`date_trunc('milliseconds', ${t.createdAt})` })
    .from(t)
    .where(and(eq(t.pageId, pageId), ne(t.threadId, threadId), eq(t.note, PAGE_REPLY_NOTE), inArray(key, keys), gte(t.createdAt, minAt), lt(t.createdAt, maxAt)))
    .limit(5_000);
  const atsOf = new Map<string, number[]>();
  for (const x of seen) atsOf.set(x.k, [...(atsOf.get(x.k) ?? []), new Date(x.at).getTime()]);
  for (const r of cand) if ((atsOf.get(r.k) ?? []).some((a) => a < r.at && a >= r.at - ROW_TEMPLATE_WINDOW_MS)) out.add(r.messageId);
  return out;
}

/** Sổ thuần của MỘT hội thoại (page, luồng) — 150 dòng mới nhất trong 7 ngày. */
export async function loadThreadLedger(pageId: string, threadId: string, now: Date = new Date()): Promise<LedgerMessage[]> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const rows: LedgerRow[] = await db
    .select({ id: t.id, messageId: t.messageId, text: t.text, note: t.note, status: t.status, createdAt: t.createdAt, sourceAt: t.sourceAt, senderKind: t.senderKind, importedAt: t.importedAt, imageUrls: t.imageUrls })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), gte(t.createdAt, new Date(now.getTime() - TEMPLATE_LOOKBACK_MS))))
    .orderBy(desc(t.createdAt))
    .limit(LEDGER_ROWS);
  return ledgerFromRows(pageId, threadId, rows, now);
}

/** Dòng đã đọc ⇒ sổ thuần (kèm hai cờ câu mẫu). Dùng chung cho đường xử lý tin và hộp thư (đã đọc sẵn dòng). */
export async function ledgerFromRows(pageId: string, threadId: string, rows: readonly LedgerRow[], now: Date): Promise<LedgerMessage[]> {
  const customerTexts = rows.filter((r) => !r.importedAt && r.note !== BOT_SENT_NOTE && r.note !== PAGE_REPLY_NOTE).slice(0, 30).map((r) => r.text);
  const legacyPage = rows.filter((r) => !r.importedAt && r.note === PAGE_REPLY_NOTE && !r.messageId.startsWith(STAFF_OUT_ID_PREFIX) && parseOrigin(r.senderKind) === null);
  const { customerTemplates } = await templateTexts(pageId, threadId, customerTexts, [], now).catch(() => ({ customerTemplates: new Set<string>() }));
  const pageTemplateIds = await pageTemplateRowIds(pageId, threadId, legacyPage).catch(() => new Set<string>());
  const flags = { customerTemplates, pageTemplateIds };
  const staffIds = [...new Set(rows.map((r) => (r.staffStatus === undefined ? staffMessageIdOf(r.messageId) : null)).filter((x): x is string => Boolean(x)))];
  const statusOf = new Map<string, string>();
  if (staffIds.length) {
    const db = await getDb();
    const sm = schema.salesChatStaffMessages;
    for (const s of await db.select({ id: sm.id, status: sm.status }).from(sm).where(inArray(sm.id, staffIds))) statusOf.set(s.id, s.status);
  }
  return rows
    .map((r) => ledgerMessageOf(r.staffStatus === undefined && staffMessageIdOf(r.messageId) ? { ...r, staffStatus: statusOf.get(staffMessageIdOf(r.messageId)!) ?? null } : r, flags))
    .filter((m): m is LedgerMessage => m !== null);
}

// ─────────────────────────── «Tin khách chưa đọc» = lượt khách mới nhất chưa xử lý ───────────────────────────

/** Sổ cho hộp thư: 200 dòng mới nhất của luồng (không giới hạn ngày — khách chờ từ tuần trước vẫn là chờ). */
const INBOX_LEDGER_ROWS = 200;
/** Câu nhân viên trong lịch sử chat web — bản sao chữ `SHOP_SAID` của engine.ts (bài kiểm so bằng nhau; tệp này không nhập engine). */
export const WEB_STAFF_PREFIX = "[Shop đã nhắn]";

/**
 * Lượt khách mới nhất của MỘT hội thoại đã được xử lý chưa — bản TS của định nghĩa (`latestTurnHandled` · `latestWebTurnHandled`). Mốc
 * «người đã mở»: lớn nhất của con trỏ đọc MỌI người dùng và mốc mở cấp cửa hàng cũ `staff_seen_at`.
 */
export async function latestTurnStateOf(conversationId: string, now: Date = new Date()): Promise<LatestTurnState | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ id: c.id, pageId: c.pageId, threadId: c.threadId, staffSeenAt: c.staffSeenAt }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv) return null;
  const r = schema.salesChatReads;
  const [read] = await db.select({ at: sql<Date | string | null>`max(${r.readThroughAt})` }).from(r).where(eq(r.conversationId, conversationId));
  const seen = [read?.at ? new Date(read.at).getTime() : null, conv.staffSeenAt ? conv.staffSeenAt.getTime() : null].filter((x): x is number => x !== null);
  const readThroughAt = seen.length ? Math.max(...seen) : null;
  if (conv.pageId && conv.threadId) {
    const t = schema.salesChatInbound;
    const rows: LedgerRow[] = await db
      .select({ id: t.id, messageId: t.messageId, text: t.text, note: t.note, status: t.status, createdAt: t.createdAt, sourceAt: t.sourceAt, senderKind: t.senderKind, importedAt: t.importedAt, imageUrls: t.imageUrls })
      .from(t)
      .where(and(eq(t.pageId, conv.pageId), eq(t.threadId, conv.threadId)))
      .orderBy(desc(t.createdAt))
      .limit(INBOX_LEDGER_ROWS);
    return latestTurnHandled(await ledgerFromRows(conv.pageId, conv.threadId, rows, now), { readThroughAt });
  }
  const m = schema.salesChatMessages;
  const msgs = await db
    .select({ seq: m.seq, role: m.role, content: m.content, createdAt: m.createdAt })
    .from(m)
    .where(eq(m.conversationId, conversationId))
    .orderBy(desc(m.seq))
    .limit(INBOX_LEDGER_ROWS);
  return latestWebTurnHandled(
    msgs.map((x) => {
      const blocks = Array.isArray(x.content) ? (x.content as { type?: unknown; text?: unknown }[]) : [];
      const text = blocks.find((b) => b?.type === "text");
      return { seq: x.seq, role: x.role === "assistant" ? "assistant" : "user", hasText: Boolean(text), at: x.createdAt.getTime(), staff: typeof text?.text === "string" && text.text.startsWith(WEB_STAFF_PREFIX) };
    }),
    { readThroughAt },
  );
}

/*
 * BẢN SQL CỦA CÙNG ĐỊNH NGHĨA (`latestTurnHandled`). Từng vế ánh xạ một-một — đổi một bên phải đổi bên kia, bài kiểm đối chiếu chạy cả
 * hai trên cùng dữ liệu:
 *  · mốc so = `date_trunc('milliseconds', …)` (TS cầm mốc ở mili giây); khoá thứ tự = (coalesce(source_at, created_at), created_at, message_id);
 *  · tin khách = dòng không nhập lịch sử, ghi chú khác BOT_SENT / PAGE_REPLY / MEDIA_ONLY, có chữ hoặc có ảnh;
 *  · bot: dòng BOT_SENT, tin khách cuối không còn PENDING, mốc gửi > mốc nhận tin khách;
 *  · nhân viên ERP: dòng staff-out mà tin nhân viên gốc (nếu tìm thấy) đã SENT; người đã xác minh phía page: cột sender_kind;
 *  · phía page khác: nguồn gốc = sender_kind; dòng cũ không cột ⇒ chữ hệ thống (META_SYSTEM_TEXT_SQL_RE) / tin mẫu (khoá gộp khoảng trắng
 *    ≥ 40 ký tự, có ở hội thoại khác trong 7 ngày) / UNKNOWN; tự động & hệ thống không bao giờ xử lý; UNKNOWN đầu phiên (±60 giây quanh tin
 *    khách mở phiên — không hoạt động nào trong 24 giờ trước) là tin chào;
 *  · «chắc chắn sau»: người xác minh không mốc nguồn ⇒ mốc tới; hai mốc nguồn ⇒ so nguồn; còn lại ⇒ tới sau ≥ 60 giây;
 *  · người đọc: max(read_through_at) mọi người dùng ≥ mốc nhận tin khách cuối.
 */
const ms = (e: SQL) => sql`date_trunc('milliseconds', ${e})`;
function rowAlias(a: string) {
  const c = (n: string) => sql.raw(`${a}."${n}"`);
  const key = ms(sql`coalesce(${c("source_at")}, ${c("created_at")})`);
  const created = ms(c("created_at"));
  const order = sql`(${key}, ${created}, ${c("message_id")})`;
  const customer = sql`(${c("imported_at")} is null and coalesce(${c("note")}, '') not in (${BOT_SENT_NOTE}, ${PAGE_REPLY_NOTE})
    and (${c("note")} = ${LEDGER_MEDIA_ONLY_NOTE} or ${c("text")} ~ '[^[:space:]]' or (jsonb_typeof(${c("image_urls")}) = 'array' and jsonb_array_length(${c("image_urls")}) > 0)))`;
  const staffOut = sql`(${c("imported_at")} is null and ${c("note")} = ${PAGE_REPLY_NOTE} and ${c("message_id")} like ${`${STAFF_OUT_ID_PREFIX}%`}
    and not exists (select 1 from "sales_chat_staff_messages" sm where sm.id = split_part(substr(${c("message_id")}, ${STAFF_OUT_ID_PREFIX.length + 1}), ':', 1) and sm.status <> 'SENT'))`;
  const pageOther = sql`(${c("imported_at")} is null and ${c("note")} = ${PAGE_REPLY_NOTE} and ${c("message_id")} not like ${`${STAFF_OUT_ID_PREFIX}%`}
    and ${c("text")} <> ${LEDGER_PAGE_IMAGE_TEXT} and ${c("text")} ~ '[^[:space:]]')`;
  const bot = sql`(${c("imported_at")} is null and ${c("note")} = ${BOT_SENT_NOTE})`;
  const tplKey = sql`btrim(regexp_replace(${c("text")}, '[[:space:]]+', ' ', 'g'))`;
  return { c, key, created, order, customer, staffOut, pageOther, bot, tplKey };
}

/**
 * «Lượt khách mới nhất của luồng (page, thread) CHƯA được xử lý» — điều kiện SQL. `convId` = mã hội thoại (con trỏ đọc). `now` = mốc của
 * cửa sổ 7 ngày nhận dạng tin mẫu (cùng `now` mà bản TS dùng).
 */
export function latestCustomerTurnUnhandledFor(pageId: SQL, threadId: SQL, seenAt: SQL): SQL<boolean> {
  const L = rowAlias("lc");
  const O = rowAlias("o");
  const S = rowAlias("s");
  const R = rowAlias("r");
  const P = rowAlias("p");
  // Tin mẫu dòng cũ: cửa sổ NEO theo mốc của chính dòng (168 giờ TRƯỚC nó) — tất định theo dòng, `pageTemplateRowIds` là bản TS.
  const legacyTemplate = sql`(char_length(${O.tplKey}) >= 40 and exists (select 1 from "sales_chat_inbound" p where p.page_id = ${O.c("page_id")} and p.thread_id <> ${O.c("thread_id")}
    and p.note = ${PAGE_REPLY_NOTE} and ${P.created} < ${O.created} and ${P.created} >= ${O.created} - interval '168 hours' and ${P.tplKey} = ${O.tplKey}))`;
  // Nguồn gốc HIỆU LỰC của dòng phía page khác (không phải staff-out).
  const origin = sql`(case when ${O.c("sender_kind")} is not null then ${O.c("sender_kind")}
    when ${O.c("text")} ~* ${META_SYSTEM_TEXT_SQL_RE} then 'META_SYSTEM'
    when ${legacyTemplate} then 'PANCAKE_AUTOMATION' else 'UNKNOWN' end)`;
  const activity = sql`(${R.customer} or ${R.bot} or ${R.staffOut} or (${R.pageOther} and ${R.c("sender_kind")} in ('VERIFIED_HUMAN', 'AI_AGENT')))`;
  const greeting = sql`exists (select 1 from "sales_chat_inbound" s where s.page_id = ${pageId} and s.thread_id = ${threadId} and ${S.customer}
    and ${O.key} between ${S.key} - interval '60 seconds' and ${S.key} + interval '60 seconds'
    and not exists (select 1 from "sales_chat_inbound" r where r.page_id = ${pageId} and r.thread_id = ${threadId} and ${activity}
      and ${R.order} < ${S.order} and ${R.key} > ${S.key} - interval '24 hours'))`;
  const generic = sql`(case when ${O.c("source_at")} is not null and ${L.c("source_at")} is not null then ${ms(O.c("source_at"))} > ${ms(L.c("source_at"))}
    else ${O.created} - ${L.created} >= interval '60 seconds' end)`;
  const verifiedAfter = sql`(case when ${O.c("source_at")} is null then ${O.created} > ${L.created} else ${generic} end)`;
  const answered = sql`exists (select 1 from "sales_chat_inbound" o where o.page_id = ${pageId} and o.thread_id = ${threadId} and ${O.order} > ${L.order} and (
      ((${O.bot} or (${O.pageOther} and ${O.c("sender_kind")} = 'AI_AGENT')) and ${L.c("status")} <> 'PENDING' and ${O.created} > ${L.created})
      or ((${O.staffOut} or (${O.pageOther} and ${O.c("sender_kind")} = 'VERIFIED_HUMAN')) and ${verifiedAfter})
      or (${O.pageOther} and ${origin} = 'OTHER_APP' and ${generic})
      or (${O.pageOther} and ${origin} = 'UNKNOWN' and ${generic} and not ${greeting})))`;
  const read = sql`coalesce(${L.created} <= ${ms(seenAt)}, false)`;
  return sql<boolean>`coalesce((select (not ${answered} and not ${read}) from (select * from "sales_chat_inbound" lc where lc.page_id = ${pageId} and lc.thread_id = ${threadId} and ${L.customer}
    order by ${L.key} desc, ${L.created} desc, lc.message_id desc limit 1) lc), false)`;
}

/** Mốc «người đã mở» của một hội thoại: con trỏ đọc lớn nhất của MỌI người dùng, hoặc mốc mở cấp cửa hàng cũ `staff_seen_at`. */
export function humanSeenAtSql(convId: SQL, staffSeenAt: SQL): SQL {
  return sql`greatest((select max(rd.read_through_at) from "sales_chat_reads" rd where rd.conversation_id = ${convId}), ${staffSeenAt})`;
}

/** Chat web: dòng `user` có khối chữ cuối cùng (theo `seq`) chưa có dòng `assistant` có khối chữ sau nó, và chưa ai mở sau nó. */
export function latestWebTurnUnhandledFor(convId: SQL, seenAt: SQL): SQL<boolean> {
  const TEXT = sql`'[{"type":"text"}]'::jsonb`;
  return sql<boolean>`coalesce((select (not exists (select 1 from "sales_chat_messages" a where a.conversation_id = ${convId} and a.role = 'assistant' and a.content @> ${TEXT} and a.seq > lu.seq)
      and not coalesce(${ms(sql`lu.created_at`)} <= ${ms(seenAt)}, false))
    from (select m.seq, m.created_at from "sales_chat_messages" m where m.conversation_id = ${convId} and m.role = 'user' and m.content @> ${TEXT} order by m.seq desc limit 1) lu), false)`;
}

/**
 * «Tin khách chưa đọc» cho câu gọi trên bảng `sales_chat_conversations` (listInbox · bộ đếm · huy hiệu): kênh nhắn tin đọc sổ tin thô,
 * chat web đọc lịch sử hội thoại — đúng phép chia của `customerExistsAfterSql` (inbox-states.ts). KHÔNG phụ thuộc «bây giờ».
 */
export function latestCustomerTurnUnhandledSql(): SQL<boolean> {
  const col = (n: string) => sql.raw(`"sales_chat_conversations"."${n}"`);
  const seen = humanSeenAtSql(col("id"), col("staff_seen_at"));
  return sql<boolean>`(case when ${col("page_id")} is not null and ${col("thread_id")} is not null
    then ${latestCustomerTurnUnhandledFor(col("page_id"), col("thread_id"), seen)}
    else ${latestWebTurnUnhandledFor(col("id"), seen)} end)`;
}

/** Hội thoại đủ trường để dựng trạng thái chủ trả lời. */
export type OwnerConvRow = { status: string; handoffReason: string | null; state: unknown; updatedAt: Date; humanCooldownUntil: Date | null };

/** Trạng thái chủ trả lời (máy trạng thái thuần) của một hội thoại đã đọc. */
export function ownerOfConversation(conv: OwnerConvRow, ledger: readonly LedgerMessage[], now: Date): ReturnType<typeof responseOwnerState> {
  const hold = aiHoldOf(conv, now);
  return responseOwnerState({ hold, conversationStatus: conv.status, handoffReason: conv.handoffReason, openTurn: openTurnOf(buildCustomerTurns(ledger)) });
}

/**
 * Lần nhường ĐANG CÓ được bật bởi một NGƯỜI ĐÃ XÁC MINH (`state.pause.origin = VERIFIED_HUMAN` với đúng mốc hết hạn đang lưu), hay
 * người bấm «Tiếp quản». Dòng nhường cũ (trước 0242, không có dấu) ⇒ KHÔNG xác minh được. HÀM THUẦN.
 */
export function pauseVerified(conv: OwnerConvRow): boolean {
  if (readConversationControl(conv.state)?.mode === "HUMAN") return true;
  const p = ((conv.state ?? {}) as { pause?: { origin?: unknown; until?: unknown } }).pause;
  if (!p || p.origin !== "VERIFIED_HUMAN") return false;
  return typeof p.until === "string" && conv.humanCooldownUntil !== null && new Date(p.until).getTime() === conv.humanCooldownUntil.getTime();
}

// ─────────────────────────── Đếm cho bảng điều khiển + hàng đợi cứu đơn ───────────────────────────

const METRIC_THREADS = 500;

async function threadsInWindow(since: Date, until: Date, now: Date): Promise<OwnershipThread[]> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const c = schema.salesChatConversations;
  // Hội thoại fanpage có ≥ 1 tin KHÁCH sống trong kỳ (mới nhất trước, trần 500).
  const threads = await db
    .select({ pageId: t.pageId, threadId: t.threadId, last: sql<Date>`max(${t.createdAt})` })
    .from(t)
    .where(and(gte(t.createdAt, since), lt(t.createdAt, until), isNull(t.importedAt), sql`coalesce(${t.note}, '') not in (${BOT_SENT_NOTE}, ${PAGE_REPLY_NOTE})`))
    .groupBy(t.pageId, t.threadId)
    .orderBy(desc(sql`max(${t.createdAt})`))
    .limit(METRIC_THREADS);
  const out: OwnershipThread[] = [];
  for (const th of threads) {
    const ledger = await loadThreadLedger(th.pageId, th.threadId, now);
    const [conv] = await db
      .select({ id: c.id, status: c.status, handoffReason: c.handoffReason, state: c.state, updatedAt: c.updatedAt, humanCooldownUntil: c.humanCooldownUntil })
      .from(c)
      .where(and(eq(c.channel, "FANPAGE"), eq(c.pageId, th.pageId), eq(c.threadId, th.threadId)))
      .limit(1);
    const owner: ResponseOwnerState = conv ? ownerOfConversation(conv, ledger, now).state : "AI_ACTIVE";
    const st = (conv?.state ?? {}) as { declined?: unknown; draft?: { total?: unknown } };
    const draftTotal = typeof st.draft?.total === "number" ? st.draft.total : null;
    out.push({ conversationId: conv?.id ?? null, ledger: ledger.filter((m) => m.arrivedAt >= since.getTime() || m.sender !== "CUSTOMER"), owner, optedOut: Boolean(st.declined), valueVnd: draftTotal });
  }
  return out;
}

/**
 * Bảng điều khiển (dùng sau ở /platform/saas — PR này KHÔNG làm giao diện): lượt khách chưa trả lời · trả lời giả · bị chặn theo lý do ·
 * tồn ở tay người · thời gian tới câu trả lời hợp lệ · mất vì bị chặn · tin phía page chưa rõ người gửi. CHỈ ĐỌC, tổ chức ngữ cảnh.
 */
export async function loadResponseOwnershipMetrics(opts: { since: Date; until?: Date; now?: Date; falseAnsweredNote: string }): Promise<OwnershipMetrics> {
  const now = opts.now ?? new Date();
  const threads = await threadsInWindow(opts.since, opts.until ?? now, now);
  return ownershipMetrics(threads, now.getTime(), { falseAnsweredNote: opts.falseAnsweredNote });
}

/** HÀNG ĐỢI CỨU ĐƠN của tổ chức ngữ cảnh (ý định mua → AI bị chặn → chưa ai trả lời). CHỈ ĐỌC. */
export async function loadRescueQueue(opts: { since: Date; now?: Date }): Promise<RescueCandidate[]> {
  const now = opts.now ?? new Date();
  return rescueCandidates(await threadsInWindow(opts.since, now, now), now.getTime());
}

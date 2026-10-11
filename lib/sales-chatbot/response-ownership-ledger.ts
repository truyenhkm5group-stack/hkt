/**
 * ═══════════ SỔ LƯỢT KHÁCH CỦA MỘT HỘI THOẠI — PHẦN ĐỌC CSDL (P0 response-ownership) ═══════════
 *
 * Đọc `sales_chat_inbound` của MỘT hội thoại thành sổ thuần (`LedgerMessage[]`) cho `response-ownership.ts` quyết định. Không ghi gì.
 * Không nhập `fanpage.ts` (fanpage nhập tệp này) — chữ ghi chú dùng bản sao trong tệp thuần, bài kiểm so bằng nhau.
 *
 * Cùng tệp: câu đếm cho bảng điều khiển (`loadResponseOwnershipMetrics`) và HÀNG ĐỢI CỨU ĐƠN (`loadRescueQueue`) — đọc sổ tin thô
 * của các hội thoại có tin khách trong kỳ rồi gọi CHÍNH hàm thuần mà đường xử lý tin dùng, nên con số và quyết định không lệch nhau.
 */
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
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
};

/** Dòng sổ tin thô ⇒ dòng sổ thuần (`null` = không tham gia phép tính lượt). HÀM THUẦN. */
export function ledgerMessageOf(r: LedgerRow, flags: { customerTemplates: ReadonlySet<string>; pageTemplates: ReadonlySet<string> }): LedgerMessage | null {
  if (r.importedAt) return null;
  let sender = senderOfRow({ note: r.note, messageId: r.messageId, senderKind: r.senderKind, text: r.text });
  if (sender === "CUSTOMER") {
    if (r.note === LEDGER_MEDIA_ONLY_NOTE) return null;
    const hasImage = Array.isArray(r.imageUrls) && r.imageUrls.length > 0;
    if (!r.text.trim() && !hasImage) return null;
  } else if (r.note === PAGE_REPLY_NOTE && !r.messageId.startsWith(STAFF_OUT_ID_PREFIX)) {
    // Ảnh / nhãn dán phía page không chữ: ghi để người thấy, KHÔNG tính là trả lời (luật có từ 08/10/2026).
    if (r.text === LEDGER_PAGE_IMAGE_TEXT || !r.text.trim()) return null;
    if (sender === "UNKNOWN" && parseOrigin(r.senderKind) === null && flags.pageTemplates.has(r.text)) sender = "PANCAKE_AUTOMATION";
  }
  return {
    id: r.messageId,
    sender,
    text: r.text,
    arrivedAt: r.createdAt.getTime(),
    sourceAt: r.sourceAt ? r.sourceAt.getTime() : null,
    template: sender === "CUSTOMER" ? flags.customerTemplates.has(r.text) : undefined,
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
  const key = sql<string>`regexp_replace(btrim(${t.text}), '[[:space:]]+', ' ', 'g')`;
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
  const pageTexts = rows.filter((r) => r.note === PAGE_REPLY_NOTE && !r.messageId.startsWith(STAFF_OUT_ID_PREFIX) && parseOrigin(r.senderKind) === null).map((r) => r.text);
  const flags = await templateTexts(pageId, threadId, customerTexts, pageTexts, now).catch(() => ({ customerTemplates: new Set<string>(), pageTemplates: new Set<string>() }));
  return rows.map((r) => ledgerMessageOf(r, flags)).filter((m): m is LedgerMessage => m !== null);
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

/**
 * ═══════════ CÙNG MỘT KHÁCH QUA HAI HỘI THOẠI — CHỈ BẰNG ĐỊNH DANH NỀN TẢNG (P0 HSLC 24/10/2026, ca «Trần Thị Ngọc») ═══════════
 *
 * Khách bình luận SĐT + địa chỉ ⇒ một hội thoại BÌNH LUẬN; nhắn Messenger ⇒ một hội thoại HỘP THƯ. Hai dòng `sales_chat_conversations`
 * không có cột nào nói chúng là một người, nên câu mẫu hỏi lại SĐT / địa chỉ và bot lên đơn thứ hai mà rào #1029 (cùng hội thoại) không
 * thấy. Đo production (ops comment-inbox-link-probe run 40079521758): `from_id` của bình luận = PSID (`sender_id`) của khách ở hộp thư, luồng
 * hộp thư Pancake = `<page_id>_<PSID>`, và tin hệ thống Meta đầu hộp thư («Bạn đang phản hồi bình luận…») mang `comment_id=` của đúng
 * bình luận ⇒ hai liên kết KIỂM CHỨNG ĐƯỢC, không cần đoán.
 *
 * MỘT hàm cho mọi chỗ cần hỏi «có phải cùng khách không» (gộp đơn pha 3 của code-erp-95 dùng đúng `sameCustomerConversations`):
 *  · VERIFIED          — có ít nhất một bằng chứng nền tảng: cùng hội thoại · cùng luồng · from_id bình luận = PSID · Meta `comment_id` ·
 *                        cùng mã khách Pancake (`fb_id`) — tất cả trên CÙNG page;
 *  · SAME_PHONE_ONLY   — chỉ trùng SĐT: người nhà dùng chung số là người KHÁC ⇒ không bao giờ gộp tự động, chỉ cờ cho người;
 *  · NONE              — kèm lý do kỹ thuật (khác page · không có định danh nền tảng · hội thoại bình luận cũ chưa có `commentOrigin` ·
 *                        định danh khác nhau · không có hội thoại).
 * KHÔNG BAO GIỜ so tên. KHÔNG nối theo `customer_id` của hội thoại: cột ấy có thể được gán theo SĐT (khách cũ nhận ra bằng số).
 */
import { and, eq, gte, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { normalizeVnPhone } from "@/lib/sales-chatbot/known-contact";

export type IdentityLevel = "VERIFIED" | "SAME_PHONE_ONLY" | "NONE";
export type IdentityEvidence =
  | { kind: "SAME_CONVERSATION" }
  | { kind: "SAME_THREAD"; pageId: string }
  | { kind: "COMMENT_FROM_ID_IS_PSID"; pageId: string }
  | { kind: "META_COMMENT_REFERENCE"; pageId: string }
  | { kind: "SAME_CUSTOMER_ID"; via: "THREAD" | "FB_ID" }
  | { kind: "SAME_PHONE" };
export type IdentityNoneReason = "DIFFERENT_PAGE" | "NO_PLATFORM_ID" | "LEGACY_NO_COMMENT_ORIGIN" | "IDS_DIFFER" | "NOT_FOUND";
export type IdentityVerdict = { level: IdentityLevel; evidence: IdentityEvidence[]; reason: IdentityNoneReason | null; detail: string };

/** Dữ kiện danh tính của MỘT hội thoại — `loadIdentityFacts` đọc từ CSDL, bài kiểm dựng tay. */
export type ConversationIdentityFacts = {
  conversationId: string;
  pageId: string | null;
  threadId: string | null;
  origin: "INBOX" | "COMMENT" | "OTHER";
  /** INBOX: PSID của khách (sender_id tin khách của luồng; thiếu ⇒ đuôi luồng `<page>_<PSID>`). */
  psid: string | null;
  /** COMMENT: from_id người bình luận (`state.commentOrigin`). Hội thoại bình luận trước 24/10/2026 ⇒ rỗng. */
  commentFromIds: string[];
  /** COMMENT: mã bình luận (đuôi luồng bình luận / mã tin bình luận) — để khớp `comment_id` của Meta. */
  commentIds: string[];
  /** INBOX: `comment_id` đọc từ tin hệ thống Meta của luồng. */
  metaCommentRefs: string[];
  /** Mã khách Pancake của luồng (`state.returning.fbIds` — `customers[].fb_id` + `from.id` tin khách; cùng page). */
  fbIds: string[];
  customerId: string | null;
  customerLinkedBy: "THREAD" | "FB_ID" | "PHONE" | null;
  /** Đã normalizeVnPhone. */
  phones: string[];
};

const inter = (a: readonly string[], b: readonly string[]) => a.some((x) => x && b.includes(x));
/** Đuôi sau dấu «_» cuối — mã bình luận trong luồng `<post>_<comment>` / mã tin `<page>_<comment>`. HÀM THUẦN. */
export const commentIdTail = (id: string) => id.slice(id.lastIndexOf("_") + 1);

/** HÀM THUẦN. Không bao giờ dùng tên. Khác page ⇒ NONE. */
export function verifiedSameCustomer(a: ConversationIdentityFacts, b: ConversationIdentityFacts): IdentityVerdict {
  if (a.conversationId === b.conversationId) return { level: "VERIFIED", evidence: [{ kind: "SAME_CONVERSATION" }], reason: null, detail: "Cùng một hội thoại" };
  if (a.pageId && b.pageId && a.pageId !== b.pageId) return { level: "NONE", evidence: [], reason: "DIFFERENT_PAGE", detail: "Hai page khác nhau — mã người dùng Facebook theo page không so được" };
  const pageId = a.pageId ?? b.pageId ?? "";
  const ev: IdentityEvidence[] = [];
  if (a.pageId && a.threadId && a.pageId === b.pageId && a.threadId === b.threadId) ev.push({ kind: "SAME_THREAD", pageId });
  const fromIsPsid = (c: ConversationIdentityFacts, i: ConversationIdentityFacts) => c.commentFromIds.length > 0 && (inter(c.commentFromIds, i.psid ? [i.psid] : []) || inter(c.commentFromIds, i.fbIds));
  if (fromIsPsid(a, b) || fromIsPsid(b, a)) ev.push({ kind: "COMMENT_FROM_ID_IS_PSID", pageId });
  const metaRef = (i: ConversationIdentityFacts, c: ConversationIdentityFacts) => i.metaCommentRefs.length > 0 && inter(i.metaCommentRefs, c.commentIds.map(commentIdTail));
  if (metaRef(a, b) || metaRef(b, a)) ev.push({ kind: "META_COMMENT_REFERENCE", pageId });
  const idsA = [...a.fbIds, ...(a.psid ? [a.psid] : [])];
  const idsB = [...b.fbIds, ...(b.psid ? [b.psid] : [])];
  if (inter(idsA, idsB)) ev.push({ kind: "SAME_CUSTOMER_ID", via: "FB_ID" });
  if (ev.length) return { level: "VERIFIED", evidence: ev, reason: null, detail: `Cùng khách theo ${ev.map((e) => e.kind).join(" · ")}` };
  if (inter(a.phones, b.phones)) return { level: "SAME_PHONE_ONLY", evidence: [{ kind: "SAME_PHONE" }], reason: null, detail: "Chỉ trùng SĐT — có thể là người khác dùng chung số; không gộp tự động" };
  const platform = (c: ConversationIdentityFacts) => Boolean(c.psid) || c.commentFromIds.length > 0 || c.fbIds.length > 0 || c.metaCommentRefs.length > 0;
  const legacy = (c: ConversationIdentityFacts) => c.origin === "COMMENT" && c.commentFromIds.length === 0;
  if (legacy(a) || legacy(b)) return { level: "NONE", evidence: [], reason: "LEGACY_NO_COMMENT_ORIGIN", detail: "Hội thoại bình luận trước 24/10/2026 chưa lưu người bình luận — không nối được" };
  if (!platform(a) || !platform(b)) return { level: "NONE", evidence: [], reason: "NO_PLATFORM_ID", detail: "Một bên không có định danh nền tảng (PSID / người bình luận / mã khách Pancake)" };
  return { level: "NONE", evidence: [], reason: "IDS_DIFFER", detail: "Định danh nền tảng khác nhau" };
}

/** Dấu người bình luận lưu vào `state.commentOrigin` lúc xử lý lượt bình luận (fanpage.ts). Có trần, không trùng. HÀM THUẦN. */
export type CommentOrigin = { postId: string | null; commentIds: string[]; fromIds: string[]; at: string };
export const COMMENT_ORIGIN_MAX = 20;
export function mergeCommentOrigin(prev: unknown, rows: readonly { messageId: string; threadId: string; fromId: string | null; postId: string | null }[], now: Date): CommentOrigin | null {
  if (!rows.length) return null;
  const p = prev && typeof prev === "object" ? (prev as Partial<CommentOrigin>) : {};
  const ids = [...(Array.isArray(p.commentIds) ? p.commentIds : []), ...rows.flatMap((r) => [r.messageId, r.threadId])].filter((x): x is string => typeof x === "string" && x.length > 0);
  const froms = [...(Array.isArray(p.fromIds) ? p.fromIds : []), ...rows.map((r) => r.fromId ?? "")].filter((x): x is string => typeof x === "string" && x.length > 0);
  return { postId: rows.find((r) => r.postId)?.postId ?? p.postId ?? null, commentIds: [...new Set(ids)].slice(-COMMENT_ORIGIN_MAX), fromIds: [...new Set(froms)].slice(-COMMENT_ORIGIN_MAX), at: now.toISOString() };
}

/** `comment_id=…` trong tin hệ thống Meta («Bạn đang phản hồi bình luận… ?comment_id=…»). HÀM THUẦN. */
export function metaCommentRefsOf(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((t) => [...t.matchAll(/[?&]comment_id=(\d+)/g)].map((m) => m[1])))];
}

const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.length > 0) : []);
const CUSTOMER_ROW = sql`coalesce(${schema.salesChatInbound.note}, '') not in ('PAGE_REPLY', 'BOT_SENT', 'MEDIA_ONLY')`;

type ConvRow = { id: string; pageId: string | null; threadId: string | null; state: Record<string, unknown>; customerId: string | null; customerPhone: string | null };

async function factsOf(row: ConvRow): Promise<ConversationIdentityFacts> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const st = row.state ?? {};
  const origin = st.commentOrigin as Partial<CommentOrigin> | undefined;
  const page = row.pageId;
  const thread = row.threadId;
  const inboxShape = Boolean(page && thread && new RegExp(`^${page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`).test(thread));
  const isComment = Boolean(origin) || Boolean(st.postContext);
  let psid: string | null = null;
  let metaRefs: string[] = [];
  if (page && thread && inboxShape) {
    const [c] = await db.select({ s: t.senderId }).from(t).where(and(eq(t.pageId, page), eq(t.threadId, thread), CUSTOMER_ROW, sql`${t.senderId} is not null`)).limit(1);
    psid = c?.s ?? thread.slice(thread.lastIndexOf("_") + 1);
    const sys = await db.select({ text: t.text }).from(t).where(and(eq(t.pageId, page), eq(t.threadId, thread), eq(t.note, "PAGE_REPLY"), sql`${t.text} like '%comment_id=%'`)).limit(20);
    metaRefs = metaCommentRefsOf(sys.map((x) => x.text));
  }
  const customer = (st.customer ?? {}) as { phone?: unknown };
  const returning = (st.returning ?? {}) as { fbIds?: unknown; phones?: unknown };
  const phones = [row.customerPhone, typeof customer.phone === "string" ? customer.phone : null, ...strs(returning.phones)].map((p) => (p ? normalizeVnPhone(p) : null)).filter((p): p is string => Boolean(p));
  return {
    conversationId: row.id,
    pageId: page,
    threadId: thread,
    origin: isComment ? "COMMENT" : inboxShape ? "INBOX" : "OTHER",
    psid,
    commentFromIds: strs(origin?.fromIds),
    commentIds: strs(origin?.commentIds),
    metaCommentRefs: metaRefs,
    fbIds: strs(returning.fbIds),
    customerId: row.customerId,
    customerLinkedBy: null,
    phones: [...new Set(phones)],
  };
}

const convCols = () => {
  const c = schema.salesChatConversations;
  return { id: c.id, pageId: c.pageId, threadId: c.threadId, state: c.state, customerId: c.customerId, customerPhone: c.customerPhone };
};

/** Bộ nạp: dữ kiện của một hội thoại (CSDL của tổ chức NGỮ CẢNH). `null` = không có hội thoại. */
export async function loadIdentityFacts(conversationId: string): Promise<ConversationIdentityFacts | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db.select(convCols()).from(c).where(eq(c.id, conversationId)).limit(1);
  return row ? factsOf({ ...row, state: (row.state ?? {}) as Record<string, unknown> }) : null;
}

export const SAME_CUSTOMER_DEFAULT_DAYS = 7;
export const SAME_CUSTOMER_MAX_DAYS = 30;
const SAME_CUSTOMER_MAX_CANDIDATES = 30;

/**
 * «Mọi hội thoại cùng danh tính của X»: cùng page, hoạt động trong `sinceDays` (mặc định 7, trần 30), mức ≥ `minLevel` (mặc định VERIFIED).
 * Không gồm X. MỌI trạng thái (OPEN · HANDOFF · người giữ) — danh tính không phụ thuộc ai đang cầm hội thoại; `status` + `heldByHuman` để
 * nơi gọi quyết. Ứng viên CHỈ tìm theo khoá xác định (luồng · PSID / from_id · mã khách Pancake · mã bình luận · SĐT cho SAME_PHONE_ONLY).
 */
export async function sameCustomerConversations(
  conversationId: string,
  opts: { sinceDays?: number; minLevel?: "VERIFIED" | "SAME_PHONE_ONLY"; now?: Date } = {},
): Promise<{ conversationId: string; verdict: IdentityVerdict; status: string; heldByHuman: boolean }[]> {
  const x = await loadIdentityFacts(conversationId);
  if (!x?.pageId) return [];
  const days = Math.min(Math.max(1, Math.floor(opts.sinceDays ?? SAME_CUSTOMER_DEFAULT_DAYS)), SAME_CUSTOMER_MAX_DAYS);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const db = await getDb();
  const c = schema.salesChatConversations;
  const ids = [...new Set([...(x.psid ? [x.psid] : []), ...x.commentFromIds, ...x.fbIds])];
  const keys: SQL[] = [];
  if (x.threadId) keys.push(eq(c.threadId, x.threadId));
  for (const id of ids.slice(0, 10)) {
    keys.push(eq(c.threadId, `${x.pageId}_${id}`));
    keys.push(sql`${c.state}->'commentOrigin'->'fromIds' ? ${id}`);
    keys.push(sql`${c.state}->'returning'->'fbIds' ? ${id}`);
  }
  for (const ref of x.metaCommentRefs.slice(0, 10)) keys.push(sql`exists (select 1 from jsonb_array_elements_text(coalesce(${c.state}->'commentOrigin'->'commentIds', '[]'::jsonb)) e(v) where e.v like ${`%${ref}`})`);
  if (x.commentIds.length) {
    const tails = [...new Set(x.commentIds.map(commentIdTail))].slice(0, 10);
    keys.push(sql`exists (select 1 from ${schema.salesChatInbound} i where i.page_id = ${c.pageId} and i.thread_id = ${c.threadId} and i.note = 'PAGE_REPLY' and (${sql.join(tails.map((tl) => sql`i.text like ${`%comment_id=${tl}%`}`), sql` or `)}))`);
  }
  if ((opts.minLevel ?? "VERIFIED") === "SAME_PHONE_ONLY" && x.phones.length) keys.push(inArray(c.customerPhone, x.phones));
  if (!keys.length) return [];
  const rows = await db
    .select({ ...convCols(), status: c.status, cooldown: c.humanCooldownUntil })
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), eq(c.pageId, x.pageId), ne(c.id, conversationId), gte(c.updatedAt, since), or(...keys)))
    .limit(SAME_CUSTOMER_MAX_CANDIDATES);
  const out: { conversationId: string; verdict: IdentityVerdict; status: string; heldByHuman: boolean }[] = [];
  for (const r of rows) {
    const verdict = verifiedSameCustomer(x, await factsOf({ ...r, state: (r.state ?? {}) as Record<string, unknown> }));
    if (verdict.level === "NONE" || (verdict.level === "SAME_PHONE_ONLY" && (opts.minLevel ?? "VERIFIED") === "VERIFIED")) continue;
    const held = readConversationControl(r.state)?.mode === "HUMAN" || Boolean(r.cooldown && r.cooldown.getTime() > now.getTime());
    out.push({ conversationId: r.id, verdict, status: String(r.status), heldByHuman: held });
  }
  return out;
}

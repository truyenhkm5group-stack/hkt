/*
  ops `comment-inbox-link-probe` — BÌNH LUẬN ĐƯỢC CHUYỂN SANG HỘP THƯ CHƯA, VÀ KHOÁ NÀO LỆCH (CHỈ ĐỌC, P0 HSLC 24/10/2026).

  Vì sao có: khách bình luận lúc 06:55Z với SĐT + địa chỉ ⇒ bot chốt đơn ở hội thoại BÌNH LUẬN; 3 phút sau khách nhắn Messenger thì một hội thoại
  MỚI mở ra, trắng ngữ cảnh, câu mẫu hỏi lại SĐT / địa chỉ và bot lên đơn thứ hai. Đo 24 giờ cả tổ chức (conv-money-trace --scan): 19 lượt chép
  đều «MOVED» (đổi `visitor_key` hội thoại bình luận sang khoá hộp thư lấy từ `private_reply_conversation` của Pancake), 0 tin được chép. MOVED
  chỉ giữ mạch khi khoá ấy TRÙNG khoá mà webhook hộp thư mang (`fanpageVisitorKey(page, thread_id)`) — script này đo đúng chỗ đó, không đoán:

   · hộp thư theo Pancake (`inboxId`) = `thread_id` của dòng dấu BOT_SENT mà `deliverCommentReply` ghi ngay sau khi nhắn riêng
     (lib/sales-chatbot/fanpage.ts) — không gọi Pancake;
   · hộp thư THẬT = luồng mà tiếng vọng của chính tin riêng ấy rơi vào (dòng PAGE_REPLY cùng page, ± 5 phút, chứa đúng chữ bot gửi);
   · `visitor_key` của hội thoại bình luận khớp khoá nào; luồng thật có hội thoại riêng không (⇒ mở MỚI, trắng ngữ cảnh);
   · danh tính: `from_id` của bình luận có trùng `sender_id` (PSID) của khách ở luồng thật không, có nằm trong `state.returning.fbIds` không.
  Ghép dòng bình luận với hội thoại bằng CHỮ + MỐC chỉ để CHẨN ĐOÁN ở đây (nhãn «ghép theo chữ») — không phải luật nghiệp vụ.

  Ba chế độ:   `<mã tổ chức> --conv=<uuid>[,<uuid>…]` (≤ 5)  ⇒ từng hội thoại: dòng, khoá, state.commentCarry, tin, đơn nối.
               `<mã tổ chức> --days=1..14`                 ⇒ mọi hội thoại có `state.commentCarry` trong kỳ: phán quyết khoá theo nhóm.
               `<mã tổ chức>|--all --legacy-keys [--days=1..60]` (P2-6, CHẠY THỬ — KHÔNG ghi, KHÔNG đổi khoá, KHÔNG gộp) ⇒ hội thoại
               bình luận đang mang khoá mã TIN «m_…» (lỗi trước bản sửa privateReplyInboxId 24/10/2026), mỗi hội thoại: luồng hộp thư
               THẬT tìm bằng CHÍNH mã tin riêng (dòng tin có `message_id` = «m_…» — tiếng vọng của tin bot vừa gửi, khoá xác định, không
               ghép theo chữ) · hộp thư ấy có hội thoại riêng không (khách đang có HAI hội thoại) · đơn còn sống. Tóm tắt công khai chỉ số
               đếm GỘP, không mã tổ chức.
  Có tên / SĐT / chữ tin ⇒ cả lượt chạy trong `ma_hoa_ket_qua`; dòng [ops:tom-tat] chỉ số đếm + cờ đúng/sai + mã hội thoại 8 ký tự.
  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên) và hỏi lại phiên.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("comment-inbox-link-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { splitSummaryLine } from "@/lib/ops/summary-lines";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { fanpageVisitorKey, normalizeEcho } from "@/lib/sales-chatbot/fanpage";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => {
  for (const line of splitSummaryLine(s)) console.log(`[ops:tom-tat] ${line}`);
};

export const LINK_MAX_CONVS = 5;
export const LINK_MAX_DAYS = 14;
/** Dòng dấu BOT_SENT ghi trong lượt nhắn riêng: trước mốc `commentCarry.at` tối đa chừng này (hai lời gọi Pancake 15 s + chép). */
export const MARKER_BEFORE_MS = 120_000;
/** Tiếng vọng của tin riêng về tới webhook hộp thư trong khoảng này quanh mốc chép (như PRIVATE_ECHO_WINDOW_MS của fanpage.ts). */
export const ECHO_WINDOW_MS = 5 * 60_000;
const PRIVATE_REPLY_THREAD = "__private_reply__";
/** Dòng của KHÁCH = không phải dòng phía page / bot / chỉ ảnh — đúng cách conv-money-trace gán nhãn «KHÁCH». */
const CUSTOMER_ROW = sql`coalesce(${schema.salesChatInbound.note}, '') not in ('PAGE_REPLY', 'BOT_SENT', 'MEDIA_ONLY')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE = "<mã tổ chức> --conv=<uuid>[,<uuid>…] | <mã tổ chức> --days=1..14 | <mã tổ chức>|--all --legacy-keys [--days=1..60]";

export const LEGACY_MAX_DAYS = 60;
export const LEGACY_DEFAULT_DAYS = 30;
export type LinkArgs = { code: string | null; all: boolean; legacy: boolean; convs: string[]; days: number | null };

export function parseLinkArgs(argv: readonly string[]): LinkArgs | { error: string } {
  const all = argv.includes("--all");
  const legacy = argv.includes("--legacy-keys");
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (all && code) return { error: "--all không đi cùng mã tổ chức" };
  if (all && !legacy) return { error: "--all chỉ dùng với --legacy-keys" };
  if (!all && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  if (legacy) {
    if (argv.some((a) => a.startsWith("--conv="))) return { error: "--legacy-keys không đi cùng --conv" };
    const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
    const d = raw === undefined ? LEGACY_DEFAULT_DAYS : Number(raw);
    if (!Number.isInteger(d) || d < 1 || d > LEGACY_MAX_DAYS) return { error: `--days (cùng --legacy-keys) phải là số nguyên 1..${LEGACY_MAX_DAYS}` };
    return { code: all ? null : code, all, legacy, convs: [], days: d };
  }
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const rawConv = val("conv");
  const convs = rawConv === undefined ? [] : rawConv.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (rawConv !== undefined && (!convs.length || convs.length > LINK_MAX_CONVS || !convs.every((x) => UUID.test(x)))) return { error: `--conv nhận 1..${LINK_MAX_CONVS} uuid, cách nhau dấu phẩy` };
  const rawDays = val("days");
  const days = rawDays === undefined ? null : Number(rawDays);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > LINK_MAX_DAYS)) return { error: `--days phải là số nguyên 1..${LINK_MAX_DAYS}` };
  if (!convs.length && days === null) return { error: "cần --conv=<uuid,…> hoặc --days=N" };
  return { code, all: false, legacy: false, convs, days };
}

/** Dáng một mã luồng để so bằng mắt mà không in mã: nhóm chữ số theo độ dài, giữ dấu phân cách («15d_16d»). HÀM THUẦN. */
export function idShape(id: string | null | undefined): string {
  if (!id) return "—";
  return id.replace(/\d+|[A-Za-z]+/g, (tok) => `${tok.length}${/\d/.test(tok[0]) ? "d" : "a"}`);
}

/** Số ký tự đầu chung của hai mã luồng. HÀM THUẦN. */
export function commonPrefix(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

const h8 = (s: string | null | undefined) => (s ? createHash("sha256").update(s).digest("hex").slice(0, 8) : "—");

/**
 * Phán quyết khoá của MỘT lượt chép bình luận. HÀM THUẦN.
 *  · NO_MARKER          — không thấy dòng dấu BOT_SENT ⇒ không biết Pancake trả hộp thư nào (lượt không nhắn riêng / dữ liệu cũ);
 *  · NO_ECHO            — có hộp thư theo Pancake, chưa thấy tiếng vọng ở luồng nào ⇒ chưa kết luận được;
 *  · SAME_THREAD        — tiếng vọng rơi đúng luồng Pancake trả ⇒ khoá khớp (MOVED giữ được mạch);
 *  · THREAD_MISMATCH    — tiếng vọng rơi vào luồng KHÁC luồng Pancake trả ⇒ khách nhắn tiếp ở luồng ERP không nối được.
 */
export type KeyVerdict = "NO_MARKER" | "NO_ECHO" | "SAME_THREAD" | "THREAD_MISMATCH";
export function keyVerdict(inboxIds: readonly string[], echoThreads: readonly string[]): KeyVerdict {
  if (!inboxIds.length) return "NO_MARKER";
  if (!echoThreads.length) return "NO_ECHO";
  return echoThreads.some((t) => inboxIds.includes(t)) ? "SAME_THREAD" : "THREAD_MISMATCH";
}

/** Chữ của một tin trong `sales_chat_messages.content` (mảng khối AI hoặc chuỗi). HÀM THUẦN. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join(" ");
}

type DbHolder = { __erpDb?: { orgs?: Map<string, { db?: Db }> } };

/** Gắn handle CHẨN ĐOÁN (chỉ đọc, không migrate) vào chỗ `getDb()` tìm handle tổ chức — như scripts/conv-money-trace.ts. */
async function bindReadOnlyOrgHandle(org: { code: string; isHome: boolean }, db: Db): Promise<void> {
  if (org.isHome) return;
  const holder = (globalThis as unknown as DbHolder).__erpDb;
  if (!holder || typeof holder !== "object") throw new Error("Không thấy sổ handle CSDL của db/index.ts — dừng.");
  const orgs = (holder.orgs ??= new Map());
  if (!(orgs instanceof Map)) throw new Error("Sổ handle CSDL tổ chức đổi cấu trúc — dừng.");
  if (!orgs.get(org.code)?.db) orgs.set(org.code, { db });
}

type ConvRow = { id: string; channel: string; status: string; visitorKey: string | null; pageId: string | null; threadId: string | null; state: Record<string, unknown>; createdAt: Date };
type Carry = { outcome: string; copied: number; at: Date };

function carryOf(state: Record<string, unknown>): Carry | null {
  const c = state.commentCarry as { outcome?: unknown; copied?: unknown; at?: unknown } | undefined;
  if (!c || typeof c !== "object" || typeof c.at !== "string") return null;
  const at = new Date(c.at);
  return Number.isNaN(at.getTime()) ? null : { outcome: String(c.outcome ?? "?"), copied: Number(c.copied ?? 0) || 0, at };
}

/** Hộp thư theo Pancake (dòng dấu) + hộp thư THẬT (tiếng vọng) của một lượt chép. */
async function carryKeys(db: Db, pageId: string, carry: Carry): Promise<{ markers: { threadId: string; text: string; at: Date }[]; echoes: { threadId: string; at: Date; senderKind: string | null }[] }> {
  const t = schema.salesChatInbound;
  const markers = (
    await db
      .select({ threadId: t.threadId, text: t.text, at: t.createdAt })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.note, "BOT_SENT"), ne(t.threadId, PRIVATE_REPLY_THREAD), gte(t.createdAt, new Date(carry.at.getTime() - MARKER_BEFORE_MS)), lte(t.createdAt, new Date(carry.at.getTime() + 5_000))))
      .orderBy(asc(t.createdAt))
      .limit(20)
  ).filter((m) => m.text.trim().length > 0);
  const texts = [...new Set(markers.map((m) => normalizeEcho(m.text)))].filter((x) => x.length >= 12);
  if (!texts.length) return { markers, echoes: [] };
  const window = await db
    .select({ threadId: t.threadId, text: t.text, at: t.createdAt, senderKind: t.senderKind })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.note, "PAGE_REPLY"), gte(t.createdAt, new Date(carry.at.getTime() - ECHO_WINDOW_MS)), lte(t.createdAt, new Date(carry.at.getTime() + ECHO_WINDOW_MS))))
    .limit(500);
  const echoes = window.filter((r) => texts.some((x) => normalizeEcho(r.text).includes(x.slice(0, 120)))).map((r) => ({ threadId: r.threadId, at: r.at, senderKind: r.senderKind }));
  return { markers, echoes };
}

async function convRows(db: Db, ids: readonly string[]): Promise<ConvRow[]> {
  const c = schema.salesChatConversations;
  const rows = await db
    .select({ id: c.id, channel: c.channel, status: c.status, visitorKey: c.visitorKey, pageId: c.pageId, threadId: c.threadId, state: c.state, createdAt: c.createdAt })
    .from(c)
    .where(inArray(c.id, [...ids]));
  return rows.map((r) => ({ ...r, channel: String(r.channel), status: String(r.status), state: (r.state ?? {}) as Record<string, unknown> }));
}

/** Hội thoại FANPAGE đang mang khoá của một luồng (`fanpageVisitorKey`). */
async function convByThread(db: Db, pageId: string, threadId: string): Promise<{ id: string; createdAt: Date } | null> {
  const c = schema.salesChatConversations;
  const [r] = await db.select({ id: c.id, createdAt: c.createdAt }).from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageVisitorKey(pageId, threadId)))).limit(1);
  return r ?? null;
}

async function traceConv(db: Db, conv: ConvRow, all: readonly ConvRow[]): Promise<void> {
  const st = conv.state;
  const carry = carryOf(st);
  const own = conv.pageId && conv.threadId ? fanpageVisitorKey(conv.pageId, conv.threadId) : null;
  const customer = (st.customer ?? {}) as { phone?: unknown; address?: unknown };
  const returning = (st.returning ?? {}) as { fbIds?: unknown };
  const fbIds = Array.isArray(returning.fbIds) ? returning.fbIds.map(String) : [];
  const post = (st.postContext ?? {}) as { postId?: unknown };
  const id8 = conv.id.slice(0, 8);
  console.log(`\n══ Hội thoại ${conv.id} · ${conv.channel} · ${conv.status} · tạo ${conv.createdAt.toISOString()}`);
  console.log(`  page ${conv.pageId ?? "—"} · thread ${conv.threadId ?? "—"} (dáng ${idShape(conv.threadId)}) · visitor_key ${conv.visitorKey ?? "—"} · khớp khoá của thread chính nó: ${own === conv.visitorKey}`);
  console.log(`  state: commentCarry ${carry ? `${carry.outcome} · chép ${carry.copied} · lúc ${carry.at.toISOString()}` : "—"} · postContext ${post.postId ? "CÓ" : "—"} · customer SĐT ${Boolean(customer.phone)} · địa chỉ ${Boolean(customer.address)} · returning.fbIds ${fbIds.length} · roundStartAt ${String(st.roundStartAt ?? "—")}`);
  const coSdt = Boolean(customer.phone);
  const coDiaChi = Boolean(customer.address);
  tomTat(`HT ${id8}: ${conv.channel} · ${conv.status} · commentCarry ${carry ? `${carry.outcome}/chép ${carry.copied}` : "—"} · visitor_key = khoá thread của chính nó ${own === conv.visitorKey} · customer SĐT ${coSdt} địa chỉ ${coDiaChi} · fbIds ${fbIds.length}`);

  // Tin phía fanpage của luồng hội thoại đang mang.
  const t = schema.salesChatInbound;
  const inbound = conv.pageId && conv.threadId ? await db.select().from(t).where(and(eq(t.pageId, conv.pageId), eq(t.threadId, conv.threadId))).orderBy(asc(t.createdAt)).limit(400) : [];
  console.log(`  — tin phía fanpage của thread (${inbound.length}):`);
  for (const r of inbound) {
    console.log(`    ${r.createdAt.toISOString()} ${r.kind} · ${r.note ?? "KHÁCH"} · ${r.status} · gửi ${r.senderKind ?? "?"}/${r.transport ?? "?"} · sender ${h8(r.senderId)} · from ${h8(r.fromId)} · post ${r.postId ? "CÓ" : "—"} · «${r.text.replace(/\s+/g, " ").slice(0, 300)}»`);
  }
  // Tin trong sổ của bot.
  const m = schema.salesChatMessages;
  const msgs = await db.select({ seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(eq(m.conversationId, conv.id)).orderBy(asc(m.seq)).limit(200);
  console.log(`  — sổ bot (${msgs.length}):`);
  for (const x of msgs) {
    const text = messageText(x.content);
    if (text) console.log(`    #${x.seq} ${x.at.toISOString()} ${x.role === "assistant" ? "BOT  " : x.role === "user" ? "KHÁCH" : x.role} «${text.replace(/\s+/g, " ").slice(0, 400)}»`);
  }
  const userTexts = new Set(msgs.filter((x) => x.role === "user").map((x) => normalizeEcho(messageText(x.content))).filter((x) => x.length > 0));

  // Đơn nối theo đúng hai phép nối của rào #1029 (conversation-order-guard.ts).
  const o = schema.orders;
  const links = [eq(o.salesConversationId, conv.id)];
  if (conv.pageId && conv.threadId) links.push(and(eq(o.pageId, conv.pageId), eq(o.conversationId, conv.threadId))!);
  const orders = await db
    .select({ id: o.id, at: o.insertedAt, stage: o.stage, salesConv: o.salesConversationId, convId: o.conversationId, total: o.totalPriceAfterDiscount, agentKey: sql<string | null>`${o.raw}->>'agentKey'` })
    .from(o)
    .where(or(...links))
    .limit(20);
  for (const x of orders) {
    console.log(`  đơn ${x.id} · ${x.at.toISOString()} · ${x.stage} · sales_conversation_id ${x.salesConv === conv.id ? "= hội thoại này" : (x.salesConv ?? "—")} · conversation_id ${x.convId === conv.threadId ? "= thread này" : (x.convId ?? "—")} · agentKey ${x.agentKey ?? "—"} · ${Number(x.total ?? 0)} ₫`);
  }
  tomTat(`HT ${id8}: đơn nối theo hai phép nối của rào #1029: ${orders.length} (theo mã hội thoại ${orders.filter((x) => x.salesConv === conv.id).length} · theo page+thread ${orders.filter((x) => x.convId === conv.threadId).length})`);

  // Dòng bình luận của hội thoại (ghép theo CHỮ + MỐC — chỉ để chẩn đoán).
  const comments = conv.pageId
    ? (
        await db
          .select({ threadId: t.threadId, fromId: t.fromId, postId: t.postId, text: t.text, at: t.createdAt, status: t.status, note: t.note })
          .from(t)
          .where(and(eq(t.pageId, conv.pageId), eq(t.kind, "COMMENT"), gte(t.createdAt, new Date(conv.createdAt.getTime() - 10 * 60_000)), lte(t.createdAt, new Date(conv.createdAt.getTime() + 10 * 60_000))))
          .limit(200)
      ).filter((r) => userTexts.has(normalizeEcho(r.text)))
    : [];
  for (const r of comments) console.log(`  bình luận (ghép theo chữ) ${r.at.toISOString()} · thread ${r.threadId} (dáng ${idShape(r.threadId)}) · from ${h8(r.fromId)} · ${r.status} · ${r.note ?? "—"}`);

  if (carry && conv.pageId) {
    const k = await carryKeys(db, conv.pageId, carry);
    const inboxIds = [...new Set(k.markers.map((x) => x.threadId))];
    const echoThreads = [...new Set(k.echoes.map((x) => x.threadId))];
    const verdict = keyVerdict(inboxIds, echoThreads);
    for (const x of inboxIds) console.log(`  hộp thư theo Pancake (dòng dấu): ${x} (dáng ${idShape(x)}) · visitor_key hội thoại = khoá này: ${conv.visitorKey === fanpageVisitorKey(conv.pageId, x)}`);
    for (const e of k.echoes) console.log(`  tiếng vọng tin riêng: ${e.at.toISOString()} · thread ${e.threadId} (dáng ${idShape(e.threadId)}) · gửi ${e.senderKind ?? "?"}`);
    // Hội thoại khác được đưa vào cùng lượt: luồng của nó có phải hộp thư Pancake trả không, visitor_key của nó có phải khoá luồng của nó không.
    for (const y of all.filter((x) => x.id !== conv.id && x.pageId === conv.pageId)) {
      const yKey = y.threadId ? fanpageVisitorKey(conv.pageId, y.threadId) : null;
      console.log(`  so với HT ${y.id}: thread của nó = hộp thư Pancake ${y.threadId ? inboxIds.includes(y.threadId) : "—"} · dáng ${idShape(y.threadId)} · chung đầu ${commonPrefix(inboxIds[0], y.threadId)} ký tự · visitor_key của nó = khoá thread của nó ${yKey === y.visitorKey} · visitor_key hội thoại bình luận = khoá thread của nó ${yKey !== null && conv.visitorKey === yKey}`);
      tomTat(`HT ${id8} ↔ ${y.id.slice(0, 8)}: thread ${y.id.slice(0, 8)} = hộp thư Pancake ${y.threadId ? inboxIds.includes(y.threadId) : "—"} · visitor_key ${id8} = khoá thread ${y.id.slice(0, 8)} ${yKey !== null && conv.visitorKey === yKey}`);
    }
    const real = echoThreads.find((x) => !inboxIds.includes(x)) ?? null;
    const realConv = real ? await convByThread(db, conv.pageId, real) : null;
    const realCustomer = real ? await db.select({ senderId: t.senderId }).from(t).where(and(eq(t.pageId, conv.pageId), eq(t.threadId, real), CUSTOMER_ROW)).limit(50) : [];
    const psids = [...new Set(realCustomer.map((x) => x.senderId).filter((x): x is string => Boolean(x)))];
    const from = [...new Set(comments.map((x) => x.fromId).filter((x): x is string => Boolean(x)))];
    const realFb = realConv ? ((all.find((x) => x.id === realConv.id)?.state.returning as { fbIds?: unknown } | undefined)?.fbIds ?? null) : null;
    console.log(
      `  PHÁN QUYẾT KHOÁ: ${verdict} · luồng thật ${real ?? "—"} (dáng ${idShape(real)}) · chung đầu với hộp thư Pancake ${commonPrefix(inboxIds[0], real)}/${real?.length ?? 0} ký tự · hội thoại trên luồng thật ${realConv ? `${realConv.id} (tạo ${realConv.createdAt.toISOString()})` : "—"} · from_id bình luận = PSID luồng thật ${from.length && psids.length ? from.some((f) => psids.includes(f)) : "chưa đo được"} · from_id ∈ fbIds hội thoại luồng thật ${Array.isArray(realFb) && from.length ? from.some((f) => (realFb as unknown[]).map(String).includes(f)) : "chưa đo được"}`,
    );
    tomTat(
      `HT ${id8}: khoá ${verdict} · dòng dấu ${inboxIds.length} · tiếng vọng ${k.echoes.length} ở ${echoThreads.length} luồng · luồng thật có hội thoại riêng ${Boolean(realConv)}${realConv ? ` (${realConv.id.slice(0, 8)})` : ""} · dáng hộp thư Pancake ${idShape(inboxIds[0])} vs luồng thật ${idShape(real)} · from_id = PSID ${from.length && psids.length ? from.some((f) => psids.includes(f)) : "chưa đo được"}`,
    );
  }
}

async function scanCarries(db: Db, days: number): Promise<void> {
  const since = new Date(Date.now() - days * 86_400_000);
  const c = schema.salesChatConversations;
  const rows = await db
    .select({ id: c.id, pageId: c.pageId, visitorKey: c.visitorKey, state: c.state, createdAt: c.createdAt })
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), sql`${c.state} ? 'commentCarry'`, sql`(${c.state}->'commentCarry'->>'at')::timestamptz >= ${since}`))
    .limit(2000);
  const tally = new Map<string, number>();
  let realOwnConv = 0;
  let shapeDiff = 0;
  for (const r of rows) {
    const carry = carryOf((r.state ?? {}) as Record<string, unknown>);
    if (!carry || !r.pageId) continue;
    const k = await carryKeys(db, r.pageId, carry);
    const inboxIds = [...new Set(k.markers.map((x) => x.threadId))];
    const echoThreads = [...new Set(k.echoes.map((x) => x.threadId))];
    const v = keyVerdict(inboxIds, echoThreads);
    const key = `${carry.outcome}→${v}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    const real = echoThreads.find((x) => !inboxIds.includes(x)) ?? null;
    if (real) {
      const rc = await convByThread(db, r.pageId, real);
      if (rc && rc.id !== r.id) realOwnConv += 1;
      if (idShape(real) !== idShape(inboxIds[0])) shapeDiff += 1;
    }
    console.log(`  ${r.id} · ${carry.at.toISOString()} · ${carry.outcome} · chép ${carry.copied} · ${v} · hộp thư Pancake ${inboxIds.join(",") || "—"} · luồng thật ${real ?? "—"}`);
  }
  tomTat(`quét ${days} ngày: ${rows.length} hội thoại có commentCarry · ${[...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}`);
  tomTat(`quét: luồng thật ≠ hộp thư Pancake mà luồng thật có hội thoại RIÊNG (mở mới, trắng ngữ cảnh) ${realOwnConv} · khác DÁNG mã ${shapeDiff}`);
}

/**
 * Phán quyết của MỘT hội thoại mang khoá «m_…» (P2-6, chạy thử). HÀM THUẦN.
 *  · TWO_CONVERSATIONS     — tin riêng rơi vào luồng hộp thư thật VÀ luồng ấy có hội thoại riêng ⇒ khách đang có hai hội thoại (ca Ngọc);
 *  · INBOX_NO_CONVERSATION — tìm được luồng hộp thư thật, chưa có hội thoại nào trên đó (khách chưa nhắn tiếp);
 *  · ECHO_NOT_FOUND        — không có dòng tin nào mang đúng mã tin ấy ⇒ không xác định được luồng thật (KHÔNG đoán).
 */
export type LegacyVerdict = "TWO_CONVERSATIONS" | "INBOX_NO_CONVERSATION" | "ECHO_NOT_FOUND";
export function legacyVerdict(realThread: string | null, realConversationId: string | null): LegacyVerdict {
  if (!realThread) return "ECHO_NOT_FOUND";
  return realConversationId ? "TWO_CONVERSATIONS" : "INBOX_NO_CONVERSATION";
}

export type LegacyTally = { conversations: number; openOrders: number; byVerdict: Record<LegacyVerdict, number>; twoWithOpenOrders: number };
export const emptyLegacyTally = (): LegacyTally => ({ conversations: 0, openOrders: 0, byVerdict: { TWO_CONVERSATIONS: 0, INBOX_NO_CONVERSATION: 0, ECHO_NOT_FOUND: 0 }, twoWithOpenOrders: 0 });

/** Hội thoại bình luận mang khoá mã tin «m_…» của MỘT tổ chức (CSDL ngữ cảnh). CHỈ ĐỌC. */
async function legacyKeys(db: Db, days: number): Promise<LegacyTally> {
  const since = new Date(Date.now() - days * 86_400_000);
  const c = schema.salesChatConversations;
  const t = schema.salesChatInbound;
  const o = schema.orders;
  const rows = await db
    .select({ id: c.id, pageId: c.pageId, threadId: c.threadId, visitorKey: c.visitorKey, status: c.status, createdAt: c.createdAt })
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), sql`left(${c.threadId}, 2) = 'm_'`, gte(c.createdAt, since)))
    .limit(5000);
  const tally = emptyLegacyTally();
  for (const r of rows) {
    if (!r.pageId || !r.threadId) continue;
    // Tiếng vọng của chính tin riêng bot vừa gửi: dòng tin có message_id = mã tin ⇒ luồng hộp thư THẬT (khoá xác định).
    // KHÔNG tính dòng DẤU nội bộ ở luồng `__private_reply__` (deliverCommentReply ghi nó với CHÍNH mã tin riêng — đo lượt 40090214039:
    // 691/692 «luồng thật» là luồng dấu ấy). `message_id` là UNIQUE nên tiếng vọng thật thường không lưu được cùng mã ⇒ ECHO_NOT_FOUND là
    // câu trả lời trung thực, không đoán.
    const [echo] = await db
      .select({ threadId: t.threadId })
      .from(t)
      .where(and(eq(t.pageId, r.pageId), eq(t.messageId, r.threadId), ne(t.threadId, r.threadId), ne(t.threadId, PRIVATE_REPLY_THREAD)))
      .limit(1);
    const real = echo?.threadId ?? null;
    const realConv = real ? await convByThread(db, r.pageId, real) : null;
    const v = legacyVerdict(real, realConv?.id ?? null);
    const live = await db.select({ id: o.id }).from(o).where(and(eq(o.salesConversationId, r.id), sql`${o.stage}::text not in ('CANCELLED', 'DELETED')`)).limit(5);
    tally.conversations += 1;
    tally.byVerdict[v] += 1;
    tally.openOrders += live.length;
    if (v === "TWO_CONVERSATIONS" && live.length) tally.twoWithOpenOrders += 1;
    console.log(`  ${r.id} · tạo ${r.createdAt.toISOString()} · ${String(r.status)} · khoá = luồng «m_…» ${r.visitorKey === fanpageVisitorKey(r.pageId, r.threadId)} · ${v} · luồng thật ${real ?? "—"} (dáng ${idShape(real)}) · hội thoại hộp thư ${realConv?.id ?? "—"} · đơn còn sống ${live.length}`);
  }
  return tally;
}

const legacyLine = (t: LegacyTally) =>
  `${t.conversations} hội thoại mang khoá mã tin «m_…» · khách đang có HAI hội thoại ${t.byVerdict.TWO_CONVERSATIONS} (trong đó còn đơn sống ${t.twoWithOpenOrders}) · có luồng hộp thư, chưa có hội thoại ${t.byVerdict.INBOX_NO_CONVERSATION} · không xác định được luồng thật ${t.byVerdict.ECHO_NOT_FOUND} · đơn còn sống ${t.openOrders}`;

/** Mở CSDL tổ chức ở chế độ CHẨN ĐOÁN, hỏi lại phiên chỉ đọc, gắn handle, chạy `fn` trong ngữ cảnh tổ chức. */
async function inOrg<T>(org: { code: string; isHome: boolean }, fn: (db: Db) => Promise<T>): Promise<T | "NOT_READ_ONLY"> {
  const db: Db = await getDbForInspection(org);
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") return "NOT_READ_ONLY";
  await bindReadOnlyOrgHandle(org, db);
  return withOrganization(org.code, () => fn(db));
}

async function main() {
  const args = parseLinkArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`comment-inbox-link-probe: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.stdout.write("", () => process.exit(2));
    return;
  }
  if (args.legacy) {
    const days = args.days ?? LEGACY_DEFAULT_DAYS;
    const orgs = args.all ? (await listOrganizations()).filter((x) => x.status === "ACTIVE") : [await findOrganization(args.code ?? "")].filter((x): x is NonNullable<typeof x> => Boolean(x));
    if (!orgs.length) {
      tomTat("comment-inbox-link-probe: DỪNG · không có tổ chức nào để đọc");
      process.stdout.write("", () => process.exit(1));
      return;
    }
    const total = emptyLegacyTally();
    let unreadable = 0;
    for (const org of orgs) {
      console.log(`\n══ ${org.code} · khoá «m_…» ${days} ngày (CHẠY THỬ — không ghi)`);
      const r = await inOrg({ code: org.code, isHome: org.isHome }, (db) => legacyKeys(db, days)).catch((e: unknown) => {
        console.log(`  không đọc được: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
        return null;
      });
      if (r === null || r === "NOT_READ_ONLY") {
        unreadable += 1;
        continue;
      }
      console.log(`  ${legacyLine(r)}`);
      total.conversations += r.conversations;
      total.openOrders += r.openOrders;
      total.twoWithOpenOrders += r.twoWithOpenOrders;
      for (const k of Object.keys(total.byVerdict) as LegacyVerdict[]) total.byVerdict[k] += r.byVerdict[k];
    }
    tomTat(`legacy-keys ${days} ngày (CHẠY THỬ): ${orgs.length} tổ chức · ${unreadable} không đọc được · ${legacyLine(total)}`);
    process.stdout.write("", () => process.exit(unreadable ? 1 : 0));
    return;
  }
  const org = await findOrganization(args.code ?? "");
  if (!org) {
    tomTat(`comment-inbox-link-probe: DỪNG · không có tổ chức «${args.code}»`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("comment-inbox-link-probe: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.stdout.write("", () => process.exit(70));
    return;
  }
  await bindReadOnlyOrgHandle({ code: org.code, isHome: org.isHome }, db);
  await withOrganization(org.code, async () => {
    if (args.convs.length) {
      const rows = await convRows(db, args.convs);
      tomTat(`comment-inbox-link-probe ${org.code}: ${rows.length}/${args.convs.length} hội thoại tìm thấy`);
      for (const r of rows) await traceConv(db, r, rows);
    }
    if (args.days !== null) await scanCarries(db, args.days);
  });
  process.stdout.write("", () => process.exit(0));
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e: unknown) => {
    console.error("comment-inbox-link-probe hỏng:", e instanceof Error ? e.message.slice(0, 300) : e);
    tomTat("comment-inbox-link-probe: LỖI — chi tiết trong phần mã hoá");
    process.stdout.write("", () => process.exit(1));
  });
}

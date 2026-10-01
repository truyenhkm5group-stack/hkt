/**
 * ═══════════ CHATBOT BÁN HÀNG TRẢ LỜI TIN NHẮN FANPAGE (qua Pancake) — CHỈ MÁY CHỦ (0182) ═══════════
 *
 * Bot fanpage của tổ chức nhà là một container riêng gắn cứng một tổ chức (biến môi trường, tệp JSON, khoá AI của máy
 * chủ). Tổ chức khách dùng lại ĐÚNG bộ máy chatbot bán hàng của mình (`chatTurn`, kênh `FANPAGE`): giá / tồn đọc từ ERP,
 * khoá AI của chính shop, đơn ghi vào ERP, chuyển nhân viên — chỉ khác lối vào (webhook Pancake) và lối ra (reply_inbox).
 *
 * LUỒNG: webhook `/api/webhooks/pancake/fanpage/<token>` (token ⇒ tổ chức, `lib/platform/webhooks.ts`) ⇒ `receiveFanpageEvent`
 * ghi tin vào `sales_chat_inbound` (UNIQUE mã tin ⇒ gửi trùng vô hại) và trả 200 ngay ⇒ sau phản hồi `processFanpageThread`
 * đợi `REPLY_GRACE_MS` (tin MỚI NHẤT của khách đủ 30 giây), GIÀNH mọi tin chờ của hội thoại (một lượt duy nhất), gọi
 * `chatTurn`, gửi các câu trả lời mới qua Pancake. Chỉ tin nhắn INBOX — bình luận không trả lời tự động.
 *
 * BOT LÀ LƯỚI ĐỠ, KHÔNG CHEN NGANG (chủ nền tảng 01/10/2026: shop đã cài câu trả lời tự động trên Meta cho câu hỏi đầu
 * tiên): MỌI tin phía page — trả lời tự động của Meta hay của nhân viên — được ghi lại (`PAGE_REPLY`); tin khách nào đã
 * có tin phía page tới SAU nó thì bot bỏ qua. Tin do NHÂN VIÊN THẬT (có `uid` / `admin_id`, không phải tin bot vừa gửi)
 * còn làm bot nhường cả hội thoại `HUMAN_TAKEOVER_MINUTES` phút.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { messagingConnectionSummaries, openActiveConnection } from "@/lib/connectors/service";
import { env } from "@/lib/env";
import { webhookUrlToken } from "@/lib/platform/webhooks";
import { describeNetworkFailure, isNetworkFailure } from "@/lib/connectors/net-error";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { chunkText } from "@/lib/messaging/providers";
import { chatTurn, conversationView, openConversation } from "@/lib/sales-chatbot/engine";

export const FANPAGE_CONNECTOR = "pancake-fanpage";
/** Nhân viên thật vừa trả lời trên fanpage ⇒ bot im lặng chừng này phút cho hội thoại đó. */
export const HUMAN_TAKEOVER_MINUTES = 30;
/** Hội thoại đã chuyển nhân viên mà im lặng quá chừng này giờ ⇒ bot nhận lại khi khách nhắn tiếp. */
export const HANDOFF_EXPIRE_HOURS = 12;
/**
 * Bot chỉ trả lời tin khách đã chờ ĐỦ chừng này mà page chưa trả lời (tự động của Meta / nhân viên). Cũng là khoảng gom
 * tin: khách gõ liên tiếp thì đợi tin MỚI NHẤT đủ 30 giây rồi trả lời một lượt.
 */
export const REPLY_GRACE_MS = 30_000;
/** Đệm lệch đồng hồ giữa máy ứng dụng và CSDL — lượt chờ ngủ thêm chừng này để tới lúc tỉnh tin chắc chắn đã đủ tuổi. */
const GRACE_SLACK_MS = 2_000;
const RETRY_MS = 3_000;
/** Dòng ghi tin phía page (Meta tự động / nhân viên) — chỉ để biết «đã có người trả lời», không phải tin chờ bot. */
const PAGE_REPLY = "PAGE_REPLY";
const WAITING = "Chờ đủ 30 giây xem page có trả lời không";
const PAGE_REPLIED_REASON = "Page đã trả lời trong 30 giây (tự động của Meta / nhân viên) — bot không chen";
const CLAIM_STALE_MS = 3 * 60_000;
const TEXT_MAX = 2000;
const STAFF_REASON = "Nhân viên đang trả lời trên fanpage";

export type FanpageEvent = {
  pageId: string;
  threadId: string;
  messageId: string;
  text: string;
  customerName: string;
  fromPage: boolean;
  /** Tin của NGƯỜI THẬT bên page (có uid / admin_id) — chưa loại tin bot vừa gửi (việc của `receiveFanpageEvent`). */
  humanStaff: boolean;
  inbox: boolean;
};

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Gói webhook Pancake (event_type = messaging) ⇒ sự kiện, hoặc `null` (không phải tin nhắn / thiếu mã). HÀM THUẦN. */
export function parsePancakeWebhook(payload: unknown): FanpageEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { event_type?: unknown; page_id?: unknown; data?: { message?: Record<string, unknown>; conversation?: Record<string, unknown> } };
  if (p.event_type !== "messaging") return null;
  const msg = p.data?.message;
  const conv = p.data?.conversation;
  const pageId = str(p.page_id);
  const messageId = str(msg?.id);
  const threadId = str(conv?.id);
  if (!pageId || !messageId || !threadId || msg?.is_removed === true) return null;
  const from = (msg?.from ?? {}) as { id?: unknown; name?: unknown; uid?: unknown; admin_id?: unknown; ai_generated?: unknown; is_automated?: unknown };
  const fromPage = str(from.id) === pageId || Boolean(from.admin_id) || Boolean(from.uid);
  const humanStaff = fromPage && Boolean(from.uid || from.admin_id) && !from.ai_generated && !from.is_automated;
  const type = str(msg?.type || conv?.type || "INBOX").toUpperCase();
  const text = stripHtml(str(msg?.original_message) || str(msg?.message)).slice(0, TEXT_MAX);
  const customerName = str(from.name) || str((conv?.from as { name?: unknown } | undefined)?.name);
  return { pageId, threadId, messageId, text, customerName: fromPage ? "" : customerName, fromPage, humanStaff, inbox: type === "INBOX" };
}

/** Khoá hội thoại fanpage (cột `visitor_key`, UNIQUE cho kênh FANPAGE): băm (page, hội thoại Pancake). */
export function fanpageVisitorKey(pageId: string, threadId: string): string {
  return createHash("sha256").update(`fanpage:${pageId}:${threadId}`).digest("hex");
}

export type ReceiveResult = { queued: boolean; reason: string };

/** Ghi MỘT sự kiện fanpage của tổ chức ngữ cảnh. Không gọi AI, không gọi Pancake — webhook trả 200 ngay sau đây. */
export async function receiveFanpageEvent(ev: FanpageEvent, now: Date = new Date()): Promise<ReceiveResult> {
  const conn = await openActiveConnection(FANPAGE_CONNECTOR);
  if (!conn.ok) return { queued: false, reason: "Kết nối fanpage chưa bật" };
  if ((conn.settings.pageId ?? "").trim() !== ev.pageId) return { queued: false, reason: "Tin của page khác page đã khai" };
  const db = await getDb();
  const t = schema.salesChatInbound;
  if (ev.fromPage) {
    if (!ev.inbox) return { queued: false, reason: "Tin của page trên bình luận" };
    // Tin bot vừa gửi được ghi sẵn với ĐÚNG mã tin ⇒ gặp lại là tin của bot — không phải nhân viên, không phải «page đã trả lời».
    const [own] = await db.select({ id: t.id }).from(t).where(eq(t.messageId, ev.messageId)).limit(1);
    if (own) return { queued: false, reason: "Tin của chính bot" };
    // Mọi tin khác phía page = page ĐÃ trả lời ⇒ tin khách đang chờ trước nó không cần bot nữa.
    await db
      .insert(t)
      .values({ pageId: ev.pageId, threadId: ev.threadId, messageId: ev.messageId, text: ev.text, status: "DONE", processedAt: now, note: PAGE_REPLY })
      .onConflictDoNothing({ target: t.messageId });
    if (!ev.humanStaff) return { queued: false, reason: "Trả lời tự động của page — bot không chen" };
    const c = schema.salesChatConversations;
    await db
      .update(c)
      .set({ status: "HANDOFF", handoffReason: STAFF_REASON, updatedAt: now })
      .where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageVisitorKey(ev.pageId, ev.threadId))));
    return { queued: false, reason: "Nhân viên đang trả lời — bot nhường" };
  }
  if (!ev.inbox) return { queued: false, reason: "Bình luận — không trả lời tự động" };
  if (!ev.text) return { queued: false, reason: "Tin không có chữ (ảnh / nhãn dán) — để nhân viên xem" };
  const rows = await db
    .insert(t)
    .values({ pageId: ev.pageId, threadId: ev.threadId, messageId: ev.messageId, text: ev.text, customerName: ev.customerName || null })
    .onConflictDoNothing({ target: t.messageId })
    .returning({ id: t.id });
  return rows.length ? { queued: true, reason: "Đã nhận" } : { queued: false, reason: "Tin trùng — đã nhận trước đó" };
}

export type FanpageDeps = { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> };

async function sendInbox(pageId: string, threadId: string, token: string, text: string, fetchImpl: typeof fetch): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const ids: string[] = [];
  const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(threadId)}/messages?page_access_token=${encodeURIComponent(token)}`;
  try {
    for (const part of chunkText(text, TEXT_MAX)) {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reply_inbox", message: part }), redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => null)) as { success?: boolean; id?: unknown; message?: unknown } | null;
      if (!res.ok || body?.success === false) return { ok: false, error: scrubSecrets(`Pancake không nhận tin: ${str(body?.message) || `HTTP ${res.status}`}`, [token]) };
      if (str(body?.id)) ids.push(str(body?.id));
    }
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, error: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Pancake: ${describeNetworkFailure(e, "pages.fm")}` : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`, [token]) };
  }
}

async function conversationFor(pageId: string, threadId: string): Promise<{ id: string; status: string; handoffReason: string | null; updatedAt: Date } | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const key = fanpageVisitorKey(pageId, threadId);
  const find = async () => (await db.select({ id: c.id, status: c.status, handoffReason: c.handoffReason, updatedAt: c.updatedAt }).from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, key))).limit(1))[0] ?? null;
  const existing = await find();
  if (existing) return existing;
  try {
    await openConversation("FANPAGE", { visitorKey: key });
  } catch {
    // Hai lượt cùng mở ⇒ chỉ số UNIQUE giữ đúng một hội thoại; đọc lại hội thoại của lượt thắng.
  }
  return find();
}

export type ProcessResult = { processed: number; replies: number; skipped: string | null; error: string | null };

/**
 * Một lượt xử lý cho MỘT hội thoại fanpage của tổ chức ngữ cảnh: giành mọi tin chờ ⇒ một lượt `chatTurn` ⇒ gửi câu trả lời
 * mới. Lặp lại (tối đa 3) nếu khách nhắn thêm trong lúc bot đang trả lời. Không ném — lỗi vào `note` của tin.
 */
export async function processFanpageThread(pageId: string, threadId: string, deps: FanpageDeps = {}): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date());
  const out: ProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  const conn = await openActiveConnection(FANPAGE_CONNECTOR);
  if (!conn.ok || (conn.settings.pageId ?? "").trim() !== pageId) return { ...out, skipped: "Kết nối fanpage chưa bật / khác page" };
  const token = (conn.secrets.pageAccessToken ?? "").trim();
  const db = await getDb();
  const t = schema.salesChatInbound;
  for (let round = 0; round < 3; round++) {
    // Tin chờ MỚI NHẤT chưa đủ 30 giây ⇒ chưa tới lượt: lượt chờ của chính tin đó sẽ gom cả hội thoại.
    const [newest] = await db
      .select({ at: sql<Date | string | null>`max(${t.createdAt})` })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), eq(t.status, "PENDING")));
    if (newest?.at && new Date(newest.at).getTime() > now().getTime() - REPLY_GRACE_MS) return { ...out, skipped: WAITING };
    const claim = randomUUID();
    const staleBefore = new Date(now().getTime() - CLAIM_STALE_MS);
    const claimed = await db
      .update(t)
      .set({ claimId: claim, claimedAt: now() })
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), eq(t.status, "PENDING"), or(isNull(t.claimId), lt(t.claimedAt, staleBefore))))
      .returning({ id: t.id, text: t.text, createdAt: t.createdAt });
    if (!claimed.length) break;
    const ids = claimed.map((r) => r.id);
    const finish = (status: "DONE" | "SKIPPED" | "PENDING", note: string | null) =>
      db
        .update(t)
        .set(status === "PENDING" ? { claimId: null, claimedAt: null, note } : { status, processedAt: now(), note })
        .where(and(inArray(t.id, ids), eq(t.claimId, claim)));
    // Page đã trả lời (Meta tự động / nhân viên) SAU tin khách sớm nhất của lượt ⇒ bot không chen.
    const earliest = new Date(Math.min(...claimed.map((r) => r.createdAt.getTime())));
    const [pageReplied] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), eq(t.note, PAGE_REPLY), gte(t.createdAt, earliest)))
      .limit(1);
    if (pageReplied) {
      await finish("SKIPPED", PAGE_REPLIED_REASON);
      out.processed += ids.length;
      out.skipped = PAGE_REPLIED_REASON;
      continue;
    }
    const conv = await conversationFor(pageId, threadId);
    if (!conv) {
      await finish("PENDING", "Không mở được hội thoại");
      return { ...out, error: "Không mở được hội thoại" };
    }
    if (conv.status === "HANDOFF") {
      const ageMs = now().getTime() - conv.updatedAt.getTime();
      const expire = conv.handoffReason === STAFF_REASON ? HUMAN_TAKEOVER_MINUTES * 60_000 : HANDOFF_EXPIRE_HOURS * 3_600_000;
      if (ageMs < expire) {
        await finish("SKIPPED", conv.handoffReason ?? "Đã chuyển nhân viên");
        out.processed += ids.length;
        out.skipped = conv.handoffReason ?? "Đã chuyển nhân viên";
        continue;
      }
      await db.update(schema.salesChatConversations).set({ status: "OPEN", handoffReason: null, updatedAt: now() }).where(eq(schema.salesChatConversations.id, conv.id));
    }
    const before = (await conversationView(conv.id))?.messages.length ?? 0;
    const text = claimed
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => r.text)
      .join("\n")
      .slice(0, TEXT_MAX);
    const turn = await chatTurn(conv.id, text, { channel: "FANPAGE", visitorKey: fanpageVisitorKey(pageId, threadId), now: now() });
    if (!turn.ok) {
      // Lượt khác đang trả lời cùng hội thoại ⇒ nhả tin để lượt sau gom; lý do khác (bot tắt…) ⇒ bỏ qua có ghi chú.
      const busy = /Đang trả lời câu trước/.test(turn.error);
      await finish(busy ? "PENDING" : "SKIPPED", turn.error.slice(0, 300));
      if (busy) return { ...out, skipped: "Hội thoại đang được trả lời" };
      out.processed += ids.length;
      out.skipped = turn.error;
      continue;
    }
    const replies = turn.view.messages.slice(before).filter((m) => m.role === "assistant" && m.text.trim());
    let sendError: string | null = null;
    for (const r of replies) {
      const sent = await sendInbox(pageId, threadId, token, r.text, deps.fetch ?? fetch);
      if (!sent.ok) {
        sendError = sent.error;
        break;
      }
      out.replies += 1;
      // Ghi mã tin bot vừa gửi: Pancake đẩy lại chính tin này qua webhook — gặp lại là tin của bot, không phải nhân viên.
      if (sent.ids.length) {
        await db
          .insert(t)
          .values(sent.ids.map((id) => ({ pageId, threadId, messageId: id, text: r.text.slice(0, TEXT_MAX), status: "DONE", processedAt: now(), note: "BOT_SENT" })))
          .onConflictDoNothing({ target: t.messageId });
      }
    }
    await finish("DONE", sendError);
    out.processed += ids.length;
    if (sendError) {
      out.error = sendError;
      break;
    }
  }
  return out;
}

/** Sau phản hồi webhook: đợi 30 giây xem page có trả lời không rồi xử lý; hội thoại bận / chưa đủ tuổi thì thử lại vài lần. */
export async function processFanpageThreadDebounced(pageId: string, threadId: string, deps: FanpageDeps = {}): Promise<ProcessResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(REPLY_GRACE_MS + GRACE_SLACK_MS);
  let last: ProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  for (let i = 0; i < 4; i++) {
    last = await processFanpageThread(pageId, threadId, deps);
    if (last.skipped !== "Hội thoại đang được trả lời" && last.skipped !== WAITING) break;
    await sleep(RETRY_MS);
  }
  return last;
}

/** Tin chờ quá lâu (lượt sau phản hồi bị mất vì máy khởi động lại…) của tổ chức ngữ cảnh — gọi kèm mỗi webhook mới. */
export async function sweepStaleFanpageThreads(deps: FanpageDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  const stale = await db
    .selectDistinct({ pageId: t.pageId, threadId: t.threadId })
    .from(t)
    .where(and(eq(t.status, "PENDING"), lt(t.createdAt, new Date(now().getTime() - 60_000)), or(isNull(t.claimId), lt(t.claimedAt, new Date(now().getTime() - CLAIM_STALE_MS)))))
    .orderBy(asc(t.pageId))
    .limit(5);
  for (const s of stale) await processFanpageThread(s.pageId, s.threadId, deps);
  return stale.length;
}

export type FanpageInboundCounts = { pending: number; done: number; skipped: number; skippedReasons: { reason: string; count: number }[] };

/**
 * Số tin fanpage theo trạng thái + ba LÝ DO bỏ qua nhiều nhất (màn hình Chatbot bán hàng). Chủ shop không đọc được CSDL —
 * một con số «bỏ qua 100» mà không kèm lý do thì không biết phải bật bot, chờ nhân viên hết nhường, hay sửa kết nối.
 */
export async function fanpageInboundCounts(): Promise<FanpageInboundCounts> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  // Dòng bot tự gửi và dòng tin phía page không phải tin khách — không đếm.
  const notBotSent = sql`coalesce(${t.note}, '') not in ('BOT_SENT', ${PAGE_REPLY})`;
  const rows = await db.select({ status: t.status, n: sql<number>`count(*)::int` }).from(t).where(notBotSent).groupBy(t.status);
  const of = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const reasons = await db
    .select({ reason: t.note, n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.status, "SKIPPED"), notBotSent))
    .groupBy(t.note)
    .orderBy(sql`count(*) desc`)
    .limit(3);
  return { pending: of("PENDING"), done: of("DONE"), skipped: of("SKIPPED"), skippedReasons: reasons.map((r) => ({ reason: r.reason?.trim() || "Không ghi lý do", count: Number(r.n) })) };
}

export type FanpageSetupView = {
  status: "NOT_CONFIGURED" | "DRAFT" | "ACTIVE" | "FAILED";
  pageId: string | null;
  /** URL dán vào Pancake — MANG TOKEN của tổ chức; `null` khi máy chủ chưa có khoá bí mật nền tảng. */
  webhookUrl: string | null;
  counts: FanpageInboundCounts;
};

/** Khối «Fanpage (qua Pancake)» của trang Chatbot bán hàng — chỉ gọi cho người cấu hình được bot (URL mang token). */
export async function fanpageSetupView(orgCode: string): Promise<FanpageSetupView> {
  const [row] = await messagingConnectionSummaries([FANPAGE_CONNECTOR]);
  const status: FanpageSetupView["status"] = !row ? "NOT_CONFIGURED" : row.lastTestOk === false ? "FAILED" : row.status === "ACTIVE" ? "ACTIVE" : "DRAFT";
  const token = webhookUrlToken("PANCAKE_FANPAGE", orgCode);
  return {
    status,
    pageId: row?.plainSettings.pageId ?? null,
    webhookUrl: token ? `${env.appUrl.replace(/\/+$/, "")}/api/webhooks/pancake/fanpage/${token}` : null,
    counts: await fanpageInboundCounts(),
  };
}


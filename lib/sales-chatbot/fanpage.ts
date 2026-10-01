/**
 * ═══════════ CHATBOT BÁN HÀNG TRẢ LỜI TIN NHẮN FANPAGE (qua Pancake) — CHỈ MÁY CHỦ (0182) ═══════════
 *
 * Bot fanpage của tổ chức nhà là một container riêng gắn cứng một tổ chức (biến môi trường, tệp JSON, khoá AI của máy
 * chủ). Tổ chức khách dùng lại ĐÚNG bộ máy chatbot bán hàng của mình (`chatTurn`, kênh `FANPAGE`): giá / tồn đọc từ ERP,
 * khoá AI của chính shop, đơn ghi vào ERP, chuyển nhân viên — chỉ khác lối vào (webhook Pancake) và lối ra (reply_inbox).
 *
 * LUỒNG: webhook `/api/webhooks/pancake/fanpage/<token>` (token ⇒ tổ chức, `lib/platform/webhooks.ts`) ⇒ `receiveFanpageEvent`
 * ghi tin vào `sales_chat_inbound` (UNIQUE mã tin ⇒ gửi trùng vô hại) và trả 200 ngay ⇒ sau phản hồi `processFanpageThread`
 * đợi vừa đủ (tin ĐẦU của hội thoại mới: `FIRST_CONTACT_WAIT_MS`; tin tiếp theo: `FOLLOWUP_WAIT_MS`), GIÀNH mọi tin chờ của hội thoại (một lượt duy nhất), gọi
 * `chatTurn`, gửi các câu trả lời mới qua Pancake.
 *
 * BÌNH LUẬN (0184, chủ shop 01/10/2026): KHÔNG BAO GIỜ trả lời công khai dưới bình luận — bot gửi MỘT tin nhắn RIÊNG cho
 * người bình luận (Facebook private reply, Pancake `private_replies`; Facebook chỉ cho một tin riêng mỗi bình luận). Cùng
 * luật với tin nhắn: page / nhân viên đã trả lời bình luận ⇒ bot không chen; bình luận đã được nhắn riêng (Pancake tự động,
 * nhân viên) ⇒ không nhắn lần hai. Gửi xong, hội thoại chuyển sang hộp thư vừa mở để khách nhắn tiếp vẫn đúng mạch.
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
import { readQuickReplyImage, rememberPancakeContent } from "@/lib/sales-chatbot/quick-replies";

export const FANPAGE_CONNECTOR = "pancake-fanpage";
/** Nhân viên thật vừa trả lời trên fanpage ⇒ bot im lặng chừng này phút cho hội thoại đó. */
export const HUMAN_TAKEOVER_MINUTES = 30;
/** Hội thoại đã chuyển nhân viên mà im lặng quá chừng này giờ ⇒ bot nhận lại khi khách nhắn tiếp. */
export const HANDOFF_EXPIRE_HOURS = 12;
/**
 * TRẢ LỜI NHANH NHẤT CÓ THỂ mà không chen ngang trả lời tự động của Meta (chủ shop 01/10/2026: bản đầu đợi 30 giây cho mọi
 * tin là quá chậm). Meta chỉ tự trả lời TIN ĐẦU của một hội thoại mới, và tin ấy tới qua Pancake sau vài giây ⇒
 *  · tin ĐẦU của hội thoại mới: đợi tối đa `FIRST_CONTACT_WAIT_MS` — trả lời tự động tới thì bỏ qua NGAY, không đợi hết;
 *  · tin TIẾP THEO: chỉ đợi khách gõ xong (`FOLLOWUP_WAIT_MS`, gom các dòng gõ liên tiếp thành một lượt).
 * Cả hai trường hợp: page đã trả lời (Meta / nhân viên) sau tin khách ⇒ bot không chen.
 */
export const FIRST_CONTACT_WAIT_MS = 10_000;
export const FOLLOWUP_WAIT_MS = 4_000;
/**
 * Hội thoại MỚI = không có dòng nào (trừ tin phía page) trước tin chờ sớm nhất. Với hội thoại mới, tin phía page tới trước
 * tin khách tối đa chừng này vẫn tính là trả lời tự động cho chính tin ấy (hai webhook có thể tới ngược thứ tự).
 */
const FIRST_CONTACT_LOOKBACK_MS = 60_000;
/** Đệm lệch đồng hồ giữa máy ứng dụng và CSDL — lượt chờ ngủ thêm chừng này để tới lúc tỉnh tin chắc chắn đã đủ tuổi. */
const GRACE_SLACK_MS = 1_000;
const RETRY_MS = 2_000;
/** Dòng ghi tin phía page (Meta tự động / nhân viên) — chỉ để biết «đã có người trả lời», không phải tin chờ bot. */
const PAGE_REPLY = "PAGE_REPLY";
const WAITING = "Đang đợi xem page có trả lời không";
const PAGE_REPLIED_REASON = "Page đã trả lời (tự động của Meta / nhân viên) — bot không chen";
/** Tin phía page trùng NGUYÊN VĂN một đoạn bot gửi trong khoảng này ⇒ là tiếng vọng của chính bot. */
const ECHO_WINDOW_MS = 10 * 60_000;
/** Tin ẢNH (không chữ) phía page tới trong khoảng này sau khi bot gửi ảnh cùng hội thoại ⇒ tiếng vọng ảnh của bot. */
const ECHO_MEDIA_WINDOW_MS = 2 * 60_000;
/** Ảnh mỗi tin (Pancake nhận tới 30, ít ảnh / tin cho khách dễ xem) và hạn dùng lại mã nội dung đã tải lên. */
const IMAGES_PER_MESSAGE = 6;
const CONTENT_REUSE_MS = 12 * 3_600_000;
/** `thread_id` của dấu tin riêng bot ghi TRƯỚC khi gửi — chưa biết hộp thư nào sẽ mở, nên so tiếng vọng trên cả page. */
const PRIVATE_REPLY_THREAD = "__private_reply__";
/** Khoảng so tiếng vọng của tin riêng (hộp thư mới mở ngay sau lời gọi). */
const PRIVATE_ECHO_WINDOW_MS = 5 * 60_000;

/** Chuẩn hoá để so tiếng vọng: Pancake trả lại đúng câu bot gửi nhưng có thể khác khoảng trắng / xuống dòng. */
export function normalizeEcho(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}
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
  /** Bình luận (0184): bài viết + người bình luận (private reply đòi cả hai). `null` với tin nhắn. */
  comment: { postId: string; fromId: string } | null;
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
  const inbox = type === "INBOX";
  // Mã bài viết: Pancake ghi ở tin / hội thoại; thiếu thì tách từ mã hội thoại bình luận `{bài}_{bình luận}` (cách bot nhà làm).
  const post = (conv?.post ?? {}) as { id?: unknown };
  const postId = str(msg?.post_id) || str(conv?.post_id) || str(post.id) || threadId.split("_")[0];
  const comment = !inbox && type === "COMMENT" ? { postId, fromId: str(from.id) } : null;
  return { pageId, threadId, messageId, text, customerName: fromPage ? "" : customerName, fromPage, humanStaff, inbox, comment };
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
    if (!ev.inbox && !ev.comment) return { queued: false, reason: "Tin của page ngoài tin nhắn / bình luận" };
    // Tin của chính bot — không phải nhân viên, không phải «page đã trả lời». Hai dấu hiệu, một là đủ: (1) ĐÚNG mã tin Pancake
    // trả về lúc gửi; (2) trùng NGUYÊN VĂN một đoạn bot ghi sẵn TRƯỚC khi gửi, cùng hội thoại, trong 10 phút — đỡ trường hợp
    // tiếng vọng tới trước khi mã tin kịp ghi, hoặc mã trong webhook khác mã lời gọi gửi trả về. Nhận nhầm tiếng vọng là
    // nhân viên ⇒ bot nhường 30 phút ngay sau câu trả lời đầu tiên của nó.
    const echo = normalizeEcho(ev.text);
    const [own] = await db
      .select({ id: t.id })
      .from(t)
      .where(
        or(
          eq(t.messageId, ev.messageId),
          // Tin ảnh không chữ: so với dấu ảnh bot ghi trước khi gửi (chữ rỗng), khoảng ngắn hơn.
          and(eq(t.pageId, ev.pageId), eq(t.threadId, ev.threadId), eq(t.note, "BOT_SENT"), eq(t.text, echo), gte(t.createdAt, new Date(now.getTime() - (echo ? ECHO_WINDOW_MS : ECHO_MEDIA_WINDOW_MS)))),
          // Tin RIÊNG trả lời bình luận: hộp thư chưa biết lúc gửi ⇒ so nguyên văn trên cả page, khoảng ngắn.
          echo ? and(eq(t.pageId, ev.pageId), eq(t.threadId, PRIVATE_REPLY_THREAD), eq(t.note, "BOT_SENT"), eq(t.text, echo), gte(t.createdAt, new Date(now.getTime() - PRIVATE_ECHO_WINDOW_MS))) : sql`false`,
        ),
      )
      .limit(1);
    if (own) return { queued: false, reason: "Tin của chính bot" };
    // Mọi tin khác phía page = page ĐÃ trả lời ⇒ tin khách đang chờ trước nó không cần bot nữa.
    await db
      .insert(t)
      .values({ pageId: ev.pageId, threadId: ev.threadId, messageId: ev.messageId, text: ev.text, status: "DONE", processedAt: now, note: PAGE_REPLY })
      .onConflictDoNothing({ target: t.messageId });
    if (ev.comment) return { queued: false, reason: "Page đã trả lời bình luận — bot không chen" };
    if (!ev.humanStaff) return { queued: false, reason: "Trả lời tự động của page — bot không chen" };
    const c = schema.salesChatConversations;
    await db
      .update(c)
      .set({ status: "HANDOFF", handoffReason: STAFF_REASON, updatedAt: now })
      .where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageVisitorKey(ev.pageId, ev.threadId))));
    return { queued: false, reason: "Nhân viên đang trả lời — bot nhường" };
  }
  if (!ev.inbox && !ev.comment) return { queued: false, reason: "Không phải tin nhắn / bình luận" };
  if (ev.comment && !ev.comment.fromId) return { queued: false, reason: "Bình luận thiếu người gửi — không nhắn riêng được" };
  if (!ev.text) return { queued: false, reason: "Tin không có chữ (ảnh / nhãn dán) — để nhân viên xem" };
  const rows = await db
    .insert(t)
    .values({ pageId: ev.pageId, threadId: ev.threadId, messageId: ev.messageId, text: ev.text, customerName: ev.customerName || null, ...(ev.comment ? { kind: "COMMENT", postId: ev.comment.postId, fromId: ev.comment.fromId } : {}) })
    .onConflictDoNothing({ target: t.messageId })
    .returning({ id: t.id });
  return rows.length ? { queued: true, reason: "Đã nhận" } : { queued: false, reason: "Tin trùng — đã nhận trước đó" };
}

export type FanpageDeps = { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> };

/**
 * Tải ảnh câu mẫu lên page (Pancake `upload_contents`, multipart — Pancake không cần URL công khai) ⇒ mã nội dung. Mã đã tải
 * cho CHÍNH page này trong 12 giờ thì dùng lại. Ảnh hỏng / lỗi tải ⇒ bỏ ảnh đó, không chặn phần còn lại.
 */
async function contentIdsFor(pageId: string, token: string, imageIds: readonly string[], fetchImpl: typeof fetch, now: Date): Promise<{ ids: string[]; errors: string[] }> {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const id of imageIds) {
    const img = await readQuickReplyImage(id);
    if (!img) continue;
    if (img.pancakePageId === pageId && img.pancakeContentId && img.pancakeUploadedAt && now.getTime() - img.pancakeUploadedAt.getTime() < CONTENT_REUSE_MS) {
      ids.push(img.pancakeContentId);
      continue;
    }
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(img.data)], { type: img.contentType }), `anh.${img.contentType.split("/")[1] ?? "jpg"}`);
      const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/upload_contents?page_access_token=${encodeURIComponent(token)}`;
      const res = await fetchImpl(url, { method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const body = (await res.json().catch(() => null)) as { success?: boolean; id?: unknown; message?: unknown } | null;
      if (!res.ok || body?.success === false || !str(body?.id)) {
        errors.push(scrubSecrets(`Pancake không nhận ảnh: ${str(body?.message) || `HTTP ${res.status}`}`, [token]));
        continue;
      }
      ids.push(str(body?.id));
      await rememberPancakeContent(id, pageId, str(body?.id), now);
    } catch (e) {
      errors.push(scrubSecrets(isNetworkFailure(e) ? `Không gọi được Pancake: ${describeNetworkFailure(e, "pages.fm")}` : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`, [token]));
    }
  }
  return { ids, errors };
}

/** Gửi ảnh (đã có mã nội dung) vào hội thoại — mỗi tin tối đa `IMAGES_PER_MESSAGE` ảnh. */
async function sendImages(pageId: string, threadId: string, token: string, contentIds: readonly string[], fetchImpl: typeof fetch): Promise<{ ok: true; ids: string[] } | { ok: false; error: string; ids: string[] }> {
  const ids: string[] = [];
  const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(threadId)}/messages?page_access_token=${encodeURIComponent(token)}`;
  try {
    for (let i = 0; i < contentIds.length; i += IMAGES_PER_MESSAGE) {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reply_inbox", content_ids: contentIds.slice(i, i + IMAGES_PER_MESSAGE) }), redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => null)) as { success?: boolean; id?: unknown; message?: unknown } | null;
      if (!res.ok || body?.success === false) return { ok: false, error: scrubSecrets(`Pancake không gửi được ảnh: ${str(body?.message) || `HTTP ${res.status}`}`, [token]), ids };
      if (str(body?.id)) ids.push(str(body?.id));
    }
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, error: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Pancake: ${describeNetworkFailure(e, "pages.fm")}` : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`, [token]), ids };
  }
}

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

type CommentReplyInput = { pageId: string; threadId: string; token: string; commentId: string; postId: string; fromId: string; text: string; imageIds: readonly string[]; conversationId: string };
type CommentReplyResult = { kind: "SENT"; inboxId: string | null; warning: string | null } | { kind: "ALREADY"; reason: string } | { kind: "FAILED"; reason: string };

/** Hộp thư mà tin riêng của MỘT bình luận đã mở (`private_reply_conversation` của Pancake) — `null` khi chưa nhắn riêng / không đọc được. */
async function privateReplyInbox(pageId: string, threadId: string, commentId: string, token: string, fetchImpl: typeof fetch): Promise<{ read: boolean; inboxId: string | null }> {
  try {
    const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(threadId)}/messages?page_access_token=${encodeURIComponent(token)}`;
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { messages?: { id?: unknown; private_reply_conversation?: unknown }[] } | null;
    if (!res.ok || !Array.isArray(body?.messages)) return { read: false, inboxId: null };
    const mine = body.messages.find((m) => str(m.id) === commentId);
    const prc = mine?.private_reply_conversation as unknown;
    const inboxId = typeof prc === "string" ? prc : prc && typeof prc === "object" ? str((prc as { id?: unknown }).id) || str((prc as { conversation_id?: unknown }).conversation_id) : "";
    return { read: true, inboxId: inboxId || null };
  } catch {
    return { read: false, inboxId: null };
  }
}

/**
 * Trả lời MỘT bình luận bằng tin nhắn RIÊNG (0184). (1) Bình luận đã được nhắn riêng (Pancake tự động / nhân viên) ⇒ không nhắn
 * lần hai (Facebook chỉ cho một). (2) Ghi dấu tiếng vọng TRƯỚC khi gửi. (3) `private_replies`. Hỏng ⇒ báo lỗi, KHÔNG BAO GIỜ
 * lùi về trả lời công khai. (4) Gửi xong: tìm hộp thư vừa mở ⇒ ghi dấu ở hộp thư đó (khách nhắn tiếp được trả lời nhanh, tiếng
 * vọng không bị coi là nhân viên), chuyển hội thoại sang hộp thư ấy (giữ mạch), gửi ảnh của câu mẫu vào đó.
 */
async function deliverCommentReply(input: CommentReplyInput, deps: FanpageDeps): Promise<CommentReplyResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const { pageId, threadId, token, commentId } = input;
  const text = input.text.trim().slice(0, TEXT_MAX);
  if (!text) return { kind: "FAILED", reason: "Bot không soạn được câu trả lời cho bình luận" };
  const before = await privateReplyInbox(pageId, threadId, commentId, token, fetchImpl);
  if (before.inboxId) return { kind: "ALREADY", reason: "Bình luận đã được nhắn riêng (Pancake tự động / nhân viên) — bot không nhắn lần hai" };
  const db = await getDb();
  const t = schema.salesChatInbound;
  await db.insert(t).values({ pageId, threadId: PRIVATE_REPLY_THREAD, messageId: `bot-out:${randomUUID()}`, text: normalizeEcho(text), status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
  try {
    const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(threadId)}/messages?page_access_token=${encodeURIComponent(token)}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "private_replies", post_id: input.postId, message_id: commentId, from_id: input.fromId, message: text }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; id?: unknown; message?: unknown } | null;
    if (!res.ok || body?.success === false) return { kind: "FAILED", reason: scrubSecrets(`Pancake không nhắn riêng được cho bình luận: ${str(body?.message) || `HTTP ${res.status}`} — bot KHÔNG trả lời công khai`, [token]) };
    if (str(body?.id)) await db.insert(t).values({ pageId, threadId: PRIVATE_REPLY_THREAD, messageId: str(body?.id), text: normalizeEcho(text), status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
  } catch (e) {
    return { kind: "FAILED", reason: scrubSecrets(isNetworkFailure(e) ? `Không gọi được Pancake: ${describeNetworkFailure(e, "pages.fm")}` : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`, [token]) };
  }
  const after = await privateReplyInbox(pageId, threadId, commentId, token, fetchImpl);
  const inboxId = after.inboxId;
  if (!inboxId) return { kind: "SENT", inboxId: null, warning: input.imageIds.length ? "Đã nhắn riêng; chưa tìm được hộp thư để gửi ảnh" : null };
  await db.insert(t).values({ pageId, threadId: inboxId, messageId: `bot-out:${randomUUID()}`, text: normalizeEcho(text), status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
  // Giữ mạch: hội thoại của bình luận đi tiếp ở hộp thư (bỏ qua nếu hộp thư đã có hội thoại riêng — khoá UNIQUE).
  const c = schema.salesChatConversations;
  await db
    .update(c)
    .set({ visitorKey: fanpageVisitorKey(pageId, inboxId), updatedAt: now() })
    .where(and(eq(c.id, input.conversationId), sql`not exists (select 1 from ${c} x where x.channel = 'FANPAGE' and x.visitor_key = ${fanpageVisitorKey(pageId, inboxId)})`))
    .catch(() => undefined);
  let warning: string | null = null;
  if (input.imageIds.length) {
    const up = await contentIdsFor(pageId, token, input.imageIds, fetchImpl, now());
    if (up.ids.length) {
      await db.insert(t).values({ pageId, threadId: inboxId, messageId: `bot-out:${randomUUID()}`, text: "", status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
      const sentImgs = await sendImages(pageId, inboxId, token, up.ids, fetchImpl);
      if (sentImgs.ids.length) await db.insert(t).values(sentImgs.ids.map((id) => ({ pageId, threadId: inboxId, messageId: id, text: "", status: "DONE", processedAt: now(), note: "BOT_SENT" }))).onConflictDoNothing({ target: t.messageId });
      if (!sentImgs.ok) warning = sentImgs.error;
    }
    warning = warning ?? up.errors[0] ?? null;
  }
  return { kind: "SENT", inboxId, warning };
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
    const [pend] = await db
      .select({ newest: sql<Date | string | null>`max(${t.createdAt})`, oldest: sql<Date | string | null>`min(${t.createdAt})` })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), eq(t.status, "PENDING")));
    if (!pend?.newest || !pend.oldest) break;
    const oldest = new Date(pend.oldest);
    // Hội thoại mới hay tin tiếp theo — xem `FIRST_CONTACT_WAIT_MS`.
    const [prior] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), lt(t.createdAt, oldest), sql`coalesce(${t.note}, '') <> ${PAGE_REPLY}`))
      .limit(1);
    const firstContact = !prior;
    const repliedSince = firstContact ? new Date(oldest.getTime() - FIRST_CONTACT_LOOKBACK_MS) : oldest;
    const pageRepliedSince = async () =>
      (await db.select({ id: t.id }).from(t).where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), eq(t.note, PAGE_REPLY), gte(t.createdAt, repliedSince))).limit(1)).length > 0;
    // Chưa đủ tuổi VÀ page chưa trả lời ⇒ chưa tới lượt (lượt chờ của chính tin mới nhất sẽ gom cả hội thoại). Page đã trả
    // lời ⇒ đi tiếp ngay để bỏ qua, không bắt khách đợi hết thời gian chờ.
    if (new Date(pend.newest).getTime() > now().getTime() - (firstContact ? FIRST_CONTACT_WAIT_MS : FOLLOWUP_WAIT_MS) && !(await pageRepliedSince())) return { ...out, skipped: WAITING };
    const claim = randomUUID();
    const staleBefore = new Date(now().getTime() - CLAIM_STALE_MS);
    const claimed = await db
      .update(t)
      .set({ claimId: claim, claimedAt: now() })
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), eq(t.status, "PENDING"), or(isNull(t.claimId), lt(t.claimedAt, staleBefore))))
      .returning({ id: t.id, text: t.text, createdAt: t.createdAt, messageId: t.messageId, kind: t.kind, postId: t.postId, fromId: t.fromId });
    if (!claimed.length) break;
    const ids = claimed.map((r) => r.id);
    const finish = (status: "DONE" | "SKIPPED" | "PENDING", note: string | null) =>
      db
        .update(t)
        .set(status === "PENDING" ? { claimId: null, claimedAt: null, note } : { status, processedAt: now(), note })
        .where(and(inArray(t.id, ids), eq(t.claimId, claim)));
    // Page đã trả lời (Meta tự động / nhân viên) sau tin khách sớm nhất của lượt ⇒ bot không chen.
    if (await pageRepliedSince()) {
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
    // CHUYỂN NGƯỜI ⇒ bot IM LẶNG trên fanpage (chủ shop 01/10/2026: không nhắn «Em đã chuyển cho nhân viên…», để nguyên
    // cho tới khi người vào đọc và trả lời). Áp cho MỌI đường chuyển: AI gọi handoff · AI hỏng · hội thoại quá dài. Nhân
    // viên vẫn nhận thông báo trong ERP (`notifySalesChatHandoff`).
    if (turn.view.status === "HANDOFF") {
      await finish("DONE", "Chuyển nhân viên — bot không nhắn gì, chờ người trả lời");
      out.processed += ids.length;
      out.skipped = "Chuyển nhân viên — bot im lặng";
      continue;
    }
    const replies = turn.view.messages.slice(before).filter((m) => m.role === "assistant" && m.text.trim());
    let sendError: string | null = null;
    // BÌNH LUẬN: một tin RIÊNG trả lời bình luận MỚI NHẤT của lượt (gộp mọi câu trả lời) — không bao giờ công khai.
    const lastComment = [...claimed].reverse().find((r) => r.kind === "COMMENT" && r.postId && r.fromId);
    if (lastComment) {
      const pr = await deliverCommentReply(
        { pageId, threadId, token, commentId: lastComment.messageId, postId: lastComment.postId!, fromId: lastComment.fromId!, text: replies.map((r) => r.text).join("\n\n"), imageIds: turn.media?.imageIds ?? [], conversationId: conv.id },
        deps,
      );
      if (pr.kind === "SENT") out.replies += 1;
      await finish(pr.kind === "ALREADY" ? "SKIPPED" : "DONE", pr.kind === "SENT" ? pr.warning : pr.reason);
      out.processed += ids.length;
      if (pr.kind === "FAILED") {
        out.error = pr.reason;
        break;
      }
      continue;
    }
    for (const r of replies) {
      // Ghi TRƯỚC khi gửi từng đoạn (đúng cách chia của sendInbox): tiếng vọng có thể tới trước khi lời gọi gửi trả mã tin.
      await db
        .insert(t)
        .values(chunkText(r.text, TEXT_MAX).map((part) => ({ pageId, threadId, messageId: `bot-out:${randomUUID()}`, text: normalizeEcho(part), status: "DONE", processedAt: now(), note: "BOT_SENT" })))
        .onConflictDoNothing({ target: t.messageId });
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
    // Ảnh của câu trả lời mẫu (0183): gửi SAU phần chữ. Dấu ảnh (chữ rỗng) ghi TRƯỚC khi gửi — tiếng vọng ảnh không có chữ.
    const media = turn.media?.imageIds ?? [];
    if (!sendError && media.length) {
      const up = await contentIdsFor(pageId, token, media, deps.fetch ?? fetch, now());
      if (up.ids.length) {
        await db.insert(t).values({ pageId, threadId, messageId: `bot-out:${randomUUID()}`, text: "", status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
        const sentImgs = await sendImages(pageId, threadId, token, up.ids, deps.fetch ?? fetch);
        if (sentImgs.ids.length) await db.insert(t).values(sentImgs.ids.map((id) => ({ pageId, threadId, messageId: id, text: "", status: "DONE", processedAt: now(), note: "BOT_SENT" }))).onConflictDoNothing({ target: t.messageId });
        if (!sentImgs.ok) sendError = sentImgs.error;
      }
      if (!sendError && up.errors.length) sendError = up.errors[0];
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

/**
 * Sau phản hồi webhook: đợi khách gõ xong rồi xử lý; tin đầu của hội thoại mới chưa đủ tuổi / hội thoại bận thì thử lại mỗi
 * `RETRY_MS` — tối đa đủ phủ `FIRST_CONTACT_WAIT_MS` (trả lời tự động của Meta tới giữa chừng ⇒ lượt kế tiếp bỏ qua ngay).
 */
export async function processFanpageThreadDebounced(pageId: string, threadId: string, deps: FanpageDeps = {}): Promise<ProcessResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(FOLLOWUP_WAIT_MS + GRACE_SLACK_MS);
  let last: ProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  const tries = Math.ceil((FIRST_CONTACT_WAIT_MS - FOLLOWUP_WAIT_MS) / RETRY_MS) + 3;
  for (let i = 0; i < tries; i++) {
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


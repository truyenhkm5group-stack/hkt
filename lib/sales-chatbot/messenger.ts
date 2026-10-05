import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { messagingConnectionSummaries, openActiveConnection, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { TesterDeps } from "@/lib/connectors/testers";
import { instagramAccountOf, messengerApp, postMessage, sendMessengerImage, sendMessengerText, sendPrivateReply, subscribePage, MESSENGER_TEXT_MAX, type ConnectablePage, type MessengerEvent } from "@/lib/integrations/messenger/graph";
import { chunkText } from "@/lib/messaging/providers";
import { canUseModule } from "@/lib/platform/capabilities";
import { AI_DOWN_HANDOFF_REASON, chatTurn, conversationView, describeCustomerImages } from "@/lib/sales-chatbot/engine";
import {
  CLAIM_STALE_MS,
  conversationFor,
  COPILOT_NOTE,
  erpStaffEchoCond,
  fanpageVisitorKey,
  FIRST_CONTACT_LOOKBACK_MS,
  FIRST_CONTACT_WAIT_MS,
  FOLLOWUP_WAIT_MS,
  GRACE_SLACK_MS,
  HUMAN_TAKEOVER_MINUTES,
  markWaitingForCustomer,
  MEDIA_ONLY_NOTE,
  MEDIA_ONLY_TEXT,
  normalizeEcho,
  noteCustomerArrived,
  mirrorFanpageContext,
  OBSERVE_HUMAN_ARM_NOTE,
  OBSERVE_NOTE,
  PAGE_REPLIED_REASON,
  PAGE_REPLY,
  postContextPrompt,
  RETRY_MS,
  sendFanpageImages,
  sendFanpageText,
  STAFF_IMAGE_MARK,
  STAFF_INFER_WINDOW_MS,
  STAFF_OUT_PREFIX,
  STAFF_REASON,
  staffOutRowId,
  stopFollowups,
  WAITING,
  type FanpageDeps,
  type ProcessResult,
  type ReceiveResult,
  type StaffMark,
} from "@/lib/sales-chatbot/fanpage";
import { draftCopilotSuggestion, loadModeConfig, pinArm } from "@/lib/sales-chatbot/operating-mode";
import { readQuickReplyImage } from "@/lib/sales-chatbot/quick-replies";
import { readPinnedArm, replyGate } from "@/lib/sales-chatbot/operating-mode-shared";
import { applyConversationControl, controlOf, controlSkipNote } from "@/lib/sales-chatbot/conversation-control-shared";
import { botMaySend, captureSendSnapshot } from "@/lib/sales-chatbot/conversation-control";
import { noteMessengerGraphFailure } from "@/lib/sales-chatbot/messenger-health";

/**
 * ═══════════ MESSENGER TRỰC TIẾP — BOT FANPAGE KHÔNG CẦN PANCAKE (0207 · docs/platform/messenger.md) ═══════════
 *
 * Cùng con bot, cùng hàng chờ (`sales_chat_inbound`), cùng hội thoại kênh `FANPAGE` (khoá = băm(page, PSID)) với đường
 * Pancake — chỉ khác ĐƯỜNG VÀO (webhook của Meta, xác thực bằng chữ ký app) và ĐƯỜNG RA (Send API). Mọi luật của lượt trả lời
 * giữ nguyên: đợi khách gõ xong, tin đầu đợi xem Meta có tự trả lời không, nhân viên trả lời ⇒ bot nhường 30 phút, chuyển
 * người ⇒ bot im, đọc ảnh, follow-up.
 *
 * Phân biệt người gửi KHÔNG phải đoán như với Pancake: Meta gửi «tiếng vọng» (`is_echo`) cho MỌI tin page gửi đi, kèm `app_id`
 * của app đã gửi. `app_id` = app của nền tảng ⇒ tin của chính bot. Khác ⇒ người (Hộp thư Meta Business Suite) hoặc trả lời
 * tự động của Meta.
 */

export const MESSENGER_CONNECTOR = "facebook-messenger";

const TEXT_MAX = 2000;

/**
 * Mã mà kết nối đang bật «sở hữu»: page (Messenger) và — nếu page gắn tài khoản Instagram doanh nghiệp — mã Instagram (DM).
 * Hai kênh dùng CÙNG page token và CÙNG Send API; hội thoại tách theo (mã, người gửi).
 */
function ownedIds(settings: Record<string, string>): string[] {
  return [settings.pageId, settings.igAccountId].map((x) => (x ?? "").trim()).filter(Boolean);
}

// ─────────────────────────── Nối / gỡ page ───────────────────────────

export type MessengerConnectResult = { ok: true; message: string } | { error: string };

/**
 * Nối MỘT page cho tổ chức của `user`: giữ chỉ mục page ⇒ tổ chức (page thuộc tổ chức khác ⇒ TỪ CHỐI, không cướp) → lưu token
 * (mã hoá, qua lõi kết nối — quyền + nhật ký ở đó) → đăng ký webhook cho page → kiểm tra → bật. Hỏng ở bước nào ⇒ dừng ở đó,
 * kết nối không bật. Nối page mới thay page cũ: chỉ mục của page cũ được gỡ.
 */
export async function connectMessengerPage(user: SessionUser, page: ConnectablePage, deps: { fetch?: typeof fetch; tester?: TesterDeps } = {}): Promise<MessengerConnectResult> {
  const orgCode = user.organization?.code;
  if (!orgCode) return { error: "Phiên không mang tổ chức." };
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật — bật ở Cài đặt → Module." };
  const app = messengerApp();
  if (!app) return { error: "Nền tảng chưa cấu hình app Facebook — báo người vận hành." };
  if (!/^\d{5,30}$/.test(page.id) || !page.token) return { error: "Page không hợp lệ." };
  const pdb = await getPlatformDb();
  const pages = schema.platformMessengerPages;
  const [owner] = await pdb.select({ orgCode: pages.orgCode }).from(pages).where(eq(pages.pageId, page.id)).limit(1);
  if (owner && owner.orgCode !== orgCode) return { error: `Page «${page.name || page.id}» đang nối với một cửa hàng khác trên nền tảng. Gỡ ở cửa hàng đó trước, hoặc liên hệ hỗ trợ.` };
  // Instagram doanh nghiệp gắn với page (nếu có và chưa thuộc tổ chức khác) — nối cùng lượt, cùng token.
  const ig = await instagramAccountOf(app, page.id, page.token, deps.fetch ?? fetch);
  const [igOwner] = ig ? await pdb.select({ orgCode: pages.orgCode }).from(pages).where(eq(pages.pageId, ig.id)).limit(1) : [];
  const igOk = ig && (!igOwner || igOwner.orgCode === orgCode) ? ig : null;
  const saved = await saveConnection(user, {
    connectorKey: MESSENGER_CONNECTOR,
    settings: { pageId: page.id, pageName: page.name.slice(0, 120), igAccountId: igOk?.id ?? "", igUsername: igOk?.username ?? "" },
    secrets: { pageAccessToken: page.token },
  });
  if ("error" in saved) return { error: saved.error };
  const sub = await subscribePage(app, page.id, page.token, deps.fetch ?? fetch);
  if (!sub.ok) return { error: `Đã lưu nhưng chưa đăng ký nhận tin cho page: ${sub.error}` };
  const tested = await testOrgConnection(user, MESSENGER_CONNECTOR, deps.tester ? { tester: deps.tester } : deps.fetch ? { tester: { fetch: deps.fetch } } : {});
  if ("error" in tested) return { error: `Đã lưu nhưng kiểm tra chưa đạt: ${tested.error}` };
  const on = await setConnectionStatus(user, MESSENGER_CONNECTOR, "ACTIVE");
  if ("error" in on) return { error: on.error };
  await pdb
    .insert(pages)
    .values({ pageId: page.id, orgCode, pageName: page.name.slice(0, 120), connectedByEmail: user.email })
    .onConflictDoUpdate({ target: pages.pageId, set: { pageName: page.name.slice(0, 120), connectedByEmail: user.email, updatedAt: new Date() }, where: eq(pages.orgCode, orgCode) });
  if (igOk) {
    await pdb
      .insert(pages)
      .values({ pageId: igOk.id, orgCode, pageName: `Instagram @${igOk.username}`.slice(0, 120), connectedByEmail: user.email })
      .onConflictDoUpdate({ target: pages.pageId, set: { pageName: `Instagram @${igOk.username}`.slice(0, 120), connectedByEmail: user.email, updatedAt: new Date() }, where: eq(pages.orgCode, orgCode) });
  }
  const keep = igOk ? [page.id, igOk.id] : [page.id];
  await pdb.delete(pages).where(and(eq(pages.orgCode, orgCode), notInArray(pages.pageId, keep)));
  const igNote = igOk ? ` và Instagram @${igOk.username}` : ig ? ` (Instagram @${ig.username} đang nối với cửa hàng khác — chưa nối)` : "";
  return { ok: true, message: `Đã nối Messenger của page «${page.name || page.id}»${igNote}. Nhắn thử một tin để thấy bot trả lời.` };
}

/** Gỡ: tắt kết nối + gỡ chỉ mục page ⇒ webhook của page không còn tới tổ chức này. Token đã lưu giữ nguyên (mã hoá). */
export async function disconnectMessengerPage(user: SessionUser): Promise<MessengerConnectResult> {
  const orgCode = user.organization?.code;
  if (!orgCode) return { error: "Phiên không mang tổ chức." };
  const off = await setConnectionStatus(user, MESSENGER_CONNECTOR, "DISABLED");
  if ("error" in off) return { error: off.error };
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, orgCode));
  return { ok: true, message: "Đã gỡ Messenger trực tiếp — bot không nhận tin từ page qua đường này nữa." };
}

// ─────────────────────────── Nhận tin (webhook) ───────────────────────────

/** Ghi MỘT sự kiện Messenger của tổ chức ngữ cảnh. Không gọi AI, không gọi Meta — webhook trả 200 ngay sau đây. */
export async function receiveMessengerEvent(ev: MessengerEvent, now: Date = new Date()): Promise<ReceiveResult> {
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  if (!conn.ok) return { queued: false, reason: "Kết nối Messenger chưa bật" };
  if (!ownedIds(conn.settings).includes(ev.pageId)) return { queued: false, reason: "Tin của page khác page đã nối" };
  const db = await getDb();
  const t = schema.salesChatInbound;
  if (ev.isEcho) {
    // Tin nhân viên gửi từ hộp thư ERP đi qua CHÍNH app nền tảng ⇒ phải bắt trước nhánh «mã app = bot», không thì thành tin bot.
    const [staffEcho] = await db.select({ id: t.id }).from(t).where(erpStaffEchoCond(ev.pageId, ev.psid, normalizeEcho(ev.text), now)).limit(1);
    if (staffEcho) return { queued: false, reason: "Tin nhân viên gửi từ hộp thư ERP" };
    const app = messengerApp();
    // Tin của chính bot: mã app của nền tảng, HOẶC đúng mã tin bot đã ghi lúc gửi (tiếng vọng Instagram không mang mã app).
    const [sentByBot] = await db.select({ id: t.id }).from(t).where(and(eq(t.messageId, ev.mid), eq(t.note, "BOT_SENT"))).limit(1);
    if ((app && ev.appId === app.appId) || sentByBot) {
      await db.insert(t).values({ pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: ev.text.slice(0, TEXT_MAX), status: "DONE", processedAt: now, note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
      return { queued: false, reason: "Tin của chính bot" };
    }
    // Tin page gửi đi KHÔNG qua app nền tảng: người trong Hộp thư Meta, hoặc trả lời tự động của Meta.
    await db.insert(t).values({ pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: ev.text.slice(0, TEXT_MAX), status: "DONE", processedAt: now, note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
    await stopFollowups(ev.pageId, ev.psid, now, false);
    const c = schema.salesChatConversations;
    const key = fanpageKey(ev.pageId, ev.psid);
    // Đang trò chuyện với bot mà page lên tiếng ⇒ là người ⇒ nhường như nhân viên. Đầu hội thoại ⇒ trả lời tự động của Meta.
    const [active] = await db
      .select({ id: c.id })
      .from(c)
      .where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, key), gte(c.lastBotAt, new Date(now.getTime() - STAFF_INFER_WINDOW_MS))))
      .limit(1);
    if (!active) return { queued: false, reason: "Trả lời tự động của page — bot không chen" };
    await db
      .update(c)
      .set({ status: "HANDOFF", handoffReason: sql`case when ${c.status} = 'HANDOFF' and ${c.handoffReason} is not null and ${c.handoffReason} <> ${STAFF_REASON} then ${c.handoffReason} else ${STAFF_REASON} end`, updatedAt: now })
      .where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, key)));
    return { queued: false, reason: "Nhân viên đang trả lời — bot nhường" };
  }
  // BÌNH LUẬN dưới bài viết (trường `feed`): một hàng chờ riêng mỗi bình luận (`threadId` = «comment:<mã>») — bot trả lời bằng
  // TIN RIÊNG (Private Replies), không bao giờ công khai. Mỗi bình luận Meta chỉ cho MỘT tin riêng.
  if (ev.comment) {
    const rows = await db
      .insert(t)
      .values({ pageId: ev.pageId, threadId: ev.mid, messageId: ev.mid, text: ev.text, kind: "COMMENT", postId: ev.comment.postId, fromId: ev.psid })
      .onConflictDoNothing({ target: t.messageId })
      .returning({ id: t.id });
    return rows.length ? { queued: true, reason: "Đã nhận bình luận" } : { queued: false, reason: "Bình luận trùng — đã nhận trước đó" };
  }
  if (!ev.text && !ev.imageUrls.length) {
    await stopFollowups(ev.pageId, ev.psid, now, true);
    // NGƯỜI phải thấy tin này trong hộp thư (MEDIA_ONLY — không vào hàng chờ của bot).
    await db.insert(t).values({ pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: MEDIA_ONLY_TEXT, status: "DONE", processedAt: now, note: MEDIA_ONLY_NOTE }).onConflictDoNothing({ target: t.messageId });
    await noteCustomerArrived(ev.pageId, ev.psid, now);
    return { queued: false, reason: "Tin không có chữ hay ảnh — để nhân viên xem" };
  }
  const rows = await db
    .insert(t)
    .values({ pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: ev.text, ...(ev.imageUrls.length ? { imageUrls: ev.imageUrls } : {}) })
    .onConflictDoNothing({ target: t.messageId })
    .returning({ id: t.id });
  if (rows.length) await noteCustomerArrived(ev.pageId, ev.psid, now);
  return rows.length ? { queued: true, reason: "Đã nhận" } : { queued: false, reason: "Tin trùng — đã nhận trước đó" };
}

/** Cùng khoá hội thoại với đường Pancake (băm page + mã hội thoại) — PSID và mã hội thoại Pancake không bao giờ trùng nhau. */
const fanpageKey = (pageId: string, psid: string) => fanpageVisitorKey(pageId, psid);

// ─────────────────────────── Gửi ───────────────────────────

/** Gửi MỘT tin chữ của bot qua Send API (chia ≤ 2.000 ký tự). Ghi mã tin đã gửi — tiếng vọng tới sau là «tin của chính bot». */
export async function sendMessengerPageText(pageId: string, psid: string, text: string, deps: FanpageDeps = {}, mark?: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  if (!conn.ok || !ownedIds(conn.settings).includes(pageId)) return { ok: false, error: "Kết nối Messenger chưa bật / khác page" };
  const app = messengerApp();
  if (!app) return { ok: false, error: "Nền tảng chưa cấu hình app Facebook" };
  const token = (conn.secrets.pageAccessToken ?? "").trim();
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  const parts = chunkText(text, MESSENGER_TEXT_MAX);
  for (const [i, part] of parts.entries()) {
    if (mark) {
      // Tin nhân viên (hộp thư ERP): ghi sẵn TRƯỚC khi gửi — tiếng vọng tới nhanh hơn phản hồi của Send API.
      const rowId = staffOutRowId(mark, i);
      await db.insert(t).values({ pageId, threadId: psid, messageId: rowId, text: normalizeEcho(part), status: "DONE", processedAt: now(), note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
      const sent = await sendMessengerText(app, token, psid, part, deps.fetch ?? fetch);
      if (!sent.ok) {
        await noteMessengerGraphFailure(sent);
        await db.delete(t).where(eq(t.messageId, rowId));
        return { ok: false, error: i > 0 ? `${sent.error} (đã gửi ${i}/${parts.length} đoạn)` : sent.error };
      }
      continue;
    }
    const sent = await sendMessengerText(app, token, psid, part, deps.fetch ?? fetch);
    // Token hỏng / mất quyền ⇒ kết nối «cần nối lại» + báo người (messenger-health.ts); lỗi khác chỉ là lỗi của tin này.
    if (!sent.ok) return (await noteMessengerGraphFailure(sent), { ok: false, error: sent.error });
    await db
      .insert(t)
      .values({ pageId, threadId: psid, messageId: sent.id ?? `bot-out:${randomUUID()}`, text: part.slice(0, TEXT_MAX), status: "DONE", processedAt: now(), note: "BOT_SENT" })
      .onConflictDoNothing({ target: t.messageId });
  }
  return { ok: true };
}

/** Nhân viên gửi ẢNH qua Send API (0211): mỗi ảnh một lời gọi (tải tệp kèm). Dòng ghi sẵn «[Ảnh]» như đường Pancake. */
export async function sendMessengerPageImages(pageId: string, psid: string, images: readonly { data: Uint8Array; contentType: string }[], deps: FanpageDeps, mark: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  if (!conn.ok || !ownedIds(conn.settings).includes(pageId)) return { ok: false, error: "Kết nối Messenger chưa bật / khác page" };
  const app = messengerApp();
  if (!app) return { ok: false, error: "Nền tảng chưa cấu hình app Facebook" };
  const token = (conn.secrets.pageAccessToken ?? "").trim();
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  const rowId = `${STAFF_OUT_PREFIX}${mark.staffMessageId}:img`;
  await db.insert(t).values({ pageId, threadId: psid, messageId: rowId, text: STAFF_IMAGE_MARK, status: "DONE", processedAt: now(), note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
  for (const [i, img] of images.entries()) {
    const sent = await sendMessengerImage(app, token, psid, img, deps.fetch ?? fetch);
    if (!sent.ok) {
      await noteMessengerGraphFailure(sent);
      if (i === 0) await db.delete(t).where(eq(t.messageId, rowId));
      return { ok: false, error: i > 0 ? `${sent.error} (đã gửi ${i}/${images.length} ảnh)` : sent.error };
    }
  }
  return { ok: true };
}

/** Ảnh của nhân viên vào hội thoại fanpage, ĐÚNG đường của page: Pancake nếu page nối qua Pancake, không thì Messenger trực tiếp. */
export async function sendPageImages(pageId: string, threadId: string, images: readonly { data: Uint8Array; contentType: string }[], deps: FanpageDeps, mark: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  const viaPancake = await sendFanpageImages(pageId, threadId, images, deps, mark);
  if (viaPancake.ok || !/chưa bật \/ khác page/.test(viaPancake.error)) return viaPancake;
  return sendMessengerPageImages(pageId, threadId, images, deps, mark);
}

/**
 * ẢNH CỦA CÂU TRẢ LỜI MẪU do BOT gửi qua Send API: đọc tệp ảnh của câu mẫu trong ERP, mỗi ảnh một lời gọi (tải tệp kèm).
 * Mã tin Meta trả về ghi `BOT_SENT` — tiếng vọng tới sau là tin của bot (Instagram không mang mã app). Ảnh hỏng / mất ⇒ bỏ ảnh
 * đó, không chặn ảnh sau; lỗi gửi ⇒ dừng, trả câu lỗi.
 */
export async function sendBotImages(pageId: string, psid: string, imageIds: readonly string[], deps: FanpageDeps = {}): Promise<{ ok: true; sent: number } | { ok: false; error: string }> {
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  if (!conn.ok || !ownedIds(conn.settings).includes(pageId)) return { ok: false, error: "Kết nối Messenger chưa bật / khác page" };
  const app = messengerApp();
  if (!app) return { ok: false, error: "Nền tảng chưa cấu hình app Facebook" };
  const token = (conn.secrets.pageAccessToken ?? "").trim();
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  let sent = 0;
  for (const id of imageIds) {
    const img = await readQuickReplyImage(id);
    if (!img) continue;
    const r = await sendMessengerImage(app, token, psid, { data: new Uint8Array(img.data), contentType: img.contentType }, deps.fetch ?? fetch);
    if (!r.ok) return (await noteMessengerGraphFailure(r), { ok: false, error: r.error });
    sent += 1;
    await db.insert(t).values({ pageId, threadId: psid, messageId: r.id ?? `bot-out:${randomUUID()}`, text: "", status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
  }
  return { ok: true, sent };
}

/** Một tin của bot vào hội thoại fanpage, ĐÚNG đường của page: Pancake nếu page nối qua Pancake, không thì Messenger trực tiếp. */
export async function sendBotText(pageId: string, threadId: string, text: string, deps: FanpageDeps = {}, mark?: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  const viaPancake = await sendFanpageText(pageId, threadId, text, deps, mark);
  if (viaPancake.ok || !/chưa bật \/ khác page/.test(viaPancake.error)) return viaPancake;
  return sendMessengerPageText(pageId, threadId, text, deps, mark);
}

// ─────────────────────────── Xử lý lượt ───────────────────────────

/** Gom tin chờ của MỘT khách (PSID) ⇒ một lượt chatbot ⇒ gửi trả lời qua Send API. Cùng luật chờ / nhường với đường Pancake. */
export async function processMessengerThread(pageId: string, psid: string, deps: FanpageDeps = {}): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date());
  const out: ProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  if (!conn.ok || !ownedIds(conn.settings).includes(pageId)) return { ...out, skipped: "Kết nối Messenger chưa bật / khác page" };
  const token = (conn.secrets.pageAccessToken ?? "").trim();
  const db = await getDb();
  const t = schema.salesChatInbound;
  for (let round = 0; round < 3; round++) {
    const [pend] = await db
      .select({ newest: sql<Date | string | null>`max(${t.createdAt})`, oldest: sql<Date | string | null>`min(${t.createdAt})` })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), eq(t.status, "PENDING")));
    if (!pend?.newest || !pend.oldest) break;
    const oldest = new Date(pend.oldest);
    const [prior] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), lt(t.createdAt, oldest), sql`coalesce(${t.note}, '') <> ${PAGE_REPLY}`))
      .limit(1);
    const firstContact = !prior;
    // Messenger gửi tiếng vọng kèm mã app ⇒ «page đã trả lời» là sự thật, không phải suy đoán theo thứ tự tới.
    const pageRepliedSince = async () => {
      const [r] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), eq(t.note, PAGE_REPLY), gte(t.createdAt, firstContact ? new Date(oldest.getTime() - FIRST_CONTACT_LOOKBACK_MS) : oldest)))
        .limit(1);
      return Boolean(r);
    };
    if (!deps.catchUp && new Date(pend.newest).getTime() > now().getTime() - (firstContact ? FIRST_CONTACT_WAIT_MS : FOLLOWUP_WAIT_MS) && !(await pageRepliedSince())) return { ...out, skipped: WAITING };
    const claim = randomUUID();
    const claimed = await db
      .update(t)
      .set({ claimId: claim, claimedAt: now() })
      .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), eq(t.status, "PENDING"), or(isNull(t.claimId), lt(t.claimedAt, new Date(now().getTime() - CLAIM_STALE_MS)))))
      .returning({ id: t.id, text: t.text, createdAt: t.createdAt, imageUrls: t.imageUrls, kind: t.kind, postId: t.postId, messageId: t.messageId });
    if (!claimed.length) break;
    const ids = claimed.map((r) => r.id);
    const finish = (status: "DONE" | "SKIPPED" | "PENDING", note: string | null) =>
      db
        .update(t)
        .set(status === "PENDING" ? { claimId: null, claimedAt: null, note } : { status, processedAt: now(), note })
        .where(and(inArray(t.id, ids), eq(t.claimId, claim)));
    const lastCustomerAt = new Date(Math.max(...claimed.map((r) => r.createdAt.getTime())));
    if (await pageRepliedSince()) {
      await finish("SKIPPED", PAGE_REPLIED_REASON);
      out.processed += ids.length;
      out.skipped = PAGE_REPLIED_REASON;
      continue;
    }
    const conv = await conversationFor(pageId, psid);
    if (!conv) {
      await finish("PENDING", "Không mở được hội thoại");
      return { ...out, error: "Không mở được hội thoại" };
    }
    {
      const cv = schema.salesChatConversations;
      await db
        .update(cv)
        .set({ lastCustomerAt, waitingSince: null, followupsSent: 0, nextFollowupAt: null, status: sql`case when ${cv.status} = 'WAITING' then 'OPEN' else ${cv.status} end` })
        .where(eq(cv.id, conv.id));
    }
    if (conv.status === "HANDOFF") {
      const ageMs = now().getTime() - conv.updatedAt.getTime();
      const retryable = conv.handoffReason === STAFF_REASON || conv.handoffReason === AI_DOWN_HANDOFF_REASON;
      if (!retryable || ageMs < HUMAN_TAKEOVER_MINUTES * 60_000) {
        await finish("SKIPPED", conv.handoffReason ?? "Đã chuyển nhân viên");
        out.processed += ids.length;
        out.skipped = conv.handoffReason ?? "Đã chuyển nhân viên";
        continue;
      }
      const cv = schema.salesChatConversations;
      await db.update(cv).set({ status: "OPEN", handoffReason: null, state: sql`${cv.state} - 'handoff'`, updatedAt: now() }).where(eq(cv.id, conv.id));
    }
    await mirrorFanpageContext(conv.id, pageId, psid, new Date(Math.min(...claimed.map((r) => r.createdAt.getTime()))));
    // CHẾ ĐỘ VẬN HÀNH (operating-mode-shared.ts): CÙNG cổng với đường Pancake — quan sát · copilot · thử nghiệm · tự động. Đặt
    // TRƯỚC mọi lời gọi tốn tiền (đọc ảnh, AI). Mặc định TỰ ĐỘNG.
    // Chế độ của HỘI THOẠI (Tiếp quản / AI gợi ý) chỉ THU HẸP cổng của tổ chức.
    const control = controlOf(conv.state);
    const gate = applyConversationControl(replyGate(await loadModeConfig(), fanpageKey(pageId, psid), readPinnedArm(conv.state)), control);
    await pinArm(conv.id, gate, now());
    if (gate.mode === "OBSERVE") {
      const note = controlSkipNote(control) ?? (gate.arm ? OBSERVE_HUMAN_ARM_NOTE : OBSERVE_NOTE);
      await finish("SKIPPED", note);
      out.processed += ids.length;
      out.skipped = note;
      continue;
    }
    for (const r of claimed) {
      const urls = Array.isArray(r.imageUrls) ? r.imageUrls.filter((u): u is string => typeof u === "string") : [];
      if (!urls.length) continue;
      const line = await describeCustomerImages(urls, { conversationId: conv.id, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      r.text = [r.text, line].filter(Boolean).join("\n").slice(0, TEXT_MAX);
      await db.update(t).set({ text: r.text, imageUrls: null }).where(eq(t.id, r.id));
    }
    const before = (await conversationView(conv.id))?.messages.length ?? 0;
    const text = claimed
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => r.text)
      .join("\n")
      .slice(0, TEXT_MAX);
    // BÌNH LUẬN: đọc nội dung bài viết để «cho giá» hiểu đúng món (cùng lời nhắc với đường Pancake).
    const commentRow = [...claimed].reverse().find((r) => r.kind === "COMMENT");
    let context = "";
    if (commentRow?.postId) {
      const app = messengerApp();
      context = postContextPrompt(app ? await postMessage(app, token, commentRow.postId, deps.fetch ?? fetch) : null);
    }
    if (gate.mode === "COPILOT") {
      // Bot soạn ở hội thoại BÓNG, không gửi: người của shop trả lời trong Hộp thư Meta; câu thật tới sau được đem so với gợi ý.
      await draftCopilotSuggestion({ conversationId: conv.id, pageId, threadId: psid, text, ...(context ? { context } : {}), now: now() });
      await finish("SKIPPED", COPILOT_NOTE);
      out.processed += ids.length;
      out.skipped = COPILOT_NOTE;
      continue;
    }
    // Ảnh chụp ĐẦU LƯỢT: người gửi tin / tiếp quản trong lúc AI đang soạn ⇒ bot không gửi câu đã soạn.
    const sendGuard = await captureSendSnapshot(conv.id);
    const turn = await chatTurn(conv.id, text, { channel: "FANPAGE", visitorKey: fanpageKey(pageId, psid), now: now(), customerName: null, ...(context ? { context } : {}) });
    if (!turn.ok) {
      const busy = /Đang trả lời câu trước/.test(turn.error);
      await finish(busy ? "PENDING" : "SKIPPED", turn.error.slice(0, 300));
      if (busy) return { ...out, skipped: "Hội thoại đang được trả lời" };
      out.processed += ids.length;
      out.skipped = turn.error;
      continue;
    }
    if (turn.view.status === "HANDOFF") {
      await finish("DONE", "Chuyển nhân viên — bot không nhắn gì, chờ người trả lời");
      out.processed += ids.length;
      out.skipped = "Chuyển nhân viên — bot im lặng";
      continue;
    }
    const replies = turn.view.messages.slice(before).filter((m) => m.role === "assistant" && m.text.trim());
    const mayFirst = await botMaySend(conv.id, sendGuard);
    if (!mayFirst.ok) {
      await finish("DONE", mayFirst.reason);
      out.processed += ids.length;
      out.skipped = mayFirst.reason;
      continue;
    }
    if (commentRow) {
      // MỘT tin riêng gộp mọi câu trả lời (Meta chỉ cho một tin riêng mỗi bình luận). Ảnh câu mẫu không đi kèm được tin riêng.
      const replyText = replies.map((r) => r.text).join("\n\n").trim();
      const app = messengerApp();
      const commentId = commentRow.messageId.replace(/^comment:/, "");
      const pr = replyText && app ? await sendPrivateReply(app, token, commentId, replyText, deps.fetch ?? fetch) : null;
      if (pr && !pr.ok) await noteMessengerGraphFailure(pr);
      if (pr?.ok) {
        out.replies += 1;
        if (pr.id) await db.insert(t).values({ pageId, threadId: psid, messageId: pr.id, text: replyText.slice(0, TEXT_MAX), status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
      }
      await finish("DONE", pr && !pr.ok ? pr.error : replyText ? null : "Bot không có câu trả lời");
      out.processed += ids.length;
      if (pr && !pr.ok) {
        out.error = pr.error;
        break;
      }
      continue;
    }
    let sendError: string | null = null;
    let yielded: string | null = null;
    let mediaDone = false;
    // Ảnh của câu trả lời mẫu: gửi NGAY SAU chữ của chính câu mẫu đó (như đường Pancake); không khớp ⇒ sau toàn bộ phần chữ.
    const sendMedia = async () => {
      mediaDone = true;
      const ids = turn.media?.imageIds ?? [];
      if (!ids.length) return;
      const may = await botMaySend(conv.id, sendGuard);
      if (!may.ok) {
        yielded = may.reason;
        return;
      }
      const r = await sendBotImages(pageId, psid, ids, deps);
      if (!r.ok) sendError = r.error;
    };
    for (const [i, r] of replies.entries()) {
      // Câu đầu đã được hỏi ở trên; từ câu thứ hai hỏi lại — người có thể vừa trả lời giữa hai câu.
      if (i > 0) {
        const may = await botMaySend(conv.id, sendGuard);
        if (!may.ok) {
          yielded = may.reason;
          mediaDone = true;
          break;
        }
      }
      const sent = await sendMessengerPageText(pageId, psid, r.text, deps);
      if (!sent.ok) {
        sendError = sent.error;
        break;
      }
      out.replies += 1;
      if (!mediaDone && turn.media?.afterText && r.text === turn.media.afterText) {
        await sendMedia();
        if (sendError || yielded) break;
      }
    }
    if (!sendError && !yielded && !mediaDone) await sendMedia();
    await finish("DONE", sendError ?? yielded);
    if (!sendError && out.replies > 0) await markWaitingForCustomer(conv.id, now());
    if (yielded) out.skipped = yielded;
    out.processed += ids.length;
    if (sendError) {
      out.error = sendError;
      break;
    }
  }
  return out;
}

/** Sau phản hồi webhook: đợi khách gõ xong rồi xử lý; tin đầu chưa đủ tuổi / hội thoại bận ⇒ thử lại (như đường Pancake). */
export async function processMessengerThreadDebounced(pageId: string, psid: string, deps: FanpageDeps = {}): Promise<ProcessResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(FOLLOWUP_WAIT_MS + GRACE_SLACK_MS);
  let last: ProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  const tries = Math.ceil((FIRST_CONTACT_WAIT_MS - FOLLOWUP_WAIT_MS) / RETRY_MS) + 3;
  for (let i = 0; i < tries; i++) {
    last = await processMessengerThread(pageId, psid, deps);
    if (last.skipped !== "Hội thoại đang được trả lời" && last.skipped !== WAITING) break;
    await sleep(RETRY_MS);
  }
  return last;
}

/**
 * Tin chờ quá lâu của page Messenger (lượt sau phản hồi mất vì máy khởi động lại…) — gọi kèm mỗi webhook Messenger và trong
 * job `sales-followup` (5 phút). Tin quá 30 phút KHÔNG trả lời bù: nhắn vào hội thoại đã nguội là làm phiền.
 */
export async function sweepStaleMessengerThreads(deps: FanpageDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  const ids = conn.ok ? ownedIds(conn.settings) : [];
  if (!ids.length) return 0;
  const db = await getDb();
  const t = schema.salesChatInbound;
  const stale = await db
    .selectDistinct({ pageId: t.pageId, threadId: t.threadId })
    .from(t)
    .where(
      and(
        inArray(t.pageId, ids),
        eq(t.status, "PENDING"),
        lt(t.createdAt, new Date(now().getTime() - 60_000)),
        gte(t.createdAt, new Date(now().getTime() - 30 * 60_000)),
        or(isNull(t.claimId), lt(t.claimedAt, new Date(now().getTime() - CLAIM_STALE_MS))),
      ),
    )
    .limit(5);
  for (const r of stale) await processMessengerThread(r.pageId, r.threadId, { ...deps, catchUp: true });
  return stale.length;
}

// ─────────────────────────── Màn hình ───────────────────────────

export type MessengerView = { appReady: boolean; page: { id: string; name: string } | null; instagram: { id: string; username: string } | null; status: string | null; lastTestOk: boolean | null };

/** Trạng thái kết nối Messenger của tổ chức ngữ cảnh (không bí mật nào). */
export async function messengerView(): Promise<MessengerView> {
  const appReady = messengerApp() !== null;
  const [row] = await messagingConnectionSummaries([MESSENGER_CONNECTOR]);
  if (!row) return { appReady, page: null, instagram: null, status: null, lastTestOk: null };
  const id = row.plainSettings.pageId ?? "";
  const igId = row.plainSettings.igAccountId ?? "";
  return { appReady, page: id ? { id, name: row.plainSettings.pageName || id } : null, instagram: igId ? { id: igId, username: row.plainSettings.igUsername ?? "" } : null, status: row.status, lastTestOk: row.lastTestOk };
}

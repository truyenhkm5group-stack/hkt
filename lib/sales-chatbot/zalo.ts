/**
 * ═══════════ CHATBOT BÁN HÀNG TRẢ LỜI TIN NHẮN ZALO OA — CHỈ MÁY CHỦ (kênh ZALO) ═══════════
 *
 * Chủ shop 04/10/2026: khách KHÔNG dùng Pancake vẫn phải dùng được bot. Zalo OA của CHÍNH shop (kết nối `zalo-oa`, app Zalo
 * của shop) đi vào ĐÚNG bộ máy chatbot bán hàng (`chatTurn`, kênh `ZALO`): giá / tồn đọc từ ERP, khoá AI của shop, đơn ghi
 * vào ERP, chuyển nhân viên — chỉ khác lối vào (webhook Zalo, chữ ký OA Secret Key) và lối ra (tin tư vấn Zalo).
 *
 * LUỒNG: webhook `/api/webhooks/zalo-oa/<token>` (token ⇒ tổ chức) ⇒ kiểm chữ ký trên THÂN THÔ ⇒ `receiveZaloEvent` ghi tin vào
 * `sales_chat_inbound` (mã tin `zalo:<msg_id>`, UNIQUE ⇒ Zalo gửi lại vô hại; `page_id` = `zalo:<OA>`, `thread_id` = người dùng
 * Zalo) và trả 200 ngay ⇒ sau phản hồi `processZaloThread` đợi khách gõ xong, GIÀNH mọi tin chờ của hội thoại, một lượt
 * `chatTurn`, gửi câu trả lời.
 *
 * Ba điều khác fanpage:
 *  · KHÔNG có trả lời tự động của Meta / ghi chú Pancake ⇒ không cần đợi lâu ở tin đầu, không hỏi lại «page đã trả lời chưa».
 *  · TIN CỦA CHÍNH OA (`oa_send_*`) tới lại qua webhook: mã tin bot vừa gửi (hoặc nguyên văn bot vừa ghi, trong 10 phút) ⇒
 *    tiếng vọng; còn lại là NHÂN VIÊN trả lời trong OA Manager ⇒ bot nhường `HUMAN_TAKEOVER_MINUTES` phút.
 *  · CỬA SỔ 48 GIỜ: ngoài 48 giờ từ tin cuối của khách Zalo TÍNH PHÍ tin tư vấn ⇒ bot KHÔNG gửi (bỏ qua có ghi chú). Không có
 *    follow-up tự động trên Zalo ở bản này — nhắc khách im lặng là đúng loại tin có thể bị tính phí.
 *
 * Ảnh câu mẫu (0183) CHƯA gửi qua Zalo (cần tải ảnh lên Zalo trước) — phần chữ vẫn đi, ghi chú nói rõ ảnh chưa gửi.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { messagingConnectionSummaries, openActiveConnection, rotateOrgConnectionSecrets } from "@/lib/connectors/service";
import { env } from "@/lib/env";
import { zaloSendImage, zaloSendText, zaloUploadImage, zaloWindow, ZALO_LIMITS, type ZaloDeps, type ZaloEvent } from "@/lib/integrations/zalo/oa";
import { ensureZaloAccessToken, usableAccessToken } from "@/lib/integrations/zalo/token";
import { chunkText } from "@/lib/messaging/providers";
import { publish } from "@/lib/realtime/bus";
import { webhookUrlToken } from "@/lib/platform/webhooks";
import { chatTurn, conversationView, describeCustomerImages, openConversation } from "@/lib/sales-chatbot/engine";
import { COPILOT_NOTE, erpStaffEchoCond, MEDIA_ONLY_NOTE, MEDIA_ONLY_TEXT, normalizeEcho, OBSERVE_HUMAN_ARM_NOTE, OBSERVE_NOTE, PAGE_REPLY, STAFF_IMAGE_MARK, STAFF_OUT_PREFIX, staffOutRowId, type StaffMark } from "@/lib/sales-chatbot/fanpage";
import { draftCopilotSuggestion, loadModeConfig, pinArm } from "@/lib/sales-chatbot/operating-mode";
import { readPinnedArm, replyGate } from "@/lib/sales-chatbot/operating-mode-shared";
import { botSendAllowed, inboundPageGate } from "@/lib/sales-chatbot/page-runtime";
import { PAGE_NOT_LIVE_SEND_ERROR } from "@/lib/sales-chatbot/page-runtime-shared";
import { applyConversationControl, controlOf, controlSkipNote } from "@/lib/sales-chatbot/conversation-control-shared";
import { botMaySend, captureSendSnapshot, holdGate, startHumanCooldown } from "@/lib/sales-chatbot/conversation-control";
import { ZALO_STAFF_REASON as ZALO_STAFF_REASON_TEXT } from "@/lib/sales-chatbot/ai-hold-shared";

export const ZALO_CONNECTOR = "zalo-oa";
/** Đợi khách gõ xong trước khi trả lời (khách hay nhắn nhiều tin ngắn liên tiếp). */
export const ZALO_WAIT_MS = 4_000;
const RETRY_MS = 2_000;
const GRACE_SLACK_MS = 1_000;
const CLAIM_STALE_MS = 3 * 60_000;
const ECHO_WINDOW_MS = 10 * 60_000;
const TEXT_MAX = ZALO_LIMITS.textMax;
export const ZALO_STAFF_REASON = ZALO_STAFF_REASON_TEXT;
const WAITING = "Đang đợi khách gõ xong";
const BUSY = "Hội thoại đang được trả lời";
export const ZALO_OUTSIDE_WINDOW = "Ngoài 48 giờ từ tin cuối của khách — Zalo tính phí tin tư vấn, bot không gửi";

/** `page_id` của tin Zalo trong `sales_chat_inbound` — tách hẳn khỏi mã page Facebook (chỉ chữ số). */
export function zaloPageKey(oaId: string): string {
  return `zalo:${oaId}`;
}

/** Khoá hội thoại Zalo (cột `visitor_key`, UNIQUE cho kênh ZALO): băm (OA, người dùng Zalo). */
export function zaloVisitorKey(oaId: string, userId: string): string {
  return createHash("sha256").update(`zalo:${oaId}:${userId}`).digest("hex");
}

const inboundId = (msgId: string) => `zalo:${msgId}`;

/** Mở (hoặc lấy) hội thoại Zalo ngay lúc nhận tin — đường phụ của hộp thư: lỗi KHÔNG làm hỏng lượt nhận. */
async function ensureZaloInbox(oaId: string, userId: string): Promise<void> {
  try {
    const conv = await zaloConversation(oaId, userId);
    publish({ type: "chat", conversationId: conv?.id ?? null });
  } catch (error) {
    console.error(`[hộp thư] không mở được hội thoại Zalo ${userId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Nhân viên gửi MỘT tin chữ cho khách Zalo TỪ HỘP THƯ ERP (0209 · lib/sales-chatbot/inbox.ts). Token qua `zaloAccessToken`
 * (đã lo làm mới + khoá); dòng ghi sẵn `staff-out:` note `PAGE_REPLY` để tiếng vọng `oa_send_text` không thành «nhân viên gõ
 * ngoài ERP». Cửa sổ 48 giờ / tin tính phí do lớp gọi quyết (`zaloWindow`) — hàm này chỉ gửi. Gửi hỏng ⇒ xoá dòng ghi sẵn.
 */
/** Nhân viên gửi ẢNH cho khách Zalo từ hộp thư (0211): tải từng ảnh lên OA ⇒ gửi tin «media». Zalo chỉ nhận JPG / PNG ≤ 1 MB. */
export async function sendZaloImages(userId: string, images: readonly { data: Uint8Array; contentType: string }[], mark: StaffMark, deps: ZaloDeps = {}): Promise<{ ok: true } | { ok: false; error: string; window: boolean }> {
  const oa = await activeOa();
  if (!oa) return { ok: false, error: "Kết nối Zalo OA chưa bật", window: false };
  const token = await zaloAccessToken(deps);
  if (!token.ok) return { ok: false, error: token.error, window: false };
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  const rowId = `${STAFF_OUT_PREFIX}${mark.staffMessageId}:img`;
  await db.insert(t).values({ pageId: zaloPageKey(oa.oaId), threadId: userId, messageId: rowId, text: STAFF_IMAGE_MARK, status: "DONE", processedAt: now(), note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
  for (const [i, img] of images.entries()) {
    const up = await zaloUploadImage({ accessToken: token.token, data: img.data, contentType: img.contentType }, deps);
    const sent = up.ok ? await zaloSendImage({ accessToken: token.token, userId, attachmentId: up.attachmentId }, deps) : { ok: false as const, error: up.error, window: false };
    if (!sent.ok) {
      if (i === 0) await db.delete(t).where(eq(t.messageId, rowId));
      const error = sent.window ? `${ZALO_OUTSIDE_WINDOW} (${sent.error})` : sent.error;
      return { ok: false, error: i > 0 ? `${error} (đã gửi ${i}/${images.length} ảnh)` : error, window: sent.window };
    }
  }
  return { ok: true };
}

export async function sendZaloText(userId: string, text: string, mark: StaffMark, deps: ZaloDeps = {}): Promise<{ ok: true } | { ok: false; error: string; window: boolean }> {
  const oa = await activeOa();
  if (!oa) return { ok: false, error: "Kết nối Zalo OA chưa bật", window: false };
  const token = await zaloAccessToken(deps);
  if (!token.ok) return { ok: false, error: token.error, window: false };
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  const pageId = zaloPageKey(oa.oaId);
  const parts = chunkText(text, TEXT_MAX);
  for (const [i, part] of parts.entries()) {
    const rowId = staffOutRowId(mark, i);
    await db.insert(t).values({ pageId, threadId: userId, messageId: rowId, text: normalizeEcho(part), status: "DONE", processedAt: now(), note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
    const sent = await zaloSendText({ accessToken: token.token, userId, text: part }, deps);
    if (!sent.ok) {
      await db.delete(t).where(eq(t.messageId, rowId));
      const error = sent.window ? `${ZALO_OUTSIDE_WINDOW} (${sent.error})` : sent.error;
      return { ok: false, error: i > 0 ? `${error} (đã gửi ${i}/${parts.length} đoạn)` : error, window: sent.window };
    }
  }
  return { ok: true };
}

export type ZaloDepsAll = ZaloDeps & { sleep?: (ms: number) => Promise<void>; catchUp?: boolean };

async function activeOa(): Promise<{ oaId: string } | null> {
  const conn = await openActiveConnection(ZALO_CONNECTOR);
  if (!conn.ok) return null;
  const oaId = (conn.settings.oaId ?? "").trim();
  return oaId ? { oaId } : null;
}

/**
 * Access token của kết nối ĐANG BẬT: còn hạn ⇒ dùng luôn (không khoá, không ghi); sắp hết ⇒ làm mới dưới khoá tư vấn và LƯU
 * cặp mới trong cùng giao dịch (`rotateOrgConnectionSecrets` đọc lại bí mật sau khi giành khoá — luồng khác vừa làm mới thì
 * dùng token đó, không làm mới lần hai bằng refresh token đã bị huỷ).
 */
export async function zaloAccessToken(deps: ZaloDeps = {}): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const conn = await openActiveConnection(ZALO_CONNECTOR);
  if (!conn.ok) return { ok: false, error: conn.reason };
  const fast = usableAccessToken(conn.secrets, (deps.now ?? (() => new Date()))());
  if (fast) return { ok: true, token: fast };
  const r = await rotateOrgConnectionSecrets(
    ZALO_CONNECTOR,
    async (cur) => {
      const t = await ensureZaloAccessToken(cur, deps);
      return { patch: t.ok ? t.patch : null, result: t };
    },
    { requireActive: true, actorLabel: "job:zalo-oa-token" },
  );
  if (!r.ok) return { ok: false, error: r.reason };
  return r.result.ok ? { ok: true, token: r.result.accessToken } : { ok: false, error: r.result.error };
}

export type ZaloReceiveResult = { queued: boolean; reason: string; userId?: string };

async function touchCustomer(oaId: string, userId: string, at: Date): Promise<void> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  await db
    .update(c)
    .set({ lastCustomerAt: sql`greatest(coalesce(${c.lastCustomerAt}, ${at}), ${at})` })
    .where(and(eq(c.channel, "ZALO"), eq(c.visitorKey, zaloVisitorKey(oaId, userId))));
}

/** Ghi MỘT sự kiện Zalo (đã kiểm chữ ký) của tổ chức ngữ cảnh. Không gọi AI, không gọi Zalo — webhook trả 200 ngay sau đây. */
export async function receiveZaloEvent(ev: ZaloEvent, now: Date = new Date()): Promise<ZaloReceiveResult> {
  if (ev.kind === "IGNORED") return { queued: false, reason: ev.reason };
  const oa = await activeOa();
  if (!oa) return { queued: false, reason: "Kết nối Zalo OA chưa bật" };
  if (ev.oaId && ev.oaId !== oa.oaId) return { queued: false, reason: "Tin của OA khác OA đã khai" };
  const db = await getDb();
  const t = schema.salesChatInbound;
  const pageId = zaloPageKey(oa.oaId);
  if (ev.kind === "INTERACTION") {
    // Khách quan tâm / đọc tin / gửi form: vẫn là tương tác của khách ⇒ cửa sổ 48 giờ tính lại từ đây.
    if (ev.eventName !== "unfollow" && ev.eventName !== "user_received_message") await touchCustomer(oa.oaId, ev.userId, ev.at.getTime() > 0 ? ev.at : now);
    return { queued: false, reason: `Sự kiện ${ev.eventName} — không phải tin cần trả lời` };
  }
  if (ev.kind === "OA_ECHO") {
    // Tin của chính bot: ĐÚNG mã tin Zalo trả về lúc gửi, hoặc trùng NGUYÊN VĂN đoạn bot ghi sẵn trước khi gửi (tiếng vọng tới
    // trước khi mã tin kịp ghi). Nhận nhầm tiếng vọng là nhân viên ⇒ bot nhường 30 phút ngay sau câu trả lời đầu tiên.
    const echo = normalizeEcho(ev.text);
    const [own] = await db
      .select({ id: t.id })
      .from(t)
      .where(or(eq(t.messageId, inboundId(ev.msgId)), and(eq(t.pageId, pageId), eq(t.threadId, ev.userId), eq(t.note, "BOT_SENT"), eq(t.text, echo), gte(t.createdAt, new Date(now.getTime() - ECHO_WINDOW_MS))), erpStaffEchoCond(pageId, ev.userId, echo, now)))
      .limit(1);
    if (own) return { queued: false, reason: "Tin của chính bot" };
    if (!echo) return { queued: false, reason: "Tin OA không có chữ — không tính là trả lời" };
    await db.insert(t).values({ pageId, threadId: ev.userId, messageId: inboundId(ev.msgId), text: echo, status: "DONE", processedAt: now, note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
    const c = schema.salesChatConversations;
    // Nhường 30 phút + sự kiện «bắt đầu nhường» — CÙNG đường với fanpage (`startHumanCooldown`); đang CẦN NGƯỜI / TIẾP QUẢN ⇒ giữ.
    const [took] = await db.select({ id: c.id }).from(c).where(and(eq(c.channel, "ZALO"), eq(c.visitorKey, zaloVisitorKey(oa.oaId, ev.userId)))).limit(1);
    if (took) await startHumanCooldown(took.id, { reason: ZALO_STAFF_REASON, at: now, actorUserId: null, key: `staff:${inboundId(ev.msgId)}`, via: "ZALO" });
    return { queued: false, reason: "Nhân viên đang trả lời trên Zalo OA — bot nhường" };
  }
  if (!ev.text && !ev.imageUrls.length) {
    // Nhãn dán / ghi âm / vị trí: bot không trả lời, nhưng khách ĐÃ tương tác ⇒ cửa sổ 48 giờ tính lại.
    // NGƯỜI phải thấy tin này trong hộp thư (MEDIA_ONLY — không vào hàng chờ của bot).
    await db.insert(t).values({ pageId, threadId: ev.userId, messageId: inboundId(ev.msgId), text: MEDIA_ONLY_TEXT, status: "DONE", processedAt: now, note: MEDIA_ONLY_NOTE }).onConflictDoNothing({ target: t.messageId });
    await ensureZaloInbox(oa.oaId, ev.userId);
    await touchCustomer(oa.oaId, ev.userId, now);
    return { queued: false, reason: "Tin không có chữ hay ảnh (nhãn dán / ghi âm / vị trí) — để nhân viên xem" };
  }
  const rows = await db
    .insert(t)
    .values({ pageId, threadId: ev.userId, messageId: inboundId(ev.msgId), text: ev.text.slice(0, TEXT_MAX), ...(ev.imageUrls.length ? { imageUrls: ev.imageUrls } : {}) })
    .onConflictDoNothing({ target: t.messageId })
    .returning({ id: t.id });
  // Khách vừa nhắn ⇒ hội thoại có trong hộp thư NGAY, không đợi bot (bot tắt / nhân viên đã trả lời trên OA vẫn thấy).
  if (rows.length) {
    await ensureZaloInbox(oa.oaId, ev.userId);
    await touchCustomer(oa.oaId, ev.userId, now);
  }
  return rows.length ? { queued: true, reason: "Đã nhận", userId: ev.userId } : { queued: false, reason: "Tin trùng — đã nhận trước đó" };
}

async function zaloConversation(oaId: string, userId: string): Promise<{ id: string; status: string; handoffReason: string | null; updatedAt: Date; humanCooldownUntil: Date | null; lastCustomerAt: Date | null; state: Record<string, unknown> } | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const key = zaloVisitorKey(oaId, userId);
  const find = async () => (await db.select({ id: c.id, status: c.status, handoffReason: c.handoffReason, updatedAt: c.updatedAt, humanCooldownUntil: c.humanCooldownUntil, lastCustomerAt: c.lastCustomerAt, state: c.state }).from(c).where(and(eq(c.channel, "ZALO"), eq(c.visitorKey, key))).limit(1))[0] ?? null;
  const existing = await find();
  if (existing) return existing;
  try {
    await openConversation("ZALO", { visitorKey: key });
  } catch {
    // Hai lượt cùng mở ⇒ chỉ số UNIQUE giữ đúng một hội thoại; đọc lại hội thoại của lượt thắng.
  }
  const created = await find();
  if (created) await db.update(c).set({ pageId: zaloPageKey(oaId), threadId: userId }).where(and(eq(c.id, created.id), isNull(c.threadId)));
  return created;
}

export type ZaloProcessResult = { processed: number; replies: number; skipped: string | null; error: string | null };

/**
 * Một lượt xử lý cho MỘT hội thoại Zalo của tổ chức ngữ cảnh: giành mọi tin chờ ⇒ một lượt `chatTurn` ⇒ gửi câu trả lời. Lặp
 * lại (tối đa 3) nếu khách nhắn thêm trong lúc bot đang trả lời. Không ném — lỗi vào `note` của tin.
 */
export async function processZaloThread(userId: string, deps: ZaloDepsAll = {}): Promise<ZaloProcessResult> {
  const now = deps.now ?? (() => new Date());
  const out: ZaloProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  const oa = await activeOa();
  if (!oa) return { ...out, skipped: "Kết nối Zalo OA chưa bật" };
  const pageId = zaloPageKey(oa.oaId);
  const db = await getDb();
  const t = schema.salesChatInbound;
  const cv = schema.salesChatConversations;
  for (let round = 0; round < 3; round++) {
    const [pend] = await db
      .select({ newest: sql<Date | string | null>`max(${t.createdAt})` })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, userId), eq(t.status, "PENDING")));
    if (!pend?.newest) break;
    if (!deps.catchUp && new Date(pend.newest).getTime() > now().getTime() - ZALO_WAIT_MS) return { ...out, skipped: WAITING };
    const claim = randomUUID();
    const claimed = await db
      .update(t)
      .set({ claimId: claim, claimedAt: now() })
      .where(and(eq(t.pageId, pageId), eq(t.threadId, userId), eq(t.status, "PENDING"), or(isNull(t.claimId), lt(t.claimedAt, new Date(now().getTime() - CLAIM_STALE_MS)))))
      .returning({ id: t.id, text: t.text, createdAt: t.createdAt, imageUrls: t.imageUrls });
    if (!claimed.length) break;
    const ids = claimed.map((r) => r.id);
    const oldest = new Date(Math.min(...claimed.map((r) => r.createdAt.getTime())));
    const lastCustomerAt = new Date(Math.max(...claimed.map((r) => r.createdAt.getTime())));
    const finish = (status: "DONE" | "SKIPPED" | "PENDING", note: string | null) =>
      db
        .update(t)
        .set(status === "PENDING" ? { claimId: null, claimedAt: null, note } : { status, processedAt: now(), note })
        .where(and(inArray(t.id, ids), eq(t.claimId, claim)));
    // CỔNG PAGE CỦA NHÀ (page-runtime.ts; «page» của Zalo là `zalo:<OA>`) — cùng cổng với fanpage.
    const pageGate = await inboundPageGate({ pageId, threadId: userId, rows: claimed, conversation: () => zaloConversation(oa.oaId, userId) });
    if (pageGate) {
      await finish("SKIPPED", pageGate);
      out.processed += ids.length;
      out.skipped = pageGate;
      continue;
    }
    // Nhân viên đã trả lời trong OA Manager SAU tin khách sớm nhất của lượt ⇒ bot không chen.
    const [staff] = await db.select({ id: t.id }).from(t).where(and(eq(t.pageId, pageId), eq(t.threadId, userId), eq(t.note, PAGE_REPLY), gte(t.createdAt, oldest))).limit(1);
    if (staff) {
      await finish("SKIPPED", ZALO_STAFF_REASON);
      out.processed += ids.length;
      out.skipped = ZALO_STAFF_REASON;
      continue;
    }
    const conv = await zaloConversation(oa.oaId, userId);
    if (!conv) {
      await finish("PENDING", "Không mở được hội thoại");
      return { ...out, error: "Không mở được hội thoại" };
    }
    // Khách vừa nhắn ⇒ mốc tin cuối của khách (cửa sổ 48 giờ của Zalo tính từ đây).
    await db.update(cv).set({ lastCustomerAt }).where(and(eq(cv.id, conv.id), or(isNull(cv.lastCustomerAt), lt(cv.lastCustomerAt, lastCustomerAt))));
    // Nhân viên trả lời trên OA ⇒ nhường 30 phút rồi bot nhận lại; AI hỏng ⇒ thử lại sau cùng khoảng đó; «Tiếp quản» / CẦN NGƯỜI
    // XỬ LÝ ⇒ ở nguyên tới khi người bấm «Trả lại cho AI» — cùng cổng với fanpage (`holdGate`).
    {
      const held = await holdGate(conv, now());
      if (held) {
        await finish("SKIPPED", held.skip);
        out.processed += ids.length;
        out.skipped = held.skip;
        continue;
      }
    }
    // CHẾ ĐỘ VẬN HÀNH (operating-mode-shared.ts — cùng MỘT cổng với fanpage): quan sát / nhánh NGƯỜI của thử nghiệm ⇒ không
    // gọi AI; copilot ⇒ soạn gợi ý, không gửi (câu thật của nhân viên tới qua tiếng vọng `oa_send_*` và được chấm như fanpage).
    // Chế độ của HỘI THOẠI (Tiếp quản / AI gợi ý) chỉ THU HẸP cổng của tổ chức.
    const control = controlOf(conv.state);
    const gate = applyConversationControl(replyGate(await loadModeConfig(), zaloVisitorKey(oa.oaId, userId), readPinnedArm(conv.state)), control);
    await pinArm(conv.id, gate, now());
    if (gate.mode === "OBSERVE") {
      const note = controlSkipNote(control) ?? (gate.arm ? OBSERVE_HUMAN_ARM_NOTE : OBSERVE_NOTE);
      await finish("SKIPPED", note);
      out.processed += ids.length;
      out.skipped = note;
      continue;
    }
    // Ngoài 48 giờ (lượt quét bù tin quá cũ): Zalo tính phí tin tư vấn ⇒ không gửi, và KHÔNG gọi AI cho câu sẽ không gửi.
    if (zaloWindow(lastCustomerAt, now()) !== "FREE") {
      await finish("SKIPPED", ZALO_OUTSIDE_WINDOW);
      out.processed += ids.length;
      out.skipped = ZALO_OUTSIDE_WINDOW;
      continue;
    }
    // Ảnh khách gửi: mô tả MỘT lần mỗi tin rồi ghi vào chính dòng tin — lượt sau không tốn tiền đọc lại.
    for (const r of claimed) {
      const urls = Array.isArray(r.imageUrls) ? r.imageUrls.filter((u): u is string => typeof u === "string") : [];
      if (!urls.length) continue;
      const line = await describeCustomerImages(urls, { conversationId: conv.id, ...(deps.fetch ? { fetch: deps.fetch as typeof fetch } : {}) });
      r.text = [r.text, line].filter(Boolean).join("\n").slice(0, TEXT_MAX);
      await db.update(t).set({ text: r.text, imageUrls: null }).where(eq(t.id, r.id));
    }
    const before = (await conversationView(conv.id))?.messages.length ?? 0;
    const text = claimed
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => r.text)
      .join("\n")
      .slice(0, TEXT_MAX);
    if (gate.mode === "COPILOT") {
      await draftCopilotSuggestion({ conversationId: conv.id, pageId, threadId: userId, text, now: now() });
      await finish("SKIPPED", COPILOT_NOTE);
      out.processed += ids.length;
      out.skipped = COPILOT_NOTE;
      continue;
    }
    // Ảnh chụp ĐẦU LƯỢT: người gửi tin / tiếp quản trong lúc AI đang soạn ⇒ bot không gửi câu đã soạn.
    const sendGuard = await captureSendSnapshot(conv.id);
    const turn = await chatTurn(conv.id, text, { channel: "ZALO", visitorKey: zaloVisitorKey(oa.oaId, userId), now: now() });
    if (!turn.ok) {
      const busy = /Đang trả lời câu trước/.test(turn.error);
      await finish(busy ? "PENDING" : "SKIPPED", turn.error.slice(0, 300));
      if (busy) return { ...out, skipped: BUSY };
      out.processed += ids.length;
      out.skipped = turn.error;
      continue;
    }
    // CHUYỂN NGƯỜI ⇒ bot IM LẶNG trên Zalo (như fanpage): nhân viên nhận thông báo trong ERP và trả lời trong OA Manager.
    if (turn.view.status === "HANDOFF") {
      await finish("DONE", "Chuyển nhân viên — bot không nhắn gì, chờ người trả lời");
      out.processed += ids.length;
      out.skipped = "Chuyển nhân viên — bot im lặng";
      continue;
    }
    const replies = turn.view.messages.slice(before).filter((m) => m.role === "assistant" && m.text.trim());
    let sendError: string | null = null;
    let yielded: string | null = null;
    // Chốt cổng page (page-runtime.ts) trước lời lấy token / gửi: tin bot chỉ đi khi «page» Zalo LIVE.
    const allowed = replies.length ? await botSendAllowed(pageId) : true;
    if (!allowed) sendError = PAGE_NOT_LIVE_SEND_ERROR;
    const token = replies.length && allowed ? await zaloAccessToken(deps) : null;
    if (token && !token.ok) sendError = token.error;
    for (const r of token?.ok ? replies : []) {
      // Người vừa trả lời / tiếp quản trong lúc bot soạn ⇒ dừng, KHÔNG gửi phần còn lại.
      const may = await botMaySend(conv.id, sendGuard);
      if (!may.ok) {
        yielded = may.reason;
        break;
      }
      for (const part of chunkText(r.text, TEXT_MAX)) {
        // Ghi TRƯỚC khi gửi: tiếng vọng `oa_send_text` có thể tới trước khi lời gọi gửi trả mã tin.
        await db.insert(t).values({ pageId, threadId: userId, messageId: `bot-out:${randomUUID()}`, text: normalizeEcho(part), status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
        const sent = await zaloSendText({ accessToken: token!.ok ? token!.token : "", userId, text: part }, deps);
        if (!sent.ok) {
          sendError = sent.window ? `${ZALO_OUTSIDE_WINDOW} (${sent.error})` : sent.error;
          break;
        }
        if (sent.messageId) await db.insert(t).values({ pageId, threadId: userId, messageId: inboundId(sent.messageId), text: normalizeEcho(part), status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
      }
      if (sendError) break;
      out.replies += 1;
    }
    const mediaNote = !sendError && (turn.media?.imageIds?.length ?? 0) > 0 ? "Ảnh của câu trả lời mẫu chưa gửi được qua Zalo — chỉ gửi phần chữ" : null;
    await finish("DONE", sendError ?? yielded ?? mediaNote);
    if (yielded) out.skipped = yielded;
    if (out.replies > 0) await db.update(cv).set({ lastBotAt: now(), ...(sendError ? { lastError: sendError.slice(0, 300) } : {}) }).where(eq(cv.id, conv.id));
    else if (sendError) await db.update(cv).set({ lastError: sendError.slice(0, 300) }).where(eq(cv.id, conv.id));
    out.processed += ids.length;
    if (sendError) {
      out.error = sendError;
      break;
    }
  }
  return out;
}

/** Sau phản hồi webhook: đợi khách gõ xong rồi xử lý; hội thoại bận / chưa đủ tuổi ⇒ thử lại mỗi `RETRY_MS`, vài lần. */
export async function processZaloThreadDebounced(userId: string, deps: ZaloDepsAll = {}): Promise<ZaloProcessResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(ZALO_WAIT_MS + GRACE_SLACK_MS);
  let last: ZaloProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  for (let i = 0; i < 4; i++) {
    last = await processZaloThread(userId, deps);
    if (last.skipped !== BUSY && last.skipped !== WAITING) break;
    await sleep(RETRY_MS);
  }
  return last;
}

/** Tin Zalo chờ quá lâu (lượt sau phản hồi bị mất vì máy khởi động lại…) của tổ chức ngữ cảnh — gọi kèm mỗi webhook mới. */
export async function sweepStaleZaloThreads(deps: ZaloDepsAll = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const oa = await activeOa();
  if (!oa) return 0;
  const db = await getDb();
  const t = schema.salesChatInbound;
  const stale = await db
    .selectDistinct({ threadId: t.threadId })
    .from(t)
    .where(and(eq(t.pageId, zaloPageKey(oa.oaId)), eq(t.status, "PENDING"), lt(t.createdAt, new Date(now().getTime() - 60_000)), or(isNull(t.claimId), lt(t.claimedAt, new Date(now().getTime() - CLAIM_STALE_MS)))))
    .orderBy(asc(t.threadId))
    .limit(5);
  for (const s of stale) await processZaloThread(s.threadId, { ...deps, catchUp: true });
  return stale.length;
}

export type ZaloSetupView = {
  status: "NOT_CONFIGURED" | "DRAFT" | "ACTIVE" | "FAILED";
  oaId: string | null;
  /** URL dán vào Zalo Developers (Webhook) — MANG TOKEN của tổ chức; `null` khi máy chủ chưa có khoá bí mật nền tảng. */
  webhookUrl: string | null;
  counts: { pending: number; done: number; skipped: number; lastSkipReason: string | null };
};

/** Khối «Zalo OA» của trang Chatbot bán hàng — chỉ gọi cho người cấu hình được bot (URL mang token). */
export async function zaloSetupView(orgCode: string): Promise<ZaloSetupView> {
  const [row] = await messagingConnectionSummaries([ZALO_CONNECTOR]);
  const status: ZaloSetupView["status"] = !row ? "NOT_CONFIGURED" : row.lastTestOk === false ? "FAILED" : row.status === "ACTIVE" ? "ACTIVE" : "DRAFT";
  const token = webhookUrlToken("ZALO_OA", orgCode);
  const db = await getDb();
  const t = schema.salesChatInbound;
  const rows = await db
    .select({ status: t.status, n: sql<number>`count(*)` })
    .from(t)
    .where(and(like(t.pageId, "zalo:%"), sql`coalesce(${t.note}, '') not in ('BOT_SENT', ${PAGE_REPLY})`))
    .groupBy(t.status);
  const of = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const [lastSkip] = await db.select({ note: t.note }).from(t).where(and(like(t.pageId, "zalo:%"), eq(t.status, "SKIPPED"))).orderBy(desc(t.createdAt)).limit(1);
  return {
    status,
    oaId: row?.plainSettings.oaId ?? null,
    webhookUrl: token ? `${env.appUrl.replace(/\/+$/, "")}/api/webhooks/zalo-oa/${token}` : null,
    counts: { pending: of("PENDING"), done: of("DONE"), skipped: of("SKIPPED"), lastSkipReason: lastSkip?.note ?? null },
  };
}

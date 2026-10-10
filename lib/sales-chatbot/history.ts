/**
 * ═══════════ NHẬP ĐỦ LỊCH SỬ HỘI THOẠI VÀO «HỘP THƯ KHÁCH» (M8 · 0221) — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ shop 06/10/2026 (SaaS, mọi tổ chức khách): hộp thư chỉ có hội thoại / tin tới SAU lúc nối page với ERP — khách cũ nhắn lại
 * thì nhân viên không thấy đã nói gì với khách, khách chưa nhắn lại thì không có trong hộp thư. Muốn: ĐỦ lịch sử, ĐỦ khách, như
 * Pancake. Một lượt NHẬP chạy nền theo tổ chức đọc API Pages của Pancake (kết nối `pancake-fanpage` của CHÍNH tổ chức):
 *  · `v2/pages/{page}/conversations` (INBOX, mới cập nhật → cũ) phân trang bằng `last_conversation_id`;
 *  · `v1/pages/{page}/conversations/{id}/messages` phân trang bằng `current_count` (trang đầu = tin mới nhất).
 *
 * GHI VÀO ĐÚNG MÔ HÌNH ĐANG DÙNG — mỗi hội thoại ⇒ một dòng `sales_chat_conversations` (`conversationFor`), mỗi tin ⇒ một dòng
 * `sales_chat_inbound` khoá `message_id` = mã tin Pancake (UNIQUE ⇒ nhập lại / trùng tin webhook đã có là BỎ QUA, không nhân
 * đôi), mốc `created_at` = mốc tin THẬT (Pancake trả ISO không múi giờ nhưng là UTC). Năm luật giữ lịch sử khỏi giả làm tin sống:
 *  1. DẤU RIÊNG. Mọi dòng mang `imported_at`; tin khách `note = 'HISTORY'`, tin page `note = 'PAGE_REPLY'` (hộp thư hiện đúng
 *     phía; mọi chỗ hiểu «page đã trả lời» hiểu đúng), cả hai `status = 'DONE'` ⇒ không bao giờ vào hàng chờ của bot.
 *  2. KHÔNG KÍCH HOẠT GÌ. Không gọi bot, không mở follow-up, không ghi sự kiện, không báo ai. Máy ghi đơn bỏ dòng lịch sử khỏi
 *     ứng viên (`order-sync.ts`); bot không chép dòng lịch sử vào lịch sử của nó (`mirrorFanpageContext`); số tin «bot đã xử lý»
 *     không đếm chúng (`fanpageInboundCounts`).
 *  3. KHÔNG THỔI PHỒNG «CHƯA ĐỌC» / «CHỜ TRẢ LỜI». `history_until` = mốc tin mới nhất đã nhập; tin khách tới mốc đó là lịch sử
 *     (`NEEDS_REPLY` của hộp thư so với nó), `staff_seen_at` được đẩy tới mốc đó (tin cũ không đậm chữ «chưa đọc»). Tin SỐNG tới
 *     sau vẫn chưa đọc / chờ trả lời như cũ.
 *  4. MỐC THẬT, KHÔNG MỐC NHẬP. `last_customer_at` chỉ NHÍCH LÊN theo mốc tin thật; hội thoại do lượt nhập tạo
 *     (`created_by = 'system:history-import'`) xếp theo `history_until` chứ không theo giờ nhập — không nhảy lên đầu. `updated_at`
 *     (đồng hồ «nhân viên đang trả lời» 30 phút của bot) KHÔNG bị chạm.
 *  5. TIN QUÁ MỚI (`freshMinutes`) KHÔNG NHẬP — tin khách chưa ai trả lời là việc của webhook / lượt quét lại; nhập nó ở dạng
 *     «đã xong» là cướp việc của bot.
 *
 * TIẾN ĐỘ LƯU ĐƯỢC: trạng thái + con trỏ (trang danh sách, hội thoại đang đọc, `current_count` của nó) nằm ở `settings`
 * (`HISTORY_SETTING_KEY`), lưu SAU MỖI lời gọi. Tiến trình chết giữa chừng ⇒ job `sales-followup` (5 phút) thấy lượt RUNNING
 * mà không có vòng nào trong tiến trình này ⇒ chạy tiếp đúng chỗ dừng. Trần tốc độ: `HISTORY_LIMITS`. Mỗi lượt (≤ 2 phút) một
 * dòng `sync_runs` (`sales-inbox-history`).
 *
 * KÊNH KHÁC: page nối THẲNG Meta (Messenger / Instagram) nhập qua `messenger-history.ts` (Conversations API, 20 tin gần nhất mỗi
 * hội thoại — giới hạn của Meta), dùng chung `writeThreadPage` / `finishThread` ở đây. Zalo OA CHƯA nhập lịch sử.
 */
import { and, asc, count, eq, gt, gte, isNotNull, isNull, like, lt, lte, or, sql } from "drizzle-orm";
import { pancakeAvatarFactsOf, pancakeAvatarPatch } from "@/lib/sales-chatbot/avatar-profile";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { describeNetworkFailure, isNetworkFailure } from "@/lib/connectors/net-error";
import { openActiveConnection } from "@/lib/connectors/service";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { bindOrganization } from "@/lib/platform/background";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { conversationFor, FANPAGE_CONNECTOR, fanpageVisitorKey, MEDIA_ONLY_TEXT, normalizeEcho, PAGE_REPLY, PANCAKE_AUTO_NOTE_RE, STAFF_IMAGE_MARK, STAFF_OUT_PREFIX, stripHtml } from "@/lib/sales-chatbot/fanpage";
import {
  emptyHistoryRun,
  HISTORY_CREATED_BY,
  HISTORY_LIMITS,
  HISTORY_NOTE,
  HISTORY_SETTING_KEY,
  HISTORY_SYNC_JOB,
  historyRunStale,
  parseHistoryRun,
  type HistoryRun,
  type HistoryStatus,
  type PendingThread,
} from "@/lib/sales-chatbot/history-shared";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { SEND_PRIORITY_MS, sendRecentlyLimited } from "@/lib/sales-chatbot/pancake-send-pressure";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { pancakeImageUrls, pancakeStickerUrls } from "@/lib/sales-chatbot/vision";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

const TEXT_MAX = 2000;
/** Tin page trùng NGUYÊN VĂN tin bot / tin nhân viên ERP đã ghi trong khoảng này ⇒ tiếng vọng, không phải tin thứ hai. */
const ECHO_WINDOW_MS = 10 * 60_000;
const ECHO_MEDIA_WINDOW_MS = 2 * 60_000;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Mốc Pancake: ISO KHÔNG múi giờ nhưng là UTC (AGENTS.md mục 4) ⇒ thêm «Z» khi thiếu. */
function pancakeTime(v: unknown): Date | null {
  const s = str(v).trim();
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type HistoryDeps = { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void>; budgetMs?: number; requestsPerTick?: number };

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** SĐT Pancake đã ghi nhận trong một phản hồi (hội thoại hoặc trang tin) ⇒ dạng 0xxxxxxxxx, không trùng. HÀM THUẦN. */
export function pancakePhonesOf(obj: unknown): string[] {
  const o = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["recent_phone_numbers", "conv_phone_numbers", "phone_numbers"]) {
    for (const p of Array.isArray(o[key]) ? (o[key] as unknown[]) : []) {
      const v = normalizeVnPhone(p && typeof p === "object" ? str((p as { phone_number?: unknown }).phone_number) : str(p));
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/**
 * Ảnh đại diện khách NẾU Pancake trả sẵn một địa chỉ https KHÔNG mang khoá. Đường ảnh đại diện riêng của Pancake đòi
 * `page_access_token` trong URL — không bao giờ lưu (kho mã PUBLIC, CSDL không phải chỗ cất khoá). Luật nằm ở
 * `avatar-profile.ts::pancakeAvatarFactsOf` — webhook / quét lại / nhập lịch sử dùng CÙNG một hàm. HÀM THUẦN.
 */
export function pancakeAvatarOf(conv: unknown): string | null {
  return pancakeAvatarFactsOf(conv).url;
}

/** Một hội thoại của danh sách Pancake ⇒ việc phải đọc; không phải hộp thư (bình luận) / thiếu mã ⇒ `null`. HÀM THUẦN. */
export function pendingThreadOf(conv: unknown): PendingThread | null {
  const c = (conv && typeof conv === "object" ? conv : {}) as Record<string, unknown>;
  const id = str(c.id);
  const type = str(c.type).toUpperCase();
  if (!id || (type && type !== "INBOX")) return null;
  const customers = Array.isArray(c.customers) ? (c.customers as Record<string, unknown>[]) : [];
  const name = str((c.from as { name?: unknown } | undefined)?.name) || str(customers[0]?.name);
  const updated = pancakeTime(c.updated_at);
  const avatar = pancakeAvatarFactsOf(c);
  return { id, name: name.slice(0, 200), phones: pancakePhonesOf(c), avatarUrl: avatar.url, avatarOutcome: avatar.outcome, ...(avatar.ref ? { avatarRef: avatar.ref } : {}), updatedAt: updated ? updated.toISOString() : null };
}

export type PlannedHistoryMessage = { messageId: string; side: "CUSTOMER" | "PAGE"; text: string; at: Date; imageUrls: string[]; customerName: string | null };

/**
 * Một trang tin Pancake ⇒ dòng sẽ ghi. Tin page: ghi chú tự động của Pancake / không chữ không ảnh ⇒ bỏ (cùng luật đường
 * webhook — không phải ai trả lời khách); chỉ ảnh ⇒ «[Ảnh]». Tin khách không chữ không ảnh (nhãn dán / ghi âm…) ⇒ dòng giữ chỗ
 * để người mở kênh xem. Tin đã thu hồi / bình luận ⇒ bỏ. Tin mới hơn `freshMs` ⇒ đếm `fresh`, KHÔNG ghi. HÀM THUẦN.
 */
export function planHistoryMessages(raw: readonly unknown[], pageId: string, opts: { nowMs: number; freshMs: number; fallbackName: string }): { rows: PlannedHistoryMessage[]; fresh: number; skipped: number } {
  const rows: PlannedHistoryMessage[] = [];
  let fresh = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const item of raw) {
    const m = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const id = str(m.id);
    const at = pancakeTime(m.inserted_at ?? m.created_at);
    const type = str(m.type).toUpperCase();
    if (!id || seen.has(id) || !at || m.is_removed === true || (type && type !== "INBOX")) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    if (opts.nowMs - at.getTime() < opts.freshMs) {
      fresh += 1;
      continue;
    }
    const from = (m.from ?? {}) as { id?: unknown; name?: unknown; uid?: unknown; admin_id?: unknown };
    const fromPage = str(from.id) === pageId || Boolean(from.uid) || Boolean(from.admin_id);
    const text = stripHtml(str(m.original_message) || str(m.message)).slice(0, TEXT_MAX);
    // Nhãn dán (👍) chỉ để hộp thư hiện (08/10/2026) — dòng nhập lịch sử không bao giờ vào lượt bot, nên gộp vào ảnh hiển thị.
    const images = pancakeImageUrls(m);
    const stickers = pancakeStickerUrls(m);
    const shown = images.length ? images : stickers;
    if (fromPage) {
      if (PANCAKE_AUTO_NOTE_RE.test(text) || (!text.trim() && !shown.length)) {
        skipped += 1;
        continue;
      }
      rows.push({ messageId: id, side: "PAGE", text: text.trim() ? text : STAFF_IMAGE_MARK, at, imageUrls: shown, customerName: null });
      continue;
    }
    rows.push({ messageId: id, side: "CUSTOMER", text: text.trim() || shown.length ? text : MEDIA_ONLY_TEXT, at, imageUrls: shown, customerName: (str(from.name) || opts.fallbackName).slice(0, 200) || null });
  }
  return { rows, fresh, skipped };
}

/** Tin page là tiếng vọng của tin bot / nhân viên ERP đã ghi (cùng chữ trong 10 phút; ảnh không chữ trong 2 phút). HÀM THUẦN. */
export function isOwnEcho(p: PlannedHistoryMessage, own: readonly { text: string; at: Date }[]): boolean {
  if (p.side !== "PAGE") return false;
  const imageOnly = p.text === STAFF_IMAGE_MARK && p.imageUrls.length > 0;
  const norm = normalizeEcho(p.text);
  return own.some((o) => {
    const gap = Math.abs(o.at.getTime() - p.at.getTime());
    if (imageOnly) return (o.text === "" || o.text === STAFF_IMAGE_MARK) && gap <= ECHO_MEDIA_WINDOW_MS;
    return o.text === norm && gap <= ECHO_WINDOW_MS;
  });
}

// ─────────────────────────── TRẠNG THÁI ───────────────────────────

export async function loadHistoryRun(): Promise<HistoryRun> {
  return parseHistoryRun(await getSettingJson<unknown>(HISTORY_SETTING_KEY, null));
}

// ─────────────────────────── PANCAKE ───────────────────────────

/** Lượt nhập dừng nhường lời gửi của bot (Pancake vừa 429 khi bot gửi) — hẹn lại sau `SEND_PRIORITY_MS`. */
export const YIELD_TO_BOT_NOTE = "Bot đang bị Pancake giới hạn tốc độ khi trả lời khách — nhập lịch sử tạm nhường, đọc tiếp sau ít phút";
type PancakeGet = { ok: true; body: Record<string, unknown> } | { ok: false; kind: "RATE_LIMIT" | "TRANSIENT" | "REJECTED"; error: string; retryAfterMs: number | null };

/** GET Pancake MỘT lần — không tự thử lại: lượt nhập tự hẹn lại theo loại lỗi (429 ⇒ nghỉ; mạng / 5xx ⇒ lùi dần). */
async function pancakeGet(url: string, token: string, fetchImpl: typeof fetch): Promise<PancakeGet> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return { ok: false, kind: "TRANSIENT", error: scrubSecrets(isNetworkFailure(e) ? describeNetworkFailure(e, "pages.fm") : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`, [token]), retryAfterMs: null };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    return { ok: false, kind: "RATE_LIMIT", error: "Pancake báo gọi quá nhiều (HTTP 429) — tạm nghỉ rồi đọc tiếp", retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : null };
  }
  if (res.status >= 500) return { ok: false, kind: "TRANSIENT", error: scrubSecrets(`Pancake bận (HTTP ${res.status})`, [token]), retryAfterMs: null };
  if (!res.ok || !body || body.success === false) return { ok: false, kind: "REJECTED", error: scrubSecrets(`Pancake từ chối: ${str(body?.message) || `HTTP ${res.status}`}`, [token]), retryAfterMs: null };
  return { ok: true, body };
}

// ─────────────────────────── GHI ───────────────────────────

type PageWrite = { inserted: number; customer: number; page: number; duplicates: number; created: boolean };

/**
 * Hội thoại ERP của luồng — tạo khi chưa có, đánh dấu do lượt nhập tạo và lấy `updated_at` = mốc tin thật cuối (`activityAt`):
 * danh sách hội thoại của trang Chatbot bán hàng xếp theo `updated_at`, giờ nhập ở đó là hàng nghìn hội thoại «vừa cập nhật».
 */
async function ensureConversation(pageId: string, threadId: string, activityAt: Date): Promise<{ id: string; created: boolean } | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const key = fanpageVisitorKey(pageId, threadId);
  const [existing] = await db.select({ id: c.id }).from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, key))).limit(1);
  if (existing) return { id: existing.id, created: false };
  const conv = await conversationFor(pageId, threadId);
  if (!conv) return null;
  // Chưa ai (bot / nhân viên ERP) đụng tới ⇒ là hội thoại của lượt nhập. Webhook mở cùng lúc thì bot đã có dấu, không đánh.
  const marked = await db
    .update(c)
    .set({ createdBy: HISTORY_CREATED_BY, updatedAt: activityAt })
    .where(and(eq(c.id, conv.id), isNull(c.createdBy), isNull(c.lastBotAt), isNull(c.lastStaffAt), eq(c.turns, 0)))
    .returning({ id: c.id });
  return { id: conv.id, created: marked.length > 0 };
}

/** Ghi MỘT trang tin đã lập kế hoạch của một luồng + đẩy mốc của hội thoại. Idempotent: khoá `message_id`. */
export async function writeThreadPage(pageId: string, threadId: string, planned: readonly PlannedHistoryMessage[], now: Date): Promise<PageWrite> {
  const out: PageWrite = { inserted: 0, customer: 0, page: 0, duplicates: 0, created: false };
  if (!planned.length) return out;
  const db = await getDb();
  const t = schema.salesChatInbound;
  let rows = [...planned];
  const pageRows = planned.filter((p) => p.side === "PAGE");
  if (pageRows.length) {
    const lo = new Date(Math.min(...pageRows.map((p) => p.at.getTime())) - ECHO_WINDOW_MS);
    const hi = new Date(Math.max(...pageRows.map((p) => p.at.getTime())) + ECHO_WINDOW_MS);
    const own = await db
      .select({ text: t.text, at: t.createdAt })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), or(eq(t.note, "BOT_SENT"), like(t.messageId, `${STAFF_OUT_PREFIX}%`)), gte(t.createdAt, lo), lte(t.createdAt, hi)));
    if (own.length) rows = rows.filter((p) => !isOwnEcho(p, own));
  }
  out.duplicates += planned.length - rows.length;
  if (!rows.length) return out;
  const inserted = await db
    .insert(t)
    .values(
      rows.map((p) => ({
        pageId,
        threadId,
        messageId: p.messageId,
        text: p.text,
        customerName: p.side === "CUSTOMER" ? p.customerName : null,
        status: "DONE",
        processedAt: now,
        note: p.side === "CUSTOMER" ? HISTORY_NOTE : PAGE_REPLY,
        kind: "INBOX",
        imageUrls: p.imageUrls.length ? p.imageUrls : null,
        importedAt: now,
        createdAt: p.at,
      })),
    )
    .onConflictDoNothing({ target: t.messageId })
    .returning({ messageId: t.messageId });
  const ids = new Set(inserted.map((r) => r.messageId));
  const done = rows.filter((p) => ids.has(p.messageId));
  out.duplicates += rows.length - done.length;
  out.inserted = done.length;
  out.customer = done.filter((p) => p.side === "CUSTOMER").length;
  out.page = out.inserted - out.customer;
  if (!done.length) return out;

  const maxAny = new Date(Math.max(...done.map((p) => p.at.getTime())));
  const conv = await ensureConversation(pageId, threadId, maxAny);
  if (!conv) return out;
  out.created = conv.created;
  const c = schema.salesChatConversations;
  const cust = done.filter((p) => p.side === "CUSTOMER");
  const maxCust = cust.length ? new Date(Math.max(...cust.map((p) => p.at.getTime()))) : null;
  await db
    .update(c)
    .set({
      ...(maxCust ? { lastCustomerAt: sql`greatest(coalesce(${c.lastCustomerAt}, ${maxCust}), ${maxCust})` } : {}),
      historyUntil: sql`greatest(coalesce(${c.historyUntil}, ${maxAny}), ${maxAny})`,
      staffSeenAt: sql`greatest(coalesce(${c.staffSeenAt}, ${maxAny}), ${maxAny})`,
      // `updated_at` là đồng hồ «nhân viên đang trả lời» của bot — lượt nhập không được chạm.
      updatedAt: sql`${c.updatedAt}`,
    })
    .where(eq(c.id, conv.id));
  return out;
}

/** Đọc xong một luồng ⇒ đóng dấu «đã nhập» + SĐT Pancake ghi nhận (`state.pancakePhones`) + ảnh đại diện (nếu có). */
export async function finishThread(pageId: string, thread: PendingThread, phones: readonly string[], now: Date): Promise<void> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db.select({ id: c.id, state: c.state }).from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageVisitorKey(pageId, thread.id)))).limit(1);
  if (!row) return;
  const st = (row.state ?? {}) as Record<string, unknown>;
  const prev = Array.isArray(st.pancakePhones) ? (st.pancakePhones as unknown[]).filter((p): p is string => typeof p === "string") : [];
  const merged = [...new Set([...phones, ...thread.phones, ...prev])].slice(0, HISTORY_LIMITS.phones);
  const patch: Record<string, unknown> = {};
  if (merged.length && merged.join() !== prev.join()) patch.pancakePhones = merged;
  // Ảnh + lý do không có ảnh (`state.pancakeAvatar`) — cùng bản vá với đường webhook (`avatar-profile.ts::pancakeAvatarPatch`).
  // Luồng không mang dữ kiện Pancake (nhập lịch sử Meta trực tiếp) ⇒ không ghi gì: thiếu dữ kiện không phải «Pancake không có ảnh».
  const outcome = thread.avatarUrl ? "URL" : thread.avatarOutcome;
  const avatarPatch = outcome ? pancakeAvatarPatch(st, { url: thread.avatarUrl, outcome, via: "HISTORY", ...(thread.avatarRef ? { ref: thread.avatarRef } : {}) }, now) : null;
  if (avatarPatch) Object.assign(patch, avatarPatch);
  await db
    .update(c)
    .set({ historyImportedAt: now, ...(Object.keys(patch).length ? { state: sql`${c.state} || ${JSON.stringify(patch)}::jsonb` } : {}), updatedAt: sql`${c.updatedAt}` })
    .where(eq(c.id, row.id));
}

/** Lô kế tiếp của phần QUÉT LẠI: hội thoại ERP của page chưa được lượt này đọc (mở trước lúc bắt đầu phần quét lại). */
async function localBatch(run: HistoryRun, pageId: string): Promise<{ items: PendingThread[]; lastConvId: string | null; remaining: number }> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const startedAt = new Date(run.startedAt ?? 0);
  const where = and(
    eq(c.channel, "FANPAGE"),
    eq(c.pageId, pageId),
    isNotNull(c.threadId),
    or(isNull(c.historyImportedAt), lt(c.historyImportedAt, startedAt)),
    lte(c.createdAt, new Date(run.localStartedAt ?? Date.now())),
    run.localCursor ? gt(c.id, run.localCursor.id) : undefined,
  );
  const [n] = await db.select({ n: count() }).from(c).where(where);
  const rows = await db.select({ id: c.id, threadId: c.threadId }).from(c).where(where).orderBy(asc(c.id)).limit(HISTORY_LIMITS.localBatch);
  return { items: rows.map((r) => ({ id: r.threadId!, name: "", phones: [], avatarUrl: null, updatedAt: null })), lastConvId: rows[rows.length - 1]?.id ?? null, remaining: Number(n?.n ?? 0) };
}

// ─────────────────────────── MỘT LƯỢT ───────────────────────────

export type HistoryTickResult = { status: HistoryStatus; requests: number; inserted: number; finished: number; duplicates: number; fresh: number; waitMs: number; note: string };

/**
 * MỘT lượt nhập cho tổ chức ngữ cảnh: đọc tiếp từ con trỏ tới khi hết ngân sách thời gian / số lời gọi, xong, lỗi, hoặc phải nghỉ
 * (429). Lưu trạng thái SAU MỖI lời gọi; người bấm «Dừng» giữa chừng ⇒ lượt thôi ngay, không ghi đè. Không ném.
 */
export async function runHistoryTick(deps: HistoryDeps = {}): Promise<HistoryTickResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = deps.fetch ?? fetch;
  const budget = deps.budgetMs ?? HISTORY_LIMITS.tickBudgetMs;
  const maxRequests = deps.requestsPerTick ?? HISTORY_LIMITS.requestsPerTick;
  const out: HistoryTickResult = { status: "IDLE", requests: 0, inserted: 0, finished: 0, duplicates: 0, fresh: 0, waitMs: 0, note: "" };
  const run = await loadHistoryRun();
  out.status = run.status;
  if (run.status !== "RUNNING") return { ...out, note: "không có lượt nhập nào đang chạy" };
  const retryAt = Date.parse(run.retryAt ?? "");
  if (Number.isFinite(retryAt) && retryAt > now().getTime()) return { ...out, waitMs: retryAt - now().getTime(), note: run.lastError ?? "đang nghỉ" };

  const save = async (): Promise<boolean> => {
    const cur = await loadHistoryRun();
    if (cur.status !== "RUNNING" || cur.startedAt !== run.startedAt) return false;
    run.lastTickAt = now().toISOString();
    await setSettingJson(HISTORY_SETTING_KEY, run);
    return true;
  };
  const stop = async (status: "FAILED" | "DONE", note: string): Promise<HistoryTickResult> => {
    run.status = status;
    run.finishedAt = now().toISOString();
    if (status === "FAILED") run.lastError = note;
    const saved = await save();
    return { ...out, status: saved ? status : (await loadHistoryRun()).status, note };
  };

  const conn = await openActiveConnection(FANPAGE_CONNECTOR);
  if (!conn.ok) return stop("FAILED", "Kết nối «Fanpage qua Pancake» chưa bật — bật lại rồi bấm «Chạy tiếp».");
  const pageId = (conn.settings.pageId ?? "").trim();
  const token = (conn.secrets.pageAccessToken ?? "").trim();
  if (!pageId || !token) return stop("FAILED", "Kết nối «Fanpage qua Pancake» thiếu page / token.");
  if (run.pageId && run.pageId !== pageId) return stop("FAILED", "Kết nối đã đổi sang page khác — bấm «Chạy lại từ đầu» cho page mới.");
  const q = `page_access_token=${encodeURIComponent(token)}`;
  const start = now().getTime();
  run.retryAt = null;

  /** Lỗi của một lời gọi ⇒ nghỉ (429), lùi dần (mạng / 5xx), hoặc dừng hẳn. `true` = lượt phải dừng ở đây. */
  const onError = async (r: Extract<PancakeGet, { ok: false }>, fatalIfRejected: boolean): Promise<HistoryTickResult | null> => {
    if (r.kind === "RATE_LIMIT") {
      const wait = Math.max(HISTORY_LIMITS.rateLimitWaitMs, r.retryAfterMs ?? 0);
      run.retryAt = new Date(now().getTime() + wait).toISOString();
      run.lastError = r.error;
      await save();
      return { ...out, status: "RUNNING", waitMs: wait, note: r.error };
    }
    if (r.kind === "TRANSIENT") {
      run.failures += 1;
      if (run.failures >= HISTORY_LIMITS.maxFailures) return stop("FAILED", `${r.error} — hỏng ${run.failures} lần liền, dừng. Bấm «Chạy tiếp» khi Pancake ổn.`);
      const wait = HISTORY_LIMITS.transientWaitMs * run.failures;
      run.retryAt = new Date(now().getTime() + wait).toISOString();
      run.lastError = r.error;
      await save();
      return { ...out, status: "RUNNING", waitMs: wait, note: r.error };
    }
    if (fatalIfRejected) return stop("FAILED", `${r.error} — kiểm tra page access token ở Cài đặt → Kết nối.`);
    return null;
  };

  /** Bot vừa bị Pancake 429 khi GỬI tin ⇒ nhập lịch sử nhường hạn mức của page cho lời trả lời khách (pancake-send-pressure.ts). */
  const yieldToBot = () => (sendRecentlyLimited(pageId, now().getTime()) ? onError({ ok: false, kind: "RATE_LIMIT", error: YIELD_TO_BOT_NOTE, retryAfterMs: SEND_PRIORITY_MS }, false) : null);

  for (;;) {
    if (out.requests >= maxRequests || now().getTime() - start >= budget) break;

    // ── Trang danh sách kế tiếp ──
    if (run.phase === "LIST" && !run.pending.length) {
      if (run.listDone) {
        run.phase = "LOCAL";
        run.localStartedAt = now().toISOString();
        run.localCursor = null;
        if (!(await save())) return { ...out, status: (await loadHistoryRun()).status, note: "lượt đã bị dừng" };
        continue;
      }
      if (out.requests) await sleep(HISTORY_LIMITS.requestGapMs);
      const yielded = await yieldToBot();
      if (yielded) return yielded;
      const r = await pancakeGet(`${PANCAKE_PAGES_API}/v2/pages/${encodeURIComponent(pageId)}/conversations?${q}&type=INBOX&order_by=updated_at${run.listCursor ? `&last_conversation_id=${encodeURIComponent(run.listCursor)}` : ""}`, token, fetchImpl);
      out.requests += 1;
      run.counts.requests += 1;
      if (!r.ok) {
        const ended = await onError(r, true);
        if (ended) return ended;
        continue;
      }
      run.failures = 0;
      const list = (Array.isArray(r.body.conversations) ? r.body.conversations : []) as unknown[];
      const lastId = str((list[list.length - 1] as { id?: unknown } | undefined)?.id);
      // Trang rỗng, hoặc Pancake trả lại đúng trang cũ (bỏ qua con trỏ) ⇒ hết danh sách.
      if (!list.length || !lastId || lastId === run.listCursor) run.listDone = true;
      else {
        run.pending = list.map(pendingThreadOf).filter((p): p is PendingThread => p !== null);
        run.listCursor = lastId;
        run.oldestReached = run.pending.reduce<string | null>((m, p) => (p.updatedAt && (!m || p.updatedAt < m) ? p.updatedAt : m), run.oldestReached);
      }
      if (!(await save())) return { ...out, status: (await loadHistoryRun()).status, note: "lượt đã bị dừng" };
      continue;
    }

    // ── Lô kế tiếp của phần quét lại ──
    if (run.phase === "LOCAL" && !run.pending.length) {
      const b = await localBatch(run, pageId);
      run.localRemaining = b.remaining;
      if (!b.items.length || !b.lastConvId) return stop("DONE", "Đã đọc hết lịch sử hội thoại của page.");
      run.localCursor = { at: now().toISOString(), id: b.lastConvId };
      run.pending = b.items;
      if (!(await save())) return { ...out, status: (await loadHistoryRun()).status, note: "lượt đã bị dừng" };
      continue;
    }

    // ── Một trang tin của hội thoại đang đọc ──
    const cur = run.pending[0]!;
    if (!run.thread || run.thread.id !== cur.id) run.thread = { id: cur.id, count: 0, pages: 0, lastIds: [], phones: [] };
    const th = run.thread;
    const finish = async () => {
      await finishThread(pageId, cur, th.phones, now());
      run.counts.conversations += 1;
      out.finished += 1;
      run.pending.shift();
      run.thread = null;
      if (run.phase === "LOCAL" && run.localRemaining !== null) run.localRemaining = Math.max(0, run.localRemaining - 1);
    };
    if (out.requests) await sleep(HISTORY_LIMITS.requestGapMs);
    const yielded = await yieldToBot();
    if (yielded) return yielded;
    const r = await pancakeGet(`${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(cur.id)}/messages?${q}${th.count ? `&current_count=${th.count}` : ""}`, token, fetchImpl);
    out.requests += 1;
    run.counts.requests += 1;
    if (!r.ok) {
      const ended = await onError(r, false);
      if (ended) return ended;
      // Một hội thoại Pancake không trả (đã xoá / không còn quyền) ⇒ bỏ qua nó, đọc tiếp. Hỏng liền nhiều hội thoại ⇒ lỗi hệ thống.
      run.counts.errors += 1;
      run.threadErrorsInRow += 1;
      run.lastError = r.error;
      if (run.threadErrorsInRow >= HISTORY_LIMITS.maxThreadErrorsInRow) return stop("FAILED", `${r.error} — ${run.threadErrorsInRow} hội thoại liền không đọc được. Kiểm tra page access token rồi bấm «Chạy tiếp».`);
      run.pending.shift();
      run.thread = null;
      if (!(await save())) return { ...out, status: (await loadHistoryRun()).status, note: "lượt đã bị dừng" };
      continue;
    }
    run.failures = 0;
    run.threadErrorsInRow = 0;
    const msgs = (Array.isArray(r.body.messages) ? r.body.messages : []) as unknown[];
    const ids = msgs.map((m) => str((m as { id?: unknown } | null)?.id)).filter(Boolean);
    const newOnes = msgs.filter((m) => !th.lastIds.includes(str((m as { id?: unknown } | null)?.id)));
    for (const p of pancakePhonesOf(r.body)) if (!th.phones.includes(p)) th.phones.push(p);
    if (!newOnes.length) {
      // Trang rỗng, hoặc Pancake trả lại đúng trang trước (bỏ qua current_count) ⇒ hết tin của hội thoại.
      await finish();
    } else {
      const plan = planHistoryMessages(newOnes, pageId, { nowMs: now().getTime(), freshMs: HISTORY_LIMITS.freshMinutes * 60_000, fallbackName: cur.name });
      const w = await writeThreadPage(pageId, cur.id, plan.rows, now());
      run.counts.messages += w.inserted;
      run.counts.customer += w.customer;
      run.counts.page += w.page;
      run.counts.duplicates += w.duplicates;
      run.counts.fresh += plan.fresh;
      run.counts.skipped += plan.skipped;
      if (w.created) run.counts.created += 1;
      out.inserted += w.inserted;
      out.duplicates += w.duplicates;
      out.fresh += plan.fresh;
      th.count += msgs.length;
      th.pages += 1;
      th.lastIds = ids.slice(0, 100);
      if (th.pages >= HISTORY_LIMITS.messagePagesPerThread) {
        run.counts.truncated += 1;
        await finish();
      }
    }
    if (!(await save())) return { ...out, status: (await loadHistoryRun()).status, note: "lượt đã bị dừng" };
  }
  return { ...out, status: "RUNNING", note: `hết ngân sách lượt (${out.requests} lời gọi) — lượt sau đọc tiếp` };
}

/** Một lượt có ghi `sync_runs`. Đang nghỉ / không có lượt ⇒ KHÔNG ghi dòng rỗng. */
export async function runInboxHistoryJob(o: { trigger: SyncTrigger; actor: string }, deps: HistoryDeps = {}): Promise<HistoryTickResult | { skipped: "BUSY" | "IDLE" | "WAIT"; waitMs: number }> {
  const run = await loadHistoryRun();
  if (run.status !== "RUNNING") return { skipped: "IDLE", waitMs: 0 };
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const retryAt = Date.parse(run.retryAt ?? "");
  if (Number.isFinite(retryAt) && retryAt > nowMs) return { skipped: "WAIT", waitMs: retryAt - nowMs };
  const r = await runSyncJob({ source: "PANCAKE", job: HISTORY_SYNC_JOB, trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
    const tick = await runHistoryTick(deps);
    ctx.summary.imported = tick.inserted;
    ctx.summary.updated = tick.finished;
    ctx.summary.skipped = tick.duplicates + tick.fresh;
    ctx.summary.detail = `nhập lịch sử hộp thư: ${tick.finished} hội thoại xong · ${tick.inserted} tin mới · ${tick.duplicates} trùng · ${tick.fresh} quá mới · ${tick.requests} lời gọi — ${tick.note}`.slice(0, 900);
    if (tick.status === "FAILED") ctx.summary.warning = tick.note.slice(0, 500);
    return tick;
  });
  if (r.skippedBecauseRunning || !r.result) return { skipped: "BUSY", waitMs: 0 };
  return r.result;
}

/** Tổ chức đang có VÒNG nhập chạy trong tiến trình này — khoá chống hai vòng (khoá `sync_runs` chặn hai lượt cùng lúc). */
const driving = new Set<string>();

/**
 * VÒNG chạy nền: lượt nối lượt tới khi xong / lỗi / bị dừng; 429 ⇒ ngủ đúng khoảng nghỉ (≤ 5 phút, dài hơn thì để job 5 phút
 * gọi lại). Tiến trình chết ⇒ vòng mất, trạng thái vẫn ở `settings`, `resumeInboxHistory` dựng lại vòng.
 */
export async function driveInboxHistory(o: { trigger: SyncTrigger; actor: string }, deps: HistoryDeps = {}): Promise<void> {
  const code = (await currentOrganization()).code;
  if (driving.has(code)) return;
  driving.add(code);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    for (let i = 0; i < 100_000; i++) {
      const r = await runInboxHistoryJob(o, deps);
      if ("skipped" in r) {
        if (r.skipped !== "WAIT" || r.waitMs > 5 * 60_000) return;
        await sleep(r.waitMs + 500);
        continue;
      }
      if (r.status !== "RUNNING") return;
      if (r.waitMs > 0) {
        if (r.waitMs > 5 * 60_000) return;
        await sleep(r.waitMs + 500);
      }
    }
  } finally {
    driving.delete(code);
  }
}

/**
 * Gọi kèm job `sales-followup` (5 phút, mọi tổ chức): lượt RUNNING mà tiến trình này không có vòng nào ⇒ dựng lại vòng (KHÔNG
 * chờ — job fan-out chạy tuần tự qua các tổ chức, không được giữ chân nó). `""` khi không có gì để làm.
 */
export async function resumeInboxHistory(): Promise<string> {
  const run = await loadHistoryRun();
  if (run.status !== "RUNNING") return "";
  if (driving.has((await currentOrganization()).code)) return "nhập lịch sử hộp thư: đang chạy";
  const go = await bindOrganization(() => driveInboxHistory({ trigger: "CRON", actor: "job:sales-followup" }));
  void go().catch((e) => console.error(`[nhập lịch sử] vòng chạy nền hỏng: ${e instanceof Error ? e.message : String(e)}`));
  return "nhập lịch sử hộp thư: chạy tiếp từ con trỏ";
}

// ─────────────────────────── NÚT BẤM (lõi — vỏ action ở lib/actions/sales-chatbot.ts) ───────────────────────────

type Result = { ok: true; message: string } | { error: string };

async function gate(user: SessionUser): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { ok: false, error: "Chỉ người quản lý chatbot (ai_sales:manage) mới đồng bộ lịch sử hộp thư." };
  return { ok: true };
}

/**
 * Bắt đầu (hoặc chạy tiếp) lượt nhập. `resume` = đọc tiếp từ con trỏ của lượt đã dừng / lỗi / chết giữa chừng; còn lại = chạy
 * lại từ đầu (nhập lại vô hại — tin đã có bị bỏ qua theo khoá). Việc nặng do vỏ action chạy SAU phản hồi.
 */
export async function startInboxHistory(user: SessionUser, raw: unknown, now: Date = new Date()): Promise<Result> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const mode = raw && typeof raw === "object" && (raw as { mode?: unknown }).mode === "resume" ? "resume" : "restart";
  const conn = await openActiveConnection(FANPAGE_CONNECTOR);
  const pageId = conn.ok ? (conn.settings.pageId ?? "").trim() : "";
  if (!conn.ok || !pageId || !(conn.secrets.pageAccessToken ?? "").trim()) return { error: "Bật kết nối «Fanpage qua Pancake» (Cài đặt → Kết nối) trước — máy đọc lịch sử bằng page access token của shop." };
  const run = await loadHistoryRun();
  if (run.status === "RUNNING" && !historyRunStale(run, now)) return { error: "Lượt nhập đang chạy — xem tiến độ ngay dưới, hoặc bấm «Dừng»." };
  const canResume = mode === "resume" && run.pageId === pageId && (run.status === "FAILED" || run.status === "CANCELLED" || run.status === "RUNNING");
  const next: HistoryRun = canResume
    ? { ...run, status: "RUNNING", finishedAt: null, lastError: null, retryAt: null, failures: 0, threadErrorsInRow: 0, lastTickAt: now.toISOString() }
    : { ...emptyHistoryRun(), status: "RUNNING", pageId, requestedAt: now.toISOString(), requestedBy: user.email, startedAt: now.toISOString(), lastTickAt: now.toISOString() };
  await setSettingJson(HISTORY_SETTING_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_INBOX_HISTORY_START", entity: "SETTINGS", entityId: HISTORY_SETTING_KEY, before: { status: run.status }, after: { status: "RUNNING", mode: canResume ? "resume" : "restart", pageId }, reason: "Đồng bộ lịch sử hội thoại vào hộp thư" });
  return { ok: true, message: canResume ? "Đang đọc tiếp lịch sử từ chỗ đã dừng — bấm «Làm mới» để xem tiến độ." : "Đã bắt đầu đọc lịch sử hội thoại từ Pancake — chạy nền, vài phút tới vài giờ tuỳ số hội thoại; bấm «Làm mới» để xem tiến độ." };
}

export async function cancelInboxHistory(user: SessionUser, now: Date = new Date()): Promise<Result> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const run = await loadHistoryRun();
  if (run.status !== "RUNNING") return { error: "Không có lượt nhập nào đang chạy." };
  await setSettingJson(HISTORY_SETTING_KEY, { ...run, status: "CANCELLED", finishedAt: now.toISOString() } satisfies HistoryRun);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_INBOX_HISTORY_CANCEL", entity: "SETTINGS", entityId: HISTORY_SETTING_KEY, before: { status: "RUNNING" }, after: { status: "CANCELLED" }, reason: "Dừng đồng bộ lịch sử hộp thư" });
  return { ok: true, message: "Đã dừng — tin đã nhập giữ nguyên; bấm «Chạy tiếp» để đọc tiếp từ chỗ dừng." };
}

/** Khối «Lịch sử hộp thư» của trang Chatbot bán hàng — chỉ cho người quản lý chatbot. */
export async function loadInboxHistoryView(user: SessionUser): Promise<{ run: HistoryRun; fanpageReady: boolean } | null> {
  if (!can(user, SALES_CHATBOT_MANAGE)) return null;
  const conn = await openActiveConnection(FANPAGE_CONNECTOR);
  return { run: await loadHistoryRun(), fanpageReady: conn.ok && Boolean((conn.settings.pageId ?? "").trim()) };
}
